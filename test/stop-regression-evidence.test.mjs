import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { normalizeRegressionCheck, normalizeStopCorrectionConfig } from '../lib/runtime-v2/stop-correction-config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { STANDING_REGRESSION, STANDING_REGRESSION_TEXT, collectRegressionEvidence, regressionDeviationProblem,
  runStopRegressionCheck, renderRegressionEvidence } from '../lib/runtime-v2/regression-evidence.mjs';
import { captureTaskStart, taskChanges } from '../lib/runtime-v2/task-changes.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=rc-test', '-c', 'user.email=rc-test@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { cwd, windowsHide: true, stdio: 'pipe' }).toString();
const SOURCE = `export const OPTIONS = [8, 12, 16, 20];
export const DEFAULT_INDEX = 1;

export class SettingsViewModel {
  minLengthIndex = DEFAULT_INDEX;

  applyPolicy(policy) {
    const index = OPTIONS.indexOf(policy.minLength);
    this.minLengthIndex = index >= 0 ? index : DEFAULT_INDEX;
  }
}
`;
const BROKEN = SOURCE.replace('[8, 12, 16, 20]', '[8, 12, 16, 20, 24]').replace('index >= 0 ? index : DEFAULT_INDEX', 'index');
const TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsViewModel, DEFAULT_INDEX } from '../src/settings.mjs';

test('should map policy minLength 16 to its option', () => {
  const vm = new SettingsViewModel();
  vm.applyPolicy({ minLength: 16 });
  assert.equal(vm.minLengthIndex, 2);
});

