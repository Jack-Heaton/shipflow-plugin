#!/usr/bin/env python3
"""
@file test_seat_guard.py
@description Unit tests for the seat-guard Stop hook's session scoping. Run: python3 test_seat_guard.py
@domain hooks

No third-party deps (stdlib unittest). Patches the two process-scanning internals
(`_codex_pids`, `_environ_of`) so the tests never touch the real host, then drives
`main()` with a crafted Stop payload and asserts what it blocks on.
"""
import importlib.util
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("seat_guard", os.path.join(_HERE, "seat-guard.py"))
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)

MINE = "aaaaaaaa-1111-2222-3333-444444444444"
OTHER = "bbbbbbbb-5555-6666-7777-888888888888"


def _environ_blob(**kv):
    """A /proc-style NUL-separated environ string."""
    return "\0".join(f"{k}={v}" for k, v in kv.items())


def _run(pid_env, stop_payload, env=None):
    """Drive main() with fake seats (pid -> environ dict) and a Stop payload; return parsed stdout or None."""
    pids = list(pid_env)
    def fake_environ_of(pid):
        e = pid_env[pid]
        return None if e is None else _environ_blob(**e)
    buf = io.StringIO()
    with mock.patch.object(sg, "_codex_pids", return_value=pids), \
         mock.patch.object(sg, "_environ_of", side_effect=fake_environ_of), \
         mock.patch.object(sg.sys, "stdin", io.StringIO(json.dumps(stop_payload))), \
         mock.patch.dict(os.environ, env or {}, clear=False):
        with redirect_stdout(buf):
            rc = sg.main()
    out = buf.getvalue().strip()
    return rc, (json.loads(out) if out else None)


class SeatGuardScoping(unittest.TestCase):
    def _home(self, run):
        return os.path.join(os.path.expanduser("~"), ".cache", "sf-codex", run)

    def test_blocks_on_own_session_seat(self):
        pid_env = {100: {"CODEX_HOME": self._home("ship-task-1"), "CLAUDE_CODE_SESSION_ID": MINE}}
        rc, out = _run(pid_env, {"session_id": MINE})
        self.assertEqual(rc, 0)
        self.assertIsNotNone(out)
        self.assertEqual(out["decision"], "block")
        self.assertIn("ship-task-1", out["reason"])

    def test_ignores_other_session_seat(self):
        # The leak this fix closes: another session's seat must not block me.
        pid_env = {200: {"CODEX_HOME": self._home("ship-task-2"), "CLAUDE_CODE_SESSION_ID": OTHER}}
        rc, out = _run(pid_env, {"session_id": MINE})
        self.assertEqual(rc, 0)
        self.assertIsNone(out)  # allowed — no block emitted

    def test_blocks_on_own_ignores_other_together(self):
        pid_env = {
            100: {"CODEX_HOME": self._home("ship-task-1"), "CLAUDE_CODE_SESSION_ID": MINE},
            200: {"CODEX_HOME": self._home("ship-task-2"), "CLAUDE_CODE_SESSION_ID": OTHER},
        }
        rc, out = _run(pid_env, {"session_id": MINE})
        self.assertEqual(out["decision"], "block")
        self.assertIn("ship-task-1", out["reason"])
        self.assertNotIn("ship-task-2", out["reason"])
        self.assertIn("100", out["reason"])
        self.assertNotIn("200", out["reason"])

    def test_unreadable_session_still_blocks(self):
        # A seat with no CLAUDE_CODE_SESSION_ID is unattributable — block, never regress the asleep bug.
        pid_env = {300: {"CODEX_HOME": self._home("ship-task-3")}}
        rc, out = _run(pid_env, {"session_id": MINE})
        self.assertEqual(out["decision"], "block")
        self.assertIn("ship-task-3", out["reason"])

    def test_unknown_own_session_blocks_all(self):
        # Cannot identify our own session (no payload id, no env) -> pre-scoping behaviour, block everything.
        pid_env = {200: {"CODEX_HOME": self._home("ship-task-2"), "CLAUDE_CODE_SESSION_ID": OTHER}}
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
            rc, out = _run(pid_env, {})
        self.assertEqual(out["decision"], "block")
        self.assertIn("ship-task-2", out["reason"])

    def test_falls_back_to_env_session_id(self):
        # No session_id in the payload, but the hook inherited CLAUDE_CODE_SESSION_ID — scope by that.
        pid_env = {200: {"CODEX_HOME": self._home("ship-task-2"), "CLAUDE_CODE_SESSION_ID": OTHER}}
        rc, out = _run(pid_env, {}, env={"CLAUDE_CODE_SESSION_ID": MINE})
        self.assertIsNone(out)  # OTHER seat ignored because our env id is MINE

    def test_no_seats_allows(self):
        rc, out = _run({}, {"session_id": MINE})
        self.assertIsNone(out)

    def test_stop_hook_active_never_loops(self):
        pid_env = {100: {"CODEX_HOME": self._home("ship-task-1"), "CLAUDE_CODE_SESSION_ID": MINE}}
        rc, out = _run(pid_env, {"session_id": MINE, "stop_hook_active": True})
        self.assertIsNone(out)

    def test_disable_switch(self):
        pid_env = {100: {"CODEX_HOME": self._home("ship-task-1"), "CLAUDE_CODE_SESSION_ID": MINE}}
        rc, out = _run(pid_env, {"session_id": MINE}, env={"SF_SEAT_GUARD": "off"})
        self.assertIsNone(out)

    def test_non_sf_codex_home_ignored(self):
        # A codex exec whose CODEX_HOME is not a sf-codex run home is not a seat.
        pid_env = {400: {"CODEX_HOME": "/home/node/.codex", "CLAUDE_CODE_SESSION_ID": MINE}}
        rc, out = _run(pid_env, {"session_id": MINE})
        self.assertIsNone(out)


if __name__ == "__main__":
    unittest.main()
