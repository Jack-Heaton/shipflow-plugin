#!/usr/bin/env node
/**
 * @file sf-runtime.mjs
 * @description Resolves ship workflow host, execution mode and per-role dispatch without launching agents.
 * @domain workflow-runtime
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginRoot, resolveRole } from './sf-resources.mjs';

const PLANNERS = new Set(['plan-drafter', 'plan-fixer', 'direction-reviewer']);
const WRITERS = new Set(['implementer', 'fixer', 'mopup-fixer']);
const PINNED = new Set(['security-reviewer', 'ux-consistency-lead']);
// Seats served by the host's own agent, so no role file exists to resolve. The stage's
// explore template is the brief (runtime.md §Resolve each role). A Claude host always serves
// explore itself, in every hybrid mode; only a Codex host runs it on GPT.
const BUILTIN = new Set(['explore']);
// The Agent tool's per-call `model` accepts only these aliases.
const SOLO_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const NAMES = {
  'plan-drafter': 'sf-plan-drafter', 'plan-fixer': 'sf-plan-fixer',
  'plan-reviewer': 'sf-plan-reviewer', 'direction-reviewer': 'sf-direction-reviewer',
  explore: 'Explore', implementer: 'sf-implementer', fixer: 'sf-fixer', 'mopup-fixer': 'sf-fixer',
};

function choice(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be ${allowed.join('|')}; got ${value}`);
  return value;
}

/** Explicit host wins over environment: a Codex child may inherit Claude's environment. */
export function resolveRuntime(options = {}, env = process.env) {
  const host = choice(options.host || env.SF_HOST || (env.CODEX_THREAD_ID ? 'codex' : 'claude'), ['claude', 'codex'], 'host');
  const legacy = options.hybridMode ?? env.HYBRID_MODE ?? (env.SHIP_REVIEW_BACKEND === 'codex' ? 'review' : 'off');
  choice(legacy, ['off', 'review', 'codex'], 'hybrid mode');
  const explicit = options.mode || env.SF_EXECUTION_MODE;
  const mode = choice(explicit || (host === 'codex' ? 'codex' : legacy === 'off' ? 'claude' : 'hybrid'), ['claude', 'codex', 'hybrid'], 'mode');
  if ((host === 'codex') !== (mode === 'codex')) {
    throw new Error(`mode ${mode} requires ${mode === 'codex' ? 'codex' : 'claude'} host; do not change model family silently`);
  }
  if (explicit === 'claude' && legacy !== 'off') throw new Error('Claude-only mode conflicts with HYBRID_MODE/SHIP_REVIEW_BACKEND; clear the hybrid setting');
  const hybridMode = mode === 'hybrid' ? (legacy === 'off' ? 'review' : legacy) : 'off';
  const solo = options.soloModel || env.SOLO_MODEL || null;
  if (solo) {
    choice(solo, SOLO_MODELS, 'SOLO_MODEL');
    // A solo fleet is all-Claude; GPT seats would silently break the lock.
    if (mode !== 'claude') throw new Error(`SOLO_MODEL=${solo} requires Claude-only mode; got ${mode} (clear HYBRID_MODE/SHIP_REVIEW_BACKEND/SF_EXECUTION_MODE or unset SOLO_MODEL)`);
  }
  return { host, mode, hybrid_mode: hybridMode, review_backend: mode === 'codex' ? 'codex-native' : mode === 'hybrid' ? 'codex' : 'claude', solo_model: solo };
}

function gptTier(role, template, options, native) {
  const tiers = JSON.parse(readFileSync(options.tiersPath || process.env.SF_CODEX_TIERS || join(pluginRoot, 'scripts', 'review-tiers.json'), 'utf8'));
  const key = tiers.templates?.[template] || tiers.seats[role] || tiers.seats['*'];
  const tier = tiers.tiers[key];
  if (!tier) throw new Error(`role ${role}: unknown tier ${key}`);
  if (native && (typeof tier.model !== 'string' || !tier.model.startsWith('gpt-') || typeof tier.effort !== 'string')) {
    throw new Error(`role ${role}: native GPT dispatch requires a concrete GPT model and effort (tier ${key})`);
  }
  return { tier: key, model: tier.model, effort: tier.effort, service_tier: tier.service_tier || null };
}

