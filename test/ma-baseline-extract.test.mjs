import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { frozenSourceParts, frozenLineSelection, runStopBaselineTask } from '../lib/runtime-v2/baseline-task.mjs';
import { createNativeTaskSession, nativeTaskFailure } from '../lib/openclaw/task-session.mjs';
import { createBaselineWorker } from '../lib/review-task/baseline-task.mjs';
import { createOwnedBaselineProposal, programPromptedBaselineRetry, verifyOwnedBaselineProposal } from '../lib/review-task/task-evidence.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';
import { listNativeRuns, recordNativeRun } from '../lib/openclaw/native-runs.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { acquireBaselineAgent, BASELINE_REUSE_BYTES } from '../lib/openclaw/baseline-agent.mjs';

async function workspace(t, beforeRemove) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-baseline-')));
  t.after(async () => { try { await beforeRemove?.(); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  return root;
}
const row = value => JSON.stringify(value) + '\n';
const workerAt = cwd => ({ cwd, outputDir: cwd, tools: [], prompt: 'Current frozen originals', systemPrompt: '',
  active() {}, isComplete: () => true, phase: () => 'CANDIDATE_COMPLETE', onAssistantMessageStart() {} });
const inputAt = root => ({ projectRoot: root, taskId: 'baseline', role: 'ground-truth-extractor',
  request: { reviewScope: { boundedBasis: true } }, reviewer: { timeoutMs: 10000 } });
const selection = { config: {}, provider: 'offline', model: 'fixture' };

test('frozen source parts end at complete original lines without boundary overlap', () => {
  for (const first of ['a'.repeat(16000), 'a'.repeat(16383)]) {
    const bytes = Buffer.from(`${first}\n${'b'.repeat(1000)}\n`), parts = frozenSourceParts(bytes);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map(({ startLine, endLine }) => [startLine, endLine]), [[1, 1], [2, 2]]);
    assert(parts.every(part => !part.startsMidLine && !part.endsMidLine));
    assert.deepEqual(Buffer.concat(parts.map(part => bytes.subarray(part.startByte, part.endByte))), bytes);
    const selected = frozenLineSelection(bytes, 1, 2);
    assert.equal(selected.text, `${first}\n${'b'.repeat(1000)}`);
    assert.equal(selected.byteStart, 0); assert.equal(selected.byteEnd, bytes.length - 1);
    assert.equal(frozenLineSelection(bytes, 1, 1, parts[1]).text, 'b'.repeat(1000));
  }
});

test('a long UTF-8 original line can be selected across byte fallback parts without accepting a fragment', () => {
  const original = '界'.repeat(8000), bytes = Buffer.from(`${original}\nnext`), parts = frozenSourceParts(bytes);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].endLine, 0); assert.equal(parts[0].endsMidLine, true);
  assert.equal(parts[1].startLine, 1); assert.equal(parts[1].startsMidLine, true);
  assert(parts.every(part => part.endByte - part.startByte <= 16384));
  for (const part of parts) assert(!bytes.subarray(part.startByte, part.endByte).toString('utf8').includes('\ufffd'));
  assert.equal(frozenLineSelection(bytes, 1, 1).text, original);
  assert.equal(frozenLineSelection(bytes, 1, 2).text, `${original}\nnext`);
  for (const part of parts) assert.throws(() => frozenLineSelection(bytes, 1, 1, part), /partial original line/u);
  assert.deepEqual(frozenSourceParts(Buffer.from('one\ntwo')).map(p => [p.startLine, p.endLine]), [[1, 2]]);
});

