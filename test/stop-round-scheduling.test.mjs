import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { persistSkillGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { withTaskDecision, withTaskState, decisionGuard, findTask, taskDirectory } from '../lib/runtime-v2/task-store.mjs';

const scope = { stopClassification: 'TASK_COMPLETE', completionClaim: true, summary: 'The original business reply declares both deliverables complete.' };
const trace = () => ({ version: 1, entryPoint: 'accept(value)', actualInput: 'The supplied finite number.',
  producerToConsumer: 'The parameter flows through value + 1 directly to the returned primitive.', stateful: false,
  statelessReason: 'The complete module is one pure arrow expression with no stored state or other operations.', stateTargets: [], targetRelations: [] });
const decode = result => JSON.parse(result.content[0].text);
// The production worker deliberately returns incomplete progress after some
// runner failures. Never let that behavior swallow an assertion in this script.
async function checkedRun(f, script, settings) {
  let scriptError;
  try {
    const handle = await f.run(async api => {
      try { await script(api); } catch (error) { scriptError = error; throw error; }
    }, settings);
    if (scriptError) throw scriptError;
    return handle;
  } catch (error) { throw scriptError ?? error; }
}

async function tenItemFixture(t, { extraRecords = 0 } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  const app = path.join(f.root, 'app.mjs'), guide = path.join(f.root, 'docs/guide.md'), skillRoot = path.join(f.root, 'skills/delivery-verifier');
  await fs.mkdir(path.dirname(guide), { recursive: true }); await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(app, 'export const accept = value => value + 1;\n');
  await fs.writeFile(guide, 'Finite-number input: accept(2) === 3. The operation is stateless; other inputs are outside scope.\n');
  const contract = 'Return the supplied finite number plus one without state; other inputs are outside scope. Document finite input, accept(2) === 3, statelessness and exclusions.';
  await fs.writeFile(path.join(f.root, 'contract.md'), contract);
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# Delivery verifier\nRead contract.md and implement app.mjs and docs/guide.md. Run node verify.mjs after the final edit; establish exit code 0 before declaring completion. Repeat only if a later correction changes a deliverable. Edit only the two deliverables.\n');
  const constraints = [
    { constraintId: 'read-implement', kind: 'STEP', statement: 'Read contract.md and implement the two deliverables.' },
    { constraintId: 'run-verifier', kind: 'STEP', statement: 'Run node verify.mjs after the final edit.', condition: 'after the final edit', dependsOn: ['read-implement'] },
    { constraintId: 'exit-zero', kind: 'CONDITION', statement: 'Establish actual exit code 0 before declaring completion.', dependsOn: ['run-verifier'] },
    { constraintId: 'rerun', kind: 'STEP', statement: 'Repeat verification only after a later correction changes a deliverable.', condition: 'a later correction changes a deliverable', applicabilityKind: 'CONDITIONAL', dependsOn: ['exit-zero'] },
    { constraintId: 'edit-only', kind: 'PROHIBITION', statement: 'Edit only app.mjs and docs/guide.md.' },
  ].map(c => ({ modality: 'MUST', sourceRef: 'SKILL.md#L2', applicabilityKind: 'CURRENT_TASK', ...c }));
  const source = await scanSkillDirectory(skillRoot), saved = await persistSkillGroundTruth({ projectRoot: f.root, taskId: f.task.taskId,
    skillId: 'delivery-verifier', skillDigest: source.digest, constraints, taskOverlays: [] });
  const claims = [
    ['app', 'Implement ./app.mjs as the finite-number plus-one stateless function.', 'IMPLEMENTATION', ['./app.mjs']],
    ['guide', 'Complete docs/guide.md with all original contract requirements.', 'ARTIFACT', ['docs/guide.md']],
    ['verify', 'Actually run the verifier after the final edit and establish exit code 0 before completion; rerun after a later correction.', 'PROCESS', []],
    ['skill', 'Read and follow the matching delivery-verifier Skill.', 'PROCESS', []],
  ].map(([id, text, verificationTarget, expectedFiles]) => ({ claimId: id, revisionId: `${id}@1`, category: 'requirements',
    text, authority: 'USER_EXPLICIT', status: 'ACTIVE', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget, expectedFiles,
    ...(verificationTarget === 'IMPLEMENTATION' ? { implementationRole: 'PRODUCTION' } : {}) }));
  const groundTruth = { taskId: f.task.taskId, version: 1, digest: sha256(claims), claims };
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(groundTruth)); f.input.evidence.groundTruth = groundTruth;
  const asObject = (claim, metricId = 'M12') => ({ objectId: `${metricId}:${claim.claimId}`, sourceId: claim.claimId, sourceRevisionId: claim.revisionId,
    metricId, description: claim.text, authority: claim.authority, hard: true, applicabilityKind: claim.applicabilityKind,
    verificationTarget: claim.verificationTarget, expectedFiles: claim.expectedFiles, ...(claim.implementationRole ? { implementationRole: claim.implementationRole } : {}) });
  f.input.request.population.metrics = { M08: constraints.map(c => ({ objectId: `M08:delivery-verifier:${c.constraintId}`, sourceId: `delivery-verifier:${c.constraintId}`,
    sourceRevisionId: `delivery-verifier@${saved.document.version}`, metricId: 'M08', description: c.statement, skillId: 'delivery-verifier',
    authority: 'MATERIAL_DERIVED', hard: true, applicabilityKind: c.applicabilityKind, condition: c.condition, verificationTarget: 'PROCESS' })),
    M12: claims.map(c => asObject(c)), M16: [asObject(claims[0], 'M16')] };
  f.input.skillRoots = [path.dirname(skillRoot)];
  const event = (type, content, other = {}) => ({ type, ...other, message: { content } });
  const invoke = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, content) => event('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: false }], { isMeta: true });
  const entries = [
    event('user', claims.map(c => c.text).join(' '), { uuid: 'original-user' }),
    event('assistant', [invoke('read-contract', 'Read', { path: 'contract.md' }), invoke('read-skill', 'Read', { path: 'skills/delivery-verifier/SKILL.md' })]),
    result('read-contract', contract), result('read-skill', await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')),
    event('assistant', [invoke('read-app', 'Read', { path: 'app.mjs' }), invoke('read-guide', 'Read', { path: 'docs/guide.md' }), invoke('read-verifier', 'Read', { path: 'verify.mjs' })]),
    result('read-app', 'export const accept = value => value;'), result('read-guide', 'Incomplete guide.'), result('read-verifier', 'process.exitCode = 0;'),
    event('assistant', [invoke('write-app', 'Write', { path: 'app.mjs', content: await fs.readFile(app, 'utf8') }), invoke('write-guide', 'Write', { path: 'docs/guide.md', content: await fs.readFile(guide, 'utf8') })]),
    result('write-app', 'Write completed.'), result('write-guide', 'Write completed.'),
    event('assistant', [invoke('verify', 'Bash', { command: 'node verify.mjs' })]), result('verify', JSON.stringify({ exitCode: 0, codePassed: true, guidePassed: true })),
    event('assistant', 'Both deliverables are complete; actual verification returned exit code 0.'),
  ];
  for (let i = 0; i < extraRecords; i++) entries.push(event('assistant', `Additional original context record ${i}.`));
  f.input.evidence.snapshot.entries = entries;
  const originalPath = path.join(f.root, 'original-process.jsonl'), originalText = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  await fs.writeFile(originalPath, originalText); f.input.evidence.snapshot.digest = sha256(originalText);
  f.input.request.processSnapshotPath = originalPath;
  return { ...f, app, guide, objects: Object.values(f.input.request.population.metrics).flat(), entries };
}

async function ready(f, api) {
  await api.readAll();
  const checklist = await api.submit('review_checklist', { ...scope, limit: 20 });
  assert.equal(checklist.total, 10); assert.equal(checklist.items.length, 10);
  let processPaths = checklist.processFiles;
  if (processPaths.length < checklist.processFileCount) {
    api.advance();
    processPaths = decode(await api.tools.get('source_ls').execute(crypto.randomUUID(), { path: checklist.processDirectory, limit: 100 })).hits;
    assert.equal(processPaths.length, checklist.processFileCount);
  }
  const seen = new Set(), ids = [], byFile = new Map();
  for (const file of [...processPaths, f.app, f.guide, ...checklist.items.flatMap(x => x.originalSkillBasis?.requiredFiles ?? [])]) {
    if (seen.has(file)) continue; seen.add(file);
    const result = await api.read(file); ids.push(result.details.citation.citeId); byFile.set(file, result.details.citation.citeId);
  }
  return { checklist, ids, byFile };
}
function submission(object, ids, extra = {}) {
  return { taskId: object.objectId, verdict: object.applicabilityKind === 'CONDITIONAL' ? 'NOT_APPLICABLE' : 'PASS',
    ...(object.applicabilityKind === 'CONDITIONAL' ? { conditionAssessment: { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_WINDOW',
      afterCallId: 'verify', reason: 'The complete actual interval from the verifier invocation through completion contains no later correction.' } } : {}),
    reason: 'Checked the original obligation against its actual current source and attributable invocation/results.', citeIds: ids, finish: false, ...extra };
}
async function group(api, values, onSaved = () => {}) {
  api.advance(); const before = api.turns();
  const results = await Promise.allSettled(values.map(async value => {
    const id = crypto.randomUUID();
    try {
      const result = await api.tools.get('submit_review').execute(id, value);
      api.params.onAgentToolResult({ toolName: 'submit_review', result, isError: false });
      const decoded = decode(result); await onSaved(decoded); return decoded;
    } catch (error) {
      api.params.onAgentToolResult({ toolName: 'submit_review', result: { content: [{ type: 'text', text: error.message }] }, isError: true });
      throw error;
    }
  }));
  assert.equal(api.turns(), before, 'the group uses one assistant frame, not one frame per tool');
  return results;
}
async function savedState(f) {
  const base = path.join(taskDirectory(f.root, f.task.taskId), 'workspace-reviews'), directory = path.join(base, (await fs.readdir(base))[0]);
  return { directory, checkpoint: JSON.parse(await fs.readFile(path.join(directory, 'review-checkpoint.json'), 'utf8')),
    itemFiles: await fs.readdir(path.join(directory, 'items')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) };
}

test('registered native worker groups nine independent items and acknowledges them before final M16+finish, retaining all ten owners', async t => {
  const f = await tenItemFixture(t), frames = [];
  const handle = await checkedRun(f, async api => {
    assert.match(api.params.extraSystemPrompt, /all with finish:false/);
    assert.match(api.params.extraSystemPrompt, /32768-token output budget/);
    const { checklist, ids } = await ready(f, api);
    assert.equal(checklist.processFileCount, 14); assert.equal(checklist.processFiles.length, 14); assert.equal(checklist.processFilesComplete, true);
    assert(checklist.processFiles.some(x => x.endsWith('000012-0000.txt')), 'the actual verifier result is directly navigable');
    const independent = f.objects.filter(x => x.metricId !== 'M16');
    for (let offset = 0; offset < independent.length; offset += 3) {
      const before = api.turns(), outcomes = await group(api, independent.slice(offset, offset + 3).map(x => submission(x, ids)));
      assert(outcomes.every(x => x.status === 'fulfilled')); assert(outcomes.every(x => x.value.complete !== true));
      frames.push({ assistantFrames: api.turns() - before, itemIds: outcomes.map(x => x.value.itemId), pending: outcomes.at(-1).value.pending });
    }
    const state = await savedState(f);
    assert.equal(state.itemFiles.length, 9); assert.equal(state.checkpoint.taskState.receiptCount, 9); assert.equal(state.checkpoint.taskState.complete, false);
    await assert.rejects(api.submit('finish_stop_review', { summary: 'Nine of ten is incomplete.' }), /incomplete/);
    const final = await api.submit('submit_review', submission(f.objects.find(x => x.metricId === 'M16'), ids, { productionTrace: trace(), finish: true }));
    assert.equal(final.complete, true); assert.equal(final.pending, 0);
  });
  assert.equal(handle.result.metricObjectJudgements.length, 10);
  assert.equal(new Set(handle.result.metricObjectJudgements.map(x => x.objectId)).size, 10);
  const state = await savedState(f); assert.equal(state.itemFiles.length, 10); assert.equal(state.checkpoint.taskState.complete, true);
  assert.equal(state.checkpoint.taskState.receiptCount, 10); assert.deepEqual(handle.proofs['M16:app'].productionTrace, trace());
  t.diagnostic(JSON.stringify({ schedulingEvidence: 'actual-registered-native-tools-and-worker', groupedFrames: frames,
    fullChecklist: 10, beforeFinalReceipts: 9, beforeFinalComplete: false, finalReceipts: 10, finalComplete: true }));
  await handle.close();
});

test('grouped ownership errors preserve siblings while valid unacknowledged and direct citations are accepted', async t => {
  const f = await tenItemFixture(t);
  const handle = await checkedRun(f, async api => {
    const { ids } = await ready(f, api), valid = f.objects.filter(x => x.metricId !== 'M16');
    const partial = await group(api, [submission(valid[0], ids), submission({ ...valid[1], objectId: 'M12:unassigned' }, ids), submission(valid[2], ids)]);
    assert.deepEqual(partial.map(x => x.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal((await savedState(f)).checkpoint.taskState.receiptCount, 2);
    await assert.rejects(api.submit('finish_stop_review', { summary: 'An invalid item is still missing.' }), /incomplete/);
    await assert.rejects(api.submit('submit_review', submission(valid[0], ids)), /already has/);
    await assert.rejects(api.submit('submit_review', submission({ objectId: 'M12:unassigned' }, ids)), /Unassigned/);
    const unseenPath = path.join(f.root, 'unacknowledged.mjs'); await fs.writeFile(unseenPath, 'export const other = 1;\n');
    const unacknowledgedId = (await api.read(unseenPath, { receipt: false })).details.citation.citeId;
    await api.submit('submit_review', submission(valid[1], [unacknowledgedId]));
    for (const object of valid.slice(3)) await api.submit('submit_review', submission(object, ids));
    const m16 = f.objects.find(x => x.metricId === 'M16');
    const final = await api.submit('submit_review', submission(m16, [], { citations: [{ path: f.app, start: 1, end: 1 }], finish: true }));
    assert.equal(final.complete, true);
  });
  assert.equal((await savedState(f)).itemFiles.length, 10);
  await handle.close();
});

for (const interruption of ['cancel', 'source-change', 'deadline']) test(`mid-group ${interruption} rejects enclosing publication and every late finish`, async t => {
  const f = await tenItemFixture(t), controller = new AbortController(), now = Date.now, deadlineAt = now() + 10000;
  f.input.abortSignal = controller.signal; f.input.deadlineAt = deadlineAt;
  let outcomes, late, interrupted = false;
  try {
    await assert.rejects(withTaskDecision({ projectRoot: f.root, taskId: f.task.taskId,
      context: { assessmentId: `group-${interruption}`, guard: decisionGuard(f.task), deadlineAt, abortSignal: controller.signal } }, async () => {
      await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => { state.mustNotPublishAfterGroup = true; });
      return checkedRun(f, async api => {
        const { ids } = await ready(f, api);
        late = () => api.tools.get('finish_stop_review').execute(crypto.randomUUID(), { summary: 'Late finish cannot certify this ended task.' });
        outcomes = await group(api, f.objects.filter(x => x.metricId !== 'M16').slice(0, 3).map(x => submission(x, ids)), async () => {
          if (interrupted) return; interrupted = true;
          if (interruption === 'cancel') controller.abort(new Error('Group owner cancelled.'));
          else if (interruption === 'source-change') await fs.writeFile(f.app, 'export const accept = value => value;\n');
          else Date.now = () => deadlineAt;
        });
        assert(outcomes.some(x => x.status === 'fulfilled')); assert(outcomes.some(x => x.status === 'rejected'));
        await assert.rejects(late());
      });
    }), error => {
      assert(!(error instanceof assert.AssertionError), 'an assertion cannot stand in for a production rejection');
      assert(!(error instanceof ReferenceError || error instanceof TypeError));
      return true;
    });
  } finally { Date.now = now; }
  assert(interrupted); assert.equal((await findTask({ projectRoot: f.root, sessionId: 'protocol-host' })).mustNotPublishAfterGroup, undefined);
  await assert.rejects(late(), /expired|abort|cancel|deadline|changed|closed/i);
  const state = await savedState(f); assert.equal(state.checkpoint.taskState.complete, false); assert(state.itemFiles.length >= 1 && state.itemFiles.length < 10);
  await assert.rejects(fs.access(path.join(state.directory, 'review.json')), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ schedulingEvidence: `mid-group-${interruption}`, outcomes: outcomes.map(x => x.status),
    retainedPartialReceiptFiles: state.itemFiles.length, taskComplete: false, enclosingMarkerPublished: false, lateFinishRejected: true }));
});

