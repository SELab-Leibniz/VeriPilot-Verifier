import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { arktsVerificationInstructions, createArktsBenchTools } from '../scripts/bench/native-arkts-tools.mjs';
import { serveArktsWorkerJobs } from '../scripts/bench/arkts-worker-exchange.mjs';

const temporaryRoot = await fs.realpath(os.tmpdir());

test('generated business tools load, confine navigation, and remain absent from private workers', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-generated-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'main.ets'), 'needle\n');
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root, stableNavigationRoot: process.cwd(),
    applyVerificationRunFile: path.join(root, 'controller-apply.json') });
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  assert.equal(factories.length, 2);
  assert(factories.every(factory => factory({ sessionKey: 'agent:main:runtime-corrector:private' }) === null));
  const nav = factories[0]({ sessionKey: 'agent:main:business' });
  const result = await nav.execute('nav', { action: 'grep', pattern: 'needle' });
  assert.equal(JSON.parse(result.content[0].text).hits.length, 1);
  const alternatives = JSON.parse((await nav.execute('literal', { action: 'grep', pattern: 'needle|absent' })).content[0].text);
  assert.deepEqual(alternatives.hits, []); assert.match(alternatives.hint, /pipe character is not OR/);
  await fs.writeFile(path.join(project, 'literal.ets'), 'literal|pipe\n');
  const actualPipe = JSON.parse((await nav.execute('pipe', { action: 'grep', pattern: 'literal|pipe' })).content[0].text);
  assert.equal(actualPipe.hits.length, 1); assert.equal(actualPipe.hint, undefined);
  await assert.rejects(nav.execute('escape', { action: 'ls', path: '..' }), /Outside benchmark workspace/);
  const check = factories[1]({ sessionKey: 'agent:main:business' });
  assert.equal(check.name, 'bench_check');
  assert.deepEqual(check.parameters.properties.action.enum, ['build', 'test']);
  await assert.rejects(check.execute('unknown', { action: 'acceptance' }), /Unknown check/);
});

test('the shared Apply tools block only a confined no-op edit in the exact marked run', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-apply-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const applyVerificationRunFile = path.join(root, 'apply-run.json');
  const original = 'saved order\ninitial order\n';
  await fs.mkdir(project);
  await Promise.all([fs.writeFile(path.join(project, 'main.ets'), original), fs.writeFile(path.join(root, 'outside.ets'), original)]);
  const options = { outputRoot: root, projectRoot: project, toolRoot: root, stableNavigationRoot: process.cwd() };
  const plugin = await createArktsBenchTools({ ...options, applyVerificationRunFile });
  const load = async ({ path: directory }) => (await import(pathToFileURL(path.join(directory, 'index.mjs')).href)).default;
  const generated = await load(plugin);
  const hooks = (definition, version) => {
    const registered = new Map();
    definition.register({ runtime: { version }, registerTool() {}, on: (name, handler) => registered.set(name, handler) });
    return registered;
  };
  assert.equal(hooks(generated, 'other-host').size, 0);
  const unpaired = path.join(root, 'unpaired');
  await fs.mkdir(unpaired);
  assert.equal(hooks(await load(await createArktsBenchTools({ ...options, outputRoot: unpaired })), '2026.7.1-2').size, 0);
  const sharedHooks = hooks(generated, '2026.7.1-2');
  assert.deepEqual([...sharedHooks.keys()], ['before_tool_call']);
  const check = sharedHooks.get('before_tool_call');
  const sessionKey = 'agent:main:business', runId = randomUUID(), olderRun = randomUUID();
  const context = { sessionKey, runId };
  const noOp = { oldText: 'saved order', newText: 'saved order' };
  const real = { oldText: 'initial order', newText: 'new order' };
  const event = { toolName: 'edit', runId, params: { path: 'main.ets', edits: [noOp] } };

  assert.equal(await check(event, context), undefined, 'no Apply is active before the controller writes its marker');
  await fs.writeFile(applyVerificationRunFile, JSON.stringify({ sessionKey, runId }));
  const decision = await check(event, context);
  assert.equal(decision.block, true);
  assert.match(decision.blockReason, /^RC_NOOP_TOOL_REQUEST\..*skipped.*remaining Apply tasks/u);
  assert.deepEqual(Object.keys(decision).sort(), ['block', 'blockReason']);
  assert.deepEqual(await check(event, { sessionKey }), decision, 'use the native event run when the SDK context lacks it');
  assert.deepEqual(await check({ ...event, runId: undefined }, context), decision);
  assert.equal(await fs.readFile(path.join(project, 'main.ets'), 'utf8'), original);

  for (const toolName of ['write', 'apply_patch', 'vendor.edit']) {
    assert.equal(await check({ ...event, toolName }, context), undefined);
  }
  for (const params of [
    { ...event.params, edits: [real] }, { ...event.params, edits: [noOp, real] },
    { ...event.params, path: '../outside.ets' }, { ...event.params, edits: [{ oldText: 'missing', newText: 'missing' }] },
  ]) {
    assert.equal(await check({ ...event, params }, context), undefined);
  }
  assert.equal(await check(event, { ...context, sessionKey: 'agent:main:other' }), undefined);
  assert.equal(await check(event, { ...context, runId: olderRun }), undefined);
  assert.equal(await check({ ...event, runId: olderRun }, { sessionKey }), undefined);
  assert.equal(await check({ ...event, runId: undefined }, { sessionKey }), undefined);
  await fs.writeFile(applyVerificationRunFile, JSON.stringify({ sessionKey, runId: olderRun }));
  assert.equal(await check(event, context), undefined, 'an old Apply cannot use a newer marker');
});