test('baseline freezing accepts Windows case aliases while rejecting real ancestor links', async t => {
  const root = await workspace(t), directory = path.join(root, 'materials'), alias = path.join(root, 'linked');
  await fs.mkdir(directory); const file = path.join(directory, 'Design.md'); await fs.writeFile(file, 'Business source.\n');
  await fs.symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const task = await ensureTask({ projectRoot: root, sessionId: 'source-check' }), truth = await loadCurrentGroundTruth(root, task.taskId);
  const truthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json'); await atomicWriteJson(truthPath, truth);
  let prepared;
  const input = { ...inputAt(root), taskId: task.taskId, schema: GROUND_TRUTH_REVIEW_SCHEMA,
    request: { taskId: task.taskId, currentGroundTruth: { path: truthPath, version: truth.version, digest: truth.digest },
      sourceCatalog: [{ kind: 'USER_MESSAGE', ref: 'transcript:U1' }, { kind: 'MATERIAL', ref: process.platform === 'win32' ? path.join(directory, 'design.md') : file }],
      reviewScope: { kind: 'baseline', boundedBasis: true } },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { role: 'user', content: 'Preserve the source.' } }] } },
    onPrepared: value => { prepared = value.request; } };
  const dependencies = { api: { runtime: { version: '2026.7.1-2', agent: {} } }, selection,
    nativeRunner: async () => { throw Object.assign(new Error('Source freeze captured'), { code: 'CAPTURED' }); },
    options: { loadPublicToolArgumentsValidator: async () => ({ identity: { scope: 'offline-unit-double' }, validateToolArguments: (_tool, call) => call.arguments }) } };
  await assert.rejects(runStopBaselineTask(input, dependencies), { code: 'CAPTURED' });
  assert.equal(prepared.identity.sources.find(source => source.kind === 'MATERIAL').sha256, sha256(await fs.readFile(file)));
  input.request.hookEventId = 'linked-source'; input.request.sourceCatalog[1].ref = path.join(alias, 'Design.md');
  await assert.rejects(runStopBaselineTask(input, dependencies), { code: 'BASELINE_SOURCE_INVALID' });
});

test('a reused native extractor keeps cwd stable before the host can rewrite its anchored transcript', async t => {
  const root = await workspace(t), api = { runtime: { version: '2026.7.1-2', agent: {} } }, calls = [], prefixes = [];
  const nativeRunner = async params => {
    let text = await fs.readFile(params.sessionFile, 'utf8').catch(() => '');
    if (text) {
      const [header, ...tail] = text.trimEnd().split('\n').map(JSON.parse);
      if (header.cwd !== params.cwd) text = [row({ ...header, cwd: params.cwd }), ...tail.map(row)].join('');
      await fs.writeFile(params.sessionFile, text);
    } else await fs.writeFile(params.sessionFile, row({ type: 'session', id: params.sessionId, cwd: params.cwd }));
    if (prefixes.length) assert((await fs.readFile(params.sessionFile)).subarray(0, prefixes.at(-1).length).equals(prefixes.at(-1)));
    await fs.appendFile(params.sessionFile, row({ type: 'message', message: { role: 'assistant', content: [] } }));
    calls.push(params); return { payloads: [], meta: {} };
  };
  let previous;
  for (const directory of ['frozen-one', 'frozen-two']) {
    const cwd = path.join(root, directory); await fs.mkdir(cwd);
    const session = await createNativeTaskSession(inputAt(root), { api, nativeRunner, selection });
    const worker = workerAt(cwd);
    worker.bindNative = async native => { if (previous) prefixes.push(await fs.readFile(native.sessionFile)); };
    await session.run(worker); await session.close();
    if (previous) { assert.equal(session.sessionId, previous.sessionId); assert.equal(session.extractorReused, true); }
    previous = session;
  }
  assert.equal(calls[0].cwd, calls[1].cwd);
  assert.equal(calls[1].cwd, path.join(root, 'frozen-one'));
});

test('no-assistant native sessions retire before a queued extractor acquires their identity', async t => {
  const root = await workspace(t), api = { runtime: { version: '2026.7.1-2', agent: {} } }, disposed = [];
  const nativeRunner = async params => {
    await fs.writeFile(params.sessionFile, row({ type: 'session', id: params.sessionId })
      + row({ type: 'custom', message: { role: 'assistant', content: [] } }));
    return { payloads: [], meta: {} };
  };
  nativeRunner.close = async (...identity) => { disposed.push(identity); };
  const first = await createNativeTaskSession(inputAt(root), { api, nativeRunner, selection });
  await first.run(workerAt(root));
  const pending = createNativeTaskSession(inputAt(root), { api, nativeRunner, selection });
  await first.close(); const next = await pending;
  assert.notEqual(next.sessionId, first.sessionId); assert.equal(next.extractorReused, false);
  assert.deepEqual(disposed, [[first.sessionKey, first.sessionId]]); await next.close();
});

test('pool release retires an existing header-only transcript even without a dispatch hint', async t => {
  const root = await workspace(t), owner = {}, args = { owner, projectRoot: root, agentId: 'main', selection, deadlineAt: Date.now() + 10000 };
  const first = await acquireBaselineAgent(args);
  await fs.writeFile(first.sessionFile, row({ type: 'session', id: first.sessionId }));
  await first.release();
  const next = await acquireBaselineAgent(args);
  assert.notEqual(next.sessionId, first.sessionId); assert.equal(next.reused, false); await next.release();
});

