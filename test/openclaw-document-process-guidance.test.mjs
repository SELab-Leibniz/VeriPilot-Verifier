import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

let buildRoot, pluginRoot, createRuntime, ensureTask, taskDirectory, findTask, withTaskState, documentExecutionNotice;
before(async () => {
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-process-guidance-build-')));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: buildRoot });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ ensureTask, taskDirectory, findTask, withTaskState } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
  ({ documentExecutionNotice } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/production-stop.mjs'))));
});
after(() => fs.rm(buildRoot, { recursive: true, force: true }));

async function fixture(t, { artifacts, documents, reviewer, extraConfig = '', supportFiles = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-process-guidance-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  const configFile = path.join(root, '.runtime-corrector/config.yaml');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, `version: 2
artifacts:
${artifacts ?? `  - name: plan
    stage: proposal
    patterns: ["notes/*.md"]
    relatedRoot: project
    relatedPatterns: ["notes/*.md"]
    rules:
      enabled: false
    review:
      enabled: true`}
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
${extraConfig}
`);
  documents ??= Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map(name => [`notes/${name}.md`, `# ${name}\nCurrent document.\n`]));
  for (const [file, body] of Object.entries({ ...documents, ...supportFiles })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const sessionId = 'bundle-parent', sessionKey = 'agent:main:bundle';
  const transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, [JSON.stringify({ type: 'session', id: sessionId }),
    JSON.stringify({ type: 'message', id: 'original', parentId: null,
      message: { role: 'user', content: 'Retain local preferences.' } })].join('\n'));
  const sharedState = {}, methods = new Map(), warnings = [], calls = [];
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'test/test' } } } },
    logger: { warn: value => warnings.push(value) }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    runtime: { version: '2026.7.1-2', gateway: { async request(method, params) {
      if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
      if (method === 'autopilot.status') return { projection: { status: 'idle' } };
      assert.fail(`Unexpected gateway method: ${method}`);
    } }, agent: { session: { getSessionEntry: async () => ({ sessionId, sessionFile: transcript }),
      resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) },
      runEmbeddedAgent: async () => assert.fail('These controls must not launch an SDK worker.') } } };
  const projectScopes = admittedProjectScopes(api);
  const task = await ensureTask({ projectRoot: root, sessionId });
  projectScopes.activate = async () => ({ taskId: task.taskId });
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes,
    reviewerFactory: async options => {
      assert.equal(options.role, 'artifact-reviewer');
      calls.push(options);
      return reviewer ? reviewer(options, { root, calls }) : { sessionId: `bundle-review-${calls.length}`,
        result: { summary: 'Reviewed the current declared bundle.', findings: [], edits: [] }, async close() {} };
    }, postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  const ctx = { workspaceDir: root, sessionId, sessionKey, agentId: 'main', runId: 'proposal', trigger: 'user',
    abortSignal: new AbortController().signal };
  await runtime.prompt({ prompt: 'Retain local preferences.' }, ctx);
  const state = sharedState.states.get(`main:${sessionId}`);
  let next = 0;
  async function write(changes, { pending = false } = {}) {
    const toolCallId = `bundle-write-${++next}`, args = { command: 'update the declared documents' };
    await runtime.beforeTool({ toolName: 'exec', toolCallId, params: args }, ctx);
    for (const [file, body] of Object.entries(changes)) await fs.writeFile(path.join(root, file), body);
    const event = { toolName: 'exec', toolCallId, args, result: { content: [{ type: 'text', text: 'Updated the declared documents.' }],
      details: pending ? { status: 'running', sessionId: 'pending-process' } : { status: 'completed', exitCode: 0 } } };
    return { toolCallId, result: await runtime.toolResult(event, ctx) };
  }
  const journal = async () => fs.readFile(path.join(taskDirectory(root, task.taskId), 'journal/events.jsonl'), 'utf8')
    .then(body => body.split('\n').filter(Boolean).map(JSON.parse), error => { if (error.code === 'ENOENT') return []; throw error; });
  return { root, api, runtime, state, sharedState, task, ctx, calls, warnings, write, journal, documents, methods, transcript, configFile, projectScopes };
}

async function coverage(f) {
  return (await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId })).documentCoverage;
}
async function processCall(f, id, action, sessionId, result, { ctx = f.ctx, args, before = true, isError = false } = {}) {
  const params = { action, ...(sessionId === undefined ? {} : { sessionId }), ...(action === 'poll' ? { timeout: 0 } : {}) };
  if (before) await f.runtime.beforeTool({ toolName: 'process', toolCallId: id, params }, ctx);
  const event = { toolName: 'process', toolCallId: id, args: args ?? params, isError, result };
  return { event, output: await f.runtime.toolResult(event, ctx) };
}
const killReceipt = () => ({ content: [{ type: 'text', text: 'Termination requested for session pending-process.' }],
  details: { status: 'failed', name: 'Error' } });
