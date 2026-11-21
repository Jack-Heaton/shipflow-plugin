/**
 * @file sf-runtime.test.mjs
 * @description Verifies provider isolation, legacy hybrid routing and native accounting on real role resources.
 * @domain workflow-runtime
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime, resolveDispatch } from '../sf-runtime.mjs';

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const roles = ['plan-drafter', 'plan-reviewer', 'plan-fixer', 'direction-reviewer', 'explore', 'implementer', 'fixer', 'mopup-fixer', 'security-reviewer', 'ux-consistency-lead', 'backend-reviewer', 'architecture', 'test-coverage-guardian'];

test('Codex-native routes all roles to concrete GPT models despite inherited Claude/hybrid markers', () => {
  for (const role of roles) {
    const dispatch = resolveDispatch({ host: 'codex', role }, { CLAUDE_CODE_ENTRYPOINT: 'cli', HYBRID_MODE: 'codex' });
    assert.equal(dispatch.mode, 'codex');
    assert.equal(dispatch.transport, 'codex-native', role);
    assert.match(dispatch.model, /^gpt-/);
    assert.ok(dispatch.effort);
  }
});

test('Claude-only dispatch retains native named roles without requiring GPT configuration', () => {
  for (const role of roles) {
    const dispatch = resolveDispatch({ host: 'claude', role }, {});
    assert.equal(dispatch.transport, 'claude-native', role);
    assert.ok(['inherit', 'opus', 'sonnet', 'haiku'].includes(dispatch.model), `${role}: ${dispatch.model}`);
  }
});

test('legacy hybrid variants preserve Claude pins and planner family', () => {
  for (const hybridMode of ['review', 'codex']) {
    for (const role of roles) {
      const dispatch = resolveDispatch({ host: 'claude', role }, { HYBRID_MODE: hybridMode });
      const claude = ['plan-drafter', 'plan-fixer', 'direction-reviewer', 'security-reviewer', 'ux-consistency-lead', 'explore'].includes(role)
        || (hybridMode === 'review' && ['implementer', 'fixer', 'mopup-fixer'].includes(role));
      assert.equal(dispatch.backend, claude ? 'claude' : 'codex', `${hybridMode}: ${role}`);
      assert.equal(dispatch.transport, claude ? 'claude-native' : 'sf-codex');
    }
  }
  assert.equal(resolveRuntime({ host: 'claude' }, { SHIP_REVIEW_BACKEND: 'codex' }).hybrid_mode, 'review');
});

test('explicit hybrid defaults to review and preserves headless tier inheritance', (t) => {
  assert.equal(resolveRuntime({ host: 'claude' }, { SF_EXECUTION_MODE: 'hybrid' }).hybrid_mode, 'review');
  const dir = mkdtempSync(join(tmpdir(), 'sf inherited tiers '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tiersPath = join(dir, 'tiers.json');
  writeFileSync(tiersPath, JSON.stringify({ seats: { '*': 'inherited' }, tiers: { inherited: { model: null, effort: null } } }));
  const hybrid = resolveDispatch({ host: 'claude', mode: 'hybrid', role: 'plan-reviewer', tiersPath }, {});
  assert.equal(hybrid.transport, 'sf-codex');
  assert.equal(hybrid.model, null);
  assert.equal(hybrid.effort, null);
  assert.throws(() => resolveDispatch({ host: 'codex', role: 'plan-reviewer', tiersPath }, {}), /concrete GPT/);
});

test('mode conflicts and missing roles fail instead of silently changing provider or dropping a gate', () => {
  assert.throws(() => resolveRuntime({ host: 'codex', mode: 'hybrid' }, {}), /requires claude/);
  assert.throws(() => resolveRuntime({ host: 'claude', mode: 'codex' }, {}), /requires codex/);
  assert.throws(() => resolveRuntime({ host: 'claude', mode: 'claude' }, { HYBRID_MODE: 'review' }), /conflicts/);
  assert.throws(() => resolveDispatch({ host: 'codex', role: 'absent-reviewer' }, {}), /unavailable/);
  assert.throws(() => resolveRuntime({ host: 'codex' }, { HYBRID_MODE: 'invalid' }), /hybrid mode/);
});

test('bounded planning reduces effort without reducing model capability; code writer tiers remain fixed', () => {
  for (const host of ['claude', 'codex']) {
    for (const role of ['plan-drafter', 'plan-fixer', 'direction-reviewer']) {
      const bounded = resolveDispatch({ host, role, complexity: 'bounded' }, {});
      const complex = resolveDispatch({ host, role, complexity: 'complex' }, {});
      assert.equal(bounded.model, complex.model);
      assert.equal(bounded.effort, 'medium');
      assert.equal(complex.effort, 'high');
      assert.equal(bounded.continuation, 'same-agent-same-settings');
    }
  }
  assert.equal(resolveDispatch({ host: 'codex', role: 'fixer' }, {}).effort, 'low');
  assert.equal(resolveDispatch({ host: 'codex', role: 'architecture', template: 'regression' }, {}).effort, 'medium');
});

test('native preflight and accounting run with neither model CLI on PATH', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sf native parity '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PATH: dir, SF_HOST: 'codex', SF_EXECUTION_MODE: 'codex', HYBRID_MODE: 'off' };
  const invoke = (file, args) => spawnSync(process.execPath, [join(scripts, file), ...args], { cwd: dir, env, encoding: 'utf8' });
  const check = invoke('sf-runtime.mjs', ['check', '--host', 'codex', '--cwd', dir]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).roles.length, 9);
  const log = join(dir, 'native.jsonl');
  const init = invoke('sf-log.mjs', ['init', '--host', 'codex', '--log', log]);
  assert.equal(init.status, 0, init.stderr);
  const meta = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(meta.host, 'codex');
  assert.equal(meta.host_version, null);
  assert.equal(meta.cc_version, null);
  for (let i = 0; i < 3; i++) {
    const row = invoke('sf-log.mjs', ['spawn', '--log', log, 'role=plan-reviewer', 'agent_type=codex-native', 'backend=codex-native', 'model=gpt-6.1-sol', 'phase=plan', 'round=1', 'wall_ms=1000', `agent_id=native-${i}`, `artifact=review-${i}.md`]);
    assert.equal(row.status, 0, row.stderr);
  }
  const result = invoke('sf-log.mjs', ['check', log, '--compact']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.claude_spawns, 0);
  assert.equal(report.usage_channel_dead, false);
});

test('report analyzer accepts an interrupted run without timestamps', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sf partial report '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'ship-task-partial.jsonl');
  writeFileSync(log, JSON.stringify({ stage: 'run-meta', task: 'partial', host: 'codex' }) + '\n');
  const result = spawnSync('python3', [join(scripts, '..', 'skills', 'ship-report', 'report.py'), '--json', log], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runs[0].task, 'partial');
});

test('SOLO_MODEL locks every non-Explore Claude role and refuses GPT seats', () => {
  for (const role of roles) {
    const dispatch = resolveDispatch({ host: 'claude', role }, { SOLO_MODEL: 'opus' });
    assert.equal(dispatch.solo_model, 'opus');
    assert.equal(dispatch.transport, 'claude-native', role);
    const unlocked = resolveDispatch({ host: 'claude', role }, {}).model;
    assert.equal(dispatch.model, role === 'explore' ? unlocked : 'opus', role);
  }
  assert.equal(resolveDispatch({ host: 'claude', role: 'implementer', soloModel: 'sonnet' }, {}).model, 'sonnet');
  assert.equal(resolveRuntime({ host: 'claude' }, {}).solo_model, null);
  assert.throws(() => resolveRuntime({ host: 'claude' }, { SOLO_MODEL: 'gpt-6.1-sol' }), /SOLO_MODEL must be/);
  assert.throws(() => resolveRuntime({ host: 'claude' }, { SOLO_MODEL: 'opus', HYBRID_MODE: 'review' }), /Claude-only/);
  assert.throws(() => resolveRuntime({ host: 'codex' }, { SOLO_MODEL: 'opus' }), /Claude-only/);
});

test('explore is the host built-in: no role file, session model, and a GPT tier on Codex backends', () => {
  const claude = resolveDispatch({ host: 'claude', role: 'explore' }, {});
  assert.equal(claude.role_name, 'Explore');
  assert.equal(claude.role_path, null);
  assert.equal(claude.model, 'inherit');
  assert.equal(claude.effort, null);
  assert.equal(claude.read_only, true);
  const codex = resolveDispatch({ host: 'codex', role: 'explore' }, {});
  assert.equal(codex.role_path, null);
  assert.match(codex.model, /^gpt-/);
});

test('HYBRID_MODE=codex keeps explore on the Claude built-in, on the session model', () => {
  const dispatch = resolveDispatch({ host: 'claude', role: 'explore', hybridMode: 'codex' }, {});
  assert.equal(dispatch.mode, 'hybrid');
  assert.equal(dispatch.hybrid_mode, 'codex');
  assert.equal(dispatch.backend, 'claude');
  assert.equal(dispatch.transport, 'claude-native');
  assert.equal(dispatch.role_name, 'Explore');
  assert.equal(dispatch.model, 'inherit');
  assert.equal(dispatch.tier, null);
});

test('every checked-in Codex tier runs gpt-6.1-sol on the default service tier', () => {
  const tiers = JSON.parse(readFileSync(join(scripts, 'review-tiers.json'), 'utf8'));
  assert.ok(Object.keys(tiers.tiers).length > 0);
  for (const [name, tier] of Object.entries(tiers.tiers)) {
    assert.equal(tier.model, 'gpt-6.1-sol', name);
    assert.equal(tier.service_tier, 'default', name);
  }
  for (const [seat, key] of Object.entries({ ...tiers.seats, ...tiers.templates })) assert.ok(tiers.tiers[key], `${seat} → ${key}`);
  assert.equal(tiers.seats.explore, undefined, 'explore has no Codex seat');
  for (const seat of ['implementer', 'fixer', 'mopup-fixer']) assert.equal(tiers.tiers[tiers.seats[seat]].effort, 'low', seat);
});

// Frontmatter exists only in the source layout; the generated Codex roles carry none.
const sourceLayout = existsSync(join(scripts, '..', 'agents'));
test('every Claude agent role pins its effort: writers high, reviewers medium', { skip: !sourceLayout && 'generated roles carry no frontmatter' }, () => {
  for (const role of ['implementer', 'fixer', 'mopup-fixer']) {
    assert.equal(resolveDispatch({ host: 'claude', role }, {}).effort, 'high', role);
  }
  for (const role of ['security-reviewer', 'ux-consistency-lead', 'backend-reviewer', 'test-coverage-guardian']) {
    assert.equal(resolveDispatch({ host: 'claude', role }, {}).effort, 'medium', role);
  }
});
