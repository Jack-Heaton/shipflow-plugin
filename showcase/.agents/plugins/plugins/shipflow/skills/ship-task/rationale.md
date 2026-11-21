# $ship-task — rationale and measured incidents

> Companion to `SKILL.md`. The skill file is the executable spec and stays short; this
> file is **why** each rule exists, with the run that taught it. It is cited from the
> skill, never loaded into a run. When a rule in `SKILL.md` looks arbitrary, the
> answer is here; when you change a rule, move its old rationale here rather than
> deleting it.

## Cost shape (why the plan loop and review are the levers)

Measured across the earlier issue-tracked skill and again
across 54 ship-task runs (2026-08-12 → 08-31): implementation is **7–25%** of sub-agent
tokens; review + fix **30–55%**; the plan loop **38–68%** and the largest single
wall-clock block (median ≈ 30 min, 13–59% of a run; on run A it was 78 min of 2h26m,
including one 51-minute plan-reviewer spawn). Writing the code is the cheap part —
every meaningful lever is in planning and review.

## Express path (Stage 1.9)

The classifier existed since the earlier issue-tracked skill but fired on **6 of 34** classified
ship-task runs. The failure reasons across the 28 full-path classifications were
multi-workspace 19, seam 18, open questions 15, auth path 14, more-than-5-files 12 —
judged from the task body in prose, not computed. One run cited `withAuthentication.ts`
as an auth-path file; the routing regex matches 116 files in the repo and that is
not one of them. "When in doubt, plan" turned every doubt into a full plan loop. The
2026-08-31 revision makes conditions 1–3 the output of `sf-route classify` and raises the
file bound from 5 to 8; only conditions 4–5 (testable AC, open questions) remain a
judgment about the task body, and a single user-decidable open question is asked in one
the available structured user-input tool instead of routing the whole run to Stage 2.

Express runs keep every gate: `security-reviewer`, the build, AC verification, and
mandatory abandonment when the diff outgrows the classification. A wrongly-expressed
task costs one implementer; a wrongly-skipped plan costs a bad change that reviewers may
rationalize rather than reject — which is why abandonment is mandatory, not advisory.

## Plan loop (Stage 2)

- **Targeted re-review on rounds ≥ 2** (earlier issue-tracked skill): re-checking ~30 unchanged
  citations to chase one open HIGH is where plan loops burned hours. Round 1 buys the
  full 11-dimension pass; later rounds scope to closed findings, touched sections, and
  implementability.
- **MEDIUM/LOW-only exit and the convergence escape**: an adversarial reviewer told
  never to soften will almost always find a MEDIUM; only CRITICAL/HIGH justify a
  re-review round. A strictly-decreasing residual of ≤ 2 HIGH is closed by one fixer
  pass and handed to the code reviewers, who judge a diff instead of prose.
- **Warm continuation (2026-08-31)**: plan rounds in the ship-task logs were
  1 × 6, 2 × 12, 3 × 6, 4 × 1. Every round ≥ 2 cold-spawned a `sf-plan-fixer` (15
  observed, median 116k tokens, 4.0 min) and a `sf-plan-reviewer` (median 138k tokens,
  4.9 min), each re-reading the plan, requirements, cited code, and a 12 KB verbatim
  paste of the review criteria. The same `SendMessage` continuation the fix loop uses
  worked on 33 of 38 recorded closure exchanges, so the plan loop now continues the
  round-1 drafter as the fixer and the round-1 reviewer for targeted re-reviews, with
  the identical cold fallback.
- **Speculative exploration**: the per-area `Explore` reports are read-only and useful
  under every plan outcome (≈ 3 min and ~108k tokens per report), so they start before
  the draft: with the Stage 1.8 repro seat, else in the same message as the round-1
  drafter. They are seeded from the Stage 1.9 file set, which exists before any plan
  does (§Parallel seats).
  Speculative *implementation* is opt-in (`SHIP_SPECULATE=implement`): after the
  round-1 fixer runs, 7 of 19 measured plans still took a CRITICAL/HIGH in a later
  round, so an implementer started then is reworked about a third of the time; it
  trades ~130k tokens for ~5 min of wall-clock and is only worth it when round 1 came
  back converging (0 CRITICAL, ≤ 2 HIGH).
- **Plan accretion**: the measured defect on run A was a 603-line plan for a 13-file
  change. The drafter's instruction-vs-provenance rule and the fixer's anti-accretion
  rules exist for that.
- **Open questions are an interview, not a stop**: most are product/preference
  decisions the user answers in one prompt; only investigation-bound items dead-stop.
- **Bounded acceptance criteria (2026-09-02)**: on one epic run the criteria
  arrived verbatim from the task body and three of them were universal claims over
  heuristic domains — "no citation on any reconcile result…", "a badge only when the block
  is actually sourced from that type", "never a different block's box". Each reviewer
  round produced a fresh counterexample (two-column sheets, full-width rows, 337/STC
  markers, an OCR-truncated 8130-3) and each became a fix-now HIGH: the rendering phase
  ran 8 rounds, the labeling phase 5 with a 9-HIGH cold panel; the containment phase, whose
  criterion was a structural invariant with a contract test, converged in one. Criteria are
  now bounded at Stage 2 (`sf-route ac-scan` tripwire → `guard:` / `fixture:` rewrite,
  interviewing on product calls), the plan reviewer files an unbounded criterion as HIGH,
  and at triage a counterexample outside the pinned set is a follow-up (`scope-policy.md`
  Rule 5), not a fix-now item.

## Implementation (Stage 3c)

