# Integration sync (shared reference)

> Canonical block for keeping a run's branch current with `origin/$BASE_BRANCH` **while
> the run is in flight**, so every panel, gate and push judges a tip that can merge.
> Referenced by `ship-task` (1B, 2.7, 3d, 3e, 3f, 3g, resume), its `epic.md` 3E (layer
> scheduler + finalize), `implement-task`, `review-task-code` and `fix-task` (through the
> ship-task engine). Rationale:
> `ship-task/rationale.md` §Integration sync. Executable form: `scripts/sf-sync.mjs`.

Why every point matters: a branch synced once at pickup and once at push reviews clean,
builds green and then opens **CONFLICTING** — or, worse, merges the base at the very end
and spends the finalize rounds on collisions that a one-commit merge would have absorbed
had it happened when the base moved. The check is a fetch plus a `rev-list --count`; the
merge only runs when the branch is behind. Cheap enough to run at every boundary.

## The block

One command — `scripts/sf-sync.mjs` — is the sync. It fetches, measures, merges (or probes),
writes the `integration-sync` event, and hands back the values every caller branches on.
**Never substitute a bare `git rev-list --count` / `git merge` for it**: ship-task-1788826709
did exactly that at 3d, 3f and 3g, merged nothing, logged nothing, and `$ship-report` read
the run as unsynced. The event is the record; the script is the only thing that writes it.

```bash
# Inputs: $WT_PATH (the tree being synced — the integration worktree for layer/resume
# points, the phase worktree for phase points), $BASE_BRANCH, $SF (shipflow scripts dir),
# $AT (sync point, table below), optional $LAYER (epic layer index). $RUN_LOG must be
# exported (it is, from Stage 0) or the event is not written.
eval "$(node "$SF/sf-sync.mjs" --cwd "$WT_PATH" --base "$BASE_BRANCH" --at "$AT" ${LAYER:+--layer "$LAYER"} --export)"
# Sets: $SYNC_BEFORE, $BEHIND, $CONFLICTS, $REVIEW_BASELINE (recomputed — load-bearing, below),
# $PROBE (clean|conflict|none), $SYNC_HEAD, $SYNC_MERGED (1 when a merge commit landed),
# $MIGRATIONS (declared|undeclared|error), $MIGRATION_COLLISIONS (count; 0 when undeclared or
# error — read $MIGRATIONS) and $MIGRATION_COLLISIONS_JSON — §Migration collisions.
# Exit 3 = conflicts (a merge is LEFT IN PROGRESS for the §Conflict rule; a probe just reports).
```

What it does, so a reader can audit the ledger against the tree: `git fetch -q origin
$BASE_BRANCH`; `SYNC_BEFORE=$(git rev-parse HEAD)`; `BEHIND=$(git rev-list --count
HEAD..origin/$BASE_BRANCH)`; when behind, `git merge --no-edit origin/$BASE_BRANCH` (a
failed merge stays in progress and `CONFLICTS` is the unmerged-file count); then `sf-log
stage integration-sync at= behind= conflicts= [probe=1] [layer=] [merge_commit=]` and
`REVIEW_BASELINE=$(git merge-base HEAD origin/$BASE_BRANCH)`. `--at phase` (or `--probe`
anywhere) is the read-only form below.

**Recompute `$REVIEW_BASELINE` after every sync that merged.** `git diff A..B` compares
two trees, not a commit range: after a merge, a diff against the *old* merge-base carries
every base commit the merge brought in, so a stale baseline sends the panel, the cold
roster, the lint ratchet and the AC gate the whole of `development`'s recent history as
if the run had written it. The script's `REVIEW_BASELINE=` line is not optional — use the
value it prints, never one captured before the sync.

**The merge delta** is `git diff --name-only "$SYNC_BEFORE"..HEAD` minus the run's own
files. When it overlaps `git diff --name-only "$REVIEW_BASELINE"..HEAD` (the base rewrote
a file this run also edits), the merged tip is new code nobody has reviewed together:
re-run the scoped type-check + `npx vitest run --changed "$SYNC_BEFORE"`, and at 3f/3g
also the cold regression roster over `"$SYNC_BEFORE"..HEAD`. A disjoint delta needs no
re-review — the merge commit is the record.

## Conflict rule

`CONFLICTS > 0` → resolve them yourself when every conflicted file is one this run
rewrote (you hold the plan and the diff; fold the base's orthogonal additions in, keep the
plan's intent, re-run the scoped type-check + `vitest run --changed "$SYNC_BEFORE"`,
commit `[sync] merge origin/<base>` and log a second event with `resolved=1`
`merge_commit=<sha>`). A conflict in a file this run never touched, or one whose two
sides encode different **product decisions** (two designs for the same surface, not two
edits to the same lines) → `git merge --abort` and `CHECKPOINT_REQUIRED:
integration-conflict` (detail: the file list and the two designs in one line each). Never
resolve by taking one side wholesale.

## Migration collisions

Two branches that each add migration `NNNN` under different file names merge clean in git
and break at deploy. When the base's `.shipflow.json` (read from `origin/<base>`, never the
branch) declares `migrations` (`repo-config.md`), every sync — merge or probe — reports the
numbers claimed by a branch-side file and any other file: `$MIGRATION_COLLISIONS` is the
count and `$MIGRATION_COLLISIONS_JSON` the list, each number with its `base` and `branch`
paths. Numbers duplicated only inside the base are `base_duplicates`: history the run did
not cause, reported, never fixed here.

