/**
 * @file sf-route.test.mjs
 * @description Tests for sf-route.mjs `ac-scan`: extracts acceptance criteria under a heading or
 *   bold label (nested sub-bullets and wrapped lines belong to their item; code fences and
 *   `source:` lines are skipped), flags universal quantifiers, recognizes bound markers, marks
 *   heuristic-domain wording, and honours --fail-on-unbounded via the exit code with the JSON
 *   still written. Also `classify` reviewer routing: infra-reviewer fires on
 *   infrastructure files, not service handler code; the panel cap, the failure-over-time gate
 *   (word-bounded, prod lines only), live_check from `.shipflow.json`, `fix-trend`, and the
 *   `batches` decomposition (seam batch first, gate reasons, the sf-log validator pair). Run: node --test plugins/shipflow/scripts/__tests__/*.test.mjs
 * @domain workflow-routing
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixTrend, planBatches, scanAcceptanceCriteria } from '../sf-route.mjs';
import { ALL_HOLD } from '../sf-parallel-gate.mjs';

const SF_ROUTE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-route.mjs');

function run(args) {
  return spawnSync(process.execPath, [SF_ROUTE, ...args], { encoding: 'utf8' });
}

function withFile(md) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-route-'));
  const f = join(dir, 'requirements.md');
  writeFileSync(f, md);
  return f;
}

// Mixed ACs: the first two are unbounded (universal wording, no guard/fixture/test anchor),
// the guarded one is bounded — the fixture the ac-scan tripwire must separate.
const RUN_ACS = `# Requirements

## Requirements

Containment at the assembly boundary.

## Acceptance criteria

*   No citation on any reconcile result references a document outside the event's linked set.
*   A citation whose quote cannot be located on the page falls back to its own block-level box,
    never to a different block's.
*   The invariant holds at the citation-assembly boundary — guard: \`enforceContainment\` contract test
    rejects any candidate whose document id is outside the linked set.
*   Re-running work scope \`c2c5bdc6…\` yields 0 off-scope citations (was 34).

## Out of scope

- Everything else — never touched.
`;

test('scanner: only the acceptance section; universal vs bounded; wrapped bullets join', () => {
  const out = scanAcceptanceCriteria(RUN_ACS);
  assert.equal(out.counts.criteria, 4, 'the out-of-scope bullet is not a criterion');
  const [c1, c2, c3, c4] = out.criteria;
  assert.equal(c1.section, 'Acceptance criteria');
  assert.deepEqual(c1.universal.sort(), ['any', 'no']);
  assert.equal(c1.bounded, false);
  assert.equal(c2.bounded, false);
  assert.match(c2.text, /never to a different block's/);
  assert.equal(c2.heuristic, true, 'quote/highlight wording is heuristic-domain');
  assert.equal(c3.bounded, true, 'guard: bounds the universal "any"');
  assert.ok(c3.bound_markers.includes('guard'));
  assert.equal(c4.universal.length, 0);
  assert.equal(c4.bounded, true);
  assert.deepEqual(out.unbounded, [1, 2]);
  assert.equal(out.counts.unbounded, 2);
  assert.equal(out.counts.heuristic_unbounded, 1);
});

test('scanner: a nested sub-bullet and a lazy (unindented) wrap belong to the item above', () => {
  const out = scanAcceptanceCriteria(`## Acceptance criteria
- All citations are contained:
  - guard: \`enforceContainment\` contract test
  - fixture: run \`c2c5bdc6\`
- No citation on any result leaves the linked set —
guard: enforceContainment rejects it
`);
  assert.equal(out.counts.criteria, 2);
  assert.equal(out.criteria[0].bounded, true);
  assert.ok(out.criteria[0].bound_markers.includes('fixture'));
  assert.equal(out.criteria[1].bounded, true, 'the unindented continuation carries the guard');
  assert.deepEqual(out.unbounded, []);
});

test('scanner: a paragraph criterion spans its wrapped lines; a blank line separates paragraphs', () => {
  const out = scanAcceptanceCriteria(`## Acceptance criteria
PRD-level (parent \`## Definition of done\`):
every child carries its regression test.

No item's outcome hint changes — guard: \`hint-parity.contract.test.ts\`.
`);
  assert.equal(out.counts.criteria, 2);
  assert.match(out.criteria[0].text, /^PRD-level .* regression test\.$/);
  assert.equal(out.criteria[1].bounded, true);
});

test('scanner: code fences and source: lines are skipped; a bold label with trailing text opens the section', () => {
  const out = scanAcceptanceCriteria(`**Acceptance Criteria** (per phase)
- All rows validate — guard: \`rows.contract.test.ts\`
  source: all rows are always valid
- source: no citation on any result
\`\`\`ts
expect(all).toBe(1)
\`\`\`
- Every writer emits the field — fixture: the 6 writers in \`writers.test.ts\`

**Description:**
- not a criterion, always ignored
`);
  assert.equal(out.counts.criteria, 2);
  assert.equal(out.criteria[0].section, 'Acceptance Criteria (per phase)');
  assert.equal(out.criteria[0].bounded, true);
  assert.ok(!/always valid/.test(out.criteria[0].text), 'the source: sub-bullet is not appended');
  assert.ok(out.criteria[1].bound_markers.includes('test-file'));
  assert.deepEqual(out.unbounded, []);
});

test('scanner: bound markers are id-shaped; universal words respect no-op and "only when"', () => {
  const b = (md) => scanAcceptanceCriteria(`## Acceptance criteria\n- ${md}\n`).criteria[0];
  assert.equal(b('All uploads land in `S3`').bounded, false, '`S3` is a name, not a fixture');
  assert.equal(b('All uploads land in `S3`').bound_markers.length, 0);
  assert.equal(b('All task codes parse — fixture set `12-34-56`, `34-10-01`').bounded, true);
  assert.ok(b('No page in run `c2c5bdc6-ffc5` is skipped').bound_markers.includes('hex-id'));
  const live = b('No deadlock on reprocess — live: rerun job 8 on dev, read the worker log');
  assert.equal(live.bounded, true, 'live: bounds the claim to one deployed run');
  assert.ok(live.bound_markers.includes('live'));
  for (const text of [
    'No cache entry outlives its time-to-live: 5 minutes',
    'Every page shows the go-live: banner',
    'Live: every page is indexed',
    'No page is skipped — live: TBD',
    'Every page is indexed (source: live: every page is indexed)',
  ]) assert.equal(b(text).bounded, false, `not a live bound: ${text}`);
  assert.deepEqual(b('no-op on empty input').universal, [], '"no-op" is not a quantifier');
  const only = b('A citation carries a document-type badge only when the cited block is actually sourced from that document type.');
  assert.deepEqual(only.universal, ['only when']);
  assert.equal(only.bounded, false);
  assert.equal(only.heuristic, true);
  assert.equal(b('Works correctly').universal.length, 0, 'vagueness is the rubric\'s job, not the scanner\'s');
});

test('scanner: numbered lists, checkboxes, CRLF, and a heading that names the bounded section', () => {
  const out = scanAcceptanceCriteria('## Acceptance criteria (bounded)\r\n1. [ ] Every row is valid — guard: `rows.contract.test.ts`\r\n2. [x] Any row\r\n');
  assert.equal(out.counts.criteria, 2);
  assert.equal(out.criteria[0].bounded, true);
  assert.equal(out.criteria[1].bounded, false);
  assert.deepEqual(out.unbounded, [2]);
});

test('cli: --fail-on-unbounded sets exit 1 but still writes the JSON; positional path works; usage errors exit 2', () => {
  const bad = withFile('## Acceptance criteria\n- All rows are always valid\n');
  const res = run(['ac-scan', '--file', bad, '--fail-on-unbounded', '--compact']);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).counts.unbounded, 1, 'JSON reaches the consumer on exit 1');
  const good = withFile('## Acceptance criteria\n- All rows are valid — pinned to the 12 rows of `fixtures/rows-2026-09.json`\n');
  assert.equal(run(['ac-scan', '--file', good, '--fail-on-unbounded']).status, 0);
  assert.equal(JSON.parse(run(['ac-scan', good, '--compact']).stdout).counts.criteria, 1, 'positional path');
  assert.equal(JSON.parse(run(['ac-scan', `--file=${good}`, '--compact']).stdout).counts.criteria, 1, '--file=path');
  const usage = run(['ac-scan']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--file <markdown> is required/);
  const wrongVerb = run(['classify', '--file', good]);
  assert.equal(wrongVerb.status, 2);
  assert.match(wrongVerb.stderr, /--file belongs to ac-scan/);
});

test('cli: importing the module does not run main (no HELP on stdout, no exit)', () => {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${SF_ROUTE}').then((m) => { console.log('imported', typeof m.scanAcceptanceCriteria); })`],
    { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /imported function/);
  assert.doesNotMatch(probe.stdout, /Usage:/);
});

test('cli: a file without an acceptance section reports zero criteria', () => {
  const f = withFile('# Plan\n\n## Steps\n- do all the things\n');
  const out = JSON.parse(run(['ac-scan', '--file', f, '--compact']).stdout);
  assert.equal(out.counts.criteria, 0);
  assert.deepEqual(out.unbounded, []);
});

// ---- classify: infra-reviewer routes on infrastructure files, not handler code ----
function routed(files) {
  const r = run(['classify', '--compact', ...files]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).reviewers.routed;
}

test('classify: a service handler diff routes to backend-reviewer, not infra-reviewer', () => {
  const r = routed([
    'services/orders/handlers/create-order.ts',
    'services/orders/workers/reindex.ts',
  ]);
  assert.ok(r.includes('backend-reviewer'), r);
  assert.ok(!r.includes('infra-reviewer'), r);
});

test('classify: stacks, terraform, k8s, Dockerfiles, CI workflows and IAM route to infra-reviewer', () => {
  for (const f of [
    'infra/lib/orders-stack.ts',
    'infra/bin/app.ts',
    'terraform/main.tf',
    'envs/prod.tfvars',
    'deploy/k8s/deployment.yaml',
    'Dockerfile',
    'services/api/Dockerfile',
    '.github/workflows/ci.yml',
    'platform/iam/worker-role.ts',
  ]) {
    assert.ok(routed([f]).includes('infra-reviewer'), f);
  }
});

test('classify: the generic routing table seats each domain reviewer on its conventional paths', () => {
  const cases = {
    'security-reviewer': ['src/auth/jwt.ts', 'server/session_store.py'],
    'prompt-reviewer': ['prompts/summarize.md', 'src/llm/client.ts', 'agents/triage.md', 'src/review.prompt.txt'],
    'database-reviewer': ['db/migrations/0042_add_index.sql', 'prisma/schema.prisma', 'queries/report.sql'],
    'backend-reviewer': ['services/billing/handlers/charge.ts', 'server/routes/users.py', 'api/v1/orders.go'],
    'frontend-reviewer': ['apps/web/app/settings/page.tsx', 'src/routes/+page.svelte', 'next.config.mjs', 'src/middleware.ts'],
    'ux-consistency-lead': ['src/components/Button.vue', 'styles/theme.css'],
    'api-contract-reviewer': ['schema/api.graphql', 'openapi.yaml', 'proto/orders.proto', 'packages/contracts/src/order.ts'],
  };
  for (const [reviewer, files] of Object.entries(cases)) {
    for (const f of files) {
      const out = classifyJson(['--panel-cap', '10', f]);
      const seated = [...out.reviewers.routed, ...out.reviewers.baselines];
      assert.ok(seated.includes(reviewer), `${f} → ${JSON.stringify(seated)} (wanted ${reviewer})`);
    }
  }
});

test('classify: frontend + backend in one diff adds api-contract-reviewer (cross-domain rule)', () => {
  const out = classifyJson(['--panel-cap', '10', 'apps/web/app/orders/page.tsx', 'services/api/handlers/orders.ts']);
  assert.ok(out.reviewers.routed.includes('api-contract-reviewer'), out.reviewers.routed);
  assert.ok(out.reviewers.notes.some((n) => /cross-domain/.test(n)), out.reviewers.notes);
  const solo = classifyJson(['--panel-cap', '10', 'apps/web/app/orders/page.tsx']);
  assert.ok(!solo.reviewers.routed.includes('api-contract-reviewer'), solo.reviewers.routed);
});

test('classify: api-contract, migration, package and lockfile seams; generic workspaces', () => {
  const out = classifyJson(['schema/api.graphql', 'db/migrations/0001.sql', 'services/api/package.json', 'pnpm-lock.yaml']);
  assert.deepEqual(out.seam.files['schema/api.graphql'], ['api-contract']);
  assert.ok(out.seam.files['db/migrations/0001.sql'].includes('migration'));
  assert.deepEqual(out.seam.files['services/api/package.json'], ['package']);
  assert.deepEqual(out.seam.files['pnpm-lock.yaml'], ['lockfile']);
  const ws = classifyJson(['apps/web/a.ts', 'packages/ui/b.ts', 'services/api/c.ts', 'libs/core/d.ts', 'tools/e.ts', 'f.ts', '.github/x.yml']);
  assert.deepEqual(ws.workspaces, ['apps/web', 'libs/core', 'packages/ui', 'root', 'services/api', 'tooling', 'tools']);
});

test('classify: legacy Flask python routes to no retired reviewer', () => {
  const r = routed(['legacy/flask/app/routes.py']);
  assert.ok(!r.includes('python-code-reviewer'), r);
});

// 0.33.0 — fleet downsize: no performance seat, architecture only on a seam, express
// tolerates a few workspaces, and the full cold panel needs a seam AND a CRITICAL/HIGH.
function classifyJson(args) {
  const r = run(['classify', '--compact', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('classify: a three-workspace, no-seam diff gets security only — no architecture, never performance', () => {
  const out = classifyJson([
    'packages/search-client/src/upsert/page-blocks.ts',
    'services/indexer/src/stages/embed-inline.ts',
    'infra/search-stack.ts',
  ]);
  assert.deepEqual(out.reviewers.baselines, ['security-reviewer']);
  assert.equal(out.reviewers.gates.performance.fired, false);
  assert.equal(out.express.few_workspaces, true, 'three workspaces are within the express bound');
  assert.equal(out.express.single_workspace, undefined, 'the old condition is gone');
  assert.equal(out.express.line_count, null, 'no diff → no line count');
  assert.equal(out.express.eligible, true);
});

test('classify: a seam fires architecture; four workspaces fail few_workspaces', () => {
  const seam = classifyJson(['packages/shared-types/src/x.ts', 'apps/web/app/page.tsx']);
  assert.deepEqual(seam.reviewers.baselines, ['security-reviewer', 'architecture']);
  const wide = classifyJson(['packages/a/src/a.ts', 'packages/b/src/b.ts', 'packages/c/src/c.ts', 'apps/web/lib/d.ts']);
  assert.deepEqual(wide.express.failed, ['few_workspaces']);
});

test('classify: .shipflow.json is a config seam — a diff that edits its own gates gets architecture', () => {
  assert.deepEqual(classifyJson(['.shipflow.json']).reviewers.baselines, ['security-reviewer', 'architecture']);
});

test('cold-roster: a seam without --had-high stays warm and adds the contract seat; with --had-high it is the full panel', () => {
  const warm = run(['cold-roster', '--compact', 'packages/shared-types/src/x.ts']);
  assert.equal(warm.status, 0, warm.stderr);
  const w = JSON.parse(warm.stdout);
  assert.equal(w.mode, 'warm');
  assert.ok(w.roster.includes('api-contract-reviewer'), JSON.stringify(w));
  assert.equal(w.skippable, false);
  const full = run(['cold-roster', '--compact', '--had-high', 'packages/shared-types/src/x.ts']);
  assert.equal(JSON.parse(full.stdout).mode, 'warm+cold-panel');
});

// ---- Panel cap, failure-over-time, live_check, fix-trend ----------------------------------

test('classify: five routed rows are capped to the top three; the rest go to capped_out with a note', () => {
  const out = classifyJson([
    'apps/web/app/orders/page.tsx', // frontend (65) + test-coverage (45)
    'apps/web/components/order-card.tsx', // ux (60)
    'services/api/handlers/orders.ts', // backend (77)
    'packages/shared-types/src/x.ts', // api-contract (50)
    'packages/db/src/schema/t.ts', // database-reviewer (80)
  ]);
  assert.deepEqual(out.reviewers.routed, ['database-reviewer', 'backend-reviewer', 'frontend-reviewer']);
  assert.ok(out.reviewers.capped_out.length >= 2, JSON.stringify(out.reviewers));
  assert.ok(out.reviewers.capped_out.includes('ux-consistency-lead'));
  assert.ok(out.reviewers.notes.some((n) => /panel cap 3/.test(n)), out.reviewers.notes);
  const wide = classifyJson(['--panel-cap', '10', 'apps/web/app/orders/page.tsx', 'apps/web/components/order-card.tsx', 'services/api/handlers/orders.ts', 'packages/db/src/schema/t.ts']);
  assert.ok(wide.reviewers.routed.length > 3, wide.reviewers.routed);
  assert.deepEqual(wide.reviewers.capped_out, []);
});

test('classify: --max-workspaces and --max-lines take a value (not a positional file)', () => {
  const out = classifyJson(['--max-workspaces', '5', '--max-lines', '9', 'a/b.ts']);
  assert.deepEqual(out.files, ['a/b.ts']);
  assert.equal(out.express.max_workspaces, 5);
  assert.equal(out.express.max_lines, 9);
});

/** A temp repo with one base commit; `change(root)` writes the diffed commit. */
function withDiffRepo(change, fn, config) {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  const G = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { env: G, stdio: 'pipe' });
  try {
    git('init', '-q');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 1;\n');
    if (config !== undefined) writeFileSync(join(root, '.shipflow.json'), typeof config === 'string' ? config : JSON.stringify(config));
    git('add', '-A');
    git('commit', '-qm', 'base');
    change(root);
    git('add', '-A');
    git('commit', '-qm', 'change');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const diffClassify = (root, extra = []) => classifyJson(['--cwd', root, '--diff', 'HEAD~1..HEAD', ...extra]);

test('failure-over-time: a prod diff adding FOR UPDATE SKIP LOCKED fires the gate and the baseline', () => {
  withDiffRepo(
    (root) => writeFileSync(join(root, 'src', 'worker.ts'), "export const x = 1;\nconst q = sql`SELECT id FROM jobs FOR UPDATE SKIP LOCKED`;\n"),
    (root) => {
      const out = diffClassify(root);
      const g = out.reviewers.gates.failure_over_time;
      assert.equal(g.fired, true, JSON.stringify(g));
      assert.ok(g.terms.includes('SKIP LOCKED') && g.terms.includes('FOR UPDATE'), g.terms);
      assert.deepEqual(g.files, ['src/worker.ts']);
      assert.ok(out.reviewers.baselines.includes('failure-over-time'));
    },
  );
});

test('failure-over-time: blockId / unlock / clock do not fire, nor does a docs-only diff, nor a removed-then-safe line', () => {
  withDiffRepo(
    (root) => writeFileSync(join(root, 'src', 'worker.ts'), 'export const blockId = 1;\nconst unlockAt = clock();\n'),
    (root) => {
      const out = diffClassify(root);
      assert.equal(out.reviewers.gates.failure_over_time.fired, false, JSON.stringify(out.reviewers.gates.failure_over_time));
      assert.ok(!out.reviewers.baselines.includes('failure-over-time'));
    },
  );
  withDiffRepo(
    (root) => writeFileSync(join(root, 'docs', 'queues.md'), 'Retry with backoff; the queue holds a lease.\n'),
    (root) => {
      const out = diffClassify(root);
      assert.equal(out.reviewers.gates.failure_over_time.fired, false);
      assert.ok(!out.reviewers.baselines.includes('failure-over-time'));
    },
  );
});

test('failure-over-time: without --diff the gate reports no diff', () => {
  const g = classifyJson(['src/worker.ts']).reviewers.gates.failure_over_time;
  assert.deepEqual(g, { fired: false, reason: 'no diff' });
});

test('classify: a test-only diff still carries every key', () => {
  const out = classifyJson(['src/__tests__/worker.test.ts']);
  assert.equal(out.reviewers.narrowed, 'test-only');
  assert.deepEqual(out.reviewers.capped_out, []);
  assert.deepEqual(out.reviewers.gates.failure_over_time, { fired: false, reason: 'test-only diff' });
  for (const k of ['declared', 'required', 'matched', 'instructions', 'dev_probe']) assert.ok(k in out.live_check, k);
});

const LIVE = { live_check: { paths: ['^src/'], instructions: 'Deploy to dev and exercise the changed endpoint once.', dev_probe: ['curl', '-fsS', 'https://dev.example.com/healthz'] } };

test('live_check: required when a prod file matches a declared path; read at the range start; an invalid config fails closed, never an exit', () => {
  withDiffRepo((root) => writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 2;\n'), (root) => {
    const lc = diffClassify(root).live_check;
    assert.equal(lc.declared, true);
    assert.equal(lc.required, true);
    assert.deepEqual(lc.matched, ['src/worker.ts']);
    assert.match(lc.instructions, /Deploy/);
    assert.deepEqual(lc.dev_probe, LIVE.live_check.dev_probe);
    assert.match(lc.note, /config-ref: HEAD~1/);
  }, LIVE);
  withDiffRepo((root) => writeFileSync(join(root, 'docs', 'a.md'), 'x\n'), (root) => {
    const lc = diffClassify(root).live_check;
    assert.equal(lc.declared, true);
    assert.equal(lc.required, false, 'docs never owe a live run');
  }, LIVE);
  withDiffRepo((root) => writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 2;\n'), (root) => {
    const r = run(['classify', '--compact', '--cwd', root, '--diff', 'HEAD~1..HEAD']);
    assert.equal(r.status, 0, r.stderr);
    const lc = JSON.parse(r.stdout).live_check;
    assert.equal(lc.declared, false);
    assert.equal(lc.required, true, 'a config error fails closed');
    assert.match(lc.note, /invalid|paths/);
  }, { live_check: { paths: 'src/', instructions: 'x' } });
});

