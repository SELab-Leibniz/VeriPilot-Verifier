import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOpenClawRuntime } from '../lib/openclaw/runtime.mjs';
import { loadPublicToolArgumentsValidator } from '../lib/openclaw/compat-2026.7.1-2.mjs';
import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';
import { captureTaskStart, taskChanges } from '../lib/runtime-v2/task-changes.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { correctionFixtureRuntime } from './support/openclaw-project-scope.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const userText = 'Preserve  empty\ninput behavior.';
const digest = data => createHash('sha256').update(data).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});
const guidance = (statement, confidence = 0.9, evidence = [{ path: 'app.js', startLine: 1, endLine: 1 }]) =>
  ({ statement, contractCell: 'values_defaults', evidence, confidence });
const scenario = (given, confidence = 0.9, quote = 'empty input') =>
  ({ kind: 'preservation', quote, given, when: 'called', then: 'use the default', confidence });
const ordinaryProposal = () => ({ guidance: [guidance('Use the existing default')], scenarios: [] });
const review = (item, decision = 'select') => ({ id: item.id, decision, reason: 'scripted' });
const selectAll = items => ({ reviews: items.map(item => review(item)) });

async function fixture(t, { repository = true, nativeHooks = false, enabled = true, proposers = 1, timeoutMs = 10000,
  archive = true, shadowMode = false, inject = true, locale = 'en', workflowDocument = false, nativePromptBeforePersist = false,
  propose = ordinaryProposal, select = selectAll } = {}) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frame-test-')));
  const cfg = path.join(projectRoot, '.runtime-corrector', 'config.yaml');
  const config = () => fs.writeFile(cfg, `version: 2
artifacts: ${workflowDocument ? `
  - name: proposal
    stage: proposal
    patterns: [proposal.md]
    rules:
      enabled: false
    review:
      enabled: true` : '[]'}
locale: ${locale}
dynamicGroundTruth:
  enabled: false
artifactCorrection:
  originalRequirementsEnabled: ${archive}
stopCorrection:
  enabled: false
  waitMode: assessment
shadowMode: ${shadowMode}
requirementFrame:
  enabled: ${enabled}
  inject: ${inject}
  proposers: ${proposers}
  timeoutMs: ${timeoutMs}
reviewers:
  defaults:
    model: fixture/scripted
`);
  await fs.mkdir(path.dirname(cfg));
  await config();
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '.runtime-correction/\nhost-state/\nnative.jsonl\n');
  await fs.writeFile(path.join(projectRoot, 'app.js'), 'export const fallback = 1;\n');
  if (repository) {
    git(projectRoot, 'init', '-q');
    git(projectRoot, 'config', 'core.autocrlf', 'false');
    git(projectRoot, 'add', '.');
    git(projectRoot, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'start');
  }
  const sessionId = 'business-session', sessionKey = 'agent:main:business';
  const dir = path.join(projectRoot, '.runtime-correction', 'requirement-frame', digest(sessionId).slice(0, 24));
  const transcript = path.join(projectRoot, 'native.jsonl');
  const messages = [{ type: 'session', id: sessionId }], calls = [], warnings = [];
  const validator = process.env.RC_OPENCLAW_HOST_ROOT ? await loadPublicToolArgumentsValidator() : null;
  let toolFactory, turn = 0;
  const api = {
    config: {}, pluginConfig: {},
    logger: { warn: text => warnings.push(text) }, registerTool: factory => { toolFactory = factory; },
    runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => path.join(projectRoot, 'host-state') },
      agent: { resolveAgentWorkspaceDir: () => projectRoot,
        session: { resolveStorePath: () => path.join(projectRoot, 'sessions.json'), getSessionEntry: async () => ({ sessionId }),
          resolveSessionFilePath: () => transcript, runWithWorkAdmission: async ({ signal }, run) => run(signal) },
        async runEmbeddedAgent(params) {
          const tools = new Map((toolFactory(params) ?? []).map(tool => [tool.name, tool]));
          const kind = params.prompt.startsWith('[REQUIREMENT_FRAME_SELECTOR]') ? 'selection' : 'proposal';
          calls.push({ kind, params, names: [...tools.keys()] });
          const call = (name, args) => tools.get(name).execute('scripted', args, params.abortSignal);
          const args = kind === 'proposal' ? await propose({ params, call, ordinal: Number(path.basename(params.cwd).slice(-1)) })
            : await select(JSON.parse(params.prompt.split('Candidates:\n')[1].split('\n\n')[0]), params, call);
          const name = kind === 'proposal' ? 'submit_frame_proposal' : 'submit_frame_selection';
          await call(name, validator ? validator.validateToolArguments(tools.get(name), { name, arguments: args }) : args);
          params.onAgentToolResult({ isError: false });
          return { payloads: [], meta: {} };
        },
      },
    },
  };
  registerTaskTools(api);
  const sharedState = {};
  const runtime = correctionFixtureRuntime(createOpenClawRuntime)(api, {
    pluginRoot, nativeHooks, sharedState, stopStartCompatibility: async () => null,
  });
  t.after(async () => {
    await runtime.dispose();
    await runtime.waitForBackgroundReviews();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });
  const ctx = { agentId: 'main', sessionId, sessionKey, workspaceDir: projectRoot, trigger: 'user' };
  return { projectRoot, sessionId, dir, calls, warnings, config, ctx, runtime,
    get state() { return sharedState.states.get(`main:${sessionId}`); },
    async prompt(text = userText, overrides = {}) {
      const id = `u${++turn}`;
      const message = { type: 'message', id, parentId: turn === 1 ? null : `u${turn - 1}`,
        message: { role: 'user', content: text } };
      const saveTranscript = () => fs.writeFile(transcript, messages.map(JSON.stringify).join('\n') + '\n');
      const prompt = () => runtime.prompt({ prompt: text }, { ...ctx, runId: id, ...overrides });
      if (nativeHooks && nativePromptBeforePersist) {
        await saveTranscript();
        const result = await prompt();
        messages.push(message);
        await saveTranscript();
        return result;
      }
      messages.push(message);
      if (nativeHooks) await saveTranscript();
      return prompt();
    },
    toolResult(toolCallId, context = {}, result = { content: [{ type: 'text', text: 'original tool result' }], details: { kept: true } }) {
      return runtime.toolResult({ toolName: 'read', toolCallId, args: { path: 'app.js' }, result }, { ...ctx, runId: `u${turn}`, ...context });
    },
    async deliveries() {
      const text = await fs.readFile(path.join(dir, 'deliveries.jsonl'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return text.split('\n').filter(Boolean).map(JSON.parse);
    },
    async frame() {
      await runtime.waitForBackgroundReviews();
      const text = await fs.readFile(path.join(dir, 'frame.json'), 'utf8').catch(error => {
        throw new Error(`No frame after ${calls.length} model calls. Warnings: ${JSON.stringify(warnings)}`, { cause: error });
      });
      return JSON.parse(text);
    },
  };
}

test('1. caps, sorts and renumbers valid items after selection in private sessions', async t => {
  const f = await fixture(t, { proposers: 3, propose: ({ ordinal }) => ({
    guidance: Array.from({ length: 3 }, (_, i) => guidance(`P${ordinal} G${i}`, i === 0 ? 1 : 0.9)),
    scenarios: Array.from({ length: 3 }, (_, i) => scenario(`P${ordinal} S${i}`, i === 0 ? 1 : 0.9)),
  }) });
  await f.prompt();
  const result = await f.frame();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.counts, { proposed: 18, valid: 18, selected: 11 });
  assert.deepEqual(result.guidance.map(item => [item.id, item.statement]),
    [['G1', 'P1 G0'], ['G2', 'P2 G0'], ['G3', 'P3 G0'], ['G4', 'P1 G1'], ['G5', 'P1 G2']]);
  assert.deepEqual(result.scenarios.map(item => [item.id, item.given]),
    [['S1', 'P1 S0'], ['S2', 'P2 S0'], ['S3', 'P3 S0'], ['S4', 'P1 S1'], ['S5', 'P1 S2'], ['S6', 'P2 S1']]);
  assert.equal(new Set(f.calls.map(({ params }) => params.sessionId)).size, 4);
  for (const { kind, params, names } of f.calls) {
    assert.notEqual(params.sessionId, f.sessionId);
    assert.equal(params.model, 'scripted');
    assert.equal(params.config.agents.list.find(agent => agent.id === 'main').workspace, params.cwd);
    assert.deepEqual(params.toolsAllow, names);
    assert.deepEqual(names, ['source_read', 'source_grep', 'source_find', 'source_ls', 'semantic_graph',
      kind === 'proposal' ? 'submit_frame_proposal' : 'submit_frame_selection']);
  }
  assert.equal((await fs.readdir(path.join(f.dir, 'raw'))).length, 4);
});

