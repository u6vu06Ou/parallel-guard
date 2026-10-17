import type { Register } from 'claude-code'
import { auditWorktrees, cleanWorktrees } from './clean'

// Busy = still doing work. 'idle'/'waiting' agents hold no CPU, so they do not count.
const BUSY = new Set(['pending', 'running'])
const MEM_TTL_MS = 15_000
// Every session on the machine shares one limit: each writes its busy count to a
// small file in a shared folder, and a spawn adds up every file that is still fresh.
const BEAT_MS = 10_000
const STALE_MS = 30_000 // a session that stopped writing (closed, crashed) stops counting

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

// Shared folder; undefined when no home directory is known (then each session counts alone).
async function sharedDir($: any) {
  const custom = await $.env.get('PARALLEL_GUARD_DIR')
  if (custom) return custom
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home}/.claude/parallel-guard` : undefined
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

async function ownBusy($: any) {
  const agents = await $.agent.list()
  return agents.filter((a: any) => BUSY.has(a.status)).length
}

async function publish($: any, busy: number, now: number) {
  try {
    const dir = await sharedDir($)
    if (dir) await $.fs.write(`${dir}/${await $.session.id()}.json`, JSON.stringify({ busy, at: now }))
  } catch {}
}

// Busy agents of every other live session on this machine.
async function othersBusy($: any, now: number) {
  let total = 0
  try {
    const dir = await sharedDir($)
    if (!dir) return 0
    const me = `${await $.session.id()}.json`
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name === me) continue
      try {
        const s = JSON.parse(await $.fs.read(`${dir}/${f.name}`))
        if (now - Number(s.at) < STALE_MS && Number(s.busy) > 0) total += Number(s.busy)
      } catch {}
    }
  } catch {}
  return total
}

async function snapshot($: any) {
  const now = await $.clock.now()
  const own = await ownBusy($)
  await publish($, own, now)
  const busy = own + (await othersBusy($, now))
  const lim = await limits($)
  const mem = await freeMb($, now)
  return { busy, mem, ...lim }
}

function label(s: { busy: number; max: number; mem: number | undefined }) {
  return `agents ${s.busy}/${s.max} (all sessions)` + (s.mem === undefined ? '' : ` · free ${(s.mem / 1024).toFixed(1)}G`)
}

// Human-readable text of a worktree clean report: what was removed, what was
// kept and why.
function cleanText(r: Awaited<ReturnType<typeof cleanWorktrees>>): string {
  if (r.error) return `worktree clean: ${r.error}`
  const removed = r.cleaned.length
    ? 'removed:\n' + r.cleaned.map(p => `  ${p}`).join('\n')
    : 'removed: nothing'
  const kept = r.entries.filter(e => !e.cleanable).map(e => `  ${e.wt.path} — ${e.reason}`)
  return `worktree clean (${r.root}):\n${removed}\n` + (kept.length ? 'kept:\n' + kept.join('\n') : 'kept: nothing')
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'parallel', description: 'Show running agents, free memory; `clean` removes finished git worktrees (parallel-guard)', argumentHint: '[clean]' })
    // Heartbeat: keep this session's count fresh so other sessions see it.
    $.clock.every(BEAT_MS, async () => {
      const s = await snapshot($)
      $.ui.status(label(s))
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await publish($, 0, await $.clock.now())
    // Nothing is removed here, ever: only a count, so the next session can
    // offer the cleanup as a human-triggered command.
    try {
      const r = await auditWorktrees($)
      const n = r.entries.filter(e => e.cleanable).length
      if (n > 0) await $.ui.notify(`${n} git worktree copies can be cleaned, run /parallel clean`)
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const s = await snapshot($)
    if (s.busy >= s.max) {
      $.ui.status(label(s))
      return { deny: `parallel-guard: ${s.busy} agents already running across all sessions (limit ${s.max}). Wait for one to finish, then retry.` }
    }
    if (s.mem !== undefined && s.mem < s.minFreeMb) {
      $.ui.status(label(s))
      return { deny: `parallel-guard: only ${s.mem} MB free memory (need ${s.minFreeMb}). Wait for agents to finish, then retry.` }
    }
    const started = await next(e)
    $.ui.status(label({ ...s, busy: s.busy + 1 }))
    return started
  }).catch(($, e, next) => next(e)) // guard broken -> never block work

  on('command.run', { command: 'parallel' }, async ($, e, next) => {
    const sub = String(e.args ?? '').trim().toLowerCase()
    if (sub.startsWith('clean')) {
      const r = await cleanWorktrees($)
      const t = cleanText(r)
      $.ui.status(`worktree clean: ${r.cleaned.length} removed`)
      return { text: t }
    }
    const s = await snapshot($)
    $.ui.status(label(s))
    return { text: label(s) }
  })
}