test('live_check: a branch that deletes live_check still owes the run (the base copy decides); the worktree copy is a note', () => {
  withDiffRepo((root) => {
    writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 2;\n');
    writeFileSync(join(root, '.shipflow.json'), '{}');
  }, (root) => {
    const lc = diffClassify(root).live_check;
    assert.equal(lc.required, true);
    assert.match(lc.note, /differs from HEAD~1/);
    const head = diffClassify(root, ['--config-ref', 'HEAD']).live_check;
    assert.equal(head.declared, false, '--config-ref overrides the range start');
    const bad = run(['classify', '--compact', '--cwd', root, '--diff', 'HEAD~1..HEAD', '--config-ref', 'no-such-ref']);
    assert.equal(bad.status, 0, bad.stderr);
    const out = JSON.parse(bad.stdout);
    assert.equal(out.live_check.required, true, 'a ref error fails closed');
    assert.ok(out.reviewers.notes.some((n) => /panel cap not applied/.test(n)), out.reviewers.notes);
  }, LIVE);
  const files = classifyJson(['src/worker.ts']).live_check;
  assert.match(files.note, /config-ref: worktree/);
});

const triage = (round, n, high, extra = {}) =>
  JSON.stringify({ stage: 'triage', round, bucket1_fix_now: n, ...(high === undefined ? {} : { bucket1_high: high }), rereview_mode: 'warm', ...extra });

