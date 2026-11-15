import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeProjectChecks, normalizeStopCorrectionConfig } from '../lib/runtime-v2/stop-correction-config.mjs';
import { runProjectChecks } from '../lib/runtime-v2/project-checks.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';

const population = { metrics: { M13: [{ objectId: 'M13:public-acceptance' }] } };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=rc-test',
  '-c', 'user.email=rc-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, windowsHide: true, stdio: 'pipe' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-project-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const contract = '# Public project rules\nRun the configured check for acceptance.\n';
  await fs.writeFile(path.join(root, 'README.md'), contract);
  await fs.writeFile(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  git(root, 'init', '-q'); git(root, 'add', 'README.md', 'source.mjs'); git(root, 'commit', '-qm', 'task start');
  const control = path.join(root, '.runtime-correction'); await fs.mkdir(control);
  const marker = path.join(control, 'executions.txt');
  const config = overrides => ({ id: 'project-contract', metrics: ['M13'], source: { path: 'README.md',
    sha256: sha256(contract), start: 2, end: 2 }, command: [process.execPath, '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); console.log('actual checker result')`], ...overrides });
  const run = (checks = [config()], extra = {}) => runProjectChecks({ projectRoot: root,
    checks: normalizeProjectChecks(checks), population, cacheDirectory: path.join(control, 'checks'), ...extra });
  return { root, control, marker, config, run };
}

test('project checks require explicit source-bound configuration and round-trip through the public schema', () => {
  const value = { id: 'contract', command: ['node', 'tools/check.mjs'], metrics: ['M13'],
    source: { path: 'README.md', sha256: 'a'.repeat(64), start: 1, end: 2 } };
  const configured = normalizeStopCorrectionConfig({ projectChecks: [value] });
  assert.equal(normalizeStopCorrectionConfig({}).projectChecks, undefined);
  assert.deepEqual(normalizeProjectChecks(configured.projectChecks), configured.projectChecks);
  assert(Object.isFrozen(configured.projectChecks[0].command));
  validateProjectConfig({ version: 2, artifacts: [], dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, projectChecks: [value] } }, 'config.yaml');
  for (const checks of [null, [value, value], [{ ...value, id: 1 }], [{ ...value, enabled: null }],
    [{ ...value, command: 'node tools/check.mjs' }], [{ ...value, command: [] }],
    [{ ...value, cwd: '../outside' }], [{ ...value, shell: true }], [{ ...value, metrics: ['M16'] }],
    [{ ...value, source: { ...value.source, path: '../rules.md' } }],
    [{ ...value, source: { ...value.source, end: 0 } }],
    [{ ...value, source: { ...value.source, sha256: 'unknown' } }],
    [{ ...value, source: { ...value.source, sha256: ['a'.repeat(64)] } }],
    [{ ...value, inputs: null }], [{ ...value, inputs: [{ path: '../outside', sha256: 'a'.repeat(64) }] }],
    [{ ...value, inputs: [{ path: 'check.mjs', sha256: 'a'.repeat(64) }, { path: 'check.mjs', sha256: 'a'.repeat(64) }] }]])
    assert.throws(() => normalizeProjectChecks(checks), /projectChecks/u);
});

test('only selected enabled checks execute; current inputs and source bind actual cached outcomes', async t => {
  const f = await fixture(t);
  assert.equal(await f.run([], {}), null);
  assert.equal(await f.run([f.config({ enabled: false })]), null);
  assert.equal(await f.run(undefined, { population: { metrics: { M16: [{}] } } }), null);
  assert.equal(await f.run(undefined, { population: { ...population, reviewPolicy: { metrics: { M13: false } } } }), null);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  const first = (await f.run()).checks[0], cached = (await f.run()).checks[0];
  assert.equal(first.status, 'PASSED'); assert.equal(first.executionConfirmed, true);
  assert.equal(first.exitCode, 0); assert.match(first.outputTail, /actual checker result/u);
  assert.equal(cached.cached, true); assert.equal(await fs.readFile(f.marker, 'utf8'), 'x');
  await fs.writeFile(path.join(f.root, 'source.mjs'), 'export const value = 2;\n');
  const changed = (await f.run()).checks[0];
  assert.equal(changed.cached, false); assert.notEqual(changed.key, first.key);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'xx');
  await fs.appendFile(path.join(f.root, 'README.md'), 'Changed source contract.\n');
  const unavailable = (await f.run()).checks[0];
  assert.equal(unavailable.reason, 'SOURCE_CHANGED'); assert.equal(unavailable.executionConfirmed, false);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'xx');
});

