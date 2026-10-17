import { test, expect, mock } from 'claude-code/testing'

function setup($: any, on: any, running: number) {
  mock.clock(on)
  mock.env(on, { PARALLEL_GUARD_MAX: '2' }) // no OS var -> memory probe skipped
  const agents = Array.from({ length: running }, (_, i) => ({ id: 'a' + i, description: 'x', type: 'general-purpose', status: 'running' }))
  agents.push({ id: 'idle1', description: 'x', type: 'general-purpose', status: 'idle' }) // idle must not count
  on('agent.list', () => ({ value: agents }))
  let started = 0
  on('agent.spawn', () => { started++; return { model: 'm', agentId: 'new' } })
  return { started: () => started }
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
