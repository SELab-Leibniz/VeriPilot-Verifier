// Document review against the original requirements, without the dynamic
// baseline. Native transcripts, reviewers and projects are temporary fixtures;
// scripted verdicts exercise routing and evidence, not model accuracy.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { loadRuntimePlan } from '../lib/runtime-plan.mjs';
import { buildOriginalRequirements, recordUserMessages, userMessageLogPath, writeOriginalRequirementSources }
  from '../lib/runtime-v2/original-requirements.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let outputRoot, pluginRoot, claudePluginRoot, createRuntime;
before(async () => {
  outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-requirements-build-'));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(outputRoot, 'openclaw') });
  claudePluginRoot = await buildPlugin({ host: 'claude', sourceRoot, outputRoot: path.join(outputRoot, 'claude') });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
});
after(async () => { if (outputRoot) await fs.rm(outputRoot, { recursive: true, force: true }); });

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-requirements-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const policy = (mode, { materialRoots = '[docs/requirements]', originalKey = true, compactionRestore = false } = {}) => `version: 2
artifacts:
  - name: design
    stage: design
    format: markdown
    patterns: [docs/design.md]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: document-review.md
dynamicGroundTruth:
  enabled: ${mode !== 'original-only' && mode !== 'stop-original'}
${materialRoots ? `  materialRoots: ${materialRoots}\n` : ''}  panel:
    size: 0
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: ${mode === 'ledger'}
  stageMetricsEnabled: false
${originalKey ? `  originalRequirementsEnabled: ${mode === 'original' || mode === 'original-only'}\n` : ''}implementationCorrection:
  enabled: false
stopCorrection:
  enabled: ${mode === 'stop-original'}
${mode === 'stop-original' ? '  originalRequirementsBasis: true\n' : ''}${compactionRestore ? 'compactionRestore:\n  enabled: true\n' : ''}reviewers:
  defaults:
    timeoutMs: 15000
`;

test('original requirements keep every real user message and exclude agent artifacts from the sources', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/requirements/prd.md'), '# PRD\nImports stay offline.\n');
  await fs.writeFile(path.join(root, 'docs/design.md'), '# Draft\n');
  await fs.writeFile(path.join(root, 'docs/api.md'), '# API\nGET /items\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Only docs/design.md is editable.\n');
  const entries = [
    { type: 'user', uuid: 'u1', timestamp: 1, message: { content: 'Write docs/design.md. Follow docs/api.md and keep imports offline.' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'I will upload data to the cloud.' }] } },
    { type: 'user', isMeta: true, uuid: 'm1', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [] }] } },
    { type: 'user', uuid: 'i1', message: { content: '[runtime-corrector:internal] reviewer prompt' } },
    { type: 'user', uuid: 'u2', timestamp: 2, message: { content: [{ type: 'text', text: 'Also support CSV export.' }] } },
  ];
  const materials = { entries: [
    { root: path.join(root, 'docs/requirements'), path: 'prd.md', bytes: 26, sha256: 'prd' },
    { root: path.join(root, 'docs'), path: 'design.md', bytes: 8, sha256: 'design' },
  ] };
  const plan = await loadRuntimePlan({ cwd: root, config: { version: 2, artifacts: [{ name: 'design', stage: 'design', format: 'markdown',
    patterns: ['docs/design.md'] }], artifactCorrection: { originalRequirementsEnabled: true } } });
  const basis = await buildOriginalRequirements({ projectRoot: root, snapshot: { entries }, materials, plan,
    hostAdapter: { instructionFileNames: ['AGENTS.md', 'CLAUDE.md'] } });
  assert.deepEqual(basis.userMessages.map(message => [message.order, message.ref, message.text]), [
    [1, 'transcript:u1', 'Write docs/design.md. Follow docs/api.md and keep imports offline.'],
    [2, 'transcript:u2', 'Also support CSV export.'],
  ]);
  assert.deepEqual(basis.materials.map(file => file.path), ['docs/requirements/prd.md']);
  assert.deepEqual(basis.projectFiles.map(file => file.path), ['AGENTS.md']);
  assert.deepEqual(basis.referencedFiles.map(file => [file.path, file.referencedBy]), [['docs/api.md', [1]]]);
  const again = await buildOriginalRequirements({ projectRoot: root, snapshot: { entries }, materials, plan,
    hostAdapter: { instructionFileNames: ['AGENTS.md'] } });
  assert.equal(again.digest, basis.digest);
  const changed = await buildOriginalRequirements({ projectRoot: root, plan, materials,
    snapshot: { entries: [...entries, { type: 'user', uuid: 'u3', message: { content: 'Drop CSV export.' } }] },
    hostAdapter: { instructionFileNames: ['AGENTS.md'] } });
  assert.notEqual(changed.digest, basis.digest);
});

