import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateProjectConfig } from '../lib/policy/config-loader.mjs';
import { createStopCorrectionStore } from '../lib/runtime-v2/stop-correction-store.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { buildMetricPopulation, buildOriginalStopPopulation } from '../lib/runtime-v2/metrics.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { loadStopOriginalRequirements, stopFeedbackCurrent } from '../lib/runtime-v2/production-stop.mjs';
import { userMessageLogPath } from '../lib/runtime-v2/original-requirements.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { recordDeviationFindings } from '../lib/runtime-v2/deviations.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';

test('M16 cannot admit a support duty while workflow metrics are disabled', () => {
  const population = { taskId: 'scope', groundTruthVersion: 0, metrics: { M08: [] },
    reviewPolicy: { metrics: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`M${String(i + 1).padStart(2, '0')}`, i === 15])) } };
  const source = { kind: 'PROJECT_FILE', ref: 'AGENTS.md', sha256: 'frozen', start: 1, end: 2 };
  const item = { metricId: 'M16', text: 'Update the module design before editing code.', source,
    verificationTarget: 'IMPLEMENTATION', implementationRole: 'SUPPORT' };
  const build = value => buildOriginalStopPopulation({ population, checklist: [value], sourceDigest: 'original' });
  assert.throws(() => build(item), error => error.code === 'STOP_ORIGINAL_CHECKLIST_INVALID');
  assert.throws(() => build({ ...item, implementationRole: 'TEST' }), /production implementation obligation/);
  assert.throws(() => build({ ...item, metricId: 'M11', verificationTarget: 'PROCESS' }), /Cannot add/);
  const production = { ...item, text: 'The production handler validates its input.', implementationRole: 'PRODUCTION' };
  assert.equal(build(production).population.metrics.M16.length, 1);
  const { implementationRole, ...legacy } = production;
  assert.equal(build(legacy).population.metrics.M16.length, 1, 'an omitted legacy role retains its default');
});

test('explicitly disabling the original basis preserves the default Stop policy', () => {
  const compile = stopCorrection => compileRuntimeV2Config({ version: 2, stopCorrection }).stopCorrection;
  assert.deepEqual(compile({ enabled: true, originalRequirementsBasis: false }), compile({ enabled: true }));
  assert.equal(compile({ enabled: true, originalRequirementsBasis: true }).originalRequirementsBasis, true);
  assert.throws(() => compile({ enabled: true, originalRequirementsBasis: 'false' }), /originalRequirementsBasis must be boolean/u);
  const noBaseline = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: false }, stopCorrection: { enabled: true } };
  assert.throws(() => validateProjectConfig(noBaseline, 'config.yaml'), /requires dynamicGroundTruth.enabled/u);
  validateProjectConfig({ ...noBaseline, stopCorrection: { enabled: true, originalRequirementsBasis: true } }, 'config.yaml');
});