test('context-overflow sessions with assistant history retire before the next extractor', async t => {
  const root = await workspace(t), api = { runtime: { version: '2026.7.1-2', agent: {} } }, disposed = [];
  const runner = async params => {
    await fs.writeFile(params.sessionFile, row({ type: 'session', id: params.sessionId })
      + row({ type: 'message', message: { role: 'assistant', content: [], stopReason: 'error' } }));
    throw Object.assign(new Error('Context overflow: prompt too large'), { code: 'REVIEWER_RUN_FAILED' });
  };
  runner.close = async (...identity) => { disposed.push(identity); };
  const first = await createNativeTaskSession(inputAt(root), { api, nativeRunner: runner, selection });
  await assert.rejects(first.run({ ...workerAt(root), isComplete: () => false, phase: () => 'READING' }), /Context overflow/);
  await first.close();
  const next = await createNativeTaskSession(inputAt(root), { api, nativeRunner: runner, selection });
  assert.notEqual(next.sessionId, first.sessionId); assert.equal(next.extractorReused, false);
  assert.deepEqual(disposed, [[first.sessionKey, first.sessionId]]);
  await next.close();
});

test('source inventory validation shares the original finite repair budget and replay cannot double-debit', async t => {
  const f = await proposalFixture(t), native = { ...f.native, runId: 'independent-checker', sessionId: 'checker-session' };
  f.worker.budget.beginAudit(native, 'candidate');
  const digest = sha256('unchanged failed inventory');
  f.worker.budget.rejectInventory(native, 'submit-1', digest);
  f.worker.budget.rejectInventory(native, 'submit-1', digest);
  assert.equal(f.worker.budget.snapshot().repairs, 1);
  for (let index = 2; index <= 4; index++) f.worker.budget.rejectInventory(native, `submit-${index}`, digest);
  assert.equal(f.worker.budget.snapshot().repairs, 4);
  assert.throws(() => f.worker.budget.rejectInventory(native, 'submit-5', digest), /repair allowance exhausted/);
});

test('large successful extractor histories retire while their original evidence remains intact', async t => {
  const root = await workspace(t), api = { runtime: { version: '2026.7.1-2', agent: {} } }, disposed = [];
  const runner = async params => {
    await fs.writeFile(params.sessionFile, row({ type: 'session', id: params.sessionId })
      + row({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(BASELINE_REUSE_BYTES) }] } }));
    return { payloads: [], meta: {} };
  };
  runner.close = async (...identity) => disposed.push(identity);
  const first = await createNativeTaskSession(inputAt(root), { api, nativeRunner: runner, selection });
  await first.run(workerAt(root)); await first.close();
  const next = await createNativeTaskSession(inputAt(root), { api, nativeRunner: runner, selection });
  assert.notEqual(next.sessionId, first.sessionId); assert.equal(next.extractorReused, false);
  assert.deepEqual(disposed, [[first.sessionKey, first.sessionId]]);
  const retained = await fs.readFile(path.join(root, '.runtime-correction/baseline-agent', first.sessionId, 'host-session.jsonl'));
  assert(retained.length > BASELINE_REUSE_BYTES);
  await next.close();
});

test('native failures preserve redacted causes, stage and run/task identity in page-readable state', async t => {
  const root = await workspace(t), secret = 'private-provider-credential', api = { runtime: { version: '2026.7.1-2', agent: {} } };
  const config = { models: { providers: { offline: { apiKey: secret } } } };
  const nativeRunner = async () => { throw Object.assign(new Error(`Provider rejected authorization: Bearer ${secret}`, {
    cause: Object.assign(new Error(`api_key=${secret}; upstream unavailable`), { code: 'ECONNRESET' }) }), { code: 'AUTH_FAILED' }); };
  const session = await createNativeTaskSession(inputAt(root), { api, nativeRunner, selection: { ...selection, config } });
  await assert.rejects(session.run({ ...workerAt(root), isComplete: () => false, phase: () => 'READING' }), error => {
    assert.equal(error.code, 'AUTH_FAILED'); assert.equal(error.cause.code, 'ECONNRESET');
    assert.equal(error.nativeFailure.stage, 'NATIVE_EXECUTION'); assert.equal(error.nativeFailure.taskId, 'baseline');
    assert.equal(error.nativeFailure.runId, session.runId); assert(!JSON.stringify(error.nativeFailure).includes(secret)); return true;
  });
  await session.close();
  const status = JSON.parse(await fs.readFile(path.join(taskDirectory(root, 'baseline'), 'baseline-extraction-status.json'), 'utf8'));
  assert.equal(status.phase, 'INTERRUPTED'); assert.equal(status.failure.code, 'AUTH_FAILED');
  assert.equal(status.failure.causes[0].code, 'ECONNRESET'); assert(!JSON.stringify(status).includes(secret));
  const runs = await listNativeRuns(root, 'baseline');
  assert.equal(runs[0].status, 'SETTLED'); assert.deepEqual(runs[0].failure, status.failure);
  const message = nativeTaskFailure(new Error('x-api-key=sk-verylongcredential01234567890'), { taskId: 't', runId: 'r', stage: 'RESULT_VALIDATION' });
  assert(!message.message.includes('sk-verylongcredential'));
  const overflow = nativeTaskFailure(Object.assign(new Error('REVIEWER_RUN_FAILED: REVIEWER_RUN_FAILED: Context overflow'), { code: 'REVIEWER_RUN_FAILED' }),
    { taskId: 't', runId: 'r', stage: 'NATIVE_EXECUTION' });
  assert.equal(overflow.message, 'REVIEWER_RUN_FAILED: Context overflow');
});