test('2. drops unsupported ranges, quotes, fields and guidance over 4000 characters before selection', async t => {
  const f = await fixture(t, { propose: () => ({
    guidance: [
      guidance('mixed', 0.9, [{ path: 'app.js', startLine: 1, endLine: 1 }, { path: 'missing', startLine: 1, endLine: 1 }]),
      guidance('missing', 0.9, [{ path: 'missing', startLine: 1, endLine: 1 }]),
      guidance('out of range', 0.9, [{ path: 'app.js', startLine: 1, endLine: 3 }]),
      { ...guidance('bad cell'), contractCell: 'wrong' },
      guidance('x'.repeat(4001)),
    ],
    scenarios: [scenario('good'), scenario('made up', 0.9, 'absent'), { ...scenario('bad kind'), kind: 'wrong' }],
  }), select: items => {
    assert.deepEqual(items.map(({ id, type }) => [id, type]), [['P1-G1', 'guidance'], ['P1-S1', 'scenario']]);
    assert(items.every(item => !Object.hasOwn(item, 'confidence')));
    return selectAll(items);
  } });
  await f.prompt();
  const result = await f.frame();
  assert.deepEqual(result.counts, { proposed: 8, valid: 2, selected: 2 });
  assert.deepEqual(result.guidance[0].evidence, [{ path: 'app.js', startLine: 1, endLine: 1 }]);
  assert.equal(result.scenarios[0].quote, 'empty input');
});