test('the configured acceptance action exposes only the public probe receipt', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-acceptance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const probe = path.join(root, 'public-acceptance.ets');
  await fs.mkdir(project);
  await fs.writeFile(probe, 'public probe fixture\n');
  const testIds = ['entry::publicAcceptance::generates valid puzzles'];
  const sha256 = 'a'.repeat(64);
  const applyVerificationRunFile = path.join(root, 'apply-run.json');
  await fs.writeFile(applyVerificationRunFile, JSON.stringify({ runId: randomUUID(), sessionKey: 'agent:main:business' }));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root,
    stableNavigationRoot: process.cwd(), applyVerificationRunFile, publicAcceptance: { probe, sha256, testIds } });
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  assert(factories.every(factory => factory({ sessionKey: 'agent:main:runtime-corrector:private' }) === null));
  const check = factories.map(factory => factory({ sessionKey: 'agent:main:business' })).find(tool => tool.name === 'bench_check');
  assert.deepEqual(check.parameters.properties.action.enum, ['build', 'test', 'acceptance']);
  assert.deepEqual(Object.keys(check.parameters.properties), ['action']);
  const { content, details } = await check.execute('public', { action: 'acceptance' });
  assert.equal(details, undefined);
  assert.deepEqual(JSON.parse(content[0].text), { action: 'acceptance', sha256,
    checks: [{ id: testIds[0], status: 'UNAVAILABLE' }], status: 'INCOMPLETE', exitCode: 2, reason: 'REQUIREMENT_PROBE_SHA_MISMATCH' });
});