for (const judgement of ['PASS', 'DEVIATION', 'UNVERIFIED']) test(`B12 explicitly rechecks the original delivered item with ${judgement}`, async t => {
  const f = await stopProtocolFixture(t, 'findings');
  const file = path.join(f.root, 'app.mjs'), transcript = path.join(f.root, 'session.jsonl');
  const requirement = 'Implement transform.\nReturn the input plus one.';
  const entries = [{ type: 'user', uuid: 'user-original', message: { content: requirement } },
    { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }];
  await fs.writeFile(transcript, entries.map(JSON.stringify).join('\n') + '\n');
  await fs.writeFile(file, `export const transform = input => ${judgement === 'PASS' ? 'input + 1' : 'input'};\n`);
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });
  const reviewer = input => {
    Object.assign(f.input, input);
    return f.run(async ({ brief, readAll, read, submit }) => {
      await readAll();
      const userPath = brief.task.basisFiles.find(p => path.basename(p).startsWith('user-original-'));
      const original = (await read(userPath)).details.citation.citeId;
      await submit('set_original_checklist', { items: [{ metricId: 'M16', text: 'Add one to the supplied value.',
        verificationTarget: 'IMPLEMENTATION', citeId: original, lineStart: 1, lineEnd: 2 }] });
      const { items } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
      const [previous, regenerated] = items;
      assert.equal(previous.objectId, object.objectId);
      assert.equal(previous.previousDeviation.reason, 'The return value was unchanged.');
      assert.notEqual(regenerated.objectId, previous.objectId);
      await assert.rejects(submit('finish_stop_review', { summary: 'No finding.' }), { code: 'REVIEW_ITEM_INCOMPLETE' });
      await assert.rejects(submit('submit_review', { taskId: regenerated.objectId, verdict: 'PASS', reason: 'Irrelevant.', citeIds: [] }),
        { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
      const current = (await read(file)).details.citation.citeId;
      await submit('submit_review', { taskId: previous.objectId, verdict: judgement, reason: 'Checked the current return expression.',
        citeIds: judgement === 'UNVERIFIED' ? [] : [current] });
      if (judgement === 'PASS') await submit('submit_review', { taskId: regenerated.objectId, verdict: 'UNVERIFIED',
        reason: 'The other requirement cannot be settled by this evidence.' });
      await submit('finish_stop_review', { summary: 'The earlier finding was reviewed.' });
    });
  };
  const event = name => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory: reviewer,
    stopHost: { directory: path.join(f.root, 'host'), stopId: 'follow-up', startProtocol: { version: 1 } },
    input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: name, last_assistant_message: 'Task complete.' } });
  await event('SessionStart');
  await createStopCorrectionStore({ directory: path.join(f.root, 'host') }).initializeSession({
    sessionId: 'protocol-host', initialize: { kind: 'NEW_SESSION', evidence: { fixture: true } },
  });
  const taskId = f.task.taskId;
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId, groundTruth: { version: 0, claims: [] }, persist: false });
  const { population: basis } = buildOriginalStopPopulation({ population, sourceDigest: 'original', checklist: [{
    metricId: 'M16', text: 'Return the input plus one.', verificationTarget: 'IMPLEMENTATION',
    source: { kind: 'USER_MESSAGE', ref: 'transcript:user-original', part: 1, sha256: sha256(requirement), start: 2, end: 2 },
  }] });
  const [object] = basis.metrics.M16, evaluationId = 'stop-0123456789abcdef';
  const [family] = await recordDeviationFindings({ projectRoot: f.root, taskId, pipeline: 'STOP', evaluationId, delivered: true,
    findings: [{ deviationKey: `metric:M16:${object.sourceId}`, severity: 'error', rootCauseId: 'REQUIREMENT_OMITTED',
      reason: 'The return value was unchanged.', violatedGroundTruthIds: [object.sourceId] }] });
  const directory = taskDirectory(f.root, taskId);
  await fs.mkdir(path.join(directory, 'evaluations'), { recursive: true });
  await fs.writeFile(path.join(directory, 'evaluations', `${evaluationId}.json`),
    JSON.stringify({ metricReport: { metrics: [{ objects: [{ ...object, judgement: 'DEVIATION' }] }] } }));
  const result = await event('Stop');
  assert.equal(result.stop.status, judgement === 'DEVIATION' ? 'DEVIATION' : 'UNVERIFIED', JSON.stringify(result.stop));
  if (judgement !== 'DEVIATION') {
    assert.equal(result.stop.reasonCode, 'STOP_MANDATORY_REQUIREMENT_UNVERIFIED');
    assert.equal(result.stop.decision, 'allow');
    assert.equal(result.stop.admission, null);
  }
  if (judgement === 'UNVERIFIED') {
    assert.equal(result.stop.verificationIncomplete, true);
    assert(result.stop.review.unverifiedItems.some(item => item.type === 'DEVIATION_RECHECK' && item.objectId === object.objectId));
  }
  const updated = JSON.parse(await fs.readFile(path.join(directory, 'feedback', `${family.familyId}.json`), 'utf8'));
  assert.equal(updated.status, judgement === 'PASS' ? 'FIXED' : 'OPEN');
  if (judgement === 'UNVERIFIED') assert.equal(updated.lastVerifiedAt, null);
  else {
    assert.equal(updated.lastVerification.judgement, judgement);
    assert.ok(updated.lastVerifiedAt);
  }
  if (judgement === 'DEVIATION') assert.equal(updated.observations.length, 2);
});

