// Deleting a git worktree copy loses whatever it holds, so every check in the
// audit below must pass before anything is removed. When in doubt a copy is
// kept, with the reason it was spared.
export const WT_MIN_AGE_MS = 2 * 60 * 60 * 1000 // a copy younger than 2h may be someone's fresh checkout
const WALK_MAX_DEPTH = 8 // junction scan: how deep to look inside a copy
const WALK_MAX_ENTRIES = 20000 // junction scan: entries max, then stop (keep the clean cheap)

export type WorktreeInfo = {
  path: string
  head?: string
  branch?: string // refs/heads/<name> when a branch is checked out; absent when detached
  bare?: boolean
  locked?: string // lock reason, or '' when locked without one
  detached?: boolean
}

export type AuditEntry = { wt: WorktreeInfo; cleanable: boolean; reason: string }

export type CleanReport = {
  root?: string
  entries: AuditEntry[]
  cleaned: string[] // paths whose copy was removed and branch deleted
  error?: string // set when the audit could not even start
}

/** Parses `git worktree list --porcelain` into blocks, one per worktree. */
export function parseWorktreeList(out: string): WorktreeInfo[] {
  const wts: WorktreeInfo[] = []
  let cur: WorktreeInfo | undefined
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    if (raw === '') { cur = undefined; continue }
    if (raw.startsWith('worktree ')) {
      cur = { path: raw.slice('worktree '.length) }
      wts.push(cur)
    } else if (cur) {
      if (raw.startsWith('HEAD ')) cur.head = raw.slice(5)
      else if (raw.startsWith('branch ')) cur.branch = raw.slice(7)
      else if (raw.startsWith('locked')) cur.locked = raw === 'locked' ? '' : raw.slice('locked '.length)
      else if (raw === 'bare') cur.bare = true
      else if (raw === 'detached') cur.detached = true
    }
  }
  return wts
}

export function refName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

export function normPath(p: string, isWin: boolean): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWin ? s.toLowerCase() : s
}

/** Junction and symbolic links inside a copy, found so the links alone can be
 *  removed before `git worktree remove` deletes. Never walks into a link. */
export async function findLinks($: any, dir: string): Promise<string[]> {
  const out: string[] = []
  let budget = WALK_MAX_ENTRIES
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > WALK_MAX_DEPTH || budget <= 0) return
    let entries: any[]
    try { entries = await $.fs.list(d) } catch { return } // unreadable: nothing found here
    for (const t of entries) {
      if (budget-- <= 0) return
      const p = `${d}/${t.name}`
      if (t.isLink) { out.push(p); continue } // the link itself: never descend into it
      if (t.kind === 'dir') await walk(p, depth + 1)
    }
  }
  await walk(dir, 0)
  return out
}

// A child run; a non-zero exit reads as failure. Nothing here uses a shell.
async function run($: any, argv: readonly string[], timeoutMs: number) {
  return await $.process.run(argv, { timeoutMs })
}

