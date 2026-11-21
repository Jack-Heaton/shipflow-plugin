---
name: review-plan
description: Adversarial red-team review of implementation plans. Challenges assumptions, identifies gaps, surfaces risks.
argument-hint: <path-to-plan-file>
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(git log *), Bash(git diff *), Bash(ls *)
---

# Adversarial Plan Review

Review whether the implementation plan meets its requirements and preserves the relevant invariants. Scale investigation to the change's concrete risks.

**An accurate shipping decision is the outcome; a clean review is successful. Report actionable defects with a concrete trigger, consequence, and evidence. Finding count is not a quality target.**

---

## Procedure

### Step 1 — Read the Plan

Read the file at `$ARGUMENTS`.

If the path does not exist or the file is empty, stop immediately and report:

> **Error:** Could not read plan file at `$ARGUMENTS`. Verify the path and try again.

### Step 2 — Gather Codebase Context

For every file, module, component, route, schema, table, endpoint, or system the plan references:

- **Verify existence** using Glob and Grep.
- **Read existing files** to understand current state, interfaces, exports, callers, and consumers.
- **Use the repository's symbol tools** (`node scripts/ts-nav.mjs refs` / `def`, the `/nav` skill) when they exist — callers and consumers the plan omits are the usual miss.
- **Check recent git history** (`git log --oneline -20`) and relevant diffs for files the plan touches.
- **Check agent definitions** in `.claude/` if the plan references agents or skills.
- **Verify external-API claims.** When the plan asserts what a vendor service, cloud API, or library can or cannot do, verify against SDK typings (e.g. `node_modules/<sdk>/dist-types/commands/`), local docs, or the package's actual exports. An unverified vendor claim (marked `UNVERIFIED:` or stated as fact) is itself a finding — do not inherit it, and do not counter it with an unverified claim of your own.

A review without codebase context is worthless. Do not skip this step. Do not rely on assumptions about what files contain — read them.

### Step 3 — Analyze Across 11 Dimensions

You must address **every** dimension below. If a dimension has no issues, explicitly write "No issues identified" for that dimension. Do not silently skip any.

Read `scoring-rubric.md` — it lives alongside this skill (`${CLAUDE_PLUGIN_ROOT}/skills/review-plan/scoring-rubric.md`) — for severity classification definitions.

#### 3.1 — Scope and Requirements Completeness

- Does the plan cover all stated requirements?
- Are there implicit requirements it ignores (auth, permissions, validation, edge cases)?
- Are acceptance criteria specific enough to verify?
- Is every acceptance criterion **bounded** — a structural guard and/or a pinned fixture
  set? A universal criterion (no/any/all/never/always/100%) over a heuristic domain (OCR,
  layout, classification, matching, ranking) with neither is a HIGH: the fix loop cannot
  converge on it (`scoring-rubric.md` §HIGH).
- Check the plan against its `## Premises`. A step that relies on a premise the operator
  struck is a HIGH. Machinery that defends against the violation of a confirmed premise
  (a retry, lock, reconciler or fallback for a case the premise rules out) is a finding
  too: the operator's answer makes it unnecessary (severity: `scoring-rubric.md`).

#### 3.2 — Architectural Soundness

- Does the plan fit the existing architecture, or does it fight it?
- Are the abstractions at the right level?
- Does it introduce new patterns that conflict with established ones?

#### 3.3 — Over-Engineering vs. Under-Engineering

- Is the plan doing too much for what's needed?
- Is it doing too little and deferring critical work as "future improvement"?
- Are there unnecessary abstractions, premature generalizations, or YAGNI violations?
- Realism — product fit and minimal design: is the design sized to the confirmed
  `## Premises` and the repository's real volumes, or to an imagined load? Does
  `## Minimal design` state a size estimate (lines of code, database round-trips per unit
  of work)? Does each mechanism beyond it cite what requires it — a premise, an
  acceptance criterion, or a repository rule? Machinery a confirmed premise rules out is
  §3.1's finding, not a second one here. (Severities: `scoring-rubric.md`.)

#### 3.4 — Security Implications

- Does the plan introduce or modify auth, permissions, or data access?
- Are there injection vectors, exposed secrets, or missing validation?
- Does it handle sensitive data appropriately?

#### 3.5 — Resources, State and Scale

- Check the plan's `## Resources and state` inventory against the diff surface its steps
  describe. A throttled resource the steps touch but the inventory omits is a finding.
- Fan-out (a loop, map, parallel branch or per-item invocation) that hits a throttled
  resource directly, with no queue or shared service between them?
- A FIFO queue without a stated reason (a standard queue with a message group id gives
  fair queuing)?
- Durable state (step results, callbacks, queue bodies) that carries data instead of the
  IDs the next step needs?
- N+1 queries, unbounded loops, missing indexes, or large payloads?
- Does it satisfy the stated load and known service limits, and the repository's
  finite-resource rule where one exists?

#### 3.6 — Error Handling and Failure Modes

- What happens when external services fail?
- What happens on invalid input, partial failures, or timeouts?
- Are there silent failures that will be hard to debug?

#### 3.7 — Testing Strategy

- Does the plan mention how changes will be tested?
- Are there untestable designs (tight coupling, hidden side effects)?
- What test types are appropriate (unit, integration, e2e)?

#### 3.8 — Hidden Dependencies and Coupling

- Does the plan create implicit dependencies between modules?
- Are there circular dependencies, shared mutable state, or ordering assumptions?
- Will changes to this plan's code ripple unexpectedly?

#### 3.9 — Migration and Rollback

