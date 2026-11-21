#!/usr/bin/env python3
"""
@file test_session_resumed.py
@description Unit tests for the session-resumed SessionStart hook. Run: python3 test_session_resumed.py
@domain hooks

Stdlib unittest, no host access: builds a temp cwd with runstates + ledgers and drives main()
with crafted SessionStart payloads.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("session_resumed", os.path.join(_HERE, "session-resumed.py"))
sr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sr)


def _iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


class Fixture:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="sf-session-resumed-")

    def run(self, rel_dir, task, stage="3-fix", updated=None, log_rel=None, log_path=None, owner="s"):
        d = os.path.join(self.root, rel_dir, "docs", "plans")
        os.makedirs(d, exist_ok=True)
        log = log_path or os.path.join(d, log_rel or f"ship-task-{task}.jsonl")
        if not os.path.exists(log):
            with open(log, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"stage": "run-meta", "skill": "ship-task", "task": task, "ts": _iso(datetime.now(timezone.utc))}) + "\n")
        rs = os.path.join(d, f"task-{task}.runstate.json")
        state = {"task": task, "stage": stage, "log_path": log,
                 "updated": _iso(updated or datetime.now(timezone.utc))}
        if owner is not None:
            state["session_id"] = owner
        with open(rs, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        return rs, log

    def rows(self, log):
        with open(log, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]


def _drive(payload, env=None):
    stdin = io.StringIO(json.dumps(payload))
    err = io.StringIO()
    with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stderr", err), \
            mock.patch.dict(os.environ, env or {}, clear=False):
        code = sr.main()
    return code, err.getvalue()


class SessionResumedTests(unittest.TestCase):
    def test_resume_marks_live_runs_in_cwd_and_worktrees(self):
        fx = Fixture()
        _, log_root = fx.run("", "aaa", owner="sess-1")
        _, log_wt = fx.run(os.path.join(".worktrees", "task-bbb"), "bbb", owner="sess-1")
        code, err = _drive({"source": "resume", "cwd": fx.root, "session_id": "sess-1"})
        self.assertEqual(code, 0)
        self.assertIn("marked 2", err)
        for log in (log_root, log_wt):
            last = fx.rows(log)[-1]
            self.assertEqual(last["stage"], "session-resumed")
            self.assertEqual(last["source"], "resume")
            self.assertEqual(last["session_id"], "sess-1")
            self.assertTrue(last["runstate"].endswith(".runstate.json"))
            self.assertTrue(last["ts"].endswith("Z"))

    def test_startup_and_compact_do_not_mark(self):
        fx = Fixture()
        _, log = fx.run("", "aaa")
        for source in ("startup", "compact", "clear", None):
            code, _ = _drive({"source": source, "cwd": fx.root, "session_id": "s"})
            self.assertEqual(code, 0)
        self.assertEqual(len(fx.rows(log)), 1, "only run-meta")

    def test_done_and_stale_runs_are_skipped(self):
        fx = Fixture()
        _, done_log = fx.run("", "done1", stage="done")
        _, stale_log = fx.run("", "old1", updated=datetime.now(timezone.utc) - timedelta(hours=49))
        _, live_log = fx.run("", "live1", updated=datetime.now(timezone.utc) - timedelta(hours=47))
        code, err = _drive({"source": "resume", "cwd": fx.root, "session_id": "s"})
        self.assertEqual(code, 0)
        self.assertIn("marked 1", err)
        self.assertEqual(len(fx.rows(done_log)), 1)
        self.assertEqual(len(fx.rows(stale_log)), 1)
        self.assertEqual(fx.rows(live_log)[-1]["stage"], "session-resumed")

    def test_missing_log_or_bad_runstate_never_fails(self):
        fx = Fixture()
        rs, log = fx.run("", "gone")
        os.remove(log)
        bad = os.path.join(fx.root, "docs", "plans", "task-bad.runstate.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        code, err = _drive({"source": "resume", "cwd": fx.root, "session_id": "s"})
        self.assertEqual(code, 0)
        self.assertEqual(err, "")

    def test_off_switch(self):
        fx = Fixture()
        _, log = fx.run("", "aaa")
        code, _ = _drive({"source": "resume", "cwd": fx.root, "session_id": "s"}, env={"SF_SESSION_MARK": "off"})
        self.assertEqual(code, 0)
        self.assertEqual(len(fx.rows(log)), 1)

    def test_relative_log_path_resolves_beside_runstate(self):
        fx = Fixture()
        d = os.path.join(fx.root, "docs", "plans")
        os.makedirs(d, exist_ok=True)
        log = os.path.join(d, "ship-task-rel.jsonl")
        with open(log, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"stage": "run-meta"}) + "\n")
        with open(os.path.join(d, "task-rel.runstate.json"), "w", encoding="utf-8") as fh:
            json.dump({"stage": "3e", "log_path": "ship-task-rel.jsonl", "session_id": "s",
                       "updated": _iso(datetime.now(timezone.utc))}, fh)
        code, err = _drive({"source": "resume", "cwd": fx.root, "session_id": "s"})
        self.assertEqual(code, 0)
        self.assertIn("marked 1", err)
        self.assertEqual(fx.rows(log)[-1]["stage"], "session-resumed")

    def test_only_runs_owned_by_the_resuming_session_are_marked(self):
        fx = Fixture()
        _, mine = fx.run("", "mine", owner="sess-1")
        _, theirs = fx.run("", "theirs", owner="sess-2")
        _, unowned = fx.run("", "legacy", owner=None)
        code, err = _drive({"source": "resume", "cwd": fx.root, "session_id": "sess-1"})
        self.assertEqual(code, 0)
        self.assertIn("marked 1", err)
        self.assertEqual(fx.rows(mine)[-1]["stage"], "session-resumed")
        self.assertEqual(len(fx.rows(theirs)), 1, "another session's run is not marked")
        self.assertEqual(len(fx.rows(unowned)), 1, "a runstate with no owner is not marked")

    def test_session_id_falls_back_to_env_and_absent_marks_nothing(self):
        fx = Fixture()
        _, log = fx.run("", "aaa", owner="sess-env")
        code, _ = _drive({"source": "resume", "cwd": fx.root}, env={"CLAUDE_CODE_SESSION_ID": "sess-env"})
        self.assertEqual(code, 0)
        self.assertEqual(fx.rows(log)[-1]["stage"], "session-resumed")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
            code, err = _drive({"source": "resume", "cwd": fx.root})
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(len(fx.rows(log)), 2, "no session id, no mark")


if __name__ == "__main__":
    unittest.main()
