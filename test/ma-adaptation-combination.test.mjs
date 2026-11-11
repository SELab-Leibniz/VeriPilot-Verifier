// All business files, native transcripts, reviewer sessions and scheduler data
// live under temporary roots. Scripted verdicts exercise transport/ownership;
// they are not a model accuracy oracle and never contact a real MA host.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { skillGraphQuoteCandidate, observeScriptedSkillSourceReview } from './helpers/skill-source-interpretation.mjs';

const execute = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let outputRoot, pluginRoot, createRuntime, findTask, taskDirectory, runWorkspaceStopReview, createPostRunDispatcher;
before(async () => {
  outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-combination-build-'));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot });
  const packed = relative => import(pathToFileURL(path.join(pluginRoot, relative)));
  ({ createOpenClawRuntime: createRuntime } = await packed('lib/openclaw/runtime.mjs'));
  ({ findTask, taskDirectory } = await packed('lib/runtime-v2/task-store.mjs'));
  ({ runWorkspaceStopReview } = await packed('lib/runtime-v2/stop-workspace-review.mjs'));
  ({ createPostRunDispatcher } = await packed('lib/openclaw/post-run-dispatch.mjs'));
});
after(async () => { if (outputRoot) await fs.rm(outputRoot, { recursive: true, force: true }); });
async function within(promise, description, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function eventually(predicate, description) {
  const until = Date.now() + 10000;
  while (!await predicate()) { assert(Date.now() < until, description); await pause(5); }
}

// Consume actual source_read receipts, not fabricated citation tags. M08 must
// disclose the bound original Skill as well as invocation/result process bytes.
async function originalWorkspaceReview(input, root, witnesses) {
  const signal = input.abortSignal ?? new AbortController().signal;
  const session = { signal, sessionId: randomUUID(),
    deadlineAt: Math.min(input.deadlineAt ?? Infinity, Date.now() + input.reviewer.timeoutMs),
    active() { signal.throwIfAborted(); },
    async run(worker) {
      const tools = new Map(worker.tools.map(tool => [tool.name, tool]));
      const call = async (name, args) => {
        worker.onAssistantMessageStart();
        const id = randomUUID(), result = await tools.get(name).execute(id, args);
        if (name === 'source_read') worker.observeReceipt({ toolName: name, toolCallId: id, isSynthetic: false,
          message: { role: 'toolResult', toolName: name, toolCallId: id, isError: false, content: result.content } });
        return result;
      };
      const read = async file => {
        let offset = 1, cite;
        do {
          const result = await call('source_read', { path: file, offset });
          offset = result.details.page.nextOffset; cite = result.details.citation.citeId;
        } while (offset !== null);
        return cite;
      };
      const { task } = JSON.parse(worker.prompt);
      for (const file of task.basisFiles) await read(file);
      await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true,
        requiredUserInput: null, externalBlocker: null });
      let offset = 0;
      do {
        const response = await call('review_checklist', { offset, limit: 20, includeProcessEvidence: true });
        const page = JSON.parse(response.content[0].text), originals = new Set(page.processFiles ?? []);
        // This fixture intentionally remains small. A truncated pointer list is
        // a fixture error, never permission to skip original execution records.
        assert.equal(page.processFilesComplete, true, 'combination fixture must disclose every captured process file');
        const processCites = [];
        for (const file of originals) processCites.push(await read(file));
        for (const item of page.items) {
          if (item.savedResult) continue;
          const cites = [await read(path.join(root, 'design.md'))];
          if (item.proofOwners.includes('PROCESS')) cites.push(...processCites);
          if (item.metricId === 'M08') {
            assert(!item.originalSkillBasis.error, JSON.stringify(item.originalSkillBasis));
            witnesses.m08.push(structuredClone(item));
            for (const file of item.originalSkillBasis.requiredFiles) cites.push(await read(file));
          }
          await call('submit_review', { taskId: item.taskId, verdict: 'PASS', citeIds: [...new Set(cites)],
            reason: 'Controlled fixture assessed the disclosed current document and exact original process/Skill bytes.' });
        }
        offset = page.nextOffset;
      } while (offset !== null);
      await call('finish_stop_review', { summary: 'Every assigned original checklist item has a saved receipt.' });
    } };
  return runWorkspaceStopReview(input, { session });
}

