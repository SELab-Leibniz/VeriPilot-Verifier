// Original-basis authority tiers. User messages, project instructions and
// user-named files are the mandatory basis; material roots are optional
// references whose drift is reported. Scripted reviewers exercise transport
// and receipt binding only, never model accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMaterialBasis, readMaterialBasis, invalidateMaterialBasis, fixedMaterialRoots } from '../lib/openclaw/material-basis.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { createOpenClawRuntime } from '../lib/openclaw/runtime.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { buildOriginalRequirements, writeOriginalRequirementSources, MANDATORY_REFERENCE_BYTES } from '../lib/runtime-v2/original-requirements.mjs';
import { runWorkspaceStopReview } from '../lib/runtime-v2/stop-workspace-review.mjs';
import { ensureTask, findTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';

const marker = (root, taskId) => path.join(root, '.runtime-correction/openclaw/material-basis', `${sha256(taskId)}.unverified.json`);
const exists = file => fs.access(file).then(() => true, () => false);
const slashes = value => value.replaceAll('\\', '/');
const noDrift = { modified: [], added: [], deleted: [] };

async function project(t, files = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-authority-'))), root = path.join(base, 'project');
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await fs.mkdir(root);
  await writeFiles(root, files);
  const task = await ensureTask({ projectRoot: root, sessionId: 'session' });
  return { base, root, task };
}

async function writeFiles(root, files) {
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
}

const readJsonParts = async files => JSON.parse((await Promise.all(files.map(file => fs.readFile(file, 'utf8')))).join(''));

// Drives the real workspace Stop review tools in-process, like
// scriptedWorkspaceReview, with a script that owns the original checklist.
function scriptedOriginalStop(input, script) {
  const signal = input.abortSignal ?? new AbortController().signal;
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + (input.reviewer?.timeoutMs ?? 20000));
  const session = { signal, deadlineAt, sessionId: randomUUID(), active() { signal.throwIfAborted(); },
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
        let offset = 1, citeId;
        do { const result = await call('source_read', { path: file, offset }); offset = result.details.page.nextOffset; citeId = result.details.citation.citeId; }
        while (offset !== null);
        return citeId;
      };
      const metrics = tools.get('set_original_checklist').parameters.properties.items.items.properties.metricId.enum;
      await script({ task: JSON.parse(worker.prompt).task, prompt: worker.systemPrompt, call, read, metricId: metrics.includes('M16') ? 'M16' : metrics[0] });
    } };
  return runWorkspaceStopReview(input, { session });
}

test('reference materials report drift instead of failing and keep their captured roots and originals', async t => {
  const { root, task } = await project(t, { 'docs/a.md': '# Alpha\nKeep alpha.\n', 'docs/b.md': '# Beta\nKeep beta.\n' });
  const docs = path.join(root, 'docs'), options = { projectRoot: root, taskId: task.taskId, roots: [docs], authority: 'reference' };
  const basis = await prepareMaterialBasis(options);
  assert.deepEqual([basis.status, basis.authority], ['CAPTURED', 'reference']);
  assert.deepEqual(await basis.assert(), noDrift);
  await fs.writeFile(path.join(docs, 'a.md'), '# Alpha\nDrop alpha.\n');
  await fs.rm(path.join(docs, 'b.md'));
  await fs.writeFile(path.join(docs, 'c.md'), '# Gamma\n');
  const drift = { modified: [path.join(docs, 'a.md')], added: [path.join(docs, 'c.md')], deleted: [path.join(docs, 'b.md')] };
  assert.deepEqual(await basis.assert(), drift);
  assert.deepEqual(await basis.current(), drift, 'drift keeps the evidence guard current');
  await basis.validateCitations([{ path: path.join(docs, 'a.md'), contentHash: 'a-later-edit' }]);
  await invalidateMaterialBasis({ projectRoot: root, taskId: task.taskId, reason: 'MATERIAL_BASIS_HOOK_UNAVAILABLE' });
  assert.equal(await exists(marker(root, task.taskId)), false);
  const saved = await readMaterialBasis(root, task.taskId);
  assert.deepEqual([saved.status, saved.authority, saved.files], ['CAPTURED', 'reference', 2]);
  assert.equal((await basis.readOriginalMaterial(path.join(docs, 'a.md'))).toString('utf8'), '# Alpha\nKeep alpha.\n');
  assert.deepEqual((await basis.referenceMaterials()).map(row => [path.basename(row.path), row.status, row.original?.toString('utf8') ?? null]), [
    ['a.md', 'MODIFIED', '# Alpha\nKeep alpha.\n'], ['b.md', 'DELETED', '# Beta\nKeep beta.\n'], ['c.md', 'ADDED', null]]);
  const later = await prepareMaterialBasis({ ...options, roots: [path.join(docs, 'c.md')], mode: 'verify' });
  assert.deepEqual(later.roots, [docs], 'a later hook cannot replace the captured root list');
  assert.deepEqual(await fixedMaterialRoots(root, task.taskId), [docs]);
  assert.deepEqual((await later.materialManifest([path.join(docs, 'c.md')])).entries.map(entry => entry.path), ['a.md', 'b.md']);
});