test('the session message log keeps user messages that a rewritten transcript dropped', async t => {
  const root = await project(t);
  const first = { type: 'user', uuid: 'u1', message: { content: 'Keep imports offline.' } };
  const second = { type: 'user', uuid: 'u2', message: { content: 'Add CSV export.' } };
  assert.deepEqual(await recordUserMessages({ projectRoot: root, sessionId: 's', snapshot: { entries: [first] } }),
    [{ ref: 'transcript:u1', timestamp: null, text: 'Keep imports offline.' }]);
  await fs.appendFile(userMessageLogPath(root, 's'), '{"torn":');
  const after = await recordUserMessages({ projectRoot: root, sessionId: 's', snapshot: { entries: [second] } });
  assert.deepEqual(after.map(message => [message.ref, message.retainedAfterCompaction ?? false]),
    [['transcript:u1', true], ['transcript:u2', false]]);
  const again = await recordUserMessages({ projectRoot: root, sessionId: 's', snapshot: { entries: [first, second] } });
  assert.deepEqual(again.map(message => [message.ref, message.retainedAfterCompaction ?? false]),
    [['transcript:u1', false], ['transcript:u2', false]]);
  const other = await recordUserMessages({ projectRoot: root, sessionId: 'other', snapshot: { entries: [] } });
  assert.deepEqual(other, [], 'logs never cross sessions');
});

test('original message files stay complete while the inline copy is bounded', async t => {
  const root = await project(t);
  const long = 'L'.repeat(5000);
  const written = await writeOriginalRequirementSources(root, { digest: 'd', materials: [], projectFiles: [], referencedFiles: [],
    userMessages: [{ order: 1, ref: 'transcript:a', characters: 5, sha256: 'a'.repeat(64), text: 'short' },
      { order: 2, ref: 'transcript:b', characters: long.length, sha256: 'b'.repeat(64), text: long }] }, { inlineBudget: 1000 });
  assert.equal(written.userMessages[0].text, 'short');
  assert.equal(written.userMessages[1].text, undefined);
  assert.equal(written.userMessages[1].preview.length, 300);
  for (const [index, text] of [[0, 'short'], [1, long]]) assert.equal(await fs.readFile(written.userMessages[index].path, 'utf8'), text);
});

test('original requirements need no dynamic baseline and cannot be combined with the baseline review', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs/requirements.md'), '# Requirements\n');
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), policy('original-only', { materialRoots: null }));
  const plan = await loadRuntimePlan({ cwd: root });
  assert.equal(plan.runtimeV2.enabled, true);
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, false);
  assert.equal(plan.runtimeV2.artifactCorrection.originalRequirementsEnabled, true);
  assert(plan.runtimeV2.dynamicGroundTruth.materialRoots.some(root => root.endsWith('requirements.md')),
    'unset material roots fall back to project material discovery');
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), policy('ledger').replace('originalRequirementsEnabled: false', 'originalRequirementsEnabled: true'));
  await assert.rejects(loadRuntimePlan({ cwd: root }), /originalRequirementsEnabled/u);
});

test('the live document harness policy selects the original requirements review', async t => {
  const { documentHookPolicy, openclawDocumentOptions } = await import('../scripts/evaluate-openclaw-document-e2e.mjs');
  const root = await project(t);
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, 'requirements.md'), '# Requirements\n');
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Review.\n');
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), documentHookPolicy('fixture', openclawDocumentOptions(), false, 'anthropic', true));
  const plan = await loadRuntimePlan({ cwd: root });
  assert.equal(plan.runtimeV2.artifactCorrection.originalRequirementsEnabled, true);
  assert.equal(plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, false);
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, false);
});

