# Phase contract (shared reference)

Resolve the host and mode through `runtime.md` on every pickup. Native Codex uses
GPT roles and native collaboration; Claude/hybrid use their selected adapters.
The cursor and committed artifacts below are provider-independent. Cross-host pickup
cold-starts any nonportable agent handle from those artifacts, preserving task scope
and previously recorded operator decisions.

> Canonical handoff contract for the **split-phase** lifecycle — the four skills
> `plan-task`, `review-task-plan`, `implement-task`, `review-task-code`. Each is a
> thin, independently-invocable slice of the same engine `ship-task` runs fused, so a
> tracked task can move through planning → review → implementation → code
> review **one phase at a time, on a different runner per phase** (Claude Code, or
> Codex through its translation layer over these same skills).
>
> This file is the single source of the phase **boundaries**: what each phase reads,
> what it must leave behind, and how the next phase — started in a *fresh process with
> no memory of the last* — reconstructs where it is. The engine itself (agents, review
> loops, PR topology, checkpoints) is NOT redefined here; it stays single-sourced in
> **`${CLAUDE_PLUGIN_ROOT}/skills/ship-task/SKILL.md`** (the single-task path is inlined
> there; epic fan-out lives in `skills/ship-task/epic.md`) and the
> `sf-*` agents.

## Why a split is possible at all

`ship-task` already resumes a crashed run from durable state alone — its Stage 1B
routes a picked-up task purely from tracker status + `docs/plans/task-<id>.runstate.json`
+ task comments (ship-task §Stage 1B and §Run state & resume). A
phase boundary is nothing more than a **deliberate stop at one of those resume points**.
The split adds one artifact — the **phase cursor** — so the boundary is legible without
inferring it from status alone (tracker status stays coarse; see §Status).

## Runner portability — artifacts live on the branch

A phase may be picked up by a different runner on a **different machine or checkout**
than the one that ran the prior phase. Therefore every phase artifact is **committed to
`$BRANCH`**, never left only in a worktree:

- The plan (`docs/plans/task-<id>.plan.md`), the requirements file, the phase cursor
  (below), the run cursor (`runstate.json`) and its audit log (the guarded
  `git add -f -- "$RUN_LOG"` of ship-task §Run state & resume — a repo may gitignore
  ledgers) are committed to `$BRANCH` at each phase exit, and pushed
  if the phase pushes (implement/review do).
- The review artifact directory (`docs/plans/task-<id>.artifacts/`) is committed too —
  it is the delivery channel between spawns and the audit trail of the review rounds.
- Pickup therefore starts by making `$BRANCH` current: reuse the worktree at the
  deterministic path if present and clean (the ledger and runstate excluded —
  `git status --short -- ':/' ':(top,exclude)docs/plans/*.jsonl' ':(top,exclude)docs/plans/*.runstate.json'`,
  ship-task §Run state & resume), else `git fetch && git worktree add` it from
  `origin/$BRANCH` (ship-task Stage 1B step 6 — dirty reused worktree → `worktree-dirty`
  checkpoint), then the §Integration sync block (`integration-sync.md`, `AT=1b`) — a
  branch that waited between phases is behind `origin/$BASE_BRANCH` by exactly that wait,
  and every phase must start on a tip that can merge. Once `$BRANCH` is checked out and
  synced, the phase cursor and plan are on disk.

The only non-committed state is the local worktree itself, which is always
reconstructable from the branch. Nothing a phase needs lives solely in a process's
memory.

## The phase cursor — `docs/plans/task-<id>.phase.json`

One JSON file per task, committed to `$BRANCH`, recording which phases are complete.
Coarse tracker status answers "roughly where is this" for a human; the cursor answers
"exactly which phase runs next" for a skill. Schema:

```json
{
  "task": "<TASK_ID>",
  "branch": "<branch>",
  "plan_drafted":  { "by": "<runner>", "at": "<iso8601>", "plan_sha": "<git blob sha of plan.md>" },
  "plan_reviewed": { "by": "<runner>", "at": "<iso8601>", "rounds": <n>, "verdict": "<reviewer verdict>", "plan_sha": "<reviewed plan blob sha>" },
  "implemented":   { "by": "<runner>", "at": "<iso8601>", "head": "<git sha>", "builds": true },
  "code_reviewed": { "by": "<runner>", "at": "<iso8601>", "rounds": <n>, "pr": "<url>", "status": "development complete|remediating" }
}
```

- A phase that has not run yet has its key set to `null` (or absent). Initialize the
  file (all four `null`) the first time any phase writes it.
- `"by"` is the runner that executed the phase — best-effort: `codex` when a Codex
  runtime env marker is present (e.g. `$CODEX_*`), else `claude`, else `unknown`. It is
  **advisory** (audit only); no logic branches on it. It exists so a mixed-runner run is
  legible after the fact ("who planned this, who implemented it").
- `plan_sha` lets `review-task-plan` detect a plan edited **after** it reviewed
  (`plan_drafted.plan_sha` ≠ current `plan.md` blob → the plan changed since draft;
  `plan_reviewed.plan_sha` ≠ current → re-review is stale). Compute with
  `git hash-object docs/plans/task-<id>.plan.md`.
- The cursor is **read-modify-write**: read the whole object, set your phase's key,
  write the whole object back. Never blind-overwrite another phase's key.

### Precedence: cursor first, then status, then comments

Every phase's entry check reads the cursor **before** tracker status. Status is the
coarse human signal and can be moved by a human out of band; the cursor is the precise
machine record. When cursor and status disagree (e.g. a human moved the task to
`in development` but `implemented` is `null`), the cursor wins — trust the recorded
artifact over the tracker — and note the divergence in the phase's opening comment. The
runstate + `**[…· checkpoint]**` comments remain the tie-breaker for a mid-phase crash,
exactly as in ship-task Stage 1B.

## Status (coarse — unchanged from ship-task)

The four phases share the **same** status set ship-task uses; no new statuses.
Each phase makes at most the transitions shown, via `tracker task status` (quote the names):

| Phase | Enters at (status) | Cursor precondition | Sets on clean exit |
|---|---|---|---|
| `plan-task` | `backlog` / `to do` / `planning` | `plan_drafted` null or user-confirmed redraft | `planning`, cursor `plan_drafted` |
| `review-task-plan` | `planning` | `plan_drafted` set, `plan_reviewed` null | `ready for development`, cursor `plan_reviewed` |
| `implement-task` | `ready for development` | `plan_reviewed` set, `implemented` null | `in development`, cursor `implemented` |
| `review-task-code` | `in development` | `implemented` set | `development complete` (or `remediating`), cursor `code_reviewed` |

A checkpoint inside any phase follows ship-task §Status lifecycle verbatim: set the task
`blocked` (or `remediating` for `unresolved-review-findings`), write the runstate cursor,
post the `CHECKPOINT_REQUIRED` block as a signed comment, then stop. The phase does NOT
advance the cursor on a checkpoint — the cursor advances only on a clean phase exit.

## Precondition gate (every phase runs this on entry)

After Stage 0 preflight + Stage 1B pickup (below), before doing any phase work:

1. Read the cursor. If the **precondition** in the table above is unmet — e.g.
   `implement-task` finds `plan_reviewed` null — **stop** with a clear message naming the
   phase that must run first (`review-task-plan`), plus the one-line command to run it.
   Do not silently run the missing phase; the point of the split is that the operator
   chooses the runner for each phase.
2. If the phase's **own** key is already set (the phase already ran): report it as a
   no-op and stop, unless the operator explicitly asked to re-run it. A re-run of a
   generation phase (`plan-task`, `implement-task`) requires confirmation because it
   overwrites downstream-consumed output; a re-run of a review phase re-opens the loop
   on the current artifact and is safe to repeat.
3. If cursor and status diverge, apply §Precedence (cursor wins) and note it.

## Shared preflight + pickup (all four phases)

