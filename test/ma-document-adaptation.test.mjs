import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { snapshotDocumentFiles, documentCommandChanges } from '../lib/openclaw/tools.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { findTask, taskDirectory, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { readConsoleObservations } from '../lib/openclaw/console-observations.mjs';

const execute = promisify(execFile), sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let artifactRoot, pluginRoot, createRuntime, handleEvent, loadConfig;
before(async () => {
  artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-plugin-'));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: artifactRoot });
  createRuntime = (await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs')))).createOpenClawRuntime;
  handleEvent = (await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/orchestrator.mjs')))).handleRuntimeV2Event;
  loadConfig = (await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')))).loadConfig;
});
after(() => fs.rm(artifactRoot, { recursive: true, force: true }));
async function workspace(t, beforeRemove) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-document-')));
  t.after(async () => { try { await beforeRemove?.(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  return root;
}
const planFor = paths => ({ artifacts: [{ nodeId: 'document', format: 'markdown', patterns: paths }] });

test('document case aliases share ownership and read qualification on Windows while CRLF hashes remain raw', async t => {
  const root = await workspace(t), raw = Buffer.from('# Design\r\nActual requirement.\r\n');
  await fs.writeFile(path.join(root, 'Design.md'), raw);
  const declared = process.platform === 'win32' ? 'design.md' : 'Design.md';
  const tools = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: [declared] } });
  const requested = process.platform === 'win32' ? 'DESIGN.MD' : declared;
  assert.equal(tools.ownsPath(requested), true);
  assert.equal(tools.ownsPath('design.md'), process.platform === 'win32');
  const read = await tools.execute({ action: 'read', path: requested });
  assert.deepEqual(read.lines, ['1: # Design', '2: Actual requirement.', '3: ']);
  assert.equal(read.sha256, sha256(raw)); assert.notEqual(read.sha256, sha256(raw.toString().replaceAll('\r\n', '\n')));
  await tools.execute({ action: 'remember', key: 'scope', note: 'Navigation only', paths: [requested] });
  assert.equal((await tools.recall()).current.length, 1);
  await tools.validateFindings([{ path: requested, line: 2, evidence: [`${requested}:2 "Actual requirement."`] }]);
  await assert.rejects(tools.validateFindings([{ path: requested, line: 1, evidence: [`${requested}:1 "Actual requirement."`] }]), /literal quotation is absent/u);
  assert.deepEqual(await fs.readFile(path.join(root, 'Design.md')), raw);
});

test('document reads reject real Junctions and links introduced after the initial snapshot', async t => {
  const root = await workspace(t), directory = path.join(root, 'real'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'Design.md'), 'Current document.\n');
  const tools = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['real/Design.md'] } });
  const moved = path.join(root, 'moved'); await fs.rename(directory, moved);
  await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.execute({ action: 'read', path: 'real/Design.md' }), /LINKED_SOURCE/u);
  await assert.rejects(createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['real/Design.md'] } }), /LINKED_SOURCE/u);
});

