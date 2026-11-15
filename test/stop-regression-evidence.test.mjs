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
  regressionFailureInventory, regressionNavigation, renderRegressionRun, runStopRegressionCheck, renderRegressionEvidence } from '../lib/runtime-v2/regression-evidence.mjs';
import { captureTaskStart, taskChanges } from '../lib/runtime-v2/task-changes.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { runProtocolTask } from '../lib/review-task/protocol-task.mjs';

test('regression navigation distinguishes restored tests without authorizing their failures', () => {
  const evidence = { changes: [], testPointers: [] };
  const run = { status: 'FAILED', exitCode: 1, command: ['node', 'C:\\release\\scripts\\bench\\arkts-regression-check.mjs', '--original-tests'],
    outputTail: 'not ok 1 - retains an existing guard\n# fail 1\n' };
  const before = regressionFailureInventory(run);
  const restored = regressionNavigation({ evidence, run });
  assert.deepEqual(restored.programRun.testSource, { mode: 'TASK_START_PUBLIC_TESTS', currentTestEditsExecuted: false });
  assert.match(renderRegressionRun(run), /testSource: .*TASK_START_PUBLIC_TESTS/);
  assert.deepEqual(regressionFailureInventory(run), before);
  assert.equal(before.failures.length, 1);

  const current = { ...run, command: run.command.slice(0, 2) };
  assert.deepEqual(regressionNavigation({ evidence, run: current }).programRun.testSource,
    { mode: 'CURRENT_PUBLIC_TESTS', currentTestEditsExecuted: true });
  const unrelated = { ...run, command: ['node', 'other-check.mjs', '--original-tests'], outputTail: 'suite=task-start\n' };
  assert.deepEqual(regressionNavigation({ evidence, run: unrelated }).programRun.testSource,
    { mode: 'CONFIGURED_COMMAND', currentTestEditsExecuted: null });
});

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
const cases = [
  [16, 2, 'should map policy minLength 16 to its option'],
  [99, DEFAULT_INDEX, 'should set minLengthIndex to default when policy minLength not in options'],
];
let failed = 0;
for (const [index, [minLength, expected, name]] of cases.entries()) {
  const vm = new SettingsViewModel();
  vm.applyPolicy({ minLength });
  const passed = vm.minLengthIndex === expected;
  if (!passed) failed++;
  console.log((passed ? 'ok ' : 'not ok ') + (index + 1) + ' - ' + name);
}
console.log('# fail ' + failed);
process.exitCode = failed > 0 ? 1 : 0;
`;
const REQUEST = 'Add a 24-character option to the password length options in src/settings.mjs.';
const AUTHORIZED_FALLBACK = 'Use index -1 for unsupported lengths.';
const OLD_FALLBACK = 'assert.equal(vm.minLengthIndex, DEFAULT_INDEX);';
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

async function regressionStop(t, { broken = true, regressionCheck, script, request = REQUEST, mutateProject, afterStart,
  deviationOnly = true, beforeReview }) {
  const f = await stopProtocolFixture(t, 'findings');
  await fs.unlink(f.input.request.groundTruthPath);
  await project(f.root, { broken: broken && !afterStart });
  await mutateProject?.(f.root);
  if (!broken) await fs.writeFile(path.join(f.root, 'README.md'), '# Settings\n\nPassword options.\n');
  const transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, [{ type: 'user', uuid: 'user-original', message: { content: request } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly, ...(regressionCheck ? { regressionCheck } : {}) } });
  let failure;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async api => {
      try {
        await beforeReview?.(f.root, api.brief.attempt);
        await api.readAll();
        const userPath = api.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const original = (await api.read(userPath)).details.citation.citeId;
        if (api.brief.attempt === 1) await api.submit('set_original_checklist', { items: [{ metricId: 'M16', text: 'Offer a 24-character password length option.',
          verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', citeId: original, lineStart: 1, lineEnd: 1 }] });
        const checklist = await api.submit('review_checklist', api.brief.attempt === 1 ? SCOPE : { limit: 20 });
        if (checklist.deferred) return;
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
  if (afterStart) {
    assert.equal(await captureTaskStart({ projectRoot: f.root, taskId: f.task.taskId }), true);
    if (broken) await fs.writeFile(path.join(f.root, 'src/settings.mjs'), BROKEN);
    await afterStart(f.root);
  }
  const result = await event('Stop');
  if (failure) throw failure;
  return { f, result };
}

const standingPopulation = { metrics: { M16: [{ objectId: 'M16:standing-x', metricId: 'M16', programStanding: STANDING_REGRESSION }] } };

test('complete review runs original regression before the first model scope and retains each failure', async t => {
  let observedBeforeModel = false;
  const { f, result } = await regressionStop(t, { deviationOnly: false,
    regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'], maxOutputBytes: 2048 },
    beforeReview: async (root, attempt) => {
      if (attempt !== 1) return;
      // The fixture's actual task ID is obtained from the prepared task tree,
      // not from a guessed model-selected scope.
      const tasks = await fs.readdir(path.join(root, '.runtime-correction', 'tasks'));
      const files = (await Promise.all(tasks.map(async name => {
        const dir = path.join(root, '.runtime-correction', 'tasks', name, 'regression-check');
        return (await fs.readdir(dir).catch(() => [])).filter(x => x.endsWith('.json')).map(x => path.join(dir, x));
      }))).flat();
      assert.equal(files.length, 1);
      const run = JSON.parse(await fs.readFile(files[0], 'utf8'));
      assert.equal(run.status, 'FAILED');
      assert.match(run.outputTail, /not ok 2 - should set minLengthIndex/u);
      observedBeforeModel = true;
    },
    script: async ({ standing, checklist, submit, cite }) => {
      assert(standing, 'complete review must retain the standing regression item');
      assert.equal(standing.regressionEvidence.programRun.status, 'FAILED');
      const current = await cite('src/settings.mjs'), original = await cite('test/settings.test.mjs');
      for (const item of checklist.items) if (item.taskId !== standing.taskId)
        await submit('submit_review', { taskId: item.taskId, verdict: 'UNVERIFIED', reason: 'This fixture reviews only the preserved fallback contract.' });
      await submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION', citeIds: [current, original],
        reason: 'Unsupported lengths no longer use the original DEFAULT_INDEX; the original test and setup were not rewritten.' });
      const failures = standing.regressionEvidence.programRun.failureInventory.failures;
      return { regressionCheck: { status: 'REVIEWED', reason: 'Original preserved fallback fails.', cases: failures.map(x => ({
        id: x.id, verdict: 'REGRESSION', objectId: standing.taskId, reason: 'The request adds one option and does not replace the unsupported-input fallback.' })) } };
    } });
  assert(observedBeforeModel);
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert(result.stop.review.metricObjectJudgements.some(row => row.objectId.startsWith('M16:standing-') && row.judgement === 'DEVIATION'));
  assert(result.stop.review.regressionCheck.cases.some(row => row.verdict === 'REGRESSION'));
  assert.match(result.stop.feedback, /DEVIATION M16:standing-/u);
  assert.equal(await fs.readFile(path.join(f.root, 'test/settings.test.mjs'), 'utf8'), TESTS);
});

test('an early original-test result cannot certify a candidate changed before model review', async t => {
  let reachedReview = false;
  const { result } = await regressionStop(t, { deviationOnly: false,
    regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'], maxOutputBytes: 2048 },
    beforeReview: async (root, attempt) => {
      if (attempt === 1) await fs.writeFile(path.join(root, 'src/settings.mjs'), SOURCE);
    },
    script: async () => { reachedReview = true; assert.fail('A stale regression result must not reach substantive review.'); },
  });
  assert.equal(reachedReview, false);
  assert.equal(result.stop.status, 'UNVERIFIED');
  assert.match(result.stop.reasonCode, /INPUT_CHANGED/u, JSON.stringify({reason:result.stop.reasonCode,review:result.stop.review}));
});

test('a cancelled tool submission cannot start its deferred completion check', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-cancelled-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const abort = new AbortController();
  let checked = false;
  await assert.rejects(runProtocolTask({
    task: { basisFiles: [] }, root, workspaceRoot: root, outputDir: root, deadlineAt: Date.now() + 10_000,
    limits: { maxTurns: 10, maxAttempts: 1, maxTokens: 1024 },
    nativeRun: async worker => {
      const finish = worker.tools.find(tool => tool.name === 'finish');
      await assert.rejects(finish.execute('cancelled-finish', {}, abort.signal), { name: 'AbortError' });
      assert.equal(worker.isComplete(), false);
    },
    definition: { prompt: 'Fictional cancelled submission.', tools: () => [{
      name: 'finish', parameters: { type: 'object', properties: {}, additionalProperties: false },
      submit(_value, ctx) {
        ctx.deferCompletion(async () => { checked = true; });
        abort.abort();
        return { saved: true };
      },
    }] },
  }), { code: 'TASK_NO_VALID_SUBMISSION' });
  assert.equal(checked, false);
});

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
    const linkedMethod = hint.currentSemanticLinks.find(link => link.definition.kind === 'method');
    assert.equal(linkedMethod?.definition.path, hint.changedFiles[0].path);
    assert.equal(linkedMethod?.test.path, hint.testPointers[0].path);
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

test('an enabled existing-test run is bounded, persisted and referenced from the standing hint', async t => {
  let runFile;
  const { f, result } = await regressionStop(t, { regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'], maxOutputBytes: 2048 },
    script: async ({ standing, submit, cite }) => {
      const run = standing.regressionEvidence.programRun;
      assert.deepEqual([run.status, run.exitCode, run.timedOut], ['FAILED', 1, false]);
      runFile = run.files[0];
      assert.equal(run.summary, `Program-run existing tests: exit 1; output at ${runFile}`);
      assert.match(path.basename(runFile), /^regression-check-0000\.txt$/u);
      const text = await fs.readFile(runFile, 'utf8');
      assert.match(text, /^status: FAILED$/mu);
      assert.match(text, /truncated: true/u);
      assert.match(text, /not ok 2 - should set minLengthIndex to default when policy minLength not in options\n# fail 1\n$/u);
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
      return { regressionCheck: { status: 'UNVERIFIED', reason: 'The existing test run did not finish.' } };
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

test('an unresolved original-test check is recorded without changing a completed zero-deviation conclusion', async t => {
  const { result, f } = await regressionStop(t, { regressionCheck: { enabled: true, command: [process.execPath, '-e', 'process.exit(2)'] },
    script: async ({ standing, submit, cite }) => {
      return { regressionCheck: { status: 'UNVERIFIED', reason: 'Exit 2 alone cannot establish a source contradiction.' } };
    } });
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND');
  assert.equal(result.stop.verificationIncomplete, true);
  assert.equal(result.stop.verificationUnavailable, false);
  assert.equal(result.stop.admission, null);
  assert.equal(result.stop.feedback, null);
  assert.deepEqual(result.stop.review.unverifiedItems, [{ id: 'regression-check', type: 'REGRESSION_CHECK',
    reason: 'Exit 2 alone cannot establish a source contradiction.' }]);
  const evaluation = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, f.task.taskId), 'evaluations', `${result.stop.evaluationId}.json`), 'utf8'));
  assert.deepEqual(evaluation.unverifiedItems, result.stop.review.unverifiedItems);
});

test('remaining regression cases accept reviewer decisions without authorization quotes or session reads', async t => {
  const { result, f } = await regressionStop(t, { request: `${REQUEST} ${AUTHORIZED_FALLBACK}`,
    regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'] },
    script: async ({ standing }) => {
      const [failure] = standing.regressionEvidence.programRun.failureInventory.failures;
      assert(failure.originalTest.context.includes(OLD_FALLBACK));
      const originalSource = (await Promise.all(failure.originalTest.sourceFiles.map(file => fs.readFile(file, 'utf8')))).join('');
      assert.equal(originalSource, TESTS, 'the program supplies the actual task-start file, not a rewritten test');
      return { regressionCheck: { status: 'EXPLAINED', reason: 'The requested fallback replaces this old expectation.',
        cases: [{ id: failure.id, verdict: 'AUTHORIZED_CHANGE', reason: 'Unsupported inputs now use the requested index.' }] } };
    } });
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND');
  assert.deepEqual(result.stop.review.unverifiedItems, []);
  assert.equal(f.calls.length, 2, 'scope preparation hands back to the same review, without a separate authorization reviewer');
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
});

test('one decided failure does not explain an omitted preserved contract, and a supported regression is dispatched', async t => {
  for (const confirmed of [false, true]) {
    const { result } = await regressionStop(t, { request: `${REQUEST} ${AUTHORIZED_FALLBACK}`,
      regressionCheck: { enabled: true, command: [process.execPath, 'tools/check.mjs'] },
      afterStart: root => fs.writeFile(path.join(root, 'src/settings.mjs'), BROKEN.replace('= index;', '= policy.minLength === 16 ? -1 : index;')),
      script: async ({ standing, submit }) => {
        const [preserved, authorized] = standing.regressionEvidence.programRun.failureInventory.failures;
        if (confirmed) await submit('submit_review', { taskId: standing.taskId, verdict: 'DEVIATION',
          citations: [{ path: 'src/settings.mjs', start: 8, end: 8 }],
          reason: 'Supported length 16 returns -1 instead of the existing index 2; only unsupported lengths were authorized to change.' });
        return { regressionCheck: { status: 'REVIEWED', reason: 'Each remaining failure is independent.', cases: [
          { id: authorized.id, verdict: 'AUTHORIZED_CHANGE', reason: 'The fallback was explicitly changed.' },
          ...(confirmed ? [{ id: preserved.id, verdict: 'REGRESSION', objectId: standing.taskId, reason: 'The supported index changed without authorization.' }] : []),
        ] } };
      } });
    assert.equal(result.stop.status, confirmed ? 'DEVIATION' : 'NO_DEVIATION_FOUND');
    assert.equal(result.stop.review.unverifiedItems.length, confirmed ? 0 : 1);
    if (!confirmed) assert.equal(result.stop.feedback, null);
  }
});

test('named regression reports need all actionable failures and ignore known failures', () => {
  const summary = 'RC_REGRESSION_CHECK FAIL tests=8 passed=5 failed=3 regressions=1 newFailures=1 knownFailures=1';
  const one = '- FAIL module::Suite::preserve saved value', two = '- ERROR module::Suite::report the unavailable service';
  const known = '- known FAIL module::Other::already broken';
  const inventory = (...lines) => regressionFailureInventory({ status: 'FAILED', outputTail: [summary, ...lines].join('\r\n') });
  assert.deepEqual(inventory(one, two, known), { complete: true, failures: [
    { id: 'module::Suite::preserve saved value', title: 'preserve saved value' },
    { id: 'module::Suite::report the unavailable service', title: 'report the unavailable service' },
  ] });
  assert.equal(inventory(one, '- ... 2 more').complete, false);
  assert.equal(inventory(one, one, known).complete, false);
  assert.equal(inventory(one, two, summary).complete, false);
  assert.deepEqual(inventory(one, two, '  public assertion: Error in preserve saved value, expect true, actualValue is false').failures[0].observedDiagnostics,
    ['expect true, actualValue is false']);
  assert.equal(regressionFailureInventory({ status: 'FAILED',
    outputTail: '    not ok 1 - original behavior\nnot ok 1 - parent suite\n# fail 1\n' }).complete, false);
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
