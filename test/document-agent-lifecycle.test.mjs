import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireDocumentSession, releaseDocumentSessions } from '../lib/document-session.mjs';
import { createDocumentTools, registerDocumentTools, bindDocumentTools } from '../lib/document-tools.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-doc-lifecycle-'));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'a.md'), 'target\n'); await fs.writeFile(path.join(root, 'b.md'), 'basis\n'); return root;
}
test('a process crash releases project admission without reusing the crashed native identity', async t => {
  const root = await project(t), moduleUrl = pathToFileURL(path.resolve('lib/document-session.mjs')).href;
  const code = `import {acquireDocumentSession} from ${JSON.stringify(moduleUrl)};const s=await acquireDocumentSession({projectRoot:${JSON.stringify(root)},identity:1});console.log(s.sessionId);setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true });
  t.after(() => child.kill()); let stderr = ''; child.stderr.on('data', data => stderr += data);
  const identity = await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', data => resolve(data.toString().trim()));
    child.once('close', code => { if (code) reject(new Error(stderr)); }); });
  await assert.rejects(acquireDocumentSession({ projectRoot: root, identity: 1, deadlineAt: Date.now() + 50 }), /DEADLINE/);
  const stopped = new Promise(resolve => child.once('close', resolve)); child.kill(); await stopped;
  const recovered = await acquireDocumentSession({ projectRoot: root, identity: 1 }); assert.notEqual(recovered.sessionId, identity); await recovered.release();
});
test('simultaneous processes never overlap project execution or remove a replacement claim', async t => {
  const root = await project(t), moduleUrl = pathToFileURL(path.resolve('lib/document-session.mjs')).href;
  const events = path.join(root, 'slots.jsonl');
  const code = `import fs from 'node:fs/promises'; import {acquireDocumentSession} from ${JSON.stringify(moduleUrl)};
    const s=await acquireDocumentSession({projectRoot:${JSON.stringify(root)},identity:1});
    await fs.appendFile(${JSON.stringify(events)},JSON.stringify({pid:process.pid,phase:'start',at:Date.now()})+'\\n');
    await new Promise(r=>setTimeout(r,35));
    await fs.appendFile(${JSON.stringify(events)},JSON.stringify({pid:process.pid,phase:'end',at:Date.now()})+'\\n');await s.release();`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true }); let stderr = '';
    child.stderr.on('data', data => stderr += data); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const records = (await fs.readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 8); let running = null;
  for (const event of records) {
    if (event.phase === 'start') { assert.equal(running, null); running = event.pid; }
    else { assert.equal(running, event.pid); running = null; }
  }
});
test('compaction checkpoints are private and current-round tools expire with their binding', async t => {
  const root = await project(t), hooks = new Map(); let factory;
  const api = { registerTool: fn => { factory = fn; }, on: (phase, fn) => hooks.set(phase, fn) };
  registerDocumentTools(api);
  const tools = await createDocumentTools({ projectRoot: root, requestPath: '/current/request.json',
    semantic: { artifactFiles: ['a.md'], workflow: { editableArtifactFiles: ['a.md'], incomingEdges: [{ sourceFiles: ['b.md'] }] } } });
  const close = bindDocumentTools({ sessionId: 'private', runId: 'round-1', tools, active() {} });
  await tools.execute({ action: 'open' }); await tools.execute({ action: 'remember', key: 'pending', note: 'Check source condition', paths: ['a.md', 'b.md'] });
  const tool = factory({ sessionId: 'private', runId: 'round-1' });
  for (const phase of ['before_compaction', 'after_compaction']) await hooks.get(phase)({}, { sessionId: 'private', runId: 'round-1' });
  const checkpoint = JSON.parse(await fs.readFile(path.join(root, '.runtime-correction/document-agent/checkpoint.json')));
  assert.equal(checkpoint.phase, 'after_compaction'); assert.equal(checkpoint.navigationOnly, true); assert.deepEqual(checkpoint.noteKeys, ['pending']);
  assert.equal((await tools.execute({ action: 'open' })).requestPath, '/current/request.json');
  close(); await assert.rejects(tool.execute('late', { action: 'recall' }), /BINDING_EXPIRED/);
  await fs.writeFile(path.join(root, 'b.md'), 'basis changed');
  const changed = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['a.md'], workflow: { editableArtifactFiles: ['a.md'], incomingEdges: [{ sourceFiles: ['b.md'] }] } } });
  assert.deepEqual((await changed.recall()).stale, ['pending']);
});
test('MCP stdio adapter exposes the same bounded production tool and rejects unknown file access', async t => {
  const root = await project(t), request = path.join(root, 'request.json');
  await fs.writeFile(request, JSON.stringify({ projectRoot: root, artifactFiles: ['a.md'] }));
  const child = spawn(process.execPath, [path.resolve('scripts/document-tools.mjs'), request, '--stdio'], { windowsHide: true });
  let output = '', stderr = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => stderr += data);
  for (const [id, method, params] of [[1, 'initialize', {}], [2, 'tools/list', {}],
    [3, 'tools/call', { name: 'rc_document', arguments: { action: 'open' } }],
    [4, 'tools/call', { name: 'rc_document', arguments: { action: 'read', path: '../private.md' } }]])
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  child.stdin.end(); const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0, stderr);
  const messages = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 4); assert.equal(messages[1].result.tools[0].name, 'rc_document');
  assert.equal(JSON.parse(messages[2].result.content[0].text).documents[0].nextLine, null);
  assert.equal(messages[3].result.isError, true);
});

test('SQLite host session ownership survives a fresh plugin API registry and closes the exact identity', async t => {
  const root = await project(t), entries = new Map(), calls = [], removals = [];
  const session = { resolveStorePath: () => '/native/sessions.json', getSessionEntry: async ({ sessionKey }) => entries.get(sessionKey),
    upsertSessionEntry: async ({ sessionKey, entry }) => { entries.set(sessionKey, entry); } };
  const compatibility = async () => ({ formatSessionMarker: identity => `sqlite:${identity.sessionId}`,
    deleteSessionEntry: async ({ sessionKey, expectedSessionId }) => { removals.push(expectedSessionId); entries.delete(sessionKey); } });
  const createApi = () => ({ runtime: { version: '2026.10.3', agent: { session, async runEmbeddedAgent(params) {
    calls.push(params); return { payloads: [{ text: JSON.stringify({ summary: 'aligned', findings: [], edits: [] }) }], meta: {} };
  } } }, config: { agents: { defaults: { model: 'fixture/model' } } } });
  const requestPath = path.join(root, 'request.json'); await fs.writeFile(requestPath, JSON.stringify({ projectRoot: root, artifactFiles: ['a.md'] }));
  const input = { projectRoot: root, taskId: 'sqlite-task', role: 'artifact-reviewer', pluginRoot: path.resolve('.'), schema: REVIEW_SCHEMA,
    reviewer: { timeoutMs: 5000 }, request: { semanticReviewRequestPath: requestPath }, evidence: { snapshot: { entries: [], digest: 'first' } } };
  const first = await createOpenClawReviewerFactory(createApi(), { compatibility })(input); await first.close();
  input.evidence.snapshot.digest = 'second';
  const second = await createOpenClawReviewerFactory(createApi(), { compatibility })(input); await second.close();
  assert.equal(first.sessionId, second.sessionId); assert.equal(entries.size, 1); assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionTarget.sessionId, calls[1].sessionTarget.sessionId);
  await releaseDocumentSessions(root); assert.deepEqual(removals, [first.sessionId]); assert.equal(entries.size, 0);
});