test('bounded command snapshots detect script edits, creates and deletions and ignore undeclared paths', async t => {
  const root = await workspace(t), plan = planFor(['existing.md', 'created.md', 'deleted.md']);
  await fs.writeFile(path.join(root, 'existing.md'), 'before'); await fs.writeFile(path.join(root, 'deleted.md'), 'remove');
  const before = await snapshotDocumentFiles(plan, root);
  await execute(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync('existing.md','after');fs.writeFileSync('created.md','new');fs.unlinkSync('deleted.md');fs.writeFileSync('outside.md','not declared');"], { cwd: root });
  const after = await documentCommandChanges(before, plan, root);
  assert.equal(after.status, 'VERIFIED');
  assert.deepEqual(after.files.map(file => path.basename(file)).sort(), ['created.md', 'deleted.md', 'existing.md']);
  assert.equal(after.checkedFiles, 3); assert(!after.currentFiles.some(entry => entry.file.endsWith('outside.md')));
});

test('wildcard and template scopes expose partial coverage without inventory, and missing/pending snapshots remain unverified', async t => {
  const root = await workspace(t); await fs.writeFile(path.join(root, 'known.md'), 'before');
  const plan = planFor(['*.md']), known = path.join(root, 'known.md');
  const original = fs.readdir;
  t.mock.method(fs, 'readdir', () => assert.fail('snapshot must not inventory directories'));
  const before = await snapshotDocumentFiles(plan, root, { observedPaths: [known] });
  await fs.writeFile(known, 'after'); await fs.writeFile(path.join(root, 'new.md'), 'not discovered');
  const after = await documentCommandChanges(before, plan, root, { observedPaths: [known] });
  assert.equal(after.status, 'UNVERIFIED'); assert(after.unverified.includes('DOCUMENT_DECLARATION_UNRESOLVED'));
  assert.deepEqual(after.files, [known]); assert.equal(after.currentFiles.length, 1);
  const template = await snapshotDocumentFiles({ artifacts: [{ pathTemplates: ['docs/{task}/design.md'] }] }, root);
  assert(template.unverified.includes('DOCUMENT_DECLARATION_UNRESOLVED'));
  t.mock.restoreAll(); assert.equal(fs.readdir, original);
  const literal = planFor(['known.md']), captured = await snapshotDocumentFiles(literal, root);
  assert((await documentCommandChanges(null, literal, root)).unverified.includes('DOCUMENT_PRE_SNAPSHOT_MISSING'));
  assert((await documentCommandChanges(captured, literal, root, { pending: true })).unverified.includes('DOCUMENT_EXECUTION_PENDING'));
  assert((await snapshotDocumentFiles(literal, root, { deadlineAt: performance.now() - 1 })).unverified.includes('DOCUMENT_SNAPSHOT_TIMEOUT'));
  assert((await documentCommandChanges(captured, planFor(['other.md']), root)).unverified.includes('DOCUMENT_DECLARATION_CHANGED'));
});

test('document snapshot file/byte bounds and actual links cannot produce verified coverage', async t => {
  const root = await workspace(t), real = path.join(root, 'real'); await fs.mkdir(real);
  await fs.writeFile(path.join(real, 'doc.md'), 'business');
  await fs.symlink(real, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'large.md'), Buffer.alloc(4 * 1024 * 1024 + 1));
  const scope = await snapshotDocumentFiles(planFor(['link/doc.md', 'large.md', '../outside.md']), root);
  assert(scope.unverified.includes('DOCUMENT_LINKED_SOURCE')); assert(scope.unverified.includes('DOCUMENT_SNAPSHOT_LIMIT'));
  assert(scope.unverified.includes('DOCUMENT_PATH_OUTSIDE_SCOPE')); assert.equal(scope.bytes, 0);
  const limited = await snapshotDocumentFiles(planFor(Array.from({ length: 129 }, (_, i) => `${i}.md`)), root);
  assert.equal(limited.entries.length, 128); assert(limited.unverified.includes('DOCUMENT_DECLARATION_LIMIT'));
});

