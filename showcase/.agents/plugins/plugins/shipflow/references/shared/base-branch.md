# Base branch (shared reference)

> The one rule for which branch new work is cut from, synced from, reviewed against and
> PR'd into. Referenced by shipflow `create-worktree` and `sync-branch`,
> `ship-task` (and its `epic.md`), `cut-task`, `fix-task`, `review-task-code`,
> `shared/phase-contract.md` and the reviewer agents. Executable form:
> `scripts/sf-base-branch.mjs`, called through `../../scripts/`. The `.sf-developer` grammar and the exact precedence
> live in that script's header; this file never restates the grammar.

No skill or agent resolves the base inline. Reading the override variable or probing
`development`/`develop` yourself is what let every copy fall back silently when an
override was missing on origin; the resolver is the only place that logic lives, and
`scripts/__tests__/spec-base-branch.test.mjs` fails on any inline copy.

## Precedence

First hit wins:

1. `base_branch` in the run's runstate (`--runstate`) — a resume keeps the base it
   started on, even if the workspace setting changed since.
2. The task body's `## Base branch` (`--task-base`).
3. A non-empty `SF_BASE_BRANCH` environment variable.
4. `target=` in `.sf-developer` at the top of the checkout (`--cwd`).
5. Auto-detect: origin `development`/`develop` → `origin/HEAD` → `main`/`master`/`trunk`
   (→ the current branch, with `--allow-current`, create-worktree only).

