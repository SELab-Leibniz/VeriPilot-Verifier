import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveMaxOutputTokens } from '../lib/agent-output.mjs';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { loadRuntimePlan } from '../lib/runtime-plan.mjs';
import { withNativeMaxOutputTokens } from '../lib/openclaw/native-config.mjs';

test('every reviewer defaults to 32K and follows role > defaults > project precedence', () => {
  for (const version of [1, 2]) {
    for (const reviewer of Object.values(compileRuntimeV2Config({ version }).reviewers))
      assert.equal(reviewer.maxOutputTokens, 32768);
    const project = compileRuntimeV2Config({ version, maxOutputTokens: 48000 });
    for (const reviewer of Object.values(project.reviewers)) assert.equal(reviewer.maxOutputTokens, 48000);
    const overrides = compileRuntimeV2Config({ version, maxOutputTokens: 48000,
      reviewers: { defaults: { maxOutputTokens: 24000 }, stopReviewer: { maxOutputTokens: 65536 } } });
    assert.equal(overrides.maxOutputTokens, 48000);
    for (const [role, reviewer] of Object.entries(overrides.reviewers))
      assert.equal(reviewer.maxOutputTokens, role === 'stopReviewer' ? 65536 : 24000);
  }
});

test('schema and direct compilation reject invalid output limits at every level', () => {
  for (const invalid of [null, 0, -1, 1.5, '32768', true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveMaxOutputTokens(invalid), /positive safe integer/);
    for (const config of [{ maxOutputTokens: invalid }, { reviewers: { defaults: { maxOutputTokens: invalid } } },
      { reviewers: { stopReviewer: { maxOutputTokens: invalid } } }]) {
      assert.throws(() => validateProjectConfig({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: true }, ...config }, 'config.yaml'), /maxOutputTokens/);
      assert.throws(() => compileRuntimeV2Config(config), /maxOutputTokens/);
    }
  }
});

test('project YAML preserves output limits through discovery and compilation in v1 and v2', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-output-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  for (const version of [1, 2]) {
    const reviewers = version === 2 ? 'reviewers:\n  stopReviewer:\n    maxOutputTokens: 65536\n' : '';
    await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: ${version}\nartifacts:\n  - name: document\n    patterns: [item.md]\nmaxOutputTokens: 49152\n${reviewers}`);
    const plan = await loadRuntimePlan({ cwd: root });
    assert.equal(plan.maxOutputTokens, 49152);
    assert.equal(plan.runtimeV2.reviewers.groundTruthExtractor.maxOutputTokens, 49152);
    assert.equal(plan.runtimeV2.reviewers.stopReviewer.maxOutputTokens, version === 2 ? 65536 : 49152);
  }
});

test('native output settings preserve unrelated model parameters and the host config', () => {
  const host = { agents: { list: [{ id: 'main', params: { max_tokens: 2048, temperature: 0.2 } }, { id: 'other', params: { maxTokens: 500 } }], defaults: { compaction: { mode: 'safeguard' }, models: {
    'provider/model': { alias: 'review', params: { temperature: 0.3, maxTokens: 8192 } },
    'other/model': { params: { maxTokens: 1024 } },
  } } } };
  const original = structuredClone(host);
  const run = withNativeMaxOutputTokens(host, 'provider', 'model', 65536, 'main');
  assert.deepEqual(host, original);
  assert.deepEqual(run.agents.defaults.models['provider/model'], { alias: 'review', params: { temperature: 0.3, maxTokens: 65536 } });
  assert.deepEqual(run.agents.defaults.models['other/model'], host.agents.defaults.models['other/model']);
  assert.equal(run.agents.list[0].params.maxTokens, 65536);
  assert.equal(run.agents.list[0].params.temperature, 0.2);
  assert.deepEqual(run.agents.list[1], host.agents.list[1]);
  assert.equal(withNativeMaxOutputTokens({}, 'provider', 'model').agents.defaults.models['provider/model'].params.maxTokens, 32768);
});
