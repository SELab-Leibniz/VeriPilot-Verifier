import { correctionFixtureRuntime } from "./support/openclaw-project-scope.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";
import { isNoopToolRequest } from '../lib/openclaw/tools.mjs';
let output, pluginRoot, createRuntime;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "rc-transparency-build-"));
  pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, "lib/openclaw/runtime.mjs"))));
  createRuntime = correctionFixtureRuntime(createRuntime);
});
after(() => fs.rm(output, { recursive: true, force: true }));
async function fixture(t, pluginConfig = {}, { shadow = false, acceptanceFeedback } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-native-lifecycle-"));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, ".runtime-corrector"));
  await fs.writeFile(path.join(root, ".runtime-corrector/config.yaml"), `version: 2
artifacts:
  - name: draft
    stage: drafting
    patterns: [draft.md]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
shadowMode: ${shadow}
${acceptanceFeedback ? `acceptanceFeedback:\n  tool: ${acceptanceFeedback.tool}\n` : ''}
`);
  const file = path.join(root, "native.jsonl"), sid = "native-parent";
  await fs.writeFile(file, [{ type: "session", id: sid }, { type: "message", id: "u", parentId: null,
    message: { role: "user", content: "Write a draft when appropriate." } }].map(JSON.stringify).join("\n"));
  const sharedState = {}, hostAbort = new AbortController(), warnings = [];
  const sessions = {
    getSessionEntry: async () => ({ sessionId: sid, sessionFile: file }),
    resolveStorePath: () => path.join(root, "sessions.json"), resolveSessionFilePath: () => file,
    runWithWorkAdmission: async (params, run) => run(params.signal),
  };
  const api = { id: "runtime-corrector", config: { agents: { defaults: { model: { primary: "test/test" } } } },
    pluginConfig, logger: { warn: x => warnings.push(x) }, runtime: { version: '2026.7.1-2', agent: { session: sessions,
      runEmbeddedAgent: async () => assert.fail("these lifecycle/interaction fixtures must not call a model") } } };
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey: "agent:main:native", agentId: "main", runId: "host-run", trigger: "user", abortSignal: hostAbort.signal };
  await runtime.prompt({ prompt: "Write a draft when appropriate." }, ctx);
  return { runtime, ctx, sessions, hostAbort, warnings, state: sharedState.states.get(`main:${sid}`) };
}

const checkTool = 'check_fixture';
const acceptanceFeedback = { tool: checkTool };
const middlewareContext = { runtime: 'openclaw' };

function checkReceipt(ctx, toolCallId, kind, status) {
  return { toolName: checkTool, toolCallId, args: { action: kind === 'acceptance' ? 'acceptance' : 'verify' },
    result: { content: [{ type: 'text', text: 'Original check result' }, { type: 'image', data: 'fixture', mimeType: 'image/png' }],
      mediaUrl: 'fixture://media', terminate: false,
      details: { runtimeCorrectorVerification: { runId: ctx.runId, kind, status }, original: { preserved: true } } } };
}

async function bindCheck(f, event, ctx = f.ctx) {
  assert.equal(await f.runtime.beforeTool({ toolName: event.toolName, toolCallId: event.toolCallId, params: event.args }, ctx), undefined);
}

function incompleteReport(ctx, id, action = 'verify') {
  const event = checkReceipt(ctx, id, 'supporting', 'INCOMPLETE');
  event.args.action = action;
  event.result.details.runtimeCorrectorVerification.incompleteReason = 'RUNNER_REPORT_INCOMPLETE';
  return event;
}

async function receiveCheck(f, event, ctx = f.ctx) {
  await bindCheck(f, event, ctx);
  return f.runtime.toolResult(event, middlewareContext);
}