test('(d) a reference capture failure degrades without the permanent marker and never blocks later hooks', async t => {
  for (const scenario of ['bytes', 'files', 'missing', 'deadline', 'cancel']) await t.test(scenario, async t => {
    const { root, task } = await project(t, { 'requirements.md': '# Requirements\nKeep the gate.\n', 'second.md': 'Second.\n' });
    const file = path.join(root, 'requirements.md'), limits = {};
    const options = { projectRoot: root, taskId: task.taskId, roots: [file], authority: 'reference', limits };
    if (scenario === 'bytes') limits.bytes = 4;
    if (scenario === 'files') { options.roots = [root]; limits.files = 1; }
    if (scenario === 'missing') await fs.rm(file);
    if (scenario === 'deadline') options.deadlineAt = Date.now() - 1;
    if (scenario === 'cancel') { const controller = new AbortController(); controller.abort(); options.signal = controller.signal; }
    const basis = await prepareMaterialBasis(options);
    assert.equal(basis.status, 'DEGRADED');
    assert.match(basis.reason, /^MATERIAL_BASIS_/u);
    assert.equal((await readMaterialBasis(root, task.taskId)).status, 'DEGRADED');
    assert.deepEqual(await basis.assert(), noDrift);
    assert.equal(await basis.readOriginalMaterial(file), null);
    const later = await prepareMaterialBasis({ ...options, signal: undefined, deadlineAt: undefined, limits: {}, mode: 'verify' });
    assert.equal(later.status, 'DEGRADED');
    const rows = await later.referenceMaterials();
    assert.equal(rows.length, { files: 2, missing: 0 }[scenario] ?? 1);
    assert(rows.every(row => row.status === 'UNTRACKED' && !row.original));
    assert.equal(await exists(marker(root, task.taskId)), false);
  });
});

test('(e) strict authority still writes the permanent marker when a material changes', async t => {
  const { root, task } = await project(t, { 'requirements.md': '# Requirements\nKeep the gate.\n' });
  const file = path.join(root, 'requirements.md'), options = { projectRoot: root, taskId: task.taskId, roots: [file] };
  const basis = await prepareMaterialBasis(options);
  assert.equal(basis.authority, 'strict');
  assert.equal(basis.referenceMaterials, undefined);
  await fs.writeFile(file, '# Requirements\nDrop the gate.\n');
  await assert.rejects(basis.assert(), { code: 'MATERIAL_BASIS_CHANGED' });
  assert.equal(JSON.parse(await fs.readFile(marker(root, task.taskId), 'utf8')).reason, 'MATERIAL_BASIS_CHANGED');
  assert.equal(await fixedMaterialRoots(root, task.taskId), null);
  await assert.rejects(prepareMaterialBasis({ ...options, mode: 'verify' }), { code: 'MATERIAL_BASIS_CHANGED' });
});

