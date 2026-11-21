/**
 * @file sf-parallel-gate.mjs
 * @description The 3b parallel-implementation gate's reason vocabulary for the shipflow ship-*
 *   skills: the four gate conditions, named by the reason a batch records when that condition
 *   is the first to fail, and the reason a batch records when every condition holds. Shared by
 *   sf-route (which computes a batch's reason) and sf-log (which refuses any other reason on a
 *   task-decomposition event). Zero dependencies.
 * @domain workflow-audit-log
 */

// Gate order: a batch records the FIRST failed condition, so the order is part of the contract.
export const GATE_REASONS = [
  'no scratch worktrees',
  'seam touched',
  'fewer than 2 independent tasks',
  'scopes overlap',
];

export const ALL_HOLD = 'all four hold';
