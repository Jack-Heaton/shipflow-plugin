---
name: review-task-code
description: "Phase 4 of the split task lifecycle: multi-axis code review of the implemented diff, fix all in-scope findings, verify acceptance criteria, and open the PR. Runs the ship-task reviewer panel + fixer loop + AC gate + PR creation, then advances the task to `development complete`. Usage: $review-task-code <task-id|task-url>"
---

> Codex compatibility: this file is generated from the Claude skill source.
> For worker dispatch, read `../../references/shared/runtime.md` and resolve each role with
> `node ../../scripts/sf-runtime.mjs resolve --host codex --role <role>`; use the returned
> GPT model and effort with Codex collaboration tools. Claude model metadata describes the
> Claude backend only. Set `SF_PLUGIN_ROOT` to this plugin's absolute root before running
> shell examples, and resolve `../` references relative to this SKILL.md. Preserve every
> confirmation gate and destructive-operation guard.

# $review-task-code — review, fix & ship the diff (split-phase, phase 4 of 4)

The **review-and-remediate half of the code phase** and the terminal phase of the split
lifecycle: it reviews the diff `$implement-task` produced across the routed panel +
`security-reviewer`, fixes every in-scope finding, files the out-of-scope ones, verifies
acceptance criteria, opens the PR, and moves the task to `development complete` — the same
terminal state a fused `ship-task` run reaches. The phase handoff is defined in
`../../references/shared/phase-contract.md`; read it — this skill assumes it.

**Usage:** `$review-task-code <task-id>` or the task URL.

## Relationship to the engine

Thin slice. Reviewer routing, the shared reviewer output/artifact contract, the
triage-driven `sf-fixer` loop with warm closure and the round-extension rules, the AC
verification gate, follow-up task filing, and PR creation with the tracker link-back are
the canonical machinery in **`ship-task` Stage 3, sub-stages 3d → 3g** and the
ship-task §Follow-up tasks / §PR link-back / §Status lifecycle sections, executed through
`${SF_PLUGIN_ROOT}/skills/ship-task/SKILL.md`. Do
not reimplement them.

## Procedure

### 1. Preflight + pickup + gate

Shared preflight + pickup + precondition gate (phase-contract.md):