async function runtimeFixture(t, paths = ['document.md', 'created.md', 'deleted.md'], { initialize = true } = {}) {
  let runtime;
  const root = await workspace(t, () => runtime?.dispose());
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: 2\nartifacts:\n  - name: document\n    stage: document\n    format: markdown\n    patterns: ${JSON.stringify(paths)}\n    rules:\n      enabled: false\n    review:\n      enabled: false\ndynamicGroundTruth:\n  enabled: false\nskillCorrection:\n  enabled: false\nstopCorrection:\n  enabled: false\nartifactCorrection:\n  groundTruthReviewEnabled: false\n  stageMetricsEnabled: false\n`);
  await fs.writeFile(path.join(root, 'document.md'), '# Before\n'); await fs.writeFile(path.join(root, 'deleted.md'), '# Remove\n');
  const warnings = [], host = { config: {}, pluginConfig: {}, runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => path.join(root, 'host-state') },
    agent: { resolveAgentWorkspaceDir: () => root } }, logger: { warn: value => warnings.push(value), info() {} } };
  const scopes = admittedProjectScopes(host);
  const sharedState = {};
  runtime = createRuntime(host, { pluginRoot, projectScopes: scopes, sharedState,
    reviewerFactory: () => assert.fail('disabled reviews must not start a model') });
  const ctx = { sessionId: 'document-session', sessionKey: 'agent:main:document', runId: 'run-one', agentId: 'main', workspaceDir: root,
    sessionFile: path.join(root, 'native.jsonl'),
    provider: 'offline', modelId: 'fixture', prompt: 'Maintain the declared documents.' };
  const state = initialize ? await runtime.beginSupervised(ctx, new AbortController().signal) : null;
  const journal = async () => {
    const task = await findTask({ projectRoot: root, sessionId: ctx.sessionId });
    const text = await fs.readFile(path.join(taskDirectory(root, task.taskId), 'journal/events.jsonl'), 'utf8');
    return { task, events: text.trim().split('\n').map(JSON.parse) };
  };
  return { root, runtime, ctx, state, journal, warnings, scopes, sharedState };
}

test('runtime uses the pre-execution binding despite rewritten args and reviews partial writes from failed scripts', async t => {
  const f = await runtimeFixture(t);
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'script', params: { command: 'original command' } }, f.ctx);
  await assert.rejects(execute(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync('document.md','# After\\n');fs.writeFileSync('created.md','# New\\n');fs.unlinkSync('deleted.md');fs.writeFileSync('outside.md','outside');process.exit(7);"], { cwd: f.root }));
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'script', args: { command: 'rtk transformed command' },
    isError: true, result: { content: [], details: { exitCode: 7, status: 'completed' } } }, f.ctx);
  const { task, events } = await f.journal();
  assert.equal(task.documentCoverage.status, 'VERIFIED', f.warnings.join('\n'));
  const reviews = events.filter(event => event.type === 'OPENCLAW_ARTIFACT_REVIEW');
  assert.deepEqual(reviews.map(event => path.basename(event.file)).sort(), ['created.md', 'document.md']);
  assert(events.some(event => event.type === 'OPENCLAW_FILE_CHANGED' && event.file.endsWith('deleted.md')));
  assert(!events.some(event => event.file?.endsWith('outside.md')));
});

test('missing execution coverage is visible and survives restart to prevent an old global PASS', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Changed without a before receipt\n');
  await f.runtime.toolResult({ toolName: 'PowerShell', toolCallId: 'missing-before', args: {}, result: { content: [] } }, f.ctx);
  const { task } = await f.journal(); assert.equal(task.documentCoverage.status, 'UNVERIFIED');
  await withTaskState({ projectRoot: f.root, taskId: task.taskId }, state => { state.verification = { ...state.verification, status: 'PASS' }; });
  const plan = await loadConfig({ cwd: f.root, pluginRoot });
  plan.runtimeV2 = { ...plan.runtimeV2, enabled: true, shadowMode: false };
  const stop = await handleEvent({ projectRoot: f.root, pluginRoot, plan, input: { session_id: f.ctx.sessionId,
    hook_event_name: 'Stop', last_assistant_message: 'Completed.' }, reviewerFactory: () => assert.fail('disabled reviews must not start a model') });
  assert.notEqual(stop.stop?.status, 'PASS', JSON.stringify(stop)); assert.deepEqual(stop.stop.unverifiedBasis, ['DOCUMENT_EXECUTION_UNVERIFIED']);
  assert.match(stop.feedback, /UNVERIFIED \(DOCUMENT_EXECUTION_UNVERIFIED\)/u);
  const persisted = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.notEqual(persisted.verification.status, 'PASS');
  const page = await readConsoleObservations({ projectRoot: f.root, sessionId: f.ctx.sessionId }, persisted);
  assert.equal(page.baseline.documentCoverage.status, 'UNVERIFIED');
  assert(page.metrics.every(metric => metric.status !== 'PASS'));
});

test('a complete bounded recheck reviews all declared current documents before clearing prior uncertainty', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'missing-before', args: {}, result: { content: [] } }, f.ctx);
  assert.equal((await f.journal()).task.documentCoverage.status, 'UNVERIFIED');
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'recheck', params: {} }, f.ctx);
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'recheck', args: {}, result: { content: [] } }, f.ctx);
  const { task, events } = await f.journal(); assert.equal(task.documentCoverage.status, 'VERIFIED', f.warnings.join('\n'));
  assert(events.some(event => event.type === 'OPENCLAW_ARTIFACT_REVIEW' && event.toolCallId === 'recheck'));
});

test('PowerShell script mutations use the same bounded pre-execution receipt', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  await f.runtime.beforeTool({ toolName: 'powershell', toolCallId: 'ps-edit', params: { command: 'script' } }, f.ctx);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Script update\n');
  await f.runtime.toolResult({ toolName: 'powershell', toolCallId: 'ps-edit', args: {}, result: { content: [] } }, f.ctx);
  const { task, events } = await f.journal();
  assert.equal(task.documentCoverage.status, 'VERIFIED');
  assert(events.some(event => event.type === 'OPENCLAW_ARTIFACT_REVIEW' && event.toolCallId === 'ps-edit'));
});

test('a foreign run cannot consume a document snapshot or publish its changed-file review', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'bound-call', params: {} }, f.ctx);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Current run update\n');
  const result = { toolName: 'exec', toolCallId: 'bound-call', args: {}, result: { content: [] } };
  await f.runtime.toolResult(result, { ...f.ctx, runId: 'foreign-run' });
  assert.equal((await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId }))?.documentCoverage, undefined);
  await f.runtime.toolResult(result, f.ctx);
  assert.equal((await f.journal()).task.documentCoverage.status, 'VERIFIED');
});

test('slow pre-hook metadata cannot turn a late snapshot into verified execution coverage', async t => {
  const f = await runtimeFixture(t, ['document.md']), original = f.scopes.resolve;
  let first = true;
  t.mock.method(f.scopes, 'resolve', async (...args) => {
    if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 1100)); }
    return original(...args);
  });
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'slow-meta', params: {} }, f.ctx);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Updated after hook delay\n');
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'slow-meta', args: {}, result: { content: [] } }, f.ctx);
  const { task } = await f.journal(); assert.equal(task.documentCoverage.status, 'UNVERIFIED');
  assert(task.documentCoverage.unverified.includes('DOCUMENT_SNAPSHOT_TIMEOUT'));
});

test('running writers stay unverified across unrelated stable commands until a matching bound terminal poll and full rereview', async t => {
  const f = await runtimeFixture(t, ['document.md', 'deleted.md']);
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'background', params: {} }, f.ctx);
  const child = spawn(process.execPath, ['-e', "setTimeout(()=>{const fs=require('node:fs');fs.writeFileSync('document.md','# Late process write\\n');fs.unlinkSync('deleted.md');},400);"],
    { cwd: f.root, windowsHide: true, stdio: 'ignore' });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Background writer exit ${code}`))); });
  t.after(() => { child.kill(); });
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'background', args: {}, result: { content: [],
    details: { status: 'running', sessionId: 'background-one', pid: child.pid } } }, f.ctx);
  assert.equal((await f.journal()).task.documentCoverage.status, 'UNVERIFIED');
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'unrelated', params: {} }, f.ctx);
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'unrelated', args: {}, result: { content: [], details: { status: 'completed', exitCode: 0 } } }, f.ctx);
  let coverage = (await f.journal()).task.documentCoverage;
  assert.equal(coverage.status, 'UNVERIFIED'); assert.equal(coverage.pendingCommands.length, 1);
  await finished;
  await f.runtime.beforeTool({ toolName: 'process', toolCallId: 'wrong-poll', params: { action: 'poll', sessionId: 'foreign-process' } }, f.ctx);
  await f.runtime.toolResult({ toolName: 'process', toolCallId: 'wrong-poll', args: {}, result: { content: [],
    details: { status: 'completed', sessionId: 'background-one', exitCode: 0 } } }, f.ctx);
  assert.equal((await f.journal()).task.documentCoverage.status, 'UNVERIFIED');
  await f.runtime.beforeTool({ toolName: 'process', toolCallId: 'terminal-poll', params: { action: 'poll', sessionId: 'background-one' } }, f.ctx);
  await f.runtime.toolResult({ toolName: 'process', toolCallId: 'terminal-poll', args: {}, result: { content: [],
    details: { status: 'completed', sessionId: 'background-one', exitCode: 0 } } }, f.ctx);
  const result = await f.journal(); coverage = result.task.documentCoverage;
  assert.equal(coverage.status, 'VERIFIED', f.warnings.join('\n')); assert.equal(coverage.pendingCommands.length, 0);
  assert.equal(coverage.resolvedProcess.originToolCallId, 'background');
  assert(result.events.some(event => event.type === 'OPENCLAW_ARTIFACT_REVIEW' && event.toolCallId === 'terminal-poll'
    && event.fingerprint === sha256('# Late process write\n')));
  assert(result.events.some(event => event.processTerminal?.sessionId === 'background-one'));
  assert(result.events.some(event => event.type === 'OPENCLAW_FILE_CHANGED' && event.toolCallId === 'terminal-poll' && event.file.endsWith('deleted.md')));
});

