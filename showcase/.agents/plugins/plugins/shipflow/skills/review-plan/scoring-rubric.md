# Severity Scoring Rubric

Use these definitions when classifying findings in a plan review.

**The severity test (0.33.0).** Ask: *if the plan were implemented exactly as written,
what happens?* CRITICAL/HIGH require a concrete answer of the form "wrong behaviour ships"
or "data is lost" with the step and the input named. A plan that is *silent* on something
— an unfilled decision, a missing edge case, an unverified claim about the code — is
MEDIUM: the implementer, the code reviewers and the gates all still stand between it and
production. Measured before this rule: round-1 plan reviews of 3–9 file fixes carried 2
CRITICAL + 9 HIGH, 5 HIGH, and 5 HIGH, and every HIGH forced a 190–270k-token warm fix
round; the plans were incomplete, not wrong. A plan with 0 CRITICAL / 0 HIGH proceeds
with its MEDIUM/LOW findings appended as review notes for the implementer.

> Load-bearing for `scripts/sf-codex.mjs` (`../../references/shared/review-backend.md`): the
> severity set here is the enum in `schemas/plan-review.schema.json`, and the verdict rule
> (CRITICAL → "Stop and redesign"; LOW-only → "Proceed as-is") is enforced by the Codex
> seat's renderer. Change both in the same PR.

## CRITICAL

**Definition:** Will fail in production, cause data loss, introduce a security vulnerability, or break existing features. Must be resolved before implementation begins.

**Examples:**

- Missing authentication or authorization on a public-facing endpoint
- Database migration with no rollback path
- Race condition that can cause data corruption
- Deleting or overwriting data without backup or confirmation
- Exposing secrets, tokens, or PII in logs or responses

## HIGH

**Definition:** A step that, implemented as written, produces a bug, a performance regression a user notices, or rework of shipped code — the failing input and the step are nameable. Should be addressed before implementing the affected section. An omission that the `## Decisions` table should have answered is MEDIUM, not HIGH, unless the plan commits to a *wrong* answer.

**Examples:**

- A step that writes a producer's new field while the strict validator it feeds rejects unknown keys (the plan names no shared schema)
- Missing error handling on external API calls
- N+1 query patterns on lists that will grow
- No input validation on user-supplied data
- Implicit ordering dependency between migration steps
- Missing cache invalidation when underlying data changes
- An acceptance criterion that is universal ("no X on any Y", "never", "always", "all", "100%") over a heuristic domain (OCR, layout, classification, matching, ranking) with no structural guard and no pinned fixture set — the fix loop has no finish line for it
- A step that relies on a premise the operator struck (`## Premises`, `status: struck`)
- A fan-out that hits a throttled resource (database locks or connections, an LLM, OCR or search service, function concurrency) directly, with no queue or shared service in between
- A durable state payload (step results, callbacks, queue bodies) that carries data growing with input size instead of IDs
- Machinery (a retry, lock, reconciler, fallback) that defends a scenario a confirmed premise, or the operator's ruling on a struck one, rules out

## MEDIUM

**Definition:** Weakness that will cause friction, confusion, or accumulating tech debt. Can proceed with implementation but the plan should be revised to acknowledge or address the issue.

**Examples:**

- An unresolved consequential decision about behavior, contracts, integrity, or an irreversible operation (not missing table formatting or local implementation mechanics)
- A claim about the code the reviewer could not verify (cite it; the drafter deletes or proves it)
- Inconsistent naming conventions vs. existing codebase
- Over-abstraction for a single use case
- Undocumented implicit dependencies between modules
- Missing consideration of an edge case that isn't immediately critical
- Tightly coupled design that makes future changes harder
- A FIFO queue without a stated reason
- A durable state payload that carries data of bounded size instead of IDs
- A mechanism beyond the minimal design that cites no premise (`(P<n>)`), acceptance criterion, or repository rule, and defends no scenario a premise rules out

## LOW

**Definition:** Nitpick, style concern, or minor omission. Does not affect correctness or reliability. Note it and move on.

**Examples:**

- Vague acceptance criteria that could be more specific
- Missing mention of logging or observability
- Missed opportunity to reuse an existing utility
- Minor naming inconsistency within the plan itself
- Documentation that could be clearer
