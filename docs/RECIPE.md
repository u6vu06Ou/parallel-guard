# Recipe: safe parallel work for agents

For an agent session that wants to run several tasks in parallel without eating the machine: cap your fan-out, use read-isolated worktrees, and keep spawned workers single-threaded.

## 1. Cap your fan-out

- Max concurrent busy agents: **(CPU cores − 2), clamped to 2–10**. The main session and the OS need headroom too.
- Watch memory, not just CPU: every busy agent loads project files and runs builds. Don't schedule a new agent while free physical memory is near its floor (a sane default floor: **2048 MB**).
- If the parallel-guard plugin is installed, `agent.spawn` is denied automatically once the cap is reached or free memory drops below the floor, and the status line shows `agents n/max · free xG`. If it is not installed, enforce the numbers yourself.

## 2. Parallel tasks belong in git worktrees

Never let parallel agents edit the same checkout. Give each its own worktree and say so in the task brief.

Start (from the main checkout):

```
git worktree add .claude/worktrees/<name> -b <branch>
```

The task brief must name its worktree path and branch, so nothing collides.

Finish — only remove a worktree after its work is committed:

1. `git -C <worktree> status --short` must be **empty**. If anything is uncommitted, stop and ask the operator — never delete uncommitted work to "clean up".
2. **Junction/symlink trap (Windows):** if the worktree holds a junctioned or symlinked `node_modules` (created with `mklink /J` or a symlink), remove the link itself first (`cmd rmdir <link>`, or `Remove-Item <link>` without `-Recurse`; on POSIX, `rm <link>`). Recursive deletion can follow the link and wipe the real `node_modules` it points to.
3. `git worktree remove <worktree>`
4. `git branch -d <branch>` (merged branches only; ask before `-D`)
5. `git worktree prune`

## 3. Task briefs for spawned workers

A spawned worker (subagent) must not fan out on its own. Every brief you hand a worker says, verbatim nothing less than:

> Do not spawn agents, subprocesses, background processes or parallel jobs yourself. Work single-threaded.

Otherwise workers spawn workers, CPU load multiplies, and nothing watches it — the agent cap counts subagents, not the processes they start.

## In one line

Cap busy agents at cores − 2 (2–10), keep 2 GB free, isolate parallel edits in worktrees, clean worktrees unlink-before-remove, and forbid workers from parallelism. If in doubt, block: a broken guard must fail open, but a missing guard fails everything at once.
