/**
 * @file sf-resources.mjs
 * @description Resolve workflow resources in source, generated, and installed plugin layouts.
 * @domain workflow-runtime
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sharedDir = existsSync(join(pluginRoot, 'references', 'shared'))
  ? join(pluginRoot, 'references', 'shared') : join(pluginRoot, 'skills', 'shared');
export const schemaDir = join(pluginRoot, 'schemas');

const roleDirs = (root) => [join(root, 'references', 'roles'), join(root, 'agents')];

export function roleSearchDirs(cwd) {
  const dirs = (process.env.SF_SEAT_DIRS || '').split(delimiter).filter(Boolean);
  dirs.push(...roleDirs(pluginRoot));
  const parent = dirname(pluginRoot);
  // A cache installation nests each plugin under its own version, unlike a source checkout.
  const marketplace = existsSync(join(parent, 'shipflow')) || existsSync(join(parent, 'shipflow'))
    ? parent : dirname(parent);
  const versionsPath = join(pluginRoot, 'references', 'plugin-versions.json');
  const bundledVersions = existsSync(versionsPath) ? JSON.parse(readFileSync(versionsPath, 'utf8')) : {};
  for (const name of ['shipflow', 'shipflow']) {
    const root = join(marketplace, name);
    dirs.push(...roleDirs(root));
    if (bundledVersions[name]) {
      // Pin cross-plugin prompts to the tested bundle even when old cache versions remain.
      // SF_SEAT_DIRS still provides an explicit override for independently upgraded roles.
      dirs.push(...roleDirs(join(root, bundledVersions[name])));
      continue;
    }
    if (existsSync(root)) {
      const versions = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()
        && (existsSync(join(root, e.name, '.codex-plugin', 'plugin.json'))
          || existsSync(join(root, e.name, '.claude-plugin', 'plugin.json'))));
      // The cache alone cannot say which of multiple versions is active. An explicit
      // SF_SEAT_DIRS selects it; silently taking newest can change the review policy.
      if (versions.length === 1) dirs.push(...roleDirs(join(root, versions[0].name)));
    }
  }
  if (cwd) dirs.push(join(cwd, '.agents', 'agents'), join(cwd, '.claude', 'agents'));
  return [...new Set(dirs)];
}

export function resolveRole(spec, { cwd } = {}) {
  if (!spec || spec === 'none') return null;
  const explicit = resolve(cwd || process.cwd(), spec);
  if (spec.endsWith('.md') && existsSync(explicit)) return explicit;
  const name = spec === 'security' ? 'security-reviewer' : spec;
  for (const dir of roleSearchDirs(cwd)) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) return path;
  }
  return undefined;
}
