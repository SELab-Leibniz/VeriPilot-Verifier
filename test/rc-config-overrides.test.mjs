import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSimpleYaml } from '../lib/simple-yaml.mjs';
import { applyRcConfigOverrides, deepMerge, emitSimpleYaml, loadRcConfigOverrides, regressionCheckPolicy, substitutePlaceholders } from '../scripts/bench/rc-config-overrides.mjs';
import { regressionCheckOverride, regressionVerdict } from '../scripts/bench/arkts-regression-check.mjs';

const base = `# comment kept only without overrides
enabled: true
reviewers:
  defaults:
    model: "custom/deepseek-v4-flash"
stopCorrection:
  enabled: true
  waitMode: "assessment"
  maxCorrectionsPerSession: 1
  metrics:
    M08: true
    M09: false
artifactCorrection:
  paths: ["openspec/**"]
`;

test('deep merge replaces arrays and scalars and merges objects without mutating inputs', () => {
  const left = { a: { b: 1, c: [1, 2], d: { e: true } }, keep: 'x' }, right = { a: { c: [3], d: { f: null } }, add: 2 };
  assert.deepEqual(deepMerge(left, right), { a: { b: 1, c: [3], d: { e: true, f: null } }, keep: 'x', add: 2 });
  assert.deepEqual(left, { a: { b: 1, c: [1, 2], d: { e: true } }, keep: 'x' });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: 'scalar' }), { a: 'scalar' });
});

test('overrides reach the business config through the product YAML subset; none keeps bytes', async t => {
  assert.deepEqual(applyRcConfigOverrides(base, null), { text: base, applied: null });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-overrides-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'overrides.json');
  await fs.writeFile(file, '\uFEFF' + JSON.stringify({ ...regressionCheckOverride, stopCorrection: { ...regressionCheckOverride.stopCorrection,
    waitMode: 'until_pass', maxCorrectionsPerSession: 3, metrics: { M09: true } } }));
  const overrides = await loadRcConfigOverrides(file);
  assert.match(overrides.sha256, /^[0-9a-f]{64}$/u);
  const variables = { node: 'C:\\node\\node.exe', harnessRoot: 'C:\\h', projectRoot: 'C:\\b\\biz-1', toolRoot: 'C:\\tools', javaHome: 'C:\\jbr' };
  const { text, applied } = applyRcConfigOverrides(base, overrides, variables);
  const parsed = parseSimpleYaml(text);
  assert.deepEqual(parsed.stopCorrection, { enabled: true, waitMode: 'until_pass', maxCorrectionsPerSession: 3, metrics: { M08: true, M09: true },
    regressionCheck: { enabled: true, command: ['C:\\node\\node.exe', 'C:\\h/scripts/bench/arkts-regression-check.mjs', '--project=C:\\b\\biz-1',
      '--tool-root=C:\\tools', '--java-home=C:\\jbr'], cwd: 'C:\\b\\biz-1', timeoutMs: 900000 } });
  assert.deepEqual(parsed.artifactCorrection, { paths: ['openspec/**'] });
  assert.equal(applied.file, file);
  assert.deepEqual(applied.value.stopCorrection.regressionCheck, parsed.stopCorrection.regressionCheck);
  assert.throws(() => applyRcConfigOverrides(base, overrides, { ...variables, javaHome: undefined }), /\$\{javaHome\}/u);
  await fs.writeFile(file, '{}');
  await assert.rejects(loadRcConfigOverrides(file), /non-empty JSON object/u);
  assert.equal(await loadRcConfigOverrides(undefined), null);
});

