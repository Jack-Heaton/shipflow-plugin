# Scope policy — sweep the class, punt the unrelated (CANONICAL)

Referenced by `ship-task` (and its `epic.md`), `fix-task` and the `sf-implementer` /
`sf-fixer` agents. This file defines what "in scope" means for a fix. It replaces the older
blanket instruction *"do not widen scope; anything else you notice becomes a new issue."*

## Why this exists

The blanket rule is a backlog generator, and it was measurably one. On the repository this
suite was developed against, **59% of all open issues (156 of 266) carried the follow-up label** —
i.e. they were created by this very review process. A single sprint closed 11 issues and filed
21. Four of those 21 were *literally the same defect, one file over*:

| Filed because the phase fixed… | …and left |
|---|---|
| 1 of 2 unsanitized `dangerouslySetInnerHTML` sinks | the other sink |
| 5 of 13 `process.env.X!` sites | 8 sites |
| 2 of 3 mutations carrying a vestigial argument | the third mutation |
| the `roles` login-time snapshot | the `isAdmin` snapshot — same class |

Each was correct under the old rule and wrong for the backlog. Worse, none of them shipped a
guard, so the next audit re-discovers and re-files them. (One finding in that repo was filed in
February, still perfectly accurate in July, and re-filed by a fresh audit.)

The old rule's *rationale* is sound and is preserved below: an unnecessary
change to a correct authorization path creates regression risk. The fix is not to abandon it but
to distinguish **widening into unrelated code** (still forbidden) from **completing the class you
are already in** (now required).

## Rule 0 — re-confirm the premise before you fix

Everything below assumes the defect you were sent for is still there. Often it is not. In the
reference repo, a verification pass over 14 issues found **one already fixed, one duplicated, and
one pointing at deleted code — 21% dead on arrival**. Findings age against a codebase that does
not stop moving, and the older the backlog, the higher that fraction runs.

> **Rule 0.** Re-confirm the finding against the **current integration branch** and cite
> `file:line` before changing anything. A prior verdict — a task body, an audit report, a
> backlog triage verification — is a **binding input, not a substitute** for that
> check. If the defect is already gone, that is a **successful outcome for the phase, not a
> failure**: report it with the evidence and stop. Never manufacture a change to satisfy an
> acceptance criterion whose premise has expired.

Two failure modes this exists to prevent, in order of cost:

- **"Fixing" what is already fixed.** The phase has an acceptance criterion and no defect to
  meet it with, so it edits correct code until the criterion reads as satisfied. On authorization
  or data-integrity paths that creates regression risk without benefit — precisely what the old blanket
  rule was right to fear.
- **Declaring a premise gone when it has only moved.** Absence at the cited path is not proof of
  removal. Check `git log --all` and open *and closed* PRs first. In the reference repo a finding
  whose premise looked deleted was in fact stranded on an unmerged branch whose PR had been
  closed; resolving it on that basis would have discarded a real defect.

When the premise has drifted rather than vanished — the code moved, the symbol was renamed, the
defect narrowed to a subset of the cited sites — fix the defect where it now lives, state the
drift in your report, and apply the class test below to the set you actually find there.

## The test — widen only if ALL THREE hold

A finding is a **same-class sibling** of the one you were sent to fix when:

1. **Same defect class.** Same root cause *and* same fix shape — not merely nearby code. If
   the fix for the sibling is a different kind of change, it is a different class. **The class
   includes every other instance of the gap the task exists to close**, even when the
   mechanism differs: a task that adds a purge listener owns "a path where the purge never
   fires" (a missing bump call in another file is the same gap, not a different subsystem).
   A one-line omission that lives in a file outside the diff is still that gap — it belongs in
   the fix, not filed as a follow-up.
2. **Mechanically enumerable.** You can produce the *complete* instance set with a grep, lint
   query, or type query, and state it. If you cannot enumerate it you cannot bound it, and
   "sweep the class" degenerates into an open-ended hunt.
