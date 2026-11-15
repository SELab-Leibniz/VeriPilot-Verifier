// Public fixture copied unchanged from requirement-frame.test.mjs at9d5039f.
// New contracts stay separate; the original file and90sec deadline are preserved.
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
import { frameCheckFamilies, readStopFrame, countFrameDispositions } from '../lib/runtime-v2/requirement-frame.mjs';
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
const selectAll = items => ({ reviews: items.map(item => review(item)), finish: true });

async function fixture(t, { repository = true, nativeHooks = false, enabled = true, proposers = 1, timeoutMs = 10000,
  archive = true, shadowMode = false, inject = true, locale = 'en', workflowDocument = false, nativePromptBeforePersist = false,
  checks = false, stopPolicy = '', files = {}, propose = ordinaryProposal, check = () => ({ checks: [] }), select = selectAll, challenge = () => ({ guidance: [], scenarios: [] }), afterSubmission = async () => {} } = {}) {
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
${stopPolicy}shadowMode: ${shadowMode}
requirementFrame:
  enabled: ${enabled}
  inject: ${inject}
  checks: ${checks}
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
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(projectRoot, file)), { recursive: true });
    await fs.writeFile(path.join(projectRoot, file), text);
  }
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
          const kind = params.prompt.startsWith('[REQUIREMENT_FRAME_SELECTOR]') ? 'selection'
            : params.prompt.startsWith('[CORRECTION_CHECK_PROPOSAL]') ? 'check' : 'proposal';
          calls.push({ kind, params, names: [...tools.keys()] });
          const call = (name, args) => tools.get(name).execute('scripted', args, params.abortSignal);
          const args = kind === 'proposal' ? await (params.prompt.startsWith('[REQUIREMENT_FRAME_COUNTEREXAMPLE]') ? challenge : propose)({ params, call, ordinal: Number(path.basename(params.cwd).slice(-1)) })
            : kind === 'check' ? await check({ params, call, family: path.basename(params.cwd).slice('check-'.length) })
              : await select(JSON.parse(params.prompt.split('Candidates:\n')[1].split('\n\n')[0]), params, call);
          const name = kind === 'selection' ? 'submit_frame_selection' : 'submit_frame_proposal';
          await call(name, validator ? validator.validateToolArguments(tools.get(name), { name, arguments: args }) : args);
          params.onAgentToolResult({ isError: false });
          await afterSubmission({ kind, params });
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

const deliveredBrief = result => result?.result.content.at(-1)?.text;

for (const decision of ['reject', 'covered', 'defer']) test(`an independent counterexample survives selector ${decision} for same-premise Stop review`, async t => {
  const entryPoint = { path: 'gate.ts', symbol: 'Gate.accepts' };
  const primary = { ...scenario('the driver rejects the input', .9, 'blocked values'), kind: 'requirement',
    when: "Gate.accepts('blocked') is called", then: 'return false without incrementing writes', entryPoint,
    evidence: [{ path: 'gate.ts', startLine: 1, endLine: 5 }], contractCell: 'branch_matrix' };
  const boundary = { ...primary, given: 'Original test replaces Gate.driver with () => true.',
    evidence: [...primary.evidence, { path: 'test/gate.test.ts', startLine: 1, endLine: 1 }] };
  const f = await fixture(t, { files: { 'gate.ts': [
    'export class Gate {', '  static driver = () => true;', '  static writes = 0;',
    '  static accepts(value) { if (!this.driver(value)) return false; this.writes++; return true; }', '}',
  ].join('\n'), 'test/gate.test.ts': 'Gate.driver = () => true;\n' },
  propose: () => ({ guidance: [], scenarios: [primary] }), challenge: () => ({ guidance: [], scenarios: [boundary] }),
  select: items => {
    const selected = items.find(item => item.given === primary.given), counterexample = items.find(item => item.given === boundary.given);
    return { reviews: [review(selected), { ...review(counterexample, decision), reason: 'A different placement is preferred.',
      ...(decision === 'covered' ? { coveredBy: selected.id } : {}) }], finish: true };
  } });
  await f.prompt('Reject blocked values without changing the empty input boundary.');
  const frame = await f.frame();
  assert.equal(frame.counts.selected, 1);
  assert.equal(frame.scenarios.length, 1);
  assert.equal(frame.status, 'partial');
  assert.equal(frame.reviewOnlyScenarios.length, 1);
  assert.equal(frame.reviewOnlyScenarios[0].given, boundary.given);
  assert.equal(frame.reviewOnlyScenarios[0].reviewOrigin, 'INDEPENDENT_COUNTEREXAMPLE');
  const brief = deliveredBrief(await f.toolResult('done'));
  assert.match(brief, /may still contain omissions/u);
  assert.doesNotMatch(brief, /Original test replaces|C1|different placement/u);
  const stop = await readStopFrame({ projectRoot: f.projectRoot, sessionId: f.sessionId, startHead: frame.startHead, review: true });
  assert.deepEqual(stop.basis.scenarios.map(item => item.id), ['S1', 'C1']);
  const initial = [{ id: 'S1', disposition: 'UNVERIFIED', reason: 'Current source has not been reviewed.' }];
  assert.equal(countFrameDispositions(stop.basis, initial, () => [], () => false), null,
    'selected-brief coverage cannot silently retire the independent counterexample');
  assert.equal(countFrameDispositions(stop.basis, [...initial, { id: 'C1', disposition: 'CHECKED', reason: 'Alternative setup.',
    contractAssessment: { applicability: 'APPLICABLE', given: primary.given, trace: 'The repaired dependency rejects.' } }], () => [], () => false), null,
    'Stop cannot replace the original successful substitute with a new failure outcome');
  const complete = countFrameDispositions(stop.basis, [...initial, { id: 'C1', disposition: 'UNVERIFIED',
    reason: 'The caller outcome under the original successful substitute is still unresolved.' }], () => [], () => false);
  assert.equal(complete.unverified, 2);
});