- **Smoke type-check with the round-1 panel**: on run B a `server-only` import pulled into
  the client bundle passed scoped `type-check` and 223 unit tests and was caught only by
  `next build` at 3f — after two review rounds and ≈ 3.4M reviewer tokens on a tree that
  could not compile. The smoke was first placed before any reviewer, where it held the
  panel for 12.6, 7.0, 3.5 and 3.4 min in four runs. As of 0.43.0 it runs once, after the
  last batch, on `$REVIEW_SHA`, in the same message as the round-1 panel: a genuine
  failure is a bucket-1 finding in round 1's triage, so a tree that cannot compile costs
  one review round, not two, and a tree that can costs the panel no wait.
- **Scoped builds (2026-08-31)**: every run built the whole monorepo twice and every
  worktree ran a full background `npm install` (1.7–1.8 GB, measured across ten
  worktrees) whose only consumer is `next build` through the link farm. A backend-only
  change paid all of it for nothing. Builds now filter to touched workspaces plus
  dependents; `next build` and the full install run only when the web app or a package
  it imports is in the diff — which still covers the run B case. The install is still
  kicked in the **background**, but from the computed file set (Stage 1.9 / 3b) rather
  than at worktree creation, so FE runs keep the overlap they had and non-FE runs never
  pay it.
- **Explore skip on ≤ 2-file batches**: the earlier PRD skill already skipped exploration for trivial
  plans; the earlier issue skill always spawned one `Explore` per task. Eight such spawns in the
  ship-task logs cost ~108k tokens and 3 min each for work the implementer does inline.
- **Parallel writers**: parallel agents writing into the same worktree race on the git
  index. The 3b gate (scratch worktrees available, no contract seam, ≥ 2 independent
  tasks, pairwise-disjoint scopes) is what makes per-scratch-worktree writers safe. A
  layer's seam tasks land first as a serial batch, so the parallel batch after it starts
  every scratch worktree from the seam change (§Parallel seats).
- **Lockfile drift**: a worktree `npm install` rewrites `package-lock.json`'s `name`
  field and some peer metadata; discard it so the PR diff stays clean.

## Review roster (Stage 3d)

Round-1 verdicts across the ship-task logs: security 20 PASS / 2 FAIL, performance
18 / 2, architecture 8 / 1, frontend 12 / 0, test-coverage 15 / 6, ux 9 / 3,
infra 4 / 1, backend 5 / 0. Before 2026-08-31 a single
`web/src/components/X.tsx` change spawned five uncapped opus reviewers
(security, performance, frontend, ux, test-coverage-guardian — the last because its
routing row matched all frontend and infrastructure source). `sf-route` now gates performance the way
architecture is gated, adds `test-coverage-guardian` only when production code changed
without a test change, and routes components-only diffs to `ux-consistency-lead` alone,
adding `frontend-reviewer` when a server/client boundary file is touched.

- **Test-only narrowing**: on run A a ~90%-test diff spawned six reviewers; security,
  infra and performance cost 599K tokens and returned PASS with zero
  findings every time.
- **Architecture gating**: on run C (phase 1) the architecture
  baseline produced the longest artifact of a six-reviewer panel — 218 lines, 0
  CRITICAL/HIGH — in which nearly every point duplicated a domain reviewer's finding.
- **Reviewers are read-only**: on run A round-2 reviewers were told to run mutation
  probes concurrently in a shared worktree; two raced and one observed the other's
  in-flight edit to a production file. Probes are `PROBE-SUGGESTED`, orchestrator-run,
  serial.
- **Artifacts, not return text**: teammate / in-process and background-completion
  paths surface an idle notification with empty text. The file is the deliverable.

## Fix loop (Stage 3e)