3. **Same review surface.** The reviewers already assigned to this change can judge the siblings
   with the same expertise and the same evidence standard. Eight environment-variable narrows is
   the same review as five. An environment-variable narrow *plus* a SQL predicate is not.

**All three hold** → fix the whole class in this change. It is bucket 1 (fix now).
**Any one fails** → check the touched-file rule below; if that fails too, file it (bucket 3).

This rule applies to confirmed defects. Optional LOW improvements remain subject to
the cleanup budget below; similarity alone does not make speculative work mandatory.

## Touched-file adjacency — small fixes in a file this change already rewrote

The old "no *while I'm in this file*" rule was written to stop drive-by edits to correct code
in files the change would otherwise not touch. A file **already in this change's diff** is
different: its regression risk is already being paid and already under this panel's review,
and a separate task for a five-line fix in it costs a full planning cycle. Measured across
39 Opus 5-era runs: bucket 3 was 18% of all triaged findings and nine runs filed 5–9
follow-ups each — the "fix one, cut five" pattern — with the excluded findings routinely
sitting in files the PR had rewritten (e.g. an a11y `alt` and a default-art
flash, both in the diff, both filed).

A finding that fails the same-class test is **still bucket 1** when **all** hold:

1. **The file is in the diff** (`git diff --name-only $REVIEW_BASELINE..HEAD`), or it is a
   test file for one that is.
2. **Bounded and mechanical** — roughly ≤ 30 changed lines, no new dependency, no
   schema/contract/auth-path/seam change (`sf-route classify` seam list), no human decision.
3. **Same review surface** — condition 3 above, unchanged: the reviewers already on this
   change can judge it with the same evidence standard.
4. **MEDIUM or higher.** A LOW in a touched file is optional cleanup within the
   run-wide budget below, otherwise residue — never its own round or follow-up task.

Adjacency fixes get their own commit tag (`[adjacent <finding id>]`) so the PR reviewer can
see them apart from the task's own change, and they do **not** trigger the recurrence-guard
requirement (that belongs to class sweeps). "While I'm in this file" remains forbidden for
files **outside** the diff — that is what the unrelated-subsystem rule below is for.

## Two guardrails

### The bound — reviewability is the real constraint

If the enumerated set exceeds **~15 files**, or crosses a **workspace boundary** (a different
package / infrastructure stack / language), do **not** silently expand the change. A 200-file diff nobody
can review is worse than two issues. Surface it as an explicit decision:

- inside an epic (`ship-task` `epic.md`): propose it as its **own phase** in the same epic; or
- in a single-task run: file it as a single **class-sweep task** naming the full
  enumerated set (not one task per instance).

Either way the decision is **recorded, not accidental**. State the enumerated count in your report.

### The recurrence guard — a swept class must not come back

When you sweep a class, the change **must** also add a guard that makes the class
unrepresentable, **if one is mechanizable**:

| Class shape | Guard |
|---|---|
| A banned syntactic pattern (`process.env.X!`, raw `dangerouslySetInnerHTML`) | ESLint rule |
| A value that must come from a shared schema/type | contract test asserting no inline redefinition |
| A field that must appear on every writer | test over the writer set, or a DB constraint |
| A wire-contract argument that must not exist | schema snapshot test |

Without a guard, the class regrows and the next audit re-files it — which is the loop this
policy exists to break. If no guard is mechanizable, **say so explicitly in your report** and
explain why; do not silently skip it.

A guard is part of the acceptance criteria, not a nice-to-have. Prefer
*"this class is empty and cannot recur"* over *"these N issues are closed."*

## Precedence — worktree/phase scope always wins

This policy governs **which defects you fix**. It does **not** override **which files you may
write**. Those are different constraints and the file constraint is absolute:

- If you are the **sole writer of a scoped worktree** (epic mode: parallel phases with
  deliberately disjoint `scope:` lists), and completing a class would require editing a file
  outside your phase's scope, **STOP and report a scope violation. Do not edit it.** Concurrent
  phases integrate by cherry-pick; a cross-phase edit produces a conflict that discards work.
- Report the sibling instances you found and the enumeration that proves the set. The
  orchestrator decides: assign them to the phase that owns those files, add a `depends-on` edge,
  or file a class-sweep task.
- In **single-task mode** there is no competing writer, so the class test governs on its own.

The practical rule: **sweep the class inside your scope; report the rest, never reach for it.**

## What is still out of scope — unchanged

File it, do not fix it, when the finding is:

- in an **unrelated subsystem** (different domain, different layer, no shared root cause) —
  and in a file **outside** the diff; a bounded defect in a touched file is the adjacency rule;
- a **pre-existing defect** you happened to notice, unrelated to the class you were sent for,
  in a file the change does **not** touch;
- a **larger refactor** than this change should carry (an architectural change, a migration, a
  contract redesign);
- **anything requiring a human decision** — a business rule, an irreversible operation, a
  trade-off. That is bucket 2, and CRITICAL/HIGH instances stop the run.

And the standing prohibition holds absolutely: **do not touch `.claude/` or `CLAUDE.md`**, and do
not "fix" a production dependency by removing it.

## Reporting requirement

Whenever this policy causes you to widen, your report must state:

1. **The class**, in one sentence.
2. **The enumeration command** you ran and its complete result (`N` instances across `M` files).
3. **What you fixed** vs. what you deliberately left, and why.
4. **The recurrence guard** you added — or an explicit statement that none is mechanizable, with
   the reason.

Whenever you decline to widen, state which of the three conditions failed **and** which
touched-file condition failed. "It felt out of scope" is not a reason; naming the failing
condition is. "Pre-existing" and "different file" are not conditions — a pre-existing defect
in a file this change rewrote is exactly what the touched-file rule admits.

## Worked examples

**Widen.** Sent to remove `process.env.X!` from five named auth files. `rg 'process\.env\.[A-Za-z_]+!' src` returns 13 sites across 13 files. Same class ✓, enumerable ✓, same reviewer ✓, under the bound ✓ → fix all 13 and add the ESLint rule. *Result: the class is closed permanently instead of leaving 8 sites and a follow-up issue.*

**Widen, but hit the bound.** Same as above, but the sweep returns 140 files across four
workspaces. Conditions 1 and 2 hold; the bound does not. → Fix the named five, and file **one**
class-sweep issue enumerating the other 135 with the ESLint rule as its acceptance criterion.
Not 135 issues, and not a silent 140-file diff.

**Do not widen.** Sent to sanitize a `ts_headline` search snippet. You notice an LLM-generated
field rendered through `dangerouslySetInnerHTML` elsewhere. Same *class* ✓ and enumerable ✓ — but
the second sink's content comes from a model, so its threat model, its allowlist, and its
verification differ: **condition 3 fails**, and its fix shape differs, so condition 1 is shaky
too. → File it, naming condition 3, and reference the sanitizer you just built as the pattern.

**Widen (touched file).** Sent to add a purge listener to an image-cache hook. The UX
reviewer finds the default-image `alt` text in `ProductImage.tsx` fails WCAG — a different
class, but the file is in the diff (the call site changed), the fix is three lines, the same
panel judges it, and it is MEDIUM. → Fix it here, tagged `[adjacent ux-M2]`. *Result: one PR
instead of a PR plus a task whose whole planning cycle is a three-line edit.*

**Do not widen.** Sent to org-scope a SQL anti-join. You notice an unrelated unguarded JSON cast
in the same file that crashes one tenant's page. Different root cause, different fix shape:
**condition 1 fails.** → File it with the evidence. Being in the same file is not a class.

## The filing floor, the mop-up round, and the generation cap (CANONICAL)