const text = output => output?.result?.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? '';
async function pending(f) {
  await f.write({}, { pending: true });
  assert.equal((await coverage(f)).status, 'UNVERIFIED');
  assert.equal((await coverage(f)).pendingCommands.length, 1);
}

test('failed kill acknowledgement gives advice without settling four-document coverage', async t => {
  const f = await fixture(t); await pending(f);
  const before = await coverage(f), calls = f.calls.length;
  const receipt = killReceipt(), original = structuredClone(receipt);
  const { output, event } = await processCall(f, 'kill-owned', 'kill', 'pending-process', receipt, { isError: true });
  assert.match(text(output), /process.*"action":"poll".*"sessionId":"pending-process".*"timeout":0/u);
  assert.match(text(output), /does not prove.*ended/u);
  assert.match(text(output), /UNVERIFIED/u);
  assert.deepEqual(event.result, original);
  assert.equal(event.isError, true); assert.equal(output.result.isError, original.isError);
  assert.deepEqual(output.result.details, original.details);
  assert.deepEqual(await coverage(f), before, 'kill advice is not terminal evidence');
  assert.equal(f.calls.length, calls, 'advice launches no reviewer or coding round');
  const repeated = await f.runtime.toolResult(event, f.ctx);
  assert.deepEqual(repeated, output); assert.equal(text(repeated).split('"action":"poll"').length - 1, 1);
  assert.deepEqual(await coverage(f), before);
});

for (const status of ['completed', 'failed', 'signal', 'unchanged']) test(`genuine ${status} poll freshly reviews four declared documents`, async t => {
  const f = await fixture(t); await pending(f);
  await processCall(f, 'kill', 'kill', 'pending-process', killReceipt(), { isError: true });
  const calls = f.calls.length;
  if (status !== 'unchanged') for (const file of Object.keys(f.documents)) await fs.appendFile(path.join(f.root, file), 'Final process write.\n');
  const details = { status: ['failed', 'signal'].includes(status) ? 'failed' : 'completed', sessionId: 'pending-process',
    ...(status === 'signal' ? { exitCode: null, exitSignal: 'SIGTERM' } : { exitCode: status === 'failed' ? 7 : 0 }) };
  await processCall(f, 'terminal', 'poll', 'pending-process', { content: [], details }, { isError: ['failed', 'signal'].includes(status) });
  const after = await coverage(f);
  assert.equal(after.status, 'VERIFIED', f.warnings.join('\n')); assert.deepEqual(after.pendingCommands, []);
  assert.equal(after.resolvedProcess.originToolCallId, 'bundle-write-1');
  assert.equal(after.resolvedProcess.status, details.status);
  assert.equal(f.calls.length - calls, 4, 'the existing path freshly reviews every declared document');
  const reviews = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === 'terminal');
  assert.deepEqual(reviews.map(row => path.relative(f.root, row.file)).sort(), Object.keys(f.documents).map(file => path.normalize(file)).sort());
  for (const row of reviews) assert.equal(row.fingerprint, sha256(await fs.readFile(row.file, 'utf8')));
});

for (const invalid of ['missing-id', 'foreign-id', 'rewritten-id', 'no-before', 'foreign-session', 'foreign-run', 'replaced-controller', 'aborted', 'scope-disabled', 'scope-changed'])
  test(`kill advice refuses ${invalid} ownership or binding`, async t => {
    const f = await fixture(t); await pending(f); const before = await coverage(f);
    const id = 'kill-invalid', params = { action: 'kill', sessionId: 'pending-process' };
    if (!['no-before', 'missing-id', 'foreign-id'].includes(invalid)) await f.runtime.beforeTool({ toolName: 'process', toolCallId: id, params }, f.ctx);
    if (invalid === 'replaced-controller') f.state.reviewController = new AbortController();
    if (invalid === 'aborted') f.ctx.abortSignal = AbortSignal.abort(new Error('Cancelled'));
    if (invalid === 'scope-disabled' || invalid === 'scope-changed') {
      const resolve = f.projectScopes.resolve;
      f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args),
        ...(invalid === 'scope-disabled' ? { enabled: false } : { fingerprint: 'changed-project' }) });
    }
    const ctx = invalid === 'foreign-session' ? { ...f.ctx, sessionId: 'foreign-session' }
      : invalid === 'foreign-run' ? { ...f.ctx, runId: 'foreign-run' } : f.ctx;
    const { output } = await processCall(f, id, 'kill', invalid === 'missing-id' ? undefined : invalid === 'foreign-id' ? 'other-process' : 'pending-process',
      killReceipt(), { ctx, before: ['missing-id', 'foreign-id'].includes(invalid), isError: true,
        ...(invalid === 'rewritten-id' ? { args: { action: 'kill', sessionId: 'other-process' } } : {}) });
    assert.doesNotMatch(text(output), /"action":"poll"/u);
    assert.deepEqual(await coverage(f), before);
  });