test('(b) a docs file created mid-task changes neither the fixed roots nor the plan, and raises no SCOPE_CHANGED', async t => {
  const { root, task } = await project(t, { 'docs/module-design.md': '# Module design\nCheck permissions first.\n' });
  await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(root, '.runtime-corrector'), { recursive: true });
  const roots = (await loadConfig({ cwd: root })).runtimeV2.dynamicGroundTruth.materialRoots;
  assert.deepEqual(roots, [path.join(root, 'docs', 'module-design.md')]);
  await prepareMaterialBasis({ projectRoot: root, taskId: task.taskId, roots, authority: 'reference' });
  await fs.writeFile(path.join(root, 'docs/new-notes.md'), '# New notes\n');
  const rediscovered = (await loadConfig({ cwd: root })).runtimeV2.dynamicGroundTruth.materialRoots;
  assert.equal(rediscovered.length, 2);
  const later = await prepareMaterialBasis({ projectRoot: root, taskId: task.taskId, roots: rediscovered, mode: 'verify', authority: 'reference' });
  assert.deepEqual(await later.assert(), noDrift);
  assert.equal((await readMaterialBasis(root, task.taskId)).status, 'CAPTURED');
  const fixed = await fixedMaterialRoots(root, task.taskId);
  assert.deepEqual(fixed, roots);
  const plan = await loadConfig({ cwd: root, derivedMaterialRoots: fixed });
  assert.deepEqual(plan.runtimeV2.dynamicGroundTruth.materialRoots, roots);
  assert.deepEqual(plan.runtimeV2.derivation.materialRoots, ['docs/module-design.md']);
  assert.equal(await exists(marker(root, task.taskId)), false);
});

test('document review and Stop share one detector for user-named files, bounded in count and mandatory size', async t => {
  const { base, root } = await project(t, { 'notes/input.md': 'Preserve the input type.\n', 'src/app.ts': 'export {};\n',
    'big.md': `# Big\n${'B'.repeat(MANDATORY_REFERENCE_BYTES)}\n`, '.env.md': 'TOKEN=placeholder\n',
    ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`r/${index + 1}.md`, `Rule ${index + 1}.\n`])) });
  const external = path.join(base, 'external.md');
  await writeFiles(base, { 'external.md': 'Accept numbers only.\n', 'escape.md': 'Outside by a relative path.\n' });
  const entries = [
    { type: 'user', uuid: 'u1', message: { content: `Follow notes/input.md, ${external}, ../escape.md, src/app.ts, .env.md and big.md.` } },
    { type: 'user', uuid: 'u2', message: { content: `Apply ${Array.from({ length: 20 }, (_, index) => `r/${index + 1}.md`).join(' ')} and notes/input.md.` } },
  ];
  const document = await buildOriginalRequirements({ projectRoot: root, snapshot: { entries }, hostAdapter: { instructionFileNames: [] } });
  const stop = await loadStopOriginalRequirements({ projectRoot: root, snapshot: { entries } });
  for (const basis of [document, stop]) {
    assert.equal(basis.referencedFiles.length, 20);
    assert.equal(basis.referencesOmitted, 3);
    assert.deepEqual(basis.referencedFiles.slice(0, 4).map(file => [file.path, file.mandatory ?? true, file.referencedBy]),
      [['notes/input.md', true, [1, 2]], [slashes(external), true, [1]], ['big.md', false, [1]], ['r/1.md', true, [2]]]);
    assert.match(basis.referencedFiles[2].note, /mandatory reference budget/u);
  }
});