> Referenced by `ship-task` §Follow-up tasks / 3e / 3f.6 / 3g (and its
> `epic.md` phases). These seven rules bound follow-up-task growth; without
> them it is geometric.

**Why volume never converges on its own.** Measured on one real run's
audit log: the fix loop closed **98** findings inline
across two rounds, then the *final* re-review surfaced **47 more** (19 MEDIUM +
28 LOW) and the PASS-break filed all 47 as eight follow-ups — each of which will
end its own run with a final-round pile of its own. Raw finding counts ran
64 → 40 → 47 across rounds: only *severity* converges; volume is set by
reviewer capability, not by the code running out of flaws, and it rises with
every model generation. Termination and filing must therefore be bounded by
**rule**, not by waiting for reviewers to run dry.

**Rule 1 — the mop-up round.** After the loop settles on PASS and *before*
filing anything: run at most **one** fixer pass when confirmed, mechanically-resolvable
in-scope MEDIUM findings remain. LOW findings alone never start a writer or review
round. Optional LOW cleanup may accompany an already-needed writer pass, with a
run-wide budget of **three findings and 30 changed lines total**, no new dependency,
contract, auth, schema, or human decision; excess becomes residue. Skip the mop-up
when there is no eligible MEDIUM work. Findings arrive with
`file:line` + recommendation. The mop-up is
verified by the **scoped type-check plus `npx vitest run --changed`** — not by
closure exchanges or a cold pass (the mop-up never reopens the PASS verdict, so
paying a review round to confirm drainage buys nothing).
The PASS verdict is **not** reopened — this is drainage, not review; the gate
already closed on CRITICAL/HIGH. A mop-up fix that breaks the type gate or a
test is reverted, and its finding goes to the filing floor — **one generation,
then stop**; there is never a second mop-up. Scope discipline is unchanged: a
finding failing this policy's three conditions (unrelated subsystem, different
class, oversize sweep) is *not* mopped up regardless of how small it is.

**Rule 2 — the filing floor.** A follow-up issue is cut only for a finding
that is (**MEDIUM or higher** AND affects correctness or a user-facing
behavior) OR names a **recurrence-guard / class-sweep opportunity**.
Everything below the floor is **residue**: listed in the PR body under
`## Review residue (not filed)` (one line each: `file:line — what`) and
counted in the audit log. Residue stays discoverable in the PR and the
review artifacts; it stops being backlog rows that each cost a planning
cycle and mint successors. Stated honestly: some real-but-minor findings
die here. That is the intended trade — the alternative was never "fixed
later," it was "one `$ship-task` run each, which files five more."

**Rule 3 — the generation cap.** A run whose task carries the `followup` or
`followup-bundle` label files new follow-ups
**only** at HIGH+ severity or for a recurrence-guard class. Everything else it
surfaces is mopped up or recorded as residue. The depth signal is the label —
one condition at filing time — and it makes a quibble-fixing run structurally
unable to spawn five more quibble tasks.

**Rule 4 — file at triage, into the run's bundle (0.24.0).** A
finding that clears the floor is filed in the triage that bucketed it, as a
sub-issue of the run's **cleanup bundle** (`ship-task` §Follow-up tasks), with an
`## Origin` section naming the run, phase, round, reviewer, finding id and
review artifact. Holding follow-ups to 3f.6 loses their provenance and serializes
the PR tail. The bundle is shipped by `ship-task`'s bundle path — no plan
loop, one PR — so a follow-up's cost is one review round, not a planning cycle.