// Removes one audited copy in the safe order: links alone first, then the
// copy, then the branch (-d refuses an unmerged branch). No step uses --force.
// Returns undefined when the copy is gone, else why it was spared.
async function removeCopy($: any, root: string, wt: WorktreeInfo, isWin: boolean): Promise<string | undefined> {
  const links = await findLinks($, wt.path)
  for (const l of links) {
    // cmd reads a forward-slash path as a switch ("/Users"), so Windows gets
    // backslashes; a path never ends in one, so quoting stays intact.
    const rmdirArg = isWin ? l.replace(/\//g, '\\') : l
    const r = await run($, isWin ? ['cmd', '/c', 'rmdir', rmdirArg] : ['rm', '--', l], 10_000)
    if (r.exitCode !== 0) {
      const why = String(r.stderr || '').trim() || 'non-zero exit'
      return `skipped at link ${l}: ${why}`
    }
  }
  const rm = await run($, ['git', '-C', root, 'worktree', 'remove', wt.path], 60_000)
  if (rm.exitCode !== 0) return `git worktree remove failed: ${String(rm.stderr || '').trim()}`
  if (wt.branch) {
    const br = await run($, ['git', '-C', root, 'branch', '-d', refName(wt.branch)], 10_000)
    if (br.exitCode !== 0) return undefined // copy gone; -d refused (race): the branch stays, the clean still counts
  }
  return undefined
}

async function repoRoot($: any): Promise<string | undefined> {
  try {
    const repo = await $.session.repo()
    if (repo && repo.root) return String(repo.root)
  } catch {}
  try {
    const cwd = await $.session.cwd()
    const r = await run($, ['git', '-C', cwd, 'rev-parse', '--show-toplevel'], 10_000)
    if (r.exitCode === 0) return String(r.stdout).trim()
  } catch {}
  return undefined
}

// Audits every worktree copy of the session's repository. Nothing is removed:
// each copy comes back cleanable plus the reason it would be kept. A copy must
// pass ALL of these to be cleanable: not the main working tree; clean status;
// its branch fully merged into the main branch; the folder older than 2h; not
// this session's own working directory. Locked, bare and detached copies are
// always spared.
export async function auditWorktrees($: any, opts: { isWin?: boolean } = {}): Promise<CleanReport> {
  const report: CleanReport = { entries: [], cleaned: [] }
  const isWin = opts.isWin ?? (await $.env.get('OS')) === 'Windows_NT'
  const now = await $.clock.now()
  const cwd = await $.session.cwd()

  const root = await repoRoot($)
  if (!root) return { ...report, error: 'not a git repository' }
  report.root = root

  const ls = await run($, ['git', '-C', root, 'worktree', 'list', '--porcelain'], 10_000)
  if (ls.exitCode !== 0) return { ...report, error: `git worktree list failed: ${String(ls.stderr || '').trim()}` }

  const wts = parseWorktreeList(String(ls.stdout))
  const main = normPath(root, isWin)
  const mainWt = wts.find(w => normPath(w.path, isWin) === main)
  const mainBranch = mainWt && mainWt.branch ? mainWt.branch : undefined

  for (const wt of wts) {
    const p = normPath(wt.path, isWin)
    const spare = (reason: string): AuditEntry => ({ wt, cleanable: false, reason })
    if (p === main) continue // the repository's main working tree is never a candidate
    if (wt.bare) { report.entries.push(spare('bare worktree')); continue }
    if (wt.locked !== undefined) { report.entries.push(spare(wt.locked ? `locked: ${wt.locked}` : 'locked')); continue }
    if (!wt.branch || wt.detached) { report.entries.push(spare('detached HEAD')); continue }
    if (!mainBranch) { report.entries.push(spare('main branch unknown')); continue }
    if (p === normPath(cwd, isWin)) { report.entries.push(spare('this session runs here')); continue }

    const st = await run($, ['git', '-C', wt.path, 'status', '--porcelain'], 30_000)
    if (st.exitCode !== 0) { report.entries.push(spare(`git status failed: ${String(st.stderr || '').trim()}`)); continue }
    if (String(st.stdout).trim() !== '') { report.entries.push(spare('uncommitted changes')); continue }

    const anc = await run($, ['git', '-C', root, 'merge-base', '--is-ancestor', refName(wt.branch), refName(mainBranch)], 30_000)
    if (anc.exitCode !== 0) { report.entries.push(spare('branch not merged into main')); continue }

    const di = await $.fs.stat(wt.path).then((s: any) => s, () => undefined)
    if (!di || di.kind !== 'dir' || !(di.mtimeMs > 0)) { report.entries.push(spare('folder age unknown')); continue }
    if (now - di.mtimeMs < WT_MIN_AGE_MS) { report.entries.push(spare('folder younger than 2h')); continue }

    report.entries.push({ wt, cleanable: true, reason: 'clean, merged and old enough' })
  }
  return report
}

// Audits, then removes what passed the audit. A copy where any removal step
// fails is marked with that step's reason and the next copy is audited as
// usual. `git worktree prune` runs last whatever happened.
export async function cleanWorktrees($: any, opts: { isWin?: boolean } = {}): Promise<CleanReport> {
  const report = await auditWorktrees($, opts)
  if (report.error || !report.root) return report
  const root = report.root
  const isWin = opts.isWin ?? (await $.env.get('OS')) === 'Windows_NT'
  for (const entry of report.entries) {
    if (!entry.cleanable) continue
    const spared = await removeCopy($, root, entry.wt, isWin)
    if (spared) { entry.cleanable = false; entry.reason = spared; continue }
    entry.reason = 'copy removed, branch deleted'
    report.cleaned.push(entry.wt.path)
  }
  try { await run($, ['git', '-C', root, 'worktree', 'prune'], 30_000) } catch {}
  return report
}
