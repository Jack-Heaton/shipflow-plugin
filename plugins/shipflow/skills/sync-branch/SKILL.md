---
name: sync-branch
description: "Merge the repo's base branch (the shared sf-base-branch resolver: an explicit override or the workspace's .sf-developer target=, else the integration branch development/develop, else the repo default like main) into the current feature branch. Usage: /sync-branch"
user_invocable: true
---

# /sync-branch — Merge the default branch into the current feature branch

Headless-friendly branch sync. Stack-agnostic: targets the repo's **base branch** as the
shared resolver (`scripts/sf-base-branch.mjs`) picks it — an explicit override or this
checkout's `.sf-developer` `target=` first, else the integration branch, else the repo
default such as `main`, rather than blindly trusting `origin/HEAD` — and validates with
whatever toolchain the repo actually uses. Can be run as:
```
claude -p "/sync-branch" --allowedTools "Bash,Read,Edit,Grep"
```

## Procedure

### 1. Resolve base (integration) branch and current branch

```bash
CURRENT=$(git branch --show-current)
git fetch origin --quiet 2>/dev/null || true
# Resolve the base branch with the shared resolver (precedence and grammar: its header;
# shipflow skills/shared/base-branch.md). --head skips an override naming this branch
# itself. An override missing on origin stops here, never a silent fallback.
DEFAULT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/sf-base-branch.mjs" --head "$CURRENT") || { echo "ERROR: no usable base branch (see the message above); nothing was merged."; exit 1; }
echo "Sync base branch resolved to: $DEFAULT"
```

If the resolver exits non-zero, stop and relay its message (push the named branch or
correct the setting, then `git fetch origin`) — never merge a substitute branch.

**Refuse if the current branch is protected.** Check `$CURRENT` against the resolved `$DEFAULT` **and** the full protected set — `main`, `master`, `staging`, `prod`, `production`, `development`, `develop`. The resolved default alone is not enough: on a repo where `$DEFAULT` is `development`, running this on `staging` would merge `development` into `staging` and commit — a release-promotion action this skill must never perform (and the conflict-path `git commit` would be blocked mid-merge by the safety-guard hook, stranding a half-merged protected branch).
> "You are on `$CURRENT` (a protected branch). /sync-branch is for feature branches only."

### 2. Handle Dirty Working Directory

Check `git status --short`. If there are uncommitted changes:

1. Show the user what's dirty
2. **Screen for sensitive/unexpected files before staging** — `git add -A` sweeps *untracked* files into history, and this skill is advertised for headless runs where nobody is watching. If the dirty set includes anything matching `.env*`, `*.pem`, `*.key`, `credentials*`, `secrets*`, or files you cannot attribute to known work in progress: **stop and report** (interactive: ask the user which files to include) instead of auto-committing. Never auto-commit a file that looks like a secret.
3. Stage and commit as WIP:
   ```bash
   git add -A && git commit -m "wip: auto-commit before sync-branch"
   ```
4. Note the WIP commit SHA for the report

### 3. Fetch and Merge

```bash
git fetch origin
git merge "origin/$DEFAULT" --no-edit
```

**If merge succeeds cleanly:** proceed to step 5.

**If merge conflicts:**

1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each conflicted file:
   - If the file was actively modified on this branch (appears in `git log --name-only origin/$DEFAULT..HEAD`): **keep the current branch version** (`git checkout --ours <file> && git add <file>`)
   - Otherwise: **keep the default-branch version** (`git checkout --theirs <file> && git add <file>`)
3. Complete the merge: `git commit --no-edit`
4. Record all conflict resolutions for the report

**If merge fails catastrophically:** abort and report:
```bash
git merge --abort
```
> "Merge aborted. Manual intervention required."

### 4. Handle Merge Failure

If `git merge --abort` was needed, report:
- Current branch name
- The error message
- Suggestion: "Run `git merge origin/$DEFAULT` manually and resolve conflicts"

Stop here — do not proceed further.

### 5. Post-Merge Validation (auto-detected)

Run whatever validation the repo supports, scoped to what changed. Detect the
toolchain — do **not** assume a specific directory layout:

- **TypeScript:** if a `tsconfig.json` exists at the repo root or inside a changed
  workspace/package, run `npx tsc --noEmit` there.
- **JS/TS monorepo:** if `turbo.json` exists, `npx turbo run build --filter=...` for
  affected packages; otherwise run the package's own `build`/`typecheck` script.
- **Other stacks:** run the project's standard check if obvious from changed files
  (e.g. `cargo check`, `go build ./...`, `python -m mypy`). Skip if none is evident.

Record pass/fail per check. Timeout: 5 minutes each (60s was chronically too short
for a cold monorepo typecheck — a gate that always times out trains people to ignore
it). Report a timeout as TIMEOUT, distinct from FAIL. If no validation toolchain is
detected, note "no validation step detected" and continue.

### 6. Report

```
## Sync Complete

| Item | Value |
|------|-------|
| Branch | `$CURRENT` |
| Merged from | `origin/$DEFAULT` |
| WIP commit | $SHA (if applicable) |
| Conflicts | N files (resolved automatically) |
| Validation | PASS / FAIL / none detected (details below) |

### Conflict Resolutions (if any)
- `path/to/file` — kept current branch (actively modified)
- `path/to/other` — kept default branch (no local changes)

### Validation Errors (if any)
[First 20 lines of output]
```

## Safety Rules

1. **Merge only** — NEVER use `git rebase`. Merge preserves history and is safer for shared branches.
2. **Never force push** — Under no circumstances run `git push --force` or `git push -f`.
3. **Abort on failure** — If the merge cannot be completed, run `git merge --abort` and report.
4. **No branch switching** — Stay on the current branch. Do not checkout the default branch.
5. **Refuse protected branches** — Do not run when the current branch is the resolved default or any of `main`/`master`/`staging`/`prod`/`production`/`development`/`develop`. Syncing is for feature branches; anything else is a release promotion in disguise.
