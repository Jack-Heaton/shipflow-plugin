# Agents, models and runtimes

Back to the [README](../README.md).

## The agents

The orchestrating session does the spawning itself. Every seat writes its report to a
declared file and returns one line, and the orchestrator reads the file. Sub-agent prose
never steers the run.

| Seat | Agent | Claude default | Codex / GPT default |
|---|---|---|---|
| Plan drafter / plan fixer | `sf-plan-drafter`, `sf-plan-fixer` (+ `-complex` high-effort profiles) | session model, medium (high for consequential design) | `gpt-6.1-sol`, medium/high |
| Plan reviewer | `sf-plan-reviewer` (+ `-complex`) | session model, medium | `gpt-6.1-sol`, medium |
| Direction reviewer | `sf-direction-reviewer` (+ `-complex`) | session model, medium | host-native |
| Explore | built-in Explore | session model | host-native |
| Implementer | `sf-implementer` | Opus, high | `gpt-6.1-sol`, low (`writer` tier) |
| Fixer / mop-up | `sf-fixer` | Opus, high | `gpt-6.1-sol`, low |
| Security (always seated) | `security-reviewer` | Opus, medium | `gpt-6.1-sol`, medium |
| Routed domain reviewers | `database-reviewer`, `backend-reviewer`, `frontend-reviewer`, `infra-reviewer`, `api-contract-reviewer`, `prompt-reviewer`, `ux-consistency-lead` | Opus, medium | `gpt-6.1-sol`, medium |
| Test coverage / cold regression | `test-coverage-guardian`, regression template | Opus, medium | `gpt-6.1-sol`, medium |
| Architecture (seam touched) | general-purpose + template | Opus | `gpt-6.1-sol`, high |

The policy behind the table is in
[`skills/shared/model-tiering.md`](../plugins/shipflow/skills/shared/model-tiering.md), and the
GPT seat tiers are in [`scripts/review-tiers.json`](../plugins/shipflow/scripts/review-tiers.json).
The principle: choose a model capable of the decision the seat makes, then set effort by
how much risk is still unresolved. Writers can run at low effort because every commit they
make is reviewed, built and checked against the acceptance criteria.

## Runs on Claude Code, Codex, or both

The stages, gates and acceptance checks are identical on every runtime. Only dispatch
changes. `sf-runtime` resolves the host and mode once at Stage 0 and records them in the
audit log.

| Mode | Orchestrator | Seats | Needs |
|---|---|---|---|
| `claude` | Claude Code | Claude agents (see the agents table above) | Claude Code |
| `codex` | Codex | Codex native sub-agents on GPT, including planners, security and UX | Codex CLI only, no Claude account |
| `hybrid` | Claude Code | `HYBRID_MODE=review`: review seats run on GPT through headless `codex exec`. `HYBRID_MODE=codex`: review, implementer, fixer and mop-up seats all run on GPT. Planning, Explore and the pinned security/UX seats stay on Claude. | Both |

Hybrid seats run in a read-only sandbox with a JSON output schema and write the same
artifact a Claude seat would. If a hybrid preflight fails, the run stops at a checkpoint.
It never quietly falls back to Claude. `SOLO_MODEL=opus` pins every Claude seat to one model
for controlled comparisons.

The Codex distribution under `.agents/plugins/` is **generated** from the Claude source by
[`scripts/generate-codex.py`](../scripts/generate-codex.py). The generator rewrites `/skill` as
`$skill`, moves agents into role references resolved by the runtime, and stamps each skill
with a compatibility banner. CI runs `--check` so the two can't drift apart.