test('(c) the Stop mandatory basis is user messages, instructions and named files; materials are listed references with frozen originals', async t => {
  const f = await stopProtocolFixture(t, 'findings');
  await fs.unlink(f.input.request.groundTruthPath);
  const notes = '# Design notes\nCompare without mutation.\n';
  await writeFiles(f.root, { 'AGENTS.md': 'Use explicit error handling.\n', 'notes/input.md': 'Preserve the input type.\n',
    'docs/design-notes.md': notes, 'docs/glossary.md': '# Glossary\nA value is a number.\n', 'app.mjs': 'export const compare = (a, b) => a === b;\n' });
  const docs = path.join(f.root, 'docs');
  const basis = await prepareMaterialBasis({ projectRoot: f.root, taskId: f.task.taskId, roots: [docs], authority: 'reference' });
  await fs.writeFile(path.join(docs, 'design-notes.md'), '# Design notes\nMutate the inputs.\n');
  const transcript = path.join(f.root, 'session.jsonl');
  await fs.writeFile(transcript, [{ type: 'user', uuid: 'user-original', message: { content: 'Implement compare in app.mjs following notes/input.md.\nReturn false for differing values.' } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false, materialRoots: [docs] },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  let seen, failure;
  const reviewerFactory = input => {
    Object.assign(f.input, input);
    return f.run(async ({ brief, readAll, read, submit }) => {
      try {
        const names = brief.task.basisFiles.map(file => slashes(path.relative(f.root, file)));
        assert(names.some(name => /\/basis\/user-original-0-0000\.txt$/u.test(name)), names.join('\n'));
        assert(names.includes('AGENTS.md') && names.includes('notes/input.md'), names.join('\n'));
        assert(!names.some(name => name.startsWith('docs/') || name.includes('reference-originals')), names.join('\n'));
        await readAll();
        const json = await readJsonParts(brief.task.basisFiles.filter(file => path.basename(file).startsWith('original-basis-')));
        assert(!json.sources.some(source => source.ref.startsWith('docs/')));
        assert(!Object.hasOwn(json, 'referenceMaterials'));
        for (const file of brief.task.referenceBasisFiles) await read(file);
        const { referenceMaterials: [design, glossary] } = await readJsonParts(brief.task.referenceBasisFiles);
        assert.deepEqual([design.path, design.status, design.title, design.sha256, design.bytes],
          ['docs/design-notes.md', 'MODIFIED', 'Design notes', sha256(notes), Buffer.byteLength(notes)]);
        assert.equal(await fs.readFile(design.frozenOriginal, 'utf8'), notes);
        assert.deepEqual([glossary.path, glossary.status, glossary.frozenOriginal], ['docs/glossary.md', 'UNCHANGED', undefined]);
        let mandatoryBytes = 0;
        for (const file of brief.task.basisFiles) mandatoryBytes += (await fs.stat(file)).size;
        assert.deepEqual(brief.task.basisBudget, { mandatoryFiles: brief.task.basisFiles.length, mandatoryBytes,
          referenceFiles: 2, referenceBytes: Buffer.byteLength(notes) + glossary.bytes });
        // Only the frozen reference is read; the unread optional glossary must not block the checklist.
        const citeId = (await read(design.frozenOriginal)).details.citation.citeId;
        await submit('set_original_checklist', { items: [{ metricId: 'M16', text: 'Compare without mutation.',
          verificationTarget: 'IMPLEMENTATION', citeId, lineStart: 2, lineEnd: 2 }] });
        seen = (await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true })).items;
        await submit('finish_stop_review', { summary: 'No deviation was found.' });
      } catch (error) { failure = error; throw error; }
    });
  };
  reviewerFactory.materialManifest = basis.materialManifest;
  reviewerFactory.referenceMaterials = basis.referenceMaterials;
  const event = (name, extra = {}) => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'authority-stop', startProtocol: { version: 1 } }, input: { session_id: 'protocol-host',
      cwd: f.root, transcript_path: transcript, hook_event_name: name, last_assistant_message: 'Task complete.', ...extra } });
  await event('SessionStart', { source: 'startup' });
  const result = await event('Stop');
  if (failure) throw failure;
  assert.equal(result.stop.status, 'NO_DEVIATION_FOUND', JSON.stringify(result.stop));
  assert.deepEqual(seen.map(item => item.originalSource), [{ kind: 'MATERIAL', ref: 'docs/design-notes.md', sha256: sha256(notes), start: 2, end: 2 }]);
  const [review] = await fs.readdir(path.join(f.root, '.runtime-correction/tasks', f.task.taskId, 'workspace-reviews'));
  const budget = JSON.parse(await fs.readFile(path.join(f.root, '.runtime-correction/tasks', f.task.taskId, 'workspace-reviews', review, 'basis-budget.json'), 'utf8'));
  assert.equal(budget.referenceFiles, 2);
});