- ship-task Stage 0 (`run-meta`: `"skill":"review-task-code","phase":"code_reviewed"`)
  and Stage 1B steps 1–3 + 6 (fetch, reject terminal states, `$BRANCH` + `$TITLE`,
  establish/reuse the worktree from `$BRANCH` — fetch the pushed branch if this runner
  doesn't have it locally).
- **Precondition:** cursor `implemented` set; status `in development`. If `implemented`
  is null → **stop**: "nothing is implemented — run `$implement-task $TASK_ID` first."
  Re-running after a prior `code_reviewed` (e.g. to re-review a remediated draft) is
  allowed; adopt the existing PR rather than opening a second one.
- Sync (`shared/integration-sync.md`, `AT=1b` — the branch waited for this phase), then
  recompute `$REVIEW_BASELINE = git merge-base HEAD origin/$BASE_BRANCH` so the panel and
  the AC gate judge the **whole** range since the integration base (ship-task 3a), not
  just one runner's commits, and never the base's own commits (the block's recompute rule).

### 2. Review → fix → build → verify → PR

Run **ship-task Stage 3 sub-stages 3d → 3g** (including its Stage 0 step 5.5 review-backend
read: `HYBRID_MODE` ∈ {`off`, `review`, `codex`} (`SHIP_REVIEW_BACKEND=codex` ≡ `review`) — at `review` the 3d review seats run per `../../references/shared/review-backend.md`; at `codex` the 3e fixer and mop-up are `sf-codex fix` seats as well (§Hybrid mode);
a resumed run on another machine has no Codex threads to warm-continue, so closures fall
back cold exactly as they do for Claude seats):

- **3d** parallel multi-axis review — the routed domain reviewers (reviewer-routing.md)
  + `security-reviewer` + the baseline reviewers, each via the shared artifact-handoff
  contract; **3e** the triage-driven `sf-fixer` loop (max rounds, warm closure,
  round extensions to the ceiling). 3e's direction-review pass
  (`sf-direction-reviewer`, before every gated fixer with a merged item), its
  `adjudication` gate and its `oscillation-stop` rule run exactly as in ship-task.
  `unresolved-review-findings` at exhaustion is **informational** —
  it does not stop the phase; it flows to a draft PR + `remediating` (ship-task §Status
  lifecycle).
- **3f** sync (`AT=3f`) and re-run the full build after fixes; **3f.5** acceptance-criteria verification
  (a failed/unverifiable criterion keeps the `ac-failed` / `ac-unverifiable` checkpoint);
  **3f.6** file out-of-scope findings as **follow-up tasks** (ship-task §Follow-up tasks).
- **3g** probe (`AT=3g`; a tip that does not merge clean is never pushed as a PR head), push + open the PR(s) with `--skill review-task-code` — the call posts the `**[review-task-code · pr]**` comment, writes both links and the status — and read `mergeable` into the report: body carries `Refs #<task>` (never a closing
  keyword), the `## Follow-up tasks` section when non-empty, and the deferred-visual-checks
  section. For a stacked topology, per-layer submit per `skills/ship-task/epic.md` §Pull-request topology.

### 3. Advance the cursor + set terminal status + report

The PR link-back is already written: 3g's `sf-push --kind final` call posted the signed
PR comment, wrote the **GitHub PR** and **GitHub Branch** links and wrote the status
(ship-task §PR link-back — one link-back per PR). This step posts none of them again.

1. Post the implementation notes comment (`**[review-task-code · reviewed]**`: reviewer
   verdicts, fix rounds, AC evidence).
2. Set the cursor's `code_reviewed` (`rounds`, `pr`, and `status` = the terminal status
   below); commit the cursor and push it with
   `env $(node "$SF/sf-gates.mjs" push-env --runstate "$RUNSTATE") git push`.
3. The terminal status is the one 3g wrote — `development complete`, or `remediating`
   when the PR stayed a draft (unresolved findings, or test arms owed). A
   `tracker.status` of `ready for testing` on 3g's call means the `development complete`
   write failed and fell back, so flag it. When `$BASE_BRANCH` differs from
   `$INTEGRATION_BRANCH`, the ship-task §PR link-back release rule applies: its sentence
   travelled as 3g's `--note`, and the report says the PR targets `<base>` and the task
   stays `development complete` until `<base>` merges into `<integration>`. Audit event:
   `{"stage":"review-task-code","task":"$TASK_ID","rounds":<n>,"pr":"<url>","status":"...","by":"...","ts":"..."}`.
4. Run ship-task Stage 4's post-mortem (`ship-report/report.py` on `$SHIP_TASK_LOG`,
   posted as a PR comment) and print:

```
=== $review-task-code complete (phase 4/4) ===
Task:      <TASK_ID> — <TITLE>   status: development complete | remediating
Branch:    <BRANCH>
PR:        <PR_URL>  (base: <PR_BASE>, <ready | DRAFT — unresolved findings>)
Reviewers: <name>=<V> ...   (fix rounds: <N>)
Follow-ups:<task urls or "none">
Audit log: <SHIP_TASK_LOG>

Next step: re-test, then review and merge the PR. Merging does NOT close the
task — flip it to `shipped` after merge (manual-close convention).
==============================================
```

## Safety rules

Inherit ship-task's safety rules (drafts-until-clean,
fix-all-in-scope/file-the-rest, binding PR topology, migrations-first, fail-loud
checkpoints, signed comments), plus:

1. **Review + ship only.** This phase does not implement new plan scope; the `sf-fixer`
   applies findings against the existing diff. A finding that needs genuinely new
   implementation beyond the plan is an out-of-scope follow-up task, not silent scope
   growth.
2. **Implemented code required.** Refuse when `implemented` is null.
3. **Judge the whole range.** Review and AC-verify against `$REVIEW_BASELINE` (the merge
   base), so resumed/multi-runner work never ships unreviewed.
4. **Terminal writes only.** The task's terminal status is `development complete` /
   `remediating`; never `shipped` (human merge-confirmation) and never touch a
   `cancelled` task.