test('real failures and bounded timeout attempts retain their evidence without an acceptance verdict', async t => {
  const f = await fixture(t);
  const failure = await f.run([f.config({ command: [process.execPath, '-e', "console.log('checker failed'); process.exit(3)"] })]);
  assert.equal(failure.checks[0].status, 'FAILED'); assert.equal(failure.checks[0].exitCode, 3);
  assert.equal(failure.checks[0].executionConfirmed, true); assert.match(failure.checks[0].outputTail, /checker failed/u);
  assert.equal(failure.status, undefined, 'command outcomes do not synthesize overall acceptance');
  const timeout = (await f.run([f.config({ command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1000 })])).checks[0];
  assert.equal(timeout.status, 'UNAVAILABLE'); assert.equal(timeout.reason, 'TIMEOUT');
  assert.equal(timeout.timedOut, true); assert.equal(timeout.executionConfirmed, false);
  const attempts = await Promise.all((await fs.readdir(path.join(f.control, 'checks'))).filter(name => name.startsWith('attempt-'))
    .map(async name => JSON.parse(await fs.readFile(path.join(f.control, 'checks', name), 'utf8'))));
  assert(attempts.some(value => value.reason === 'TIMEOUT' && value.timedOut));
});

test('a cached command result cannot retire a changed selected acceptance premise', async t => {
  const f = await fixture(t), checks = [f.config({ metrics: ['M13', 'M14', 'M15'] })];
  const first = (await f.run(checks)).checks[0];
  const revised = { metrics: { M13: [{ ...population.metrics.M13[0], sourceRevisionId: 'public-acceptance@2',
    description: 'Execute for this revised acceptance premise.' }] } };
  const next = (await f.run(checks, { population: revised })).checks[0];
  assert.equal(next.cached, false); assert.notEqual(next.scopeDigest, first.scopeDigest);
  assert.deepEqual(next.objectIds, ['M13:public-acceptance'], 'unselected acceptance metrics add no obligations');
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'xx');
  assert.equal((await f.run(checks, { population: revised })).checks[0].cached, true);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'xx');
});

test('pinned original checker files cannot be replaced before or during a successful command', async t => {
  const f = await fixture(t), file = path.join(f.root, 'checker.mjs');
  const script = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(f.marker)}, 'original'); console.log('original verifier');\n`;
  await fs.writeFile(file, script);
  const pinned = f.config({ command: [process.execPath, 'checker.mjs'], inputs: [{ path: 'checker.mjs', sha256: sha256(script) }] });
  assert.equal((await f.run([pinned])).checks[0].status, 'PASSED');
  await fs.writeFile(file, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(f.marker)}, 'bypass'); process.exit(0);`);
  const changed = (await f.run([pinned])).checks[0];
  assert.equal(changed.reason, 'CHECKER_INPUT_CHANGED'); assert.equal(changed.executionConfirmed, false);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'original');
  // The control tree is intentionally absent from the ordinary candidate
  // digest. Explicit pins must still detect changes to a verifier stored there.
  const controlFile = path.join(f.control, 'original-checker.mjs');
  await fs.writeFile(controlFile, 'original verification bytes');
  const midRun = f.config({ id: 'changes-pinned-checker', inputs: [{ path: '.runtime-correction/original-checker.mjs',
    sha256: sha256('original verification bytes') }], command: [process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(controlFile)}, 'modified verifier'); console.log('exit zero anyway')`] });
  const result = (await f.run([midRun])).checks[0];
  assert.equal(result.exitCode, 0); assert.equal(result.reason, 'CHECKER_INPUT_CHANGED');
  assert.equal(result.executionConfirmed, false);
});

test('a mutating checker invalidates its binding and accounts for unstarted siblings', async t => {
  const f = await fixture(t);
  const mutation = f.config({ id: 'mutates-input', command: [process.execPath, '-e',
    "require('node:fs').writeFileSync('source.mjs', 'export const value = 99;'); console.log('completed')"] });
  const value = await f.run([mutation, f.config()]);
  assert.equal(value.checks.length, 2);
  assert(value.checks.every(check => check.reason === 'INPUT_CHANGED' && check.executionConfirmed === false));
  assert.equal(value.checks[0].exitCode, 0, 'keep the actual exit while rejecting the stale binding');
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('deadline and real-path containment checks prevent unapproved launches', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(undefined, { deadlineAt: Date.now() + 100 })).checks[0].reason, 'STOP_DEADLINE');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-project-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run([f.config({ cwd: 'escape' })])).checks[0].reason, 'PATH_OUTSIDE_PROJECT');
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
});

test('cancellation never launches before admission and preserves an interrupted attempt after launch', async t => {
  const f = await fixture(t), early = new AbortController(); early.abort(new Error('owner stopped'));
  await assert.rejects(f.run(undefined, { signal: early.signal }), /owner stopped/u);
  await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
  const active = new AbortController();
  const running = f.run([f.config({ command: [process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(f.marker)}, 'started'); setInterval(() => {}, 1000)`] })], { signal: active.signal });
  for (let n = 0; n < 200 && !await fs.stat(f.marker).catch(() => null); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'started');
  active.abort(new Error('owner stopped during execution'));
  await assert.rejects(running, /owner stopped during execution/u);
  const attempts = await Promise.all((await fs.readdir(path.join(f.control, 'checks'))).filter(name => name.startsWith('attempt-'))
    .map(async name => JSON.parse(await fs.readFile(path.join(f.control, 'checks', name), 'utf8'))));
  assert(attempts.some(value => value.reason === 'CANCELLED' && value.executionConfirmed === false));
});

