---
name: review-task-plan
description: "Phase 2 of the split task lifecycle: adversarially review a drafted plan and refine it to convergence (no drafting-from-scratch). Runs the ship-task plan-reviewer + plan-fixer loop, resolves open questions, and advances the task to `ready for development` for /implement-task. Usage: /review-task-plan <task-id|task-url>"
user_invocable: true
argument-hint: "<task-id | task-url>"
---

# /review-task-plan — review & converge the plan (split-phase, phase 2 of 4)

The **review-and-remediate half of planning**, split out of `ship-task`: it takes the
plan `/plan-task` drafted and runs the adversarial review → refine loop to convergence,
resolves `## Open Questions`, and hands a `ready for development` task to
`/implement-task`. It does **not** draft a plan from scratch — that is `/plan-task`
(phase 1). The phase handoff is defined in
`${CLAUDE_PLUGIN_ROOT}/skills/shared/phase-contract.md`; read it — this skill assumes it.

**Usage:** `/review-task-plan <task-id>` or the task URL.

## Relationship to the engine

Thin slice. The review loop (max-rounds, early-convergence exit, targeted re-review on
rounds ≥2), the `sf-plan-reviewer` gate of record, the `sf-plan-fixer` incorporation
step, the open-questions interview, and the checkpoints (`plan-review-exhausted`) are the
canonical machinery in **`ship-task` Stage 2 (the review/refine loop; prompts in
`skills/shared/plan-prompts.md`)**, specified in `${CLAUDE_PLUGIN_ROOT}/skills/ship-task/SKILL.md`. Do
not reimplement the loop.

## Procedure

### 1. Preflight + pickup + gate

Shared preflight + pickup + precondition gate (phase-contract.md):

- ship-task Stage 0 (`run-meta`: `"skill":"review-task-plan","phase":"plan_reviewed"`)
  and Stage 1B steps 1–3 + 6 (fetch, reject terminal states, `$BRANCH` + `$TITLE`,
  worktree from `$BRANCH`).
- **Precondition:** cursor `plan_drafted` set **and** `plan_reviewed` null; status
  `planning`. If `plan_drafted` is null → **stop**: "no drafted plan — run
  `/plan-task $TASK_ID` first." If `plan_reviewed` is already set, re-running re-opens
  the loop on the current `plan.md` (safe to repeat; no confirmation needed) — but if
  `plan_drafted.plan_sha` ≠ the current plan blob, note the plan changed since the last
  review and treat it as a fresh review.
- Read `docs/plans/task-$TASK_ID.plan.md` and the artifact dir from `$BRANCH`. For a
  **subtask**, the plan is the parent's (phase-contract.md §"Shared preflight + pickup").

### 2. Run the review → refine loop

Run **ship-task Stage 2's loop starting at the round-1 review** (the drafter is not
re-spawned; rounds ≥ 2 fall back cold because the drafter of a prior phase is not continuable)
(skip the round-1 drafter spawn — the draft already exists; with `SHIP_REVIEW_BACKEND=codex`
the reviewer seat is `sf-codex review --template plan-r1` / `plan-rereview` per
`skills/shared/review-backend.md` §Plan review, after ship-task Stage 0 step 5.5): spawn `sf-plan-reviewer`
(round 1 full 11-dimension pass, rounds ≥2 targeted re-review) — plus the plan
failure-over-time seat beside it (ship-task Stage 2
§Plan failure-over-time seat) — read verdict + findings
from `$ARTIFACT_DIR/plan-review-r<round>.md` (and `plan-review-fot-r<round>.md` when the seat ran), and on open CRITICAL/HIGH spawn
`sf-plan-fixer` to incorporate, looping with the early-convergence exit and max-rounds
exactly as written. Resolve both roles through `runtime.md` / `model-tiering.md`,
preserving warm settings and using the high profile for consequential cold planning.

- **Open questions:** run ship-task Stage 2's open-questions interview verbatim — a plan
  with unresolved `- [ ]` items or unconfirmed `## Premises` does not pass this phase;
  resolve them with the operator (`AskUserQuestion`) or emit the interview checkpoint. This is the phase that owns
  question resolution.
- **Exhaustion:** persisting CRITICAL/HIGH at max rounds → `CHECKPOINT_REQUIRED:
  plan-review-exhausted` per ship-task (status `blocked` + signed checkpoint comment +
  runstate). The cursor is **not** advanced on a checkpoint.

### 3. Commit + advance the cursor + hand off

On a clean pass (verdict "Proceed as-is", or the convergence/MEDIUM-LOW escape):

1. Commit the refined `plan.md` + the review artifacts to `$BRANCH`.
2. Set the cursor's `plan_reviewed` (`rounds`, `verdict`, and the reviewed
   `plan_sha = git hash-object …plan.md`); commit the cursor.
3. `tracker task status "$TASK_ID" "ready for development"`.
4. Post a signed comment `**[review-task-plan · reviewed]**`: the verdict, the round
   count, and the next command `/implement-task $TASK_ID`. If the plan exceeds a
   comment's practical size, post the summary + the committed plan path. Audit event:
   `{"stage":"review-task-plan","task":"$TASK_ID","rounds":<n>,"verdict":"...","by":"...","ts":"..."}`.

### 4. Report

```
=== /review-task-plan complete (phase 2/4) ===
Task:     <TASK_ID> — <TITLE>   status: ready for development
Plan:     docs/plans/task-<TASK_ID>.plan.md  (reviewed — <verdict>, <N> rounds)
Next:     /implement-task <TASK_ID>
==============================================
```

## Safety rules

Inherit ship-task's safety rules, plus:

1. **Review only.** Never draft a plan from scratch (that is `/plan-task`); the
   `sf-plan-fixer` refines the existing plan against findings — it does not regenerate it.
2. **The plan gate is real.** Do not advance to `ready for development` with open
   CRITICAL/HIGH findings, unresolved `## Open Questions`, or unconfirmed `## Premises` —
   checkpoint instead.
3. **Stale-review guard.** If the plan blob changed since `plan_drafted.plan_sha`, review
   the current plan, not a remembered one.
4. **Artifacts on the branch.** Commit the reviewed plan + review reports + cursor so
   `/implement-task` can pick up from `$BRANCH` alone.