Every phase skill begins by running, **by reference**, the ship-task front matter that is
independent of which phase runs:

- **Stage 0 (preflight):** ship-task Stage 0 — classify `$ARGUMENTS` (existing-task mode
  only; these skills never cut a task), sanitize the title, initialize the audit log
  (`SHIP_TASK_LOG`, `run-meta` event carries `"skill":"<phase-skill-name>"` and
  `"phase":"<phase>"`), resolve `SHIP_MODE` / `$BASE_BRANCH` / branch authorizations.
  That Stage 0 `$BASE_BRANCH` is superseded by the pickup resolve below.
  Each phase keeps and commits its own ledger (the phases never adopt, so never run
  `init --resume`); `sf-log cursor` repoints the runstate's `log_path` at the latest one.
- **Stage 1B (pickup + worktree):** ship-task Stage 1B steps 1–3 + 6 — fetch the task
  (`tracker task view --subtasks`), reject terminal states, parse `## Branch` → `$BRANCH`, the
  optional `## Base branch` → `$TASK_BASE` (both through base-branch.md §Task-body rule's
  parse rule, single-quoted) and the title, establish/reuse the worktree for
  `$BRANCH` per §Runner portability. `$BASE_BRANCH` comes from ship-task §Worktree's
  pickup resolve (`PICKUP=1`): the runstate's `base_branch` first, then the task body's
  `## Base branch`, then the workspace settings (`skills/shared/base-branch.md` §Pickup
  rule) — so every phase, on any machine, ships onto the base the task started on. **Skip
  Stage 1B's status-routing table (step 5)** — the phase cursor + the precondition gate
  above replace it; each phase knows its own entry, it is not choosing an entry stage.

`$TASK_ID` may be a parent single task or a subtask (an epic phase). A subtask's plan
lives with the parent (ship-task Stage 1B step 5, `ready for development` row): resolve
`parent` and read `docs/plans/task-<parent_id>.plan.md`, scoped to this subtask's
`## Phase`. Epics themselves (fan-out across subtasks, layer scheduling) stay with
`ship-task` — the phase skills operate on **one** task/subtask at a time.

## The `tracker` helper + comment signatures

Tracker interaction is the ship-task `tracker` contract verbatim
(`${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs`; `gh` authentication; invoke from the
worktree root; never hardcode ids). Each phase posts one signed opening/closing comment
so a mixed-runner history stays attributable — signature
`**[<phase-skill-name> · <context>]**`, e.g. `**[implement-task · done]**`. Include the
`"by"` runner in the closing comment when it is known, so the task history shows who ran the phase.

## What each phase must guarantee for the next

The contract in one line each — the exit conditions the next phase's precondition depends on:

- **`plan-task` →** a committed `plan.md` that conforms to the plan-drafter template
  (Context / Files / Steps / Verification / Out-of-scope / Open Questions / PR topology /
  optional Phases), cursor `plan_drafted` set with its `plan_sha`. It does NOT review the
  plan — Open Questions may remain; `review-task-plan` resolves or escalates them.
- **`review-task-plan` →** a plan whose CRITICAL/HIGH findings are closed (or a
  `plan-review-exhausted` checkpoint), `## Open Questions` all resolved (unresolved →
  the interview checkpoint, ship-task Stage 2), cursor `plan_reviewed`. This is the gate
  of record on the plan.
- **`implement-task` →** code on `$BRANCH` implementing the reviewed plan that **passes
  the scoped build gate** (ship-task 3f), committed and pushed, cursor `implemented`. It does
  NOT run the review panel and does NOT open a PR. An empty diff → `empty-implementation`
  checkpoint (ship-task 3c).
- **`review-task-code` →** the diff reviewed by the routed panel + `security-reviewer`,
  all in-scope findings fixed (out-of-scope filed as follow-up tasks), AC verified, PR
  opened with the tracker link-back, cursor `code_reviewed`, task `development complete`
  (or `remediating`). This is the terminal phase — after it, the human re-tests/merges,
  exactly as at the end of a fused ship-task run.