test('fix-trend: replan only when HIGH > 0 and neither must-fix nor HIGH fell', () => {
  assert.equal(fixTrend([triage(1, 4, 2), triage(2, 4, 2)].join('\n')).replan, true);
  assert.equal(fixTrend([triage(1, 4, 2), triage(2, 5, 3)].join('\n')).replan, true);
  assert.equal(fixTrend([triage(1, 4, 2), triage(2, 2, 2)].join('\n')).replan, false, 'must-fix fell');
  // CW M1: 4 HIGH -> 1 HIGH + 4 ADJACENT MEDIUM: must-fix rose, HIGH fell
  assert.equal(fixTrend([triage(1, 4, 4), triage(2, 5, 1)].join('\n')).replan, false);
  // MEDIUM-only growth never re-plans
  assert.equal(fixTrend([triage(1, 3, 0), triage(2, 4, 0)].join('\n')).replan, false);
  assert.match(fixTrend([triage(1, 4), triage(2, 5)].join('\n')).reason, /without bucket1_high/);
  assert.equal(fixTrend([triage(1, 4), triage(2, 5)].join('\n')).replan, false);
  const one = fixTrend(triage(1, 4, 1));
  assert.equal(one.replan, false);
  assert.deepEqual(one.rounds, [{ round: 1, must_fix: 4, high: 1, rereview_mode: 'warm' }]);
});