test('3. excludes rejected, low-confidence and unreviewed candidates', async t => {
  const f = await fixture(t, {
    propose: () => ({ guidance: [guidance('keep', 0.75), guidance('low', 0.74), guidance('reject'), guidance('omitted')], scenarios: [] }),
    select: items => ({ reviews: [review(items[0]), review(items[1]), review(items[2], 'reject')] }),
  });
  await f.prompt();
  assert.deepEqual((await f.frame()).guidance.map(item => item.statement), ['keep']);
});

test('4. no Git HEAD records NO_GIT_HEAD without model calls', async t => {
  const f = await fixture(t, { repository: false });
  await f.prompt();
  const result = await f.frame();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'NO_GIT_HEAD');
  assert.equal(f.calls.length, 0);
});

test('5. export leaves Git status and index intact and removes its temporary directory', async t => {
  const f = await fixture(t);
  const index = path.join(f.projectRoot, '.git', 'index');
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'staged contents\n');
  git(f.projectRoot, 'add', 'app.js');
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'unstaged contents\n');
  const status = git(f.projectRoot, 'status', '--porcelain');
  const before = digest(await fs.readFile(index));
  await f.prompt();
  assert.equal((await f.frame()).status, 'ready');
  assert.equal(git(f.projectRoot, 'status', '--porcelain'), status);
  assert.equal(digest(await fs.readFile(index)), before);
  for (const { params } of f.calls) await assert.rejects(fs.stat(path.dirname(params.cwd)), { code: 'ENOENT' });
});

