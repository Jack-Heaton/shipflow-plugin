#!/usr/bin/env python3
"""
@file safety-guard.py
@description Pre-tool safety checks to block dangerous operations (PreToolUse hook)
@domain hooks

Enforces safety rules:
- Block destructive SQL aimed at anything named prod/production
- Block force pushes to protected branches and `rm -rf` of the repo root / home / filesystem root
- Block git commit/push on protected branches (development/main/master/staging)
- Warn about .env file modifications
- Enforce security-sensitive code patterns
"""
import json
import os
import subprocess
import sys
import re
from typing import Optional, Tuple

PROTECTED_BRANCHES = {'main', 'master', 'development', 'staging', 'prod', 'production'}
PROTECTED_BRANCH_OVERRIDE = '# allow-protected-branch'
# Scoped override: `# allow-protected-branch:<path>` — allowed only if <path> is a
# real git tree checked out on a NON-protected branch. This is what orchestrator
# skills (ship-task and its phase skills) use for worktree writes; unlike the bare marker it
# cannot be used to write to a protected branch.
SCOPED_OVERRIDE_RE = re.compile(r'#\s*allow-protected-branch:(\S+)')

GIT_WRITE_RE = re.compile(
    r'(?:^|[;&|\s])git\s+(?:commit|push)(?:\s|$)',
    re.IGNORECASE,
)

# Dangerous patterns that should be blocked or warned
BLOCKED_PATTERNS = [
    # Git force operations on main
    (r'git\s+push\s+.*(--force|\s-f\b).*\b(main|master|development|staging|prod|production)\b',
     'Force push to a protected branch blocked. This is destructive and requires explicit user approval.'),
    (r'git\s+reset\s+--hard\s+origin/(main|master)',
     'Hard reset to main/master blocked. This discards all local changes.'),

    # Destructive SQL against anything named prod / production
    (r'(DROP\s+(DATABASE|SCHEMA|TABLE)|DELETE\s+FROM|TRUNCATE).*(\b|_)prod(uction)?(\b|_)',
     'Destructive SQL against a production target blocked. Use a reviewed migration instead.'),
    (r'(\b|_)prod(uction)?(\b|_).*(DROP\s+(DATABASE|SCHEMA|TABLE)|DELETE\s+FROM|TRUNCATE)',
     'Destructive SQL against a production target blocked. Use a reviewed migration instead.'),

    # Recursive deletes of the filesystem root, home, or the current repo root
    (r'\brm\s+-[a-zA-Z]*(rf|fr)[a-zA-Z]*\s+(/|~|\$HOME|\.|\./|\*)(\s|$)',
     'Recursive delete of the filesystem root, home directory, or repository root blocked.'),
]

# Warning patterns (allow but provide context)
WARNING_PATTERNS = [
    # Env file modifications
    (r'\.env($|\.)',
     '⚠️ Modifying .env file. Ensure no secrets are committed to git.'),

    # Direct SQL modifications
    (r'(DELETE\s+FROM|DROP\s+(TABLE|DATABASE|INDEX)|TRUNCATE|ALTER\s+TABLE)',
     '⚠️ Destructive SQL operation. Consider running database-reviewer agent first.'),

    # Git config changes
    (r'git\s+config',
     '⚠️ Git config modification detected.'),

    # Package.json modifications
    (r'rm.*package.*\.json',
     '⚠️ Removing package.json. Ensure this is intentional.'),
]


def _extract_effective_cwd(command: str, default_cwd: str) -> str:
    """Resolve the directory a git command will actually run in.

    Handles `cd <path> && ...`, `cd <path>; ...`, `cd <path>` on its own line,
    and `git -C <path> ...`; otherwise falls back to the hook's view of cwd.

    The separator set matters. Until 2026-08-24 only `&&` was recognised, so
    `cd <worktree>; git push` and multi-line scripts resolved to the SESSION cwd —
    on a `/workspace`-rooted session that is `development`, and every worktree
    push was refused. Over five days that false positive produced 23 Codex
    refusals, 45 bare `# allow-protected-branch` bypasses and 7 `--no-verify`
    pushes: the guard trained both agents to bypass it.
    """
    cd_match = re.match(
        r'\s*cd\s+(?:"([^"]+)"|\'([^\']+)\'|(\S+))\s*(?:&&|;|\n|$)',
        command,
    )
    if cd_match:
        return cd_match.group(1) or cd_match.group(2) or cd_match.group(3)

    gitc_match = re.search(
        r'git\s+-C\s+(?:"([^"]+)"|\'([^\']+)\'|(\S+))',
        command,
    )
    if gitc_match:
        return gitc_match.group(1) or gitc_match.group(2) or gitc_match.group(3)

    return default_cwd