test('fix-trend: no comparison after warm+cold-panel, across a scope expansion, or on the seam-extension round', () => {
  const cold = [triage(1, 2, 1, { rereview_mode: 'warm+cold-panel' }), triage(2, 4, 2)].join('\n');
  assert.equal(fixTrend(cold).replan, false);
  assert.match(fixTrend(cold).reason, /warm\+cold-panel/);
  const scope = [triage(1, 2, 1), JSON.stringify({ stage: 'note', event: 'scope-expansion', round: 1 }), triage(2, 4, 2)].join('\n');
  assert.equal(fixTrend(scope).replan, false);
  assert.match(fixTrend(scope).reason, /scope-expansion/);
  const seam = [triage(1, 2, 1), JSON.stringify({ stage: 'fix-seam-extension', round: 2, seam_round: 1 }), triage(2, 4, 2)].join('\n');
  assert.equal(fixTrend(seam).replan, false);
  assert.match(fixTrend(seam).reason, /seam-extension/);
  // another phase's scope expansion does not suppress this phase
  const other = [triage(1, 2, 1, { epic_phase: 'p7' }), JSON.stringify({ stage: 'note', event: 'scope-expansion', epic_phase: 'p6' }), triage(2, 4, 2, { epic_phase: 'p7' })].join('\n');
  assert.equal(fixTrend(other, 'p7').replan, true);
});

