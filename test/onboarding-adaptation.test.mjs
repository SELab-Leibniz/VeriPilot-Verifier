import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { ensureTask, findTask, taskDirectory, decisionGuard } from '../lib/runtime-v2/task-store.mjs';
import { loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { runTaskOnboarding, maybeRunTaskOnboarding, materialManifest, sortMaterialEntries } from '../lib/runtime-v2/onboarding.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { readConsoleObservations } from '../lib/openclaw/console-observations.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const operation = (text, expectedFiles) => ({ operation: 'ADD', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
  applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT', text, expectedFiles,
  source: { ref: 'transcript:u1', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } });
const report = operations => ({ summary: 'Controlled original requirements.', taskClassification: 'CONTINUATION', operations });

async function fixture(t, response) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-onboard-adapt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'onboarding-parent' });
  const snapshot = { entries: [{ type: 'user', uuid: 'u1', message: { content: 'Deliver app.mjs and docs/guide.md.' } }] };
  const transcript = path.join(root, 'conversation.jsonl');
  await fs.writeFile(transcript, snapshot.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const calls = [], roles = [], requests = [];
  const api = { config: {}, runtime: { version: '2026.7.1-2', agent: { runEmbeddedAgent: async params => {
    calls.push(params); return { payloads: [{ text: JSON.stringify(await response({ params, calls, root, task })) }], meta: {} };
  } } }, logger: { warn() {} } };
  const native = createOpenClawReviewerFactory(api, { provider: 'fixture', model: 'fixture-model' });
  const factory = Object.assign(options => { roles.push(options.role); requests.push(structuredClone(options.request)); return native(options); }, native);
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [], panel: { size: 1, adjudicator: false } },
    skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    implementationCorrection: { enabled: false }, stopCorrection: { enabled: true },
    reviewers: { groundTruthExtractor: { timeoutMs: 5000, formatRepairAttempts: 1 } } }, { policyRoot: path.join(root, '.runtime-corrector') });
  const input = { cwd: root, session_id: 'onboarding-parent', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'write',
    transcript_path: transcript, hook_event_id: 'onboard-adaptation' };
  return { root, task, snapshot, input, runtimeV2, reviewerFactory: factory, calls, roles, requests };
}

test('expectedFiles errors repair in the native role session before any ledger write, within its existing budget', async t => {
  const f = await fixture(t, async ({ calls, root, task }) => {
    assert.equal((await loadCurrentGroundTruth(root, task.taskId)).version, 0, 'preflight runs before writes');
    return report([operation('Deliver app.mjs.', ['app.mjs']), operation('Deliver docs/guide.md.', calls.length === 1 ? ['wrong.md'] : ['docs/guide.md'])]);
  });
  const outcome = await runTaskOnboarding({ ...f, projectRoot: f.root });
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  assert.equal(f.calls.length, 2, 'one configured repair, without another panel');
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert.notEqual(f.calls[0].runId, f.calls[1].runId);
  assert.match(f.calls[1].prompt, /ONBOARDING_OPERATIONS_INVALID/);
  assert.match(f.calls[1].prompt, /expectedFiles/);
  assert(f.calls[1].timeoutMs <= f.calls[0].timeoutMs);
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 2); assert.equal(current.frozenAtVersion, current.version);
});

test('exhausted metadata repair retains an invalid duty, writes valid siblings, and retries without dropping or duplicating obligations', async t => {
  const original = [operation('Deliver app.mjs.', ['app.mjs']), operation('Deliver docs/guide.md.', ['wrong.md'])];
  original[0].claimId = 'original-app';
  const f = await fixture(t, ({ calls }) => report(calls.length % 2 === 1 ? structuredClone(original) : []));
  let outcome;
  for (let attempt = 0; attempt < 3; attempt++) {
    outcome = await maybeRunTaskOnboarding({ ...f, projectRoot: f.root });
    assert.equal(outcome.status, attempt < 2 ? 'DEFERRED' : 'UNVERIFIED', JSON.stringify(outcome));
    const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
    assert.equal(current.claims.length, 1); assert.equal(current.frozenAtVersion, null);
    assert.deepEqual(outcome.pendingOperations[0].operation, { ...original[1], panelConfirmed: true });
  }
  assert.equal(f.calls.length, 6, 'three existing onboarding attempts, each with one configured native repair');
  const task = await findTask({ projectRoot: f.root, sessionId: f.input.session_id });
  assert.deepEqual(task.groundTruth.onboardingPending[0].operation, { ...original[1], panelConfirmed: true });
  const data = await readConsoleObservations({ projectRoot: f.root, sessionId: f.input.session_id }, task);
  assert.equal(data.baseline.pending, true); assert.equal(data.baseline.pendingOperations.length, 1);
  assert(data.records.some(row => row.kind === 'baseline' && row.status === 'UNVERIFIED'));
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: f.runtimeV2 }, reviewerFactory: f.reviewerFactory,
    input: { ...f.input, hook_event_name: 'Stop', hook_event_id: 'pending-stop', last_assistant_message: 'All requested work is complete.' },
    assessmentContext: { mode: 'verify_only', assessmentId: 'pending-onboarding', guard: decisionGuard(task), deadlineAt: Date.now() + 10000 } });
  assert.equal(result.stop.status, 'UNVERIFIED', JSON.stringify(result));
  assert.match(JSON.stringify(result), /ONBOARDING_OPERATIONS_UNVERIFIED/);
  assert.equal(f.roles.filter(role => role === 'stop-reviewer').length, 0);
  const journal = await fs.readFile(path.join(taskDirectory(f.root, task.taskId), 'journal/events.jsonl'), 'utf8');
  assert.match(journal, /ONBOARDING_OPERATION_UNVERIFIED/);
});

