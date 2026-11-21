#!/usr/bin/env python3
"""
@file session-resumed.py
@description SessionStart(resume) hook: stamp `session-resumed` on every live run ledger so a
  dropped-and-resumed orchestrator session is a marked gap, not orchestrator time.
@domain hooks

Why: a ship-* run's ledger (docs/plans/<skill>-<epoch>.jsonl) records when each seat returns,
so the wall between events is where /ship-report reads orchestrator time, operator waits, and
seat time from. A session that drops (network, host sleep) and comes back through
`claude --resume` / `--continue` writes nothing — the orchestrator does not know it was gone —
and the ledger then shows a silent gap that is indistinguishable from the orchestrator thinking
for an hour. Measured 2026-09-07 on three runs: the 30–55 min gaps before fixer/implementer
spawns could not be attributed either way. This hook is the marker: SessionStart fires with
`source: "resume"` exactly in that case, and the gap that precedes the mark is then reported as
a session gap.

How: reads the hook payload on stdin ({session_id, cwd, source, …}); for `source == "resume"`
finds every runstate `docs/plans/*.runstate.json` under cwd (and cwd/.worktrees/*/) whose
`stage` is not `done`, whose `updated` is within RUNSTATE_FRESH_HOURS, and whose `session_id`
(stamped by `sf-log cursor` from CLAUDE_CODE_SESSION_ID) is the resuming session's; resolves its
`log_path`, and appends one `{"stage":"session-resumed","source":"resume",…}` line to each.
Ownership matters: any session resuming in a checkout that holds another session's live run
would otherwise write a false mark into that run's ledger (and dirty a tree it does not own).
A runstate with no `session_id` is skipped until its owner's next cursor write stamps one.
Never blocks: every failure path exits 0 with nothing written. SF_SESSION_MARK=off disables it.
"""
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

RUNSTATE_FRESH_HOURS = 48
MARK_SOURCES = {"resume"}


def _stdin_json():
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return {}


def _parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def runstate_paths(cwd):
    """Every runstate under cwd's docs/plans and one level of .worktrees/*/docs/plans."""
    patterns = [
        os.path.join(cwd, "docs", "plans", "*.runstate.json"),
        os.path.join(cwd, ".worktrees", "*", "docs", "plans", "*.runstate.json"),
    ]
    found = []
    for pat in patterns:
        found.extend(glob.glob(pat))
    return sorted(set(found))


def live_logs(cwd, session_id, now=None):
    """[(runstate path, log path)] for runs this session owns that are not done and were touched recently."""
    if not session_id:
        return []
    now = now or datetime.now(timezone.utc)
    fresh_after = now - timedelta(hours=RUNSTATE_FRESH_HOURS)
    out = []
    for rs in runstate_paths(cwd):
        try:
            with open(rs, "r", encoding="utf-8") as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(state, dict) or state.get("stage") == "done":
            continue
        if state.get("session_id") != session_id:
            continue
        updated = _parse_iso(state.get("updated"))
        if updated is None or updated < fresh_after:
            continue
        log_path = state.get("log_path")
        if not isinstance(log_path, str) or not log_path:
            continue
        if not os.path.isabs(log_path):
            log_path = os.path.join(os.path.dirname(rs), log_path)
        if os.path.isfile(log_path):
            out.append((rs, log_path))
    return out


def mark(log_path, runstate, session_id, source, now=None):
    now = now or datetime.now(timezone.utc)
    event = {
        "stage": "session-resumed",
        "source": source,
        "session_id": session_id,
        "runstate": runstate,
        "ts": now.isoformat().replace("+00:00", "Z"),
    }
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")
    return event


def main():
    if os.environ.get("SF_SESSION_MARK", "").lower() == "off":
        return 0
    payload = _stdin_json()
    source = payload.get("source")
    if source not in MARK_SOURCES:
        return 0
    cwd = payload.get("cwd") or os.getcwd()
    session_id = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    marked = 0
    for runstate, log_path in live_logs(cwd, session_id):
        try:
            mark(log_path, runstate, session_id, source)
            marked += 1
        except OSError:
            continue
    if marked:
        sys.stderr.write(f"shipflow session-resumed: marked {marked} live run ledger(s)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # a hook must never fail the session start
        sys.exit(0)