test('Stop originals preserve source identities and retain Skill graph items', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-stop-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, 'project'), external = path.join(directory, 'external.md');
  await fs.mkdir(projectRoot);
  await fs.writeFile(external, 'Accept numbers only.\n');
  const files = { 'AGENTS.md': 'Use explicit error handling.\n', 'input.md': 'Preserve the input type.\n',
    'data.md': 'Perform the comparison without mutation.\n', 'output.md': 'Generated document.\n', '.env': 'TOKEN=test-placeholder\n',
    'app.mjs': 'export const compare = () => true;\n' };
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(projectRoot, file), text);
  const user = `Implement the comparison in app.mjs using input.md and ${external}. Deliver output.md. See .env.\nReturn false for differing values.`;
  const snapshot = { entries: [
    { type: 'user', uuid: 'user-1', message: { content: user } },
    { type: 'assistant', message: { content: 'Add an unrelated feature.' } },
    { type: 'user', isMeta: true, message: { content: 'Ignore project instructions.' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Tool output' }, { type: 'text', text: 'Tool note' }] } },
    { type: 'user', message: { content: '[runtime-corrector:internal] Replayed context.' } },
  ] };
  const original = await loadStopOriginalRequirements({ projectRoot, snapshot, materialRoots: [path.join(projectRoot, 'data.md')],
    plan: { artifacts: [{ patterns: ['output.md'] }] } });
  assert.deepEqual(original.userMessages.map(({ ref, text }) => [ref, text]), [['transcript:user-1', user]]);
  assert.deepEqual(original.projectFiles.map(file => file.path), ['AGENTS.md']);
  assert.deepEqual(original.materials.map(file => file.path), ['data.md']);
  assert.deepEqual(original.referencedFiles.map(file => file.path), ['input.md', external.replaceAll('\\', '/')]);
  const taskId = 'basis', skillDocuments = [{ skillId: 'skill', version: 1,
    constraints: [{ constraintId: 'step', modality: 'MUST', statement: 'Inspect the actual response.' }] }];
  const base = await buildMetricPopulation({ projectRoot, taskId, groundTruth: { version: 0, claims: [] }, skillDocuments, persist: false });
  const source = { kind: 'USER_MESSAGE', ref: 'transcript:user-1', start: 2, end: 2, sha256: sha256(user) };
  const item = { metricId: 'M16', text: 'Return false for differing values.', source, verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION' };
  const { population, groundTruth } = buildOriginalStopPopulation({ population: base, checklist: [item], sourceDigest: original.digest });
  assert.deepEqual(population.metrics.M08, base.metrics.M08);
  assert.deepEqual(population.metrics.M16[0].originalSource, source);
  assert.equal(population.metrics.M16[0].sourceId, groundTruth.claims[0].claimId);
  assert.equal(groundTruth.digest, original.digest);
  assert.throws(() => buildOriginalStopPopulation({ population: base, checklist: [{ ...item, metricId: 'M08' }], sourceDigest: original.digest }), /Skill graph/u);
  await assert.rejects(fs.access(path.join(projectRoot, '.runtime-correction')), { code: 'ENOENT' });
});

test('Stop originals keep a user message that a host compaction removed, but never Stop feedback', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-original-stop-log-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const request = 'Implement compare(value) in app.mjs.\nReturn value plus one.';
  const load = entries => loadStopOriginalRequirements({ projectRoot, sessionId: 'compacted', snapshot: { entries } });
  const before = await load([{ type: 'user', uuid: 'user-original', message: { content: request } },
    { type: 'user', uuid: 'stop-feedback', message: { content: '[runtime-corrector:stop-feedback] compare still returns the input.' } }]);
  assert.deepEqual(before.userMessages.map(message => message.ref), ['transcript:user-original']);
  const after = await load([{ type: 'assistant', uuid: 'summary', message: { content: 'Summary: compare is in progress.' } },
    { type: 'user', uuid: 'user-continue', message: { content: 'Continue.' } }]);
  assert.deepEqual(after.userMessages.map(({ order, ref, sha256: hash, retainedAfterCompaction = false }) => [order, ref, hash, retainedAfterCompaction]),
    [[1, 'transcript:user-original', sha256(request), true], [2, 'transcript:user-continue', sha256('Continue.'), false]]);
  assert.equal(after.digest, (await load([])).digest, 'once logged, the sources no longer depend on the live transcript');
  const changed = [{ type: 'user', uuid: 'user-original', message: { content: 'Return the value unchanged.' } }];
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(load(changed), { code: 'STOP_TASK_BASIS_UNAVAILABLE' });
});

