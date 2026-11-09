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
import { captureTaskStart } from '../lib/runtime-v2/task-changes.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
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
  archive = true, shadowMode = false, propose = ordinaryProposal, select = selectAll } = {}) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frame-test-')));
  const cfg = path.join(projectRoot, '.runtime-corrector', 'config.yaml');
  const config = () => fs.writeFile(cfg, `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: false
artifactCorrection:
  originalRequirementsEnabled: ${archive}
stopCorrection:
  enabled: false
shadowMode: ${shadowMode}
requirementFrame:
  enabled: ${enabled}
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
            : await select(JSON.parse(params.prompt.split('Candidates:\n')[1].split('\n\n')[0]), params);
          const name = kind === 'proposal' ? 'submit_frame_proposal' : 'submit_frame_selection';
          await call(name, validator ? validator.validateToolArguments(tools.get(name), { name, arguments: args }) : args);
          params.onAgentToolResult({ isError: false });
          return { payloads: [], meta: {} };
        },
      },
    },
  };
  registerTaskTools(api);
  const runtime = correctionFixtureRuntime(createOpenClawRuntime)(api, {
    pluginRoot, nativeHooks, stopStartCompatibility: async () => null,
  });
  t.after(async () => {
    await runtime.dispose();
    await runtime.waitForBackgroundReviews();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });
  const ctx = { agentId: 'main', sessionId, sessionKey, workspaceDir: projectRoot, trigger: 'user' };
  return { projectRoot, sessionId, dir, calls, warnings, config, ctx, runtime,
    async prompt(text = userText) {
      const id = `u${++turn}`;
      messages.push({ type: 'message', id, parentId: turn === 1 ? null : `u${turn - 1}`, message: { role: 'user', content: text } });
      if (nativeHooks) await fs.writeFile(transcript, messages.map(JSON.stringify).join('\n') + '\n');
      return runtime.prompt({ prompt: text }, { ...ctx, runId: id });
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
    assert.deepEqual(names, kind === 'proposal'
      ? ['source_read', 'source_grep', 'source_find', 'source_ls', 'submit_frame_proposal'] : ['submit_frame_selection']);
  }
  assert.equal((await fs.readdir(path.join(f.dir, 'raw'))).length, 4);
});

test('2. drops unsupported ranges, quotes, fields and overlong items before selection', async t => {
  const f = await fixture(t, { propose: () => ({
    guidance: [
      guidance('mixed', 0.9, [{ path: 'app.js', startLine: 1, endLine: 1 }, { path: 'missing', startLine: 1, endLine: 1 }]),
      guidance('missing', 0.9, [{ path: 'missing', startLine: 1, endLine: 1 }]),
      guidance('out of range', 0.9, [{ path: 'app.js', startLine: 1, endLine: 3 }]),
      { ...guidance('bad cell'), contractCell: 'wrong' },
      guidance('x'.repeat(301)),
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

test('6. source tools see only committed files and committed bytes', async t => {
  const f = await fixture(t, { propose: async ({ call, params }) => {
    assert(!params.prompt.includes('candidate bytes'));
    const listing = JSON.parse(toolText(await call('source_ls', {})));
    assert(!listing.hits.includes('untracked.js'));
    await assert.rejects(call('source_read', { path: 'untracked.js' }), { code: 'ENOENT' });
    assert.match(toolText(await call('source_read', { path: 'app.js' })), /fallback = 1/u);
    return ordinaryProposal();
  } });
  await fs.writeFile(path.join(f.projectRoot, 'untracked.js'), 'uncommitted file');
  await fs.writeFile(path.join(f.projectRoot, 'app.js'), 'candidate bytes');
  await f.prompt();
  assert.equal((await f.frame()).status, 'ready');
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