test('should set minLengthIndex to default when policy minLength not in options', () => {
  const vm = new SettingsViewModel();
  vm.applyPolicy({ minLength: 99 });
  assert.equal(vm.minLengthIndex, DEFAULT_INDEX);
});
`;
const CHECK = `import { SettingsViewModel, DEFAULT_INDEX } from '../src/settings.mjs';
for (let line = 0; line < 4000; line++) console.log('progress line ' + line + ' of the existing suite');
const vm = new SettingsViewModel();
vm.applyPolicy({ minLength: 99 });
if (vm.minLengthIndex !== DEFAULT_INDEX) {
  console.log('not ok 2 - should set minLengthIndex to default when policy minLength not in options');
  process.exit(1);
}
console.log('ok 2 - should set minLengthIndex to default when policy minLength not in options');
`;
const REQUEST = 'Add a 24-character option to the password length options in src/settings.mjs.';
const SCOPE = { stopClassification: 'TASK_COMPLETE', completionClaim: true, limit: 20 };

async function project(root, { broken = true } = {}) {
  const files = { 'src/settings.mjs': SOURCE, 'test/settings.test.mjs': TESTS, 'tools/check.mjs': CHECK, 'README.md': '# Settings\n' };
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  git(root, 'init', '-q'); git(root, 'add', '--', ...Object.keys(files)); git(root, 'commit', '-q', '-m', 'base');
  if (broken) await fs.writeFile(path.join(root, 'src/settings.mjs'), BROKEN);
}

async function regressionStop(t, { broken = true, regressionCheck, script, request = REQUEST, mutateProject, onReviewerStart }) {
  const f = await stopProtocolFixture(t, 'findings');
  await fs.unlink(f.input.request.groundTruthPath);
  await project(f.root, { broken });
  await mutateProject?.(f.root);
  if (!broken) await fs.writeFile(path.join(f.root, 'README.md'), '# Settings\n\nPassword options.\n');
  const transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, [{ type: 'user', uuid: 'user-original', message: { content: request } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true, ...(regressionCheck ? { regressionCheck } : {}) } });
  let failure;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async api => {
      try {
        await onReviewerStart?.(f.root, input.taskId);
        await api.readAll();
        const userPath = api.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const original = (await api.read(userPath)).details.citation.citeId;
        await api.submit('set_original_checklist', { items: [{ metricId: 'M16', text: 'Offer a 24-character password length option.',
          verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', citeId: original, lineStart: 1, lineEnd: 1 }] });
        const checklist = await api.submit('review_checklist', SCOPE);
        const finish = await script({ ...api, original, checklist, standing: checklist.items.find(item => item.programStanding === STANDING_REGRESSION),
          cite: async file => (await api.read(path.isAbsolute(file) ? file : path.join(f.root, file))).details.citation.citeId });
        await api.submit('finish_stop_review', { summary: 'Scanned the scoped checklist.', ...finish });
      } catch (error) { failure = error; throw error; }
    });
  };
  const event = (name, extra = {}) => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'regression-stop', startProtocol: { version: 1 } },
    input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: name, last_assistant_message: 'Task complete.', ...extra } });
  await event('SessionStart', { source: 'startup' });
  const result = await event('Stop');
  if (failure) throw failure;
  return { f, result };
}

const standingPopulation = { metrics: { M16: [{ objectId: 'M16:standing-x', metricId: 'M16', programStanding: STANDING_REGRESSION }] } };

test('the standing regression item cites the pre-existing test and the changed code', async t => {
  const { result } = await regressionStop(t, { script: async ({ brief, standing, submit, cite }) => {
    const standingPath = brief.task.basisFiles.find(file => path.basename(file).startsWith('standing-obligations-'));
    assert.match(await fs.readFile(standingPath, 'utf8'), new RegExp(`REGRESSION \\(M16 IMPLEMENTATION/PRODUCTION, HARD\\): ${STANDING_REGRESSION_TEXT.replace(/[().]/gu, '\\$&')}`, 'u'));
    assert.equal(standing.description, STANDING_REGRESSION_TEXT);
    assert.deepEqual([standing.metricId, standing.hard, standing.authority, standing.verificationTarget, standing.implementationRole],
      ['M16', true, 'PROJECT_CONSTRAINT', 'IMPLEMENTATION', 'PRODUCTION']);
    assert.deepEqual(standing.originalSource, { kind: 'PROGRAM_STANDING', ref: 'runtime-corrector:standing-obligations',
      sha256: standing.originalSource.sha256, start: 2, end: 2 });
    const hint = standing.regressionEvidence;
    assert.deepEqual(hint.changedFiles, [{ path: 'src/settings.mjs', status: 'modified' }]);
    assert.equal(hint.testPointers[0].path, 'test/settings.test.mjs');
    assert.ok(hint.testPointers[0].identifiers.includes('minLengthIndex'), JSON.stringify(hint.testPointers));
    assert.match(hint.testPointers[0].cases[0], /^L11 should set minLengthIndex to default when policy minLength not in options$/u);
    assert.deepEqual(hint.programRun, { status: 'NOT_RUN', summary: 'No program-run existing-test check ran for this Stop.' });
    const evidence = await fs.readFile(hint.evidenceFiles[0], 'utf8');
    assert.match(evidence, /modified src\/settings\.mjs {2}hunks\(new lines\): 1-\d+/u);
    assert.match(evidence, /^-    this\.minLengthIndex = index >= 0 \? index : DEFAULT_INDEX;$/mu);
    assert.match(evidence, /^ {2}test\/settings\.test\.mjs\n {4}identifiers: .*minLengthIndex/mu);
    assert.match(evidence, /L11: should set minLengthIndex to default/u);
    const changed = await cite('src/settings.mjs'), existing = await cite('test/settings.test.mjs');
    const reason = 'applyPolicy no longer falls back to DEFAULT_INDEX for an unknown minLength, which the existing test asserts.';
    await assert.rejects(submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', reason, citeIds: [changed] }),
      error => error.code === 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' && /pre-existing behavior it breaks/u.test(error.message));
    await assert.rejects(submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', reason, citeIds: [existing] }),
      { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
    assert.deepEqual(await submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', reason, citeIds: [existing, changed] }),
      { saved: true, itemId: standing.taskId });
  } });
  assert.equal(result.stop.status, 'DEVIATION', JSON.stringify(result.stop));
  assert.equal(result.decision, 'block');
  assert.match(result.feedback, /DEFAULT_INDEX/u);
});

test('changed test setup can prove a shared production-state regression without proving production fulfillment', async t => {
  const { result } = await regressionStop(t, { broken: false,
    mutateProject: root => fs.writeFile(path.join(root, 'test/settings.test.mjs'), TESTS +
      '\nSettingsViewModel.prototype.applyPolicy = function () { this.minLengthIndex = -1; };\n'),
    regressionCheck: { enabled: true, command: [process.execPath, '--input-type=module', '-e',
      "await import('./test/settings.test.mjs'); const { SettingsViewModel, DEFAULT_INDEX } = await import('./src/settings.mjs'); const vm = new SettingsViewModel(); vm.applyPolicy({ minLength: 99 }); process.exit(vm.minLengthIndex === DEFAULT_INDEX ? 0 : 1);"] },
    script: async ({ checklist, standing, submit, cite }) => {
      assert(standing, 'A changed test that mutates shared production state must remain reviewable.');
      assert.equal(standing.regressionEvidence.programRun.status, 'FAILED');
      const changed = await cite('test/settings.test.mjs');
      const existing = await cite(standing.regressionEvidence.evidenceFiles[0]);
      const production = checklist.items.find(item => !item.programStanding);
      await assert.rejects(submit('submit_review', { taskId: production.taskId, verdict: 'DEVIATION',
        reason: 'A test edit alone cannot prove the requested production option is missing.', citeIds: [changed] }),
      { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
      await submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION',
        reason: 'The changed test replaces the shared applyPolicy method without restoring it, breaking the pre-existing default-index assertion for later callers.',
        citeIds: [changed, existing] });
    } });
  assert.equal(result.stop.status, 'DEVIATION');
  assert.match(result.feedback, /without restoring/u);
});

test('without existing non-artifact source changes no standing item or evidence is added', async t => {
  const { f } = await regressionStop(t, { broken: false, regressionCheck: { enabled: true, command: [process.execPath, '-e', 'process.exit(3)'] },
    script: async ({ brief, checklist }) => {
      assert.equal(brief.task.basisFiles.some(file => /standing-obligations|regression-/u.test(path.basename(file))), false);
      assert.deepEqual(checklist.items.map(item => item.programStanding ?? null), [null]);
      assert.equal(checklist.items.some(item => item.regressionEvidence), false);
    } });
  await assert.rejects(fs.access(path.join(taskDirectory(f.root, f.task.taskId), 'regression-check')), { code: 'ENOENT' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-none-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, { broken: false });
  const collect = (options = {}) => collectRegressionEvidence({ projectRoot: root, ...options });
  assert.deepEqual(await collect(), { available: true, triggered: false, changes: [], testPointers: [] });
  await fs.writeFile(path.join(root, 'README.md'), '# Changed docs\n');
  await fs.mkdir(path.join(root, '.runtime-correction/tasks'), { recursive: true });
  await fs.writeFile(path.join(root, '.runtime-correction/tasks/state.mjs'), 'export {};\n');
  await fs.mkdir(path.join(root, 'src/fresh'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/fresh/new.mjs'), 'export const fresh = 1;\n');
  const docs = await collect();
  assert.equal(docs.triggered, false);
  assert.deepEqual(docs.changes, [{ path: 'README.md', status: 'modified' }, { path: 'src/fresh/new.mjs', status: 'untracked' }]);
  git(root, 'add', '--', 'src/fresh/new.mjs'); git(root, 'commit', '-q', '-m', 'generated');
  await fs.mkdir(path.join(root, 'generated'), { recursive: true });
  await fs.writeFile(path.join(root, 'generated/out.mjs'), 'export const out = 1;\n');
  git(root, 'add', '--', 'generated/out.mjs'); git(root, 'commit', '-q', '-m', 'artifact');
  await fs.writeFile(path.join(root, 'generated/out.mjs'), 'export const out = 2;\n');
  assert.equal((await collect()).triggered, true);
  assert.equal((await collect({ artifacts: [{ patterns: ['generated/**'] }] })).triggered, false);
  assert.equal((await collect({ excluded: [path.join(root, 'generated')] })).triggered, false);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-nogit-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  assert.deepEqual(await collectRegressionEvidence({ projectRoot: outside }), { available: false, triggered: false, changes: [], testPointers: [] });
});

test('the existing-test run finishes before the OpenClaw private reviewer starts and its evidence reaches the standing hint', async t => {
  let runFile;
  const { f, result } = await regressionStop(t, { regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'], maxOutputBytes: 2048 },
    onReviewerStart: async (root, taskId) => {
      const cache = path.join(taskDirectory(root, taskId), 'regression-check');
      const files = await fs.readdir(cache);
      assert.equal(files.length, 1);
      assert.equal(JSON.parse(await fs.readFile(path.join(cache, files[0]), 'utf8')).status, 'FAILED');
    },
    script: async ({ standing, submit, cite }) => {
      const run = standing.regressionEvidence.programRun;
      assert.deepEqual([run.status, run.exitCode, run.timedOut], ['FAILED', 1, false]);
      runFile = run.files[0];
      assert.equal(run.summary, `Program-run existing tests: exit 1; output at ${runFile}`);
      assert.match(path.basename(runFile), /^regression-check-0000\.txt$/u);
      const text = await fs.readFile(runFile, 'utf8');
      assert.match(text, /^status: FAILED$/mu);
      assert.match(text, /truncated: true/u);
      assert.match(text, /not ok 2 - should set minLengthIndex to default when policy minLength not in options\n$/u);
      assert.ok(Buffer.byteLength(text.split('--- output tail ---\n')[1]) <= 2048);
      const changed = await cite('src/settings.mjs'), output = await cite(runFile);
      await submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', citeIds: [output, changed],
        reason: 'The existing minLengthIndex default test fails after applyPolicy stopped using DEFAULT_INDEX.' });
    } });
  assert.equal(result.stop.status, 'DEVIATION', JSON.stringify(result.stop));
  const cacheDirectory = path.join(taskDirectory(f.root, f.task.taskId), 'regression-check');
  const [cached] = await fs.readdir(cacheDirectory);
  const record = JSON.parse(await fs.readFile(path.join(cacheDirectory, cached), 'utf8'));
  assert.deepEqual([record.command, record.cwd, record.exitCode, record.timedOut, record.status, record.truncated],
    [[process.execPath, 'tools/check.mjs'], '.', 1, false, 'FAILED', true]);
  assert.ok(Number.isInteger(record.durationMs) && record.outputBytes > 100000 && Buffer.byteLength(record.outputTail) <= 2048);
  assert.ok(runFile);
});

test('a disabled or unselected regression check never runs, and an unchanged workspace reuses its result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root);
  const marker = path.join(root, '.runtime-correction', 'runs.log');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  const command = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0)`];
  const run = (config, population = standingPopulation) => runStopRegressionCheck({ projectRoot: root, config, population,
    cacheDirectory: path.join(root, '.runtime-correction', 'cache') });
  assert.equal(await run(undefined), null);
  assert.equal(await run(normalizeRegressionCheck({ enabled: false, command })), null);
  assert.equal(await run(normalizeRegressionCheck({ enabled: true, command }), { metrics: { M16: [{ objectId: 'M16:original' }] } }), null);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  const config = normalizeRegressionCheck({ enabled: true, command });
  const first = await run(config), second = await run(config);
  assert.deepEqual([first.status, first.exitCode, first.cached, second.status, second.cached], ['PASSED', 0, undefined, 'PASSED', true]);
  assert.equal(await fs.readFile(marker, 'utf8'), 'x');
  await fs.writeFile(path.join(root, 'src/settings.mjs'), BROKEN + '// changed again\n');
  assert.equal((await run(config)).cached, undefined);
  assert.equal(await fs.readFile(marker, 'utf8'), 'xx');
});

