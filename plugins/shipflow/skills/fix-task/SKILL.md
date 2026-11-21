---
name: fix-task
description: "Fix a reported failure on an existing tracked task (a GitHub issue by default): analyze the task and its subtasks, interview the user for the missing detail, cut a bug sub-issue on the failing task, then land a planned-and-reviewed MINIMUM fix and return the whole task to `development complete`. Usage: /fix-task <task-id|task-url> [failure-mode description]"
user_invocable: true
argument-hint: "<task-id | task-url> [what's failing]"
---

# /fix-task — Log a bug on a tracked task and land a reviewed minimum fix

A task shipped (or reached testing) and someone found it broken. `/fix-task` turns
that report into tracked, reviewed remediation: it **analyzes** the failing task and
its subtasks, **interviews** you for the detail the task history can't supply,
**files the failure as a `bug` subtask** on the failing task, lands a **planned and
reviewed minimum fix** through the ship-task engine, and returns the **entire task to
`development complete`** so the human can re-test.

**Usage:**
- `/fix-task <issue-number>` / `/fix-task #<n>` / `/fix-task https://github.com/<owner>/<repo>/issues/<n>` — the failing task
- `/fix-task <task-id> <failure-mode description>` — task ref followed by free-text
  describing what's broken (everything after the ref is the failure description)

`$ARGUMENTS` = the task ref, optionally followed by the failure-mode text.

## How this skill relates to `/ship-task`

`fix-task` is a **thin front-end over the ship-task engine, not a new one.** The plan
loop, worktree, implement/review/fix machinery, build + acceptance-criteria gates, PR
creation, and every tracker convention (the `tracker` helper, the §Status lifecycle table,
signed comments, PR link-back, follow-up tasks) are the canonical machinery in
`${CLAUDE_PLUGIN_ROOT}/skills/ship-task/SKILL.md` (self-contained for the single-task
path). This skill adds only four things around it:

1. a **failure analysis** pass over the failing task + its subtasks,
2. a **targeted interview** for what the task history doesn't already answer,
3. cutting the **`bug` subtask** with a root-cause-oriented body, and
4. the **parent-task flip back to `development complete`** after the fix lands.

Everything between "bug subtask exists" and "PR is open" is **ship-task executed
verbatim** on that subtask — do not re-implement the plan loop, the reviewers, the PR
topology, or the checkpoint machine. Read the referenced ship-task stage, apply it,
don't invent variants. `HYBRID_MODE` (ship-task Stage 0 step 5.5,
`skills/shared/review-backend.md`; `SHIP_REVIEW_BACKEND=codex` ≡ `review`) applies here
exactly as it does there — at `codex` the fixer and mop-up seats are `sf-codex fix` too.

Bug fixes are **always planned and reviewed** — this skill
**forces ship-task's full path** and never takes the express path, even for a one-liner.

## Tooling — the `tracker` helper

All tracker interaction goes through `${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs` under the
same rules ship-task documents (`gh` CLI authentication, invoke from the checkout/worktree
root, never hardcode issue numbers, never call the tracker API directly). Verbs used directly by this skill:

- `tracker task view <id> --subtasks` — the failing task's body + `subtasks[]` (id, name,
  status, url) for the analysis pass.
- `tracker task comments <id> [--all]` — read prior context / prior `bug` subtasks so a
  re-report doesn't duplicate an open one.
- `tracker tag ensure bug` then `tracker task create --parent <parentId>
  --title <t> --status "to do" --tag bug --body-file <md>` — cut the bug sub-issue.
- `tracker task status <id> "<status>"` — quote status names (they contain spaces).
- `tracker task comment <id> --body-file <f>` — every comment opens with the signature
  `**[fix-task · <context>]**` (comments post as the authenticated `gh` user; the signature is
  what keeps history attributable).

If `tracker` fails with an auth error, tell the user to run `gh auth login` — do **not**
try to fix credentials yourself.

## Procedure

### Stage 0 — Preflight + parse the report

