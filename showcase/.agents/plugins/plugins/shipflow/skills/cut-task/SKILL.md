---
name: cut-task
description: "Create a tracked task (a GitHub issue by default) and set up a worktree for it. PRD-shaped requests become a parent issue + one sub-issue per phase. Usage: $cut-task \"Task title\""
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $cut-task — Create a task and set up a worktree for it

Creates a task in the project tracker (GitHub Issues through `scripts/tracker.mjs`),
derives a branch name from the task content, and creates a worktree for development.
The task's status lives in a `status:<slug>` label, its domain in a `domain:<name>`
label, and its PR (opened later by `$ship-task`) carries `Refs #<n>` — never a closing
keyword, because the human closes the task after merge.

**Usage:** `$cut-task "Task title here"`

The argument `$ARGUMENTS` is the task title. If empty, ask the user for a title.

## Tooling — the `tracker` helper

All tracker interaction goes through the zero-dependency adapter at
`../../scripts/tracker.mjs` (never call the tracker API directly, never
hardcode issue numbers). It uses the `gh` CLI's authentication and the repository `gh`
resolves from the cwd (override with `--repo owner/name` or `$SF_TRACKER_REPO`). Invoke as
`node "../../scripts/tracker.mjs" <verb> …`.

Verbs used here:
- `tracker lists` → the repository and the status vocabulary (JSON).
- `tracker tag ensure <name>` → idempotently create a label (no-op if present). Used to
  self-provision taxonomy labels before applying them.
- `tracker task create --title <t> --body-file <md> [--status "to do"] [--parent <id>] [--tag <t>…]` → prints `{id, url, …}`.
- `tracker task view <id>` / `tracker task comment <id> --body-file <f>` — used for the PRD-mode checklist.
- `tracker task edit <id> [--title <t>] [--body-file <md>]` — replaces the body (full
  replacement — fetch with `task view` and re-emit when amending). Not used by cut-task
  itself; here for the ship-* skills and ad-hoc amendments.

**Comment attribution.** Every `tracker` mutation posts as the authenticated `gh` user, so
agent-posted comments open with a bold bracketed signature line —
`**[<agent-or-skill> · <context>]**`, e.g. `**[sf-implementer · phase 2]**` — to keep
task history attributable.

If `tracker lists` fails with an auth error, tell the user to run `gh auth login` — do
**not** try to fix credentials yourself.

## Concept mapping

| Concept | GitHub Issues backend |
|---|---|
| Task | Issue (same body section schema; id = issue number) |
| Status | Exactly one `status:<slug>` label; `shipped` / `cancelled` also close the issue |
| Domain | One `domain:<name>` label (§5) |
| Work type / layer / risk | Labels (§5) |
| Parent + phases | Parent issue + sub-issues (`--parent`), one per phase |
| PR link | `Refs #<n>` in the PR body + the sticky Links comment (added later by ship-*) |

Porting to another tracker changes only `tracker.mjs` and this table.

## Procedure

### 1. Parse title

Read the title from `$ARGUMENTS`. If none, ask: "What should the task title be?"

### 2. Gather requirements

Ask the user (or reuse what they already gave in the conversation) for:
- **Requirements**: what needs to be done
- **Acceptance criteria**: how to verify it's done. A check only a deployed run can show
  ("re-run the nightly import on staging and confirm no deadlock in the worker logs") gets
  a `live:` finish line naming the input, the trigger and the log or query that decides it —
  `$ship-task` offers to deploy and run it for you once the PR is open.
- **Context**: relevant background (related tasks, design decisions, constraints)

### 3. Detect single-task vs PRD (multi-phase) mode

If the request describes **multi-phase work** — several coherent, independently
shippable deliverables, or the user explicitly asks for "a parent task with
subtasks / sub-issues per phase" — run **PRD mode** (§7). Otherwise single-task (§6).
Do not manufacture phases: a request that is one unit is one task. When genuinely
unsure, ask the user via the available structured user-input tool (options: single task / split into phases).

### 4. Derive branch name

Generate a branch name from the title:
1. Lowercase; replace spaces/special chars with hyphens; collapse consecutive hyphens.
2. Trim to ≤50 chars at a word boundary.
3. Prefix by change type: `feat/`, `fix/`, `refactor/`, `chore/`, etc.

Example: "Add document search filtering" → `feat/add-document-search-filtering`.

Present it for confirmation: "Suggested branch name: `$BRANCH`. Use this or provide a
different one?" Before presenting, verify it doesn't collide with an existing ref's
namespace (a bare `feat` branch blocks `feat/...`); adjust if it does — the same guard
`$create-worktree` applies.

For **PRD mode**, derive one branch per phase (`$BRANCH-phase-<id>` or a per-phase name).

### 5. Classify the task — domain + labels

**Domain.** Every task carries exactly one `domain:<name>` label naming the area of the
codebase **the change lands in** (not the symptom or the surface that reported it). Read
the repository's existing domain labels (`gh label list --search "domain:" --json name`
on the GitHub backend) and pick the best fit. When none fits, propose a short new one
(`domain:search`, `domain:billing`, `domain:infra`). A task that spans layers (a feature
needing a schema change) takes its **main product domain** — the feature it serves; the
one exception is a separately shipped deliverable (a migration that is its own PR gets its
own task, `domain:database`).

When the request plausibly fits more than one domain, **confirm with the user via
the available structured user-input tool** — one question, the candidates as options (recommend the better fit
first), never guess silently. Store it as `$DOMAIN`.