test('the active Apply run receives pinned acceptance and supporting details without rewriting content', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-apply-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), exchange = path.join(root, 'exchange'), javaHome = path.join(root, 'java');
  const list = path.join('entry', 'src', 'test', 'List.test.ets');
  const source = 'export default function testsuite(): void {}\n';
  const probe = path.join(root, 'public.ets');
  await Promise.all([path.dirname(path.join(project, list)), exchange, path.join(javaHome, 'bin')]
    .map(directory => fs.mkdir(directory, { recursive: true })));
  await Promise.all([fs.writeFile(path.join(project, list), source), fs.writeFile(probe, source),
    fs.writeFile(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')]);
  const applyVerificationRunFile = path.join(root, 'apply-run.json');
  const sessionKey = 'agent:main:business', runId = randomUUID(), nextRunId = randomUUID();
  const markRun = (id, key = sessionKey) => fs.writeFile(applyVerificationRunFile, JSON.stringify({ runId: id, sessionKey: key }));
  const workerPin = { exchange, toolchainSha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40) };
  const options = { projectRoot: project, toolRoot: root, javaHome,
    stableNavigationRoot: process.cwd(), applyVerificationRunFile,
    publicAcceptance: { probe, sha256: createHash('sha256').update(source).digest('hex'), testIds: ['entry::Example::requirement'] } };
  const checkTool = async (outputRoot, publicTestWorker) => {
    const plugin = await createArktsBenchTools({ ...options, outputRoot, publicTestWorker });
    const tools = [];
    (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({
      registerTool: factory => tools.push(factory({ sessionKey })),
    });
    return tools.find(candidate => candidate?.name === 'bench_check');
  };
  const tool = await checkTool(root, workerPin);
  const run = action => tool.execute(action, { action });
  const expected = (kind, status, id = runId) => ({ runtimeCorrectorVerification: { runId: id, kind, status } });
  const control = new AbortController();
  let outcome = 'pass';
  const worker = serveArktsWorkerJobs(exchange, async (action, input, job) => {
    assert.equal(action, 'test');
    const receipt = exitCode => ({ input, execution: { exitCode, interrupted: false, outputComplete: true },
      output: 'Finished :entry:default@UnitTestArkTS', raw: '', freshReport: false });
    if (outcome === 'unstarted') return { ...receipt(null), execution: { exitCode: null, interrupted: true, outputComplete: false, reason: 'ENOENT' } };
    if (outcome === 'compile-failed') return { ...receipt(1), execution: { exitCode: 1, interrupted: false, outputComplete: false, compileSucceeded: false },
      output: 'Error Message: Test fixture compile error' };
    if (outcome === 'moved') await markRun(nextRunId);
    const original = await fs.readFile(path.join(job.directory, 'source', list), 'utf8');
    const title = original.includes('__rc_contract_probe') ? 'requirement' : 'support';
    if (outcome === 'instrument-incomplete') {
      const frame = (position, name, code) => ['class=Example', `current=${position}`, 'id=JS', 'numtests=2', `test=${name}`]
        .map(value => `OHOS_REPORT_STATUS: ${value}`).concat(`OHOS_REPORT_STATUS_CODE: ${code}`).join('\n');
      const raw = [frame(1, title, 1), frame(1, title, 0), frame(2, 'unfinished', 1),
        'TestFinished-ResultCode: -1', 'user test finished.'].join('\n');
      const result = receipt(0);
      return { ...result, raw, freshReport: true, execution: { ...result.execution,
        runtime: arktsInstrumentRuntime, snapshotSha256: input.snapshotSha256, compileSucceeded: true } };
    }
    const status = outcome === 'fail' ? 'fail' : 'pass';
    const raw = [`[Hypium]start running case '${title}'`, 'OHOS_REPORT_STATUS: class=Example',
      `[Hypium][${status}]${title} ; consuming 1ms`, 'OHOS_REPORT_STATUS: class=Example',
      `OHOS_REPORT_STATUS: test=${title}`, `OHOS_REPORT_STATUS_CODE: ${status === 'pass' ? 0 : -2}`];
    if (outcome !== 'incomplete' && outcome !== 'deadline') raw.push('[Hypium][end] run suites end');
    const result = { ...receipt(outcome === 'bad-exit' ? 1 : 0), raw: raw.join('\n'), freshReport: true };
    if (outcome === 'deadline') result.execution = { exitCode: null, interrupted: true, outputComplete: false, reason: 'deadline' };
    return result;
  }, { signal: control.signal, pollMs: 5 });
  try {
    const proposal = await run('acceptance');
    assert.equal(proposal.details, undefined);
    await markRun(runId);
    const accepted = await run('acceptance');
    assert.deepEqual(accepted.content, proposal.content);
    assert.deepEqual(accepted.details, expected('acceptance', 'PASS'));
    assert.deepEqual((await run('test')).details, expected('supporting', 'PASS'));
    outcome = 'fail';
    assert.deepEqual((await run('acceptance')).details, expected('acceptance', 'FAIL'));
    assert.deepEqual((await run('test')).details, expected('supporting', 'FAIL'));
    outcome = 'compile-failed';
    const compileFailure = await run('acceptance');
    const compilePayload = JSON.parse(compileFailure.content[0].text);
    assert.equal(compilePayload.reason, 'REQUIREMENT_PROBE_COMPILE_FAILED');
    assert.deepEqual(compilePayload.checks, [{ id: 'entry::Example::requirement', status: 'UNAVAILABLE' }]);
    assert.deepEqual(compileFailure.details, expected('acceptance', 'INCOMPLETE'));
    assert.equal((await run('test')).details, undefined);
    outcome = 'deadline';
    const deadlineFailure = await run('acceptance');
    assert.equal(JSON.parse(deadlineFailure.content[0].text).reason, 'REQUIREMENT_PROBE_DEADLINE');
    assert.equal(deadlineFailure.details, undefined);
    for (outcome of ['bad-exit', 'incomplete']) {
      assert.deepEqual((await run('test')).details, expected('supporting', 'INCOMPLETE'));
    }
    outcome = 'instrument-incomplete';
    const wrongBackend = await run('test');
    assert.equal(JSON.parse(wrongBackend.content[0].text).reason, 'PUBLIC_TEST_WORKER_UNAVAILABLE');
    assert.equal(wrongBackend.details, undefined);
    const instrumentOutput = path.join(root, 'instrument');
    await fs.mkdir(instrumentOutput);
    const instrumentTool = await checkTool(instrumentOutput, { ...workerPin, runtime: arktsInstrumentRuntime, caseId: 'public-fixture' });
    const partial = await instrumentTool.execute('test', { action:'test' });
    assert.deepEqual(partial.details.runtimeCorrectorVerification, { runId, kind: 'supporting', status: 'INCOMPLETE',
      incompleteReason: 'RUNNER_REPORT_INCOMPLETE' });
    const localTests = JSON.parse(partial.content[0].text).localTests;
    assert.equal(localTests.completeRuntime, false);
    assert.equal(localTests.metadataErrors.at(-1).activeCaseId, 'entry::Example::unfinished');
    outcome = 'unstarted';
    assert.equal((await run('test')).details, undefined);
    assert.equal((await run('acceptance')).details, undefined);
    outcome = 'moved';
    assert.equal((await run('test')).details, undefined);
    outcome = 'pass';
    assert.deepEqual((await run('test')).details, expected('supporting', 'PASS', nextRunId));
    await markRun(nextRunId, 'agent:main:other');
    assert.equal((await run('test')).details, undefined);
  } finally {
    control.abort();
    await worker;
  }
});

test('an expired business deadline stops native checks before touching the workspace or toolchain', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-deadline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const applyVerificationRunFile = path.join(root, 'apply-run.json');
  await fs.writeFile(applyVerificationRunFile, JSON.stringify({ runId: randomUUID(), sessionKey: 'agent:main:business' }));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project,
    toolRoot: path.join(root, 'no-toolchain'), stableNavigationRoot: process.cwd(), deadlineAt: Date.now() - 1,
    applyVerificationRunFile, lintRequirement: {}, publicAcceptance: { probe: path.join(root, 'absent.ets'), sha256: 'a'.repeat(64), testIds: ['entry::probe::check'] } });
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  const tool = factories.map(factory => factory({ sessionKey: 'agent:main:business' })).find(candidate => candidate.name === 'bench_check');
  for (const action of ['build', 'test', 'lint', 'acceptance']) {
    const { content, details } = await tool.execute(action, { action });
    assert.equal(details, undefined);
    assert.deepEqual(JSON.parse(content[0].text), { action, status: 'INCOMPLETE', success: false, exitCode: null,
      interrupted: true, outputComplete: false, reason: 'BUSINESS_DEADLINE' });
  }
  assert.deepEqual(await fs.readdir(project), []);
});