def _tool_cwd(tool_input: dict, session_cwd: str) -> str:
    """The directory the harness will run the command in.

    Claude Code's Bash tool runs in the session cwd. Codex's `exec_command`
    carries an out-of-band `workdir` (its adapter surfaces it in `tool_input`),
    which is the directory the command ACTUALLY runs in — a session rooted at
    `/workspace` routinely executes in `.worktrees/<branch>`. Honour that field,
    and any `cwd` a future adapter supplies, before the session-level fallback.
    """
    for key in ('workdir', 'cwd'):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return session_cwd


# `git push [<opts>] <remote> <refspec>`: an explicit refspec names the branch the push
# lands on, independent of cwd. `HEAD:development` and `feature:development` target a
# protected branch from anywhere; `origin fix/x` targets a feature branch from anywhere.
PUSH_REFSPEC_RE = re.compile(
    r'git\s+push\s+(?:-[-\w=]+\s+)*(?:\S+)\s+(?:\+)?(?:(\S+?):)?([^\s:]+)',
)


def _push_target_branch(command: str) -> Optional[str]:
    """Return the remote branch an explicit-refspec `git push` writes to, if any."""
    m = PUSH_REFSPEC_RE.search(command)
    if not m:
        return None
    dst = m.group(2)
    if dst.startswith('-') or dst.startswith('refs/tags/') or dst == '--tags':
        return None
    return dst.removeprefix('refs/heads/')


