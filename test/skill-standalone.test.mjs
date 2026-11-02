import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { sharedBasisFixture } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { skillE2eOptions, skillE2ePolicy } from '../scripts/evaluate-skill-e2e.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';

async function standalone(t) {
  const f = await sharedBasisFixture(t);
  f.plan.runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    skillCorrection: { enabled: true, skillRoots: ['skills'], selection: { mode: 'include', include: ['demo'] } },
    stopCorrection: { enabled: false }, reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000 } } },
  { policyRoot: `${f.root}/.runtime-corrector` });
  f.state.useNativeGraph = true;
  return f;
}

test('standalone Skill establishes and checks its graph without global extraction or a fake task baseline', async t => {
  const f = await standalone(t);
  const selection = await f.select();
  assert.equal(selection.watcher.status, 'ACTIVE', JSON.stringify(selection));
  assert.equal(f.graphs().length, 1);
  assert.equal(f.globals().length, 0);
  assert.equal(f.audits().length, 0);
  assert.equal((await f.truth()).version, 0);
  assert((await fs.readFile(await f.graphFile(), 'utf8')).includes('Verify before completion.'));
  const stopped = await f.invoke('Stop', { last_assistant_message: 'The task is complete.' });
  assert(f.calls.some(call => call.role === 'skill-reviewer'), JSON.stringify(stopped));
  assert.equal(f.globals().length, 0);
  assert.equal(Object.values((await f.task()).watchers)[0].status, 'PASS', JSON.stringify(stopped));
});

test('standalone Skill discards a graph when the original changes during model extraction', async t => {
  const f = await standalone(t);
  f.state.graphNativeScript = async ({ result }) => {
    await fs.appendFile(f.skillFile, '\nNever publish credentials.\n');
    return result;
  };
  const selection = await f.select();
  assert.equal(selection.reason, 'SKILL_WATCH_NOT_ESTABLISHED');
  assert.equal(selection.watcher.status, 'UNVERIFIED');
  await assert.rejects(fs.access(await f.graphFile()), { code: 'ENOENT' });
  assert.equal((await f.truth()).version, 0);
});

test('Skill-only Stop preparation retains its task identity when global extraction is disabled', async t => {
  const f = await standalone(t), runtime = f.plan.runtimeV2;
  f.plan.runtimeV2 = { ...runtime, stopCorrection: { ...runtime.stopCorrection, enabled: true,
    fileQualityReviewEnabled: false, metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
      [`M${String(i + 1).padStart(2, '0')}`, i === 7])) } };
  await f.select();
  const stopped = await f.invoke('Stop', { last_assistant_message: 'The task is complete.' });
  assert(f.calls.some(call => call.role === 'skill-reviewer'), JSON.stringify(stopped));
  assert(f.calls.some(call => call.role === 'stop-reviewer'), JSON.stringify(stopped));
  assert(!JSON.stringify(stopped).includes("Cannot read properties of undefined (reading 'taskId')"));
  assert.equal(f.globals().length, 0);
});

test('standalone Skill keeps uncertain original interpretation unverified', async t => {
  const f = await standalone(t);
  await f.select();
  f.state.semanticDisposition = 'UNCERTAIN';
  await f.invoke('Stop', { last_assistant_message: 'The task is complete.' });
  assert.equal(Object.values((await f.task()).watchers)[0].status, 'UNVERIFIED');
  assert.equal(f.globals().length, 0);
});

test('Skill-only configuration keeps distinct configurable reviewer and assessment deadlines', async t => {
  const f = await standalone(t);
  await fs.mkdir(`${f.root}/.runtime-corrector`, { recursive: true });
  const options = skillE2eOptions(['--role-timeout-ms', '720000', '--assessment-timeout-ms', '1200000', '--wall-ms', '2400000']);
  const file = `${f.root}/.runtime-corrector/config.yaml`;
  await fs.writeFile(file, skillE2ePolicy(options));
  const plan = await loadConfig({ cwd: f.root });
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, false);
  assert.equal(plan.runtimeV2.reviewers.skillReviewer.timeoutMs, 720000);
  assert.equal(plan.runtimeV2.stopCorrection.assessmentTimeoutMs, 1200000);
  assert.deepEqual(Object.entries(plan.runtimeV2.stopCorrection.metrics).filter(([, enabled]) => enabled).map(([id]) => id), ['M08']);
  await fs.writeFile(file, skillE2ePolicy(options).replace('    M01: false', '    M01: true'));
  await assert.rejects(loadConfig({ cwd: f.root }), /requires dynamicGroundTruth/);
  for (const args of [['--role-timeout-ms', '0'], ['--wall-ms', 'NaN'], ['--assessment-timeout-ms', '1000']])
    assert.throws(() => skillE2eOptions(args));
});
