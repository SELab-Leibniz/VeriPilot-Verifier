import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireDocumentSession, releaseDocumentSessions } from '../lib/document-session.mjs';
import { createDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
import { observeInternalTool } from '../lib/openclaw/internal-context.mjs';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-document-'));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'target.md'), '# Design\nREQ-1: local import only\n');
  await fs.writeFile(path.join(root, 'source.md'), '# Scope\nREQ-1: local import only\n'); return root;
}
const semantic = () => ({ stage: 'design', artifactFiles: ['target.md'], reviewer: { criteria: 'Preserve scope.' },
  workflow: { targetFiles: ['target.md'], editableArtifactFiles: ['target.md'], incomingEdges: [{ sourceFiles: ['source.md'] }] } });

test('project sessions serialize, reuse, rotate after policy/failure and release idle identities', async t => {
  const root = await project(t), closed = [], options = { projectRoot: root, identity: 1, closeNative: async id => closed.push(id) };
  const first = await acquireDocumentSession(options); let acquired = false;
  const waiting = acquireDocumentSession(options).then(s => { acquired = true; return s; });
  await new Promise(r => setTimeout(r, 40)); assert.equal(acquired, false);
  await first.release(); const second = await waiting;
  assert.equal(first.sessionId, second.sessionId); assert.equal(second.reused, true); await second.release();
  const changed = await acquireDocumentSession({ ...options, identity: 2 }); assert.notEqual(changed.sessionId, first.sessionId);
  await changed.release({ healthy: false }); assert.deepEqual(closed, [first.sessionId, changed.sessionId]);
  const idle = await acquireDocumentSession({ ...options, idleMs: 15 }); await idle.release();
  await new Promise(r => setTimeout(r, 35)); assert.ok(closed.includes(idle.sessionId));
});

test('waiting sessions honor cancellation/deadline and recover a dead process lease', async t => {
  const root = await project(t), owner = await acquireDocumentSession({ projectRoot: root, identity: 1 });
  const controller = new AbortController(); const pending = acquireDocumentSession({ projectRoot: root, identity: 1, signal: controller.signal });
  controller.abort(new Error('cancel queued round')); await assert.rejects(pending, /cancel queued round/);
  await assert.rejects(acquireDocumentSession({ projectRoot: root, identity: 1, deadlineAt: Date.now() + 25 }), /DEADLINE/);
  await owner.release();
});

test('notes recover after reconstruction, never replace reads, and expire on changed content or authority', async t => {
  const root = await project(t), input = { projectRoot: root, semantic: semantic(), scopeIdentity: 1 };
  const tools = await createDocumentTools(input);
  assert.deepEqual(tools.manifest().map(row => row.path).sort(), ['source.md', 'target.md']);
  await assert.rejects(tools.execute({ action: 'remember', key: 'trace', note: 'REQ-1 maps here', paths: ['target.md'] }), /CURRENT_READS/);
  const opened = await tools.execute({ action: 'open' });
  assert.equal(opened.documents.length, 2); assert(opened.documents.every(page => page.nextLine === null));
  assert.match((await tools.execute({ action: 'read', path: 'target.md' })).lines[1], /^2: REQ-1/);
  await tools.execute({ action: 'remember', key: 'trace', note: 'REQ-1 maps here', paths: ['target.md'] });
  const restored = await createDocumentTools(input); assert.equal((await restored.recall()).current.length, 1);
  assert.deepEqual((await (await createDocumentTools({ ...input, scopeIdentity: 2 })).recall()).stale, ['trace']);
  await fs.writeFile(path.join(root, 'target.md'), 'changed'); await assert.rejects(restored.verify(), /EVIDENCE_CHANGED/);
  assert.deepEqual((await (await createDocumentTools(input)).recall()).stale, ['trace']);
});

test('tools bound output, reject undeclared files and forbid link escapes', async t => {
  const root = await project(t); await fs.writeFile(path.join(root, 'target.md'), 'REQ-1 一'.repeat(3000) + '\n' + 'REQ-1\n'.repeat(100));
  const tools = await createDocumentTools({ projectRoot: root, semantic: semantic() });
  assert.equal((await tools.execute({ action: 'read', path: 'target.md' })).requiresHostRead, true);
  await assert.rejects(tools.execute({ action: 'search', query: 'REQ-1' }), /DOCUMENT_PATH_REQUIRED.*open or manifest/);
  const search = await tools.execute({ action: 'search', path: 'target.md', query: 'REQ-1' });
  assert.equal(search.truncated, true); assert(Buffer.byteLength(JSON.stringify(search)) < 9000);
  await assert.rejects(tools.execute({ action: 'read', path: '../other.md' }), /NOT_DECLARED/);
  await assert.rejects(createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['../other.md'] } }), /OUTSIDE_SCOPE/);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-doc-link-')); t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, 'private.md'), 'private');
  await fs.symlink(other, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['linked/private.md'] } }), /LINKED/);
});