def _current_branch(cwd: str) -> Optional[str]:
    """Return the current git branch in `cwd`, or None if unavailable."""
    try:
        result = subprocess.run(
            ['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            return branch if branch and branch != 'HEAD' else None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def _is_shared_root(cwd: str) -> bool:
    """True when `cwd` is the primary checkout of a repository that keeps `.worktrees/`.

    Every concurrent session works out of that checkout, so the refusal must not
    suggest switching its branch: doing so swaps the files under another session's
    running pre-push hook. A checkout without `.worktrees/` (web sessions) has no
    other option than branching in place.
    """
    try:
        result = subprocess.run(
            ['git', '-C', cwd, 'rev-parse', '--path-format=absolute',
             '--git-dir', '--git-common-dir', '--show-toplevel'],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode != 0:
            return False
        git_dir, common_dir, top_level = result.stdout.strip().split('\n')
        return (os.path.realpath(git_dir) == os.path.realpath(common_dir)
                and os.path.isdir(os.path.join(top_level, '.worktrees')))
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError, ValueError):
        return False


def _branch_route(cwd: str) -> str:
    """Where the refused write should go instead, for this kind of checkout."""
    if _is_shared_root(cwd):
        return (
            "This is the shared root checkout: do not switch its branch — other "
            "sessions and their pre-push hooks read this tree. Create a worktree "
            "(`/create-worktree <branch>`), carry uncommitted edits across with "
            "`git diff | git -C <worktree> apply`, and commit there. "
        )
    return "Switch to a feature branch or worktree. "


def check_protected_branch(command: str, cwd: str) -> Optional[Tuple[str, bool]]:
    """Block `git commit`/`git push` when the effective branch is protected.

    Overrides (checked in order — the scoped form must be tested before the bare
    substring, which it contains):
    - `# allow-protected-branch:<path>` — verified: allowed only when <path> is a
      git tree on a non-protected branch; a bad path or protected target BLOCKS.
    - `# allow-protected-branch` (bare) — unverified escape hatch for interactive
      use (documented by /commit). Orchestrator skills must use the scoped form.
    """
    if not GIT_WRITE_RE.search(command):
        return None

    scoped = SCOPED_OVERRIDE_RE.search(command)
    if scoped:
        target = scoped.group(1)
        target_branch = _current_branch(target)
        if target_branch and target_branch not in PROTECTED_BRANCHES:
            return None
        return (
            f"Scoped override rejected: `{target}` is "
            + (f"checked out on protected branch `{target_branch}`."
               if target_branch else "not a resolvable git working tree.")
            + " The scoped `# allow-protected-branch:<path>` marker only authorizes"
            " writes into a worktree on a non-protected branch.",
            True,
        )

    if PROTECTED_BRANCH_OVERRIDE in command:
        return None

    # An explicit push refspec settles the question without consulting cwd: the branch
    # the push writes to is named in the command. This is what makes the guard correct
    # from a `/workspace`-rooted session pushing a worktree branch, and what makes
    # `git push origin HEAD:development` from a feature worktree still refuse.
    push_target = _push_target_branch(command)
    if push_target is not None:
        if push_target in PROTECTED_BRANCHES:
            return (
                f"Refusing git push to protected branch `{push_target}` (explicit refspec). "
                f"Open a PR instead. If this is intentional, re-run with "
                f"`{PROTECTED_BRANCH_OVERRIDE}` in the command.",
                True,
            )
        return None

    effective_cwd = _extract_effective_cwd(command, cwd)
    branch = _current_branch(effective_cwd)
    if branch is None or branch not in PROTECTED_BRANCHES:
        return None

    message = (
        f"Refusing git commit/push on protected branch `{branch}` "
        f"(cwd: {effective_cwd}). {_branch_route(effective_cwd)}"
        f"If the command runs in a worktree, say so: `cd <worktree> && …`, "
        f"`git -C <worktree> …`, or name the branch (`git push origin <branch>`). "
        f"If this is intentional, re-run with `{PROTECTED_BRANCH_OVERRIDE}` "
        f"in the command."
    )
    return (message, True)


def check_bash_command(command: str, cwd: str) -> Optional[Tuple[str, bool]]:
    """Check bash command for dangerous patterns.

    Returns (message, is_blocked) or None if safe.
    """
    protected = check_protected_branch(command, cwd)
    if protected:
        return protected

    # Check blocked patterns first
    for pattern, message in BLOCKED_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return (message, True)

    # Check warning patterns
    for pattern, message in WARNING_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return (message, False)

    return None


def check_file_operation(file_path: str, tool_name: str) -> Optional[Tuple[str, bool]]:
    """Check file operations for sensitive patterns.

    Returns (message, is_blocked) or None if safe.
    """
    # Check for .env file modifications
    if '.env' in file_path.lower():
        return ('⚠️ Modifying environment file. Ensure no secrets are committed.', False)

    # Check for credential/secret file modifications
    secret_patterns = [
        r'credentials?\.json',
        r'secrets?\.json',
        r'\.pem$',
        r'\.key$',
        r'private.*key',
    ]
    for pattern in secret_patterns:
        if re.search(pattern, file_path, re.IGNORECASE):
            return (f'⚠️ Modifying sensitive file: {file_path}. Verify this is intentional.', False)

    return None


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, IOError):
        sys.exit(0)

    hook_event = input_data.get('hook_event_name', '')

    if hook_event != 'PreToolUse':
        sys.exit(0)

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})
    cwd = input_data.get('cwd') or os.getcwd()

    result = None

    # Check Bash commands
    if tool_name == 'Bash':
        command = tool_input.get('command', '')
        result = check_bash_command(command, _tool_cwd(tool_input, cwd))

    # Check file operations
    elif tool_name in ['Write', 'Edit']:
        file_path = tool_input.get('file_path', '')
        result = check_file_operation(file_path, tool_name)

    if result:
        message, is_blocked = result

        if is_blocked:
            # Block the operation
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": message
                }
            }
        else:
            # Allow with warning context
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "additionalContext": message
                }
            }

        print(json.dumps(output))

    sys.exit(0)


if __name__ == '__main__':
    main()
