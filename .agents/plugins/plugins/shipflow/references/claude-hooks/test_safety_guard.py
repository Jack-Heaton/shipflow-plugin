#!/usr/bin/env python3
"""
@file test_safety_guard.py
@description Unit tests for where the protected-branch refusal sends the write. Run: python3 test_safety_guard.py
@domain hooks

No third-party deps (stdlib unittest). Builds a throwaway repository on a protected
branch, with and without `.worktrees/`, and reads the refusal `check_protected_branch`
returns in each.
"""
import importlib.util
import os
import subprocess
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("safety_guard", os.path.join(_HERE, "safety-guard.py"))
sg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sg)


def _git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd, check=True, capture_output=True,
    )


class ProtectedBranchRouteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="sf-")
        self.root = os.path.join(os.path.realpath(self._tmp.name), "root")
        os.mkdir(self.root)
        _git(self.root, "init", "-q", "-b", "development")
        _git(self.root, "commit", "-q", "--allow-empty", "-m", "init")

    def tearDown(self):
        self._tmp.cleanup()

    def _refusal(self, cwd):
        verdict = sg.check_protected_branch("git commit -m x", cwd)
        self.assertIsNotNone(verdict)
        return verdict[0]

    def test_a_checkout_without_worktrees_may_branch_in_place(self):
        message = self._refusal(self.root)
        self.assertIn("Switch to a feature branch or worktree", message)
        self.assertNotIn("shared root checkout", message)

    def test_the_shared_root_is_sent_to_a_worktree_only(self):
        linked = os.path.join(self.root, ".worktrees", "fix-x")
        _git(self.root, "worktree", "add", "-q", linked, "-b", "fix/x")
        message = self._refusal(self.root)
        self.assertNotIn("Switch to a feature branch", message)
        for fact in ("shared root checkout", "/create-worktree", "git -C <worktree> apply", "allow-protected-branch"):
            self.assertIn(fact, message)

    def test_a_linked_worktree_on_a_feature_branch_is_not_refused(self):
        linked = os.path.join(self.root, ".worktrees", "fix-x")
        _git(self.root, "worktree", "add", "-q", linked, "-b", "fix/x")
        self.assertIsNone(sg.check_protected_branch("git commit -m x", linked))
        self.assertFalse(sg._is_shared_root(linked))


class BlockedPatternTests(unittest.TestCase):
    def _blocked(self, cmd):
        v = sg.check_bash_command(cmd, "/nonexistent")
        return v is not None and v[1]

    def test_destructive_commands_are_blocked(self):
        for cmd in (
            "git push --force origin main",
            "git push -f origin development",
            "psql -c 'DROP DATABASE app_prod'",
            "psql $PROD_URL -c 'TRUNCATE users'",
            "rm -rf /",
            "rm -rf ~",
            "rm -fr .",
        ):
            self.assertTrue(self._blocked(cmd), cmd)

    def test_ordinary_commands_pass(self):
        for cmd in ("git push origin fix/x", "rm -rf node_modules", "rm -rf ./dist", "psql -c 'select 1'"):
            self.assertFalse(self._blocked(cmd), cmd)


if __name__ == "__main__":
    unittest.main()
