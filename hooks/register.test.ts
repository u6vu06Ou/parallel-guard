import { test, expect, mock } from 'claude-code/testing'
import { auditWorktrees, cleanWorktrees, WT_MIN_AGE_MS } from './clean'

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

// Worktree cleanup: git never runs, every child call `$.process.run` would
// make is written out by hand. An unmocked call reads as a failure with that
// argv, so a runaway command cannot hide. The callback `$` has no host
// namespaces (only event calls), so the unit tests build one that routes
// through the same mocks.

type Run = { argv: readonly string[]; exitCode: number; stdout: string; stderr: string }
type GitMap = Record<string, { exitCode: number; stdout?: string; stderr?: string }>
type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

type WtFixture = {
  git: GitMap
  now: number
  dirs: Record<string, number> // path -> mtimeMs
  listings: Record<string, FsEntry[]>
  cwd: string
}

function unit$(fx: WtFixture) {
  const rung: Run[] = []
  const $: any = {
    clock: { now: async () => fx.now },
    env: { get: async (k: string) => (k === 'OS' ? 'Windows_NT' : undefined) },
    process: {
      run: async (argv: readonly string[]) => {
        const key = argv.join(' ')
        const m = fx.git[key] ?? { exitCode: 1, stderr: 'unmocked: ' + key }
        rung.push({ argv, exitCode: m.exitCode, stdout: m.stdout ?? '', stderr: m.stderr ?? '' })
        return { exitCode: m.exitCode, stdout: m.stdout ?? '', stderr: m.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    session: { cwd: async () => fx.cwd, repo: async () => ({ root: '/wt-repo' }) },
    fs: {
      stat: async (p: string) => {
        if (!(p in fx.dirs)) throw new Error('missing: ' + p)
        return { kind: 'dir', size: 0, mtimeMs: fx.dirs[p], isLink: false }
      },
      list: async (p?: string) => fx.listings[String(p ?? '')] ?? [],
    },
    ui: { status: async () => undefined, notify: async () => ({ isSent: true }) },
  }
  return { $, rung: () => rung }
}

const LIST = [
  'worktree /wt-repo', 'HEAD 1111', 'branch refs/heads/main', '',
  'worktree /wt-ok', 'HEAD 2222', 'branch refs/heads/ok', '',
  'worktree /wt-new', 'HEAD 3333', 'branch refs/heads/new', '',
  'worktree /wt-dirty', 'HEAD 4444', 'branch refs/heads/dirty', '',
  'worktree /wt-feature', 'HEAD 5555', 'branch refs/heads/feature', '',
].join('\n')

// Audit: clean status, branch merged into main, folder older than WT_MIN_AGE_MS.
const AUDIT_GIT: GitMap = {
  'git -C /wt-repo worktree list --porcelain': { exitCode: 0, stdout: LIST },
  'git -C /wt-ok status --porcelain': { exitCode: 0 },
  'git -C /wt-new status --porcelain': { exitCode: 0 },
  'git -C /wt-dirty status --porcelain': { exitCode: 0, stdout: ' M src/a.ts' },
  'git -C /wt-feature status --porcelain': { exitCode: 0 },
  'git -C /wt-repo merge-base --is-ancestor ok main': { exitCode: 0 },
  'git -C /wt-repo merge-base --is-ancestor new main': { exitCode: 0 },
  'git -C /wt-repo merge-base --is-ancestor feature main': { exitCode: 1 },
}

const NOTHING_NEW = (now: number): Record<string, number> => ({
  '/wt-ok': now - WT_MIN_AGE_MS - 3600_000, // an hour past the cutoff
  '/wt-new': now - WT_MIN_AGE_MS / 2, // half the cutoff: too new
  '/wt-dirty': now - WT_MIN_AGE_MS - 3600_000,
  '/wt-feature': now - WT_MIN_AGE_MS - 3600_000,
})

test('audit: clean merged and old enough is cleanable, the rest are spared with reasons', async () => {
  const now = 1_000_000_000_000
  const f = unit$({
    git: AUDIT_GIT, now, dirs: NOTHING_NEW(now), cwd: '/somewhere-else',
    listings: { '/wt-ok': [{ name: 'README.md', kind: 'file', size: 10, mtimeMs: 0, isLink: false }] },
  })

  const report = await auditWorktrees(f.$, { isWin: false })
  expect(report.error).toBeUndefined()
  expect(report.root).toBe('/wt-repo')
  const by = (p: string) => report.entries.find(e => e.wt.path === p)!
  expect(by('/wt-ok').cleanable).toBe(true)
  expect(by('/wt-new').cleanable).toBe(false)
  expect(by('/wt-new').reason).toContain('younger')
  expect(by('/wt-dirty').reason).toContain('uncommitted')
  expect(by('/wt-feature').reason).toContain('not merged')
  // Audit only: no removal call, ever.
  const removals = f.rung().filter(r => r.argv.includes('remove') || r.argv.includes('prune'))
  expect(removals.length).toBe(0)
})

test('clean: junction link removed before the copy, target untouched', async () => {
  const now = 1_000_000_000_000
  const nodeLink = ['cmd', '/c', 'rmdir', '\\wt-ok\\node_modules'] // cmd gets backslashes
  const f = unit$({
    git: {
      ...AUDIT_GIT,
      'git -C /wt-repo worktree remove /wt-ok': { exitCode: 0 },
      'git -C /wt-repo branch -d ok': { exitCode: 0 },
      'git -C /wt-repo worktree prune': { exitCode: 0 },
      'cmd /c rmdir \\wt-ok\\node_modules': { exitCode: 0 },
    },
    now, dirs: NOTHING_NEW(now), cwd: '/somewhere-else',
    listings: {
      // a junction inside the copy: the link itself, nothing behind it
      '/wt-ok': [{ name: 'node_modules', kind: 'other', size: 0, mtimeMs: 0, isLink: true }],
    },
  })

  const report = await cleanWorktrees(f.$, { isWin: true }) // Windows: the cmd rmdir path
  expect(report.error).toBeUndefined()
  expect(report.cleaned).toEqual(['/wt-ok'])
  const r = f.rung()
  const at = (argv: readonly string[]) => r.findIndex(x => x.argv.join(' ') === argv.join(' '))
  const rm = at(nodeLink)
  const wtRemove = at(['git', '-C', '/wt-repo', 'worktree', 'remove', '/wt-ok'])
  const brDelete = at(['git', '-C', '/wt-repo', 'branch', '-d', 'ok'])
  expect(rm).toBeGreaterThanOrEqual(0)
  expect(wtRemove).toBeGreaterThan(rm) // link alone first, then the copy
  expect(brDelete).toBeGreaterThan(wtRemove) // branch last
  // Only that one link was removed; the target folder is never touched.
  const rmdirs = r.filter(x => x.argv[0] === 'cmd')
  expect(rmdirs.length).toBe(1)
  expect(rmdirs[0]!.argv.join(' ')).not.toContain('wt-target')
  expect(r.some(x => x.stderr.startsWith('unmocked'))).toBe(false)
})