test('acceptance feedback appends one advisory per native run without changing the host result', async t => {
  const f = await fixture(t, {}, { acceptanceFeedback });
  const receive = (id, kind, status = 'PASS', ctx = f.ctx) => receiveCheck(f, checkReceipt(ctx, id, kind, status), ctx);
  assert.equal(await receive('acceptance-failed', 'acceptance', 'FAIL'), undefined);
  const first = checkReceipt(f.ctx, 'first-support', 'supporting', 'PASS');
  assert.equal(await receiveCheck(f, first), undefined);
  assert.equal(await f.runtime.toolResult(first, middlewareContext), undefined, 'repeated delivery of the same call does not count twice');
  assert.equal(await receive('second-support', 'supporting', 'INCOMPLETE'), undefined);

  const third = checkReceipt(f.ctx, 'third-support', 'supporting', 'PASS');
  const original = structuredClone(third.result);
  const outcome = await receiveCheck(f, third);
  assert.deepEqual(third.result, original, 'the native input result retains its original bytes and fields');
  assert.equal(outcome.result.content.length, original.content.length + 1);
  assert.deepEqual(outcome.result.content.slice(0, -1), original.content);
  assert.deepEqual({ ...outcome.result, content: original.content }, original);
  assert.equal(outcome.result.content.at(-1).type, 'text');
  assert.match(outcome.result.content.at(-1).text, /RC_ACCEPTANCE_RECHECK/u);

  assert.equal(await receive('fourth-support', 'supporting'), undefined);
  assert.equal(await receive('acceptance-failed-again', 'acceptance', 'FAIL'), undefined);
  for (const id of ['another-1', 'another-2', 'another-3']) assert.equal(await receive(id, 'supporting'), undefined);
  const stale = checkReceipt(f.ctx, 'old-delayed-check', 'supporting', 'PASS');
  await bindCheck(f, stale);
  const next = { ...f.ctx, runId: 'next-admitted-run' };
  await f.runtime.prompt({ prompt: 'Start the next run.' }, next);
  assert.equal(await f.runtime.toolResult(stale, middlewareContext), undefined);
  assert.equal(f.state.nativeRunId, next.runId);
  assert.equal(await receive('next-before-fail', 'supporting', 'PASS', next), undefined);
  assert.equal(await receive('next-failed', 'acceptance', 'FAIL', next), undefined);
  assert.equal(await receive('next-support-1', 'supporting', 'PASS', next), undefined);
  assert.equal(await receive('next-support-2', 'supporting', 'PASS', next), undefined);
  const nextOutcome = await receive('next-support-3', 'supporting', 'PASS', next);
  assert.match(nextOutcome.result.content.at(-1).text, /RC_ACCEPTANCE_RECHECK/u);
  assert.equal(f.hostAbort.signal.aborted, false);
});

test('the latest acceptance receipt controls which supporting results count', async t => {
  const f = await fixture(t, {}, { acceptanceFeedback });
  const receive = (id, kind, status = 'PASS') => receiveCheck(f, checkReceipt(f.ctx, id, kind, status));
  for (const status of ['PASS', 'INCOMPLETE', 'FAIL']) {
    assert.equal(await receive(`${status}-initial-fail`, 'acceptance', 'FAIL'), undefined);
    assert.equal(await receive(`${status}-support-1`, 'supporting'), undefined);
    assert.equal(await receive(`${status}-support-2`, 'supporting'), undefined);
    assert.equal(await receive(`${status}-latest-acceptance`, 'acceptance', status), undefined);
    assert.equal(await receive(`${status}-after`, 'supporting'), undefined);
  }
  assert.equal(await receive('another-support', 'supporting'), undefined);
  const outcome = await receive('third-since-latest-fail', 'supporting');
  assert.match(outcome.result.content.at(-1).text, /RC_ACCEPTANCE_RECHECK/u);
});

