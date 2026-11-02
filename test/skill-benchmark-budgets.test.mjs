import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { skillBenchmarkBudgets, skillBenchmarkPolicy } from '../scripts/helpers/skill-benchmark-budgets.mjs';
import { nativeGatewayCodingProvider } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

test('actual Skill-only configuration retains finite 24-hour and 2000-step budgets throughout', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-long-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), skillBenchmarkPolicy());
  const plan = await loadConfig({ cwd: root, pluginRoot: fileURLToPath(new URL('../', import.meta.url)) });
  const v = plan.runtimeV2;
  assert.equal(v.skillCorrection.enabled, true);
  assert.equal(v.dynamicGroundTruth.enabled, false);
  assert.equal(v.artifactCorrection.groundTruthReviewEnabled, false);
  assert.equal(v.implementationCorrection.enabled, false);
  assert.equal(v.reviewers.skillReviewer.timeoutMs, 86400000);
  assert.equal(v.reviewers.skillReviewer.maxSteps, 2000);
  assert.equal(v.reviewers.skillReviewer.maxAttempts, 2000);
  assert.equal(v.reviewers.stopReviewer.maxSteps, 2000);
  assert.equal(v.reviewers.stopReviewer.timeoutMs, 86400000);
  assert.equal(v.stopCorrection.assessmentTimeoutMs, 86400000);
  assert.equal(v.stopCorrection.maxCorrectionsPerSession, 2000);
  assert.equal(v.skillCorrection.maxWatchTurns, 2000);
  assert.deepEqual(Object.keys(v.stopCorrection.metrics).filter(id => v.stopCorrection.metrics[id]), ['M08']);
  assert.throws(() => skillBenchmarkBudgets(86400001, 2000));
  assert.throws(() => skillBenchmarkBudgets(86400000, 0));
  assert.equal(skillBenchmarkBudgets(7200000, 500).maxSteps, 500);
});

test('24-hour provider budget and light GLM reasoning reach the native host definition', () => {
  const provider = nativeGatewayCodingProvider({ api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash' }, 128000, 86400000);
  assert.equal(provider.definition.timeoutSeconds, 86400);
  assert.equal(provider.definition.models[0].reasoning, true);
  assert.equal(provider.definition.models[0].compat.supportsReasoningEffort, true);
  const relay = { api: 'openai-completions', baseUrl: 'http://host.docker.internal:30123/v1', model: 'glm-5.3-flash' };
  assert.throws(() => nativeGatewayCodingProvider(relay));
  assert.equal(nativeGatewayCodingProvider(relay, 128000, 86400000, { allowLocalRelay: true }).definition.timeoutSeconds, 86400);
});

test('the existing M08 terminal executor accepts more than the old 200-turn ceiling with configured 2000 steps', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.reviewer.maxSteps = 2000; f.input.reviewer.maxAttempts = 2000;
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  const handle = await f.run(async ({ advance, readAll, read, submit }) => {
    for (let step = 0; step < 250; step++) advance();
    await readAll(); await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Configured budget fixture completed.' });
    const actual = await read(f.file);
    await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'Current original source read.', citeIds: [actual.details.citation.citeId], finish: true });
  });
  const raw = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'result.json'), 'utf8'));
  assert.equal(raw.completed, true);
  assert.equal(raw.limits.maxTurns, 2000);
  assert.equal(raw.limits.maxAttempts, 2000);
  assert(raw.turns > 200);
});