/** Returns a dispatch contract. Native tools remain the host's responsibility. */
export function resolveDispatch(options = {}, env = process.env) {
  const runtime = resolveRuntime(options, env);
  const role = (options.role || '').replace(/^reviewer:/, '');
  if (!role) return runtime;
  const complexity = choice(options.complexity || 'bounded', ['bounded', 'complex'], 'complexity');
  const baseRoleName = NAMES[role] || role;
  const claudePlan = runtime.mode !== 'codex' && (PLANNERS.has(role) || (role === 'plan-reviewer' && runtime.mode === 'claude'));
  const roleName = claudePlan && complexity === 'complex' ? `${baseRoleName}-complex` : baseRoleName;
  const builtin = BUILTIN.has(role);
  const rolePath = builtin ? null : resolveRole(roleName, { cwd: options.cwd });
  const templateOnly = ['architecture', 'performance', 'holistic'].includes(role);
  if (!rolePath && !templateOnly && !builtin) throw new Error(`role ${roleName} is unavailable; install its plugin or provide SF_SEAT_DIRS`);
  let backend = runtime.mode === 'codex' ? 'codex' : 'claude';
  if (runtime.mode === 'hybrid' && !PLANNERS.has(role) && !PINNED.has(role)) {
    if (!BUILTIN.has(role) && (!WRITERS.has(role) || runtime.hybrid_mode === 'codex')) backend = 'codex';
  }
  let model, effort, tier = null, serviceTier = null;
  if (backend === 'codex') {
    const selected = gptTier(role, options.template, options, runtime.host === 'codex');
    ({ model, effort, tier } = selected);
    serviceTier = selected.service_tier;
    if (PLANNERS.has(role)) effort = complexity === 'complex' ? 'high' : 'medium';
  } else {
    const body = rolePath ? readFileSync(rolePath, 'utf8') : '';
    model = /^model:\s*(\S+)/m.exec(body)?.[1] || (templateOnly ? 'opus' : 'inherit');
    effort = /^effort:\s*(\S+)/m.exec(body)?.[1] || null;
    if (PLANNERS.has(role) || role === 'plan-reviewer') effort = complexity === 'complex' ? 'high' : 'medium';
    if (runtime.solo_model && role !== 'explore') model = runtime.solo_model;
  }
  return {
    ...runtime, role, role_name: roleName, role_path: rolePath || null,
    backend, transport: runtime.host === 'codex' ? 'codex-native' : backend === 'claude' ? 'claude-native' : 'sf-codex',
    model, effort, tier, service_tier: serviceTier,
    read_only: !(WRITERS.has(role) || role === 'plan-drafter' || role === 'plan-fixer'),
    artifact_write: true,
    capabilities: role === 'ux-consistency-lead' ? ['browser-if-rendered-verification-required'] : [],
    continuation: 'same-agent-same-settings',
  };
}

function main(args) {
  const verb = args.shift();
  if (!['resolve', 'check'].includes(verb)) throw new Error('usage: sf-runtime resolve|check --host codex|claude [--mode codex|claude|hybrid] [--role <role>] [--complexity bounded|complex] [--cwd <path>] [--solo-model opus|sonnet|haiku|fable]');
  const options = {};
  const keys = { host: 'host', mode: 'mode', 'hybrid-mode': 'hybridMode', role: 'role', complexity: 'complexity', cwd: 'cwd', template: 'template', 'tiers-path': 'tiersPath', 'solo-model': 'soloModel' };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]?.replace(/^--/, '')];
    if (!key || !args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option ${args[i]}`);
    options[key] = args[i + 1];
  }
  if (verb === 'resolve') console.log(JSON.stringify(resolveDispatch(options)));
  else {
    const runtime = resolveRuntime(options);
    const roles = ['plan-drafter', 'plan-reviewer', 'plan-fixer', 'direction-reviewer', 'explore', 'implementer', 'fixer', 'mopup-fixer', 'security-reviewer'];
    const dispatches = roles.map(role => resolveDispatch({ ...options, role }));
    console.log(JSON.stringify({ ...runtime, ok: true, roles: dispatches }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`sf-runtime: ${error.message}`); process.exitCode = 1; }
}