**Labels.** `cut-task` self-provisions from the **fixed taxonomy below** — for each chosen
label, run `tracker tag ensure <name>` first (idempotent) so create never fails on an
unknown label. Do **not** invent labels outside this taxonomy (the domain label excepted).
Then build a `TAGS` **array** of repeated `--tag` flags (an array, not a space-joined
string: under zsh an unquoted `$TAGS` is not word-split, so a string would reach `tracker`
as one argument):
- **Domain** (exactly one): `domain:<name>`.
- **Work type** (exactly one): `bug` · `feature` · `enhancement` · `tech-debt` · `refactor` · `chore` · `spike`.
- **Stack layer** (zero or more): `frontend` · `backend` · `pipeline` · `infra` · `database` · `ai-ml`.
- **Risk** (as needed): `security` · `data-integrity`.
- **Priority** (only when the user states urgency): `priority:urgent` · `priority:high`.

Example: `tracker tag ensure domain:search && tracker tag ensure feature && tracker tag ensure backend`,
then `TAGS=(--tag domain:search --tag feature --tag backend)`.

### 5.5. Resolve the base branch

Resolve once, before any body is written, with the shared resolver
(`../../references/shared/base-branch.md` — precedence, call forms, the task-body rule). When
ship-task Stage 1A runs these steps, it reuses its Stage 0 `$BASE_BRANCH` instead.

```bash
git fetch origin --quiet 2>/dev/null || true
BASE_BRANCH=$(node "../../scripts/sf-base-branch.mjs") || { echo "ERROR: no usable base branch (see the message above); no task was created."; exit 1; }
```

If it exits non-zero, stop and relay its message (push the named branch or correct the
setting, then `git fetch origin`). The value is written into every body below as
`## Base branch`, so a later pickup ships the task onto the branch it was cut for.

### 6. Single-task mode — create the task

Write the body to a temp file (never interpolate user text through a shell heredoc),
then pass `--body-file`. Body schema:

```markdown
## Requirements

<requirements text>

## Acceptance Criteria

<acceptance criteria text>

## Branch

`<branch>`

## Base branch

`<$BASE_BRANCH>`

## Context

<context text>

---
*Created via `$cut-task`.*
```

```bash
node "../../scripts/tracker.mjs" task create \
  --title "$TITLE" --status "to do" "${TAGS[@]}" \
  --body-file /tmp/cut-task-body.md
rm /tmp/cut-task-body.md
```

Capture the task `id` and `url` from the JSON output. Then create the worktree (§8).

### 7. PRD mode — parent task + one sub-issue per phase

The create side of ship-task's epic bookkeeping (`skills/ship-task/epic.md`).

1. **Create the parent task** with `--status "to do"` and the §5 labels. Its body carries
   the overall Requirements / Acceptance Criteria / Context, the §6 `## Branch` and
   `## Base branch` sections, and a `## Phases` section listing each phase (id, one-line
   summary, depends-on). Capture `$PARENT_ID` / URL.
2. **For each phase**, create a sub-issue with `--parent "$PARENT_ID"` and
   `--status "to do"`. Title: `Phase <id>: <short title>`. Body:
   ```markdown
   ## Requirements
   <phase summary>

   ## Acceptance Criteria
   <phase acceptance>

   ## Branch
   `<per-phase branch>`

   ## Base branch
   `<the parent's $BASE_BRANCH>`

   ## Phase
   - id: <id>
   - depends-on: <ids or none>

   ## Context
   Part of #<parent>. Created via `$cut-task`.
   ```
   Record `phase_id → subtask_id/url`.
3. **Post a phase-checklist comment on the parent** so progress is visible:
   ```
   - [ ] Phase <id> — #<sub-issue> (depends-on: <ids or none>)
   ```
   Write it to a temp file and `tracker task comment "$PARENT_ID" --body-file …`.

Create the worktree (§8) for the **parent's** branch (phase worktrees come later, when
each phase is actually implemented — out of scope for cut-task).

### 8. Create the worktree

Create the worktree for the derived branch using the **create-worktree** skill (plain
`git worktree`, cut from the base branch it resolves — the same shared resolver as
§5.5 — and it asks the developer-name question when the workspace has one). Adopt it as the active working
directory: verify `cd "$WORKTREE_PATH" && pwd`, then set every subsequent tool call's
cwd to `$WORKTREE_PATH` (a shell-local `cd` does not persist). Report its output.

### 9. Report

Single-task:
> **Task created: <name>**
> - URL: <task url>
> - Status: `to do`
> - Domain: `domain:<name>`
> - Branch: `<branch>`
> - Worktree: active at `$WORKTREE_PATH`

PRD:
> **Parent task created: <name>** — <parent url> (`to do`, <N> phases)
> - Phase <id>: <sub-issue url>  (one line per phase)
> - Worktree: active at `$WORKTREE_PATH`

## Safety rules

1. **No branch prerequisite** — runs from any branch.
2. **One initial status only** — new tasks are created `to do`; do NOT advance
   status here. Planning/implementation transitions belong to the ship-* skills.
3. **Do NOT start planning or implementation** — those are separate skills.
4. **One task (or one parent+phases set) per invocation** — do not batch unrelated tasks.
5. **Confirm branch name** — always let the user approve or override the derived branch.
6. **Never hardcode issue numbers** — every id comes from a `tracker` call in this run.
