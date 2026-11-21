---
name: implement-task
description: "Phase 3 of the split task lifecycle: implement a reviewed plan (no code review, no PR). Runs the ship-task explore + implementer engine and the full build gate, commits + pushes the code on the task branch, advances the task to `in development` for $review-task-code. Usage: $implement-task <task-id|task-url>"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $implement-task — implement the reviewed plan (split-phase, phase 3 of 4)

The **generation half of the code phase**, split out of `ship-task`: it turns a reviewed
plan into committed, building code on the task branch and stops. It does **not** run the
review panel and does **not** open a PR — that is `$review-task-code` (phase 4). The
phase handoff is defined in
`../../references/shared/phase-contract.md`; read it — this skill assumes it.

**Usage:** `$implement-task <task-id>` or the task URL.

## Relationship to the engine

Thin slice. Task decomposition into batches, the parallelizability gate, the parallel
`Explore` + serial/scratch-worktree `sf-implementer` engine, the worktree contract, the
build-resilience rules, and the empty-implementation checkpoint are the canonical
machinery in **`ship-task` Stage 3, sub-stages 3a–3c + 3f**, specified in
`${SF_PLUGIN_ROOT}/skills/ship-task/SKILL.md`. Do not
reimplement them.

## Procedure

### 1. Preflight + pickup + gate

Shared preflight + pickup + precondition gate (phase-contract.md):

- ship-task Stage 0 (`run-meta`: `"skill":"implement-task","phase":"implemented"`) and
  Stage 1B steps 1–3 + 6 (fetch, reject terminal states, `$BRANCH` + `$TITLE`,
  establish/reuse the worktree — a dirty reused worktree → `worktree-dirty` checkpoint).
- **Precondition:** cursor `plan_reviewed` set **and** `implemented` null; status
  `ready for development`. If `plan_reviewed` is null → **stop**: "the plan isn't
  reviewed — run `$review-task-plan $TASK_ID` first" (do not implement an unreviewed
  plan). If `implemented` is already set, this is a **re-implementation**: confirm via
  the available structured user-input tool and note that `$review-task-code` will re-review the full diff.
- Read the reviewed `docs/plans/task-$TASK_ID.plan.md` (the parent's, scoped to the
  `## Phase`, for a subtask).

### 2. Implement + build (no review)

Enter with `tracker task status "$TASK_ID" "in development"`, then run **ship-task Stage 3
sub-stages 3a → 3c → 3f** — including ship-task Stage 0 step 5.5 first (`HYBRID_MODE`
resolution and, when not `off`, the `review-backend.md` §Preflight codex probe that
exports `SF_CODEX_HOME`; without it every `sf-codex` call below would run against the
user's `~/.codex`). At `HYBRID_MODE=codex` 3c's implementer seat is the `sf-codex implement`
command in `review-backend.md` §Hybrid mode (`gpt-6.1-sol` / low), with `sf-implementer` as the
fallback; 3c's Explore stays the built-in Claude agent in every mode:

- **3a** baseline (`$BASELINE`, `$REVIEW_BASELINE`), status transition (the `tracker` line
  above replaces the label edit), lockfile-drift discard, artifact dir.
- **3b** decompose the reviewed plan into batches with the parallelizability gate;
  **3c** parallel `Explore` per task then implement each batch (serial writer, or scratch
  worktrees for a `parallelizable: true` batch) via `sf-implementer` — model per
  model-tiering.md (opus during the active experiment; the risky-scope override still
  applies), effort as pinned. A blocker from an explorer → `ambiguous-fix-required`
  checkpoint; an empty diff after 3c → `empty-implementation` checkpoint.
- **3f** the full build check with build resilience — after 3f's §Integration sync
  (`shared/integration-sync.md`, `AT=3f`), so the tip handed to `$review-task-code` is
  current with the base and the build ran on it. Implementation is not complete until
  it builds — a persistent build failure is a `CHECKPOINT_REQUIRED` per ship-task 3f,
  not a hand-off.

**Stop before 3d.** Do NOT spawn any reviewer, run the fix loop (3e), verify acceptance
criteria (3f.5), file follow-ups (3f.6), or open a PR (3g) — all of that is
`$review-task-code`.

### 3. Commit + push + advance the cursor + hand off

1. The implementer commits per-task on `$BRANCH` (3c). Run the sync block's `AT=3g`
   probe (a tip that does not merge clean is merged and re-gated first). Then read the
   push-gate baseline that pickup kicked and ask its queued skip question, if any, per
   `shared/run-preflight.md` §Push-gate baseline — this push is the one it blocks. Push
   `$BRANCH` so a different runner can pick up phase 4 from the remote, with
   `env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") git push -u origin "$BRANCH"`
   in the foreground; confirm the remote moved per the repo's push rule (never report a
   push from its exit code alone). Once the
   branch is on the remote, set the task's **GitHub Branch** field to its tree URL
   (`tracker task branch "$TASK_ID" --url "$(gh repo view --json url -q .url)/tree/$BRANCH"`;
   fail-soft if the field is absent, per ship-task §PR link-back) — this fills the branch
   link during the review-gate window, before a PR exists.
2. Set the cursor's `implemented` (`head = git rev-parse HEAD`, `builds: true`); commit
   the cursor and push it through `push-env` as in step 1.
3. Leave the task at `in development` (do NOT advance to `development complete` — the code
   is unreviewed and has no PR).
4. Post a signed comment `**[implement-task · implemented]**`: the head sha, files
   changed (`git --numstat` summary), build status, and the next command
   `$review-task-code $TASK_ID`. Audit event:
   `{"stage":"implement-task","task":"$TASK_ID","head":"...","builds":true,"by":"...","ts":"..."}`.

### 4. Report

```
=== $implement-task complete (phase 3/4) ===
Task:   <TASK_ID> — <TITLE>   status: in development
Branch: <BRANCH>  @ <head sha>   (pushed, builds ✓, UNREVIEWED, no PR)
Files:  <N changed>
Next:   $review-task-code <TASK_ID>
============================================
```

## Safety rules

Inherit ship-task's safety rules (worktree contract,
reads-parallel/writes-serial, migrations-first, build resilience), plus:

1. **Implement only.** Never spawn a reviewer, never run the fix loop, never verify AC,
   never open a PR — those are `$review-task-code`. This phase's output is *unreviewed by
   design*; the next phase is the gate.
2. **Reviewed plan required.** Refuse to implement when `plan_reviewed` is null.
3. **Must build.** Hand off only code that passes the full build gate (3f); a broken
   build is a checkpoint, not a hand-off.
4. **Push before hand-off.** Commit and push `$BRANCH` + the cursor so phase 4 is
   pickup-able from the remote on any runner/machine.
