import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkArtifact, finalizeArtifactCheck } from '../lib/runtime-corrector.mjs';
import { documentHookPolicy, openclawDocumentOptions } from '../scripts/evaluate-openclaw-document-e2e.mjs';
import { bindDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { createOpenClawRuntime } from '../lib/openclaw/runtime.mjs';

async function fixture(t, source = '# Scope\n#### Original heading\n```text\n  keep literal  \n```\n\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-copy-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  const config = documentHookPolicy('fixture', openclawDocumentOptions());
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), config);
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Preserve the complete source.');
  await fs.writeFile(path.join(root, 'requirements.md'), source);
  await fs.writeFile(path.join(root, 'design.md'), source);
  const check = () => checkArtifact({ cwd: root, filePath: 'design.md', deferPersistence: true });
  return { root, source, config, check };
}

test('rules.enabled false disables baseline style rules while explicit copy fidelity still rejects changed literals', async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).result.status, 'passed', 'Original heading jumps must not activate disabled baseline rules');
  await fs.writeFile(path.join(f.root, 'design.md'), f.source.replace('  keep literal  ', ' keep literal '));
  const prepared = await f.check();
  assert.equal(prepared.result.status, 'failed');
  assert.equal(prepared.result.diagnostics[0].ruleId, 'DOCUMENT-COPY-MISMATCH');
  assert.equal(prepared.result.diagnostics[0].line, 4);
  assert.match(prepared.result.diagnostics[0].evidence[0], /  keep literal  /u);
  assert(!prepared.result.diagnostics.some(item => item.ruleId === 'MARKDOWN-HEADING-JUMP'));
  const finalized = await finalizeArtifactCheck(prepared, { status: 'completed', findings: [], diffs: [], edits: [], summary: 'Model says passed.' });
  assert.equal(finalized.result.status, 'failed', 'A semantic PASS must not erase deterministic copy errors');
  assert.equal(await fs.readFile(path.join(f.root, 'design.md'), 'utf8'), f.source.replace('  keep literal  ', ' keep literal '), 'Review must never rewrite business files');
});

test('copy review exposes missing EOF newlines and passes a real repair, retaining exact input hashes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'design.md'), f.source.slice(0, -1));
  const first = await f.check();
  assert.equal(first.result.status, 'failed');
  assert.match(first.result.diagnostics[0].suggestion, /EOF\/newlines/u);
  assert.notEqual(first.result.metadata.documentCopy[0].expectedSha256, first.result.metadata.documentCopy[0].actualSha256);
  await fs.writeFile(path.join(f.root, 'design.md'), f.source);
  const second = await f.check();
  assert.equal(second.result.status, 'passed');
  assert.equal(second.result.metadata.documentCopy[0].exact, true);
  assert.notEqual(first.result.metadata.inputDigest, second.result.metadata.inputDigest);
});

test('literal trailing whitespace keeps strict failure and directs native repair away from fuzzy no-op edit', async t => {
  const f = await fixture(t, '# Scope\n```text\nhvplot                        0.5.2                           \n```\n');
  const actual = f.source.replace('0.5.2                           ', '0.5.2                          ');
  await fs.writeFile(path.join(f.root, 'design.md'), actual);
  const prepared = await f.check(), finding = prepared.result.diagnostics[0];
  assert.equal(prepared.result.status, 'failed');
  assert.equal(finding.line, 3);
  assert(finding.evidence.some(line => line.includes('source 27, current 26')));
  assert.match(finding.suggestion, /native write tool/u);
  assert.equal(await fs.readFile(path.join(f.root, 'design.md'), 'utf8'), actual);
  assert.equal((await finalizeArtifactCheck(prepared, { status: 'completed', findings: [], diffs: [], edits: [] })).result.status, 'failed');
});

test('ordinary style checks stay enabled when requested and a copy source cannot escape declared authority', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.runtime-corrector/empty.yaml'), 'version: 1\nrules: []\n');
  const enabled = f.config.replace('rules:\n      enabled: false', 'rules:\n      enabled: true\n      file: empty.yaml');
  await fs.writeFile(path.join(f.root, '.runtime-corrector/config.yaml'), enabled);
  assert((await f.check()).result.diagnostics.some(item => item.ruleId === 'MARKDOWN-HEADING-JUMP'));
  await fs.writeFile(path.join(f.root, '.runtime-corrector/config.yaml'), f.config.replace('copyFrom: original-requirements', 'copyFrom: undeclared-source'));
  await assert.rejects(f.check(), /must be bound/u);
});

test('document copy is opt-in and an unavailable declared source remains unverified', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.runtime-corrector/config.yaml'), f.config.replace('      copyFrom: original-requirements\n', ''));
  await fs.writeFile(path.join(f.root, 'design.md'), 'A legitimate differently structured design.\n');
  assert.equal((await f.check()).result.status, 'passed');
  await fs.writeFile(path.join(f.root, '.runtime-corrector/config.yaml'), f.config.replace('review:\n      enabled: true', 'review:\n      enabled: false'));
  assert.equal((await f.check()).result.status, 'passed', 'Disabling review also disables its optional copy contract');
  await fs.writeFile(path.join(f.root, '.runtime-corrector/config.yaml'), f.config);
  await fs.unlink(path.join(f.root, 'requirements.md'));
  const missing = await f.check();
  assert.equal(missing.result.status, 'pending');
  assert(missing.result.diagnostics.some(item => item.ruleId === 'DOCUMENT-COPY-SOURCE-UNRESOLVED'));
});

test('document navigation checkpoint failures never escape into host compaction', async t => {
  const hooks = new Map(), id = `failed-document-${Date.now()}`;
  registerDocumentTools({ registerTool() {}, on: (name, callback) => hooks.set(name, callback) });
  const unbind = bindDocumentTools({ sessionId: id, runId: 'run', active() {}, tools: { async checkpoint() { throw new Error('Notes disk unavailable'); } } });
  t.after(unbind);
  for (const hook of hooks.values()) await assert.doesNotReject(hook({}, { sessionId: id, runId: 'run' }));
});

test('a plugin exception and failed background cleanup do not abort or reject the native host invocation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-doc-fail-open-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = new AbortController(), reviewController = new AbortController();
  const state = { agentId: 'main', sessionId: 'host', sessionKey: 'agent:main:host', projectRoot: root,
    nativeRunId: 'run', reviewController, seen: new Map(), projectScope: { fingerprint: root } };
  let releases = 0;
  const sharedState = { states: new Map([['main:host', state]]), postRunDispatcher: {
    async load() {}, get() { return null; }, async release() { releases++; throw new Error('Cleanup disk unavailable'); } } };
  const api = { id: 'runtime-corrector', pluginConfig: {}, config: {}, runtime: { agent: {}, state: { resolveStateDir: () => path.join(root, 'host-state') } },
    logger: { warn() { throw new Error('Logger unavailable'); } } };
  const runtime = createOpenClawRuntime(api, { pluginRoot: path.resolve('.'), nativeHooks: true, sharedState,
    projectScopes: { async resolve() { throw null; } } });
  await assert.doesNotReject(runtime.beforeTool({ toolName: 'write', toolCallId: 'write', params: { path: 'design.md' } },
    { agentId: 'main', sessionId: 'host', sessionKey: state.sessionKey, runId: 'run', abortSignal: host.signal }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(releases, 1);
  assert.equal(host.signal.aborted, false);
  assert.equal(reviewController.signal.aborted, true, 'Only plugin-owned work may be cancelled');
  assert.match(state.seen.get('feedback:write'), /RC_REVIEW_UNVERIFIED/u);
});
