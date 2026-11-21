# Reviewer prompt templates (shared reference)

> Canonical copy. Referenced by `ship-task` 3d/3e (and its `epic.md` phases) and the
> split-phase `review-task-code`. Fill the placeholders; do not otherwise modify the
> templates. Plan-loop prompts live in `plan-prompts.md`.

## Artifact handoff (CANONICAL — the delivery contract for every ship-* spawn)

**Never depend on a sub-agent's return text as the delivery channel.** Some
harness paths (teammate / in-process mode, background completion) surface an
idle notification with empty result text — a run that parses verdicts out of
return text silently gets nothing. The artifact is the deliverable; the return
text is at most a status line.

The orchestrator declares an artifact directory once per run, inside the
worktree, and creates it before the first spawn:

```bash
ARTIFACT_DIR="$WT_PATH/docs/plans/task-$TASK_ID.artifacts"
mkdir -p "$ARTIFACT_DIR"
```

Treat it like the audit log: preserved for post-gaming, never deleted mid-run.
**Tracked runs (`ship-task` and the split-phase skills) commit it** on `$BRANCH` —
it is the handoff channel between phases that may run on different machines
(`phase-contract.md`).

Rules:

1. **Every spawn prompt declares an output path** (`{artifact_path}`, e.g.
   `$ARTIFACT_DIR/review-security-r1.md`, `$ARTIFACT_DIR/explore-T2.md`) and
   instructs the agent to write its full report there.
2. **The agent's final message is one line**: role, verdict/summary, artifact
   path. Nothing else.
3. **The orchestrator reads the file, not the return text.** An empty or idle
   return with the artifact present on disk is a **success**. A missing
   artifact after the spawn settles is the failure signal — retry once, then
   treat as a failed spawn.
4. **Downstream spawns get paths, not pasted content** where possible (e.g.
   the implementer is told to read `$ARTIFACT_DIR/explore-*.md`) — cheaper
   than re-serializing reports through the orchestrator's context, and the
   artifact survives a context loss or resume.
5. Record `artifact` on the corresponding `spawn` accounting event (see
   `spawn-accounting.md`) so `/ship-report` can verify delivery.

## Reviewers are read-only — mutation probes are writes (CANONICAL)

Reviewers run **in parallel in a shared worktree**. That is safe only because they
read. The moment a reviewer edits a file — including to prove a finding — the
parallelism becomes a write race.

**Never instruct a reviewer to mutate code.** This covers the tempting cases:
deleting a wrapper to prove a test is tautological, flipping a condition to confirm
a branch is unreached, commenting out a guard to see whether anything fails. A
reviewer that wants such a probe must **describe it** in its artifact — the exact
edit and the expected outcome — and mark the finding `PROBE-SUGGESTED` rather than
running it.

The orchestrator executes suggested probes **after** the parallel review settles,
one at a time, and restores the tree between each. If several probes are worth
running, they are still serial: the cost of a probe is seconds, the cost of a race
is a corrupted diff nobody notices.

> This rule exists because it was violated. A real run instructed its round-2
> reviewers to run mutation probes concurrently in a shared worktree; two raced and one
> observed the other's in-flight edit to a production file. The tree was verified clean
> afterward and the finding was real — but the mechanism was one unlucky interleaving
> away from a silently mangled commit. It was recorded as an `orchestration-note` in
> that run's audit log.

## Models

Per `${CLAUDE_PLUGIN_ROOT}/skills/shared/model-tiering.md` (the single source):
the architecture and performance baselines run **opus** (`general-purpose`, no
effort cap available); `security-reviewer` runs **opus** pinned in its frontmatter;
the holistic reviewer runs opus; routed domain reviewers use their own frontmatter —
don't override. Codex seats (`SHIP_REVIEW_BACKEND=codex`) ignore these Claude tiers and
take model + effort from `scripts/review-tiers.json` (`review-backend.md` §Seat tiers).

## Placeholders