test('fix-trend: at most one re-plan per phase; a numeric epic_phase matches its --epic-phase string', () => {
  const replanNote = (extra = {}) => JSON.stringify({ stage: 'note', event: 'fix-replan', round: 2, ...extra });
  // sf-log JSON-parses k=v values, so epic_phase=7 lands as a number
  const phased = [triage(1, 4, 2, { epic_phase: 7 }), triage(2, 4, 2, { epic_phase: 7 })];
  const fresh = fixTrend(phased.join('\n'), '7');
  assert.equal(fresh.replan, true);
  assert.equal(fresh.replan_already_taken, false);
  const taken = fixTrend([...phased, replanNote({ epic_phase: 7 }), triage(3, 4, 2, { epic_phase: 7 })].join('\n'), '7');
  assert.equal(taken.replan_already_taken, true);
  assert.equal(taken.replan, false);
  assert.match(taken.reason, /already re-planned/);
  // another phase's re-plan does not count against this one
  const other = fixTrend([...phased, replanNote({ epic_phase: 6 })].join('\n'), '7');
  assert.equal(other.replan_already_taken, false);
  assert.equal(other.replan, true);
  // single-task run: any fix-replan note counts
  const single = fixTrend([triage(1, 4, 2), replanNote(), triage(2, 4, 2)].join('\n'));
  assert.equal(single.replan_already_taken, true);
  assert.equal(single.replan, false);
});