An override (1–4) equal to `--head` (the branch being synced, PR'd or pushed) is skipped
and resolution falls to the next level. An override that is not on origin
(`refs/remotes/origin/<branch>` does not resolve) is an **error**, never a fallback. The
resolver never fetches: every caller runs its own `git fetch origin` first.

## Call forms

Every call ends in a stop. Nothing may follow `||` except the stop — never `|| true`,
never `|| echo`, never a default branch. The resolver's stderr already names the branch,
where the setting came from, and the next step.

```bash
# General (Stage 0 of the ship-* skills; a stop here is preflight-failed)
git fetch origin --quiet 2>/dev/null || true
BASE_BRANCH=$(node "../../scripts/sf-base-branch.mjs") || { echo "CHECKPOINT_REQUIRED: preflight-failed (base branch)"; exit 1; }

# Syncing or PR'ing the current branch: skip an override that names the branch itself
BASE_BRANCH=$(node "../../scripts/sf-base-branch.mjs" --head "$CURRENT") || exit 1

# create-worktree only: the current branch is a last auto-detect rung
BASE_BRANCH=$(node "../../scripts/sf-base-branch.mjs" --allow-current) || exit 1

# The repo's integration branch, ignoring every override (release rule)
INTEGRATION_BRANCH=$(node "../../scripts/sf-base-branch.mjs" --integration) || exit 1

# The launch checkout's .sf-developer as JSON: {"developer":…|null,"target":…|null}
SETTINGS=$(node "../../scripts/sf-base-branch.mjs" --settings) || exit 1
```

Inside the ship-* skills `$SF` is the shipflow scripts directory, so `node
"$SF/sf-base-branch.mjs" …` is the same call. Exit codes: 0 prints the branch; 1 is a
resolution error (missing override, bad grammar, bad runstate, nothing found); 2 is a
usage error.

**Reviewer agents.** An agent reviews against the base branch its prompt names. With none
named, it runs `node "../../scripts/sf-base-branch.mjs"`; if that command
cannot run or exits non-zero, the agent stops and reports that it has no base branch. It
never assumes `development`.

## Pickup rule (ship-task)

A pickup re-resolves; Stage 0's value serves new-task mode only. In both worktree and
inline mode, before any worktree or branch is created:

1. **Runstate source.** The reused worktree's `docs/plans/<task|issue>-<id>.runstate.json`;
   else `git show origin/$BRANCH:<that path>` written to a temp file; else none. Inline
   mode reads it the `git show` way, before `git switch`.
2. **Resolve** with `--cwd` (the reused worktree when one exists, else the launch
   checkout), `--runstate`, `--task-base "$TASK_BASE"` (ship-task only; the task body's
   `## Base branch`, empty when absent) and `--head "$BRANCH"`. A stop here is
   `CHECKPOINT_REQUIRED: base-branch-missing`, never `preflight-failed` (that one fires
   before any worktree exists).
3. **Fresh branch** (worktree mode, no reusable worktree): the fresh-branch block below.
   When the base came from the runstate or the task body (`$PERSIST_TARGET`), the new
   worktree's `.sf-developer` records it as `target=`, so `$sync-branch` and
   the reviewer agents in that worktree agree with the run. An override the operator
   exported in the environment is never persisted.
4. The existing base-correct block, then the pickup integration sync (`AT=1b`).
5. **Record.** At the push-gate kick, after an adopt's `init --resume`:
   `node "$SF/sf-log.mjs" cursor "$RUNSTATE" base_branch="\"$BASE_BRANCH\""`. The
   JSON-quoted form keeps a name such as `123` a string (`sf-log cursor` JSON-parses
   values). The write is idempotent.

Steps 1–2 (`RS_REL` is `docs/plans/task-$TASK_ID.runstate.json`; `WT_PATH` is empty in
inline mode; `TASK_BASE` is empty when the body has no `## Base branch`):

```bash
RS_FILE=""
if [ -n "$WT_PATH" ] && [ -f "$WT_PATH/$RS_REL" ]; then RS_FILE="$WT_PATH/$RS_REL"
elif git cat-file -e "origin/$BRANCH:$RS_REL" 2>/dev/null; then RS_FILE=$(mktemp); git show "origin/$BRANCH:$RS_REL" > "$RS_FILE"; fi
RESOLVE_CWD=$(git rev-parse --show-toplevel); [ -n "$WT_PATH" ] && [ -d "$WT_PATH" ] && RESOLVE_CWD="$WT_PATH"
BASE_BRANCH=$(node "$SF/sf-base-branch.mjs" --cwd "$RESOLVE_CWD" ${RS_FILE:+--runstate "$RS_FILE"} --task-base "$TASK_BASE" --head "$BRANCH") || { echo "CHECKPOINT_REQUIRED: base-branch-missing"; exit 1; }
# Persist only a base that came from the runstate or the task body (never an exported override).
RS_BASE=""
[ -n "$RS_FILE" ] && RS_BASE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).base_branch ?? ""' "$RS_FILE")
PERSIST_TARGET=""
{ [ "$BASE_BRANCH" = "$RS_BASE" ] || [ "$BASE_BRANCH" = "$TASK_BASE" ]; } && PERSIST_TARGET="$BASE_BRANCH"
```

**Fresh-branch block.** The repo script cuts from `$BASE_BRANCH` because the pickup base
is handed to it as its override. It receives `--target` only when it advertises the flag:
an older repo script rejects an unknown option and exits 1, so for that script the target
line is appended after it returns. With no repo script, shipflow `create-worktree` Steps
1.5, 2, 3 and 4 run for `$BRANCH` with `DEFAULT="$BASE_BRANCH"`, `WORKTREE="$WT_PATH"`,
`WT_TARGET="${PERSIST_TARGET:-$LAUNCH_TARGET}"` and `DEV_NAME` already set; its Step 1 (a
resolve without the runstate or task body) and Step 1.6 (the name question, already asked)
are skipped. `DEV_NAME` and `LAUNCH_TARGET` come from the §Worktree name question below, so
the fallback inherits the launch checkout's `target=` as the repo script does.

```bash
if [ -f scripts/create-worktree.sh ]; then
  if [ -n "$PERSIST_TARGET" ] && grep -q -- '--target' scripts/create-worktree.sh; then
    SF_BASE_BRANCH="$BASE_BRANCH" bash scripts/create-worktree.sh "$BRANCH" ${DEV_NAME:+--developer "$DEV_NAME"} --target "$PERSIST_TARGET"
  else
    SF_BASE_BRANCH="$BASE_BRANCH" bash scripts/create-worktree.sh "$BRANCH" ${DEV_NAME:+--developer "$DEV_NAME"}
    if [ -n "$PERSIST_TARGET" ] && ! grep -q '^target=' "$WT_PATH/.sf-developer" 2>/dev/null; then
      printf 'target=%s\n' "$PERSIST_TARGET" >> "$WT_PATH/.sf-developer"
    fi
  fi
fi
# No repo script: shipflow create-worktree Steps 1.5, 2, 3, 4 (see above).
```

An epic records its base as a `base: <branch>` line right after `prd-sha:` in the epic
checklist comment. An epic resume (ship-task Stage 1A, `epic.md`) extracts
the value by command substitution (a jq `capture` of `base: (?<b>\S+)`, never typed from
the comment) and resolves with `--task-base "$RECORDED_BASE"`, so it keeps that base
whichever checkout resumes it. A missing branch or a value failing the §Task-body rule
parse rule stops with `base-branch-missing`, and an epic with no `base:` line keeps
Stage 0's value. Epic phase subtasks and phase or scratch worktrees take the epic's
recorded base (the parent's `## Base branch`, or the runstate `base_branch`) and never
re-resolve from their own checkout.

## Worktree name question

Every worktree created from a workspace whose `.sf-developer` has a name asks one
the available structured user-input tool before the worktree exists: **Inherit `<name>`** (recommended; shares the
`-dev-<name>` stacks), **New name**, or **No name**. The answer reaches the repo script as
`--developer <name>` (omitted for no name) and the fallback path as the name line it
writes. `target=` is inherited without asking. Internal phase and scratch worktrees never
ask and get no `.sf-developer`. In the ship-* skills the question is asked on the
fresh-worktree path only (a reused worktree keeps its file), from the launch checkout's
settings, and logs `operator-wait` first:

```bash
SETTINGS=$(node "$SF/sf-base-branch.mjs" --settings) || { echo "CHECKPOINT_REQUIRED: base-branch-missing (.sf-developer)"; exit 1; }
LAUNCH_DEV=$(node -p 'JSON.parse(process.argv[1]).developer ?? ""' "$SETTINGS")
LAUNCH_TARGET=$(node -p 'JSON.parse(process.argv[1]).target ?? ""' "$SETTINGS")   # the no-script fallback's inherited target=
DEV_NAME=""   # set from the answer when LAUNCH_DEV is non-empty: the name, a new name, or empty
```

## Task-body rule (tracked-task skills)

`$cut-task` resolves the base once (the general call form, before it writes the body) and
writes, right after `## Branch`:

```markdown
## Base branch
`feature/x`
```

into the single-task body, the parent body and every phase subtask body (which carry the
parent's value). ship-task Stage 2.7 subtask bodies carry the run's `$BASE_BRANCH`.
`fix-task` writes the bug subtask's section from a resolve with `--task-base <the parent's
## Base branch>`, which stops when that branch is missing. ship-task Stage 1B parses the
optional section into `$TASK_BASE`; the split-phase skills and `fix-task` inherit it through
`shared/phase-contract.md`.

**Parse rule.** Anyone who can edit a task or issue body or post a comment controls its
text, so a branch value read from one (`## Branch`, `## Base branch`, the epic checklist
comment's `base:` line) reaches a shell only after a check:
with the backticks stripped, it must match `^[A-Za-z0-9._/-]+$` and must not start with
`-` (the resolver's own value rule). A value that fails stops the run, `base-branch-missing`
for `## Base branch` and the `base:` line, the skill's cut-failed checkpoint for `## Branch`,
and is never pasted into a command. Assign an accepted value in single quotes: `TASK_BASE='feature/x'`.
The `base:` line never passes through a typed assignment: it arrives by command
substitution, and `--task-base` applies this check.

## Release rule

Compare the run's `$BASE_BRANCH` — the ultimate base, never a stacked layer's PR base —
with `INTEGRATION_BRANCH` (the `--integration` call). When they differ, the task still
lands at `development complete`, and both the `**[ship-task · pr]**` comment and the final
report say that the PR targets `<base>` and that the task stays `development complete`
until `<base>` merges into `<integration>`. A release process that collects
`development complete` tasks should hold such a task until its base has merged.