1. **Split `$ARGUMENTS`:** the first token is the task ref; everything after it is the
   free-text **failure mode** (`$FAILURE`, possibly empty).
   - Task ref matches `^https://github\.com/[^/]+/[^/]+/issues/([0-9]+)$`, `^#?([0-9]+)$`
     → `$TASK_ID` (the issue number). If empty or `tracker task view` 404s, ask via
     `AskUserQuestion` for the failing task's id/url (option: "Other / type your own")
     and re-resolve. **This skill only operates on an existing task** — there is no
     new-task / PRD input mode.
2. **Sanitize** the task `name` per ship-task Stage 0.2 before any shell interpolation;
   use `$TITLE` downstream.
3. **Clean tree, ship mode, base branch, web/protected-branch authorizations:** run
   ship-task Stage 0 step 3 (audit log), Stage 0 step 6 (`SHIP_MODE`, `$BASE_BRANCH`,
   `$INTEGRATION_BRANCH`) and step 7 (inline-mode branch authorization, protected-branch
   markers) verbatim. The audit log is a
   ship-task log; the `run-meta` event carries `"skill":"fix-task"`.

### Stage 1 — Analyze the failing task (do the legwork first)

Reads run in parallel (reads parallel, writes serial). Before asking the user anything:

1. **Fetch the whole picture:** `tracker task view "$TASK_ID" --subtasks` and
   `tracker task comments "$TASK_ID" --all`. Read the parent body (Requirements /
   Acceptance Criteria / Branch / Context), every subtask's status and body, and the
   comment trail — including any linked PR URLs and prior `bug` subtasks.
2. **De-dupe:** if an open `bug` subtask already covers this failure, adopt it instead
   of cutting a second (jump to Stage 4 with that id) — report the reuse. A closed one
   that regressed → cut a fresh subtask that links the old one in `## Context`.
3. **Locate the implicated code.** From the task's `## Branch`, its linked PRs, and the
   changed files, map the failing surface. Fan out `Explore` agents (one per candidate
   area) to find where the reported behavior lives — Explore
   locates; the root-cause hypothesis is yours to form from what it returns, or spawn one
   `general-purpose` agent at `model: sonnet` when the evidence needs weighing. This is a **diagnose-first** step
   (evidence before fixes): reproduce the failure or read to the line where it
   originates, and form a **root-cause hypothesis** — do not jump to a fix. The
   confirmed root cause is what Stage 4's plan must state before touching code.
4. **Write the failure map** — a short internal note: reported symptom, the parent's
   original acceptance criteria the failure violates, the implicated files, the
   root-cause hypothesis, and the open questions it leaves. This feeds Stage 2 and the
   subtask body; it is not posted anywhere yet.

### Stage 2 — Interview for the gaps only

Ask the user **only what Stage 1 could not answer** — never re-ask what `$FAILURE` or
the task history already states. Route every question through `AskUserQuestion` (one
decision per question, recommendation first where you have one). Typical gaps, dropped
when already known:

- **Reproduction / trigger** — the exact steps or input that surface the failure.
- **Expected vs. actual + blast radius** — what should happen, what happens instead,
  and who/what it affects (which is also the fix's acceptance criterion).
- **Severity / urgency** — informs priority on the subtask and whether it blocks.
- **Scope guardrails** — what is explicitly **out of scope** for the minimum fix, so
  the plan doesn't grow into an adjacent refactor.

If Stage 1 already answered everything and `$FAILURE` is concrete, skip the interview —
don't manufacture questions. If the failure is too vague to reproduce or to write a
verifiable acceptance criterion for, **that** is the one question worth asking.

### Stage 3 — Cut the bug subtask

The bug sub-issue takes the `domain:` label of the area **the fix lands in** (cut-task §5)
— usually the parent's own domain. A fix that truly belongs to another domain is still a
sub-issue of the failing task (the parent link is the provenance); it simply carries that
other `domain:` label.

`tracker tag ensure bug` (plus the `domain:` label and one stack-layer label from cut-task §5 when clear, e.g.
`backend`), then write the body to a temp file (never interpolate report text through a
shell heredoc) and create with `--parent "$TASK_ID"`:

```markdown
## Requirements

**Failure:** <one-line symptom>

**Reproduction:** <steps / trigger, from $FAILURE + interview>

**Expected vs. actual:** <what should happen> — instead, <what happens>.

**Root-cause hypothesis:** <the Stage 1 finding; the plan confirms it before fixing>

**Scope guardrail:** minimum fix only — resolve the reported failure without adjacent
refactors or cleanup. Out of scope: <the Stage 2 guardrails, or "none stated">.

## Acceptance Criteria

- The reported failure no longer reproduces (<the concrete repro from above>).
- No regression in the parent task's original acceptance criteria.

## Branch

`<fix/…-derived-from-the-subtask-title>`

## Base branch

`<$BUG_BASE>`

## Context

Bug found on <parent task url> (<parent status at report time>). Filed via `/fix-task`.
<link any prior/regressed bug subtask here.>
```

Derive `## Branch` per cut-task §4 (prefix `fix/`), confirm it with the user, and guard
against ref-namespace collisions exactly as cut-task does. `## Base branch` comes from a
resolve seeded with the parent's section (`skills/shared/base-branch.md` §Task-body
rule), so the fix lands where the failing task shipped; a parent base that is no longer
on origin, or that fails that section's parse rule, stops here:

```bash
PARENT_BASE='<the parent ## Base branch value, backticks stripped, that passed the parse rule; empty when absent>'
BUG_BASE=$(node "$SF/sf-base-branch.mjs" --task-base "$PARENT_BASE") || { echo "CHECKPOINT_REQUIRED: base-branch-missing (parent ## Base branch)"; exit 1; }
```

Create the subtask
`--status "to do"`, capture `$BUG_ID` / its url, then post a signed comment on the
**parent** (`**[fix-task · bug-filed]**`) linking the new subtask so the report is
visible from the failing task. Audit event:
`{"stage":"fix-bug-filed","parent":"$TASK_ID","bug":"$BUG_ID","branch":"...","ts":"..."}`.

### Stage 4 — Planned & reviewed minimum fix (ship-task full path)

Hand `$BUG_ID` to the **ship-task engine, forced onto the full path**, and run it
verbatim — worktree, plan, implement, review, fix loop, build + acceptance-criteria
gates, PR. Concretely, execute `${CLAUDE_PLUGIN_ROOT}/skills/ship-task/SKILL.md` from
its **Stage 1B (existing-task mode)** on `$BUG_ID`, with exactly these overrides:

- **Never express.** Run Stage 1.8 (reproduce first); skip Stage 1.9's express
  classification — a bug fix is always planned and reviewed; enter Stage 2 (plan). The
  plan must state the **confirmed root cause** (Stage 1's hypothesis, verified) before proposing the change.
- **Minimum scope is binding.** The subtask's `## Scope guardrail` is a hard constraint
  the plan and implementer honor: the smallest change that resolves the failure without
  regressing the parent's acceptance criteria. No opportunistic refactors. If the fix
  genuinely cannot be minimal (the root cause is structural), surface that as a
  `CHECKPOINT_REQUIRED` rather than quietly widening scope.
- Everything else is ship-task as written: the plan loop and its checkpoints, the routed
  reviewers + `security-reviewer`, the fix loop and warm closure (3e's direction-review pass
  with `sf-direction-reviewer` before every gated fixer with a merged item, its
  `adjudication` gate and its `oscillation-stop` rule all run exactly as in ship-task),
  follow-up filing for
  out-of-scope findings, the base syncs at every boundary (`shared/integration-sync.md`
  — a fix branch cut against a moving `development` must merge clean), the
  build/lint/AC gates, and Stage 3g's push + PR. The PR body
  carries `Refs #<bug sub-issue>` (never a closing keyword — the human closes the task
  after merge and re-test), and
  at PR-open the **bug subtask** goes to `development complete` (or `remediating` if it
  exits as a draft under `unresolved-review-findings`), per ship-task §PR link-back.

Do not duplicate any of that machinery here — it is inherited.

### Stage 5 — Return the whole task to `development complete`

The user's contract: once the fix lands, the **entire failing task** goes back to
`development complete` so the human re-tests it.

1. **Only when the bug subtask reached `development complete`** in Stage 4 (its PR is
   open and clean). If the subtask exited as `remediating` (draft PR, unresolved
   findings) or hit a `CHECKPOINT_REQUIRED`, **do not flip the parent** — leave it as
   it is and report the blocker; the parent flips only after the fix is real.
2. `tracker task status "$TASK_ID" "development complete"` — regressing the parent from
   whatever post-development status it was in (`ready for testing`, `testing`,
   `shipped`, …) — a closed parent is reopened by the status change. **Never** flip a
   parent that is `cancelled`; if it is, stop and report (the fix PR still stands on the
   subtask). If the status write fails, fall back to `ready for testing` and flag the gap
   in the report — never let a tracker gap strand a finished fix.
3. Post a signed comment on the **parent** (`**[fix-task · fixed]**`) with: the bug
   subtask url, the fix PR url, a one-line summary of the change, and the note that the
   task is back in `development complete` pending re-test. Also add the fix PR to the
   **parent's** Links comment (`tracker task pr "$TASK_ID" --url "<fix PR url>"`;
   fail-soft, per ship-task §PR link-back) so the parent surfaces its fix PR — the bug
   sub-issue already carries the same link from Stage 4. Leave the parent's **GitHub
   Branch** link unchanged: the fix lives on the bug sub-issue's branch, so the parent's
   branch link stays pointed at its own original branch. When the fix PR targets a non-integration base, the comment and the
   final report carry the ship-task §PR link-back release rule line (the task stays
   `development complete` until that base merges). Audit event:
   `{"stage":"fix-parent-reopened","parent":"$TASK_ID","bug":"$BUG_ID","pr":"<url>","parent_status":"development complete","ts":"..."}`.

