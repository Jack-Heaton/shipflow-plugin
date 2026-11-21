/**
 * @file sf-resources.test.mjs
 * @description Verify plugin resource discovery across source and installed package layouts.
 * @domain workflow-runtime
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const resources = fileURLToPath(new URL('../sf-resources.mjs', import.meta.url));

function fixture(t, installed = false) {
  const root = mkdtempSync(join(tmpdir(), 'sf-res space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flow = join(root, 'shipflow', ...(installed ? ['1.0.0'] : []));
  const entry = join(flow, 'scripts', 'sf-resources.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  copyFileSync(resources, entry);
  const write = (path, value = '') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  const query = (name, dirs = '') => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', `import { resolveRole, sharedDir } from ${JSON.stringify(pathToFileURL(entry).href)};
      console.log(JSON.stringify({role:resolveRole(${JSON.stringify(name)}),sharedDir}));`],
    { encoding: 'utf8', env: { ...process.env, SF_SEAT_DIRS: dirs } }));
  return { root, flow, write, query };
}

test('source layout resolves sibling agents and shared prompts', (t) => {
  const fx = fixture(t);
  const role = fx.write(join(fx.root, 'shipflow', 'agents', 'security-reviewer.md'));
  assert.deepEqual(fx.query('security'), { role, sharedDir: join(fx.flow, 'skills', 'shared') });
});

test('installed layout resolves versioned generated roles; ambiguity needs explicit selection', (t) => {
  const fx = fixture(t, true);
  fx.write(join(fx.flow, 'references', 'shared', 'runtime.md'));
  const v1 = join(fx.root, 'shipflow', '2.0.0');
  fx.write(join(v1, '.codex-plugin', 'plugin.json'), '{}');
  const role = fx.write(join(v1, 'references', 'roles', 'security-reviewer.md'));
  assert.deepEqual(fx.query('security'), { role, sharedDir: join(fx.flow, 'references', 'shared') });
  const v2 = join(fx.root, 'shipflow', '2.1.0');
  fx.write(join(v2, '.codex-plugin', 'plugin.json'), '{}');
  fx.write(join(v2, 'references', 'roles', 'security-reviewer.md'));
  assert.equal(fx.query('security').role, undefined);
  assert.equal(fx.query('security', [join(fx.root, 'missing'), dirname(role)].join(delimiter)).role, role);
  fx.write(join(fx.flow, 'references', 'plugin-versions.json'), JSON.stringify({ 'shipflow': '2.0.0' }));
  assert.equal(fx.query('security').role, role);
});
