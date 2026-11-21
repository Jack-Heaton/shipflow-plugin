/**
 * @file sf-roles.mjs
 * @description The ledger role vocabulary for the shipflow ship-* skills: the role prefixes
 *   /ship-report aggregates on (spawn-accounting.md) and the rule that refuses a drifted role.
 *   Shared by sf-log (enforced at write) and sf-codex (checked before any seat runs, so a bad
 *   --role never pays for a seat whose ledger row would then be refused). Zero dependencies.
 * @domain workflow-audit-log
 */

export const ROLE_PREFIXES = [
  'plan-drafter',
  'plan-reviewer',
  'plan-drafter-fixer',
  'explore',
  'implementer',
  'fixer',
  'reviewer:',
  'holistic',
  'mopup-fixer',
  'direction-reviewer',
];

/** Why `role` (logged at `phase`) would be refused on a spawn row, or null when it is valid. */
export function roleError(role, phase) {
  const r = String(role);
  if (!ROLE_PREFIXES.some((p) => r.startsWith(p))) {
    return `role "${r}" must start with one of: ${ROLE_PREFIXES.join(' ')} (a reviewer logs as reviewer:<agent>)`;
  }
  if (r === 'reviewer:') return 'role "reviewer:" names no agent — log reviewer:<agent>';
  if (r.startsWith('implementer') && phase === 'fix') {
    return `role "${r}" with phase=fix — log a fixer as role=fixer (a scope-expansion implementer logs phase=implement)`;
  }
  return null;
}
