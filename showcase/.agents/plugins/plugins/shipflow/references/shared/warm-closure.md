# Warm-closure re-review protocol (shared reference)

> Canonical spec for the **re-review that ends every fix round** of the implementation
> review loop. Referenced by `ship-task` 3e (and its `epic.md` phases) and
> `review-task-code`. **Round numbering here is the *fix* round** — the protocol runs at the end
> of every fix round, including the first; the initial review (before any fixer has
> run) is always a full parallel panel of cold reviewers and is not governed by this
> file. The protocol replaces the cold re-spawn with two cheaper, better-targeted
> instruments and degrades to the old behavior whenever its mechanism is unavailable.

## Why

A re-review does two different jobs that the cold re-spawn bundled:

1. **Closure verification** — did the fixer genuinely close finding N, or rename it?
   Best judged by the finding's *author*, who already holds the traced call sites and
   reasoning that produced it. Re-spawning that reviewer cold re-pays its entire context
   acquisition to answer a question it could answer warm in a fraction of the tokens.
2. **Regression detection** — did the fixer's *new* code introduce a defect? Best judged
   by *fresh eyes* over the fix commits. Measured on `#2283`: a full six-reviewer cold
   round 2 cost **708K tokens (28% of the run)** to re-confirm a unanimous PASS; its one
   genuine catch (a tautological assertion) was in the **fixer's own commits**.

What this protocol deliberately does **not** do is put the fixer and reviewers in an
open dialogue: two agents in conversation drift toward agreement, and the pipeline's
highest-value catches (e.g. the silent-obligation-drop finding on `#2374`) came from
independently formed positions. Warmth is used only to *verify closure*, never to
negotiate findings.

## The protocol (per fix round, after the fixer's commits land)

**Prerequisite — capture the fix baseline and the fix commit.** Immediately before
spawning the fixer, `FIX_BASELINE=$(git rev-parse HEAD)`; once the round's last writer
(the fixer, or its addendum) has returned, `FIX_SHA=$(git rev-parse HEAD)`. Every
`{fix_commit_range}` below and in `reviewer-prompts.md` means `$FIX_BASELINE..$FIX_SHA` —
never `$REVIEW_BASELINE..`, which turns the cheap regression pass back into a full
re-read; never `..HEAD`, which a later writer moves under a reviewer still reading; never
a stale value.

**Late seats and the addendum fixer (Codex-backend runs only — `HYBRID_MODE` ≠ `off`).**
The fixer launches when the panel's Codex summary lands; a pinned Claude seat still
running does **not** hold it. Its findings are triaged when they arrive and, if any
are bucket 1, go to a second fixer spawn in the **same round** (`sf-log spawn … round=N
addendum=true`, its own fix direction when gated), started only after the first fixer has
returned — one writer at a time. On a Claude-backend run every seat is read together.
`$FIX_BASELINE` is captured once, before the first fixer, so both writers' commits sit in
one `{fix_commit_range}`; the round's closure exchanges (§1) and cold pass (§2) run once,
after the addendum lands. A late seat with no bucket-1 findings is closed like any
uncontacted reviewer: its verdict carries forward. When adjudication also redirects a
decision, the redirect addendum runs after this late-seat addendum — one writer at a time,
and no addendum spawns a further addendum (the per-round writer invariant is stated once in
`ship-task` 3e step 3.5).

## 0. Direction review (before the fixer)