test('combined initialization never guesses completionClaim; later pages omit classification and keep all selected items', async t => {
  const f = await tenItemFixture(t); let selections = 0; f.input.onScope = async () => { selections++; };
  const handle = await checkedRun(f, async api => {
    if (api.brief.attempt > 1) {
      const restored = await api.submit('review_checklist', {});
      assert.equal(restored.total, 10); assert.equal(restored.pending, 10); assert.equal(selections, 1); return;
    }
    await api.readAll();
    await assert.rejects(api.submit('review_checklist', { stopClassification: 'TASK_COMPLETE', limit: 5 }), /structured completion claim/);
    assert.equal(selections, 0);
    const first = await api.submit('review_checklist', { ...scope, limit: 5 }); assert.equal(first.items.length, 5); assert.equal(first.nextOffset, 5);
    const second = await api.submit('review_checklist', { offset: first.nextOffset, limit: 5 }); assert.equal(second.items.length, 5); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.items, ...second.items].map(x => x.objectId)).size, 10); assert.equal(selections, 1);
    await assert.rejects(api.submit('review_checklist', { ...scope, stopClassification: 'INTERMEDIATE', completionClaim: false }), /already fixed/);
    await assert.rejects(api.submit('review_checklist', { stopClassification: 'TASK_COMPLETE' }), /structured completion claim/);
    await assert.rejects(api.submit('finish_stop_review', { summary: 'Navigation does not complete ten items.' }), /incomplete/);
    // Return incomplete on both native attempts; this is an explicit mechanism check, not a PASS fixture.
  });
  assert.equal(handle.collection.complete, false); assert.equal(handle.result.metricObjectJudgements.length, 0);
  await handle.close();
});