test('the native Stop basis exposes optional references on demand and preserves mandatory receipt gates', async t => {
  const journaled = 'Task complete. The implementation returns the input plus one.';
  for (const duplicate of [true, false]) await t.test(duplicate ? 'exact hook duplicate' : 'distinct hook text', async t => {
    const f = await stopProtocolFixture(t, 'findings');
    const requirement = 'Return the input plus one.';
    const hookText = duplicate ? journaled : 'Task complete. A host follow-up is available.';
    const latestAssistant = { type: 'assistant', uuid: 'completion',
      message: { id: 'completion', role: 'assistant', content: [{ type: 'text', text: journaled }] } };
    const snapshot = { entries: [{ type: 'user', uuid: 'user-original', message: { content: requirement } }, latestAssistant] };
    const app = path.join(f.root, 'app.mjs'), instructions = path.join(f.root, 'AGENTS.md');
    const reference = 'background.md', before = '# Original background\nOptional context from task start.\n';
    const after = '# Updated background\nContext edited during the task.\n';
    await Promise.all([
      fs.writeFile(app, 'export const transform = input => input + 1;\n'),
      fs.writeFile(instructions, 'Keep the implementation in app.mjs.\n'),
      fs.writeFile(path.join(f.root, reference), after),
    ]);
    const originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot, referenceTier: true,
      readReferenceMaterials: async () => [{ path: reference, status: 'MODIFIED', original: Buffer.from(before),
        bytes: Buffer.byteLength(before), sha256: sha256(before), currentBytes: Buffer.byteLength(after), currentSha256: sha256(after) }] });
    f.input.evidence = { ...f.input.evidence, snapshot, originalRequirements };
    f.input.request = { ...f.input.request, hook: { lastAssistantMessage: hookText, stopHookActive: true },
      reviewScope: { kind: 'workspace-stop' }, fixedStopClassification: null, classificationContract: 2 };

    const script = async ({ brief, read, submit }) => {
      const { basisFiles, referenceBasisFiles } = brief.task;
      assert.equal(referenceBasisFiles.length, 1);
      assert(!basisFiles.includes(referenceBasisFiles[0]));
      assert(basisFiles.includes(instructions));
      const deliveredText = result => {
        assert.equal(result.details.page.nextOffset, null);
        const [citation, ...lines] = result.content.map(block => block.text).join('').split('\n');
        assert.match(citation, /^\[citeId=/u);
        assert.match(lines.pop(), /^\[RC page /u);
        return lines.join('\n');
      };
      const parts = [];
      for (const file of basisFiles.filter(file => path.basename(file).startsWith('original-basis-'))) parts.push(deliveredText(await read(file)));
      const basis = JSON.parse(parts.join(''));
      assert.deepEqual(basis.latestAssistant, latestAssistant);
      assert.deepEqual(basis.request.hook, { stopHookActive: true, ...(duplicate ? {} : { lastAssistantMessage: hookText }) });
      assert.equal(Object.hasOwn(basis, 'referenceMaterials'), false);
      assert.deepEqual(basis.sources.map(source => source.kind), ['USER_MESSAGE', 'PROJECT_FILE']);

      // Exercise the optional read path on one run and leave the catalog
      // entirely unread on the other.
      if (!duplicate) {
        const catalog = JSON.parse(deliveredText(await read(referenceBasisFiles[0])));
        const [material] = catalog.referenceMaterials;
        assert.equal(catalog.referenceMaterials.length, 1);
        assert.equal(material.path, reference);
        assert.equal(material.status, 'MODIFIED');
        assert.equal(deliveredText(await read(material.frozenOriginal)), before);
      }

      const user = basis.sources.find(source => source.kind === 'USER_MESSAGE');
      const original = await read(user.file);
      assert.equal(deliveredText(original), requirement);
      const checklist = { items: [{ metricId: 'M16', text: requirement, verificationTarget: 'IMPLEMENTATION',
        citeId: original.details.citation.citeId, lineStart: 1, lineEnd: 1 }] };
      const finish = () => submit('finish_stop_review', { summary: 'Verified the implementation.' });
      await assert.rejects(submit('set_original_checklist', checklist), { code: 'TASK_BASIS_UNREAD' });
      await assert.rejects(finish(), { code: 'TASK_BASIS_UNREAD' });
      await read(instructions);
      await submit('set_original_checklist', checklist);
      const { items: [assigned] } = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
      assert.equal(assigned.originalSource.sha256, sha256(requirement));
      await assert.rejects(finish(), { code: 'REVIEW_ITEM_INCOMPLETE' });
      const delivered = await read(app);
      await submit('submit_review', { taskId: assigned.objectId, verdict: 'PASS', reason: 'The return expression adds one.',
        citeIds: [delivered.details.citation.citeId] });
      assert.equal((await finish()).complete, true);
    };
    let assertionFailure;
    const review = await f.run(context => script(context).catch(error => {
      assertionFailure = error;
      throw error;
    })).catch(error => { throw assertionFailure ?? error; });
    assert.equal(review.result.metricObjectJudgements[0].judgement, 'PASS');
  });
});