test('6. source and semantic graph tools see only committed files and bytes', async t => {
  const f = await fixture(t, { propose: async ({ call, params }) => {
    assert(!params.prompt.includes('candidate bytes'));
    assert.match(params.prompt, /semantic_graph/u);
    const listing = JSON.parse(toolText(await call('source_ls', {})));
    assert(!listing.hits.includes('untracked.js'));
    await assert.rejects(call('source_read', { path: 'untracked.js' }), { code: 'ENOENT' });
    assert.match(toolText(await call('source_read', { path: 'app.js' })), /fallback = 1/u);
    const query = async args => JSON.parse(toolText(await call('semantic_graph', args)));
    assert.deepEqual((await query({ operation: 'definition', symbol: 'fallback' })).hits,
      [{ path: 'app.js', symbol: 'fallback', kind: 'const', line: 2 }]);
    assert.deepEqual((await query({ operation: 'dependencies', file: 'app.js' })).hits,
      [{ from: 'app.js', to: 'start.ets', kind: 'import', line: 1 }]);
    assert.deepEqual((await query({ operation: 'definition', symbol: 'candidate' })).hits, []);
    assert.equal((await query({ operation: 'dependencies', file: 'untracked.js' })).indexed, false);
    return ordinaryProposal();
  }, select: async (items, params, call) => {
    assert.match(params.prompt, /verify the decisive source lines/u);
    assert.match(toolText(await call('source_read', { path: 'app.js' })), /fallback = 1/u);
    const query = JSON.parse(toolText(await call('semantic_graph', { operation: 'definition', symbol: 'candidate' })));
    assert.deepEqual(query.hits, []);
    await assert.rejects(call('source_read', { path: 'untracked.js' }), { code: 'ENOENT' });
    return selectAll(items);
  } });
  await fs.writeFile(path.join(f.projectRoot, 'start.ets'), 'export const base = 1;\n');
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'import "./start.ets";\nexport const fallback = 1;\n');
  git(f.projectRoot, 'add', 'app.js', 'start.ets');
  git(f.projectRoot, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'frozen graph input');
  await fs.writeFile(path.join(f.projectRoot, 'untracked.js'), 'export const candidate = 2;\n');
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'export { candidate } from "./untracked.js";\n');
  await f.prompt();
  assert.equal((await f.frame()).status, 'ready');
});

test('a snapshot without supported graph files still uses the original proposal tools', async t => {
  const f = await fixture(t, { propose: async ({ call, params }) => {
    assert.doesNotMatch(params.prompt, /semantic_graph/u);
    assert.match(toolText(await call('source_read', { path: 'app.py' })), /fallback = 1/u);
    return { guidance: [guidance('Keep the Python fallback', 0.9, [{ path: 'app.py', startLine: 1, endLine: 1 }])], scenarios: [] };
  } });
  git(f.projectRoot, 'mv', 'app.js', 'app.py');
  await fs.writeFile(path.join(f.projectRoot, 'app.py'), 'fallback = 1\n');
  git(f.projectRoot, 'add', 'app.py');
  git(f.projectRoot, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'Python snapshot');
  await f.prompt();
  assert.equal((await f.frame()).status, 'ready');
  assert(!f.calls.some(({ names }) => names.includes('semantic_graph')));
});

test('7. model failure or timeout leaves prompt output unchanged', async t => {
  const disabled = await fixture(t, { enabled: false });
  const expected = await disabled.prompt();
  for (const reason of ['MODEL_FAILED', 'TIMEOUT']) await t.test(reason, async sub => {
    const f = await fixture(sub, { timeoutMs: 3000, propose: async ({ params }) => {
      if (reason === 'MODEL_FAILED') throw new Error('scripted model failure');
      await delay(10000, undefined, { signal: params.abortSignal });
    } });
    assert.deepEqual(await f.prompt(), expected);
    const result = await f.frame();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, reason);
    assert.equal(f.calls.length, 1);
    await assert.rejects(fs.stat(path.dirname(f.calls[0].params.cwd)), { code: 'ENOENT' });
  });
});