- `<worktree path>` — the working tree the reviewer must operate in.
- `{change_ref}` — what is being reviewed, e.g. `Issue #42: "Add fleet search"` or `PR #17`.
- `{diff_range}` — the exact range reviewers judge, e.g. `$REVIEW_BASELINE..$REVIEW_SHA` (`REVIEW_SHA=$(git rev-parse HEAD)` captured when the panel is spawned) or `origin/$BASE_BRANCH...$REVIEW_SHA`. Use the range that matches **what the PR will actually ship**, not just this run's commits — and end it at a captured commit, never `HEAD`: a seat that outlives the panel reads while the round's fixer writes.
- `{project_context_line}` — one line naming the concrete invariants relevant to this diff, grounded in repository rules and affected paths (for example tenant isolation, record attribution, compliance calculation, audit history, or migration integrity). Omit when none apply; a domain-wide criticality label is not a substitute for a specific risk.
- `{artifact_path}` — the file this reviewer writes its full report to (see §Artifact handoff), e.g. `<worktree path>/docs/plans/issue-42.artifacts/review-security-r1.md`.
- `{prior_artifact_path}` — (re-review after a fix round) the same reviewer's previous-round artifact, so the re-review verifies closure instead of starting cold.
- `{fix_commit_range}` — (re-review after a fix round) the fixer's commits only: `$FIX_BASELINE..$FIX_SHA`, where `FIX_BASELINE=$(git rev-parse HEAD)` was captured immediately before spawning the fixer and `FIX_SHA` once the round's last writer returned (see `warm-closure.md` §Prerequisite). Never `$REVIEW_BASELINE..`, never `..HEAD`, never a value from an earlier round.
- `{findings_table}` — (warm closure only) the reviewer's own fix-now findings: rows are either `<id> — <one-line summary> — claimed fixed by <commit sha(s)>` or `<id> — <one-line summary> — DECLINED: <the fixer's verbatim evidence>`. Declined findings are **not** filtered out of the table — the decline is a claim their author verifies (`warm-closure.md` §1).
- `{accepted_decisions}` — (warm closure only) the semantic decisions the orchestrator **accepted** at adjudication (ship-task 3e step 3.5), one line per decision, so the reviewer treats them as facts of the design rather than arguments. When the round's fixer reported no semantic gaps, the literal `(none — the fixer reported no semantic decisions this round)`.
- `{direction_path}` — (direction review only) the fix direction the reviewer judges, e.g. `$ARTIFACT_DIR/fix-direction-r<N>.md`.
- `{reviewer_artifacts}` — (direction review only) the reviewer artifacts the direction was synthesized from, **one absolute path per line**, so the reviewer can check each item against its sources. When they are unavailable (a resumed or out-of-repo run) pass the single line `(not available — the run's artifacts are not in this repo; review the direction against the code paths it names)`.
- `{merged_items}` — (direction review only) the item ids that cite more than one finding id, as the orchestrator counted them (e.g. `U1 U4 U9`) — the T1 candidates the reviewer starts from.
- `{closure_artifact_path}` — (warm closure only) where the closure table is written. **Always absolute** (`$WT_PATH/$ARTIFACT_DIR/review-security-r2-closure.md`) — a relative path from a wrong cwd writes the artifact where the orchestrator will not find it and silently converts a warm hit into a cold fallback.

## Codex seats read these same templates (`SHIP_REVIEW_BACKEND=codex`)

`scripts/sf-codex.mjs` locates each template below **by its `## ` heading** and takes the
first fenced block under it, so a Codex seat receives the same template text a Claude
seat receives, with the same placeholders filled from the caller's flags, and three
mechanical substitutions (`review-backend.md`): `<worktree contract>` becomes a
read-only working-tree line, `<output contract>` becomes the JSON output contract for
`schemas/review-findings.schema.json`, and in the closure template everything from the
line beginning `Write your closure table to` onward is replaced by the JSON contract for
`schemas/review-closure.schema.json` — likewise the clarification template from its
`Reply with ONE paragraph` line (the seat's final message *is* the artifact; `sf-codex`
renders the `.md`). Only the `reply with exactly NOT-CONTINUABLE …` signalling
clause is dropped for Codex seats (a failed `codex exec resume` is that signal); the rule
that follows it in the same sentence is kept. The §Fixer prompt below is also a Codex
template (`sf-codex fix`, `HYBRID_MODE=codex`): there `<worktree contract + branch
authorizations>` becomes a SOLE-WRITER working-tree line (Stage 0.7's authorizations are
not carried — `review-backend.md` §Hybrid mode), the `<bucket-1 findings …finding>` block
becomes the findings file, and `[fix round <N> …]` gets the round number; those three
placeholders and its heading are shape-locked like the rest. **Renaming a heading or the
`Write your closure table to` line fails `node scripts/sf-codex.mjs templates` (exit 1) —
run it after editing this file.**

## Worktree contract (prepend to every reviewer prompt)

```
First action: run `cd <worktree path> && pwd` and verify pwd matches <worktree path>.
If it does not match, stop and report — do not operate in /workspace.
```

## Output contract (append to every reviewer prompt)

```
IMPORTANT — Output format override: Regardless of your default output format,
you MUST use the following format for this review:

Write your FULL report to {artifact_path} (create parent dirs if needed).
In the report, use ONLY these severity levels: CRITICAL, HIGH, MEDIUM, LOW.
For each finding, include: what the code does, what is wrong, impact, and recommendation.
Require a concrete trigger, consequence, and evidence. A clean review is successful.
Optional LOW suggestions never independently start a fix or re-review round. Uncertain
concerns may be stated as nonblocking questions with a resolving check, not mandatory fixes.
A recommendation is held to the same evidence bar as the finding itself: cite the
exact file:line the recommended change would apply to, and verify that code is live
(actually reached/rendered — not commented out, feature-flagged off, or marked
DISABLED) before recommending a change to it. If you cannot cite live code for a
recommendation, state the problem without prescribing the fix.
End the report with an explicit verdict line in this exact format:
**Verdict: PASS** (if no CRITICAL or HIGH findings exist)
**Verdict: FAIL** (if any CRITICAL or HIGH finding exists)

Be terse. No preamble, no restating the diff back, no praise, no summary of what you
reviewed. Prose budget scales with severity: CRITICAL and HIGH findings get the full
four fields; a MEDIUM gets ONE short paragraph covering all four; LOWs go in a single
table (one row each: file:line | what | why it matters | suggested fix) with no
individual sections — the suggested-fix cell is one clause, held to the same
live-code bar as any recommendation; only budgeted LOW cleanup reaches the fixer.
Areas you checked and found clean get AT MOST one line each — never a narrated
section. Do not quote long code blocks (a `file:line` reference is enough). Omit any
severity level that has no findings. If a finding plausibly belongs to another domain
reviewer on this panel, state it in ONE line naming that domain and move on — do not
develop another reviewer's finding.

Your final message must be EXACTLY ONE LINE (the file is the deliverable):
Verdict: <PASS|FAIL> — <n> CRITICAL / <n> HIGH / <n> MEDIUM / <n> LOW — {artifact_path}
```

## Baseline reviewer 1 — security (`security-reviewer` agent)

```
<worktree contract>

Review the code changes for {change_ref}.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Run `git diff {diff_range}` to see the exact changes.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.
Focus your review on security: authentication, authorization, input validation,
injection vectors, secret handling, and data integrity.

<output contract>
```

## Baseline reviewer 2 — architecture (`general-purpose` sub-agent, model: opus)

```
<worktree contract>

Review the code changes for {change_ref}.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Run `git diff {diff_range}` to see the exact changes.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.
Focus your review on STRUCTURE: module boundaries, dependency direction,
contract/abstraction fit, error-handling strategy, and adherence to codebase
conventions that affect maintainability.

Out of scope for you — do not report: formatting, indentation, whitespace;
index-file maintenance; file-header presence; anything a linter handles. Domain-specific findings
(security, database, per-framework) belong to the routed domain reviewers —
one-line deferral, not a developed finding. Your value is the structural
finding nobody else on the panel is positioned to make; a long list of
duplicated MEDIUMs and style LOWs is this seat failing at opus prices.

<output contract>
```

## Baseline reviewer 3 — performance (`general-purpose` sub-agent, model: opus)

> **Retired as a standalone seat in 0.33.0** — `sf-route` never lists it (nine PASS in ten
> at opus price, no CRITICAL/HIGH). The template stays so `sf-codex templates` and old
> ledgers still resolve the heading; the checklist below is now carried by
> `backend-reviewer` and `database-reviewer`.

```
<worktree contract>

Review the code changes for {change_ref}.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Run `git diff {diff_range}` to see the exact changes.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.
Focus your review EXCLUSIVELY on performance: N+1 queries, unbounded loops,
missing indexes, payload size, cold-start cost for new serverless functions, unnecessary
re-renders, blocking I/O on hot paths, and scalability under 10x load.

Treat only findings with a realistic risk of user-visible slowdown,
outage, or cost spike as CRITICAL/HIGH. Micro-optimizations with no
measurable impact are LOW at most.

<output contract>
```

## Baseline reviewer 4 — failure over time (`general-purpose` sub-agent)

> Seated by `sf-route classify` when the changed prod lines touch concurrency, queues, durable
> steps or retries (`gates.failure_over_time`, `reviewer-routing.md` §Baselines and gates).
> Express runs keep it. Tests pass on one ordering; this seat asks what the next thousand do.

```
<worktree contract>

Review the code changes for {change_ref}.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Run `git diff {diff_range}` to see the exact changes.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.
Focus your review on FAILURE OVER TIME. For each mechanism the change adds or alters (a lock,
a transaction, a queue producer or consumer, a durable step, a callback, a retry or backoff
loop, a lease or heartbeat), play it forward through:
- retries and redelivery of the same message or step;
- duplicate delivery and out-of-order delivery;
- a timeout that fires while the work is still running;
- a crash mid-transaction or between two writes that must agree;
- lease or lock expiry while the holder still acts;
- partial fan-out failure (some branches succeed, some fail, the rest are retried).

A finding must name a concrete interleaving: the actors, the order of their steps, and the
state that results (a lost write, a duplicate side effect, a deadlock, a stuck item, a
double charge). A "this could race" with no interleaving is not a finding. The interleaving
must be one the actual configuration permits: cite the guard you checked (queue type and
delivery semantics, concurrency limit, unique or conditional constraint, idempotency key).
An existing guard that blocks it means no finding. Severity follows
the result: data loss, corruption or a stuck pipeline is CRITICAL/HIGH; a recoverable delay
is MEDIUM at most.

Out of scope for you — do not report: style, structure, and domain findings the routed
reviewers own (one-line deferral at most).

<output contract>
```

## Domain reviewer — Round 1 (routed named agents, per `reviewer-routing.md`)

```
<worktree contract>

Review the code changes for {change_ref}.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Files changed: {list from git diff --name-only over {diff_range}}
If the changed code references files created or modified earlier in this run,
read those files for context: {prior_files_list}
Run `git diff {diff_range}` to see the exact changes.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.
Focus your review on the changes in this diff only.
Apply your full review methodology to analyze the code.

<output contract>
```

## Domain reviewer — Round 2+ (re-review after a fix round)

```
<worktree contract>

This is a RE-REVIEW after a fixer claimed to address issues found in the
previous round. Be skeptical. Fixes are often superficial.

Your previous round's findings are at: {prior_artifact_path}
Read them first. Your job this round, in priority order:
1. Verify each prior CRITICAL/HIGH finding is genuinely closed (not renamed,
   not moved, not superficially patched).
2. Review the fixer's new commits for regressions they introduced.
3. Only then, scan the rest of the diff — do NOT re-derive findings you
   already validated as fixed, and do NOT re-verify unchanged code you
   already cleared last round.

Review the code changes for {change_ref}.
Files changed: {list from git diff --name-only over {diff_range}}
Run `git diff {diff_range}` to see ALL changes (not just the latest fix).
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.

This is round {fix_round} of review. Do NOT lower your standards because
this is a re-review. Apply the same rigor as the first review.

<output contract>
```

## Closure verification — warm continuation (re-review after a fix round, via `SendMessage`)

Sent to the **same reviewer agent** that produced the initial-review findings
(context intact) — at the end of **every** fix round, including the first
(`warm-closure.md` §The protocol). Used by the warm-closure protocol; if the
agent is not continuable, fall back to "Domain reviewer — Round 2+" above.

```
<worktree contract>

A fixer has committed changes claiming to close findings from YOUR review.
Verify each one. You already hold the context that produced these findings —
use it; do not re-review the whole diff. If you NO LONGER hold your original
analysis of this change (context loss, compaction), reply with exactly
NOT-CONTINUABLE and write no artifact — do not attempt verification from the
fix diff alone.

Your findings under verification:
{findings_table}

Accepted design decisions (facts for this verification):
{accepted_decisions}

Run `git diff {fix_commit_range}` to see exactly what the fixer changed.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.

For EACH finding, verdict one of:
- CLOSED — the defect you found is genuinely gone. Cite the file:line of the
  fix that removes it.
- REOPENED — the defect survives (renamed, moved, superficially patched, or
  the fix introduced an equivalent problem). Cite file:line evidence.
- DECLINE-ACCEPTED — (rows marked DECLINED only) the fixer's evidence for not
  fixing your finding is correct. Verify the evidence itself, not its
  plausibility: if the decline cites a tool or library limitation, confirm the
  limitation exists (open the docs/types/code that would prove it); if it
  claims the cited code is dead or already safe, open that code. A decline
  whose evidence does not hold is REOPENED — declining is a claim, and you are
  its verifier.
- NOT-MINE — this finding was not yours / was misattributed. This verdict
  carries the same evidence bar as the others: cite the section of your own
  previous review artifact that shows the finding is not in it. The findings
  list was built from your artifact, so expect this to be rare.

If the evidence cannot establish closure, mark REOPENED and name the missing
check; uncertainty alone is not evidence of a new defect. A fix that relocated
the problem is not CLOSED. Preserve the adjudicated severity. Accept a verified
fix or evidence that refutes your original finding. The accepted design decisions above are facts, not
arguments: a fix that departs from your recommendation to honor one is CLOSED
if the defect is gone, and REOPENED if the decision reintroduces it. Do not
re-open scope with new findings about code you already reviewed; the ONE
exception is a CRITICAL or HIGH defect in the
fix commits themselves — report it under a heading "NEW (fix-introduced)".
Anything below HIGH, leave to the cold regression pass.

Write your closure table to {closure_artifact_path}: one row per finding —
id | CLOSED/REOPENED/DECLINE-ACCEPTED/NOT-MINE | file:line evidence |
one-sentence reason.

Your final message must be EXACTLY ONE LINE:
Closure: <n> CLOSED / <n> REOPENED / <n> DECLINE-ACCEPTED / <n> NOT-MINE — {closure_artifact_path}
```

## Pre-fix clarification — warm continuation (one question per ambiguous finding, via `SendMessage`)

Sent to the reviewer that raised the finding, by recorded `agent_id`, **before** the
fixer runs (`warm-closure.md` §Pre-fix clarification): at most one question per finding
triage marked ambiguous; the answer is appended to the fixer's prompt under that finding.
Codex seats run it through `sf-codex review --template clarify --resume <thread_id>`.

```
<worktree contract>

Before a fixer runs, the orchestrator has ONE clarification question about a
finding from YOUR review. Answer from the analysis you already hold; do not
re-review the diff and do not raise new findings. If the answer changes the
finding's scope or severity, say so explicitly — that is a dispute, which the
orchestrator escalates to a human decision (bucket 2), never resolves with you.

Finding: {finding_id}
Question: {question}

Reply with ONE paragraph. Your final message is that paragraph and nothing else.
```

## Direction review (`sf-direction-reviewer`, before the fixer of a gated round)

A read-only native agent using the `sf-direction-reviewer` role, not a CLI review
template — it runs on a fix direction with ≥ 1 merged item that carries a CRITICAL/HIGH
(`merged_high ≥ 1`), before the fixer, and the orchestrator resolves every BLOCKING
finding by editing the direction first, inside the item's word budget (`ship-task` 3e
step 2b; `warm-closure.md` §0). The agent body carries its Targets and evidence bar;
this task text names its subject.

