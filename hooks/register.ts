import type { Register } from 'claude-code'

// Busy = still doing work. 'idle'/'waiting' agents hold no CPU, so they do not count.
const BUSY = new Set(['pending', 'running'])
const MEM_TTL_MS = 15_000

let memCache: { at: number; freeMb: number | undefined } | undefined

async function limits($: any) {
  const max = Number(await $.env.get('PARALLEL_GUARD_MAX'))
  const cpus = Number(await $.env.get('NUMBER_OF_PROCESSORS'))
  const minFree = Number(await $.env.get('PARALLEL_GUARD_MIN_FREE_MB'))
  return {
    max: max > 0 ? max : cpus > 0 ? Math.min(10, Math.max(2, cpus - 2)) : 6,
    minFreeMb: minFree > 0 ? minFree : 2048,
  }
}

// Free physical memory in MB; undefined when it cannot be read (then we never block on it).
async function freeMb($: any, now: number) {
  if (memCache && now - memCache.at < MEM_TTL_MS) return memCache.freeMb
  let mb: number | undefined
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      const r = await $.process.run(
        ['powershell', '-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'],
        { timeoutMs: 5000 },
      )
      const kb = Number(r.stdout.trim())
      if (kb > 0) mb = Math.round(kb / 1024)
    } else {
      const r = await $.process.run(['sh', '-c', "free -m 2>/dev/null | awk '/^Mem:/{print $7}'"], { timeoutMs: 5000 })
      const v = Number(r.stdout.trim())
      if (v > 0) mb = v
    }
  } catch {}
  memCache = { at: now, freeMb: mb }
  return mb
}

async function snapshot($: any) {
  const agents = await $.agent.list()
  const busy = agents.filter((a: any) => BUSY.has(a.status)).length
  const lim = await limits($)
  const mem = await freeMb($, await $.clock.now())
  return { busy, mem, ...lim }
}

function label(s: { busy: number; max: number; mem: number | undefined }) {
  return `agents ${s.busy}/${s.max}` + (s.mem === undefined ? '' : ` · free ${(s.mem / 1024).toFixed(1)}G`)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'parallel', description: 'Show running agents and free memory (parallel-guard)' })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const s = await snapshot($)
    if (s.busy >= s.max) {
      $.ui.status(label(s))
      return { deny: `parallel-guard: ${s.busy} agents already running (limit ${s.max}). Wait for one to finish, then retry.` }
    }
    if (s.mem !== undefined && s.mem < s.minFreeMb) {
      $.ui.status(label(s))
      return { deny: `parallel-guard: only ${s.mem} MB free memory (need ${s.minFreeMb}). Wait for agents to finish, then retry.` }
    }
    const started = await next(e)
    $.ui.status(label({ ...s, busy: s.busy + 1 }))
    return started
  }).catch(($, e, next) => next(e)) // guard broken -> never block work

  on('command.run', { command: 'parallel' }, async $ => {
    const s = await snapshot($)
    $.ui.status(label(s))
    return { text: label(s) }
  })
}
