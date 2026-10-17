import { test, expect, mock } from 'claude-code/testing'

function setup($: any, on: any, running: number, env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, { PARALLEL_GUARD_MAX: '2', ...env }) // no OS var -> memory probe skipped
  const agents = Array.from({ length: running }, (_, i) => ({ id: 'a' + i, description: 'x', type: 'general-purpose', status: 'running' }))
  agents.push({ id: 'idle1', description: 'x', type: 'general-purpose', status: 'idle' }) // idle must not count
  on('agent.list', () => ({ value: agents }))
  let started = 0
  on('agent.spawn', () => { started++; return { model: 'm', agentId: 'new' } })
  return { started: () => started, now: () => clock.now() }
}

const spawn = ($: any) => $.agent.spawn({ prompt: 'hi', description: 'd' })

test('under the limit: spawn goes through', async ($, on) => {
  const s = setup($, on, 1)
  const r = await spawn($)
  expect(r.deny).toBeUndefined()
  expect(s.started()).toBe(1)
})

test('at the limit: spawn is denied, idle agents ignored', async ($, on) => {
  const s = setup($, on, 2)
  const r = await spawn($)
  expect(String(r.deny)).toContain('limit 2')
  expect(s.started()).toBe(0)
})

// Other sessions on the machine: files in the shared folder count toward the same limit.
function shared(on: any, files: Record<string, { busy: number; at: number }>) {
  const written: Record<string, string> = {}
  on('session.id', () => ({ value: 'me' }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_: any, e: any) => ({ value: JSON.stringify(files[Object.keys(files).find(n => String(e.path).endsWith(n))!]) }))
  on('fs.write', (_: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
  return written
}

test('busy agents in another session count toward the shared limit', async ($, on) => {
  const s = setup($, on, 1, { PARALLEL_GUARD_DIR: '/pg' })
  const now = s.now()
  shared(on, { 'other.json': { busy: 1, at: now } })
  const r = await spawn($)
  expect(String(r.deny)).toContain('across all sessions')
  expect(s.started()).toBe(0)
})

test('a session that stopped writing (stale) no longer counts', async ($, on) => {
  const s = setup($, on, 1, { PARALLEL_GUARD_DIR: '/pg' })
  const now = s.now()
  const written = shared(on, { 'old.json': { busy: 5, at: now - 60_000 } })
  const r = await spawn($)
  expect(r.deny).toBeUndefined()
  expect(s.started()).toBe(1)
  const mine = Object.keys(written).find(k => k.endsWith('me.json'))
  expect(written[mine!]).toContain('"busy":1')
})