test('a prepared test result cannot be used if production source changes before scope selection', async t => {
  await regressionStop(t, {
    regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'] },
    onReviewerStart: root => fs.writeFile(path.join(root, 'src/settings.mjs'), SOURCE),
    script: async ({ standing }) => {
      assert.equal(standing.regressionEvidence.programRun.status, 'UNAVAILABLE');
      assert.match(standing.regressionEvidence.programRun.summary, /WORKSPACE_CHANGED/u);
    },
  });
});

test('a failing public requirement probe cannot be excused as an obsolete baseline assertion', async t => {
  const { result } = await regressionStop(t, {
    regressionCheck: { enabled: true, command: [process.execPath, '-e',
      "console.log('RC_REQUIREMENT_CHECK FAIL tests=1 passed=0 failed=1'); process.exit(1)"] },
    script: async ({ standing, submit, cite, original }) => {
      const output = await cite(standing.regressionEvidence.programRun.files[0]);
      const code = await cite('src/settings.mjs');
      await assert.rejects(submit('finish_stop_review', { summary: 'The original contract supersedes this result.',
        regressionCheck: { status: 'EXPLAINED', reason: 'Obsolete expected behavior.', citeIds: [output, code],
          explanations: [{ failure: 'public requirement', reason: 'Claim the prior assertion is obsolete.',
            originalCiteId: original, citeIds: [code] }] } }),
      { code: 'REVIEW_REQUIREMENT_CHECK_UNRESOLVED' });
      return { regressionCheck: { status: 'UNVERIFIED', reason: 'The public requirement is unresolved.', citeIds: [output] } };
    },
  });
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.verificationIncomplete, true);
});

