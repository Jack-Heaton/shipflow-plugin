# ship-task — epic path (Stage 2.7 / 3E) and pull-request topology

Loaded by `SKILL.md` §Stage 2.7 when the reviewed plan has two or more `## Phases`. That
section owns the deltas — phase fan-out, the per-phase engine, same-layer concurrency, the
integrated-layer gate, speculative layers, status mapping, kickoff auto-confirm. This file
supplies what those deltas build on: decomposition, sub-issue cutting, the layer scheduler,
integration and finalize mechanics, stack topology, and the epic checkpoints and safety
rules. **Where the two disagree, `SKILL.md` wins.** Spawns, the review/fix loop, gates
(`sf-gates`), pushes (`sf-push`), model tiering and audit events are always `SKILL.md`'s;
nothing here re-specifies them.

Vocabulary: the task being shipped (`$TASK_ID`) is the **epic parent**; each phase is a
GitHub **sub-issue** of it. Every tracker read/write goes through `tracker` (`node
"$SF/tracker.mjs" …`) — never `gh issue` directly — so the epic path ports with the rest of
the skill to another tracker.

## Resource budget (optional — default off)

There is no reliable programmatic read of session or weekly usage limits, so the epic never
invents a "% of limit". Resumability makes a hard cutoff non-destructive; an optional budget
pauses the run **at a layer boundary** using honest proxies. All unset = run to completion.

| Env var | Effect (checked only at layer boundaries in 3E) |
|---|---|
| `SF_EPIC_TIME_BUDGET_MIN` | Soft wall-clock budget, minutes since the epic's first audit-log event. |
| `SF_EPIC_MAX_PHASES_PER_RUN` | Stop after this many phases integrated this invocation. |
| `SF_EPIC_USAGE_CMD` | A shell command printing an integer usage percentage. |
| `SF_EPIC_USAGE_MAX_PCT` | Threshold for `SF_EPIC_USAGE_CMD` (default `85`). |

A tripped budget → `CHECKPOINT_REQUIRED: resource-budget-reached` once the current layer is
integrated, pushed and its sub-issues' statuses written — never mid-phase. Re-invoking resumes.

## Stage 2.7 — Epic detection + fan-out cutting

Absent `## Phases`, or exactly one phase → single-task path (Stage 3). Two or more → epic.
The plan reviewer already vetted the decomposition in Stage 2, so the DAG and disjoint
scopes are trusted; 2.7a re-checks them mechanically.

### 2.7a — Parse + validate the phase DAG

1. Parse each `### Phase <id>` into `{id, depends_on[], scope[], summary, acceptance}`.
2. Validate: every dependency id exists, the graph is acyclic, and any two phases with no
   dependency path between them have **disjoint scope** (no shared file) and touch no
   contract seam (`sf-route classify` over each scope). Failure →
   `CHECKPOINT_REQUIRED: epic-decomposition-invalid` (detail: the cycle or the overlap).
3. **Soft check — test/spec coupling.** For each concurrency-eligible phase, list scope files
   matching `*.test.*` / `*.spec.*` whose module under test is owned by *another* concurrent
   phase. Path-disjoint but symbol-coupled; do not fail (the 3E cherry-pick is the
   backstop) — record each `{test, owning_phase}` in the `warnings` of the
   `epic-decompose` event.
4. Compute topological **layers**: layer 0 = `depends-on: none`; layer k = phases whose
   deps all sit in layers < k. Apply §Pull-request topology: a database migration occupies
   its own lower layer below every runtime phase that consumes it; a migration that is not
   backward-compatible with the deployed application is revised to expand/contract, else
   `epic-decomposition-invalid`.

`sf-log stage epic-decompose layers='[["P1","P2"],["P3"]]' phases='{…}' warnings='[…]'`.

### 2.7b — Kickoff confirmation (single human gate)