test('a full brief quota cannot silently remove a valid low-confidence independent counterexample', async t => {
  const primary = { ...scenario('ordinary input', .99), entryPoint: { path: 'gate.ts', symbol: 'accepts' },
    evidence: [{ path: 'gate.ts', startLine: 1, endLine: 1 }], contractCell: 'values_defaults' };
  const counterexample = { ...primary, given: 'original dependency succeeds at the empty-input boundary', confidence: .2 };
  const f = await fixture(t, { files: { 'gate.ts': 'export function accepts(value) { return value != null }\n' },
    propose: () => ({ guidance: [], scenarios: Array.from({ length: 6 }, (_, index) => ({ ...primary, given: 'ordinary input ' + index })) }),
    challenge: () => ({ guidance: [], scenarios: [counterexample] }) });
  await f.prompt();
  const frame = await f.frame();
  assert.equal(frame.counts.valid, 7); assert.equal(frame.counts.selected, 6);
  assert.equal(frame.reviewOnlyScenarios.length, 1);
  assert.equal(frame.reviewOnlyScenarios[0].given, counterexample.given);
  const stop = await readStopFrame({ projectRoot: f.projectRoot, sessionId: f.sessionId, startHead: frame.startHead, review: true });
  assert.equal(stop.basis.scenarios.length, 7);
});

test('Stop keeps independent counterexamples even when the host brief has no selected advice', async t => {
  const primary = { ...scenario('an ordinary input', .9, 'empty input'), entryPoint: { path: 'gate.ts', symbol: 'accepts' },
    evidence: [{ path: 'gate.ts', startLine: 1, endLine: 1 }], contractCell: 'values_defaults' };
  const counterexample = { ...primary, given: 'the original input is absent' };
  const f = await fixture(t, { files: { 'gate.ts': 'export function accepts(value) { return value != null }\n' },
    propose: () => ({ guidance: [], scenarios: [primary] }), challenge: () => ({ guidance: [], scenarios: [counterexample] }),
    select: items => ({ reviews: items.map(item => review(item, 'reject')), finish: true }) });
  await f.prompt();
  const frame = await f.frame();
  assert.equal(frame.counts.selected, 0); assert.equal(frame.status, 'empty');
  const stop = await readStopFrame({ projectRoot: f.projectRoot, sessionId: f.sessionId, startHead: frame.startHead, review: true });
  assert.deepEqual(stop.basis.scenarios.map(item => item.id), ['C1']);
  assert.equal(stop.basis.scenarios[0].given, counterexample.given);
});

test('a legacy cached brief is regenerated before it can claim independent counterexample audit coverage', async t => {
  const f = await fixture(t);
  await f.prompt();
  const legacy = await f.frame(), before = f.calls.length;
  delete legacy.counterexampleAuditVersion;
  await fs.writeFile(path.join(f.dir, 'frame.json'), JSON.stringify(legacy));
  const oldStop = await readStopFrame({ projectRoot: f.projectRoot, sessionId: f.sessionId, startHead: legacy.startHead, review: true });
  assert.equal(oldStop.preparation.counterexampleAuditVersion, 0);
  await f.prompt();
  const regenerated = await f.frame();
  assert.equal(regenerated.counterexampleAuditVersion, 1);
  assert(f.calls.length > before, 'legacy advice cannot bypass the new independent-counterexample preparation');
});

test('invalid raw counterexample evidence is never promoted to a retained Stop scenario', async t => {
  const primary = { ...scenario('an ordinary input'), entryPoint: { path: 'gate.ts', symbol: 'accepts' },
    evidence: [{ path: 'gate.ts', startLine: 1, endLine: 1 }], contractCell: 'values_defaults' };
  const f = await fixture(t, { files: { 'gate.ts': 'export function accepts(value) { return value != null }\n' },
    propose: () => ({ guidance: [], scenarios: [primary] }), challenge: () => ({ guidance: [],
      scenarios: [{ ...primary, given: 'unsupported raw claim', evidence: [{ path: 'missing-test.ts', startLine: 1, endLine: 1 }] }] }) });
  await f.prompt();
  const frame = await f.frame();
  assert.equal(frame.reviewOnlyScenarios, undefined);
  const stop = await readStopFrame({ projectRoot: f.projectRoot, sessionId: f.sessionId, startHead: frame.startHead, review: true });
  assert.deepEqual(stop.basis.scenarios.map(item => item.id), ['S1']);
});