async function proposalFixture(t) {
  let worker;
  const root = await workspace(t, () => worker?.close()), source = path.join(root, 'source'), outputDir = path.join(root, 'worker');
  await fs.mkdir(source); await fs.mkdir(outputDir); await fs.writeFile(path.join(source, 'source.txt'), 'original\n');
  const identity = { taskId: 'baseline', requestId: 'current', sources: [], sourceCatalog: [] };
  worker = await createBaselineWorker({ root: source, outputDir, identity, requiredFiles: ['source.txt'],
    schema: GROUND_TRUTH_REVIEW_SCHEMA, deadlineAt: Date.now() + 10000, active() {}, assertCurrent() {}, bindOperations: value => value,
    maxRepairs: 4, nativeRun: async () => {} });
  const native = { taskId: 'baseline', runId: 'native-run', sessionId: 'native-session', role: 'ground-truth-extractor',
    ownerPid: process.pid, sessionFile: path.join(root, 'native.jsonl') };
  await fs.writeFile(native.sessionFile, row({ type: 'session', id: native.sessionId }));
  const capability = { identity: { scope: 'offline-unit-double' }, validateToolArguments(tool, call) {
    const issues = validateJsonSchema(call.arguments, tool.parameters); if (issues.length) throw new Error(issues[0].message); return call.arguments;
  } };
  const proposal = await createOwnedBaselineProposal({ directory: path.join(root, 'proposals'), toolName: 'save_baseline_batch',
    identity: () => ({ requestId: 'current' }), active() {}, validationCapability: capability, maxBytes: 51200,
    bindBudgetConsumer: value => worker.budget.bindProposalConsumer('extractor', value) });
  await proposal.bindNative(native);
  const binding = { ...native, sessionKey: 'agent:main:runtime-corrector:native-session' };
  proposal.bindToolBinding(binding, () => true);
  let ordinal = 0;
  const parameters = { type: 'object', required: ['batchId', 'good'], properties: { batchId: { type: 'integer' }, good: { type: 'boolean' } }, additionalProperties: false };
  async function call(args, prepare) {
    const id = `call-${++ordinal}`;
    worker.budget.consumeTurn('extractor', native);
    await fs.appendFile(native.sessionFile, row({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'save_baseline_batch', id, arguments: args }] } }));
    const result = await proposal.execute({ id, args, parameters, prepare });
    const message = { role: 'toolResult', toolName: 'save_baseline_batch', toolCallId: id, isError: false, content: result.content };
    proposal.observeReceipt({ toolName: 'save_baseline_batch', toolCallId: id, isSynthetic: false, message }, { binding, sessionKey: binding.sessionKey });
    await fs.appendFile(native.sessionFile, row({ type: 'message', message }));
    return JSON.parse(result.content[0].text);
  }
  return { worker, proposal, native, call, root, parameters, capability };
}