test('a replaced review controller cannot consume an earlier document capture', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'cancelled', params: {} }, f.ctx);
  f.state.reviewController.abort(new Error('Prior controller cancelled'));
  f.state.reviewController = new AbortController();
  await fs.writeFile(path.join(f.root, 'document.md'), '# Late previous-controller edit\n');
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'cancelled', args: {}, result: { content: [] } }, f.ctx);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId }))?.documentCoverage, undefined);
});

for (const toolName of ['exec', 'process']) test(`the first ${toolName} call binds its document receipt before a same-run controller replacement`, async t => {
  const f = await runtimeFixture(t, ['document.md'], { initialize: false });
  assert.equal(f.sharedState.states.size, 0);
  const event = { toolName, toolCallId: 'first-call', params: toolName === 'process' ? { action: 'poll', sessionId: 'writer' } : {} };
  await f.runtime.beforeTool(event, f.ctx);
  const state = f.sharedState.states.get('main:document-session');
  assert(state, f.warnings.join('\n'));
  const binding = [...f.sharedState.toolBindings.get(event.toolCallId).values()][0];
  const receipt = toolName === 'process' ? binding.runtimeCorrectorDocumentProcess : binding.runtimeCorrectorDocumentSnapshot;
  assert.equal(receipt.controller, state.reviewController);
  assert.equal(receipt.runId, f.ctx.runId);
  const admittedController = state.reviewController;
  state.reviewController = new AbortController(); state.abortSignal = state.reviewController.signal;
  assert.equal(admittedController.signal.aborted, false, 'replacement does not rely on an aborted host signal');
  await fs.writeFile(path.join(f.root, 'document.md'), '# Previous-controller write\n');
  await f.runtime.beforeTool(event, f.ctx);
  const repeated = [...f.sharedState.toolBindings.get(event.toolCallId).values()][0];
  assert.equal((toolName === 'process' ? repeated.runtimeCorrectorDocumentProcess : repeated.runtimeCorrectorDocumentSnapshot).controller,
    admittedController, 'repeated admission cannot transfer an existing receipt to the new controller');
  await f.runtime.toolResult({ ...event, args: {}, result: { content: [], details: { status: 'completed', sessionId: 'writer', exitCode: 0 } } }, f.ctx);
  assert.equal((await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId }))?.documentCoverage, undefined);
});