Creating N sub-issues and running an hours-long, many-spawn job is outward-facing and hard
to reverse, so confirm **once**: the available structured user-input tool with the phase list and dependencies, the
layer/parallelism plan, the number of sub-issues to create, and a rough cost/time estimate.
Options: `Proceed` (recommended), `Proceed but force serial`, `Cancel`. `Cancel` → stop
with nothing created; force serial → `EPIC_FORCE_SERIAL=1`. `SKILL.md` §Stage 2.7 makes the
gate notify-only when every phase sub-issue already exists (`SHIP_EPIC_CONFIRM=1` restores
it; `SHIP_EPIC_NOCONFIRM=1` skips it even when creating).

### 2.7c — Cut one sub-issue per phase

The task being shipped becomes the epic parent; it already holds the requirements.

```bash
node "$SF/tracker.mjs" tag ensure epic
node "$SF/tracker.mjs" task create --parent "$TASK_ID" --status "ready for development" \
  --tag epic --title "[epic #$TASK_ID] Phase <id>: <title>" --body-file <body-file>
```

`--body-file` always — phase text never reaches a shell. A sub-issue skips its own plan
loop: the epic plan, already adversarially reviewed, is its plan. Body (the `cut-task`
shape plus `## Phase`):

```markdown
## Requirements
<phase summary>

## Acceptance Criteria
<phase acceptance>

## Branch
`<the epic's $BRANCH — integrated mode; the layer branch in stack mode>`

## Base branch
`<$BASE_BRANCH>`

## Phase
- id: <id>
- depends-on: <ids or none>
- scope: <file paths>

## Context
Part of epic #<parent>. Plan: see the parent issue. Implemented by $ship-task.
```

Record `phase_id → sub-issue number`. Post one parent comment
(`**[ship-task · epic]**`) with the checklist `- [ ] Phase <id> — #<child> (depends-on: …)`
and, in PRD mode, `prd-sha: <12 hex>` followed on the next line by `base: $BASE_BRANCH` —
Stage 1A's resume check reads both. `tracker task status "$TASK_ID" "in development"`.

`sf-log stage epic-cut children='{"P1":"123","P2":"124"}' force_serial=<bool>`.

### 2.7d — Resume (`RESUME_EPIC=1`)

Skip 2.7b/2.7c. Re-read the plan and `tracker task view "$TASK_ID" --subtasks`; build
`phase_id → sub-issue` from the checklist and each sub-issue's `## Phase`. A phase is
**done** when its status is `development complete` / `ready for testing` / `testing` /
`shipped`, or (integrated mode) its `epic-layer` head is an ancestor of `origin/$BRANCH`.
Everything else is **pending**. Re-establish the integration worktree on the recorded base
and enter 3E with the pending phases only, respecting the DAG.

## Stage 3E — Epic fan-out

Implement the phases as parallel as the DAG allows, integrate each topological layer, and
ship what landed. **Integrated mode** (the default) integrates every layer onto the epic's
one branch and opens one PR at the end; **stack mode** (§Pull-request topology) gives each
layer its own branch and PR. Failed phases and their dependents are deferred; completed
lower layers still ship.

The orchestrator drives every spawn: nested sub-agents have no spawn tool, so phase-level
parallelism is the orchestrator interleaving depth-1 spawns across phases — never nested
phase agents.

### Setup

- `$INTEGRATION_WT` = the epic's worktree on `$BRANCH`. Stack mode only: later layers use
  `${BRANCH}-layer-<k>-<slug>` based on the layer below, initialized with
  `gh stack init --base "$BASE_BRANCH" …`, and a resume runs `gh stack sync` first.
- Run the §Integration sync block (`shared/integration-sync.md`) on `$INTEGRATION_WT` with
  `AT=resume` on a resume, else `AT=layer LAYER=0`. Stack mode syncs the bottom layer only.
- `EPIC_START_TS` = the epic's first audit-log timestamp; `PHASES_THIS_RUN=0`.
- Scheduler state: `completed`, `failed`, `deferred` empty; `remaining` = pending phases.

### Layer scheduler

Repeat until no phase in `remaining` has all deps satisfied:

1. **Defer blocked phases.** A `remaining` phase with a dependency in `failed ∪ deferred` →
   `deferred` (reason `dep <x> not landed`). Never run.
2. **Form the layer:** `LAYER = { p ∈ remaining : deps(p) ⊆ completed }`; empty → exit.
3. **Sync, then baseline.** The §Integration sync block on `$INTEGRATION_WT`
   (`AT=layer LAYER=<k>`) **before** reading the tip, so every phase worktree is cut from a
   base current now. `LAYER_BASELINE` = the just-synced tip (stack mode: the direct lower
   branch's tip, `origin/$BASE_BRANCH` for layer 0).
4. **Run the layer.** Parallel (worktree mode, `|LAYER| > 1`, not `EPIC_FORCE_SERIAL`): one
   worktree per phase cut from `LAYER_BASELINE`, seeded per `shared/scratch-worktree.md`:
   ```bash
   PHASE_BRANCH="${BRANCH}-phase-${id}"
   PHASE_WT="/workspace/.worktrees/$(echo "$PHASE_BRANCH" | tr '/' '-')"
   git worktree add -b "$PHASE_BRANCH" "$PHASE_WT" "$LAYER_BASELINE"
   ```
   then the per-phase engine for every phase concurrently (cap 3 in flight, waves beyond).
   Otherwise serial on `$INTEGRATION_WT` with the `serial_reason` `SKILL.md` defines.
5. **Integrate** (parallel path only). Re-run the sync block (`AT=layer LAYER=<k>`), take
   `LAYER_GATE_BASE=$(git -C "$INTEGRATION_WT" rev-parse HEAD)`, then replay each passed
   phase:
   ```bash
   git -C "$INTEGRATION_WT" cherry-pick "${LAYER_BASELINE}..${PHASE_BRANCH}"
   ```
   Classify a **conflict** before choosing a rule. A conflicted file that
   `git log --oneline "$SYNC_BEFORE"..HEAD -- <file>` lists was rewritten by the base while
   the phase ran — a **base collision**, resolved per the sync block's §Conflict rule and
   `git cherry-pick --continue`. Otherwise scopes were not disjoint. **Test-only additive
   exception:** every conflicted path is `*.test.*` / `*.spec.*` and both sides only add
   independent blocks → keep both, `git add`, continue (the layer gate is the net). Any
   other conflict → `git cherry-pick --abort`,
   `CHECKPOINT_REQUIRED: epic-integration-conflict` (phase id + files). Remove each
   integrated phase worktree and branch. Failed phases are not integrated; their worktrees
   are discarded and redone on a resume.
6. **Layer gate.** Integrated mode: the `sf-gates gate --mode layer` command, the push and
   the `epic-layer` event exactly as `SKILL.md` §Stage 2.7 specifies. Stack mode: the full
   gate against the direct lower branch. Failure →
   `CHECKPOINT_REQUIRED: epic-layer-build-failed`; nothing is stacked on a broken layer.
7. **Stack mode only — submit the layer.** `gh stack submit --auto` under the approved push
   skips, verify the PR's direct base, keep it draft until its own checks and review pass.
   Its body carries `Refs #<child>` for each sub-issue it implements and `Part of #<parent>`.
   Record PR URL, head/base SHA, children and migration gate state on the `epic-layer` event.
8. **Budget gate** (layer boundary only) — §Resource budget.

Passed phases move to `completed`; a phase's sub-issue status follows `SKILL.md`'s 3E
status mapping.

### Per-phase engine

The single-task loop in `SKILL.md` Stage 3 (explore → implement → routed review → triage →
fix → closure) runs per phase in its worktree, with `PHASE_BASELINE = LAYER_BASELINE` and
these deltas:

- **A phase branch never merges the base.** Its sync points run the sync block's read-only
  probe (`AT=phase`); a merge commit on `$PHASE_BRANCH` would break step 5's cherry-pick
  range. A `conflict` probe is early notice that step 5 will need the base-collision rule.
- The implementer is scoped to the phase's `scope`, told it is the **sole writer** of its
  worktree, and reports a scope violation instead of editing outside it.
- `tracker task status <child> "in development"` at phase start.
- Skip the per-run tail (full build gate, AC table, PR) — it runs once in Finalize.
  Bucket-3 findings accumulate into `$EPIC_FOLLOWUPS` (one cleanup bundle per run).
- **Late migration** after higher stack PRs exist → §Pull-request topology's late-migration
  protocol. In integrated mode a late migration is a re-plan: checkpoint.
- **Phase pass** = the fix loop ends with no open CRITICAL/HIGH. **Phase fail** = the loop
  ceiling is reached with CRITICAL/HIGH still open → `failed`, not integrated.
- **A hard stop inside a phase halts the whole epic** — `ambiguous-fix-required`,
  `destructive-migration`, `database-trigger`, `new-dependency` always need a human, even
  under ship-what-landed.

### Finalize (after the scheduler exits)

1. `completed` empty → `CHECKPOINT_REQUIRED: epic-all-phases-failed`.
2. **Holistic cross-phase review** of the cumulative diff (consistency, integration
   coherence, duplication) with one triage-driven fix round. Integrated mode: the fix lands
   on `$BRANCH` directly. Stack mode: it lands in the lowest layer whose scope owns the
   defect, then `gh stack rebase` + `gh stack submit --auto` and every rewritten layer above
   re-runs its checks and review closure.
3. **Sync, then the full build gate** — the sync block at `AT=3f` on the shipping tip, then
   `SKILL.md` 3f. The build runs once, on the tip that ships.
4. **Acceptance** — `SKILL.md` 3f.5 against the cumulative tip: the parent's criteria plus
   every landed phase's. Deferred phases' criteria are `DEFERRED`, not failed.
5. **Follow-ups** — `$EPIC_FOLLOWUPS` per `SKILL.md` §Follow-up tasks.
6. **PR.** Integrated mode: `SKILL.md` 3g opens the one PR. Stack mode: `gh stack submit
   --auto`, each layer PR marked ready only when its own gates pass, migration-dependent
   layers kept draft until `migration_applied` is recorded. Either way the body carries
   `Refs #<parent>`, `## Phases landed` (`- <id> #<child> ✅`), `## Phases deferred`
   (`- <id> #<child> — <reason>`, left open for a resume), `## Follow-up tasks`, and the AC
   table with `DEFERRED` rows called out. Statuses — not closing keywords — record
   completion (§Status lifecycle); the human closes the parent as `shipped` after merge.

`sf-log stage epic-finalize stack='[{"layer":0,"pr_url":"…","base":"…","children":["123"]}]' landed='["P1"]' deferred='["P3"]' followups='[…]' build=PASS`,
then `PushNotification`: `ship-task #<parent> epic: <X> phases landed, <Y> deferred — PR <url>`.

## Pull-request topology

The reviewed plan carries `## Pull request topology`: `single`, or an ordered `stack`
(bottom/trunk-nearest first), each layer `{id, title, scope, depends-on, deploy-gate}`.

- `single` — coherent, migration-free work that is reviewable as one PR. **The default for
  an epic**: layers integrate onto one branch and ship as one PR.
- `stack` — a non-epic plan with a database migration (the generated migration, its
  metadata/snapshots and the minimum schema source form a bottom layer; runtime consumers
  sit above it), or several independently deployable dependency layers. An **epic** runs as
  a stack — the whole run, never a hybrid — only when a layer must land independently (a
  migration layer, `deploy-gate: independent`) or `SHIP_EPIC_TOPOLOGY=stack`. Never one
  layer per commit, agent or file.
- Every layer builds and passes its checks against its direct base. A database layer is
  backward-compatible with the deployed application; otherwise plan expand/contract.

Stack mechanics use GitHub's `github/gh-stack` CLI extension; verify `gh stack --help` and
repository access first, else `CHECKPOINT_REQUIRED: stacked-prs-unavailable` (recovery
`gh extension install github/gh-stack`). Branches `${BRANCH}-layer-<index>-<slug>`; a late
migration `${BRANCH}-migration-<seq>`. The bottom PR targets `$BASE_BRANCH`, each later PR
the branch below it. Every layer opens as a draft.

**Migration deployment gate.** Merging a migration PR is not proof it ran. Record
`migration_merged`, `migration_applied`, environment, the command/query artifact and the
timestamp separately in the audit log and runstate. A dependent layer stays draft until
every lower migration's apply is verified. The skill never merges, and never claims an
environment apply it did not observe.

**Migration discovered after higher PRs exist.** Freeze submits above the discovery point
and persist runstate. `gh pr view <n> --json state,mergeStateStatus,autoMergeRequest` for
every open stack PR: `QUEUED`, a non-null `autoMergeRequest`, or `gh stack modify` refusing
→ `CHECKPOINT_REQUIRED: stack-modification-blocked` (never dequeue automatically). A
dependent PR already merged → `CHECKPOINT_REQUIRED: late-migration-after-dependent-merge`.
Otherwise, on a clean tree, `gh stack modify`: insert one branch
`${BRANCH}-migration-<seq>` below the **lowest** dependent layer (every layer above inherits
it), implement and commit the migration there, `gh stack submit --auto`, then re-verify
every PR base and body and re-run builds, checks, review closure and acceptance on the
rewritten higher SHAs.

## Epic checkpoint reasons

Same block format and checkpoint convention as `SKILL.md` §CHECKPOINT_REQUIRED.

| Reason | Stage | When |
|---|---|---|
| `epic-prd-mismatch` | 1A | An epic matches the PRD but its recorded `prd-sha` differs. Human decides: resume as-is, close, or re-plan. |
| `epic-decomposition-invalid` | 2.7a | Cycle, missing dependency, overlapping concurrent scopes, or a migration that cannot be made backward-compatible. |
| `epic-integration-conflict` | 3E.5 | A passed phase's cherry-pick conflicted on production code — scopes were not disjoint. |
| `epic-layer-build-failed` | 3E.6 | An integrated layer fails its gate; nothing is stacked on it. |
| `epic-all-phases-failed` | Finalize | Every layer-0 phase failed review; nothing landed. |
| `resource-budget-reached` | 3E.8 | A configured `SF_EPIC_*` budget tripped at a layer boundary. Re-run to resume. |
| `stacked-prs-unavailable` | 3E setup | Stack topology required but `gh stack` or repository access is missing. |
| `stack-scope-violation` | 3E | A task crossed reviewed layer scopes; revise the topology instead of smearing the change. |
| `late-migration-after-dependent-merge` | 3E | A required migration surfaced after dependent code merged. |
| `stack-modification-blocked` | 3E | A stack PR is queued or auto-merging, the tree is dirty, or `gh stack modify` refuses. |

## Epic safety rules

1. **Decomposition comes from the reviewed plan**, never mid-run heuristics. Only a
   `## Phases` section that survived Stage 2 triggers the epic path.
2. **One confirmation before creating sub-issues** (2.7b), unless they already exist.
3. **Parallel writes only across provably independent phases, each in its own worktree.**
   Inline mode runs phases serially. Integration is by cherry-pick; a production conflict
   halts — partial or unreviewed phase work never lands.
4. **Ship completed layers, defer the rest.** A failed phase and its dependents are
   deferred; safety hard stops still halt the whole epic.
5. **Resumable, never destructive on a stop.** Every phase is a sub-issue and every layer is
   pushed before the next, so a checkpoint, budget pause or usage cutoff loses at most the
   in-flight phases' isolated work.
6. **No fabricated usage signal.** Budgets use only the explicit `SF_EPIC_*` proxies, at
   clean layer boundaries.
7. **Migration layers are mandatory in a stack.** Merge state and environment-apply state are
   separate, auditable gates. Late migrations restack unmerged work, never queued or merged work.
8. **Never merge.** The skill creates, updates and restacks PRs; merging is always human.