test('a later bounded retry can repair pending metadata and freeze the complete ledger', async t => {
  let repaired = false;
  const f = await fixture(t, () => report([operation('Deliver app.mjs.', ['app.mjs']), operation('Deliver docs/guide.md.', repaired ? ['docs/guide.md'] : ['wrong.md'])]));
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'DEFERRED');
  repaired = true;
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'COMPLETED');
  const task = await findTask({ projectRoot: f.root, sessionId: f.input.session_id });
  assert.deepEqual(task.groundTruth.onboardingPending, []);
  const current = await loadCurrentGroundTruth(f.root, task.taskId);
  assert.equal(current.claims.length, 2); assert.equal(current.frozenAtVersion, current.version);
});

test('fresh panels cannot omit a pending original across all retries or restart and cannot permit Stop PASS', async t => {
  const valid = operation('Deliver app.mjs.', ['app.mjs']), invalid = operation('Deliver docs/guide.md.', ['wrong.md']);
  valid.claimId = 'retained-valid-app';
  let attempt = 0;
  const f = await fixture(t, () => report(attempt === 0 ? [valid, invalid] : [valid]));
  let pendingId;
  for (; attempt < 3; attempt++) {
    // Rehydrate from disk between attempts. The originally captured task object
    // is deliberately stale, exactly as a restarted controller may receive it.
    if (attempt) assert((await findTask({ projectRoot: f.root, sessionId: f.input.session_id })).groundTruth.onboardingPending.length);
    const outcome = await maybeRunTaskOnboarding({ ...f, projectRoot: f.root });
    assert.equal(outcome.status, attempt < 2 ? 'DEFERRED' : 'UNVERIFIED', JSON.stringify(outcome));
    assert.equal(outcome.pendingOperations.length, 1);
    pendingId ??= outcome.pendingOperations[0].operationId;
    assert.equal(outcome.pendingOperations[0].operationId, pendingId);
    assert.deepEqual(outcome.pendingOperations[0].operation, { ...invalid, panelConfirmed: true });
    const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
    assert.equal(current.claims.length, 1); assert.equal(current.claims[0].claimId, valid.claimId); assert.equal(current.frozenAtVersion, null);
  }
  assert.equal(f.requests.length, 3); assert.deepEqual(f.requests[0].pendingOperations, []);
  for (const request of f.requests.slice(1)) {
    assert.equal(request.pendingOperations[0].operationId, pendingId);
    assert.deepEqual(request.pendingOperations[0].operation, { ...invalid, panelConfirmed: true });
    assert(request.instructions.some(instruction => instruction.includes('omission')));
  }
  const calls = f.calls.length;
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'UNVERIFIED');
  assert.equal(f.calls.length, calls, 'a restart cannot reset the bounded retry ladder');
  const task = await findTask({ projectRoot: f.root, sessionId: f.input.session_id });
  const result = await handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2: f.runtimeV2 }, reviewerFactory: f.reviewerFactory,
    input: { ...f.input, hook_event_name: 'Stop', hook_event_id: 'omitted-pending-stop', last_assistant_message: 'Complete.' },
    assessmentContext: { mode: 'verify_only', assessmentId: 'omitted-onboarding', guard: decisionGuard(task), deadlineAt: Date.now() + 10000 } });
  assert.equal(result.stop.status, 'UNVERIFIED', JSON.stringify(result));
  assert.match(JSON.stringify(result), /ONBOARDING_OPERATIONS_UNVERIFIED/);
  assert.equal(f.roles.filter(role => role === 'stop-reviewer').length, 0);
});