test('8. new native user turns reuse a ready frame for the task-start HEAD', async t => {
  const f = await fixture(t, { nativeHooks: true });
  const task = await ensureTask({ projectRoot: f.projectRoot, sessionId: f.sessionId });
  const head = git(f.projectRoot, 'rev-parse', 'HEAD').trim();
  assert.equal(await captureTaskStart({ projectRoot: f.projectRoot, taskId: task.taskId }), true);
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'new head\n');
  git(f.projectRoot, 'add', 'app.js');
  git(f.projectRoot, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'second head');
  await f.prompt();
  const first = await f.frame();
  assert.equal(first.status, 'ready', JSON.stringify(f.warnings));
  assert.equal(first.startHead, head);
  await f.prompt('A new real user turn.');
  assert.deepEqual(await f.frame(), first);
  assert.equal(f.calls.length, 2);
});

test('9. disabled never creates the requirement-frame directory', async t => {
  const f = await fixture(t, { enabled: false });
  await f.prompt();
  await f.runtime.waitForBackgroundReviews();
  await assert.rejects(fs.stat(path.dirname(f.dir)), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});

test('invalid config values fall back to defaults', async t => {
  const f = await fixture(t, { enabled: 'invalid', proposers: 0, timeoutMs: -1 });
  const { runtimeV2 } = await loadConfig({ cwd: f.projectRoot, pluginRoot });
  assert.deepEqual(runtimeV2.requirementFrame, { enabled: false, proposers: 3, inject: true, review: true, timeoutMs: 600000 });
});

test('a valid empty result runs the selector and regenerates on the next real turn', async t => {
  let calls = 0;
  const f = await fixture(t, { propose: () => ++calls === 1 ? { guidance: [], scenarios: [] } : ordinaryProposal() });
  await f.prompt();
  const result = await f.frame();
  assert.equal(result.status, 'empty');
  assert.equal(result.reason, 'NO_VALID_ITEM');
  assert.deepEqual(f.calls.map(call => call.kind), ['proposal', 'selection']);
  await f.prompt('[runtime-corrector:feedback] followup text');
  assert.equal((await f.frame()).status, 'ready');
  const secondPrompt = f.calls[2].params.prompt;
  assert(secondPrompt.includes(`U1: ${userText}`));
  assert(secondPrompt.includes('(contains Runtime Corrector text that is not a user requirement) U2:'));
});

test('ending a session aborts its running frame without publishing it', { timeout: 10000 }, async t => {
  let begin;
  const entered = new Promise(resolve => { begin = resolve; });
  const f = await fixture(t, { propose: async ({ params }) => {
    begin(params.abortSignal);
    await delay(10000, undefined, { signal: params.abortSignal });
  } });
  await f.prompt();
  const signal = await entered;
  await assert.rejects(fs.stat(path.join(f.dir, 'frame.json')), { code: 'ENOENT' });
  await f.runtime.sessionEnd({}, f.ctx);
  await f.runtime.waitForBackgroundReviews();
  assert.equal(signal.aborted, true);
  await assert.rejects(fs.stat(path.join(f.dir, 'frame.json')), { code: 'ENOENT' });
});

const briefMarker = '[runtime-corrector:feedback]';
const briefTitle = '[RC implementation hints | advisory]';
const deliveredBrief = result => result?.result.content.at(-1)?.text;

test('6.4.1 and 6.4.5: a cached frame goes at run start once, with the pre-edit change count', async t => {
  const f = await fixture(t, { nativeHooks: true });
  const task = await ensureTask({ projectRoot: f.projectRoot, sessionId: f.sessionId });
  assert.equal(await captureTaskStart({ projectRoot: f.projectRoot, taskId: task.taskId }), true);
  assert.equal(await f.prompt(), undefined);
  const frame = await f.frame();
  const prompted = await f.prompt('Now implement the planned change.');
  assert(prompted?.prependContext, JSON.stringify({ warnings: f.warnings, frame: frame.status,
    nativeRunId: f.state?.nativeRunId, brief: f.state?.frameBrief }));
  const { prependContext } = prompted;
  assert(prependContext.startsWith(`${briefMarker}\n${briefTitle}`));
  assert(prependContext.endsWith('1. Use the existing default (evidence: app.js:1-1)'));
  assert.equal(prependContext.split(briefTitle).length - 1, 1);
  assert.equal(await f.toolResult('after-prompt'), undefined);
  const receipts = await f.deliveries();
  assert.equal(receipts.length, 1);
  const [{ at, ...receipt }] = receipts;
  assert(Number.isFinite(Date.parse(at)));
  assert.deepEqual(receipt, { channel: 'run_start', runId: 'u2', startHead: frame.startHead, productionChangesBefore: 0 });
});

test('6.4.2 and 6.4.5: a frame that becomes ready mid-turn follows existing feedback on the next result', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(finish);
  const f = await fixture(t, {
    nativeHooks: true, propose: async () => { await pending; return ordinaryProposal(); },
    workflowDocument: true,
  });
  const task = await ensureTask({ projectRoot: f.projectRoot, sessionId: f.sessionId });
  assert.equal(await captureTaskStart({ projectRoot: f.projectRoot, taskId: task.taskId }), true);
  assert.equal(await f.prompt(), undefined);
  assert.equal(await f.toolResult('before-ready'), undefined, JSON.stringify(f.warnings));
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'export const fallback = 2;\n');
  await fs.writeFile(path.join(f.projectRoot, 'proposal.md'), 'Draft workflow document.');
  const plan = await loadConfig({ cwd: f.projectRoot, pluginRoot });
  const changeSet = await taskChanges({ projectRoot: f.projectRoot, taskId: task.taskId, plan });
  assert.deepEqual(changeSet.changes.map(({ path: file, owner }) => [file, owner]),
    [['app.js', 'STOP'], ['proposal.md', 'DOCUMENT_CORRECTION']], JSON.stringify(plan.configuredArtifacts));
  finish();
  const frame = await f.frame();
  assert.equal(await f.toolResult('awaiting-approval', {}, { content: [], interactive: true }), undefined);
  assert.deepEqual(await f.deliveries(), []);
  f.state.hotReviewFeedback.push('Existing hot review feedback.');
  const result = await f.toolResult('with-brief');
  assert.deepEqual(result.result.details, { kept: true });
  assert.deepEqual(result.result.content.slice(0, 2), [
    { type: 'text', text: 'original tool result' },
    { type: 'text', text: `${briefMarker}\nExisting hot review feedback.` },
  ]);
  assert(deliveredBrief(result).startsWith(`${briefMarker}\n${briefTitle}`));
  assert.equal(await f.toolResult('next-result'), undefined);
  assert(!deliveredBrief(await f.toolResult('with-brief')).includes(briefTitle));
  const receipts = await f.deliveries();
  assert.equal(receipts.length, 1);
  assert.deepEqual({ ...receipts[0], at: null }, {
    at: null, channel: 'tool_result', runId: 'u1', startHead: frame.startHead, productionChangesBefore: 1,
  });
});