async function documentFixture(t, mode, policyOptions = {}) {
  const root = await project(t);
  let runtime;
  t.after(async () => { await runtime?.dispose(); await runtime?.waitForBackgroundReviews(); });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), policy(mode, policyOptions));
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Check the design against the original requirements.\n');
  await fs.writeFile(path.join(root, 'docs/requirements/constraints.md'), '# Constraints\nAll imports run offline on the device.\n');
  const sessionId = `doc-${mode}`, sessionKey = `agent:main:doc-${mode}`, transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root }) + '\n');
  let leaf = null;
  const append = async record => {
    const id = record.id ?? randomUUID();
    await fs.appendFile(transcript, JSON.stringify({ type: 'message', ...record, id, parentId: leaf }) + '\n'); leaf = id;
  };
  const calls = [];
  // A host lifecycle mutation (manual compaction) withholds work admission until it ends.
  let admissionHeld = null;
  const admissions = new Set();
  const admit = (params, run) => {
    const admitted = Promise.resolve(admissionHeld).then(() => run(params.signal));
    admissions.add(admitted);
    admitted.then(() => admissions.delete(admitted), () => admissions.delete(admitted));
    return admitted;
  };
  const holdAdmission = () => {
    let open;
    admissionHeld = new Promise(resolve => { open = resolve; });
    return async () => { admissionHeld = null; open(); await Promise.allSettled([...admissions]); };
  };
  const api = { id: 'runtime-corrector', pluginConfig: { hookTimeoutMs: 5000 },
    config: { plugins: { entries: { autopilot: { enabled: false } } } },
    logger: { warn: value => calls.push({ warning: value }), info() {} },
    runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => path.join(root, 'host-state') },
      agent: { resolveAgentWorkspaceDir: () => root, session: {
        getSessionEntry: async () => ({ sessionId, sessionFile: transcript }), resolveStorePath: () => path.join(root, 'sessions.json'),
        resolveSessionFilePath: () => transcript, runWithWorkAdmission: admit,
      }, runEmbeddedAgent() { assert.fail('the offline document fixture must never start a live model'); } },
      gateway: { request: async () => ({ id: 'offline-notice', aborted: true }) } } };
  const factory = async input => {
    const { request, schema, role } = input;
    const handle = result => ({ result, sessionId: `scripted-${randomUUID()}`, close: async () => {} });
    if (schema?.properties?.operations) {
      calls.push({ role: 'ground-truth-extractor' });
      const source = request.sourceCatalog.filter(item => item.kind === 'USER_MESSAGE').at(-1);
      const recorded = input.evidence?.groundTruth?.claims?.some(claim => claim.source?.ref === source.ref);
      return handle({ summary: 'Controlled baseline', taskClassification: 'CONTINUATION', operations: recorded ? [] : [{
        operation: 'ADD', category: 'requirements', text: 'docs/design.md keeps imports offline.', authority: 'USER_EXPLICIT', severity: 'HARD',
        verificationTarget: 'ARTIFACT', expectedFiles: ['docs/design.md'], source: { ref: source.ref, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }] });
    }
    if (role === 'artifact-reviewer') {
      const semantic = JSON.parse(await fs.readFile(request.semanticReviewRequestPath, 'utf8'));
      const messages = await Promise.all((semantic.originalRequirements?.userMessages ?? [])
        .map(async message => ({ ...message, full: await fs.readFile(message.path, 'utf8') })));
      const design = await fs.readFile(path.join(root, 'docs/design.md'), 'utf8');
      calls.push({ role, semantic, messages, ledger: Boolean(semantic.runtimeV2) });
      const line = design.split('\n').findIndex(text => /cloud/iu.test(text)) + 1;
      const offline = messages.some(message => /offline/iu.test(message.full)) || Boolean(semantic.runtimeV2);
      return handle({ summary: 'Controlled original-requirement review', edits: [], findings: line && offline ? [{
        ruleId: 'AGENT-OFFLINE-IMPORT', severity: 'error', path: 'docs/design.md', line,
        message: 'The design uploads imports to the cloud, but the user requires offline imports.',
        evidence: [`docs/design.md:${line}: "${design.split('\n')[line - 1]}"`, 'user message 1: "keep imports offline"'] }] : [] });
    }
    assert.fail(`Unplanned offline reviewer role: ${role}`);
  };
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  runtime = createRuntime(api, { pluginRoot, sharedState: {}, reviewerFactory: factory, nativeHooks: true,
    projectScopes: admittedProjectScopes(api),
    compatibility: async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }),
    stopStartCompatibility: async () => ({ version: 1, onStart: () => () => {}, drain: async () => {}, diagnosticsEnabled: () => true }),
    postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  await runtime.postRunReady;
  const context = runId => ({ agentId: 'main', sessionId, sessionKey, runId, workspaceDir: root, trigger: 'user',
    provider: 'offline', modelId: 'scripted', abortSignal: new AbortController().signal });
  let promptResult;
  // The MA host persists the user message only after before_prompt_build.
  const ask = async (runId, prompt, { persistAfterPrompt = false } = {}) => {
    if (!persistAfterPrompt) await append({ message: { role: 'user', content: prompt } });
    const ctx = context(runId);
    await runtime.sessionStart({ sessionId, source: 'startup' }, ctx);
    const gate = await runtime.beforeAgentRun({ sessionId, sessionKey, prompt }, ctx);
    assert(!gate || gate.outcome === 'pass', JSON.stringify({ gate, calls }));
    promptResult = await runtime.prompt({ prompt }, ctx);
    if (persistAfterPrompt) await append({ message: { role: 'user', content: prompt } });
    return ctx;
  };
  const write = async (ctx, content) => {
    const toolCallId = randomUUID(), args = { path: 'docs/design.md', content };
    await append({ message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'write', arguments: args }] } });
    const gate = await runtime.beforeTool({ toolName: 'write', toolCallId, params: args }, ctx);
    assert(!gate?.block, JSON.stringify(gate));
    await fs.writeFile(path.join(root, 'docs/design.md'), content);
    await append({ message: { role: 'toolResult', toolName: 'write', toolCallId, isError: false, content: [{ type: 'text', text: 'written' }] } });
    const before = calls.length;
    const result = await runtime.toolResult({ toolName: 'write', toolCallId, args,
      result: { content: [{ type: 'text', text: 'written' }], details: { status: 'completed' } } }, ctx);
    const text = (result?.result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    return { feedback: text, calls: calls.slice(before) };
  };
  const finish = async (ctx, text) => {
    await append({ message: { role: 'assistant', content: text } });
    await runtime.beforeFinalize({ sessionId, runId: ctx.runId, lastAssistantMessage: text }, ctx);
    await runtime.agentEnd({ sessionId, runId: ctx.runId, success: true, messages: [{ role: 'assistant', content: text }] }, ctx);
    await runtime.waitForNativeReviews();
  };
  // A manual gateway compaction runs outside any agent run; maxLines truncation fires no hook.
  const compact = async (ctx, summary, { truncate = false, manual = false, hook = true } = {}) => {
    if (hook) await runtime.compact({ sessionId }, manual ? { agentId: 'main', sessionId, sessionKey, workspaceDir: root } : ctx);
    const id = `c-${randomUUID()}`;
    const record = { type: 'compaction', id, parentId: truncate ? null : leaf, summary, firstKeptEntryId: leaf, tokensBefore: 120000 };
    if (truncate) await fs.writeFile(transcript, [{ type: 'session', version: 3, id: sessionId, cwd: root }, record]
      .map(item => JSON.stringify(item)).join('\n') + '\n');
    else await fs.appendFile(transcript, JSON.stringify(record) + '\n');
    leaf = id;
  };
  return { root, sessionId, ask, write, finish, compact, holdAdmission, calls,
    get promptResult() { return promptResult; } };
}