test('explicit same-duty repair after an omitted retry clears only that original once without duplicating valid siblings', async t => {
  const valid = operation('Deliver app.mjs.', ['app.mjs']), invalid = operation('Deliver docs/guide.md.', ['wrong.md']);
  valid.claimId = 'same-valid-app';
  let attempt = 0;
  const f = await fixture(t, () => report(attempt === 0 ? [valid, invalid] : attempt === 1 ? [valid]
    : [valid, { ...invalid, expectedFiles: ['docs/guide.md'] }]));
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'DEFERRED');
  const pending = (await findTask({ projectRoot: f.root, sessionId: f.input.session_id })).groundTruth.onboardingPending[0];
  attempt = 1;
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'DEFERRED');
  attempt = 2;
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'COMPLETED');
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'COMPLETED');
  const task = await findTask({ projectRoot: f.root, sessionId: f.input.session_id }), current = await loadCurrentGroundTruth(f.root, task.taskId);
  assert.deepEqual(task.groundTruth.onboardingPending, []); assert.equal(current.frozenAtVersion, current.version);
  assert.equal(current.claims.length, 2); assert.equal(current.claims.filter(claim => claim.claimId === valid.claimId).length, 1);
  assert.deepEqual(current.claims.find(claim => claim.text === invalid.text).expectedFiles, ['docs/guide.md']);
  const events = (await fs.readFile(path.join(taskDirectory(f.root, task.taskId), 'journal/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'ONBOARDING_OPERATION_RECONCILED' && event.operationId === pending.operationId).length, 1);
});

test('restart before the outer onboarding receipt cannot turn retained pending originals into an existing-ledger skip', async t => {
  const valid = operation('Deliver app.mjs.', ['app.mjs']), invalid = operation('Deliver docs/guide.md.', ['wrong.md']);
  let attempt = 0;
  const f = await fixture(t, () => report(attempt === 0 ? [valid, invalid] : attempt === 1 ? [valid]
    : [valid, { ...invalid, expectedFiles: ['docs/guide.md'] }]));
  // runTaskOnboarding persists the delta and pending originals before its
  // caller commits the outer receipt: this is the durable crash checkpoint.
  assert.equal((await runTaskOnboarding({ ...f, projectRoot: f.root })).status, 'UNVERIFIED');
  const saved = await findTask({ projectRoot: f.root, sessionId: f.input.session_id });
  assert.equal(saved.onboarding, undefined); assert(saved.groundTruth.onboardingPending.length);
  attempt = 1;
  const resumed = await maybeRunTaskOnboarding({ ...f, projectRoot: f.root });
  assert.equal(resumed.status, 'DEFERRED'); assert.equal(resumed.pendingOperations.length, 1);
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).frozenAtVersion, null);
  attempt = 2;
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'COMPLETED');
  assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).claims.length, 2);
});

test('dropping invalid delivery metadata or weakening duty semantics never reconciles its retained original', async t => {
  const valid = operation('Deliver app.mjs.', ['app.mjs']), invalid = { ...operation('Deliver docs/guide.md.', ['wrong.md']),
    applicability: 'Before publishing, including recovery from an interrupted write.' };
  let replacement = invalid;
  const f = await fixture(t, () => report([valid, replacement]));
  assert.equal((await runTaskOnboarding({ ...f, projectRoot: f.root })).status, 'UNVERIFIED');
  const original = (await findTask({ projectRoot: f.root, sessionId: f.input.session_id })).groundTruth.onboardingPending[0];
  for (const changed of [{ expectedFiles: [] }, { expectedFiles: undefined }, { severity: 'SOFT', expectedFiles: ['docs/guide.md'] },
    { applicability: 'Only after publication.', expectedFiles: ['docs/guide.md'] }, { verificationTarget: 'PROCESS', expectedFiles: ['docs/guide.md'] }]) {
    replacement = { ...invalid, ...changed };
    const outcome = await runTaskOnboarding({ ...f, projectRoot: f.root });
    assert.equal(outcome.status, 'UNVERIFIED', JSON.stringify({ changed, outcome }));
    assert(outcome.pendingOperations.some(pending => pending.operationId === original.operationId));
    assert.deepEqual(outcome.pendingOperations.find(pending => pending.operationId === original.operationId).operation, original.operation);
    assert.equal((await loadCurrentGroundTruth(f.root, f.task.taskId)).frozenAtVersion, null);
  }
});