test('the released template and the ArkTS run config survive an override round trip', async () => {
  const template = await fs.readFile(new URL('../.runtime-corrector-default/config.yaml', import.meta.url), 'utf8');
  const { text } = applyRcConfigOverrides(template, { file: 'x.json', sha256: 'x', value: { stopCorrection: { waitMode: 'until_pass' } } });
  const before = parseSimpleYaml(template), after = parseSimpleYaml(text);
  assert.deepEqual(after, deepMerge(before, { stopCorrection: { waitMode: 'until_pass' } }));
  const { renderArktsRunConfig, arktsRunProfile } = await import('../scripts/bench/arkts-run-profile.mjs');
  const rendered = renderArktsRunConfig('openai/deepseek-v4-flash', arktsRunProfile('600000'), { enabled: true, baseline: false, originalRequirementsBasis: true, deviationOnly: true });
  const merged = parseSimpleYaml(emitSimpleYaml(deepMerge(parseSimpleYaml(rendered), { stopCorrection: before.stopCorrection })));
  assert.deepEqual(merged.stopCorrection, deepMerge(parseSimpleYaml(rendered).stopCorrection, before.stopCorrection));
});

test('the emitter refuses shapes the product parser cannot read back', () => {
  assert.equal(emitSimpleYaml({ list: [{ id: 'a', nested: { x: 1 } }], empty: [] }), 'list:\n  - id: "a"\n    nested:\n      x: 1\nempty: []\n');
  assert.throws(() => emitSimpleYaml({ a: {} }), /Empty YAML mappings/u);
  assert.throws(() => emitSimpleYaml({ a: [[1]] }), /Nested YAML sequences/u);
  assert.throws(() => emitSimpleYaml({ 'bad key': 1 }), /Unsupported YAML key/u);
  assert.throws(() => substitutePlaceholders('${missing}', {}), /missing/u);
});

test('regressionCheck is validated by the harness and reported as dropped while the product ignores it', () => {
  const configured = { enabled: true, command: ['node', 'check.mjs'], cwd: 'C:\\b', timeoutMs: 1000 };
  assert.deepEqual(regressionCheckPolicy(configured, undefined), { configured, effective: null, honoredByProduct: false });
  assert.deepEqual(regressionCheckPolicy(configured, configured), { configured, effective: configured, honoredByProduct: true });
  assert.equal(regressionCheckPolicy(undefined, undefined), null);
  for (const invalid of [{ ...configured, command: [] }, { ...configured, command: 'node check.mjs' }, { ...configured, timeoutMs: 0 }, { ...configured, extra: 1 }])
    assert.throws(() => regressionCheckPolicy(invalid), /regressionCheck must be/u);
});

test('regression verdict counts only regressions and new failures against a complete baseline', () => {
  const run = statuses => ({ freshReport: true, finished: true, completeRuntime: true, statuses, counts: {},
    failures: Object.entries(statuses).filter(([, status]) => status !== 'PASS').map(([id, status]) => ({ id, status })) });
  const baseline = run({ a: 'PASS', b: 'FAIL', c: 'PASS' });
  assert.deepEqual(regressionVerdict(run({ a: 'PASS', b: 'FAIL', c: 'PASS' }), baseline),
    { status: 'PASS', exitCode: 0, names: ['- known FAIL b'], line: 'RC_REGRESSION_CHECK PASS tests=3 passed=2 failed=1 regressions=0 newFailures=0 knownFailures=1' });
  const failed = regressionVerdict(run({ a: 'FAIL', b: 'FAIL', c: 'PASS', d: 'ERROR' }), baseline);
  assert.equal(failed.status, 'FAIL');
  assert.deepEqual(failed.names, ['- FAIL a', '- ERROR d', '- known FAIL b']);
  assert.equal(regressionVerdict(run({ a: 'FAIL' }), null).line, 'RC_REGRESSION_CHECK FAIL tests=1 passed=0 failed=1 baseline=none');
  assert.equal(regressionVerdict({ ...run({}), completeRuntime: false }, null).status, 'INCOMPLETE');
  assert.equal(regressionVerdict(run(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`t${index}`, 'FAIL']))), null, 5).names.at(-1), '- ... 25 more');
});