test('fix-trend: two triage rows for one round count once (the last); --epic-phase filters', () => {
  const log = [triage(1, 4, 1), triage(2, 1, 1), triage(2, 4, 1), triage(1, 9, 3, { epic_phase: 'p7' }), triage(2, 1, 1, { epic_phase: 'p7' })].join('\n');
  const single = fixTrend(log, '');
  assert.deepEqual(single.rounds.map((r) => [r.round, r.must_fix]), [[1, 4], [2, 4]]);
  assert.equal(single.replan, true);
  const p7 = fixTrend(log, 'p7');
  assert.deepEqual(p7.rounds.map((r) => [r.round, r.must_fix]), [[1, 9], [2, 1]]);
  assert.equal(p7.replan, false);
  // CLI form: --log / --epic-phase are value flags; no file list needed
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    const f = join(dir, 'run.jsonl');
    writeFileSync(f, `${log}\nnot json\n`);
    const r = run(['fix-trend', '--compact', '--log', f, '--epic-phase', 'p7']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).replan, false);
    assert.equal(run(['fix-trend']).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Round-1 fixes: trigger recall, withheld content, panel cap --------------------------

const FOT_POSITIVE = [
  'await queue.send(new SendMessageCommand({ QueueUrl, MessageBody }));',
  'new SendMessageBatchCommand(input)',
  'new ReceiveMessageCommand(input)',
  'new ChangeMessageVisibilityCommand(input)',
  "await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);",
  'const maxRetries = 3;',
  'const MAX_RETRIES = 3;',
  'await withRetry(fn);',
  'await retryWithBackoff(fn);',
  'if (isRetryable(e)) return;',
  'retryCount += 1;',
  'await acquireLock(id);',
  "db.select().from(t).for('update');",
  'const queueUrl = env.QUEUE_URL;',
  'await context.step("x", fn);',
  'await branchCtx.step("x", fn);',
  'export const pipeline = new DurablePipelineV2();',
  'deadLetterQueue: dlq,',
  'await setVisibilityTimeout(30);',
  'const ok = isIdempotent(req);',
  'await claimLease(id);',
  'for (const q of queues) {}',
  'await Promise.allSettled(pages.map(dispatch));',
  'await ctx.waitForCallback("x");',
  'MessageGroupId: id,',
  'SELECT id FROM jobs FOR UPDATE SKIP LOCKED',
  'await db.transaction(async (tx) => {});',
  "SELECT pg_try_advisory_lock(1)",
  'const locked = isLocked(row);',
  'retried after throttling',
  'const h = new DLQHandler();',
];
const FOT_NEGATIVE = ['export const blockId = 1;', 'const unlockAt = clock();', 'const doc: BlockDoc = buildBlockDoc(b);', 'Advisory Circular 43.13-1B applies'];

test('failure-over-time: idiomatic camelCase / snake_case / dotted forms fire; blockId, unlock, clock, BlockDoc do not', async () => {
  const { failureOverTimeTermsIn } = await import('../sf-route.mjs');
  for (const line of FOT_POSITIVE) assert.ok(failureOverTimeTermsIn(line).length > 0, `should fire: ${line}`);
  for (const line of FOT_NEGATIVE) assert.deepEqual(failureOverTimeTermsIn(line), [], `should not fire: ${line}`);
  // end to end through classify --diff
  withDiffRepo(
    (root) => writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 1;\nawait queue.send(new SendMessageCommand({ QueueUrl, MessageBody }));\n'),
    (root) => {
      const out = diffClassify(root);
      assert.equal(out.reviewers.gates.failure_over_time.fired, true, JSON.stringify(out.reviewers.gates.failure_over_time));
      assert.ok(out.reviewers.baselines.includes('failure-over-time'));
    },
  );
});

test('failure-over-time: a committed *.ts -diff attribute neither hides the lines nor zeroes the line count', () => {
  withDiffRepo(
    (root) => {
      writeFileSync(join(root, '.gitattributes'), '*.ts -diff\n');
      writeFileSync(join(root, 'src', 'worker.ts'), 'export const x = 1;\nretry(lock);\n');
    },
    (root) => {
      const out = diffClassify(root);
      const g = out.reviewers.gates.failure_over_time;
      assert.equal(g.fired, true, JSON.stringify(g));
      assert.deepEqual(g.files, ['src/worker.ts']);
      // one line in .gitattributes + the one added worker.ts line
      assert.equal(out.express.line_count, 2);
      assert.deepEqual(out.seam.files['.gitattributes'], ['config']);
    },
  );
});

test('classify: a baseline never spends a cap slot (auth + db + handler + stack → 3 domain seats + security)', () => {
  const files = ['apps/web/auth/session.ts', 'packages/db/src/schema/a.ts', 'services/api/handlers/x.ts', 'infra/lib/stacks/s-stack.ts'];
  const out = classifyJson(files);
  assert.deepEqual(out.reviewers.routed, ['database-reviewer', 'backend-reviewer', 'infra-reviewer']);
  assert.ok(!out.reviewers.routed.includes('security-reviewer'));
  assert.ok(!out.reviewers.capped_out.includes('security-reviewer'));
  assert.ok(out.reviewers.baselines.includes('security-reviewer'));
  assert.equal(run(['classify', '--panel-cap', '0', 'a.ts']).status, 2);
});

test('classify: review.cap_exempt seats are uncapped', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, '.shipflow.json'), JSON.stringify({ review: { cap_exempt: ['ux-consistency-lead'] } }));
    const out = classifyJson(['--cwd', root, 'apps/web/app/orders/page.tsx', 'apps/web/components/order-card.tsx', 'services/api/handlers/orders.ts', 'packages/shared-types/src/x.ts', 'packages/db/src/schema/t.ts']);
    assert.deepEqual(out.reviewers.routed, ['database-reviewer', 'backend-reviewer', 'frontend-reviewer', 'ux-consistency-lead']);
    assert.ok(!out.reviewers.capped_out.includes('ux-consistency-lead'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classify: an unreadable .shipflow.json lifts the panel cap (fails closed) with a note', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, '.shipflow.json'), '{ not json');
    const out = classifyJson(['--cwd', root, 'apps/web/app/orders/page.tsx', 'apps/web/components/order-card.tsx', 'services/api/handlers/orders.ts', 'packages/shared-types/src/x.ts', 'packages/db/src/schema/t.ts']);
    assert.ok(out.reviewers.routed.includes('ux-consistency-lead'), out.reviewers.routed);
    assert.ok(out.reviewers.routed.length > 3, out.reviewers.routed);
    assert.deepEqual(out.reviewers.capped_out, []);
    assert.ok(out.reviewers.notes.some((n) => /panel cap not applied/.test(n)), out.reviewers.notes);
    assert.equal(out.live_check.required, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The 3b decomposition: sf-route computes the batches, sf-log validates them.
const SF_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sf-log.mjs');

function batchesCli(tasks, extra = []) {
  return spawnSync(process.execPath, [SF_ROUTE, 'batches', '--tasks', '-', '--compact', ...extra], { encoding: 'utf8', input: JSON.stringify(tasks) });
}

test('batches: two independent tasks with disjoint scopes form one parallel batch', () => {
  const { batches } = planBatches([
    { id: 'S1', scope: ['scripts/a.mjs'] },
    { id: 'S2', scope: ['scripts/b.mjs', 'scripts/__tests__/b.test.mjs'] },
  ]);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].tasks.map((t) => t.id), ['S1', 'S2']);
  assert.equal(batches[0].seam_touched, false);
  assert.equal(batches[0].parallelizable, true);
  assert.equal(batches[0].parallelizable_reason, ALL_HOLD);
});

test('batches: a seam task lands as a serial batch, then the rest of the layer runs in parallel', () => {
  const { batches } = planBatches([
    { id: 'S1', scope: ['scripts/a.mjs'] },
    { id: 'S2', scope: ['packages/shared-types/src/x.ts'] },
    { id: 'S3', scope: ['scripts/c.mjs'] },
  ]);
  assert.deepEqual(batches.map((b) => [b.id, b.tasks.map((t) => t.id), b.seam_touched, b.parallelizable, b.parallelizable_reason]), [
    ['B1', ['S2'], true, false, 'seam touched'],
    ['B2', ['S1', 'S3'], false, true, ALL_HOLD],
  ]);
});

test('batches: dependent tasks go to a later layer; an id naming no input task counts as done', () => {
  const { batches } = planBatches([
    { id: 'S1', scope: ['scripts/a.mjs'], depends_on: ['P0'] },
    { id: 'S2', scope: ['scripts/b.mjs'] },
    { id: 'S3', scope: ['scripts/c.mjs'], depends_on: ['S1', 'S2'] },
  ]);
  assert.deepEqual(batches.map((b) => [b.tasks.map((t) => t.id), b.parallelizable_reason]), [
    [['S1', 'S2'], ALL_HOLD],
    [['S3'], 'fewer than 2 independent tasks'],
  ]);
  assert.deepEqual(batches[0].tasks[0].depends_on, ['P0'], 'depends_on is carried into the event');
  assert.equal('depends_on' in batches[0].tasks[1], false);
});

test('batches: a depends_on id naming no input task is reported in unresolved_depends_on', () => {
  const mistyped = planBatches([
    { id: '1', scope: ['scripts/a.mjs'] },
    { id: '2', scope: ['scripts/b.mjs'], depends_on: ['step-1', '1'] },
    { id: '3', scope: ['scripts/c.mjs'], depends_on: ['P0'] },
  ]);
  assert.deepEqual(mistyped.unresolved_depends_on, [{ task: '2', id: 'step-1' }, { task: '3', id: 'P0' }]);
  const resolved = planBatches([{ id: '1', scope: ['scripts/a.mjs'] }, { id: '2', scope: ['scripts/b.mjs'], depends_on: ['1'] }]);
  assert.deepEqual(resolved.unresolved_depends_on, []);
  const r = batchesCli([{ id: '1', scope: ['scripts/a.mjs'], depends_on: ['step-0'] }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).unresolved_depends_on, [{ task: '1', id: 'step-0' }]);
});

test('batches: scope paths are compared in canonical form (leading ./ stripped)', () => {
  const seam = planBatches([
    { id: 'S1', scope: ['scripts/a.mjs'] },
    { id: 'S2', scope: ['./packages/shared-types/src/a.ts'] },
    { id: 'S3', scope: ['scripts/c.mjs'] },
  ]).batches;
  assert.deepEqual(seam.map((b) => [b.tasks.map((t) => t.id), b.seam_touched, b.parallelizable_reason]), [
    [['S2'], true, 'seam touched'],
    [['S1', 'S3'], false, ALL_HOLD],
  ]);
  assert.deepEqual(seam[0].tasks[0].scope, ['packages/shared-types/src/a.ts'], 'the batch carries the canonical path');
  const overlap = planBatches([{ id: 'S1', scope: ['./scripts/b.mjs'] }, { id: 'S2', scope: [' scripts/b.mjs'] }]).batches;
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].parallelizable, false);
  assert.equal(overlap[0].parallelizable_reason, 'scopes overlap');
  const route = planBatches([{ id: 'S1', scope: ['app/[id]/page.tsx'] }, { id: 'S2', scope: ['app/(org)/page.tsx'] }]).batches;
  assert.equal(route[0].parallelizable_reason, ALL_HOLD, 'route-segment brackets are file paths');
});

test('batches verb: a scope entry that is not one repository-relative file path exits 2', () => {
  const cases = [
    ['a directory', 'scripts/', /names a directory/],
    ['a star glob', 'scripts/*.mjs', /is a glob/],
    ['a question-mark glob', 'scripts/?.mjs', /is a glob/],
    ['a brace glob', 'scripts/{a,b}.mjs', /is a glob/],
    ['an absolute path', '/scripts/a.mjs', /is absolute/],
    ['a parent segment', 'scripts/../scripts/a.mjs', /"\.\." segment/],
    ['a blank entry', '  ', /is empty/],
    ['a bare ./', './', /is empty/],
    ['an interior . segment', 'scripts/./a.mjs', /"\." segment/],
    ['a repeated leading ./', '././scripts/a.mjs', /"\." segment/],
    ['a bare .', '.', /"\." segment/],
    ['a trailing . segment', 'scripts/.', /"\." segment/],
    ['an empty segment', 'scripts//a.mjs', /empty segment/],
    ['whitespace after the leading ./', './ scripts/a.mjs', /whitespace after the leading \.\//],
    ['a backslash', 'packages\\shared-types\\src\\a.ts', /holds a backslash/],
  ];
  for (const [what, entry, re] of cases) {
    const r = batchesCli([{ id: 'a', scope: ['scripts/a.mjs'] }, { id: 'b', scope: [entry] }]);
    assert.equal(r.status, 2, `${what}: ${r.stdout}`);
    assert.match(r.stderr, re, what);
    assert.match(r.stderr, /task b: scope entry/, what);
    assert.equal(r.stdout, '', what);
  }
});

test('batches verb: a scope entry carrying a line reference or markup exits 2', () => {
  // A finding's `file:` line is path:line; copied verbatim it hides a shared file and a seam file.
  const r = batchesCli([
    { id: 'a', scope: ['package.json:12'] },
    { id: 'b', scope: ['src/a.ts:10'] },
    { id: 'c', scope: ['src/a.ts:40'] },
  ]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /task a: scope entry "package\.json:12" holds a ":"/);
  assert.equal(r.stdout, '');
  const cases = [
    ['line:col', 'src/a.ts:10:4', /holds a ":"/],
    ['a line range', 'src/a.ts:10-20', /holds a ":"/],
    ['a line list', 'src/a.ts:10,12', /holds a ":"/],
    ['an :L<line> suffix', 'src/a.ts:L10', /holds a ":"/],
    ['a trailing colon', 'src/a.ts:40:', /holds a ":"/],
    ['a range on a seam file', 'package.json:10-20', /holds a ":"/],
    ['a #L<line> suffix', 'src/a.ts#L10', /ends in a #L<line> suffix/],
    ['a #L<line> suffix on a seam file', 'package.json#L3', /ends in a #L<line> suffix/],
    ['a parenthesised note', 'src/a.ts (line 40)', /ends in a parenthesised note/],
    ['a backticked path', '`src/a.ts`', /holds a backtick/],
  ];
  for (const [what, entry, re] of cases) {
    const refused = batchesCli([{ id: 'a', scope: ['scripts/a.mjs'] }, { id: 'b', scope: [entry] }]);
    assert.equal(refused.status, 2, `${what}: ${refused.stdout}`);
    assert.match(refused.stderr, re, what);
    assert.match(refused.stderr, /task b: scope entry/, what);
    assert.equal(refused.stdout, '', what);
  }
});

test('batches: an interior space, a [id] segment, a # and an interior parenthesis are accepted', () => {
  const scope = ['docs/release notes/a.md', 'app/fleet/[id]/page.tsx', 'docs/c#/a.md', 'docs/a (copy).md'];
  const { batches } = planBatches([{ id: 'S1', scope }, { id: 'S2', scope: ['scripts/b.mjs'] }]);
  assert.deepEqual(batches[0].tasks[0].scope, scope);
  assert.equal(batches[0].parallelizable_reason, ALL_HOLD);
});

test('batches: overlapping scopes keep the batch serial and unsplit; no scratch worktrees fails first', () => {
  const tasks = [{ id: 'S1', scope: ['scripts/a.mjs'] }, { id: 'S2', scope: ['scripts/a.mjs', 'scripts/b.mjs'] }];
  const overlap = planBatches(tasks).batches;
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].parallelizable, false);
  assert.equal(overlap[0].parallelizable_reason, 'scopes overlap');
  assert.equal(planBatches(tasks, { scratch: false }).batches[0].parallelizable_reason, 'no scratch worktrees');
});

test('batches: an entry that is a directory prefix of another task\'s entry overlaps it', () => {
  for (const tasks of [
    [{ id: 'S1', scope: ['scripts'] }, { id: 'S2', scope: ['scripts/a.mjs'] }],
    [{ id: 'S1', scope: ['scripts/lib/a.mjs'] }, { id: 'S2', scope: ['scripts/lib'] }],
  ]) {
    const { batches } = planBatches(tasks);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].parallelizable, false);
    assert.equal(batches[0].parallelizable_reason, 'scopes overlap');
  }
  const siblings = planBatches([{ id: 'S1', scope: ['scripts/a'] }, { id: 'S2', scope: ['scripts/a.mjs', 'scripts/ab/c.mjs'] }]).batches;
  assert.equal(siblings[0].parallelizable_reason, ALL_HOLD, 'a shared name prefix is not a directory prefix');
  const own = planBatches([{ id: 'S1', scope: ['scripts/lib', 'scripts/lib/a.mjs'] }, { id: 'S2', scope: ['scripts/b.mjs'] }]).batches;
  assert.equal(own[0].parallelizable_reason, ALL_HOLD, 'a prefix inside one task is not overlap');
});