test('exhausted native source repair isolates its invalid original while valid siblings still apply', async t => {
  const bad = operation('Deliver docs/guide.md.', ['docs/guide.md']); bad.source.ref = 'transcript:unknown';
  const f = await fixture(t, ({ calls }) => calls.length === 1 ? report([operation('Deliver app.mjs.', ['app.mjs']), bad])
    : { sourceRepairs: [{ index: 1, source: bad.source }] });
  const result = await runTaskOnboarding({ ...f, projectRoot: f.root });
  assert.equal(result.status, 'UNVERIFIED', JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  const current = await loadCurrentGroundTruth(f.root, f.task.taskId);
  assert.equal(current.claims.length, 1); assert.equal(current.frozenAtVersion, null);
  assert.equal(result.pendingOperations[0].operation.text, bad.text);
  assert.equal(result.pendingOperations[0].operation.source.ref, 'transcript:unknown');
});

test('an explicit validated source-ref repair reconciles a persisted original while retaining its duty and proof owner', async t => {
  const valid = operation('Deliver app.mjs.', ['app.mjs']), invalid = operation('Deliver docs/guide.md.', ['docs/guide.md']);
  invalid.source.ref = 'transcript:unknown';
  let repairing = false;
  const f = await fixture(t, ({ calls }) => repairing ? report([valid, { ...invalid, source: { ...invalid.source, ref: 'transcript:u1' } }])
    : calls.length === 1 ? report([valid, invalid]) : { sourceRepairs: [{ index: 1, source: invalid.source }] });
  assert.equal((await maybeRunTaskOnboarding({ ...f, projectRoot: f.root })).status, 'DEFERRED');
  const original = (await findTask({ projectRoot: f.root, sessionId: f.input.session_id })).groundTruth.onboardingPending[0];
  assert.equal(original.reasonCode, 'SOURCE_BINDING_INVALID');
  repairing = true;
  const outcome = await maybeRunTaskOnboarding({ ...f, projectRoot: f.root });
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const task = await findTask({ projectRoot: f.root, sessionId: f.input.session_id }), current = await loadCurrentGroundTruth(f.root, task.taskId);
  assert.deepEqual(task.groundTruth.onboardingPending, []); assert.equal(current.claims.length, 2);
  const repaired = current.claims.find(claim => claim.text === invalid.text);
  assert.equal(repaired.source.ref, 'transcript:u1'); assert.equal(repaired.source.kind, invalid.source.kind);
  assert.equal(repaired.source.subject, invalid.source.subject); assert.equal(repaired.verificationTarget, invalid.verificationTarget);
  assert.deepEqual(repaired.expectedFiles, invalid.expectedFiles);
});

test('nested and individual material roots use the same relative codepoint order on Windows and POSIX', () => {
  const entries = api => [
    { root: api.join(api.sep === '\\' ? 'C:\\p' : '/p', 'skills'), path: 'demo/examples/demo.py', id: 'parent-example' },
    { root: api.join(api.sep === '\\' ? 'C:\\p' : '/p', 'skills/demo'), path: 'SKILL.md', id: 'file-root-skill' },
    { root: api.join(api.sep === '\\' ? 'C:\\p' : '/p', 'skills/demo/examples'), path: 'demo.py', id: 'nested-example' },
    { root: api.join(api.sep === '\\' ? 'C:\\p' : '/p', 'skills'), path: 'demo/SKILL.md', id: 'parent-skill' },
  ];
  const expected = ['parent-skill', 'file-root-skill', 'parent-example', 'nested-example'];
  assert.deepEqual(sortMaterialEntries(entries(path.win32), path.win32).map(entry => entry.id), expected);
  assert.deepEqual(sortMaterialEntries(entries(path.posix), path.posix).map(entry => entry.id), expected);
});

test('material manifest ordering and digest are stable for nested directory and file roots', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-onboard-order-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'skills/demo'), examples = path.join(skill, 'examples'), file = path.join(skill, 'SKILL.md');
  await fs.mkdir(examples, { recursive: true }); await fs.writeFile(file, 'Original Skill.\n'); await fs.writeFile(path.join(examples, 'demo.py'), '# Original example.\n');
  const roots = [examples, file, skill], first = await materialManifest(roots), second = await materialManifest([...roots].reverse());
  assert.deepEqual(first, second, 'root declaration order must not change source numbering or digest');
  assert.equal(first.entries[0].path, 'SKILL.md');
});

test('critical-path diagnostics skip an absent host and preserve a pre-workspace validator failure', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-onboard-diagnostic-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.RC_OPENCLAW_HOST_ROOT;
  const run = host => spawnSync(process.execPath, ['--test', '--test-name-pattern=critical-path MATERIAL revision', 'test/stop-baseline-task.test.mjs'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env: host ? { ...env, RC_OPENCLAW_HOST_ROOT: host } : env,
      encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const absent = run(); assert.equal(absent.status, 0, absent.stdout + absent.stderr);
  assert.match(absent.stdout, /Requires RC_OPENCLAW_HOST_ROOT/);
  const unavailable = run(path.join(root, 'missing-host'));
  assert.equal(unavailable.status, 1, unavailable.stdout + unavailable.stderr);
  assert.match(unavailable.stdout, /"lastWorkspace":null/);
  assert.match(unavailable.stdout, /ENOENT/);
  assert.doesNotMatch(unavailable.stdout + unavailable.stderr, /TypeError|ERR_INVALID_ARG_TYPE/);
});