test('native factory reuses project identity across rounds, restores notes, rejects stale evidence and expires tools', async t => {
  const root = await project(t), calls = [], closed = []; let registered, mutate = false, external = false, waitForCancel = false, admitted;
  const runner = async params => {
    calls.push(params); const tool = registered({ sessionId: params.sessionId, runId: params.runId });
    assert.equal(registered({ sessionId: 'host' }), null); assert.equal(registered({ sessionId: params.sessionId, runId: 'old' }), null);
    const invoke = async args => JSON.parse((await tool.execute('read', args)).content[0].text);
    assert.equal((await invoke({ action: 'manifest' })).length, 2);
    await invoke({ action: 'read', path: 'target.md' });
    if (calls.length === 2) assert.equal((await invoke({ action: 'recall' })).current.length, 1);
    await invoke({ action: 'remember', key: 'trace', note: 'Inspect REQ-1', paths: ['target.md'] });
    await fs.appendFile(params.sessionFile, JSON.stringify({ prompt: params.prompt }) + '\n');
    if (external) await observeInternalTool('read', { path: path.join(root, 'implementation.mjs') });
    if (waitForCancel) {
      admitted(); await new Promise((_resolve, reject) => params.abortSignal.addEventListener('abort', () => reject(params.abortSignal.reason), { once: true }));
    }
    if (mutate) await fs.writeFile(path.join(root, 'source.md'), 'changed during review');
    return { payloads: [{ text: JSON.stringify({ summary: 'aligned', findings: [], edits: [] }) }], meta: {} };
  };
  runner.close = async (_key, id) => closed.push(id);
  const api = { runtime: { agent: { runEmbeddedAgent: runner } }, config: { agents: { defaults: { model: 'fixture/model' } } }, registerTool: f => { registered = f; } };
  registerDocumentTools(api); const requestPath = path.join(root, 'request.json'); await fs.writeFile(requestPath, JSON.stringify(semantic()));
  const input = { projectRoot: root, taskId: 'task-1', role: 'artifact-reviewer', pluginRoot: path.resolve('.'), schema: REVIEW_SCHEMA,
    reviewer: { session: 'detached', timeoutMs: 5000 }, request: { semanticReviewRequestPath: requestPath }, evidence: { snapshot: { entries: [] } } };
  const first = await createOpenClawReviewerFactory(api)(input); await first.close();
  input.evidence.snapshot.digest = 'round-2';
  const next = await createOpenClawReviewerFactory(api)(input); await next.close();
  assert.equal(first.sessionId, next.sessionId); assert.equal(closed.length, 0); assert.notEqual(calls[0].prompt, calls[1].prompt);
  assert.equal(calls[0].sessionFile, calls[1].sessionFile); assert.equal(registered({ sessionId: next.sessionId }), null);
  const traces = path.join(root, '.runtime-correction/openclaw/review-traces');
  assert.equal((await fs.readdir(path.join(traces, (await fs.readdir(traces))[0]))).length, 2);
  const duplicate = await createOpenClawReviewerFactory(api)(input); await duplicate.close();
  assert.equal(calls.length, 2, 'exact evidence duplicates do not call the model');
  assert.equal(duplicate.envelope.document_cache_hit, true);
  input.evidence.snapshot.digest = 'round-3';
  mutate = true; await assert.rejects(createOpenClawReviewerFactory(api)(input), /EVIDENCE_CHANGED/); assert.deepEqual(closed, [first.sessionId]);
  mutate = false; external = true; input.evidence.snapshot.digest = 'external-evidence';
  const before = calls.length;
  for (let i = 0; i < 2; i++) { const handle = await createOpenClawReviewerFactory(api)(input); await handle.close(); }
  assert.equal(calls.length, before + 2, 'extra source reads disable exact-input caching');
  external = false; waitForCancel = true; input.evidence.snapshot.digest = 'cancellation';
  const controller = new AbortController(); input.abortSignal = controller.signal;
  const started = new Promise(resolve => { admitted = resolve; });
  const pending = createOpenClawReviewerFactory(api)(input); await started; controller.abort(new Error('host cancelled document review'));
  await assert.rejects(pending, /host cancelled document review/);
  assert.equal(closed.length, 2, 'cancelled project identity is retired');
});