```
<worktree contract>

You are reviewing a FIX DIRECTION before its fixer runs: the orchestrator's binding
synthesis of this round's review findings into one set of instructions the fixer follows
literally. Your job is to surface the invariant and scoping questions it leaves open, per
your Targets (T1–T5) — an invariant the direction omits is one the fix drops. T5 is the
not-found versus transient-error check: an item that treats a failed read or lookup as
not-found must also state the branch for a transient or unknown error.

Fix direction (your subject — read it whole): {direction_path}

Reviewer artifacts it was synthesized from — read each and check every direction item
against the findings it claims to cover. When a line reads "(not available …)", the run's
artifacts are not in this repo: review the direction against the live code paths it names.
{reviewer_artifacts}

Items that merge more than one finding id, as the orchestrator counted them — start here;
these are your T1 candidates: {merged_items}

Open the live code at every file range the direction names before filing a finding against
it. Every finding is BLOCKING or NOTE (your Output contract): a BLOCKING finding states,
in one sentence the orchestrator can answer by editing the direction, the invariant or
state-model question the item leaves open, and cites the item and either the sources it merges or the code range it contradicts.
A question whose answer needs a design (a new mechanism, a new surface, a guarantee across
more than one boundary) is a NOTE marked `not fixer-shaped`, not a BLOCKING — the
orchestrator routes that item out of the fix round rather than writing the design into the
direction.

Write your full report to {artifact_path}. Your final message is one line:
Direction review: <n> BLOCKING / <n> NOTE — {artifact_path}
```