test('large process navigation stays bounded and existing directory continuation reaches every original record without granting citations', async t => {
  const f = await tenItemFixture(t, { extraRecords: 16 });
  const handle = await checkedRun(f, async api => {
    await api.readAll(); const checklist = await api.submit('review_checklist', { ...scope, limit: 20 });
    assert.equal(checklist.processFileCount, 30); assert.equal(checklist.processFilesComplete, false);
    assert(checklist.processFiles.length <= 20); assert(Buffer.byteLength(JSON.stringify(checklist.processFiles)) <= 8192);
    const continuation = checklist.processFilesContinuation; assert.equal(continuation.tool, 'source_ls'); assert.equal(continuation.arguments.offset, 0);
    const pageArgs = { offset: 2, limit: 3 };
    const { classification, items, total, pending, nextOffset } = await api.submit('review_checklist', pageArgs);
    const compact = await api.submit('review_checklist', { ...pageArgs, includeNavigation: false });
    assert.deepEqual(compact, { classification, items, total, pending, nextOffset });
    const restored = await api.submit('review_checklist', { ...pageArgs, includeNavigation: true });
    assert.deepEqual(restored.processFilesContinuation, continuation);
    let offset = 0; const hits = [];
    do {
      api.advance(); const result = decode(await api.tools.get('source_ls').execute(crypto.randomUUID(), { ...continuation.arguments, offset, limit: 7 }));
      assert.equal(result.navigationOnly, true); hits.push(...result.hits); offset = result.nextOffset;
    } while (offset !== null);
    assert.equal(hits.length, 30); assert.equal(new Set(hits).size, 30);
    if (api.brief.attempt === 1) await assert.rejects(api.submit('submit_review', submission(f.objects[0], [], { verdict: 'DEVIATION' })), /deviation requires/i);
    await assert.rejects(api.submit('finish_stop_review', { summary: 'All paths are visible, but no item has proof yet.' }), /incomplete/);
  });
  assert.equal(handle.collection.complete, false); assert.equal(handle.sourceCitations.length, 0); await handle.close();
});

