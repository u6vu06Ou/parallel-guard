# parallel-guard

A Claude Code plugin that stops new subagents from spawning when too many are already running, or when the machine is low on free memory — so a fan-out of parallel agents never eats your CPU and RAM alive.

## Why

Claude Code happily spawns a dozen subagents at once. Each busy agent loads files, runs builds and burns CPU and memory — on a laptop this cascades into swap death and OOM kills. parallel-guard counts *busy* agents (still doing work; idle/waiting agents hold no CPU and don't count) and denies new spawns once a limit is reached.

## Install

At a Claude Code prompt:

```
/plugin install parallel-guard --marketplace u6vu06Ou/parallel-guard
```

(Answer `y` to add the marketplace, then pick the user scope.)

## What it does

- **Denies new `agent.spawn` calls** while busy agents are at the cap, or while free physical memory is below the floor. Denials explain themselves and ask you to retry when an agent finishes.
- **Status line**: after each spawn check it shows `agents 3/8 · free 6.2G` — busy count over the cap, and free memory.
- **`/parallel` command**: print the same snapshot any time.
- **`/parallel clean` command**: automatic cleanup of finished git worktrees for the repository your current folder belongs to. A copy is only removed when it passes ALL of these checks: not the main working directory; `git status` clean; its branch fully merged into the main branch; the folder untouched for over 2 hours; no session is running in it (locked, bare and detached copies are always spared). Copies are removed in a safe order — junctions/symlinks inside the copy are deleted alone first (never their target), then `git worktree remove` without `--force`, then `git branch -d` (which itself refuses an unmerged branch), finally `git worktree prune`. If any step fails the copy is kept and the report explains why. Session end never deletes anything — it only tells you how many copies can be cleaned, so cleanup always stays a human-triggered command.
- **Zero model tokens**: the guard runs entirely as hooks; it never makes a model call.
- **Fail open**: if the guard itself throws, it lets the spawn through — a broken guard never blocks your work.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `PARALLEL_GUARD_MAX` | CPU cores − 2, clamped to 2–10 | Max busy subagents, added up across every Claude Code session on the machine, before new spawns are denied |
| `PARALLEL_GUARD_MIN_FREE_MB` | `2048` | Minimum free physical memory (MB) to allow a new spawn |
| `PARALLEL_GUARD_DIR` | `~/.claude/parallel-guard` | Shared folder where each session writes its busy count (a session silent for 30 s stops counting) |

Reads work on Windows and Linux/macOS; if free memory can't be read at all, the memory check is skipped and only the agent cap applies.

## License

MIT — see [LICENSE](LICENSE).

---

## 繁中簡版

# parallel-guard

Claude Code 外掛：同一時間跑太多 subagent 時擋下新的，或剩餘記憶體不足時擋下，避免 CPU／記憶體被吃爆。只算「忙碌中」的 agent（idle 不佔 CPU，不算）。

安裝（在 Claude Code 對話框輸入）：

```
/plugin install parallel-guard --marketplace u6vu06Ou/parallel-guard
```

行為：agent.spawn 被擋時會說明原因；狀態列顯示 `agents 3/8 · free 6.2G`；`/parallel` 隨時查同樣資訊；純 hook 運作、零模型 token；guard 自己出錯時一律放行，不擋工作。

`/parallel clean`：自動收掉做完的 git 工作副本（worktree）。一個副本要通過全部檢查才會被收：不是主工作目錄、`git status` 乾淨、分支已完全併回主分支、資料夾超過 2 小時沒動、沒有 session 在裡面工作（locked／bare／detached 一律保留）。收的順序安全：先單獨刪掉副本裡的 junction／symlink（絕不刪到連結目標），再 `git worktree remove`（不用 `--force`），再 `git branch -d`（只收已併回的分支），最後 `git worktree prune`。任何一步失敗，該副本就保留並說明原因。session 結束時什麼都不刪，只提示有幾個副本可以收，收不收永遠由人決定。

環境變數：

| 變數 | 預設 | 意義 |
|---|---|---|
| `PARALLEL_GUARD_MAX` | CPU 核心數 − 2，介於 2～10 | 忙碌 agent 上限（同一台電腦所有 Claude Code 視窗合計），超過就擋 |
| `PARALLEL_GUARD_MIN_FREE_MB` | `2048` | 剩餘實體記憶體下限（MB），低於就擋 |
| `PARALLEL_GUARD_DIR` | `~/.claude/parallel-guard` | 各視窗回報忙碌數的共用資料夾（30 秒沒更新的視窗不算） |

讀不到記憶體時只套用 agent 上限。授權 MIT。