async function nativeFixture(t, { combined = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-combination-')));
  let runtime, waitMode = 'until_pass', autopilot = 'done';
  t.after(async () => { try { await runtime?.dispose(); await runtime?.waitForBackgroundReviews(); }
    finally { await fs.rm(root, { recursive: true, force: true }); } });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  const configure = async mode => {
    waitMode = mode;
    const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, false]));
    metrics.M01 = true; metrics.M08 = combined;
    await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: 2
artifacts:
  - name: design
    stage: design
    format: markdown
    patterns: [design.md]
    rules:
      enabled: false
    review:
      enabled: ${combined}
      criteria: document-review.md
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 1
    adjudicator: false
skillCorrection:
  enabled: ${combined}
  selection:
    mode: all
  completionCheckIntervalTurns: 100
  maxWatchTurns: 1000
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  metrics:
${Object.entries(metrics).map(([id, enabled]) => `    ${id}: ${enabled}`).join('\n')}
  fileQualityReviewEnabled: false
  waitMode: ${mode}
  assessmentTimeoutMs: 20000
  feedbackReserveMs: 1000
reviewers:
  defaults:
    timeoutMs: 15000
`);
  };
  await configure(waitMode);
  await fs.writeFile(path.join(root, '.runtime-corrector/document-review.md'), 'Check the current declared design against the original requirement.\n');
  await fs.writeFile(path.join(root, 'design.md'), '# Draft\n');
  await fs.writeFile(path.join(root, 'fixture-write.cjs'),
    "require('node:fs').writeFileSync('design.md','# Design\\nVerified acceptance.\\nRun: '+process.argv[2]+'\\n');console.log('design.md updated');\n");
  await fs.writeFile(path.join(root, 'fixture-verify.cjs'),
    "require('node:assert/strict').match(require('node:fs').readFileSync('design.md','utf8'),/Verified acceptance/);console.log('verified acceptance');\n");
  const selectedSkill = path.join(root, 'extra/group/demo/SKILL.md');
  const duplicateSkill = path.join(root, 'skills/demo/SKILL.md');
  for (const file of [selectedSkill, duplicateSkill]) await fs.mkdir(path.dirname(file), { recursive: true });
  const originalSkill = '---\nname: demo\ndescription: Verify the current design.\n---\n# Verification\n\nVerify design.md with an executable assertion before declaring completion.\n';
  await fs.writeFile(selectedSkill, originalSkill);
  await fs.writeFile(duplicateSkill, '---\nname: demo\ndescription: Different source.\n---\n# Other\n\nDo not substitute this duplicate for a different selected source.\n');
  const sessionId = 'combination', sessionKey = 'agent:main:combination', transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: root }) + '\n');
  let leaf = null;
  const append = async message => { const id = randomUUID(); await fs.appendFile(transcript,
    JSON.stringify({ type: 'message', id, parentId: leaf, message }) + '\n'); leaf = id; };
  const prompt = 'Deliver design.md and follow the selected verification Skill.';
  await append({ role: 'user', content: prompt });
  const warnings = [], terminals = new Map(), sharedState = {}, witnesses = { m08: [], stop: [], artifacts: [], roles: [] };
  const api = { id: 'runtime-corrector', pluginConfig: { hookTimeoutMs: 5000 },
    config: { plugins: { entries: { autopilot: { enabled: false } } }, skills: { load: { extraDirs: [path.join(root, 'extra')] } } },
    logger: { warn: value => warnings.push(value), info() {} },
    runtime: { version: '2026.7.1-2', state: { resolveStateDir: () => path.join(root, 'host-state') },
      agent: { resolveAgentWorkspaceDir: () => root, session: {
        getSessionEntry: async () => ({ sessionId, sessionFile: transcript }), resolveStorePath: () => path.join(root, 'sessions.json'),
        resolveSessionFilePath: () => transcript, runWithWorkAdmission: async (params, run) => run(params.signal),
      }, runEmbeddedAgent() { assert.fail('the offline combination fixture must never start a live model'); } },
      gateway: { request: async method => method === 'autopilot.status'
        ? { projection: autopilot === 'unknown' ? {} : { status: autopilot } }
        : { id: 'offline-notice', aborted: true } } } };
  const factory = async input => {
    const { request, schema, role } = input;
    witnesses.roles.push(role);
    const handle = result => ({ result, sessionId: `scripted-${randomUUID()}`, close: async () => {} });
    if (request.skillGraphOnly) return handle({ summary: 'Complete controlled graph proposal',
      skillGroundTruth: skillGraphQuoteCandidate(input.evidence.skillSource) });
    if (schema?.properties?.operations) {
      const sources = request.sourceCatalog.filter(source => source.kind === 'USER_MESSAGE'), source = sources.at(-1);
      const recorded = input.evidence?.groundTruth?.claims?.some(claim => claim.source?.ref === source.ref);
      return handle({ summary: 'Controlled original-user onboarding', taskClassification: 'CONTINUATION',
        operations: !recorded ? [{ operation: 'ADD', category: 'requirements',
          text: sources.length === 1 ? 'Deliver design.md with verified acceptance.' : 'Revise design.md with verified acceptance.', authority: 'USER_EXPLICIT', severity: 'HARD',
          verificationTarget: 'ARTIFACT', expectedFiles: ['design.md'],
          source: { ref: source.ref, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }] : [] });
    }
    if (role === 'artifact-reviewer') {
      assert(request.semanticReviewRequestPath, 'semantic reviewer must receive its current declared artifact request');
      const semantic = JSON.parse(await fs.readFile(request.semanticReviewRequestPath, 'utf8'));
      const bytes = await fs.readFile(path.join(root, 'design.md'), 'utf8');
      assert.match(bytes, /Verified acceptance/u);
      witnesses.artifacts.push({ semantic, bytes });
      return handle({ summary: 'Controlled assessment of the current declared design.', findings: [], edits: [] });
    }
    if (role === 'skill-reviewer') {
      const requestDirectory = path.join(taskDirectory(root, input.taskId), 'combination-receipts', randomUUID());
      await fs.mkdir(requestDirectory, { recursive: true });
      return observeScriptedSkillSourceReview(input, { ...handle({ summary: 'Original source and interpretation checked.',
        completionStatus: 'COMPLETED', findings: [], conditionalAssessments: [] }), requestDirectory });
    }
    if (request.reviewScope?.kind === 'workspace-stop') {
      const record = runtime.postRuns.list().sessions.find(record => record.sessionId === sessionId);
      const saved = record && runtime.postRuns.byId(record.id);
      witnesses.stop.push({ at: Date.now(), deadlineAt: saved?.deadlineAt ?? input.deadlineAt, roleDeadlineAt: input.deadlineAt, record: saved });
      return originalWorkspaceReview(input, root, witnesses);
    }
    assert.fail(`Unplanned offline reviewer role/scope: ${role} ${JSON.stringify(request.reviewScope)}`);
  };
  factory.supportsReviewCollection = true;
  factory.handoff = async ({ originHandle, ...input }) => { await originHandle?.close(); return factory(input); };
  runtime = createRuntime(api, { pluginRoot, sharedState, reviewerFactory: factory, nativeHooks: true,
    projectScopes: admittedProjectScopes(api),
    compatibility: async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }),
    stopStartCompatibility: async () => ({ version: 1, onStart: () => () => {}, drain: async () => {}, diagnosticsEnabled: () => true }),
    postRunTerminal: async (_identity, runId) => {
      assert(terminals.has(runId), `No trusted terminal fixture for ${runId}`); return terminals.get(runId).promise;
    } });
  await runtime.postRunReady;
  const context = runId => ({ agentId: 'main', sessionId, sessionKey, runId, workspaceDir: root, trigger: 'user',
    provider: 'offline', modelId: 'scripted', abortSignal: new AbortController().signal });
  const start = async runId => {
    const activePrompt = terminals.size ? `Revise design.md for ${runId} and verify acceptance.` : prompt;
    if (terminals.size) await append({ role: 'user', content: activePrompt });
    terminals.set(runId, deferred()); const ctx = context(runId);
    await runtime.sessionStart({ sessionId, source: 'startup' }, ctx);
    const gate = await runtime.beforeAgentRun({ sessionId, sessionKey, prompt: activePrompt }, ctx);
    assert(!gate || gate.outcome === 'pass', JSON.stringify({ gate, warnings }));
    await runtime.prompt({ prompt: activePrompt }, ctx); return ctx;
  };
  const tool = async (ctx, name, args, action) => {
    const toolCallId = randomUUID();
    await append({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name, arguments: args }] });
    const gate = await runtime.beforeTool({ toolName: name, toolCallId, params: args }, ctx);
    assert(!gate?.block, JSON.stringify(gate));
    const value = await action(), text = typeof value === 'string' ? value : 'completed';
    await append({ role: 'toolResult', toolName: name, toolCallId, isError: false, content: [{ type: 'text', text }] });
    await runtime.toolResult({ toolName: name, toolCallId, args,
      result: { content: [{ type: 'text', text }], details: { status: 'completed', exitCode: 0 } } }, ctx);
  };
  const write = ctx => tool(ctx, 'exec', { command: `"${process.execPath}" fixture-write.cjs "${ctx.runId}"`, workdir: root }, async () => {
    return (await execute(process.execPath, ['fixture-write.cjs', ctx.runId], { cwd: root })).stdout;
  });
  const verify = ctx => tool(ctx, 'exec', { command: `"${process.execPath}" fixture-verify.cjs`, workdir: root }, async () => {
    return (await execute(process.execPath, ['fixture-verify.cjs'], { cwd: root })).stdout;
  });
  const finish = async (ctx, text) => {
    await append({ role: 'assistant', content: text });
    await runtime.beforeFinalize({ sessionId, runId: ctx.runId, lastAssistantMessage: text }, ctx);
    await runtime.agentEnd({ sessionId, runId: ctx.runId, success: true, messages: [{ role: 'assistant', content: text }] }, ctx);
    terminals.get(ctx.runId).resolve({ runId: ctx.runId, status: 'ok' });
    await within(runtime.waitForNativeReviews(), `native Stop ${ctx.runId}`);
  };
  const post = () => {
    const entry = runtime.postRuns.list().sessions.find(record => record.sessionId === sessionId);
    return entry && runtime.postRuns.byId(entry.id);
  };
  const journal = async () => {
    const task = await findTask({ projectRoot: root, sessionId });
    assert(task, JSON.stringify({ warnings, roles: witnesses.roles }));
    const file = path.join(taskDirectory(root, task.taskId), 'journal/events.jsonl');
    return { task, events: (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse) };
  };
  return { root, runtime, api, warnings, witnesses, start, tool, write, verify, finish, post, journal, configure,
    selectedSkill, originalSkill, setAutopilot: value => { autopilot = value; } };
}

test('one native session preserves baseline, exec document review, exact duplicate Skill identity and original M08 through Stop', async t => {
  const f = await nativeFixture(t, { combined: true }), ctx = await f.start('business-one');
  await f.write(ctx);
  await f.tool(ctx, 'read', { path: f.selectedSkill }, () => fs.readFile(f.selectedSkill, 'utf8'));
  await f.verify(ctx);
  await f.finish(ctx, 'design.md is delivered. Its executable acceptance assertion passed.');
  const { task, events } = await f.journal(), identity = { path: await fs.realpath(f.selectedSkill), sha256: sha256(f.originalSkill) };
  assert(task.groundTruth.version > 0); assert.equal(task.groundTruth.onboardingPending?.length ?? 0, 0);
  assert.equal(task.documentCoverage.status, 'VERIFIED');
  assert(events.some(event => event.type === 'OPENCLAW_ARTIFACT_REVIEW' && path.basename(event.file) === 'design.md'));
  assert(f.witnesses.artifacts.length > 0, 'the actual script edit must invoke declared semantic document review');
  assert(Object.values(task.watchers).some(watcher => watcher.skillId === 'demo'
    && watcher.sourceIdentity.path === identity.path && watcher.sourceIdentity.sha256 === identity.sha256));
  assert(f.witnesses.m08.length > 0, 'exact selected Skill must survive into the assigned Stop population');
  for (const item of f.witnesses.m08) {
    assert.deepEqual(item.skillSourceIdentity, identity);
    assert(item.skillGraphDigest);
    assert(item.originalSkillBasis.requiredFiles.includes(identity.path), 'Stop must disclose the source actually read, despite workspace duplicate');
  }
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND', JSON.stringify({ post: f.post(), warnings: f.warnings }));
  assert.equal(f.post().phase, 'IDLE'); assert.equal(f.post().reviewStatus, 'NO_DEVIATION_FOUND');
});

for (const mode of ['assessment', 'until_pass']) for (const wake of ['done', 'unknown']) {
  test(`a new ${mode} host run owns its candidate after prior until_pass IDLE; autopilot ${wake} resumes it once`, async t => {
    const f = await nativeFixture(t), prior = await f.start('prior-until-pass');
    await f.write(prior); await f.finish(prior, 'The prior design is complete.');
    assert.equal(f.post().phase, 'IDLE'); assert.equal(f.post().reviewStatus, 'NO_DEVIATION_FOUND');
    const reviewedBefore = f.witnesses.stop.length;
    await f.configure(mode); f.api.config.plugins.entries.autopilot.enabled = true; f.setAutopilot('running');
    const current = await f.start(`autopilot-${mode}-${wake}`); await f.write(current);
    await f.finish(current, `A new candidate for ${mode}/${wake}.`);
    const held = f.post();
    assert.equal(held.phase, 'COEXIST_WAIT', JSON.stringify({ held, warnings: f.warnings }));
    assert.equal(held.runId, current.runId); assert.equal(held.candidate.runId, current.runId);
    assert.match(held.candidate.text, new RegExp(`${mode}/${wake}`, 'u'));
    assert(held.completedRuns.includes(prior.runId)); assert.equal(held.deadlineAt, null);
    assert.equal(f.witnesses.stop.length, reviewedBefore, 'verified RUNNING must suppress concurrent Stop review');
    await f.runtime.beforeFinalize({ sessionId: current.sessionId, runId: current.runId, lastAssistantMessage: held.candidate.text }, current);
    await f.runtime.agentEnd({ sessionId: current.sessionId, runId: current.runId, success: true }, current);
    await pause(30); f.setAutopilot(wake);
    const latest = f.post();
    await within(f.runtime.postRuns.recheck(latest, { actor: 'fixture-owner', runId: latest.runId, version: latest.version }), 'autopilot manual recheck');
    await within(f.runtime.waitForNativeReviews(), 'resumed candidate');
    assert.equal(f.witnesses.stop.length, reviewedBefore + 1, JSON.stringify({ message: 'duplicate finalize/end must coalesce the held candidate',
      post: f.post(), warnings: f.warnings, roles: f.witnesses.roles, task: (await f.journal()).task.verification }));
    const resumed = f.witnesses.stop.at(-1);
    assert(resumed.deadlineAt - resumed.at >= held.candidate.reviewBudgetMs - 1000,
      `hold must retain the complete review budget: ${JSON.stringify({ held, resumed })}`);
    assert.equal(f.post().phase, 'IDLE'); assert.equal(f.post().reviewStatus, 'NO_DEVIATION_FOUND');
    assert.equal(f.post().coexistence.status, wake === 'done' ? 'IDLE' : 'UNKNOWN');
    if (wake === 'unknown') assert.match(f.post().coexistence.message, /不推断|无法核实/u);
    await f.runtime.beforeFinalize({ sessionId: current.sessionId, runId: current.runId, lastAssistantMessage: held.candidate.text }, current);
    await within(f.runtime.waitForNativeReviews(), 'late duplicate finalize');
    assert.equal(f.witnesses.stop.length, reviewedBefore + 1);
  });
}

async function dispatcherFixture(t, callbacks = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-combination-scheduler-')));
  const managers = [], sent = [], errors = [];
  const identity = { agentId: 'main', sessionKey: 'agent:main:persisted', sessionId: 'persisted', projectRoot: root,
    scopeFingerprint: 'scope', scopeTaskId: 'activation', controlRevision: 0 };
  const create = overrides => {
    const manager = createPostRunDispatcher({ directoryFor: () => root, defaultDirectory: root, validate: async () => true,
      waitTerminal: async (_record, runId) => runId.startsWith('rc-user-') ? null : { runId, status: 'ok' },
      review: async () => ({ reviewStatus: 'PASS' }),
      sendUser: async (_record, task) => { sent.push(task); return { runId: task.runId }; },
      onError: error => errors.push(error), ...callbacks, ...overrides });
    managers.push(manager); return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, identity, create, sent, errors };
}

test('scheduler restart preserves held original candidate and FIFO, then never replays an uncertain submitted intent', async t => {
  let running = true, reviews = 0;
  const f = await dispatcherFixture(t, { beforeReview: async () => ({ hold: running,
    coexistence: { status: running ? 'RUNNING' : 'IDLE', reason: 'SCRIPTED_STATUS', updatedAt: Date.now() } }),
    review: async () => { reviews++; return { reviewStatus: 'PASS' }; } });
  const first = f.create(); await first.started(f.identity, 'original-business', undefined, false);
  const a = await first.defer(f.identity, { sourceId: 'user-a', text: 'First queued task' });
  const b = await first.defer(f.identity, { sourceId: 'user-b', text: 'Second queued task' });
  await first.candidate(f.identity, { runId: 'original-business', text: 'Original candidate', reviewBudgetMs: 10000 });
  await first.drain(); assert.equal(first.snapshot(f.identity).phase, 'COEXIST_WAIT');
  await first.dispose();
  const second = f.create(); await second.load(); await second.drain();
  assert.equal(second.snapshot(f.identity).phase, 'COEXIST_WAIT'); assert.equal(reviews, 0); assert.equal(f.sent.length, 0);
  assert.deepEqual(second.snapshot(f.identity).pending.map(item => item.id), [a.id, b.id]);
  running = false; const held = second.snapshot(f.identity);
  await second.recheck(f.identity, { actor: 'fixture-owner', runId: held.runId, version: held.version }); await second.drain();
  assert.equal(reviews, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, a.id);
  const submitted = second.snapshot(f.identity); assert.equal(submitted.phase, 'USER_DISPATCHING');
  assert.deepEqual(submitted.pending.map(item => item.id), [b.id]);
  await second.dispose();
  const third = f.create(); await third.load(); await third.drain();
  assert.equal(f.sent.length, 1, 'persisted uncertain send must not replay');
  const recovered = third.snapshot(f.identity);
  assert.equal(recovered.runId, submitted.runId); assert.equal(recovered.phase, 'USER_DISPATCHING');
  assert.deepEqual(recovered.pending.map(item => item.id), [b.id]);
  assert.notEqual(recovered.history.find(item => item.id === a.id).status, 'FINISHED');
  assert.equal(reviews, 1); assert.deepEqual(f.errors, []);
});

test('audited cancellation releases only its owner; a late old review cannot complete the next queued run', async t => {
  const reviewing = deferred(), late = deferred();
  const f = await dispatcherFixture(t, { review: async () => { reviewing.resolve(); return late.promise; } });
  const manager = f.create(); await manager.started(f.identity, 'cancel-owner', undefined, false);
  const next = await manager.defer(f.identity, { sourceId: 'next', text: 'The next independent task' });
  await manager.candidate(f.identity, { runId: 'cancel-owner', text: 'Old final candidate', reviewBudgetMs: 10000 });
  await within(reviewing.promise, 'old review starts');
  const old = manager.snapshot(f.identity);
  assert.equal(old.phase, 'REVIEWING');
  await manager.confirmCancel(f.identity, { actor: 'fixture-owner', runId: old.runId, version: old.version });
  await eventually(() => f.sent.length === 1, 'cancel must dispatch the pending task once');
  const replacement = manager.snapshot(f.identity);
  assert.equal(replacement.phase, 'USER_DISPATCHING'); assert.equal(replacement.dispatching.id, next.id);
  assert.notEqual(replacement.runId, old.runId);
  late.resolve({ reviewStatus: 'PASS', reviewSummary: { marker: 'late-old-owner' } }); await manager.drain();
  const settled = manager.snapshot(f.identity);
  assert.equal(settled.phase, 'USER_DISPATCHING'); assert.equal(settled.runId, replacement.runId);
  assert.notEqual(settled.reviewSummary?.marker, 'late-old-owner'); assert.equal(f.sent.length, 1);
  assert.notEqual(settled.history.find(item => item.id === next.id).status, 'FINISHED');
  await manager.dispose(); const recovered = f.create(); await recovered.load(); await recovered.drain();
  assert.equal(recovered.snapshot(f.identity).runId, replacement.runId); assert.equal(f.sent.length, 1);
});
