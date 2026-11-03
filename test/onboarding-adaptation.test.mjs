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
  const calls = [], roles = [];
  const api = { config: {}, runtime: { version: '2026.7.1-2', agent: { runEmbeddedAgent: async params => {
    calls.push(params); return { payloads: [{ text: JSON.stringify(await response({ params, calls, root, task })) }], meta: {} };
  } } }, logger: { warn() {} } };
  const native = createOpenClawReviewerFactory(api, { provider: 'fixture', model: 'fixture-model' });
  const factory = Object.assign(options => { roles.push(options.role); return native(options); }, native);
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [], panel: { size: 1, adjudicator: false } },
    skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    implementationCorrection: { enabled: false }, stopCorrection: { enabled: true },
    reviewers: { groundTruthExtractor: { timeoutMs: 5000, formatRepairAttempts: 1 } } }, { policyRoot: path.join(root, '.runtime-corrector') });
  const input = { cwd: root, session_id: 'onboarding-parent', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'write',
    transcript_path: transcript, hook_event_id: 'onboard-adaptation' };
  return { root, task, snapshot, input, runtimeV2, reviewerFactory: factory, calls, roles };
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