test('the optional repository lint action reports an unverifiable check as an unsuccessful tool result', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-lint-tool-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: root, toolRoot: root,
    stableNavigationRoot: process.cwd(), lintRequirement: { source: 'AGENTS.md', configSha256: null } });
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  const check = factories.map(factory => factory({ sessionKey: 'agent:main:business' })).find(tool => tool.name === 'bench_check');
  assert.deepEqual(check.parameters.properties.action.enum, ['build', 'test', 'lint']);
  const answer = JSON.parse((await check.execute('lint', { action: 'lint' })).content[0].text);
  assert.deepEqual(answer, { action: 'lint', status: 'INCOMPLETE', success: false, reason: 'REQUIRED_LINT_CONFIG_MISSING', lint: null });
});

test('shared verification instructions match available tools and keep Apply reports outside the approved plan', () => {
  const standard = arktsVerificationInstructions();
  assert.match(standard, /bench_check supports build, test\./u);
  const planning = arktsVerificationInstructions({ lintRequirement: {}, stage: 'proposal' });
  assert.match(planning, /Plan verification using the available tools/u);
  assert.match(planning, /Leave implementation files unchanged and implementation tasks unchecked/u);
  assert.match(planning, /Keep optional checks and their availability in notes outside the checklist/u);
  const withProbe = arktsVerificationInstructions({ publicAcceptance: {} });
  assert.match(withProbe, /bench_check supports build, test, acceptance\./u);
  const withBoth = arktsVerificationInstructions({ publicAcceptance: {}, lintRequirement: {} });
  assert.match(withBoth, /bench_check supports build, test, lint, acceptance\./u);
  for (const apply of [standard, withProbe, withBoth, arktsVerificationInstructions({ stage: 'apply' })]) {
    assert.match(apply, /Run project verification through the available tools during Apply/u);
    assert.match(apply, /Keep every approved OpenSpec document unchanged, including notes, except for the completion marks of existing checklist entries/u);
    assert.match(apply, /Do not append, remove or rewrite approved text/u);
    assert.match(apply, /Record verification blockers and results in the final response, not in those documents/u);
    assert.match(apply, /only asks for a status report is complete once the status is recorded in the final response/u);
    assert.match(apply, /Leave required verification tasks unchecked while their outcomes remain unverified/u);
    assert.match(apply, /treat command examples as guidance/iu);
    assert.match(apply, /record a required check with no available tool as unverified and leave its task unchecked/iu);
    assert.doesNotMatch(apply, /notes outside the entries|notes outside the checklist/u);
  }
});