Before a gated fixer runs, a read-only `sf-direction-reviewer` red-teams the fix direction
when it merges findings **that include a CRITICAL/HIGH** — the trigger is **≥ 1 direction
item citing more than one finding id, at least one of them CRITICAL/HIGH**. A direction that
merges only MEDIUM/LOW findings skips the review (the fixer's closures and the gates are its
check). Measured before 0.33.0: the reviewer ran on every gated round at 115–140k tokens and
returned 2–6 BLOCKING items per round; the orchestrator answered them by adding design to the
direction, which is where fix rounds grew scope (one task +8 steps / 7 files,
another's phase 2 +16 steps / 30 files). The orchestrator resolves every BLOCKING finding
by editing the direction into the item's own text **before** spawning the fixer, within the
direction budget (`ship-task` 3e step 2: a BLOCKING answer that needs more than the item's
budget is a plan amendment or a follow-up, never a longer direction); it never re-splits the
item back into the reviewers' original recommendations. The gate is one review and one
revision — no second review round — and the fixer's closures are the check on the revised
direction. The procedure and its ledger events (`spawn role=direction-reviewer`, `note
event=direction-revised`, `note event=direction-review-skipped`) are in `ship-task` 3e step
2b; `sf-log check`'s `fixers_without_direction_review` catches a gated fixer that ran on an
unreviewed direction (a `merged_items=0` row, or a `merged_high=0` row from 0.33.0 on, is
ungated and never flagged).

### 1. Warm closure verification — one exchange per reviewer that holds a defect or a decline

Contact a reviewer only when it has something a closure can change: its round verdict was
**FAIL** (it raised a CRITICAL/HIGH in the fix-now bucket), **or** the fixer **declined** one
of its findings (a decline is a claim only its author can verify), **or** one of its findings
was **reopened** in an earlier round. A reviewer whose round-1 verdict was PASS and whose
MEDIUM/LOW findings the fixer applied is **not contacted**: the fixer's named tests and the
gates verify a mechanical MEDIUM/LOW fix, and its verdict carries forward as PASS. Measured
before 0.33.0: one run ran 17 closure exchanges at 150–230k tokens each (about 3.1M
tokens); 16 returned `reopened_ids: []`, and across ten ledgers only one exchange ever
reopened anything — two LOWs.

For each reviewer that qualifies, send **the same agent** the "Closure verification (warm)"
template (`reviewer-prompts.md`): the fix commit range, its findings the fixer claims closed
**or declined** (declined rows carry the fixer's verbatim evidence), and an **absolute**
closure artifact path (`$ARTIFACT_DIR/review-<role>-r<N>-closure.md`).

**Closure verifies against the stated design.** When the fixer had to settle a design
question the direction left open, the orchestrator's accepted decisions travel to the
reviewer in the same template as facts (the `## Accepted` lines) — so a fix that departs
from a reviewer's recommendation to honor an accepted decision reads as CLOSED when the
defect is gone, not as a fresh disagreement. The adjudication that produces those
decisions (accept vs redirect, the redirect-addendum fixer, the `adjudication` event) is
`ship-task` 3e step 3.5; `sf-log check`'s `closures_without_adjudication` catches a closure
that ran while the round still had unadjudicated or unredirected semantic gaps.

**Declines are claims, and the finding's author is their verifier.** An accepted decline
that nobody verified is a silently dropped finding (an orchestrator-accepted decline can
cite a limitation that does not exist). The author
verdicts `DECLINE-ACCEPTED` (evidence confirmed — the template requires confirming the
evidence itself) or `REOPENED`. The orchestrator never accepts a decline on its own.

**Addressing (load-bearing).** Address the exchange by the raw `agent_id` recorded on
the reviewer's `spawn` event — **never by agent-type name**. `SendMessage` name
resolution is latest-wins: after this protocol's own cold pass has spawned (say)
`security-reviewer`, the *name* resolves to that regression agent, which never authored
the findings and will confidently mark them CLOSED. Baseline reviewers are nameless
`general-purpose` spawns and have no name to use anyway. **No recorded `agent_id` → cold
fallback (§4).**

Rules: **one exchange** (a dispute is escalated, not talked out); the artifact contract
holds (verdict table in the file, one-line return; missing artifact after one retry or a
`NOT-CONTINUABLE` reply → cold fallback); skeptical defaults are in the template
(uncertain → `REOPENED`; a fix that moved the problem is not closed; no severity
re-litigation); the one thing a warm reviewer may add is a **CRITICAL/HIGH defect in
the fix commits** under a `NEW (fix-introduced)` heading. Reviewers that do not qualify
above are not contacted; their verdict carries forward.

### 2. Cold regression pass — fresh eyes on the fix commits

Compute the roster, never judge it:

```bash
node "../../scripts/sf-route.mjs" cold-roster --cwd "$WT_PATH" \
  --diff "$FIX_BASELINE..$FIX_SHA" [--had-high]      # --had-high when bucket 1 held a CRITICAL/HIGH
```

| `mode` | Cold roster | Template + range |
|---|---|---|
| `warm+cold-panel` — a fix commit touched a seam (the script's canonical seam list: auth, shared-contract, barrel, api-contract, config, package, lockfile, migration) **and** the bucket held a CRITICAL/HIGH (`--had-high`) | **Full initial-review panel**, cold | The round-1 templates over the **full `$REVIEW_BASELINE..HEAD` range** — identical to the old full re-review. Not the regression template: its fix-commits-only scope contradicts a full-range read. |
| `warm` — otherwise (a seam touched by a MEDIUM/LOW-only round adds the contract seat to the roster instead of the full panel) | the returned `roster` (routing rows matched by the fix files, dual-route and cross-domain applied, capped at 3; `security-reviewer` added on `--had-high`; `security-reviewer` alone when no row matches) | "Regression pass (cold)" template over `{fix_commit_range}` |

**The floor is zero when there is nothing to read.** When the script reports
`skippable=true` (no seam, no test-class file in the fix commits, no CRITICAL/HIGH in the
bucket) **and** every closure came back `CLOSED` or `DECLINE-ACCEPTED`, spawn no cold
reviewer this round: log `rereview_mode=warm` with `rereview_reviewers=[]`. Any
`REOPENED`, any `NEW (fix-introduced)`, or any test file in the fix diff (the `#2283`
tautology case) keeps the pass. Spawns are always **new** reviewers, never continuations.

### 3. Round verdict

The round is **clean** when every fix-now finding is `CLOSED` or `DECLINE-ACCEPTED` in a
closure artifact (an unclaimed `NOT-MINE` counts as `REOPENED`) and the cold pass plus
any `NEW (fix-introduced)` heading report no CRITICAL/HIGH.

Derive `reviewer_verdicts` for the triage event: a reviewer whose findings all closed is
`PASS` whether or not the cold pass covered its domain; an uncontacted reviewer carries
its prior verdict; a reviewer with a `REOPENED` finding is `FAIL`.

`REOPENED` findings join the next round's fix-now bucket and take the **ordinary path** —
a fresh fixer attempt, then closure by the same author. There is no pre-commit pairing
sub-protocol.

On an item id's **second** `REOPENED` verdict the loop has oscillated: the orchestrator logs
`sf-log stage oscillation-stop finding=<id> round=N severity=<sev> action=<…>`, and the id
never re-enters a fixer round under standing authorization. The disposition is by severity:

- **CRITICAL/HIGH**: the orchestrator writes `$ARTIFACT_DIR/design-note-<id>.md` — the
  invariant, the state model, the two designs the rounds oscillated between and which one
  holds, in ≤ 20 lines — and logs the stop with `design_note=<path> action=design-note`,
  after which the id joins the next round's bucket 1 **once**. A finding reopened after its
  design-note round is `action=checkpoint` (`CHECKPOINT_REQUIRED: ambiguous-fix-required`,
  existing reason) or bucket 3 by severity — never a second design note. When the note itself
  needs an operator decision, log `action=checkpoint` and raise the same checkpoint.
- **MEDIUM/LOW**: `action=bucket-3`, filed as a follow-up task.

So the id can re-enter the fixer at most once, and only behind a design note. Every fixer
spawn in a round that follows any `oscillation-stop` carries `findings='[<item ids in its
bucket>]'`, and every `closure-exchange` carries `reopened_ids='[…]'` (the orchestrator fills
it as `item ?? id` from its own closure table — REOPENED rows and unverdicted rows — as
distinct item ids, so two seats merged into one item list it once) so `sf-log check` can see
a missed stop. At loop exhaustion the skill's own exit
(`unresolved-review-findings`, draft PR) governs.

### 4. Cold fallback — the protocol must degrade to the old behavior

Use the cold "Domain reviewer — Round 2+" template with `{prior_artifact_path}` for any
reviewer where warm continuation is unavailable: no `agent_id` recorded, no
`SendMessage` tool, the agent unreachable (**resumed run**, teammate / in-process spawn
path), a `NOT-CONTINUABLE` reply, or no closure artifact after one retry. Never block
the loop on continuation mechanics — a run where every exchange falls back is a
pre-protocol run: correct, just not cheaper. Record the path per exchange so
`$ship-report` can measure the warm-hit rate.

## Pre-fix clarification (optional, orchestrator-mediated)

Before spawning the fixer, the orchestrator MAY send each initial-review reviewer **at
most one** clarification question per finding that triage marked ambiguous, by recorded
`agent_id`. The answer is appended to the fixer's prompt under that finding. The fixer
never messages reviewers; leaves do not message leaves. If the answer changes a
finding's scope or severity, that is a dispute → bucket 2.

## Audit events

One `closure-exchange` event per warm exchange and one `clarify` per clarification,
via `sf-log` (`spawn-accounting.md` §Continuations):

```
sf-log stage closure-exchange role=reviewer:<role>:closure round=N path=<warm|cold-fallback> \
  findings_closed=N findings_reopened=N findings_decline_accepted=N findings_not_mine=N \
  reopened_ids='[<item ids reopened this round>]' agent_id=<id> artifact=<closure artifact> tokens=<n|omit> started=<epoch ms>
sf-log stage clarify role=reviewer:<role>:clarify round=N finding=<id> answered=true agent_id=<id> tokens=… started=…
sf-log stage adjudication round=N gaps=<n> accepted=<n> redirected=<n> artifact=<adjudication file>
sf-log stage oscillation-stop finding=<item id> round=N severity=<CRITICAL|HIGH|MEDIUM|LOW> \
  action=<design-note|checkpoint|bucket-3> design_note=<path when action=design-note>
```

`agent_id` is the continued agent's id (the cold-fallback spawn's own id on that path); a
Claude row with `tokens=`/`duration_ms=` is refused without it, because `sf-log` stores the
turn's usage as the delta against that agent's earlier rows (`spawn-accounting.md`
§Continuations).

The `adjudication` event is written before the round's closure whenever the fixer reported
semantic gaps (`ship-task` 3e step 3.5); a round with zero semantic gaps writes none. The
`oscillation-stop` event is written on an item id's second `REOPENED` (§3); `reopened_ids`
is `item ?? id` for every reopened finding (Codex closure seats write it; the Claude
orchestrator fills it from its closure table), so a stop that was skipped is visible in the
ledger.

**Triage-event emission point.** The round's `triage` event is appended **after the
closure exchanges settle and before the cold pass runs**, with `rereview_mode` set by
the cold-roster branch alone (`warm` or `warm+cold-panel`; `cold-fallback` only when the
orchestrator knew up front that no warm exchange was possible, e.g. a resumed run).
Per-exchange fallback is recorded on `closure-exchange.path`, not here.

## Boundaries (unchanged invariants)

- **Reviewers stay read-only**; mutation probes remain `PROBE-SUGGESTED`,
  orchestrator-executed, serial (`reviewer-prompts.md`).
- **The fixer stays the sole writer** in the worktree.
- **Reviewer disagreements escalate to the user** — never resolved agent-to-agent.
- The initial review is always a cold, parallel, blind panel.

## Measurement note

A warm round is not comparable to a cold round token-for-token, so `fix_rounds` counts do
not compare across the two. The number that must not regress: findings that surface
**after** merge.