test('SOURCE-only initialization omits large process navigation until explicitly requested', async t => {
  const f = await tenItemFixture(t, { extraRecords: 16 });
  const sourceItems = f.objects.filter(x => x.metricId === 'M16' || x.metricId === 'M12' && x.sourceId === 'app');
  f.input.request.population.metrics = { M12: [sourceItems.find(x => x.metricId === 'M12')], M16: [sourceItems.find(x => x.metricId === 'M16')] };
  const handle = await checkedRun(f, async api => {
    assert.equal(api.brief.task.processNavigationOmitted, true);
    assert.deepEqual(api.brief.task.processFiles, []); assert.equal(api.brief.task.processFilesContinuation, undefined);
    await api.readAll(); const original = await api.submit('review_checklist', scope);
    assert.equal(original.total, 2); assert.equal(original.processNavigationOmitted, true);
    assert.deepEqual(original.processFiles, []); assert.equal(original.processFilesContinuation, undefined);
    const restored = await api.submit('review_checklist', { includeProcessEvidence: true });
    assert.equal(restored.total, original.total); assert.equal(restored.processFileCount, 30);
    assert.equal(restored.processFilesComplete, false); assert.equal(restored.processFilesContinuation.tool, 'source_ls');
    for (const [i, object] of sourceItems.entries()) await api.submit('submit_review', submission(object, [],
      { verdict: 'UNVERIFIED', reason: 'This navigation test has not inspected production source.', finish: i === sourceItems.length - 1 }));
  });
  assert(handle.result.metricObjectJudgements.every(x => x.judgement === 'UNVERIFIED')); await handle.close();
});
