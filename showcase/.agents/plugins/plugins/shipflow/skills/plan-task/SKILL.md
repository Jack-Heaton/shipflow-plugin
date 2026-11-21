---
name: plan-task
description: "Phase 1 of the split task lifecycle: draft an implementation plan for a task (no review). Runs the ship-task plan-drafter once, commits docs/plans/task-<id>.plan.md, advances the phase cursor, and leaves the task in `planning` for $review-task-plan. Usage: $plan-task <task-id|task-url>"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $plan-task — draft the plan (split-phase, phase 1 of 4)

The **generation half of planning**, split out of `ship-task` so it can run on a
different runner than the review that follows: it drafts an implementation plan and
stops. It does **not** review the plan — that is `$review-task-plan` (phase 2). The four
phases and their handoff are defined once in
`../../references/shared/phase-contract.md`; read it — this skill assumes it.

**Usage:** `$plan-task <task-id>` or `$plan-task https://github.com/<owner>/<repo>/issues/<n>`.

## Relationship to the engine

This skill is a **thin slice**, not a new planner. The drafter agent, the plan template,
the length budget, the PR-topology and Phases rules, and every tracker convention are the
canonical machinery in `ship-task` Stage 2 (the draft step; prompts in
`../../references/shared/plan-prompts.md`) and `sf-plan-drafter`, specified in
`${SF_PLUGIN_ROOT}/skills/ship-task/SKILL.md`. Do not reimplement them.

## Procedure

### 1. Preflight + pickup + gate

Run the **shared preflight + pickup** and the **precondition gate** from
`phase-contract.md` §"Shared preflight + pickup" and §"Precondition gate":

- ship-task Stage 0 (existing-task mode only; audit `run-meta` carries
  `"skill":"plan-task","phase":"plan_drafted"`) and Stage 1B steps 1–3 + 6 (fetch the
  task, reject terminal states, parse `$BRANCH` + `$TITLE`, establish/reuse the worktree
  from `$BRANCH`).
- **Precondition:** status in `backlog` / `to do` / `planning`; cursor `plan_drafted`
  is `null`. If `plan_drafted` is already set, this is a **re-draft**: confirm with the
  operator via the available structured user-input tool (re-drafting overwrites a plan that `review-task-plan`
  or `implement-task` may already depend on) before proceeding; if `implemented` is set,
  refuse (a drafted-over plan would strand shipped code) and report.
- **Reproduce first:** after the gate, run ship-task Stage 1.8 before any drafting. Its
  `not-reproduced` checkpoint ends this phase there; a reproduced test's R-1 criterion goes
  first in step 2's requirements file.

### 2. Build the requirements file

Write `docs/plans/task-$TASK_ID.requirements.md` in the worktree from the task body's
Title / Requirements / Acceptance Criteria / Context — ship-task Stage 2's requirements
step. For a **subtask**, include the parent's Context and
this subtask's `## Phase` scope (phase-contract.md §"Shared preflight + pickup").

### 3. Draft the plan (drafter, once — no review)

Create the artifact dir (`docs/plans/task-$TASK_ID.artifacts/`) and spawn the
**`sf-plan-drafter`** exactly as ship-task Stage 2 round 1 (`plan-prompts.md` §Round 1 — drafter):
requirements file + plan output path `docs/plans/task-$TASK_ID.plan.md` + the plan
template + the exploration reports (the `explore-<area>.md` paths of Stage 2 §Plan-phase
Explores), with the prior-art Explore (Stage 2 §Prior-art Explore) launched in the same
message. Resolve model and effort through `runtime.md` / `model-tiering.md`: medium
for bounded work, the high profile for consequential design. The drafter emits the full plan including `## Pull request topology`
(migrations force a migration-first stack) and, only when the work is genuinely
multi-slice, `## Phases`. `## Open Questions` may remain populated — resolving them is
`review-task-plan`'s job, not this phase's.

Enter this step with `tracker task status "$TASK_ID" planning` (if not already there).

### 4. Commit + advance the cursor + hand off

1. Commit `plan.md`, the requirements file, and the artifact dir to `$BRANCH`
   (phase-contract.md §"Runner portability" — artifacts live on the branch).
2. Compute `plan_sha = git hash-object docs/plans/task-$TASK_ID.plan.md` and set the
   cursor's `plan_drafted` (read-modify-write `docs/plans/task-$TASK_ID.phase.json`,
   initializing all-null if absent), then commit the cursor.
3. Leave the task at `planning` (do NOT advance to `ready for development` — the plan is
   unreviewed).
4. Post a signed comment `**[plan-task · drafted]**`: the plan file path, whether
   `## Open Questions` is non-empty, the runner (`"by"`), and the next command —
   `$review-task-plan $TASK_ID`. Audit event:
   `{"stage":"plan-task","task":"$TASK_ID","plan_sha":"...","open_questions":<bool>,"by":"...","ts":"..."}`.

### 5. Report

```
=== $plan-task complete (phase 1/4) ===
Task:   <TASK_ID> — <TITLE>   (<task url>)   status: planning
Plan:   docs/plans/task-<TASK_ID>.plan.md  (drafted, UNREVIEWED)
Open questions: <yes — N / none>
Next:   $review-task-plan <TASK_ID>   (run it on whichever runner you want)
========================================
```

## Safety rules

Inherit ship-task's safety rules, plus:

1. **Draft only.** Never spawn the plan-reviewer or plan-fixer, never resolve Open
   Questions, never advance past `planning` — that is `review-task-plan`.
2. **Existing task only** (like fix-task): never cut a task; operate on one that exists.
3. **Re-draft is guarded.** Overwriting an existing `plan.md` requires confirmation and
   is refused once `implemented` is set on the cursor.
4. **Artifacts on the branch.** Commit the plan + requirements + cursor so a different
   runner can pick up phase 2 from `$BRANCH` alone.
