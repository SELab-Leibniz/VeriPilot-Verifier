import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';

const changeName = 'preserve-display-order';
const prefix = `openspec/changes/${changeName}`;
const tasks = '# Tasks\n\n- [ ] Retain the selected order.\n';
let output, pluginRoot, createRuntime, registerPlanControl, inspectPlan, findTask, ensureTask;
before(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-drift-build-'));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl, inspectArmedOpenSpecApply: inspectPlan } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ findTask, ensureTask } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
});
after(() => fs.rm(output, { recursive: true, force: true }));

async function fixture(t, { arm = true, shadow = false, review = false, reviewerFailure = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-native-plan-drift-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: 2
artifacts:
  - name: plan
    stage: proposal
    patterns: ["openspec/changes/**/proposal.md", "openspec/changes/**/design.md", "openspec/changes/**/tasks.md", "openspec/changes/**/specs/**/spec.md"]
    rules:
      enabled: false
    review:
      enabled: ${review}
dynamicGroundTruth:
  enabled: false
stopCorrection:
  enabled: false
shadowMode: ${shadow}
`);
  const documents = {
    [`${prefix}/proposal.md`]: '# Proposal\n\nRetain display preferences.\n',
    [`${prefix}/design.md`]: '# Design\n\nRestore selected order on start.\n',
    [`${prefix}/tasks.md`]: tasks,
    [`${prefix}/specs/order/spec.md`]: '## ADDED Requirements\n\n### Requirement: Order\nThe app SHALL retain the selected order.\n',
  };
  await fs.mkdir(path.join(root, prefix, 'specs/order'), { recursive: true });
  for (const [relative, text] of Object.entries(documents)) await fs.writeFile(path.join(root, relative), text);
  const sid = 'native-plan-parent', sessionKey = 'agent:main:plan-drift';
  const transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, [{ type: 'session', id: sid }, { type: 'message', id: 'original', parentId: null,
    message: { role: 'user', content: 'Retain the selected display order.' } }].map(JSON.stringify).join('\n'));
  const sharedState = {}, warnings = [], methods = new Map();
  const sessions = { getSessionEntry: async () => ({ sessionId: sid, sessionFile: transcript }),
    resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
    runWithWorkAdmission: async (params, run) => run(params.signal) };
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'test/test' } } } },
    logger: { warn: value => warnings.push(value) }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    runtime: { version: '2026.7.1-2', agent: { session: sessions,
      runEmbeddedAgent: async () => assert.fail('The plan drift guard must run without a model.') } } };
  const projectScopes = admittedProjectScopes(api);
  const task = await ensureTask({ projectRoot: root, sessionId: sid });
  projectScopes.activate = async () => ({ taskId: task.taskId });
  const calls = [];
  const reviewerFactory = async options => {
    calls.push(options.role);
    if (reviewerFailure) throw new Error('The artifact reviewer is unavailable.');
    return { sessionId: 'artifact-review', result: { summary: 'Reviewed the selected artifact.', findings: [], edits: [] },
      async close() {} };
  };
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes,
    ...(review ? { reviewerFactory } : {}),
    postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey, agentId: 'main', runId: 'proposal', trigger: 'user',
    abortSignal: new AbortController().signal };
  await runtime.prompt({ prompt: 'Retain the selected display order.' }, ctx);
  const state = sharedState.states.get(`main:${sid}`);
  registerPlanControl(api, { async openSpecPlanTarget(query) {
    return query.runId === state.nativeRunId && query.sessionId === sid && query.sessionKey === sessionKey
      ? { state, projectRoot: root, current: async () => true } : null;
  } });
  async function rpc(action, params) {
    let value;
    await methods.get(`runtime-corrector.openspec.${action}`)({ params,
      client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
      respond(success, result, error) { assert.equal(success, true, error?.message); value = result; } });
    return value;
  }
  const address = { sessionKey, sessionId: sid, runId: ctx.runId, changeName };
  if (arm) {
    const preview = await rpc('preview', address);
    const approval = { ...address, expectedRevision: preview.revision };
    await rpc('approve', approval);
    await rpc('arm', { ...approval, applyRunId: 'apply' });
  }
  await runtime.agentEnd({ runId: ctx.runId, success: true }, ctx);
  await runtime.waitForNativeReviews({ drain: true });
  ctx.runId = 'apply';
  await runtime.prompt({ prompt: 'Apply the approved plan.' }, ctx);

  const journal = async () => {
    const task = await findTask({ projectRoot: root, sessionId: sid });
    const file = path.join(root, '.runtime-correction/tasks', task.taskId, 'journal/events.jsonl');
    return fs.readFile(file, 'utf8').then(text => text.split('\n').filter(Boolean).map(JSON.parse), error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  };
  let nextId = 0;
  async function edit(relative, contents, { result = {}, toolName = 'write', args, beforeResult } = {}) {
    const toolCallId = `native-change-${++nextId}`;
    args ??= { path: path.join(root, relative), content: contents };
    await runtime.beforeTool({ toolName, toolCallId, params: args }, ctx);
    if (contents !== null) await fs.writeFile(path.join(root, relative), contents);
    await beforeResult?.();
    const event = { toolName, toolCallId, args, result: {
      content: [{ type: 'text', text: 'Original host tool result' }], details: { original: true }, ...result,
    } };
    return { event, outcome: await runtime.toolResult(event, ctx), toolCallId };
  }
  async function check(relative, options = {}) {
    const toolCallId = `native-check-${++nextId}`;
    await runtime.beforeTool({ toolName: 'runtime_corrector', toolCallId, params: { command: 'check', subject: relative } }, ctx);
    const { runId, abortSignal, ...factoryContext } = ctx;
    return runtime.manualCheck(factoryContext, relative, { toolCallId, signal: abortSignal, ...options });
  }
  return { root, ctx, state, runtime, projectScopes, documents, warnings, calls, edit, check, journal };
}

test('armed Apply drift adds one bounded notice and keeps mutation evidence without semantic re-review', async t => {
  const f = await fixture(t);
  const relative = `${prefix}/design.md`;
  const { event, outcome, toolCallId } = await f.edit(relative, '# Design\n\nSelect a different default.\n');
  assert(outcome?.result);
  assert.deepEqual(outcome.result.content.slice(0, -1), event.result.content);
  assert.match(outcome.result.content.at(-1).text, /Apply changed the approved OpenSpec plan/u);
  assert.equal(outcome.result.content.at(-1).text.match(/Apply changed/gu)?.length, 1);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(rows.some(row => row.type === 'OPENCLAW_FILE_CHANGED'));
  const [skipped] = rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED');
  assert.equal(skipped.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.equal(skipped.runId, 'apply');
  assert.equal(skipped.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(skipped.openSpecPlan.differences, [relative]);
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
  assert.deepEqual(f.warnings, []);
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'Apply completed.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  const reviewRoot = path.join(f.root, '.runtime-correction/openclaw/native-stop-reviews');
  const directories = await fs.readdir(reviewRoot, { withFileTypes: true });
  const records = (await Promise.all(directories.filter(entry => entry.isDirectory()).map(async directory => {
    const folder = path.join(reviewRoot, directory.name);
    const files = await fs.readdir(folder);
    return Promise.all(files.filter(file => file.endsWith('.json')).map(file => fs.readFile(path.join(folder, file), 'utf8').then(JSON.parse)));
  }))).flat();
  const stop = records.find(record => record.runId === 'apply');
  assert.equal(stop?.status, 'SETTLED');
  assert.equal(stop?.reviewStatus, 'DEVIATION');
  assert.equal(stop?.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.deepEqual(stop?.openSpecPlan.differences, [relative]);
});

test('a mixed write batch skips only the changed plan document and still checks genuine checkbox progress', async t => {
  const f = await fixture(t);
  const relative = `${prefix}/design.md`, checklist = `${prefix}/tasks.md`;
  const input = `*** Begin Patch\n*** Update File: ${relative}\n@@\n-Restore selected order on start.\n+Select a new default.\n*** Update File: ${checklist}\n@@\n-- [ ] Retain the selected order.\n+- [x] Retain the selected order.\n*** End Patch`;
  const { outcome, toolCallId } = await f.edit(relative, '# Design\n\nSelect a new default.\n', {
    toolName: 'apply_patch', args: { input },
    beforeResult: () => fs.writeFile(path.join(f.root, checklist), tasks.replace('[ ]', '[x]')),
  });
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert.deepEqual(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED').map(row => row.file), [path.join(f.root, relative)]);
  assert.deepEqual(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW').map(row => row.file), [path.join(f.root, checklist)]);
  assert.equal(rows.filter(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT').length, 2);
  assert.equal(rows.filter(row => row.type === 'OPENCLAW_FILE_CHANGED').length, 2);
  assert.equal(outcome.result.content.at(-1).text.match(/Apply changed/gu)?.length, 1);
});

test('an error receipt is ineligible for the early drift optimization', async t => {
  const f = await fixture(t);
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Partial failing write\n', { result: { isError: true } });
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
  assert(!outcome?.result?.content.some(block => block.text?.includes('Apply changed the approved OpenSpec plan')));
});

test('a native run replaced during plan capture receives no drift feedback or skip evidence', async t => {
  const f = await fixture(t);
  const lstat = fs.lstat;
  let replaced = false;
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Changed design\n', { beforeResult() {
    t.mock.method(fs, 'lstat', async (...args) => {
      if (!replaced && args[0] === path.join(f.root, prefix, 'proposal.md')) {
        replaced = true;
        f.state.nativeRunId = 'a-new-native-run';
        f.state.reviewController.abort(new Error('The host replaced this run.'));
        f.state.reviewController = new AbortController();
      }
      return lstat(...args);
    });
  } });
  assert(replaced, 'The replacement must occur during approved plan inspection.');
  assert.equal(outcome, undefined);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(!rows.some(row => ['OPENCLAW_ARTIFACT_REVIEW_SKIPPED', 'OPENCLAW_FEEDBACK_DELIVERED'].includes(row.type)));
});

test('ordinary checkbox updates, unarmed changes, and unavailable plan evidence retain artifact processing', async t => {
  for (const kind of ['checkbox', 'unarmed', 'unavailable']) await t.test(kind, async t => {
    const f = await fixture(t, { arm: kind !== 'unarmed' });
    const relative = kind === 'checkbox' ? `${prefix}/tasks.md` : `${prefix}/design.md`;
    if (kind === 'unavailable') await fs.rm(path.join(f.root, prefix, 'proposal.md'));
    const { outcome, toolCallId } = await f.edit(relative, kind === 'checkbox' ? tasks.replace('[ ]', '[x]') : '# Changed design\n');
    const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
    assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
    assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
    assert(!outcome?.result?.content.some(block => block.text?.includes('Apply changed the approved OpenSpec plan')));
  });
});

test('shadow drift records the unchanged guard evidence without delivering feedback', async t => {
  const f = await fixture(t, { shadow: true });
  const { outcome, toolCallId } = await f.edit(`${prefix}/design.md`, '# Changed design\n');
  assert.equal(outcome, undefined);
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
  assert(!rows.some(row => row.type === 'OPENCLAW_FEEDBACK_DELIVERED'));
});

test('an explicit native check retains armed drift without a semantic call or clearing final Stop', async t => {
  const f = await fixture(t, { review: true });
  const relative = `${prefix}/design.md`;
  await fs.writeFile(path.join(f.root, relative), '# Design\n\nSelect a different default.\n');
  const checked = await f.check(relative);
  assert.equal(checked.result.status, 'failed');
  assert.equal(checked.result.classification, 'DEVIATION');
  assert.equal(checked.result.metadata.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(checked.result.metadata.openSpecPlan.differences, [relative]);
  assert.equal(checked.result.metadata.semanticReview.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.match(checked.feedback, /Apply changed the approved OpenSpec plan/u);
  assert.deepEqual(f.calls, []);
  assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
  const task = await findTask({ projectRoot: f.root, sessionId: f.ctx.sessionId });
  assert.equal(task.verification.status, 'STALE');
  const [skipped] = (await f.journal()).filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED');
  assert.equal(skipped.source, 'manual-check');
  assert.equal(skipped.runId, 'apply');
  assert.equal(skipped.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  await f.runtime.reply({ kind: 'final', runId: 'apply', sessionKey: f.ctx.sessionKey,
    payload: { text: 'Apply completed.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: 'apply', success: true }, f.ctx);
  const records = await f.runtime.waitForNativeReviews({ drain: true });
  const stop = records.find(record => record.runId === 'apply');
  assert.equal(stop?.reviewStatus, 'DEVIATION');
  assert.equal(stop?.reasonCode, 'OPENSPEC_APPLY_PLAN_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('explicit unchanged, checkbox-only, unarmed, unrelated, and unreadable-plan checks retain semantic processing', async t => {
  for (const kind of ['unchanged', 'checkbox', 'unarmed', 'unrelated', 'unavailable']) await t.test(kind, async t => {
    const f = await fixture(t, { review: true, arm: kind !== 'unarmed' });
    let relative = `${prefix}/design.md`;
    if (kind === 'checkbox') {
      relative = `${prefix}/tasks.md`;
      await fs.writeFile(path.join(f.root, relative), tasks.replace('[ ]', '[x]'));
    }
    if (kind === 'unarmed' || kind === 'unrelated')
      await fs.writeFile(path.join(f.root, relative), '# Design\n\nSelect a new default.\n');
    if (kind === 'unrelated') {
      relative = 'openspec/changes/retain-search-term/design.md';
      await fs.mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
      await fs.writeFile(path.join(f.root, relative), '# Design\n\nRetain the search term.\n');
    }
    if (kind === 'unavailable') await fs.rm(path.join(f.root, prefix, 'proposal.md'));
    const checked = await f.check(relative);
    assert.equal(checked.result.status, 'passed');
    assert.deepEqual(f.calls, ['artifact-reviewer']);
    assert.equal(checked.result.metadata.semanticReview.status, 'completed');
    assert(!checked.result.diagnostics.some(row => row.ruleId === 'OPENSPEC_APPLY_PLAN_CHANGED'));
    assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
    if (kind === 'unrelated') assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
    if (kind === 'checkbox') assert.equal((await inspectPlan(f.state, 'apply')).status, 'PRESERVED');
  });
});

test('shadow explicit checks report confirmed plan drift without a semantic PASS or model call', async t => {
  const f = await fixture(t, { review: true, shadow: true });
  await fs.writeFile(path.join(f.root, prefix, 'tasks.md'), tasks + '\nA later instruction.\n');
  const checked = await f.check(`${prefix}/tasks.md`);
  assert.equal(checked.result.status, 'failed');
  assert.equal(checked.result.classification, 'DEVIATION');
  assert.equal(checked.result.metadata.openSpecPlan.status, 'CHANGED');
  assert.deepEqual(f.calls, []);
  assert.equal((await inspectPlan(f.state, 'apply')).status, 'CHANGED');
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_FEEDBACK_DELIVERED'));
});

test('explicit normal checks preserve unavailable-review diagnostics', async t => {
  const f = await fixture(t, { review: true, reviewerFailure: true });
  const checked = await f.check(`${prefix}/design.md`);
  assert.equal(checked.result.status, 'failed');
  assert(checked.result.diagnostics.some(row => row.ruleId === 'AGENT-SEMANTIC-REVIEW-FAILED'));
  assert(!checked.result.diagnostics.some(row => row.ruleId === 'OPENSPEC_APPLY_PLAN_CHANGED'));
  assert.deepEqual(f.calls, ['artifact-reviewer']);
});

test('an explicit check replaced during plan capture cannot publish old drift evidence', async t => {
  const f = await fixture(t, { review: true });
  await fs.writeFile(path.join(f.root, prefix, 'design.md'), '# Changed design\n');
  const lstat = fs.lstat;
  let replaced = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!replaced && args[0] === path.join(f.root, prefix, 'proposal.md')) {
      replaced = true;
      f.state.nativeRunId = 'another-native-run';
      f.state.reviewController.abort(new Error('The host replaced this run.'));
      f.state.reviewController = new AbortController();
    }
    return lstat(...args);
  });
  await assert.rejects(f.check(`${prefix}/design.md`), /RC_CHECK_(?:INVOCATION_UNAVAILABLE|CANCELLED)/u);
  assert(replaced);
  assert.deepEqual(f.calls, []);
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
});

test('an explicit check whose project scope changes during capture cannot publish drift evidence', async t => {
  const f = await fixture(t, { review: true });
  await fs.writeFile(path.join(f.root, prefix, 'design.md'), '# Changed design\n');
  const lstat = fs.lstat, resolve = f.projectScopes.resolve;
  let changed = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (!changed && args[0] === path.join(f.root, prefix, 'proposal.md')) {
      changed = true;
      f.projectScopes.resolve = async (...args) => ({ ...await resolve(...args), fingerprint: 'a-new-project-scope' });
    }
    return lstat(...args);
  });
  await assert.rejects(f.check(`${prefix}/design.md`), /RC_CHECK_(?:INVOCATION_UNAVAILABLE|CANCELLED|SCOPE_OR_EVIDENCE_UNAVAILABLE)/u);
  assert(changed);
  assert.deepEqual(f.calls, []);
  assert(!(await f.journal()).some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW_SKIPPED'));
});