test('original mode reviews a document write against the user messages without refreshing the baseline', async t => {
  const f = await documentFixture(t, 'original');
  const ctx = await f.ask('original-run', 'Write docs/design.md for the importer. Keep imports offline; see docs/requirements/constraints.md.');
  const first = await f.write(ctx, '# Importer\nUpload every import to the cloud.\n');
  assert.deepEqual(first.calls.map(call => call.role), ['artifact-reviewer'], 'a document write must not start baseline extraction');
  const [review] = first.calls;
  assert.equal(review.ledger, false);
  assert.equal(review.semantic.originalRequirements.schemaVersion, 'runtime-corrector.original-requirements.v1');
  assert.deepEqual(review.messages.map(message => message.full), ['Write docs/design.md for the importer. Keep imports offline; see docs/requirements/constraints.md.']);
  assert.deepEqual(review.semantic.originalRequirements.materials.map(file => file.path), ['docs/requirements/constraints.md']);
  assert.equal(review.semantic.originalRequirements.materials.some(file => file.path === 'docs/design.md'), false);
  assert.match(first.feedback, /AGENT-OFFLINE-IMPORT/u);
  const repaired = await f.write(ctx, '# Importer\nImports run offline on the device.\n');
  assert.deepEqual(repaired.calls.map(call => call.role), ['artifact-reviewer']);
  assert.doesNotMatch(repaired.feedback, /AGENT-OFFLINE-IMPORT/u);
});

