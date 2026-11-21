# shipflow hooks

| Hook | Event | What it does |
|------|-------|--------------|
| `safety-guard.py` | PreToolUse (`Bash\|Write\|Edit`) | Refuses `git commit`/`git push` on a protected branch (`main`, `master`, `development`, `staging`, `prod`, `production`) unless the command carries the scoped `# allow-protected-branch:<worktree path>` marker naming a checkout on a non-protected branch (what ship-task prepends to sub-agent git writes) or the bare interactive escape hatch. Blocks force-pushes to protected branches, destructive SQL aimed at a prod-named target, and `rm -rf` of `/`, `~` or `.`; warns on `.env`, credential files and other destructive SQL. Tests: `python3 -m pytest hooks/`. |
| `session-resumed.py` | SessionStart (`resume`) | Appends a `session-resumed` event to the ledger of every live run under cwd (and `cwd/.worktrees/*/`) that the resuming session owns — a runstate not `done`, touched within 48 h, whose `session_id` (stamped by `sf-log cursor`) matches, via its `log_path` — so `/ship-report` attributes the gap before it to a dropped session instead of orchestrator time (`spawn-accounting.md` §Session marks). Never blocks; `SF_SESSION_MARK=off` disables it. Tests: `python3 hooks/test_session_resumed.py`. |
| `seat-guard.py` | Stop | Blocks ending the turn while a `sf-codex` seat (a `codex exec` reviewer or `codex app-server` writer whose `CODEX_HOME` is a `~/.cache/sf-codex/<run>/` run home) launched by **this** session is still running, with a reason telling the orchestrator to arm a `run_in_background`/`Monitor` waiter. Scoped by the `CLAUDE_CODE_SESSION_ID` each seat inherits, so one session's guard never blocks on another session's seats (`pgrep` is host-wide). Honours `stop_hook_active` (never loops); `SF_SEAT_GUARD=off` disables it. |

Why it exists: a fixer launched as `nohup … &` in a foreground Bash call lets the turn end
with the seat still running and nothing armed to wake the orchestrator when it finishes,
idling the run until the operator prompts it. The skill text forbids that shape
(ship-task §3e, review-backend.md §Substitution table); this hook is the enforcement.

Requires `python3` and `pgrep` on PATH. On hosts without `/proc` it reads the environment via
`ps eww`; when it cannot see a process environment at all it allows the stop.
