#!/usr/bin/env python3
"""
@file seat-guard.py
@description Stop hook: refuse to end the turn while a sf-codex writer/review seat is still running.
@domain hooks

Why: a seat launched as `nohup … &` inside a foreground Bash call returns at once, so a turn
can end with the seat still running and nothing armed to wake the orchestrator when it
finishes — the run then idles until the operator prompts it. The skill text forbids that
shape (ship-task §3e); this hook enforces it.

How: a sf-codex seat is a `codex exec …` (reviewer) or `codex app-server …` (writer) process
whose CODEX_HOME is a per-run home under ~/.cache/sf-codex/<run>/ (sf-codex `home init`). If one
is alive, the stop is blocked with a
reason telling the orchestrator to arm a waiter. `stop_hook_active` (Claude Code sets it when a
previous Stop hook already blocked this turn) is honoured → exit 0, so a stray seat can never
loop the session. SF_SEAT_GUARD=off disables it.

Session scoping: `pgrep -f "codex (exec|app-server)"` is host-wide, so on a machine running two Claude Code
sessions (e.g. an interactive session while a ship-task runs in another worktree) the guard would
otherwise block session B's turn on session A's seats and tell it to wake a run it never launched.
Every seat inherits `CLAUDE_CODE_SESSION_ID` from the session that spawned it (visible in the same
environ this hook already reads for CODEX_HOME), so the guard blocks only on seats whose launching
session matches this Stop's `session_id`. A seat whose launching session is unreadable is still
blocked (never regress the asleep-turn bug); a seat that plainly belongs to a *different* session
is ignored. When this session's own id cannot be determined at all, the guard blocks on every seat
(the pre-scoping behaviour — protection is never weakened when identity is unknown).

Portability: Linux reads /proc/<pid>/environ; elsewhere falls back to `ps eww`, and when neither
can see an environment the hook allows the stop (never a false block on an unknown platform).
"""
import json
import os
import subprocess
import sys

RUN_HOME_MARK = os.path.join(".cache", "sf-codex") + os.sep


def _stdin_json():
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return {}


def _codex_pids():
    try:
        out = subprocess.run(["pgrep", "-f", "codex (exec|app-server)"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(p) for p in out.split() if p.isdigit() and int(p) != os.getpid()]


def _environ_of(pid):
    proc = f"/proc/{pid}/environ"
    if os.path.exists(proc):
        try:
            with open(proc, "rb") as fh:
                return fh.read().decode("utf-8", "replace")
        except OSError:
            return None
    try:  # macOS / BSD: `ps eww` prints the command with its environment appended
        return subprocess.run(["ps", "eww", "-o", "command=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def live_seats():
    """[(pid, run name, launching session id | None)] for every codex process whose CODEX_HOME
    is a sf-codex run home. The session id is the CLAUDE_CODE_SESSION_ID the seat inherited from
    the session that spawned it — the scoping key that keeps one session's guard off another's seats."""
    seats = []
    for pid in _codex_pids():
        env = _environ_of(pid)
        if env is None:
            continue
        # /proc: NUL-separated KEY=VAL; ps eww: whitespace-separated tokens after the command.
        tokens = env.split("\0") if "\0" in env else env.split()
        run = session = None
        for tok in tokens:
            if run is None and tok.startswith("CODEX_HOME=") and RUN_HOME_MARK in tok:
                run = tok.split("=", 1)[1].rstrip("/").rsplit(os.sep, 1)[-1]
            elif session is None and tok.startswith("CLAUDE_CODE_SESSION_ID="):
                session = tok.split("=", 1)[1] or None
        if run is not None:
            seats.append((pid, run, session))
    return seats


def main():
    if os.environ.get("SF_SEAT_GUARD", "").lower() in ("off", "0", "false"):
        return 0
    payload = _stdin_json()
    if payload.get("stop_hook_active"):
        return 0  # already blocked once this turn — never loop
    seats = live_seats()
    if not seats:
        return 0
    # Scope to this session's seats: a seat that plainly belongs to a different session is ignored;
    # one whose launching session is unreadable is still blocked. If we cannot identify our own
    # session, keep every seat (pre-scoping behaviour — never weaken protection on unknown identity).
    my_session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID") or None
    if my_session is not None:
        seats = [s for s in seats if s[2] is None or s[2] == my_session]
    if not seats:
        return 0
    runs = sorted({run for _, run, _ in seats})
    reason = (
        f"{len(seats)} sf-codex seat(s) still running for run {', '.join(runs)} (pids "
        f"{', '.join(str(p) for p, _, _ in seats)}). Do not end the turn on a running seat: arm a waiter now — "
        "a run_in_background Bash call (or Monitor) on the seat's artifact (fix-r<N>.md / implement-<batch>.md / "
        "panel-*.json) — then continue when it lands. ship-task §3e; review-backend.md §Substitution table. "
        "If the seat is a stray from a finished run, kill it and stop again."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