test('owned draft navigation accepts optional current revision metadata without granting a write or extra allowance', async t => {
  const f = await proposalFixture(t);
  const rejected = await f.call({ action: 'submit', value: { batchId: 1, good: false } }, () => {
    throw Object.assign(new Error('Controlled candidate rejection'), { code: 'BASELINE_SCOPE_INVALID' });
  });
  const metadata = await f.call({ action: 'inspect' });
  assert.equal(metadata.proposalId, rejected.proposalId); assert.equal(metadata.revisionDigest, rejected.revisionDigest);
  const page = await f.call({ action: 'inspect', proposalId: rejected.proposalId, path: ['good'] });
  assert.equal(page.navigationOnly, true); assert.equal(page.text, 'false');
  const current = await f.call({ action: 'inspect', path: ['good'] });
  assert.equal(current.text, 'false'); assert.equal(f.worker.budget.snapshot().repairs, 1);
  let proof;
  const accepted = await f.call({ action: 'correct_and_submit',
    parentRevisionDigest: rejected.revisionDigest, changes: [{ op: 'set', path: ['good'], value: true }] },
    async value => ({ receipt: { accepted: value.good }, commit: async (_receipt, value) => { proof = value; } }));
  assert.equal(accepted.accepted, true); assert.equal(f.worker.budget.snapshot().repairs, 1);
  await f.proposal.closeNativeWindow(f.native);
  await recordNativeRun(f.root, { ...f.native, status: 'SETTLED', settledAt: Date.now() });
  await verifyOwnedBaselineProposal({ directory: path.join(f.root, 'proposals'), proof, toolName: 'save_baseline_batch',
    parameters: f.parameters, validationCapability: f.capability, materialized: { batchId: 1, good: true }, receipt: accepted,
    windows: f.proposal.closedWindows(), projectRoot: f.root, taskId: f.native.taskId });
});

for (const legacy of [false, true]) test(`owned repair guidance retains exact parent and ${legacy ? 'exempts proven retired RC instructions' : 'charges ordinary boundary rejections'}`, async t => {
  const f = await proposalFixture(t);
  const first = await f.call({ action: 'submit', value: { batchId: 1, good: false } }, async () => {
    const repair = legacy ? 'Resubmit this unsaved batchId.' : 'Choose the actual owner.';
    throw Object.assign(new Error(`Choose the owner. ${repair}`), { code: 'BASELINE_SCOPE_INVALID',
      baselineValidation: { reason: 'PROOF_OWNER_REQUIRED', repair } });
  });
  assert.equal(first.parentRevisionDigest, first.revisionDigest); assert(first.proposalId);
  assert.match(first.repair, /correct_and_submit/u); assert.match(first.repair, new RegExp(first.parentRevisionDigest, 'u'));
  assert.equal(f.worker.budget.snapshot().repairs, 1);
  const deadlineAt = f.worker.budget.snapshot().deadlineAt;
  const boundary = await f.call({ action: 'submit', value: { batchId: 1, good: true } });
  assert.equal(boundary.repairCharged, !legacy); assert.equal(f.worker.budget.snapshot().repairs, legacy ? 1 : 2);
  assert.equal(f.worker.budget.snapshot().turns, 2); assert.equal(f.worker.budget.snapshot().deadlineAt, deadlineAt);
  const otherBatch = await f.call({ action: 'submit', value: { batchId: 2, good: true } });
  assert.equal(otherBatch.repairCharged, true); assert.equal(f.worker.budget.snapshot().repairs, legacy ? 2 : 3);
  const accepted = await f.call({ action: 'correct_and_submit', proposalId: first.proposalId,
    parentRevisionDigest: first.parentRevisionDigest, changes: [{ op: 'set', path: ['good'], value: true }] }, async value => ({ receipt: { accepted: value.good }, commit: async () => {} }));
  assert.equal(accepted.accepted, true); await f.proposal.closeNativeWindow(f.native);
  const journal = await fs.readFile(f.worker.budget.snapshot().journal.path, 'utf8');
  assert.equal(journal.includes('PROGRAM_PROMPT_REJECTED'), legacy);
});

test('retired-prompt attribution cannot exempt another batch or ordinary corrected guidance', () => {
  const receipt = { accepted: false, code: 'BASELINE_SCOPE_INVALID', validation: { reason: 'PROOF_OWNER_REQUIRED', repair: 'Resubmit this unsaved batchId.' } };
  assert.equal(programPromptedBaselineRetry(receipt, { action: 'submit', value: { batchId: 2 } }, { batchId: 1 }), false);
  assert.equal(programPromptedBaselineRetry({ accepted: false, repair: 'correct_and_submit' }, { action: 'submit', value: { batchId: 1 } }, { batchId: 1 }), false);
  assert.equal(programPromptedBaselineRetry(receipt, { action: 'correct_and_submit', value: { batchId: 1 } }, { batchId: 1 }), false);
  assert.equal(programPromptedBaselineRetry({ accepted: false, message: 'Quoted material: Resubmit this unsaved batchId.' }, { action: 'submit', value: { batchId: 1 } }, { batchId: 1 }), false);
});
