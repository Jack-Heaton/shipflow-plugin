---
name: sf-plan-fixer-complex
description: "High-effort profile for sf-plan-fixer when a cold spawn must resolve consequential design. Shares the base role's instructions and artifact contract."
model: inherit
effort: high
---

Read the sibling `sf-plan-fixer.md` role file before acting and follow its complete
instructions and artifact contract. Resolve it from this role's directory (the
runtime may package roles under `agents/` or `references/roles/`).

This profile selects high effort on the session model for unresolved architectural,
contract, authorization, data-integrity, or irreversible decisions. Its frontmatter
supersedes the base role's medium-effort default; all other base instructions apply.
Use this profile for a cold spawn selected by the runtime, not to restart a warm
thread merely to change settings.