## Fixer prompt (`sf-fixer`, one spawn per fix round)

```
<worktree contract + branch authorizations>

The following adjudicated findings are in scope and sorted by severity. Resolve
confirmed defects; optional LOW cleanup is limited by scope-policy's shared budget
and may be left as residue. Speculative suggestions are not required fixes:

<bucket-1 findings (CRITICAL → LOW), grouped by file, each with file:line and
the reviewer's recommendation; clarification answers appended under their finding>

=== FIX DIRECTION (binding) ===
<fix direction>
=== END FIX DIRECTION ===

The direction above binds you. Where a finding carries `verify_first` probes, run
them BEFORE editing for that finding and record each probe in your report's
`verify_first` array (finding id, the exact probe you ran, its outcome, and whether
it contradicted the planned approach) — a direction that asked for probes your
report does not carry is treated as unverified work; if a probe's outcome contradicts the planned approach, STOP that finding
and report the contradiction instead of improvising a design. Where the direction
marks something out-of-scope, do not touch it. Reviewer RECOMMENDATIONS remain
hypotheses even when the direction adopts one.

Apply targeted fixes for each finding. Keep each fix scoped to the finding — do
NOT refactor unrelated code or take on work beyond these findings. SCOPE means
the finding's DEFECT CLASS (skills/shared/scope-policy.md): fix same-class
siblings and add a recurrence guard where one is mechanizable; enumerate and
report the class; if the set exceeds ~15 files or crosses a workspace, fix the
named instances and report the rest. Findings marked ADJACENT are bounded fixes
in files this change already rewrote (scope-policy §Touched-file adjacency):
fix them in their own commit tagged `[adjacent <id>]`, no recurrence guard. Do NOT modify files under .claude/ or
CLAUDE.md.

Reviewer RECOMMENDATIONS are hypotheses, not instructions. Before executing
one, open the code it cites and verify it applies — the cited code is live
(reached/rendered, not commented out, feature-flagged off, or DISABLED) and
behaves as the reviewer assumed. If verification fails, fix the underlying
finding your own way or decline it with one line of evidence. Declining a bad
recommendation with evidence is a success, not a skipped item.

Stage changed files and commit locally (nothing is pushed until re-review
passes). If findings span multiple areas, one commit per area, tagged
`[fix round <N> <area>]`. If a pre-commit type-check fails citing stale build
artifacts (`.next/`, missing generated types, "module not found" for files that
exist), clear `.next` / `.turbo` / `.cache` and retry the commit once before
treating it as a real failure.

Verify with named test files or the runner's changed-files mode, never a whole project
or directory run (unbounded here; it ends the seat by timeout).
Never change repo-wide configuration (vitest/tsconfig/eslint bases, package.json
scripts, CI files) inside a fix round — a finding that seems to require it is
reported as a blocker, not fixed by widening a global budget.
```

## Regression pass — cold, fix commits only (re-review after a fix round)

A **fresh** spawn (never a continuation), at the end of every fix round
including the first; roster per `warm-closure.md` §2.

```
<worktree contract>

A fix round just landed commits addressing review findings for {change_ref}.
You have NOT seen this change before. Your job is the fixer's NEW code only.

{project_context_line}
Make an evidence-based shipping decision. A clean review is successful; finding count is not a target.

Run `git diff {fix_commit_range}` — these are the fix commits. Review THIS diff
for defects the fixes introduced: regressions, broken invariants in the edited
code, fixes that half-apply a recommendation, new dead paths, tautological or
weakened tests. Do not re-review code outside this range except to verify an
edited line still holds its callers' assumptions.
The range ends at a commit, not the working tree: when you need a file's full contents, read them at that commit (`git show <end-sha>:<path>`), never from the checkout — a writer may be editing it while you read, and a finding cited against the checkout is unreproducible.

<output contract>
```