test('a first native turn starts after its user record is persisted and carries pending work into the next turn', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(finish);
  const f = await fixture(t, { nativeHooks: true, nativePromptBeforePersist: true,
    propose: async () => { await pending; return ordinaryProposal(); } });
  const task = await ensureTask({ projectRoot: f.projectRoot, sessionId: f.sessionId });
  assert.equal(await captureTaskStart({ projectRoot: f.projectRoot, taskId: task.taskId }), true);
  assert.equal(await f.prompt(), undefined);
  assert.equal(f.calls.length, 0);
  await f.runtime.beforeTool({ toolName: 'read', toolCallId: 'proposal-read', params: { path: 'app.js' } }, { ...f.ctx, runId: 'u1' });
  const work = f.state.requirementFrameWork;
  assert(work, JSON.stringify(f.warnings));
  await f.runtime.prompt({ prompt: userText }, { ...f.ctx, runId: 'u1' });
  assert.equal(await f.prompt('Now implement the planned change.'), undefined);
  assert.equal(f.state.requirementFrameWork, work);
  assert.equal(work.controller.signal.aborted, false);
  finish();
  assert.equal((await f.frame()).status, 'ready');
  assert.deepEqual(f.calls.map(({ kind }) => kind), ['proposal', 'selection']);
  assert(f.calls[0].params.prompt.includes(userText));
  assert(deliveredBrief(await f.toolResult('code-read')).startsWith(briefMarker));
  assert.equal(await f.runtime.prompt({ prompt: 'Now implement the planned change.' }, { ...f.ctx, runId: 'u2' }), undefined);
  assert.equal(await f.toolResult('second-code-read'), undefined);
  assert.deepEqual((await f.deliveries()).map(({ runId, channel, productionChangesBefore }) =>
    ({ runId, channel, productionChangesBefore })), [{ runId: 'u2', channel: 'tool_result', productionChangesBefore: 0 }]);
});