- If the plan changes data schemas, APIs, or state shapes — how is migration handled?
- Can this be rolled back if something goes wrong?
- Is there a deployment ordering concern?
- Does the plan introduce a database trigger or stored procedure (`CREATE
  TRIGGER` / `CREATE FUNCTION` / `CREATE PROCEDURE`)? That is a **HIGH finding
  unless the plan documents prior human sign-off** — the orchestrator hard-stops
  on it (`database-trigger` checkpoint). Validation and authorization belong in
  the application layer (zod schemas, authorization checks in the insert/update
  statement itself) or in declarative constraints (FK, composite FK, `UNIQUE`,
  `CHECK`) — a trigger that duplicates application-layer checks doubles the
  maintenance surface and hides logic from the type-checker and tests
  (`packages/db/CLAUDE.md` §"Triggers and stored procedures require human
  sign-off").

#### 3.10 — Maintainability and Readability

- Will a new team member understand this code in 6 months?
- Are naming conventions consistent with the codebase?
- Is the plan creating tech debt it doesn't acknowledge?

#### 3.11 — Implementability (plan hygiene)

The test: **can an implementer follow this plan literally, once, top to
bottom, without reconstructing its review history?** Plans that survive
multiple review rounds accrete — this dimension is the counter-pressure.

- Are consequential decisions about behavior, contracts, integrity, and irreversible
  actions clear? (`plan-prompts.md` §Decisions table.) A missing consequential choice
  is MEDIUM unless the plan as written produces a concrete CRITICAL/HIGH consequence.
  Table formatting, exact diagnostic text, and local test organization are not
  findings; the implementer may decide local mechanics.
- Is any decision stated more than once? Repetition drifts; each decision
  belongs in exactly one place, referenced elsewhere.
- Is provenance ("changed in response to review", "previously we considered…",
  justification-for-the-reviewer prose) mixed into the instruction path? It
  belongs in an appendix or nowhere — never between steps an implementer must
  execute.
- Do any two sections now contradict each other (cross-section drift from
  successive edits)?
- Does the plan carry claims that can't be verified against the codebase? An
  unverifiable claim should be **deleted**, not defended — flag it for
  removal rather than asking for more support.
- Is the plan's length proportionate to the change? A plan that has more than
  doubled since round 1 without new scope is accreting, not improving.

### Step 4 — Produce Structured Output

> Load-bearing for `scripts/sf-codex.mjs` (`skills/shared/review-backend.md`): the Codex
> plan-review seat's JSON is rendered into **this** layout, and the 3.1–3.11 dimension
> numbering above is hard-coded in `schemas/plan-review.schema.json`. Adding or renumbering
> a dimension, or changing this layout, changes both in the same PR.

Format your review exactly as follows:

---

## Plan Review: `<plan file name>`

### Overall Risk: **CRITICAL** | **HIGH** | **MEDIUM** | **LOW**

Use the highest severity finding to determine overall risk.

### Summary

| Severity | Dimension  | Finding              |
| -------- | ---------- | -------------------- |
| CRITICAL | 3.x — Name | One-line description |
| HIGH     | 3.x — Name | One-line description |
| ...      | ...        | ...                  |

### Detailed Findings

For each finding in the summary table, expand with:

**[SEVERITY] 3.x — Dimension Name: Short title**

- **Plan says:** What the plan proposes (quote or paraphrase)
- **Problem:** What's wrong with this
- **Impact:** Why it matters (data loss, broken feature, security hole, rework, etc.)
- **Evidence:** Specific file paths, code references, or codebase patterns that support this finding
- **Recommendation:** Concrete action to fix (not vague advice)

### Dimensions With No Issues

List each dimension that had no findings on a single line:

- 3.x — Dimension Name: No issues identified.

### Open Questions

Bullet list of consequential questions requiring resolution before implementation. Put uncertain concerns here with the check that would resolve them; they are not mandatory fixes without supporting evidence. If none, write "None."

### Verdict

One of:

- **Proceed as-is.** The plan is sound. Findings are LOW severity only.
- **Proceed with modifications.** Address the findings above before or during implementation. No fundamental redesign needed.
- **Stop and redesign.** CRITICAL issues require rethinking the approach before any code is written.

---

## Rules

- Every finding **must** reference a specific part of the plan or a specific file/line in the codebase. No hand-waving.
- **Recommendations are held to the same evidence bar as findings.** A recommendation must cite the specific file/line it would apply to, and you must have verified that code is **live** — actually reached, rendered, or executed — not commented out, feature-flagged off, or marked DISABLED. When you cannot cite live code for the fix, you still owe direction: state the problem, give the most plausible remedy explicitly marked `UNVERIFIED`, and name the exact check that would settle it (the file to open, the command to run). A bare "this is broken" with the remedy left open sends the fixer in blind — its guess becomes next round's findings. A confidently-worded recommendation against dead code costs a full round downstream; so does a veto with no path forward.
- **You are adversarial toward defects, not toward the goal.** The requirement is fixed; your job is to make the plan achieve it. A finding that an approach cannot work must name the nearest approach that can (evidence-cited or marked `UNVERIFIED`) or the specific evidence that would identify one.
- If the plan is genuinely solid, keep the review short. Don't invent problems to look thorough.
- **Actionability over volume.** Findings require evidence and a concrete consequence.
  Optional LOW suggestions are nonblocking; they never independently start a fix or
  re-review round. Uncertain concerns belong in Open Questions with a resolving check,
  not in the mandatory fix list. Stop when the scoped review is complete.
- Don't suggest alternative architectures unless a finding is CRITICAL.
- Don't repeat or summarize the plan back to the author — they wrote it, they know what it says.
- Don't add pleasantries, encouragement, or compliments. This is a technical review, not a performance evaluation.