**Rule 5 — the goal-post rule (quality counterexamples are follow-ups).** An
acceptance criterion is bounded by its **structural guard** and its **pinned
fixture set** (`ship-task` Stage 2 §Bound the acceptance criteria); the rule
applies only to a criterion carrying `guard:` / `fixture:` — a run that skipped
Stage 2, or a criterion the operator marked `goal-post: exempt`, has no pinned
set and triages normally. A reviewer finding whose only evidence is a **new
counterexample** to a bounded criterion — an input the requirements never named
(another page layout, another document type, another phrase pattern) — is
**bucket 3 at its stated severity**, filed with `goal-post: yes` in its Origin,
**only when the counterexample shows a quality shortfall: a correct-but-worse
output** (a quote not highlighted, a badge missing, a lower-ranked match) on an input
the run never measured; worse-than-base on a measured input is Rule 5a. A
counterexample demonstrating a **crash, data loss, wrong data attributed to the
wrong source, or an authorization / tenancy miss is bucket 1 at its severity
regardless of the fixture set** — the goal post never moves for a defect. It is
also bucket 1 when it breaks a pinned fixture or the structural guard. A
CRITICAL or HIGH goal-post finding earns one bucket-2 question (widen the set?)
before it is filed. Universal criteria over document-layout and classification
heuristics ("no citation on any result", "never a different block's") make a
phase run round after round chasing counterexamples; a mechanical criterion
(a boundary invariant with a contract test) converges in one round.
Reviewers can always produce one more input; a
criterion with no finite verification set has no finish line.

**Rule 5a — caused or worsened here is in scope.** Before any finding goes to bucket 3,
ask: did this change cause it, or make it more likely? Two shapes are always **bucket 1**,
never filed, regardless of file, domain, or the goal-post rule:

- **Regression against the base.** The change's own output is worse than the base
  branch's on an input the run already measured (a fixture, a phase-evidence page, an
  eval row) — fewer sections, a lost highlight, a lower rank. That is not a new
  counterexample; it is this change's defect.
- **Pre-existing, made more likely.** A latent defect the change turns from rare into
  likely or certain (a race the new path or a new flag difference widens). The trigger
  ships with this change, so the fix does too.

Only a defect the change neither introduced nor made more likely may be filed.

**Rule 6 — work, not validation.** A follow-up task or issue is filed only
for work an agent or developer can pick up and finish: a defect, a missing
guard, a named code change. A check the operator owes — a live dev run, an
in-app look at a route — is not work for the backlog: it is recorded in the
PR body (`## Live dev run`, `## Deferred visual checks`) and asked once in the
post-PR question (`ship-task` 3g), never filed. A finding whose only content
is "confirm with the operator" is a question, not a follow-up. A **failed**
live run or failed in-app check is a defect, and is filed as a `bug` subtask
(`ship-task` 3g; the `fix-task` body shape). Validation-only tasks are rarely
picked up: they accumulate as abandoned follow-ups and hide the ones that
name work.

**Rule 7 — nothing parks.** A filed follow-up is shipped now or blocked by name; it
never waits in `to do` for someone to notice it. Two outcomes only:

- **Ship it immediately.** Once the run's own PR is verified, the cleanup bundle starts as
  its own `$ship-task <bundle id>` run (`ship-task` §Ship the bundle) in a fresh worktree.
  A finding related to the task — Rule 0's premise, the class test or touched-file
  adjacency — is never filed at all: it is fixed in this change.
- **Block it on a named blocker.** An item that cannot ship now is set to `blocked`, never
  left `to do`, with a `## Blocker` section naming one concrete thing: an operator ruling
  (asked in the same turn via the available structured user-input tool), an operator-declared cleanup release (for
  example, dropping a data-bearing schema object), or an external party. "Low priority",
  "big", and "not now" are not blockers. When the blocker clears, the item ships the same way.

A follow-up is reported as shipped only when its PR is verified on the remote, never
because it was filed or started.

**Audit:** after the mop-up, append one event:
```json
sf-log stage mopup fixed=N residue=N filed=N generation_capped=N
```
(`filed` = issues that cleared the floor; `generation_capped` = findings a
non-capped run would have filed but the cap held back — the number that
measures whether the cap is doing work.) Each triage-time filing batch logs
`followup-tasks created='[…]' bundle=<id> round=<n>`; the bundle's creation
logs `followup-bundle bundle=<id>`.