- **`$MIGRATION_COLLISIONS` > 0 at a merge point** → fix it before the next step: renumber
  the branch-side files with the repo's declared `renumber` procedure, commit
  `[sync] renumber migrations`, re-run the block's probe until it reports 0, and log
  `sf-log stage note event=migration-renumbered numbers='[…]'`. When every path of a number
  is branch-side (two phases of one run), renumber the later phase's file. At `layer` this
  happens before `$LAYER_BASELINE` is taken and before any phase worktree is cut, so no
  phase of the next layer starts on a colliding number. In stack mode, restack the upper
  layers (`gh stack sync`) after the renumber commit.
- **At `phase`** (probe only) the count is recorded, not fixed — the phase branch takes no
  merge; the next `layer` sync on the integration worktree fixes it.
- **`$MIGRATIONS` = `error`** (the base config or its tree could not be read; the event
  carries `migrations=error`) → the count is unknown, never 0. Re-run the block once; if it
  persists, `layer` raises `epic-layer-build-failed` and 3f raises a bucket-1 finding.
- **Not resolvable** (no `renumber` procedure fits, or the renumber collides again) →
  `CHECKPOINT_REQUIRED: integration-conflict` (detail: the numbers and both paths).

A same-named file added on both sides is a merge conflict, not a collision — §Conflict rule.

## Probe — a read-only "would it merge clean?"

For a tree that must **not** receive a merge commit (an epic phase branch, see below) or
a last check before push, ask git without touching the tree — `--at phase` probes by
definition; `--probe` forces it at any other point:

```bash
eval "$(node "$SF/sf-sync.mjs" --cwd "$WT_PATH" --base "$BASE_BRANCH" --at "$AT" --probe ${LAYER:+--layer "$LAYER"} --export)"
```
Underneath: `git merge-tree --write-tree origin/$BASE_BRANCH HEAD` (git ≥ 2.38) →
`PROBE=clean|conflict`, `CONFLICTS` = the `CONFLICT` lines counted, event logged with
`probe=1`. The tree and `$REVIEW_BASELINE` are untouched; callers branch on `$PROBE`,
`$BEHIND` and `$SYNC_BEFORE` exactly as after the merge form. When `merge-tree` is
unavailable the script logs `probe=1 conflicts=-1`, prints `PROBE=none`, and the caller
falls through to the merge at the next non-phase point.

## Sync points

| `at=` | Where | Merge or probe | Why here |
|---|---|---|---|
| `1b` | Pickup — §Worktree, **both** the reused-worktree and inline-mode branches (the fresh-worktree branch already cuts from `origin/$BASE_BRANCH`). Every split-phase skill and `fix-task` enter through 1B, so they inherit it. | merge | A branch that waited for a plan review, a runner hand-off or an operator answer is behind before the first line is written. |
| `3d` | Before the round-1 panel. | merge | The panel must review a tip that can merge. |
| `3e` | Every fix-round boundary (before each closure / cold pass launches). | merge | A fix loop is the longest wait in a run; the base moves under it. |
| `3f` | Before the build gate — so the gate, the lint ratchet and the AC table run on the merged tip, once. | merge | A gate on a pre-merge tip is re-run after the 3g merge or it never validated what ships. |
| `3g` | Immediately before `git push`. | probe, then merge only if behind | Nothing between 3f and here should have moved the base, but a run's finalize can take an hour. A tip that does not probe clean is never pushed as a PR head — merge, re-run the scoped gate (type-check + `vitest --changed`), then push. After `gh pr create`, read `gh pr view --json mergeable` and carry `CONFLICTING` into the report as a failure of this rule. |
| `layer` | Epic, integrated mode — `$WT_PATH` is the integration worktree (`$INTEGRATION_WT`, `$BRANCH` checked out). Runs **before** `$LAYER_BASELINE` is taken for layer *k* (so every phase worktree is cut from a current base), and, on a layer that cherry-picks, again immediately before step 5's cherry-picks. The layer gate's ref is set per layer kind in ship-task Stage 2.7. Stack mode: the bottom layer branch only. | merge | A base collision absorbed at the layer it appears on is a one-commit merge; deferred to finalize it is a merge-resolver seat and an operator decision (`rationale.md` §Integration sync). |
| `phase` | Inside an epic **phase** worktree (`$WT_PATH` = `$PHASE_WT`), at its 3d/3e/3f points. | **probe only — never merge** | A merge commit on a phase branch breaks step 5's `LAYER_BASELINE..PHASE_BRANCH` cherry-pick range (a merge is not cherry-pickable without `-m`, and with it the base's commits replay). The layer-boundary sync is what keeps phases current; the probe only tells the orchestrator early that step 5 will collide. |
| `resume` | Any resume (`resume-adopted`, 2.7d, a phase-cursor pickup) before scheduling work; for an epic `$WT_PATH` is the integration worktree. | merge | A crashed or paused run is behind by however long it slept. |

**Epic cherry-pick conflicts after a `layer` sync** are one of two things — tell them
apart before choosing the rule: `git log --oneline "$SYNC_BEFORE"..HEAD -- <file>` on the
integration branch lists the base commits the sync brought in. A conflicted file that
appears there is a **base collision** (the base and the phase edited the same file) →
the §Conflict rule above, resolved on the integration branch, then
`git cherry-pick --continue`. A conflicted file that does not → phase-vs-phase, scopes
were not disjoint → the scheduler's existing `epic-integration-conflict` checkpoint.

**Speculative layer k+1** (ship-task 2.7) is cut from `$BRANCH` before layer *k*'s sync
runs; its `git rebase` onto the integrated tip absorbs the sync. A rebase conflict is
still discarded per 2.7 — never merge the base into the speculative tree.

## What the block is not

- Not `$sync-branch` (shipflow): that skill auto-commits a WIP and is for a human at a
  prompt; this block runs inside an orchestrator on a tree that is committed at every
  boundary.
- Not a rebase. The run's commits stay as authored; merge commits are the audit trail of
  when the base arrived and what it touched (`report.py` renders every event).
