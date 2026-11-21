# The pipeline, stage by stage

Back to the [README](../README.md).

| Stage | What happens | Why it's there |
|---|---|---|
| **0 · Preflight** | Resolves the host (Claude or Codex) and execution mode, the base branch, and a **baseline of the push-gated test suites on the base** before any code changes. | A failure that already exists on the base is reported as pre-existing, so it isn't blamed on the change and doesn't burn a fix round. |
| **1A / 1B · Issue + worktree** | Cuts a new issue (`/cut-task`), or picks up an existing one and parses its `## Requirements`, `## Acceptance Criteria`, `## Branch` and `## Base branch`. Each run gets its own branch, and its own git worktree locally. | Many runs can go in parallel without stepping on each other. |
| **1.8 · Reproduce first** | For bugs and performance or concurrency work, a seat writes a failing test that runs in the real environment and commits it as `[repro]` before any planning. | A fix gets planned against an observed failure, not a theory. |
| **1.9 · Blast-area routing** | `sf-route` classifies the likely file set (prod, test or meta files, the workspaces touched, *seams* such as auth, shared contracts, migrations and lockfiles). | Small, well-specified work takes the **express** path. Everything else gets a reviewed plan. Parent issues fan out as an **epic**. |
| **2 · Plan** | Acceptance criteria are **bounded** first: every "never", "all" or "100%" gets a `guard:` (a structural check) or a `fixture:` (a named input set). A drafter writes the plan, an adversarial plan reviewer scores it, and a plan fixer revises it, round after round, until the plan is clean. | Unbounded criteria make review loops chase counterexamples forever. Bounded ones converge. |
| **3a–3c · Implement** | The plan is split into batches. Independent batches with disjoint scopes run in parallel in scratch worktrees. Seam-touching work lands first, one batch at a time. | Parallelism where it's safe, serial order where a shared contract is moving. |
| **3d · Routed review** | `sf-route` seats a panel based on the files that actually changed: security always, plus domain reviewers (database, backend, frontend, infra, API contract, prompts, UX, test coverage), with an architecture seat when a seam is touched. | Reviewers read code they're specialists in, and the panel scales with the change's blast area. |
| **3e · Triage + fix loop** | Findings are deduped across seats, then sorted into **fix now**, **needs a human**, **out of scope** (filed as a follow-up issue right away) or **not legitimate** (dropped). A fixer applies a round's fixes, then a cold regression pass re-checks them. Two base rounds, extendable up to six. | Review findings become a bounded, auditable loop, not an argument. |
| **3f · Gates** | Build, lint, type-check and tests run as concurrent jobs through `sf-gates`. An **acceptance-criteria table** marks each criterion PASS, FAIL or `NOT VERIFIED` with the evidence. | "Done" means the criteria were checked. Anything unchecked is labeled `NOT VERIFIED`, never assumed to pass. |
| **3g · PR** | `sf-push` pushes through the repo's own verified push command, then opens or updates the PR, reads back `mergeable`, and links the PR and branch back to the issue. | The run ends on a mergeable PR and an updated issue, not just a pushed branch. |
| **4 · Report** | A final report, plus a schema-validated JSONL audit log of every stage, spawn, token count and operator wait. `/ship-report` turns the log into a cost and cycle post-mortem. | Model and effort tiers get tuned from measured runs, not vibes. |

### The status lifecycle

The workflow moves the issue through a fixed lifecycle. On GitHub each status is a single
`status:<name>` label, and the terminal statuses also close the issue.

`to do` → `planning` → `ready for development` → `in development` → `development complete`
(PR open, criteria verified). `remediating` means a draft PR still has unresolved
critical or high findings. `blocked` means a checkpoint stopped the run. Everything after
the PR opens (`ready for testing` → `testing` → `shipped`) belongs to the human.

### Checkpoints, not interruptions

The run only stops at `CHECKPOINT_REQUIRED`, which has an enumerated reason
(`preflight-failed`, `ambiguous-fix-required`, `epic-integration-conflict`, …). It writes
a run cursor first, so `/ship-task <issue>` resumes exactly where it stopped. Questions follow one
**interview policy**:

- Every question is a structured multiple-choice prompt with the recommended answer first.
- Questions that only matter for medium or low findings never interrupt the run. They're
  collected into `pr-questions.md` and asked once, after the PR is open.
- Blocking questions are **queued**. The run keeps doing every piece of work that doesn't
  depend on the answer, and asks the whole queue at once only when nothing else is left.
- New feature toggles are always the operator's call. No agent adds a flag on its own
  judgment.