test('the document request lists reference materials with their status and writes readable frozen originals', async t => {
  const { root, task } = await project(t, { 'docs/spec.md': '# Spec\nKeep imports offline.\n', 'docs/extra.md': '# Extra\n' });
  const basis = await prepareMaterialBasis({ projectRoot: root, taskId: task.taskId, roots: [path.join(root, 'docs/spec.md'), path.join(root, 'docs/extra.md')],
    authority: 'reference' });
  await fs.writeFile(path.join(root, 'docs/spec.md'), '# Spec\nUpload imports.\n');
  await fs.rm(path.join(root, 'docs/extra.md'));
  const entries = [{ type: 'user', uuid: 'u1', message: { content: 'Write the design.' } }];
  const requirements = await buildOriginalRequirements({ projectRoot: root, snapshot: { entries }, hostAdapter: { instructionFileNames: [] },
    referenceTier: true, readReferenceMaterials: basis.referenceMaterials });
  assert.equal(requirements.materialTier, 'reference');
  assert.deepEqual(requirements.materials.map(file => [file.path, file.status, file.title]), [['docs/extra.md', 'DELETED', 'Extra'], ['docs/spec.md', 'MODIFIED', 'Spec']]);
  const written = await writeOriginalRequirementSources(path.join(root, '.runtime-correction/.semantic-review/round'), requirements);
  assert.deepEqual(await Promise.all(written.materials.map(file => fs.readFile(file.frozenOriginal, 'utf8'))), ['# Extra\n', '# Spec\nKeep imports offline.\n']);
  assert(written.materials.every(file => file.originalBase64 === undefined));
});