- **Round 2 earns its keep**: round-2 fix-now yields in the ship-task logs were
  9, 0, 0, 3, 4, 3, 2, 4 — the base budget stays at 2 (+1 seam extension, then the
  orchestrator's own extensions up to `SHIP_FIX_ROUND_CEILING`).
- **Seam extension (2026-09-01)**: a fix round that touches a seam re-runs the full
  round-1 panel cold over the whole range (`warm-closure.md` §2), i.e. a fresh review of a
  bigger change — and on one run it arrived in round 2 with the budget already spent:
  9 new fix-now findings, verified by gates only, PR opened `draft-unverified-final-round`
  with 5 follow-ups. One extra ordinary round when `warm+cold-panel` fired (once per run,
  before any extension) costs one fixer + closures on the rare seam case and turns a
  known-unverified draft into a reviewed PR. Non-seam runs keep the base budget of 2.
- **Orchestrator adjudication + wait work (2026-09-01)**: the orchestrator idles at zero
  token cost while seats run, so utilization is not the argument — judgment with context
  is. Three steps ran on judgment-free prose: plan-fixer rounds consumed unverified
  reviewer CRITICALs (the loop's largest serial block), triage sorted findings without
  reading the diff (two seats' identical HIGH became two fixer items), and the 3f–3g tail
  (~30 min) ran serially after the last fix round. Now: adjudicate plan findings against
  cited evidence, read the diff during the panel, dedupe at triage, and draft the tail
  during waits.
- **Fix direction (2026-09-01)**: `review-backend.md` §Fix direction. The first hybrid
  run graded the Luna implementer A− and the same-model fixer C — the difference was the
  input (reviewed plan vs raw hypotheses). The orchestrator, which already adjudicates
  the bucket at triage, now writes a binding per-finding direction (approach +
  verify_first probes + out-of-scope) when the bucket is design-shaped; the fixer
  executes. Gated so two-MEDIUM buckets and the mop-up stay one cheap spawn.
- **`HYBRID_MODE=codex` writers and explorers (2026-09-01)**: the implementer is the
  pipeline's heaviest spawn and its input is the most bounded artifact we produce — on
  one run the Claude implementer's "decisions the plan did not specify" were six
  cosmetic items and zero semantic ones. That is the profile a Sonnet-class model at top
  effort handles, so the seat moves to `gpt-5.6-luna` / xhigh behind a flag, with two
  guards the Claude path never had: the report's commits are verified against
  `git log <baseline>..HEAD`, and every plan gap is tagged and counted, so "are our plans
  bounded enough?" becomes a number per run instead of an opinion. Exploration moves for
  the same reason (locate, don't judge) and gets a structured tripwire field. Sandbox:
  landlock cannot do workspace-write, so writers run with codex's sandbox bypassed inside
  the worktree — the boundary a Claude implementer already relies on.
- **Codex seat tiers (2026-09-01)**: `review-backend.md` §Seat tiers. Measured on
  `ship-task-1788227781`: plan-reviewer 36% of Codex tokens and worth it (3 CRITICALs,
  live-code verified); `test-coverage-guardian` 17% for six "no test for X" HIGHs;
  `architecture` 11% for a MEDIUM and a duplicate HIGH. The demoted seats were 44% of
  Codex tokens; wall-clock is unchanged (the Claude seats set the envelope).
- **Fixers back to Luna, at MAX + priority (2026-09-04)**: fixers had been moved to
  Terra/high on 2026-09-03 after five Luna/**xhigh** fix rounds regressed (four introduced
  defects, one a HIGH blocker). The correction is not effort-family but effort-level: the
  fixer and mop-up seats return to `fast-max` (Luna / **max**, its ceiling), the same tier
  the implementer already earns — the writer seats get the reasoning, at the effort the
  xhigh run lacked. All Luna seats (explore, implementer, fixer, mop-up) now pin
  `service_tier: "priority"`; Terra and frontier seats set none and inherit the run home's.
- **Convergence escape** (retired 2026-09-02, see the next bullet): on run B the cap was
  fictional — round 2 exhausted with two convergent HIGHs open, then an unrelated
  `build-failed` checkpoint bought rounds 3 and 4, which closed both (one was a total
  sign-in lockout latent behind a config flag). The run shipped correct work only because
  a build failure happened to occur.
- **Round extension replaces the escape (2026-09-02)**: the escape's "every remaining
  finding raised by ≥ 2 seats" condition almost never held, so one epic run
  exhausted the budget in all three phases and asked the operator five times whether to
  run another round (P4 r4, P1 r4, P2 r3/r4/r5). The recommended option was taken every
  time — the decision was mechanical — and one question idled the run 8h03m overnight;
  operator waits were 10.9 h of the run's 15.9 h. The orchestrator now extends on its own
  under four rules (progress or a bounded bucket; no finding reopened twice and no
  revert/inversion of an earlier fix; no fix-introduced CRITICAL/HIGH last round; a
  per-phase ceiling of 6) and asks only when there is a decision to make. The oscillation
  rule is the one that would have stopped P4 (reading order rebuilt, patched twice,
  reverted by the operator) and P2 (revalidation flipped both ways) earlier, not later.
- **Late pinned seats — the addendum fixer (2026-09-02)**: the Claude security seat set every
  panel's envelope on one epic run (29 min on P1 round 1 against 2–5 min per
  Codex seat) and the fixer was held for it so its findings would "ride the same round".
  The fixer now launches on the Codex bucket; a late seat's fix-now findings get a second
  fixer spawn in the same round, and closures run once after both. The seat's verdict is
  unchanged; only the idle is gone.
- **Follow-ups filed at triage, into a bundle (2026-09-02)**: L1 of the same run filed five
  follow-ups at 3f.6, four minutes before its PR, each a standalone task whose only
  provenance was a footer. They are now subtasks of one cleanup bundle per run, filed in
  the triage that raised them with an `## Origin` section, and the bundle ships through a
  fixer-shaped path with no plan loop (`ship-task` Stage 1.9 §Bundle path).
- **Warm closure + cold regression split**: on run A a full six-reviewer cold round 2
  cost 708K tokens (28% of the run) to re-confirm a unanimous PASS; its one genuine catch
  (a tautological assertion) was in the fixer's own commits. Closure is verified by the
  finding's author (cheap, precise, cannot be talked out of it); regressions are caught
  by fresh eyes over the fix diff. Declines are verified by the author too — on run C
  an orchestrator-accepted decline cited an ORM limitation that did not exist.
- **Cold-pass floor is zero when there is nothing to read (2026-08-31)**: the floor
  bought an opus spawn even when every closure came back CLOSED, no CRITICAL/HIGH was in
  the bucket, and no test file was in the fix commits. The run A tautology case is
  exactly a test-file edit, which keeps the pass.
- **"Seam touched → full cold panel" is computed, not judged (2026-08-31)**: judged from
  prose, the full-panel branch fired on 7 of 13 round-1 triages; on one task the
  cold panel was 10 spawns and 1.2M tokens (26% of the run).
- **Pairing retired (2026-08-31)**: the reopened-finding pairing sub-protocol was ~170
  lines of orchestrator state (uncommitted drafts, staged-by-path invariants,
  unconditional `git restore` at every exit) and produced 4 `pairing-check` events in 54
  runs, one of which reopened anyway. A REOPENED finding now takes the ordinary next
  round; the round cap and `unresolved-review-findings` bound it.
- **Mop-up round, verified lightly (2026-08-31)**: on run D the final re-review
  surfaced 47 MEDIUM/LOW findings after 98 had been fixed, and reclassify-and-file turned
  a converged run into eight issues. The mop-up drains those inline; it is verified by
  the type gate plus `vitest run --changed`, not by another closure round, because it
  never reopens the PASS verdict.
- **Filing floor and generation cap**: the reference repository reached 156 of 266 open
  issues carrying `cc-followup` — created by this very review process.
- **Touched-file adjacency (2026-08-31)**: Opus 5 applies the three-condition scope test
  literally, and the test excluded bounded fixes in files the PR had already rewritten
  ("not 'while I'm in this file'"). Across 39 Opus 5-era runs bucket 3 was 18% of triaged
  findings and nine runs filed 5–9 follow-ups. On one task six follow-ups were cut
  from one fix; three were small MEDIUMs in two component files
  (in-diff file, or the same purge gap the task closes). `scope-policy.md` §Touched-file
  adjacency admits those as bucket 1.
- **0.33.0 — thrash and escapes, ten ledgers 2026-09-11 → 09-18.** Implementation was
  6–13% of sub-agent tokens; closure exchanges and cold panels were the largest single
  waste (one run: 17 exchanges ≈ 3.1M tokens, 16 returned nothing reopened; a seam-only
  cold panel ≈ 1M tokens for 0 CRITICAL / 0 HIGH). Express never fired in ten runs (a
  4-file fix failed `single_workspace`). Scope grew in fix rounds, not plans: adjudication
  accepted 3/3, 5/5, 3/3, 3/3 with zero redirects; the direction reviewer's BLOCKING items
  were answered with design (one run +8 steps / 7 files; another's phase 2 +16 / 30);
  a 19 KB four-item direction; a fixer wrote a three-case concurrency proof inside a round.
  Plan reviews graded omissions as CRITICAL/HIGH (2 C + 9 H on a 4-file fix) and every HIGH
  bought a 190–270k-token warm round, while implementers still reported 3–5 semantic gaps
  per batch of the same seven classes (error path, bounds, text, return shape, test
  placement, contract pair, markers). Meanwhile four escapes were runtime contracts a diff
  reader cannot see: an init call missing at deploy, producer/strict-validator
  drift (100% of one record type), a database-driver uuid cast, a schema-literal
  gate on truncated output. Seats: performance 9 PASS / 1 FAIL at opus,
  architecture 9 / 1, security 20 / 3, backend 4 / 5. Changes: closure exchanges
  only for FAIL / declined / reopened reviewers; full cold panel only on seam + HIGH;
  express `few_workspaces` (≤ 3) + `bounded_lines` (≤ 400 on the diff); adjudication gains
  `## Deferred` (commit reverted, filed) and accept is no longer the default; direction
  budget 120 words per item, reviewer only on `merged_high ≥ 1`; plan `## Decisions` table
  required with a severity test that reserves CRITICAL/HIGH for "implemented as written,
  ships wrong"; 0 C / 0 H plans skip the fix pass; reports carry semantic gaps only;
  performance seat retired and architecture seam-only, with the runtime-contract checklist
  moved into `test-coverage-guardian` and `backend-reviewer`; preflight repairs
  node_modules / dist before any seat; `sf-log check` adds `spawns_wall_orphaned` and
  `usage_channel_dead` (four of ten ledgers had no token data on CC 2.1.273–2.1.277).

## Epic fan-out (Stage 2.7 / 3E)

- **One integration branch, one PR (2026-09-02)**: the stack existed so a lower layer
  (a migration) could merge while higher layers were in flight. On one epic run
  no layer was a migration, yet every layer paid the full tail — install + `next build`,
  mop-up, AC table, push, `gh stack submit`, PR body, tracker link-back — ≈ 37 min per
  layer — and L2 was cut on L1's tip so any L1 review change forced a restack. The
  pre-push hook itself was ~3 min (41 commits; type-checks, the vitest arms, jsdom 16 s,
  workspace suites 71 s) — the cost was the tail and the topology, not the hook. Layers now
  integrate onto one branch behind the phases' own review loops and a scoped
  type-check + `vitest --changed`; the expensive gate runs once at the top. The stack
  remains for the case it was built for.
- **Speculative next layer (2026-09-02)**: P2's explore (8 min), implementer (17 min) and
  layer setup (9 min) ran only after L1's PR was open, although its explore notes depended
  on nothing that changed after P1's round-1 closures. The explore now starts with the
  lower layer's panel; the implementer starts once the lower layer's round-1 bucket is
  closed with no CRITICAL/HIGH open; the panel waits for integration and a clean rebase.
  Gated that way, this run's P1 (9 fix-now, 2 human in round 1) would have released P2's
  implementer after round 4 — later than ideal, but still ahead of the layer tail.
- **Kickoff is notify-only (2026-09-02)**: the epic kickoff (`epic.md` 2.7b) confirmation asked
  one epic run whether to run the plan it had just accepted after three review
  rounds; the answer arrived 98 min later. The plan loop's clean pass and the validated DAG
  are the authorization; the operator gets the layer plan as a notification and
  `SHIP_EPIC_CONFIRM=1` restores the question.

## Integration sync (`shared/integration-sync.md`, 0.27.0)

- **Sync at every boundary, not at the ends (2026-09-07)**: 0.26.0 merged the base at 3d
  and 3g only. On `ship-task-1788621317` (epic, 8 phases, 6 integrated layers, ~30 h) the
  orchestrator improvised one sync before layer 0's cherry-picks (13 behind, 0 conflicts)
  and none for layers 1–5; the 3g sync then arrived **30 commits behind with 2
  conflicts** in files two phases had rewritten. Absorbing them took a merge-resolver seat
  (36 min), an operator product decision at the merge boundary (the two sides were two
  designs for the login page), and the finalize panel over the merge delta — four finalize
  fix rounds, one operator-authorized — plus three HIGHs filed against base code the
  merge pulled in. The run's own post-mortem said it: synced at every layer gate, the
  login-page conflict is a one-commit merge at the layer it appeared on. The check is a
  fetch and a `rev-list --count`; the merge runs only when behind.
- **Phases probe, layers merge**: a merge commit on a phase branch is not cherry-pickable
  by range (`LAYER_BASELINE..PHASE_BRANCH` would carry it; `-m` replays the base's commits),
  so the per-phase 3d sync could never run inside an epic — which is why the 0.26.0 rule
  silently covered only single-task runs. The integration branch syncs at the top of each
  layer (before phase worktrees are cut) and again before the picks; phases run the
  read-only `merge-tree` probe so a coming collision is known before step 5.
- **Recompute `$REVIEW_BASELINE` after a merge**: `git diff A..B` compares trees. After a
  base merge, a diff against the old merge-base includes every base commit the merge
  brought in — the panel, the ratchet and the AC table would judge `development`'s history
  as the run's diff. The block ends by recomputing it for that reason.
- **3f syncs, 3g probes**: with the merge at 3g (after the build gate), a delta at 3g
  meant re-running the gate — on this run, the full build and lint ratchet ran twice at
  finalize. The merge now precedes 3f; 3g asks `merge-tree` whether the tip still merges
  clean and only merges again when the base moved during finalize. The PR's `mergeable`
  field is read back into the report so a CONFLICTING head is a failed rule, not a
  surprise for the reviewer.

## Gates (3f / 3f.5)

- **Lint gate**: run B shipped a new `react-hooks/set-state-in-effect` error with every
  gate green — the pipeline had never asked lint. The repo's per-file ratchet is the
  gate; whole-workspace `npm run lint` reports 721 pre-existing errors.
- **A test that has never been executed is not an artifact**: on run B the AC table
  said "E2E spec written but never executed — needs a dev server". True and incomplete —
  the spec contradicted a fix the same run had made. Read an unrun spec against the code
  and say whether it would pass.
- **Concurrent gates (0.43.0)**: build, manifest drift with the skipped suites, lint and
  each acceptance command ran one after another, and last seat → PR took 5–34 min (median
  about 16). They share no port, database or lock (operator-confirmed premise,
  2026-10-01), so they run concurrently on the synced tip. Each job's verdict is its own
  exit status and its log sits under a `mktemp -d` directory: a verdict read through
  a pipeline has already reported a red gate as green in the reference repository. A
  command that reads build output waits for the `build` job to exit 0. `drift` stays one
  job, serial inside, because two concurrent `sf-gates run` processes were not verified
  safe. A drift, skipped-suite or lint fix moves the tip, so the whole job set runs once
  more after the one fixer pass. Acceptance logs stay out of `$ARTIFACT_DIR` because they
  are not committed.
- **One gate command (0.44.0)**: the orchestrator launched each job by hand, waited on
  per-job exit files, held the build readers, applied build resilience and compared logs
  to decide "pre-existing". From the 3f sync to the PR that was a median 16.2 min (p90
  39.8) over 27 runs, spent in orchestrator turns that were shell work. `sf-gates gate`
  does all of it in one process and prints one JSON verdict; its `next` field is the
  former "act in this order" list as a mapping, so the orchestrator reads a log only for
  a job marked `fail` or `error`. The 3c smoke and the 2.7 layer gate are modes of the
  same command. Drift checks still run one after another inside it, a retry still runs
  alone after every started job has ended, and nothing was added beyond the old rules: no
  cache, no lock, no per-job deadline. "Far below the diff" for the lint count had no
  number; it is now "fewer than half of the changed, existing, lintable frontend files"
  (operator, 2026-10-02). A job killed twice, or a `build`/`smoke` whose `npx turbo` cannot
  be resolved, is `error`, not `fail`: the run learned nothing about the code.
  **Debt:** the build, type-check and lint commands moved from the skill's fenced blocks
  into `sf-gates.mjs` unchanged, so a plugin script now carries monorepo-specific commands
  (`npx turbo run build|type-check`, the web-app and `packages/` test, the
  web-package exclusion filter, `scripts/lint-ratchet.mjs` and its `ok (N file(s)
  checked` line) against `shared/repo-config.md`'s rule that a plugin script hardcodes
  nothing repo-specific. They were not declared in `.shipflow.json` here because gates read
  the base's copy: between the upstream merge and the base carrying the new keys, every
  run would have had no build. Making them repo-declared is a separate change.

## Push and PR mechanics (3g, 0.44.0)

- **One command for the tail**: after the gates, 3g was five shell lines the orchestrator
  ran and read one turn at a time — push, find the PR, create or edit it, read
  `mergeable`, then four `tracker` calls for the link-back. `sf-push --kind final` does them
  in one process and prints one JSON line. The orchestrator keeps what needs the run's
  context: the body, and the ready-versus-draft call (safety rule 1), which it makes
  before the call (`--task-status`) and acts on after it (`gh pr ready`).
- **A push is verified against the remote**: 3g, the layer push and the checkpoint push
  were bare `git push` calls, and nothing in the skill named the repo's required
  `scripts/push-verified.sh`. A push whose hook was still failing has already been
  reported as pushed there. A repo now declares its command (`.shipflow.json`
  `push.verified`), and whatever that command reports, `sf-push` compares
  `git ls-remote` with the `HEAD` it recorded before the push; `verified` is that
  comparison, not an exit status. The command is read from the base's copy, like the
  gates, so a branch cannot swap the command that pushes it; until the base carries the
  key the built-in push runs under the same check.
- **`gh pr edit` does not apply the edit**: re-tested 2026-10-02 in the reference
  repository (`gh` 2.23.0) — exit 1, one GraphQL pre-fetch that fails on
  `projectCards`, no update mutation, body unchanged; an earlier operator note recorded
  exit 0 with the same result. A re-run of 3g therefore left a stale body on the PR. The
  body goes through `gh api -X PATCH … -F body=@<file>` and is read back; a body that
  does not match is `error.step: body-verify`, whatever the update's exit status was.
- **Run in the background, judged from the JSON**: the pre-push hook can outlast the
  foreground tool limit, and a killed push leaves nothing on the remote. The transcript
  goes to a file under the temp directory, never into the repository.
- **`CONFLICTING` writes no status**: the base moved during the push and 3g loops once;
  the second call writes the comment and the status, so the task is not marked
  `development complete` on a PR that cannot merge and the comment is not posted twice.
- **Stack mode keeps its own push**: `gh stack submit` cannot go through a verified push
  command, so it stays under `push-env` and each layer then calls `--push no`, which
  compares the remote tip with the layer's branch ref (the layer need not be checked
  out).
- **Layer and checkpoint pushes skip the hook's test arms**: an integrated epic pushes
  after every layer, and each push re-ran the hook's unit tier on commits the layer gate
  had just tested. On an existing branch the hook judges only the commits after the
  remote tip, so skipping alone would leave those commits untested for good. The two
  hook inputs are a pair: `SF_HOOK_RUN_CHECKPOINT=1` skips the three arms, and the final
  push's `SF_HOOK_RANGE_BASE` makes the hook judge the run's whole range once. `sf-push`
  is their only caller, and `--arms skip` is opt-in per call: a run that never reaches a
  final push through `sf-push` (a stack run, `implement-task`) would otherwise skip the
  arms and never repay them. `SF_HOOK_SKIP_TEST_UNIT` keeps its one meaning, an
  operator-approved red baseline.
- **The range base is the merge-base with the base**: the 3g probe has just merged the
  base, so the range is the pull request's own diff. A run-start sha would also sweep in
  every base commit the run's syncs merged, and a sha after the remote tip would shrink
  the range.
- **`test_arms` is read from the transcript**: a clone whose installed hook predates the
  inputs runs every arm on a checkpoint push and prints no range-base line on the final
  one. Reporting from what the hook printed keeps the report true in both cases; a final
  push with no range-base line is `unconfirmed`, which matters only when an earlier push
  of the run asked to skip. A final push to a remote that already holds the tip hands the
  hook no ref line (`no-ref-pushed`), so 3g commits the `stage=3g` cursor first.
- **`arms_owed` lives in the committed runstate**: whether an earlier push asked to skip
  is a fact about the branch, and a ledger line written after the push is not on it — a
  resume in another checkout would read "no skip" and mark the PR ready. The key is set
  in the commit the skipping push carries and cleared only by a final push that reports
  `ran`. It records the request, not what the hook did. A clone whose hook reads neither
  input ran every arm, so its checkpoint returns `ran`, the key goes back to `false`, and
  the run ends ready through the `--push no` call. The draft case is a hook that honoured
  the checkpoint input but whose final transcript shows no range line: nothing there
  confirms the arms, and the report names the range instead of guessing.

## Review backend (`SHIP_REVIEW_BACKEND=codex`, 0.20.0)

- **Why the seats and not the writers.** Per §Cost shape the plan loop and review are
  30–68% of sub-agent tokens; implementation is 7–25%. Every reviewer is already a pure
  artifact contract, so the producer can be swapped without touching 3d/3e or the plan
  loop — `review-backend.md` is a substitution table, not a second engine.
- **Independence is the second reason.** Triage credits a deduped finding to every seat
  that raised it, and `warm-closure.md` credits the pipeline's best catches to
  independently formed positions. A plan drafted by one model family and
  reviewed by another, and a code finding convergent across families, are stronger claims
  than two same-family spawns. Every diff still gets a Claude read: `security-reviewer`
  stays pinned (the one opus gate of record, and a safety-critical repo's security gate does
  not change model family on the same PR as the plumbing); `ux-consistency-lead` stays
  because it needs Playwright.
- **Read-only becomes mechanical.** run A's mutation-probe race (§Review roster) happened
  because "reviewers are read-only" was prose. `codex exec -s read-only` cannot be talked
  out of it, and the seat never writes its artifact — `sf-codex` renders it from the JSON.
- **Blind seats — the first live incident (2026-08-31, `ship-task-1788189087`).** The
  first hybrid run's Codex plan seat returned one HIGH: "plan and requirements were
  unreadable" — every command it ran failed with `bwrap: No permissions to create a new
  namespace` (the devcontainer forbids unprivileged user namespaces; codex 0.151's Linux
  sandbox is bwrap-only). Worse, the pre-release probe seats (173 s PASS, 345 s "Proceed
  as-is") had hit the same failure and **answered anyway** — zero successful commands in
  their rollouts. Fix (0.20.1): `home init` probes the sandbox and enables the landlock
  backend (`use_legacy_landlock`, verified read-only) when bwrap cannot start; `review`
  treats a seat with `commands_ok = 0` as `blind` (exit 2 → Claude fallback), never as a
  verdict. Lesson recorded in `review-backend.md` §Runtime: a well-formed JSON verdict is
  not evidence the seat read the diff — count its commands.
  `--output-schema` was enforced on every run (the API rejected `oneOf` in a schema — use
  `anyOf`; `pattern`, `minimum`, `minLength` were accepted). Codex `tokens_in` sums every
  model call's full context, so a Codex seat's `tokens` is not comparable to a Claude
  seat's `subagent_tokens` — `$ship-report`'s per-backend subtotal is a segmentation aid,
  not a cost comparison, until the accountings are reconciled.
- **Why an isolated `CODEX_HOME`.** `codex exec resume` against the shared `~/.codex` failed
  with `database disk image is malformed` on the thread-history store in the devcontainer
  (cause unverified — the directory is host-mounted). A per-run home under
  `~/.cache/sf-codex/` with a symlinked `auth.json` resumed correctly, keeps the run's
  threads out of the user's interactive session list, and deletes cleanly. It cannot live
  under `/tmp` (codex refuses helper binaries there) or in the worktree (credentials).
- **Why no silent downgrade.** A backend that quietly fell back to Claude for the whole run
  would poison the one measurement this exists for. Per-seat failover is different: it is
  logged (`codex-seat-fallback`), visible in `$ship-report`, and keeps the run moving.

## Parallel seats (0.43.0)

Measured over the last 14 completed ship-task ledgers (2026-09-30 to 2026-10-01, vendored
shipflow 0.42.0), the round-1 review panel was the only step that reliably ran in parallel:
a median of about 24% of seat-busy time had two or more seats running, and all 42
`batch-implement` events were `mode=serial`.

- 0 of 37 decomposed batches were parallelizable. First failed condition: fewer than 3
  independent tasks (17), inline mode (9), seam touched (5), free-text reasons the gate
  did not define (3: "serial by choice: one writer in the shared worktree", "worktree mode
  but one writer per phase worktree", "worktree is outside the monorepo").
- Plans arrived as dependency chains (usually one task without `depends-on`), and the
  orchestrator collapsed steps: one run logged a single task "S1-S8" over 19 files.
- 4 of 14 runs were inline (cloud checkout) and fully serial; one epic had 6 phases in
  one layer with zero implementer overlap. One worktree-mode epic (layer 0 = phases
  3 and 1) had 0 overlapping implementers of 8; two others had 3 overlapping pairs of 8
  and 3 of 9.
- 8 of 11 planned runs spawned the Stage 2 Explores after the drafter returned
  (one run: drafter alone for 11.8 min).
- Last seat → PR took 5–34 min (median about 16).
- Implementer → first reviewer gap was 12.6, 7.0, 3.5 and 3.4 min in four runs.

What changed, and why:

- **The 3b gate fires on real plans.** The threshold is 2 independent tasks (was 3): 17
  batches failed on the count alone. The drafter groups steps into parallel-safe
  work-streams and names a `depends-on` only for a real ordering need, and 3b keeps one
  task per plan step — a collapsed "S1-S8" task can never pass a gate that counts tasks.
  Batches come from `sf-route batches`, and `sf-log` accepts only the gate's four
  conditions or `all four hold` as `parallelizable_reason` (`scripts/sf-parallel-gate.mjs`),
  so a serial batch is countable by cause; a spec test keeps the list in 3b equal to the
  one `sf-log` enforces. Operator decision (2026-10-01): a batch that touches a seam no
  longer goes serial as a whole — the seam tasks of a layer land first as a serial batch,
  then the rest of the layer is gated on its own and fans out when it passes. A batch
  with `seam_touched=true` is still never parallel.
- **Explores start before the draft.** They were keyed on "work areas of the draft", so
  they could not start until the drafter returned; three texts also named three launch
  points (with the drafter, with the reviewer, once the draft exists). The areas are now
  the workspaces of the Stage 1.9 file set (at most 4; one area when the set has no prod
  workspace), which is known before planning. The Explores launch with the Stage 1.8
  repro seat when that seat runs on a file set of more than 2 files, else with the
  drafter; a `not-reproduced` stop keeps their reports for the resumed run. 3c reuses a
  report only for a task whose every file was in that area's seed list, because a report
  says nothing about a file its seat was never pointed at. The drafter
  reads the reports that exist when it finalizes and the plan reviewer reads all of them.
  The brief's source is the task body at the 1.8 launch point, because the requirements
  file is written at Stage 2. `sf-log check` reports `plan_explores_after_drafter` so a
  run that still starts them late is visible in its ledger. The Codex plan reviewer gets
  no path flag: its template line names the `.artifacts` directory beside the requirements
  file, a path both reviewer seats are given.
- **The gates stop blocking the panel and each other.** The round-1 panel launches with
  the smoke type-check (§Implementation), and 3f / 3f.5 run as concurrent jobs (§Gates).
  `sf-log check` reports `intervals` — `last_seat_to_pr_ms` and
  `implementer_to_first_reviewer_ms` — so both gaps are read from each run's ledger. The
  smoke runs once on multi-batch runs (plan review, 2026-10-01): "after the first batch"
  and "with the round-1 panel" name different moments when a run has two or more batches,
  and the panel's moment is the one that removes the wait.
- **Same-layer epic phases fan out, and the ledger counts them.** `SKILL.md` Stage 2.7
  states the fan-out itself — every phase of a layer spawned in one message, stage by
  stage of the per-phase engine, at most 3 phases in flight — because the rule lived only
  in the epic scheduler's step 4, behind a section ship-task ran by reference, and
  one worktree-mode epic ran a two-phase layer with no overlapping implementers.
  The `epic-layer` event carries `in_flight` (the most phases of the layer in flight at
  once) and, at `in_flight=1`, a `serial_reason` from a fixed list (`single-phase`,
  `no-scratch-worktrees`, `force-serial`, `resumed`, `not-fanned-out`), so a serial layer
  is countable by cause the way a serial batch is. `not-fanned-out` is the residual — a
  layer of two or more runnable phases that ran one at a time for no listed cause — so a
  missed fan-out is written as one and counted, not refused or filed under another cause.
  `sf-log` requires `in_flight` only on `mode=integrated` rows: a stack-mode row may omit both fields.
- **Inline (cloud) mode stays serial: the cloud worktree check is unverified
  (2026-10-01).** No cloud session ran `git worktree add`, so inline mode cuts no scratch
  or phase worktree: 3b's first condition fails with `no scratch worktrees`, same-layer
  phases run one at a time (`serial_reason=no-scratch-worktrees`) and layer speculation
  stays off.
  - *The attempt.* The orchestrator spawned an agent with `isolation: remote` to reach a
    cloud session. The harness served it locally — `CLAUDE_CODE_ENTRYPOINT=cli`,
    `CLAUDE_CODE_REMOTE` empty, an OrbStack kernel, an agent worktree under
    `.claude/worktrees/` — so its transcript is a local devcontainer's. A Claude Code Web
    session could be reached from that run only by creating a scheduled cloud routine on
    the operator's account, which the run did not do.
  - *What the local probe showed* (git 2.39.5; not a cloud session). Both commands exited 0:

        $ git worktree add -b sf-wt-probe-a <checkout's parent>/sf-wt-probe-a HEAD
        Preparing worktree (new branch 'sf-wt-probe-a')
        HEAD is now at 72d50a8 Merge pull request #99 from <org>/<branch>
        $ mktemp -d
        /tmp/tmp.k9y4fEj4s0
        $ git worktree add -b sf-wt-probe-b /tmp/tmp.k9y4fEj4s0/sf-wt-probe-b HEAD
        Preparing worktree (new branch 'sf-wt-probe-b')
        HEAD is now at 72d50a8 Merge pull request #99 from <org>/<branch>

    `git worktree list` then showed both, and `git worktree remove --force`,
    `git branch -D` and `git worktree prune` cleaned them up. Committing inside the new
    worktree and cherry-picking back was not tested: the agent's worktree-isolation guard
    refused git commands there.
  - *A cloud session's statement, relayed by the operator* — a statement that the tooling
    is present, not the output of `git worktree add` run there: "Yes. The repo's
    scripts/create-worktree.sh <branch> --no-push is available here, and so is the
    $create-worktree skill. Both set up the linked dependencies that the pre-push
    type-checks need. This cloud container is a bit different from the shared /workspace
    setup. The checkout is already on this session's own branch,
    its session branch, and no other session shares it. So I can work here
    directly, or cut a separate worktree if you want something kept apart from this
    branch."
  - *What a cloud session must still run*, from the cloud checkout, before inline mode may
    cut scratch or phase worktrees (a transcript with `CLAUDE_CODE_REMOTE` set, or a
    non-`cli` entrypoint, in which both `git worktree add` commands print `rc=0`):

        echo "entry=$CLAUDE_CODE_ENTRYPOINT remote=$CLAUDE_CODE_REMOTE"
        TOP=$(git rev-parse --show-toplevel); PARENT=$(dirname "$TOP"); SCRATCH=$(mktemp -d)
        git worktree add -b sf-wt-probe-a "$PARENT/sf-wt-probe-a" HEAD; echo "rc=$?"
        git worktree add -b sf-wt-probe-b "$SCRATCH/sf-wt-probe-b" HEAD; echo "rc=$?"
        git worktree list
        git worktree remove --force "$PARENT/sf-wt-probe-a"; git worktree remove --force "$SCRATCH/sf-wt-probe-b"; git worktree prune
        git branch -D sf-wt-probe-a sf-wt-probe-b; rmdir "$SCRATCH"

    One passing session does not prove every cloud checkout, so a later change that lets
    inline mode fan out also probes per run before it cuts a worktree.

## Audit logging (sf-log)

Across 54 ship-task logs the orchestrator improvised about 120 distinct `stage` names
(`pr`, `pr-open`, `pr-opened`, `pull-request`, `pr-created`; five spellings of AC
verification) and spawn accounting was present in only 29. On one earlier run
7 of 44 spawn events were invalid JSON — exactly the round-1 reviewer batch, the most
expensive phase of the run — because the line was assembled by `printf`. `$ship-report`
repeatedly reported "the marginal yield of round 2 is unmeasurable". `sf-log` validates
the stage name, writes with a JSON serializer, and is one call per event.

## Skill weight

Before 2026-08-31 a ship-task run loaded ship-task (538 lines) and executed the older
issue skill (1,071) and PRD skill (1,391) "verbatim through a substitution table", plus ≈ 1,700 lines
of shared protocol — roughly 5,000 lines carried on every orchestrator turn. The
improvised event names, missing spawn events, and prose-judged classifiers above are what
that indirection looked like in the logs. The single-task path is now inlined once. The
epic path (rare — one `epic-decompose` in 54 runs) states its own phase fan-out, per-phase
engine and integrated-layer gate in `SKILL.md`; decomposition and the layer scheduler's
integration and submit mechanics live beside it in `epic.md`, loaded only on an epic.