test('6.4.3: private runs and owned Stop continuations do not receive a pending brief', async t => {
  const f = await fixture(t, { nativeHooks: true });
  await f.prompt();
  await f.frame();
  assert.equal(await f.runtime.prompt({ prompt: 'internal' }, { ...f.ctx, runId: 'private', runtimeCorrectorInternal: true }), undefined);
  assert.equal(await f.toolResult('private-result', { runtimeCorrectorInternal: true }), undefined);
  const runId = 'owned-stop-run';
  const directory = path.join(f.projectRoot, '.runtime-correction', 'openclaw', 'native-followups', sha256([f.ctx.sessionKey, f.sessionId]));
  await atomicWriteJson(path.join(directory, 'receipt.json'), {
    runId, status: 'FINISHED', sessionId: f.sessionId, sessionKey: f.ctx.sessionKey,
  });
  assert.equal(await f.prompt('Stop continuation', { runId }), undefined);
  assert.equal(await f.toolResult('owned-result', { runId }), undefined);
  assert.deepEqual(await f.deliveries(), []);
});

test('6.4.3: inject:false and shadowMode suppress both brief channels', async t => {
  for (const options of [{ inject: false }, { shadowMode: true }]) await t.test(JSON.stringify(options), async sub => {
    const f = await fixture(sub, options);
    const startHead = git(f.projectRoot, 'rev-parse', 'HEAD').trim();
    await atomicWriteJson(path.join(f.dir, 'frame.json'), {
      status: 'ready', startHead, guidance: [{ id: 'G1', ...ordinaryProposal().guidance[0] }], scenarios: [],
    });
    assert.equal(await f.prompt(), undefined);
    assert.equal(await f.toolResult('suppressed'), undefined);
    assert.deepEqual(await f.deliveries(), []);
  });
});

test('6.4.4: the localized brief delivers long selected items and prints only first evidence', async t => {
  const statement = '界'.repeat(3999) + '𠮷';
  const quote = '原文'.repeat(2100);
  const given = '前提'.repeat(101), when = '操作'.repeat(101), then = '预期'.repeat(101);
  const f = await fixture(t, { locale: 'zh', propose: () => ({
    guidance: [guidance(statement, 1, [
      { path: 'app.js', startLine: 1, endLine: 1 }, { path: '.gitignore', startLine: 1, endLine: 2 },
    ])],
    scenarios: [
      { ...scenario(given, 0.99, quote), kind: 'requirement', when, then },
      scenario('低置信但已入选', 0.75),
    ],
  }), select: items => ({ reviews: items.map(item => ({ ...review(item), reason: '理由'.repeat(101) })) }) });
  await f.prompt(`${userText} ${quote}`);
  assert.deepEqual((await f.frame()).counts, { proposed: 3, valid: 3, selected: 3 });
  const brief = deliveredBrief(await f.toolResult('long-brief'));
  assert(brief.startsWith(`${briefMarker}\n【RC 实现提示｜仅供参考】`));
  assert(brief.includes(`1. ${statement}（依据：app.js:1-1）`));
  assert(brief.includes(`- [新需求] 前提：${given}；操作：${when}；预期：${then}。（原文：“${quote}”）`));
  assert(brief.includes('- [保持不变] 前提：低置信但已入选'));
  assert(!brief.includes('.gitignore'));
  assert.equal((await f.deliveries())[0].productionChangesBefore, null);
});