### Stage 6 — Final report

Run ship-task Stage 4 (post-mortem via `ship-report/report.py`, decommission run
processes), then print:

```
=== /fix-task complete ===
Task:       <TASK_ID> — <TITLE>   (<task url>)   → development complete
Bug:        <BUG_ID> — <bug subtask url>
Branch:     <BRANCH>
PR:         <PR_URL>  (base: <PR_BASE>, <ready | DRAFT — unresolved findings>)
Reviewers:  <name>=<V> ...   (fix rounds: <N>, plan rounds: <N>)
Follow-ups: <task urls or "none">
Audit log:  <SHIP_TASK_LOG>

Next step: re-test the task, then review and merge the fix PR. Merging does NOT
close the task — after merge, advance it through the post-development
lifecycle (manual-close convention). The task is `development complete` with the
bug subtask and fix PR linked in its comments.
===========================
```

## Status handling (parent vs. subtask)

Two tasks move in one run — keep them distinct:

- **Bug subtask** (`$BUG_ID`): follows the ship-task §Status lifecycle exactly —
  `to do` → `planning` → `ready for development` → `in development` →
  `development complete` (or `remediating` / `blocked` on a checkpoint). This skill
  never sets those directly; the ship-task engine does.
- **Parent task** (`$TASK_ID`): this skill makes exactly **one** parent transition —
  the Stage 5 flip to `development complete` — and only after the subtask's fix landed.
  It is never set to `shipped` (human merge-confirmation) and a `cancelled` parent is
  never touched.

## Safety rules

Inherit every ship-task safety rule (one tracker per run, statuses move one machine,
signed comments, read-modify-write body edits, drafts-until-clean, fail-loud
checkpoints, reads-parallel/writes-serial, migrations-first PR topology). Plus:

1. **Existing task only.** `fix-task` never creates a top-level task or a PRD epic — it
   operates on a task that already exists and files a `bug` subtask under it. (A
   cross-domain fix may become a top-level `bug` task with a `depends-on` edge; that is
   the one exception, and it is still a fix, not a feature.)
2. **Always planned and reviewed.** Never take ship-task's express path — a bug fix
   gets the plan loop and the full reviewer set regardless of size.
3. **Minimum fix.** The subtask's scope guardrail binds the plan and implementer;
   scope growth is a checkpoint, not a silent widening.
4. **The parent flip is earned, not automatic.** `development complete` on the parent
   is written only when the subtask's fix actually reached `development complete`; a
   draft/blocked fix leaves the parent as-is.
5. **Diagnose before fixing.** Stage 1 forms and Stage 4's plan confirms the root cause
   before any code changes — no speculative fixes.