test('Proposal findings and the persisted Stop checklist join one original span across paging and paraphrase', async t => {
  const proposal = 'openspec/changes/sort-order/proposal.md';
  const { root, task } = await project(t, { [proposal]: '# Proposal\nReset the saved sort order.\n' });
  t.after(() => releaseDocumentSessions(root));
  const prefix = 'Context\n'.repeat(2048);
  const selected = '恢复已保存的排序 🧪。\r';
  const original = `${prefix}${selected}\n${'Further context.\n'.repeat(750)}`;
  const ref = 'transcript:original-sort-order';
  const snapshot = { entries: [
    { type: 'user', uuid: 'original-sort-order', message: { content: original } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } },
  ] };
  const documentOriginals = await buildOriginalRequirements({ projectRoot: root, sessionId: 'session', snapshot });
  const requestRoot = path.join(root, '.runtime-correction', '.semantic-review', 'proposal');
  const requestPath = path.join(requestRoot, 'request.json');
  const semantic = { projectRoot: root, stage: 'proposal', artifactFiles: [proposal],
    originalRequirements: await writeOriginalRequirementSources(requestRoot, documentOriginals) };
  assert(!Object.hasOwn(semantic.originalRequirements.userMessages[0], 'text'), 'the original is delivered through the archived file');
  await fs.writeFile(requestPath, JSON.stringify(semantic));

  let documentAnchor;
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } }, logger: { warn() {} },
    runtime: { version: '2026.7.1-2', agent: { async runEmbeddedAgent(params) {
      const { tools } = globalThis[Symbol.for('runtime-corrector.document-tools.v1')].get(params.sessionId);
      const current = await tools.execute({ action: 'read', path: proposal, start: 2, count: 1 });
      assert.deepEqual(current.lines, ['2: Reset the saved sort order.']);
      const evidence = await tools.execute({ action: 'read_original', ref, start: 2049, count: 1 });
      assert.equal(evidence.text, selected);
      documentAnchor = evidence.anchor;
      const result = { summary: 'Review the proposal.', edits: [], findings: [{ ruleId: 'AGENT-SORT-ORDER', severity: 'error',
        path: proposal, line: 2, message: 'The proposal discards the user’s prior preference.',
        evidence: [`${proposal}:2 "Reset the saved sort order."`], originalSourceAnchorId: documentAnchor.anchorId }] };
      return { payloads: [{ text: JSON.stringify(result) }], meta: {} };
    } } },
  };
  const artifact = await createOpenClawReviewerFactory(api)({ projectRoot: root, taskId: task.taskId,
    role: 'artifact-reviewer', pluginRoot: path.resolve('.'), reviewer: { session: 'detached', timeoutMs: 5000 },
    schema: REVIEW_SCHEMA, request: { semanticReviewRequestPath: requestPath }, evidence: { snapshot, semanticRequest: semantic } });
  await artifact.close();
  assert.equal(artifact.result.findings[0].originalSourceAnchorId, documentAnchor.anchorId);
  assert.deepEqual(documentAnchor, { anchorId: documentAnchor.anchorId, kind: 'USER_MESSAGE', ref, sha256: sha256(original),
    byteStart: Buffer.byteLength(prefix), byteEnd: Buffer.byteLength(prefix + selected) });

  const stopOriginals = await loadStopOriginalRequirements({ projectRoot: root, sessionId: 'session', snapshot });
  const paraphrase = 'Apply the previously saved sorting preference.';
  let reviewDirectory;
  const stop = await scriptedOriginalStop({ projectRoot: root, taskId: task.taskId,
    request: { hook: { last_assistant_message: 'Task complete.' }, workflowStages: ['proposal', 'implementation'],
      population: { taskId: task.taskId, groundTruthVersion: 0, metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } },
    evidence: { snapshot, originalRequirements: stopOriginals, groundTruth: { taskId: task.taskId, version: 0, claims: [] } },
    onPrepared: ({ requestDirectory }) => { reviewDirectory = requestDirectory; },
  }, async ({ task: brief, read, call }) => {
    for (const file of brief.basisFiles) await read(file);
    const secondPart = brief.basisFiles.find(file => path.basename(file) === 'user-original-0-0001.txt');
    assert(secondPart, 'Stop delivers the selected source after a part boundary');
    const { details: { citation: { citeId } } } = await call('source_read', { path: secondPart, offset: 1 });
    const checklist = await call('set_original_checklist', { items: [{ metricId: 'M16', text: paraphrase,
      verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', citeId, lineStart: 1, lineEnd: 1 }],
    scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
    const page = JSON.parse(checklist.content[0].text);
    assert.deepEqual(page.items[0].originalSourceAnchor, documentAnchor);
    await call('finish_stop_review', { summary: 'Checklist captured for the current task.' });
  });
  await stop.close();
  const persisted = JSON.parse(await fs.readFile(path.join(reviewDirectory, 'original-checklist.json'), 'utf8'));
  const [object] = persisted.population.metrics.M16;
  const [claim] = persisted.groundTruth.claims;
  assert.deepEqual(object.originalSourceAnchor, documentAnchor);
  assert.deepEqual(claim.originalSourceAnchor, documentAnchor);
  assert.equal(object.originalSource.part, 2);
  assert.equal(object.description, paraphrase);
  assert.equal(object.sourceId, claim.claimId);
});

test('(a) default template: a business edit of a discovered material keeps document review and Stop running with its frozen original', async t => {
  const original = '# 模块设计\nPermission checks run before every export.\n', edited = '# 模块设计\nExports skip the permission check.\n';
  const proposal = 'openspec/changes/export/proposal.md';
  const delta = 'openspec/changes/export/specs/reporting/export/spec.md';
  const { root, task } = await project(t, { 'docs/module-design.md': original, 'AGENTS.md': 'Keep exports audited.\n',
    'notes/input.md': 'Exports use CSV.\n', 'app.py': 'def export(rows): return rows\n' });
  await fs.cp(new URL('../.runtime-corrector-default/', import.meta.url), path.join(root, '.runtime-corrector'), { recursive: true });
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.correctionBarrier.turnActivated = true; });
  const transcript = path.join(root, 'host.jsonl');
  await fs.writeFile(transcript, [{ type: 'session', id: 'session' },
    { type: 'message', id: 'human', parentId: null, message: { role: 'user', content: 'Write openspec/changes/export/proposal.md for the CSV export and follow notes/input.md.' } },
    { type: 'message', id: 'answer', parentId: 'human', message: { role: 'assistant', content: 'The proposal is written.' } }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const documents = [], warnings = [];
  let stop;
  const factory = async input => {
    if (input.role === 'artifact-reviewer') {
      const semantic = JSON.parse(await fs.readFile(input.request.semanticReviewRequestPath, 'utf8'));
      documents.push({ semantic, frozen: await Promise.all(semantic.originalRequirements.materials.map(file => file.frozenOriginal && fs.readFile(file.frozenOriginal, 'utf8'))) });
      const wrongFormat = semantic.workflow.targetFiles.includes(delta) && (await fs.readFile(path.join(root, delta), 'utf8')).includes('JSON');
      const findings = wrongFormat ? [{ ruleId: 'AGENT-EXPORT-FORMAT', severity: 'error', path: delta, line: 2,
        message: 'The proposed output format conflicts with the requested CSV export.',
        evidence: ['notes/input.md:1', `${delta}:2`] }] : [];
      return { result: { summary: 'Scripted document review.', edits: [], findings }, sessionId: randomUUID(), close: async () => {} };
    }
    assert.equal(input.request.reviewScope.kind, 'workspace-stop');
    return scriptedOriginalStop(input, async ({ task: brief, read, call, metricId, prompt }) => {
      for (const file of brief.basisFiles) await read(file);
      for (const file of brief.referenceBasisFiles) await read(file);
      const { referenceMaterials } = await readJsonParts(brief.referenceBasisFiles);
      const design = referenceMaterials.find(file => file.path === 'docs/module-design.md');
      stop = { names: brief.basisFiles.map(file => slashes(path.relative(root, file))), design, budget: brief.basisBudget, prompt,
        frozen: await fs.readFile(design.frozenOriginal, 'utf8') };
      const citeId = await read(design.frozenOriginal);
      await call('set_original_checklist', { items: [{ metricId, text: 'Permission checks run before every export.',
        verificationTarget: 'IMPLEMENTATION', citeId, lineStart: 2, lineEnd: 2 }] });
      await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true, requiredUserInput: null, externalBlocker: null });
      await call('finish_stop_review', { summary: 'No deviation was found.' });
    });
  };
  const api = { id: 'runtime-corrector', config: {}, pluginConfig: {}, logger: { warn: text => warnings.push(text), info() {} }, runtime: {
    state: { resolveStateDir: () => path.join(root, 'host-state') },
    agent: { session: { getSessionEntry: async () => ({ sessionId: 'session', sessionFile: transcript }),
      resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
      runWithWorkAdmission: async (params, run) => run(params.signal) } } } };
  const runtime = createOpenClawRuntime(api, { pluginRoot: path.resolve('.'), reviewerFactory: factory, nativeHooks: true, sharedState: {},
    projectScopes: admittedProjectScopes(api), compatibility: async () => ({ emitAgentEvent() {}, markDiagnosticSessionProgress() {} }),
    postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  t.after(async () => { await runtime.dispose(); await runtime.waitForBackgroundReviews(); });
  const ctx = { agentId: 'main', sessionId: 'session', sessionKey: 'agent:main:authority', workspaceDir: root, runId: 'business-run' };
  const tool = async (toolName, toolCallId, args, change) => {
    await runtime.beforeTool({ toolName, toolCallId, params: args }, ctx);
    await change?.();
    return runtime.toolResult({ toolName, toolCallId, args, result: { content: [{ type: 'text', text: 'done' }], details: { status: 'completed' } } }, ctx);
  };
  const write = (toolCallId, name, content) => tool('write', toolCallId, { path: name, content }, () => writeFiles(root, { [name]: content }));
  await runtime.sessionStart({ sessionId: 'session' }, ctx);
  await tool('read', 'read-design', { path: 'docs/module-design.md' });
  const captured = await readMaterialBasis(root, task.taskId);
  assert.deepEqual([captured?.status, captured?.authority, captured?.files], ['CAPTURED', 'reference', 1], JSON.stringify({ captured, warnings }));
  await write('edit-design', 'docs/module-design.md', edited);
  await write('new-notes', 'docs/new-notes.md', '# New notes\n');
  const reviewed = await write('proposal', proposal, '# Proposal\nExport rows as CSV.\n');
  assert.equal(documents.length, 1, JSON.stringify({ reviewed, warnings }));
  const [{ semantic, frozen }] = documents;
  assert.equal(semantic.originalRequirements.materialTier, 'reference');
  assert.deepEqual(semantic.originalRequirements.materials.map(file => [file.path, file.status, file.title]), [['docs/module-design.md', 'MODIFIED', '模块设计']]);
  assert.deepEqual(frozen, [original]);
  assert.deepEqual(semantic.originalRequirements.referencedFiles.map(file => file.path), ['notes/input.md']);
  const rejected = await write('delta-draft', delta, '# Export behavior\nExport rows as JSON.\n');
  assert.match(JSON.stringify(rejected), /AGENT-EXPORT-FORMAT/u);
  const corrected = await write('delta-corrected', delta, '# Export behavior\nExport rows as CSV.\n');
  assert.doesNotMatch(JSON.stringify(corrected), /AGENT-EXPORT-FORMAT/u);
  assert.equal(documents.length, 3);
  for (const { semantic } of documents.slice(1)) {
    assert.deepEqual(semantic.workflow.targetFiles, [delta]);
    assert.deepEqual(semantic.workflow.incomingEdges[0].sourceFiles, [proposal]);
    assert.deepEqual(semantic.originalRequirements.referencedFiles.map(file => file.path), ['notes/input.md']);
  }
  await runtime.reply({ kind: 'final', sessionKey: ctx.sessionKey, runId: ctx.runId, payload: { text: 'The proposal is written.' } }, ctx);
  const [record] = await runtime.waitForNativeReviews({ drain: true });
  assert(stop, JSON.stringify({ record, warnings }));
  assert.equal(record.reviewStatus, 'NO_DEVIATION_FOUND', JSON.stringify({ record, warnings }));
  assert(stop.names.includes('AGENTS.md') && stop.names.includes('notes/input.md'), stop.names.join('\n'));
  assert(!stop.names.some(name => name.startsWith('docs/') || name.includes('reference-originals')), stop.names.join('\n'));
  assert.deepEqual([stop.design.status, stop.design.title, stop.design.sha256], ['MODIFIED', '模块设计', sha256(original)]);
  assert.equal(stop.frozen, original);
  assert.equal(stop.budget.referenceFiles, 1);
  assert.match(stop.prompt, /When an obligation needs optional context, read task\.referenceBasisFiles/u);
  const current = await findTask({ projectRoot: root, sessionId: 'session' });
  assert.equal(current.materialBasis, undefined);
  assert.doesNotMatch(JSON.stringify({ verification: current.verification, warnings }), /MATERIAL_BASIS/u);
  assert.equal(await exists(marker(root, task.taskId)), false);
  assert.deepEqual(await fixedMaterialRoots(root, task.taskId), [path.join(root, 'docs', 'module-design.md')]);
});