test('running and failed nonterminal polls preserve uncertainty', async t => {
  const f = await fixture(t); await pending(f);
  for (const [id, details] of [['running', { status: 'running', sessionId: 'pending-process' }],
    ['missing', { status: 'failed' }], ['no-exit', { status: 'failed', sessionId: 'pending-process' }]]) {
    await processCall(f, id, 'poll', 'pending-process', { content: [], details }, { isError: true });
    assert.equal((await coverage(f)).status, 'UNVERIFIED'); assert.equal((await coverage(f)).pendingCommands.length, 1);
  }
});

test('unrelated and already-settled commands receive no kill advice', async t => {
  const f = await fixture(t);
  await processCall(f, 'unrelated', 'kill', 'pending-process', killReceipt(), { isError: true }).then(({ output }) => assert.doesNotMatch(text(output), /"action":"poll"/u));
  await pending(f);
  await processCall(f, 'terminal', 'poll', 'pending-process', { content: [], details: { status: 'completed', sessionId: 'pending-process', exitCode: 0 } });
  const { output } = await processCall(f, 'late-kill', 'kill', 'pending-process', killReceipt(), { isError: true });
  assert.doesNotMatch(text(output), /"action":"poll"/u); assert.equal((await coverage(f)).status, 'VERIFIED');
});

test('a kill-shaped terminal result still cannot clear a pending command', async t => {
  const f = await fixture(t); await pending(f); const before = await coverage(f);
  await processCall(f, 'kill-with-exit', 'kill', 'pending-process', { content: [],
    details: { status: 'failed', sessionId: 'pending-process', exitSignal: 'SIGTERM' } });
  assert.deepEqual(await coverage(f), before);
});

test('a terminal process receipt cannot replace a failed fresh document review', async t => {
  const f = await fixture(t, { reviewer: async () => { throw new Error('Controlled document reviewer unavailable'); } });
  await pending(f);
  await fs.appendFile(path.join(f.root, 'notes/alpha.md'), 'Changed before terminal poll.\n');
  await processCall(f, 'terminal', 'poll', 'pending-process', { content: [],
    details: { status: 'completed', sessionId: 'pending-process', exitCode: 0 } });
  const after = await coverage(f);
  assert.equal(after.status, 'UNVERIFIED'); assert.deepEqual(after.pendingCommands, []);
  assert(after.unverified.includes('DOCUMENT_SCOPE_REREVIEW_REQUIRED'));
  const reviews = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === 'terminal');
  assert.equal(reviews.length, 4); assert(reviews.every(row => row.result.status !== 'passed'));
});

for (const shape of ['ambiguous', 'foreign-snapshot', 'oversized', 'escaped']) test(`pending ${shape} ID is bounded and never inferred`, async t => {
  const f = await fixture(t); await pending(f);
  const sessionId = shape === 'oversized' ? 'p'.repeat(201) : shape === 'escaped' ? 'process"\nexample' : 'pending-process';
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, task => {
    task.documentCoverage.pendingCommands[0].sessionId = sessionId;
    if (shape === 'ambiguous') task.documentCoverage.pendingCommands.push(structuredClone(task.documentCoverage.pendingCommands[0]));
    if (shape === 'foreign-snapshot') task.documentCoverage.pendingCommands[0].snapshot.projectRoot = path.dirname(f.root);
  });
  const before = await coverage(f);
  const { output } = await processCall(f, 'kill', 'kill', sessionId, killReceipt(), { isError: true });
  assert.deepEqual(await coverage(f), before);
  if (shape === 'escaped') {
    assert.match(text(output), /"action":"poll"/u);
    assert(text(output).includes(JSON.stringify(sessionId))); assert(!text(output).includes(sessionId));
    assert(text(output).length < 1200);
  } else assert.doesNotMatch(text(output), /"action":"poll"/u);
});

test('pending Stop notice is host-neutral and declaration fallback is unchanged', () => {
  const notice = documentExecutionNotice({ status: 'UNVERIFIED', unverified: ['DOCUMENT_EXECUTION_PENDING'] });
  assert.equal(notice.reasonCode, 'DOCUMENT_EXECUTION_UNVERIFIED');
  assert.match(notice.text, /尚未取得.*终态/u);
  assert.doesNotMatch(notice.text, /补全精确声明|process\.poll/u);
  assert.equal(documentExecutionNotice({ status: 'VERIFIED' }), null);
  assert.match(documentExecutionNotice({ status: 'UNVERIFIED', unverified: ['DOCUMENT_DECLARATION_LIMIT'] }).text, /补全精确声明/u);
});