test('unbound, mismatched and private check results do not advance acceptance feedback', async t => {
  const f = await fixture(t, {}, { acceptanceFeedback });
  assert.equal(await receiveCheck(f, checkReceipt(f.ctx, 'owned-failure', 'acceptance', 'FAIL')), undefined);
  const forged = checkReceipt(f.ctx, 'no-invocation', 'supporting', 'PASS');
  assert.equal(await f.runtime.toolResult(forged, middlewareContext), undefined);
  const wrongArgs = checkReceipt(f.ctx, 'wrong-args', 'supporting', 'PASS');
  await bindCheck(f, wrongArgs);
  assert.equal(await f.runtime.toolResult({ ...wrongArgs, args: { action: 'other' } }, middlewareContext), undefined);
  const wrongTool = checkReceipt(f.ctx, 'wrong-tool', 'supporting', 'PASS');
  await bindCheck(f, wrongTool);
  assert.equal(await f.runtime.toolResult({ ...wrongTool, toolName: 'other_fixture' }, middlewareContext), undefined);
  const wrongRun = checkReceipt({ ...f.ctx, runId: 'unowned-run' }, 'wrong-run', 'supporting', 'PASS');
  assert.equal(await receiveCheck(f, wrongRun), undefined);
  const privateCtx = { ...f.ctx, sessionId: 'private-reviewer', sessionKey: 'agent:main:runtime-corrector:private' };
  assert.equal(await receiveCheck(f, checkReceipt(privateCtx, 'private-check', 'supporting', 'PASS'), privateCtx), undefined);

  for (const id of ['real-support-1', 'real-support-2'])
    assert.equal(await receiveCheck(f, checkReceipt(f.ctx, id, 'supporting', 'PASS')), undefined);
  const outcome = await receiveCheck(f, checkReceipt(f.ctx, 'real-support-3', 'supporting', 'PASS'));
  assert.match(outcome.result.content.at(-1).text, /RC_ACCEPTANCE_RECHECK/u);
});

test('repeated incomplete reports on the same check get one run-bound advisory', async t => {
  const f = await fixture(t, {}, { acceptanceFeedback });
  const receive = (id, action, ctx = f.ctx) => receiveCheck(f, incompleteReport(ctx, id, action), ctx);
  assert.equal(await f.runtime.toolResult(incompleteReport(f.ctx, 'not-admitted'), middlewareContext), undefined);
  const first = incompleteReport(f.ctx, 'first');
  assert.equal(await receiveCheck(f, first), undefined);
  assert.equal(await f.runtime.toolResult(first, middlewareContext), undefined);
  assert.equal(await receive('second'), undefined);
  assert.equal(await receiveCheck(f, checkReceipt(f.ctx, 'healthy', 'supporting', 'PASS')), undefined);
  assert.equal(await receive('after-healthy'), undefined);
  assert.equal(await receive('another-check', 'different'), undefined);
  assert.equal(await receive('same-first'), undefined);
  assert.equal(await receiveCheck(f, checkReceipt(f.ctx, 'independent', 'acceptance', 'PASS')), undefined);
  assert.equal(await receive('same-second'), undefined);
  const last = incompleteReport(f.ctx, 'same-third');
  const outcome = await receiveCheck(f, last);
  assert.match(outcome.result.content.at(-1).text, /RC_VERIFICATION_INCOMPLETE/u);
  assert.doesNotMatch(outcome.result.content.at(-1).text, /RC_ACCEPTANCE_RECHECK/u);
  assert.deepEqual({ ...outcome.result, content: outcome.result.content.slice(0, -1) }, last.result);
  assert.equal(await receive('same-fourth'), undefined);
  assert.equal(await receive('same-fifth'), undefined);

  const stale = incompleteReport(f.ctx, 'stale');
  await bindCheck(f, stale);
  const next = { ...f.ctx, runId: 'next-verification-run' };
  await f.runtime.prompt({ prompt: 'Proceed with the next run.' }, next);
  assert.equal(await f.runtime.toolResult(stale, middlewareContext), undefined);
  assert.equal(await receive('new-first', undefined, next), undefined);
  assert.equal(await receive('new-second', undefined, next), undefined);
  const repeated = await receive('new-third', undefined, next);
  assert.match(repeated.result.content.at(-1).text, /RC_VERIFICATION_INCOMPLETE/u);
});