for (const [truncate, writeFirst] of [[false, true], [true, true], [true, false]]) test(`original mode still sees the original user message after ${truncate ? 'a truncating' : 'an append-only'} host compaction${writeFirst ? '' : ' before any document write'}`, async t => {
  const f = await documentFixture(t, 'original');
  const first = await f.ask('before-compaction', 'Write docs/design.md. Keep imports offline.');
  if (writeFirst) await f.write(first, '# Importer\nImports run offline.\n');
  await f.compact(first, 'Summary: the user wants an importer design.', { truncate });
  await f.finish(first, 'The importer design is written.');
  const second = await f.ask('after-compaction', 'Add a section about CSV export.');
  const result = await f.write(second, '# Importer\nUpload imports to the cloud.\n\n## CSV export\nExport CSV files.\n');
  const [review] = result.calls;
  assert.deepEqual(review.messages.map(message => [message.full, message.retainedAfterCompaction ?? false]),
    [['Write docs/design.md. Keep imports offline.', truncate], ['Add a section about CSV export.', false]]);
  assert.match(result.feedback, /AGENT-OFFLINE-IMPORT/u, 'the pre-compaction requirement must still govern the review');
  const archived = (await fs.readFile(userMessageLogPath(f.root, f.sessionId), 'utf8')).trim().split('\n').map(line => JSON.parse(line).text);
  assert.deepEqual(archived, ['Write docs/design.md. Keep imports offline.', 'Add a section about CSV export.']);
});

const REQUIREMENTS_ONLY = 'Requirements for docs/design.md: keep imports offline. Reply only with "Noted".';

test('C restores a late-persisted user message once after manual truncating compaction', async t => {
  for (const captureAtTurnEnd of [true, false]) {
    const f = await documentFixture(t, 'original-only', { compactionRestore: true });
    const first = await f.ask('requirements-only', REQUIREMENTS_ONLY, { persistAfterPrompt: true });
    if (captureAtTurnEnd) {
      await f.finish(first, 'Noted');
      const archived = await recordUserMessages({ projectRoot: f.root, sessionId: f.sessionId });
      assert.deepEqual(archived.map(message => message.text), [REQUIREMENTS_ONLY], 'agentEnd must capture the late-persisted user message');
    }
    // An admitted PreCompact callback cannot see the old transcript once the
    // manual host mutation releases admission.
    const release = f.holdAdmission();
    try {
      await f.compact(first, 'Truncated.', { truncate: true, manual: true });
    } finally {
      await release();
    }
    if (!captureAtTurnEnd) await f.finish(first, 'Noted');
    const second = await f.ask('after-compaction', 'Now write docs/design.md.', { persistAfterPrompt: true });
    const restored = f.promptResult?.prependContext ?? '';
    assert.match(restored, /\[runtime-corrector:internal\]/u, 'manual compaction must preserve the original when it precedes agentEnd');
    assert.equal(restored.split(REQUIREMENTS_ONLY).length, 2);
    await f.finish(second, 'Noted');
    await f.ask('after-restore', 'Continue.', { persistAfterPrompt: true });
    assert.equal(f.promptResult?.prependContext, undefined);
  }
});