test('a timed-out, unlaunched or out-of-budget check is unavailable evidence and never a deviation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root);
  const heartbeat = path.join(root, 'heartbeat.log');
  const child = `setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 50)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const started = Date.now();
  const timedOut = await runStopRegressionCheck({ projectRoot: root, population: standingPopulation,
    config: normalizeRegressionCheck({ enabled: true, command: [process.execPath, '-e', parent], timeoutMs: 1000 }) });
  assert.deepEqual([timedOut.status, timedOut.reason, timedOut.timedOut, timedOut.exitCode], ['UNAVAILABLE', 'TIMEOUT', true, null]);
  assert.ok(Date.now() - started < 10000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const size = (await fs.stat(heartbeat).catch(() => ({ size: 0 }))).size;
  assert.ok(size > 0, 'the grandchild started before the timeout');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await fs.stat(heartbeat).catch(() => ({ size: 0 }))).size, size, 'the whole process tree is killed on timeout');
  const unlaunched = await runStopRegressionCheck({ projectRoot: root, population: standingPopulation,
    config: normalizeRegressionCheck({ enabled: true, command: ['rc-definitely-missing-command-xyz'] }) });
  assert.deepEqual([unlaunched.status, unlaunched.reason], ['UNAVAILABLE', 'LAUNCH_FAILED']);
  const late = await runStopRegressionCheck({ projectRoot: root, population: standingPopulation, deadlineAt: Date.now() + 1500,
    config: normalizeRegressionCheck({ enabled: true, command: [process.execPath, '-e', 'process.exit(1)'] }) });
  assert.deepEqual([late.status, late.reason, late.durationMs], ['UNAVAILABLE', 'STOP_DEADLINE', 0]);
  const evidence = await collectRegressionEvidence({ projectRoot: root });
  const runFile = path.join(root, '.runtime-correction', 'regression-check-0000.txt');
  const citations = [{ path: path.join(root, 'src/settings.mjs'), start: 1, end: 11, readProof: { owner: 'SOURCE' } },
    { path: runFile, start: 1, end: 12, readProof: { owner: 'BASIS' } }];
  for (const run of [timedOut, unlaunched, late, { ...timedOut, status: 'PASSED', exitCode: 0 }])
    assert.match(regressionDeviationProblem({ projectRoot: root, evidence, citations, run, runFiles: [runFile] }), /pre-existing behavior/u);
  assert.equal(regressionDeviationProblem({ projectRoot: root, evidence, citations, run: { status: 'FAILED', exitCode: 1 }, runFiles: [runFile] }), null);
  await regressionStop(t, { regressionCheck: { enabled: true, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1000 },
    script: async ({ standing, submit, cite }) => {
      const run = standing.regressionEvidence.programRun;
      assert.deepEqual([run.status, run.timedOut], ['UNAVAILABLE', true]);
      assert.match(run.summary, /^Program-run existing tests unavailable \(TIMEOUT\); this is not evidence of a deviation\./u);
      const changed = await cite('src/settings.mjs'), output = await cite(run.files[0]);
      await assert.rejects(submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', citeIds: [output, changed],
        reason: 'The existing test run did not finish.' }), { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
    } }).then(({ result }) => assert.notEqual(result.stop.status, 'DEVIATION', JSON.stringify(result.stop)));
});

test('a task-start change set keeps a regression the business already committed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-regression-committed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, { broken: false });
  const taskId = 'task-committed-regression';
  assert.equal(await captureTaskStart({ projectRoot: root, taskId }), true);
  await fs.writeFile(path.join(root, 'src/settings.mjs'), BROKEN);
  git(root, 'commit', '-q', '-am', 'business change');
  assert.equal((await collectRegressionEvidence({ projectRoot: root })).triggered, false);
  const changes = await taskChanges({ projectRoot: root, taskId });
  const evidence = await collectRegressionEvidence({ projectRoot: root, taskChanges: { startHead: changes.startHead,
    changes: changes.changes.filter(change => change.owner === 'STOP').map(({ path: file, status }) => ({ path: file, status })) } });
  assert.equal(evidence.triggered, true);
  assert.equal(evidence.base, 'TASK_START');
  assert.deepEqual(evidence.changes.filter(change => change.code).map(change => [change.path, change.status]), [['src/settings.mjs', 'modified']]);
  assert.equal(evidence.testPointers[0]?.path, 'test/settings.test.mjs');
  assert.match(evidence.diffs.join('\n'), /^-\s+this\.minLengthIndex = index >= 0 \? index : DEFAULT_INDEX;$/mu);
});

test('a failed original-test check cannot finish as clean without an evidenced disposition', async t => {
  const { result } = await regressionStop(t, { regressionCheck: { enabled: true, command: [process.execPath, '-e', 'process.exit(2)'] },
    script: async ({ standing, submit, cite }) => {
      await assert.rejects(submit('finish_stop_review', { summary: 'No deviations.' }), { code: 'REVIEW_REGRESSION_CHECK_REQUIRED' });
      const output = await cite(standing.regressionEvidence.programRun.files[0]);
      await assert.rejects(submit('finish_stop_review', { summary: 'The old test is stale.', regressionCheck: {
        status: 'EXPLAINED', reason: 'The command exited 2.', citeIds: [output] } }), { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
      return { regressionCheck: { status: 'UNVERIFIED', reason: 'Exit 2 alone cannot establish a source contradiction.', citeIds: [output] } };
    } });
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.equal(result.stop.verificationIncomplete, true);
});

test('an explicitly requested behavior change can explain an old failing assertion with source evidence', async t => {
  const { result } = await regressionStop(t, { request: REQUEST + ' Use index -1 for unsupported lengths.',
    regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'], maxOutputBytes: 1024 },
    script: async ({ standing, original, submit, cite }) => {
      const source = await cite('src/settings.mjs'), existing = await cite('test/settings.test.mjs');
      const check = { status: 'EXPLAINED', reason: 'The original now requires -1 instead of the old default for unsupported 99.',
        citeIds: [await cite(standing.regressionEvidence.programRun.files[0]), source, existing] };
      await assert.rejects(submit('finish_stop_review', { summary: 'Requested behavior.', regressionCheck: check }), { code: 'REVIEW_REGRESSION_EXPLANATION_REQUIRED' });
      return { regressionCheck: { ...check, explanations: [{ failure: 'Unsupported-length default assertion',
        reason: 'The source uses indexOf, which returns the requested -1 for 99.', originalCiteId: original, citeIds: [source, existing] }] } };
    } });
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND');
});

test('edited or deleted tests retain their task-start assertions as review evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root);
  const testPath = path.join(root, 'test/settings.test.mjs');
  const assertion = 'assert.equal(vm.minLengthIndex, DEFAULT_INDEX);';
  await fs.writeFile(testPath, TESTS.replace(assertion, 'assert.equal(vm.minLengthIndex, -1);'));
  const evidence = await collectRegressionEvidence({ projectRoot: root });
  const excerpt = evidence.originalTests.find(item => item.title.includes('default'));
  assert(excerpt.body.includes(assertion));
  assert(!excerpt.body.includes('minLengthIndex, -1'));
  assert.match(renderRegressionEvidence(evidence), /Task-start public test excerpts/u);
  await fs.unlink(testPath);
  assert((await collectRegressionEvidence({ projectRoot: root })).originalTests.some(item => item.body.includes(assertion)));
});

test('related boundary contracts remain visible when many edited ordinary cases exhaust the navigation limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-boundary-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await project(root, { broken: false });
  const ordinary = Array.from({ length: 12 }, (_, index) =>
    `test('ordinary policy scenario ${index}', () => { const vm = new SettingsViewModel(); vm.applyPolicy({ minLength: 16 }); assert.equal(vm.minLengthIndex, 2); });`).join('\n');
  const boundaryCase = "test('missing payload keeps the existing fallback', () => { assert.equal(new SettingsViewModel().minLengthIndex, DEFAULT_INDEX); });";
  const original = TESTS.split("test('")[0] + ordinary + '\n' + boundaryCase + '\n';
  const file = path.join(root, 'test/settings.test.mjs');
  await fs.writeFile(file, original); git(root, 'add', '.'); git(root, 'commit', '-qm', 'many ordinary public cases and one boundary');
  await fs.writeFile(path.join(root, 'src/settings.mjs'), BROKEN);
  await fs.writeFile(file, original.replaceAll('minLengthIndex, 2', 'minLengthIndex, 3'));
  const evidence = await collectRegressionEvidence({ projectRoot: root });
  const pointer = evidence.testPointers.find(item => item.path === 'test/settings.test.mjs');
  assert.equal(pointer.cases.length, 8);
  assert(pointer.cases.some(item => item.title === 'missing payload keeps the existing fallback'));
  assert(evidence.originalTests.some(item => item.body.includes(boundaryCase)));
});

test('regressionCheck configuration is validated at normalization and by the project schema', () => {
  const stop = regressionCheck => normalizeStopCorrectionConfig({ enabled: true, regressionCheck }).regressionCheck;
  assert.equal(normalizeStopCorrectionConfig({ enabled: true }).regressionCheck, undefined);
  assert.deepEqual(stop({}), { enabled: false, cwd: '.', timeoutMs: 600000, maxOutputBytes: 65536 });
  const parsed = stop({ enabled: true, command: `node "tools/run tests.mjs" --grep 'min length'`, cwd: 'entry\\src/', timeoutMs: 5000, maxOutputBytes: 4096 });
  assert.deepEqual(parsed, { enabled: true, command: ['node', 'tools/run tests.mjs', '--grep', 'min length'], cwd: 'entry/src', timeoutMs: 5000, maxOutputBytes: 4096 });
  assert.deepEqual(stop(parsed), parsed, 'normalization is idempotent');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.command));
  for (const [value, message] of [
    [null, /regressionCheck must be an object/u],
    [[], /regressionCheck must be an object/u],
    [{ enabled: 'yes' }, /enabled must be boolean/u],
    [{ enabled: true }, /command is required/u],
    [{ enabled: true, command: [] }, /nonempty argv array/u],
    [{ enabled: true, command: ['node', ''] }, /nonempty argv array/u],
    [{ enabled: true, command: 'npm test && rm -rf build' }, /shell operators/u],
    [{ enabled: true, command: 'npm test > out.log' }, /shell operators/u],
    [{ enabled: true, command: 'echo $HOME' }, /shell operators/u],
    [{ enabled: true, command: 'node "unterminated' }, /unterminated quote/u],
    [{ enabled: true, command: 'node ""' }, /empty arguments/u],
    [{ enabled: true, command: 5 }, /argv array or a nonempty string/u],
    [{ enabled: false, command: null }, /command cannot be null/u],
    [{ enabled: true, command: ['node'], cwd: 'C:\\project' }, /relative project path/u],
    [{ enabled: true, command: ['node'], cwd: '/srv/project' }, /relative project path/u],
    [{ enabled: true, command: ['node'], cwd: 'entry/../../outside' }, /cannot leave the project root/u],
    [{ enabled: true, command: ['node'], timeoutMs: 999 }, /timeoutMs must be an integer/u],
    [{ enabled: true, command: ['node'], timeoutMs: 1.5e3 + 0.5 }, /timeoutMs must be an integer/u],
    [{ enabled: true, command: ['node'], maxOutputBytes: 10 }, /maxOutputBytes must be an integer/u],
    [{ enabled: true, command: ['node'], shell: true }, /regressionCheck\.shell is not supported/u],
  ]) assert.throws(() => stop(value), message, JSON.stringify(value));
  assert.equal(compileRuntimeV2Config({ version: 2, stopCorrection: { enabled: true, regressionCheck: { enabled: true, command: ['npm', 'test'] } } })
    .stopCorrection.regressionCheck.timeoutMs, 600000);
  const document = regressionCheck => ({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, regressionCheck } });
  validateProjectConfig(document({ enabled: true, command: ['npm', 'test'], cwd: '.', timeoutMs: 1000, maxOutputBytes: 1024 }), 'config.yaml');
  validateProjectConfig(document({ enabled: true, command: 'npm test' }), 'config.yaml');
  for (const value of [{ enabled: true, command: 5 }, { enabled: false, extra: 1 }, { enabled: true, command: ['npm'], timeoutMs: 10 },
    { enabled: true, command: 'npm test | tee log' }])
    assert.throws(() => validateProjectConfig(document(value), 'config.yaml'), /regressionCheck/u, JSON.stringify(value));
});