test('the pinned OpenClaw source loader can load the generated acceptance plugin', {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async t => {
  const host = process.env.RC_OPENCLAW_HOST_ROOT;
  const { version } = JSON.parse(await fs.readFile(path.join(host, 'package.json'), 'utf8'));
  if (version !== '2026.7.1-2') { t.skip('Requires OpenClaw 2026.7.1-2'); return; }
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-host-acceptance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: root, toolRoot: root,
    stableNavigationRoot: process.cwd(), publicAcceptance: { probe: path.join(root, 'public.ets'),
      sha256: 'a'.repeat(64), testIds: ['entry::acceptance::check'] } });
  const modulePath = path.join(plugin.path, 'index.mjs');
  const importerUrl = pathToFileURL(path.join(host, 'dist/plugin-module-loader-cache-uqaaAPup.js')).href;
  const { r: sourceLoader, t: createCache } = await import(importerUrl);
  const load = sourceLoader({ modulePath, importerUrl, argvEntry: path.join(host, 'openclaw.mjs'), cache: createCache() });
  const tools = [];
  load(modulePath).default.register({ registerTool: factory => tools.push(factory({ sessionKey: 'agent:main:business' })) });
  assert.deepEqual(tools.find(tool => tool.name === 'bench_check').parameters.properties.action.enum, ['build', 'test', 'acceptance']);
});

test('optional business reads bound every page while retaining all UTF-8 lines and path confinement', async t => {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rc-bench-paged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const lines = Array.from({ length: 633 }, (_, i) => `第 ${i + 1} 行`);
  await fs.writeFile(path.join(project, 'large.ets'), lines.join('\n'));
  const plugin = await createArktsBenchTools({ outputRoot: root, projectRoot: project, toolRoot: root,
    stableNavigationRoot: process.cwd(), pagedReads: true });
  const manifest = JSON.parse(await fs.readFile(path.join(plugin.path, 'openclaw.plugin.json')));
  assert(manifest.contracts.tools.includes('bench_read'));
  const factories = [];
  (await import(pathToFileURL(path.join(plugin.path, 'index.mjs')).href)).default.register({ registerTool: factory => factories.push(factory) });
  assert(factories.every(factory => factory({ sessionKey: 'agent:main:runtime-corrector:private' }) === null));
  const read = factories.map(factory => factory({ sessionKey: 'agent:main:business' })).find(tool => tool.name === 'bench_read');
  let offset = 1; const observed = [];
  while (offset !== null) {
    const result = await read.execute('page', { path: 'large.ets', offset });
    const text = result.content.map(block => block.text).join('');
    const page = result.details.page;
    assert(page.end - page.start + 1 <= 120);
    observed.push(...text.split('\n[RC page ')[0].split('\n'));
    offset = page.nextOffset;
  }
  assert.deepEqual(observed, lines);
  await assert.rejects(read.execute('oversized', { path: 'large.ets', limit: 2000 }), /1 to 250/);
  await assert.rejects(read.execute('escape', { path: '../outside.ets' }), /ENOENT|Outside benchmark workspace/);
  await fs.writeFile(path.join(root, 'outside.ets'), 'outside');
  await assert.rejects(read.execute('escape-existing', { path: '../outside.ets' }), /Outside benchmark workspace/);
});