test('Stop defers configured execution outside the native call and exposes attributable command evidence', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  await fs.unlink(f.input.request.groundTruthPath);
  const rules = 'Before reporting completion, run the configured project acceptance command.\n';
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), rules);
  git(f.root, 'init', '-q'); git(f.root, 'add', 'spec.md', 'AGENTS.md'); git(f.root, 'commit', '-qm', 'original project');
  const transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, [{ type: 'user', uuid: 'user-original', message: { content: rules.trim() } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }].map(JSON.stringify).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, stopCorrection: {
    enabled: true, originalRequirementsBasis: true, deviationOnly: false, metrics: { M13: true, M16: false },
    projectChecks: [{ id: 'public-acceptance', metrics: ['M13'], source: { path: 'AGENTS.md', sha256: sha256(rules), start: 1, end: 1 },
      command: [process.execPath, '-e', "console.log('actual configured project execution')"] }] } });
  let observed = false, deferred = false, failure;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async api => {
      try {
        await api.readAll();
        const user = api.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const original = (await api.read(user)).details.citation.citeId;
        if (api.brief.attempt === 1) await api.submit('set_original_checklist', { items: [{ metricId: 'M13',
          text: rules.trim(), verificationTarget: 'PROCESS', citeId: original, lineStart: 1, lineEnd: 1 }] });
        const checklist = await api.submit('review_checklist', api.brief.attempt === 1
          ? { stopClassification: 'TASK_COMPLETE', completionClaim: true, includeProcessEvidence: true }
          : { includeProcessEvidence: true });
        if (checklist.deferred) { deferred = true; return; }
        const evidence = checklist.programEvidenceFiles.find(file => path.basename(file).startsWith('project-check-public-acceptance-'));
        assert(evidence, 'native reviewer must receive the actual configured execution record');
        const read = await api.read(evidence);
        assert.match(read.content.map(block => block.text ?? '').join('\n'), /actual configured project execution/u);
        const object = checklist.items.find(item => item.metricId === 'M13');
        await api.submit('submit_review', { taskId: object.taskId, verdict: 'PASS',
          reason: 'The configured acceptance command actually completed for this unchanged candidate.', citeIds: [read.details.citation.citeId] });
        await api.submit('finish_stop_review', { summary: 'Reviewed the actual project command result.' });
        observed = true;
      } catch (error) { failure = error; throw error; }
    });
  };
  const event = name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'project-check-stop', startProtocol: { version: 1 } },
    input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: name,
      last_assistant_message: 'Task complete.', ...(name === 'SessionStart' ? { source: 'startup' } : {}) } });
  await event('SessionStart');
  const result = await event('Stop');
  if (failure) throw failure;
  assert(deferred && observed);
  assert(result.stop.review.metricObjectJudgements.some(row => row.objectId.startsWith('M13:') && row.judgement === 'PASS'));
});