test('batches verb: --no-scratch yields "no scratch worktrees" on every batch, seam batch included', () => {
  const tasks = [
    { id: 'S1', scope: ['scripts/a.mjs'] },
    { id: 'S2', scope: ['package.json'] },
    { id: 'S3', scope: ['scripts/c.mjs'] },
  ];
  const r = batchesCli(tasks, ['--no-scratch']);
  assert.equal(r.status, 0, r.stderr);
  const { batches } = JSON.parse(r.stdout);
  assert.deepEqual(batches.map((b) => [b.seam_touched, b.parallelizable, b.parallelizable_reason]), [
    [true, false, 'no scratch worktrees'],
    [false, false, 'no scratch worktrees'],
  ]);
});

test('batches verb: a cycle, a duplicate id, an empty scope, unreadable JSON and a missing --tasks exit 2', () => {
  const cases = [
    ['a cycle', [{ id: 'a', scope: ['x.mjs'], depends_on: ['b'] }, { id: 'b', scope: ['y.mjs'], depends_on: ['a'] }], /cycle.*a, b/],
    ['a duplicate id', [{ id: 'a', scope: ['x.mjs'] }, { id: 'a', scope: ['y.mjs'] }], /duplicate task id a/],
    ['an empty scope', [{ id: 'a', scope: [] }], /task a: scope/],
  ];
  for (const [what, tasks, re] of cases) {
    const r = batchesCli(tasks);
    assert.equal(r.status, 2, `${what}: ${r.stdout}`);
    assert.match(r.stderr, re, what);
    assert.equal(r.stdout, '', what);
  }
  const bad = spawnSync(process.execPath, [SF_ROUTE, 'batches', '--tasks', '-'], { encoding: 'utf8', input: '{ not json' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot read tasks/);
  const none = run(['batches']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--tasks/);
});

test('batches output is accepted by sf-log stage task-decomposition (producer / validator pair)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  try {
    const log = join(dir, 'run.jsonl');
    writeFileSync(log, '');
    const tasks = [
      { id: 'S1', scope: ['scripts/a.mjs'] },
      { id: 'S2', scope: ['packages/shared-types/src/x.ts'] },
      { id: 'S3', scope: ['scripts/c.mjs'] },
      { id: 'S4', scope: ['scripts/a.mjs'], depends_on: ['S1'] },
    ];
    for (const extra of [[], ['--no-scratch']]) {
      const r = batchesCli(tasks, extra);
      assert.equal(r.status, 0, r.stderr);
      const { batches } = JSON.parse(r.stdout);
      const logged = spawnSync(process.execPath, [SF_LOG, 'stage', 'task-decomposition', `batches=${JSON.stringify(batches)}`], {
        encoding: 'utf8',
        env: { ...process.env, RUN_LOG: log, SF_RUN_TASK: 'unit' },
      });
      assert.equal(logged.status, 0, logged.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
