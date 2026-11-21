# Workflow runtime — Claude, Codex, or hybrid

Read once at workflow entry, including split phases and resumed runs. This file owns
host/tool adaptation; the shipping stages, acceptance criteria and authorization scope
are shared. Its dispatch rules take precedence over host-specific examples elsewhere.

## Select the host and execution mode

| Host (`SF_HOST`) | Mode (`SF_EXECUTION_MODE`) | Dispatch |
|---|---|---|
| `claude` | `claude` | Claude orchestrator and native Claude agents |
| `codex` | `codex` | GPT orchestrator and native GPT agents; no Claude CLI or account required |
| `claude` | `hybrid` | Claude orchestrator, existing Claude pins and headless GPT seats |

Set `SF_HOST` from the application actually running this skill, never from an inherited
Claude environment variable in a Codex child. Default mode is the host's own family.
For Claude hosts, existing `HYBRID_MODE=review|codex` and `SHIP_REVIEW_BACKEND=codex`
remain supported and select hybrid. `HYBRID_MODE=codex` is **not** the native Codex mode.
An explicit incompatible host/mode fails before external writes.

Resolve once with the installed plugin's absolute script path:

```bash
SF_RUNTIME=$(node "$SF/sf-runtime.mjs" resolve --host "$SF_HOST") || exit 1
export SF_HOST=$(printf '%s' "$SF_RUNTIME" | jq -r .host)
export SOLO_MODEL=$(printf '%s' "$SF_RUNTIME" | jq -r '.solo_model // empty')
export SF_EXECUTION_MODE=$(printf '%s' "$SF_RUNTIME" | jq -r .mode)
export HYBRID_MODE=$(printf '%s' "$SF_RUNTIME" | jq -r .hybrid_mode)
node "$SF/sf-runtime.mjs" check --host "$SF_HOST" --cwd "$WT_PATH"
```

Use these resolved values in every entrypoint; do not recompute hybrid mode from legacy
variables afterward. Persist `host`, `mode`, `hybrid_mode`, `review_backend` and `solo_model` in the preflight ledger and
run cursor. On resume, compare recorded mode with the current choice; a deliberate
cross-host handoff keeps committed artifacts but cold-starts roles whose handles cannot
be resumed. Never resume a Claude handle as a Codex handle, or vice versa.

## Solo-model fleet (`SOLO_MODEL`)

`SOLO_MODEL=opus|sonnet|haiku|fable` (or `--solo-model`) locks every Claude seat except
Explore to that model — planners, plan/direction reviewers, writers, every routed and
baseline reviewer, and any `general-purpose` spawn. Explore is not locked: it is the
host's built-in agent and runs on the session model, so start the session on the solo
model when the explore seat must match. `SOLO_MODEL` is
Claude-only: the resolver refuses it with a Codex host, hybrid mode or an unknown alias.
Pass `model: "$SOLO_MODEL"` on every non-Explore `Agent` spawn — the per-call override is
what beats frontmatter pins and `inherit` — and log that model on its `spawn` row. Effort
selection (named `-complex` profiles) is unchanged. Record `solo_model` on the preflight
event and run cursor; `sf-log check` lists any non-Explore Claude spawn at another model
under `spawns_off_solo_model`. On resume, a different `SOLO_MODEL` is a deliberate change:
warm seats keep their original model, new cold spawns use the new one.

## Resolve each role, then dispatch

```bash
node "$SF/sf-runtime.mjs" resolve --host "$SF_HOST" --role plan-drafter --complexity bounded --cwd "$WT_PATH"
```

Use `complex` for a new architecture, cross-contract behavior, authorization design,
concurrency/state transitions or irreversible data choices. The JSON returns the role
file, provider, transport, model and effort. Read that role file and the stage's prompt
template. `explore` has no role file: it is the host's built-in agent, and its brief is
the stage's own explore template (`plan-prompts.md` §Speculative exploration, or the
skill's 3c brief) on either host. A Claude host always serves it with the built-in Claude
`Explore`, in every hybrid mode — `HYBRID_MODE=codex` never moves it to GPT. Only a Codex
host runs it on GPT, as a native subagent at the `seats['*']` tier. Role names are semantic jobs, not tool names. Planning defaults to medium
effort on the same capable family; complex planning uses high. Code-writer and review
tiers stay in `review-tiers.json`. `inherit` on Claude means the actual session model;
log the actual identity if available, otherwise `session`, never invent it.

### Codex native

- Use the available native subagent creation tool with the resolved GPT `model` and
  `reasoning_effort`. Where the tool exposes `fork_turns`, use `none` with explicit
  worktree, requirements/plan, role and artifact paths; full-history forks may not
  accept model overrides. Each agent reads repository instructions in its worktree.
- Use native wait and follow-up/resume tools and retain returned handles. An idle
  agent needs the tool that **starts another turn**, not merely a mailbox message.
  Preserve context and settings for warm closure. If continuation is unavailable,
  cold-start the same role with its prior artifact and the scoped delta. Never
  downgrade to Claude or omit a gate because a native tool is unavailable.
- Schedule within the host's available concurrency; queue remaining readers. A
  worktree has one writer. Await all required artifacts before declaring completion;
  use the host's wait mechanism rather than detached shell jobs. Native agents are
  accounted by the orchestrator exactly once; only headless `sf-codex` self-logs.
- All roles, including planning, security and UX, use GPT. Claude pin lists and the
  headless hybrid substitutions do not apply. For a routed role or required capability
  that is unavailable, report the exact gap before dependent work; never call the
  absent gate passed. A browser is required only when the task's verification needs
  rendered interaction; use the tools available in this host.
- Map `AskUserQuestion` to an available user-input tool, or ask a concise question in
  the response when none exists. Optional unanswered questions permit a stated
  assumption; required product decisions or approvals remain pending. Retain prior
  user authorization. Omit unsupported `PushNotification`; ordinary progress updates
  provide status. `Bash`/`Read` examples mean the available terminal/file tools.
- Do not run `claude plugin list`, Claude hooks, or headless Codex setup to verify a
  native session. Check installed role/resource paths with `sf-runtime check`, resolve
  the actual routed roster, and verify native subagent/model/tool availability.
  Log missing token usage as null; native handles are not `codex exec` thread IDs.
- On pickup after interruption, explicitly append `session-resumed source=resume`
  and reconcile the cursor, committed artifacts and actual git state. Native waiting
  and explicit resume reconciliation replace Claude's Stop/SessionStart hook behavior.

### Claude native and hybrid

Claude native uses the named-agent tools. Hybrid retains `review-backend.md`'s existing
headless transport, security/UX Claude pins, model-family mix and failure behavior.
The runtime resolver makes those assignments explicit; it does not move existing hybrid
seats. Use native Claude role effort controls when supported; if unavailable, report
the actual setting rather than claiming a cap. Warm turns retain their initial settings;
do not cold-start solely to reduce effort. If newly discovered design work needs higher
effort, delegate that bounded design question and feed its decision into the warm role.

## Completion and handoff

Every mode uses the same artifact schemas, bounded plan gate, review/fix loop, build and
acceptance checks, tracker updates and verified push/PR handoff. The user invoking the
workflow supplies its task-scoped authority; the runtime never adds deployment/merge
authority. A cross-runner split-phase handoff uses `phase-contract.md`, not process memory.
Package validation proves resources resolve; behavioral parity additionally requires
an isolated task covering implementation, a review fix, a required operator question,
and interruption/resume on each host. Report what was actually exercised.