test('acceptance feedback stays silent when unconfigured or in shadow mode', async t => {
  for (const options of [{}, { acceptanceFeedback, shadow: true }]) {
    const f = await fixture(t, {}, options);
    assert.equal(await receiveCheck(f, checkReceipt(f.ctx, 'failure', 'acceptance', 'FAIL')), undefined);
    for (const id of ['one', 'two', 'three'])
      assert.equal(await receiveCheck(f, checkReceipt(f.ctx, id, 'supporting', 'PASS')), undefined);
    for (const id of ['partial-1', 'partial-2', 'partial-3']) assert.equal(await receiveCheck(f, incompleteReport(f.ctx, id)), undefined);
    assert.equal(f.hostAbort.signal.aborted, false);
  }
});

test('pinned-host no-op guard uses a pre-execution rejection and supports an explicit opt-out', async t => {
  for (const enabled of [true, false]) {
    const f = await fixture(t, { noopToolCallGuard: enabled });
    const file = path.join(f.ctx.workspaceDir, 'unchanged.txt');
    await fs.writeFile(file, 'alpha\n');
    const event = { toolName: 'write', toolCallId: 'noop-write', params: { path: file, content: 'alpha\n' } };
    const decision = await f.runtime.beforeTool(event, f.ctx);
    assert.equal(decision?.block, enabled ? true : undefined);
    if (enabled) {
      assert.match(decision.blockReason, /RC_NOOP_TOOL_REQUEST.*not executed/u);
      assert.deepEqual(await f.runtime.beforeTool(event, f.ctx), decision);
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha\n');
    assert.equal(f.hostAbort.signal.aborted, false);
  }
});

test('no-op detection preserves changed, unreadable, ambiguous and outside-scope requests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-noop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'source.txt'), 'alpha\r\nbeta\r\n');
  const patch = (before, after) => `*** Begin Patch\n*** Update File: source.txt\n@@\n-${before}\n+${after}\n*** End Patch`;
  const cases = [
    ['write', { path: 'source.txt', content: 'alpha\r\nbeta\r\n' }, true],
    ['edit', { path: 'source.txt', edits: [{ oldText: 'alpha', newText: 'alpha' }] }, true],
    ['apply_patch', { input: patch('alpha', 'alpha') }, true],
    ['write', { path: 'source.txt', content: 'changed' }, false],
    ['write', { path: 'missing.txt', content: '' }, false],
    ['edit', { path: 'source.txt', edits: [{ oldText: 'alpha', newText: 'new' }] }, false],
    ['edit', { path: 'source.txt', edits: [{ oldText: 'missing', newText: 'missing' }] }, false],
    ['apply_patch', { input: patch('alpha', 'new') }, false],
    ['apply_patch', { input: patch('missing', 'missing') }, false],
    ['apply_patch', { input: '*** Begin Patch\n*** Delete File: source.txt\n*** End Patch' }, false],
    ['exec', { command: 'write source.txt' }, false],
    ['write', { path: path.join(root, '..', 'outside.txt'), content: 'alpha' }, false],
  ];
  for (const [name, args, expected] of cases)
    assert.equal(await isNoopToolRequest(name, args, root), expected, JSON.stringify({ name, args }));
  await fs.writeFile(path.join(root, 'source.txt'), 'alpha\nalpha\n');
  assert.equal(await isNoopToolRequest('edit', { path: 'source.txt', edits: [{ oldText: 'alpha', newText: 'alpha' }] }, root), false);
  assert.equal(await isNoopToolRequest('apply_patch', { input: patch('alpha', 'alpha') }, root), false);
  assert.equal(await isNoopToolRequest('write', { path: 'source.txt', content: 'alpha\nalpha\n' }, root, root, AbortSignal.abort()), false);
});
test("identityless and internal reviewer end events do not cancel the business review population", async t => {
  const f = await fixture(t);
  await f.runtime.agentEnd({}, {});
  await f.runtime.agentEnd({}, { ...f.ctx, sessionId: "private-reviewer", sessionKey: "agent:main:runtime-corrector:private" });
  assert.equal(f.state.reviewController.signal.aborted, false);
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("only a host-admitted retry reopens an ended review signal; reset stays cancelled", async t => {
  const f = await fixture(t);
  await f.runtime.agentEnd({ success: false, error: "fixture network failure" }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, true);
  await f.runtime.prompt({ prompt: "Assembled retry prompt is not a new user requirement." }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, false);
  await f.runtime.reset({}, f.ctx);
  await f.runtime.prompt({ prompt: "late callback" }, f.ctx);
  assert.equal(f.state.reviewController.signal.aborted, true);
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("a reviewer admission fault is advisory and cannot become a host tool veto", async t => {
  const f = await fixture(t);
  f.sessions.runWithWorkAdmission = async () => { throw new Error("fixture review admission failure"); };
  const result = await f.runtime.beforeTool({ toolName: "write", toolCallId: "write", params: { path: "draft.md" } }, f.ctx);
  assert.equal(result, undefined);
  assert(f.warnings.some(x => x.includes("fixture review admission failure")));
  assert.equal(f.hostAbort.signal.aborted, false);
});
test("approval and question results retain original media, error, structure and interaction identity", async t => {
  const f = await fixture(t);
  f.sessions.runWithWorkAdmission = async () => { throw new Error("fixture review admission failure"); };
  for (const interaction of [{ interactive: true, channelData: { question: "Proceed?" } }, { details: { status: "approval-pending", approvalId: "host-approval" } }]) {
    const result = { ...interaction, isError: true, content: [{ type: "text", text: "Original host result" }, { type: "image", data: "fixture", mimeType: "image/png" }], mediaUrl: "fixture://media" };
    const before = structuredClone(result);
    assert.equal(await f.runtime.toolResult({ toolName: "exec", toolCallId: "approval", args: {}, result }, f.ctx), undefined);
    assert.deepEqual(result, before);
  }
});


test("late terminal callbacks cannot replace or cancel a newer native run", async t => {
  const f = await fixture(t);
  await f.runtime.prompt({ prompt: "host-admitted next run" }, { ...f.ctx, runId: "new-host-run" });
  const controller = f.state.reviewController;
  f.state.nativeNeedsStop = true;
  await f.runtime.agentEnd({ success: true, runId: "host-run" }, f.ctx);
  await f.runtime.agentEnd({ success: false, runId: "host-run", error: "late old error" }, f.ctx);
  const payload = { text: "old native delivery", mediaUrl: "fixture://media" };
  assert.equal(await f.runtime.reply({ kind: "final", sessionKey: f.ctx.sessionKey, runId: "host-run", payload }), undefined);
  assert.equal(f.state.nativeRunId, "new-host-run");
  assert.equal(f.state.reviewController, controller);
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.state.nativeNeedsStop, true);
  assert.equal(f.hostAbort.signal.aborted, false);
});


test("an ordinary new chat does not inherit the prior business Stop flag", async t => {
  const f = await fixture(t);
  f.state.nativeNeedsStop = true;
  await f.runtime.prompt({ prompt: "hello" }, { ...f.ctx, runId: "ordinary-chat" });
  assert.equal(f.state.nativeNeedsStop, false);
  const payload = { text: "Hello!" };
  assert.equal(await f.runtime.reply({ kind: "final", sessionKey: f.ctx.sessionKey, runId: "ordinary-chat", payload }), undefined);
  assert.deepEqual(payload, { text: "Hello!" });
});