test('an execution snapshot without before-hook admission remains explicitly unverified', async t => {
  const f = await runtimeFixture(t, ['document.md'], { initialize: false }), original = f.scopes.resolve;
  let calls = 0;
  t.mock.method(f.scopes, 'resolve', async (...args) => {
    const scope = await original(...args);
    return ++calls === 2 ? { ...scope, enabled: false } : scope;
  });
  await f.runtime.beforeTool({ toolName: 'exec', toolCallId: 'unadmitted', params: {} }, f.ctx);
  assert.equal(f.sharedState.states.size, 0);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Executed without admission\n');
  await f.runtime.toolResult({ toolName: 'exec', toolCallId: 'unadmitted', args: {}, result: { content: [] } }, f.ctx);
  const { task } = await f.journal();
  assert.equal(task.documentCoverage.status, 'UNVERIFIED', f.warnings.join('\n'));
  assert(task.documentCoverage.unverified.includes('DOCUMENT_INVOCATION_UNADMITTED'));
});

test('a duplicate before-hook cannot replace the original document pre-image', async t => {
  const f = await runtimeFixture(t, ['document.md']);
  const event = { toolName: 'exec', toolCallId: 'duplicate', params: {} };
  await f.runtime.beforeTool(event, f.ctx);
  const binding = [...f.sharedState.toolBindings.get(event.toolCallId).values()][0], original = binding.runtimeCorrectorDocumentSnapshot;
  await fs.writeFile(path.join(f.root, 'document.md'), '# Updated between hook deliveries\n');
  await f.runtime.beforeTool(event, f.ctx);
  assert.equal([...f.sharedState.toolBindings.get(event.toolCallId).values()][0].runtimeCorrectorDocumentSnapshot, original);
  await f.runtime.toolResult({ ...event, args: {}, result: { content: [] } }, f.ctx);
  const { events } = await f.journal();
  assert(events.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW' && row.toolCallId === event.toolCallId));
});

test('a duplicate before-hook preserves an original missing snapshot instead of certifying a late capture', async t => {
  const f = await runtimeFixture(t, ['document.md'], { initialize: false }), original = f.scopes.resolve;
  let calls = 0;
  t.mock.method(f.scopes, 'resolve', async (...args) => {
    const scope = await original(...args);
    return ++calls <= 2 ? { ...scope, enabled: false } : scope;
  });
  const event = { toolName: 'exec', toolCallId: 'missing-original', params: {} };
  await f.runtime.beforeTool(event, f.ctx);
  assert.equal([...f.sharedState.toolBindings.get(event.toolCallId).values()][0].runtimeCorrectorDocumentSnapshot, null);
  await fs.writeFile(path.join(f.root, 'document.md'), '# Written before a duplicate receipt\n');
  await f.runtime.beforeTool(event, f.ctx);
  const binding = [...f.sharedState.toolBindings.get(event.toolCallId).values()][0];
  assert.equal(binding.runtimeCorrectorDocumentSnapshot, null);
  assert.equal(binding.runtimeCorrectorDocumentProcess, null);
  await f.runtime.toolResult({ ...event, args: {}, result: { content: [] } }, f.ctx);
  const { task } = await f.journal();
  assert.equal(task.documentCoverage.status, 'UNVERIFIED');
  assert(task.documentCoverage.unverified.includes('DOCUMENT_PRE_SNAPSHOT_MISSING'));
});
