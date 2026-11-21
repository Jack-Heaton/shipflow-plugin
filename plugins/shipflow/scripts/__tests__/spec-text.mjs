/**
 * @file spec-text.mjs
 * @description Helpers for spec-contract tests: read a shipflow spec file relative to the plugin
 *   root and cut one section out of it, so a test pins key terms inside the section that must
 *   carry them rather than anywhere in the file. Not a test file.
 * @domain workflow-spec
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readSpec(relPath) {
  return readFileSync(resolve(PLUGIN_ROOT, relPath), 'utf8');
}

// From the first match of startRe to the first match of endRe after it (exclusive). Throws when
// either bound is missing, so a renamed heading fails loudly instead of matching an empty string.
export function section(text, startRe, endRe) {
  const start = text.search(startRe);
  if (start < 0) throw new Error(`section start not found: ${startRe}`);
  const rest = text.slice(start + 1);
  const end = rest.search(endRe);
  if (end < 0) throw new Error(`section end not found after ${startRe}: ${endRe}`);
  return text.slice(start, start + 1 + end);
}