test('a turn without tools logs its user message at turn end, so a hookless truncation loses nothing', async t => {
  const f = await documentFixture(t, 'original');
  const first = await f.ask('requirements-only', REQUIREMENTS_ONLY, { persistAfterPrompt: true });
  await f.finish(first, 'Noted');
  await f.compact(first, 'Truncated.', { truncate: true, hook: false });
  const second = await f.ask('after-truncation', 'Now write docs/design.md.', { persistAfterPrompt: true });
  const [review] = (await f.write(second, '# Importer\nUpload imports to the cloud.\n')).calls;
  assert.deepEqual(review.messages.map(message => [message.full, message.retainedAfterCompaction ?? false]),
    [[REQUIREMENTS_ONLY, true], ['Now write docs/design.md.', false]]);
});

test('a manual host compaction neither waits for withheld work admission nor loses the user message', async t => {
  const f = await documentFixture(t, 'original');
  const first = await f.ask('requirements-only', REQUIREMENTS_ONLY, { persistAfterPrompt: true });
  const release = f.holdAdmission();
  const outcome = await Promise.race([f.compact(first, 'Truncated.', { truncate: true, manual: true }).then(() => 'returned'),
    new Promise(resolve => setTimeout(resolve, 2000, 'waiting'))]);
  await release();
  assert.equal(outcome, 'returned');
  await f.finish(first, 'Noted');
  const second = await f.ask('after-compaction', 'Now write docs/design.md.');
  const result = await f.write(second, '# Importer\nUpload imports to the cloud.\n');
  const [review] = result.calls;
  assert.deepEqual(review.messages.map(message => [message.full, message.retainedAfterCompaction ?? false]),
    [[REQUIREMENTS_ONLY, true], ['Now write docs/design.md.', false]]);
  assert.match(result.feedback, /AGENT-OFFLINE-IMPORT/u);
});

test('with only the Stop original basis enabled, the host still logs a user message before a manual compaction drops it', async t => {
  const f = await documentFixture(t, 'stop-original');
  const { runtimeV2 } = await loadRuntimePlan({ cwd: f.root });
  assert.equal(runtimeV2.artifactCorrection.originalRequirementsEnabled, false);
  assert.equal(runtimeV2.stopCorrection.originalRequirementsBasis, true);
  const first = await f.ask('requirements-only', REQUIREMENTS_ONLY, { persistAfterPrompt: true });
  const release = f.holdAdmission();
  await f.compact(first, 'Truncated.', { truncate: true, manual: true });
  await release();
  const archived = (await fs.readFile(userMessageLogPath(f.root, f.sessionId), 'utf8')).trim().split('\n').map(line => JSON.parse(line).text);
  assert.deepEqual(archived, [REQUIREMENTS_ONLY]);
});