for (const [name, { deviationOnly = false, compacted = false }] of [
  ['one production Stop reviewer builds a receipt-bound checklist and delivers a current deviation without a ledger', {}],
  ['B12 admits a receipt-bound deviation from original requirements with the baseline disabled', { deviationOnly: true }],
  ['after a host compaction removes the request, the production Stop still builds its checklist from the session log', { compacted: true }],
]) test(name, async t => {
  const f = await stopProtocolFixture(t, 'findings');
  const ledgerPath = f.input.request.groundTruthPath;
  await fs.unlink(ledgerPath);
  const source = path.join(f.root, 'app.mjs'), transcript = path.join(f.root, 'session.jsonl');
  const requirement = 'Implement compare(value) in app.mjs.\nReturn value plus one.';
  await fs.writeFile(source, 'export const compare = value => value;\n');
  const writeTranscript = entries => fs.writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await writeTranscript([{ type: 'user', uuid: 'user-original', message: { content: requirement } },
    { type: 'assistant', uuid: compacted ? 'progress' : 'completion', message: { content: compacted ? 'Working on compare.' : 'Task complete.' } }]);
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: !deviationOnly && !compacted },
    stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly } });
  const roles = [], scope = { stopClassification: 'TASK_COMPLETE', completionClaim: true };
  let callbackFailure;
  const reviewerFactory = input => {
    roles.push(input.role);
    assert.equal(input.role, 'stop-reviewer');
    assert.equal(input.request.groundTruthPath, undefined);
    Object.assign(f.input, input);
    return f.run(async ({ brief, readAll, read, submit }) => {
      try {
        await readAll();
        await assert.rejects(submit('review_checklist', scope), { code: 'STOP_ORIGINAL_CHECKLIST_REQUIRED' });
        const userPath = brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
        const original = (await read(userPath)).details.citation.citeId, delivery = (await read(source)).details.citation.citeId;
        const item = { metricId: 'M16', text: 'Return value plus one.', verificationTarget: 'IMPLEMENTATION',
          citeId: original, lineStart: 2, lineEnd: 2 };
        for (const invalid of [{ ...item, citeId: delivery }, { ...item, lineEnd: 3 }])
          await assert.rejects(submit('set_original_checklist', { items: [invalid] }), { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
        await submit('set_original_checklist', { items: [item] });
        const { items: [assigned] } = await submit('review_checklist', scope);
        assert.deepEqual(assigned.originalSource, { kind: 'USER_MESSAGE', ref: 'transcript:user-original',
          part: 1, sha256: sha256(requirement), start: 2, end: 2 });
        await submit('submit_review', { taskId: assigned.taskId, verdict: 'DEVIATION',
          reason: 'compare returns the input without adding one.', citeIds: [delivery] });
        await submit('finish_stop_review', { summary: 'The production counterexample is confirmed.' });
      } catch (error) { callbackFailure = error; throw error; }
    });
  };
  const directory = path.join(f.root, 'host'), sessionId = 'protocol-host', stopId = 'original-stop';
  const event = (name, extra = {}) => handleRuntimeV2Event({ projectRoot: f.root, plan: { runtimeV2, artifacts: [] }, reviewerFactory,
    stopHost: { directory, stopId, startProtocol: { version: 1 } }, input: { session_id: sessionId, cwd: f.root,
      transcript_path: transcript, hook_event_name: name, last_assistant_message: 'Task complete.', ...extra } });
  await event('SessionStart', { source: 'startup' });
  if (compacted) {
    await event('PreCompact', { trigger: 'auto', custom_instructions: null });
    await writeTranscript([{ type: 'assistant', uuid: 'compaction-summary', message: { content: 'Summary: compare is in progress.' } },
      { type: 'user', uuid: 'user-continue', message: { content: 'Continue.' } },
      { type: 'assistant', uuid: 'completion', message: { content: 'Task complete.' } }]);
  }
  const result = await event('Stop');
  if (callbackFailure) throw callbackFailure;
  if (compacted) assert.deepEqual((await fs.readFile(userMessageLogPath(f.root, sessionId), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line).text), [requirement, 'Continue.']);
  assert.deepEqual(roles, ['stop-reviewer']);
  assert.equal(result.stop.status, 'DEVIATION', JSON.stringify(result.stop));
  assert.equal(result.decision, 'block');
  assert.match(result.feedback, /without adding one/u);
  await assert.rejects(fs.access(ledgerPath), { code: 'ENOENT' });
  const state = await createStopCorrectionStore({ directory }).inspect(sessionId);
  const feedback = () => stopFeedbackCurrent({ directory, sessionId, projectRoot: f.root, taskId: f.task.taskId,
    deviations: state.stops[stopId].currentDeviations });
  await fs.writeFile(ledgerPath, 'unrelated malformed older ledger');
  assert.equal((await feedback()).length, 1);
  await fs.writeFile(source, 'export const compare = value => value + 1;\n');
  const staleAttachments = await feedback();
  assert.deepEqual(staleAttachments.deviations, []);
  assert.equal(staleAttachments.attachmentFailures.length, 1);
});