test('the Claude Code PostToolUse hook delivers the same original requirements to its review fork', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), policy('original-only'));
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Check the design against the original requirements.\n');
  await fs.writeFile(path.join(root, 'docs/requirements/constraints.md'), '# Constraints\nAll imports run offline on the device.\n');
  await fs.writeFile(path.join(root, 'docs/api.md'), '# API\nGET /items\n');
  await fs.writeFile(path.join(root, 'docs/design.md'), '# Importer\nUpload every import to the cloud.\n');
  const transcript = path.join(root, 'transcript.jsonl');
  await fs.writeFile(transcript, [
    { type: 'user', uuid: 'c1', timestamp: '2026-11-04T00:00:00Z', message: { role: 'user', content: 'Write docs/design.md and follow docs/api.md. Keep imports offline.' } },
    { type: 'assistant', uuid: 'c2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'Write', input: { file_path: path.join(root, 'docs/design.md') } }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const shim = path.join(root, 'fake-claude.cjs'), capture = path.join(root, 'capture.jsonl');
  await fs.writeFile(shim, String.raw`
const fs = require("node:fs"), path = require("node:path");
const prompt = process.argv[1] || "";
const match = prompt.match(/--request "([^"]+)"/);
if (prompt.includes("runtime-corrector:semantic-review --request ") && match) {
  const request = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), match[1]), "utf8"));
  const files = (request.originalRequirements?.userMessages ?? []).map(message => fs.readFileSync(message.path, "utf8"));
  fs.appendFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ request, files }) + "\n");
  process.stdout.write(JSON.stringify({ session_id: "fork", structured_output: { summary: "fixture", findings: [], edits: [] } }));
  process.exit(0);
}
`);
  const completed = spawnSync(process.execPath, [path.join(claudePluginRoot, 'scripts/post-tool-use.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ session_id: 'claude-original', transcript_path: transcript, cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'docs/design.md') }, tool_response: { success: true }, tool_use_id: 'toolu-1' }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: claudePluginRoot, CODEAGENT3_PLUGIN_ROOT: '', RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
      NODE_OPTIONS: `--require=${shim.replaceAll('\\', '/')}`, FAKE_CLAUDE_CAPTURE: capture } });
  assert.equal(completed.status, 0, completed.stderr);
  const [{ request, files }] = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(files, ['Write docs/design.md and follow docs/api.md. Keep imports offline.']);
  assert.deepEqual(request.originalRequirements.materials.map(file => file.path), ['docs/requirements/constraints.md']);
  assert.deepEqual(request.originalRequirements.referencedFiles.map(file => file.path), ['docs/api.md']);
  assert.deepEqual(request.originalRequirements.projectFiles, []);
  assert.equal(request.runtimeV2, undefined);
});

const publishedClaims = async root => {
  const [taskId] = await fs.readdir(path.join(root, '.runtime-correction/tasks'));
  const published = JSON.parse(await fs.readFile(path.join(root, '.runtime-correction/tasks', taskId, 'ground-truth/current.json'), 'utf8'));
  return published.claims.map(claim => claim.text);
};

test('ledger mode publishes an extracted baseline before its first review', async t => {
  const ledger = await documentFixture(t, 'ledger');
  const ctx = await ledger.ask('ledger-run', 'Write docs/design.md. Keep imports offline.');
  const reviewed = await ledger.write(ctx, '# Importer\nUpload every import to the cloud.\n');
  assert.deepEqual(reviewed.calls.map(call => call.role), ['ground-truth-extractor', 'artifact-reviewer']);
  assert.equal(reviewed.calls[1].ledger, true);
  assert.equal(reviewed.calls[1].semantic.originalRequirements, undefined);
  assert.deepEqual(await publishedClaims(ledger.root), ['docs/design.md keeps imports offline.']);
});

for (const [label, policyOptions] of [['absent', { originalKey: false }], ['false', {}]]) test(`with originalRequirementsEnabled ${label}, a document write refreshes the dynamic baseline before its review`, async t => {
  const f = await documentFixture(t, 'transcript', policyOptions);
  const config = await fs.readFile(path.join(f.root, '.runtime-corrector/config.yaml'), 'utf8');
  assert.equal(/originalRequirementsEnabled/u.test(config), label === 'false');
  assert.equal((await loadRuntimePlan({ cwd: f.root })).runtimeV2.artifactCorrection.originalRequirementsEnabled, false);
  const reviewed = await f.write(await f.ask('transcript-run', 'Write docs/design.md. Keep imports offline.'),
    '# Importer\nUpload every import to the cloud.\n');
  assert.deepEqual(reviewed.calls.map(call => call.role), ['ground-truth-extractor', 'artifact-reviewer']);
  assert.equal(reviewed.calls[1].ledger, false, 'the review itself still does not use the baseline');
  assert.equal(reviewed.calls[1].semantic.originalRequirements, undefined);
  assert.deepEqual(await publishedClaims(f.root), ['docs/design.md keeps imports offline.']);
});
