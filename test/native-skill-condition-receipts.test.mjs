import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReviewerProgress, registerReviewerProgress } from '../lib/openclaw/reviewer-progress.mjs';
import { runInternalExecution } from '../lib/openclaw/internal-context.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import * as skillSource from '../lib/runtime-v2/skill-source.mjs';
import * as runtime from '../lib/runtime-v2/orchestrator.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import * as conditionContract from '../lib/review-task/task-evidence.mjs';
import { skillGraphCandidate, interpretSkillUnit } from './helpers/skill-source-interpretation.mjs';
const { bindSkillGraph, skillConditionalTargets } = skillSource;
const { validateSkillConditionalReview } = runtime;
const { captureConditionSnapshot } = conditionContract;

async function fixture(t, { text: suppliedText, interpret, interpretHeading, entries: suppliedEntries } = {}) {
  const parent = path.resolve('.runtime-correction/native-condition-receipt-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'business' }), directory = path.join(root, '.runtime-correction/request');
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'request.json'), '{}');
  const sessionFile = path.join(directory, 'session.jsonl');
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'private', cwd: root }) + '\n');
  const text = suppliedText ?? '# Verification\n\nIf a later correction changes the deliverable, run verification again.\n' + '完整上下文。'.repeat(40);
  const entries = suppliedEntries ?? [{ type: 'user', message: { content: 'Deliver a numeric result.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'actual-verify', name: 'Bash', input: { command: 'public-verifier' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'actual-verify', content: 'Exit code 0' }] } },
    { type: 'assistant', message: { content: 'Completed.' } }];
  const evidence = { skillSource: { root: path.join(root, 'skills/demo'), digest: sha256(text), truncated: false,
    files: [{ path: 'SKILL.md', content: text, sha256: sha256(text) }] }, snapshot: { entries },
    skillGroundTruth: { constraints: [{ constraintId: 'rerun', sourceRef: 'SKILL.md', applicabilityKind: 'CONDITIONAL' }] } };
  await fs.mkdir(evidence.skillSource.root, { recursive: true }); await fs.writeFile(path.join(evidence.skillSource.root, 'SKILL.md'), text);
  if (interpret) evidence.skillGroundTruth = { taskId: task.taskId, skillId: 'demo', version: 1,
    ...bindSkillGraph(skillGraphCandidate(evidence.skillSource, interpret, interpretHeading), evidence.skillSource) };
  const transcriptPath = path.join(root, 'business.jsonl'), transcript = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(transcriptPath, transcript); evidence.snapshot.digest = sha256(transcript);
  let alive = true, registration; const hooks = new Map();
  const progress = await createReviewerProgress({ projectRoot: root, taskId: task.taskId, sessionId: 'private',
    role: 'skill-reviewer',
    requestDirectory: directory, request: { watcher: { skillId: 'demo' } }, evidence, prepared: {},
    canSave: () => alive, canRecover: () => alive });
  registerReviewerProgress({ on(name, fn) { hooks.set(name, fn); }, registerTool(factory, metadata) {
    if (metadata.names.includes('rc_skill_care')) registration = factory;
  } });
  const ctx = { agentId: 'main', sessionId: 'private', sessionKey: 'agent:main:private', runId: 'actual-private-run' };
  const inScope = fn => runInternalExecution('private', fn, null, progress);
  const report = { conditionalAssessments: [{ constraintId: 'rerun', conditionAssessment: { evidenceKind: 'PROCESS_WINDOW' },
    actualEvidence: ['skill/SKILL.md', 'execution/0', 'execution/1', 'execution/2', 'execution/3'] }] };
  const issue = async (id, args) => inScope(async () => {
    await fs.appendFile(sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'rc_skill_care', arguments: args }] } }) + '\n');
    const result = await registration(ctx).execute(id, args);
    const event = { toolName: 'rc_skill_care', toolCallId: id, isSynthetic: false,
      message: { role: 'toolResult', toolName: 'rc_skill_care', toolCallId: id, isError: false, content: result.content } };
    return { result, event };
  });
  // The installed host's synchronous persist hook has no sessionId/runId.
  // The tool-factory context and persist context are different interfaces.
  const hostContext = event => ({ agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolName: event.toolName, toolCallId: event.toolCallId });
  const notify = (event, context = hostContext(event), owner = progress) => runInternalExecution('private',
    () => hooks.get('tool_result_persist')?.(event, context), null, owner);
  const append = message => fs.appendFile(sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
  const persist = async (event, context = hostContext(event)) => { await notify(event, context); await append(event.message); };
  return { root, task, evidence, transcriptPath, progress, ctx, report, issue, persist, notify, append, sessionFile, hostContext, inScope, close: () => { alive = false; } };
}

function skillCollectionDiagnostic(action, code) {
  let caught;
  assert.throws(action, error => { caught = error; assert.equal(error.code, code); return true; });
  assert(caught.message.startsWith(`${code}:`));
  assert(Buffer.byteLength(caught.message) <= 8192);
  const start = caught.message.indexOf('{'); assert(start >= 0, 'collection rejection needs actionable key diagnostics');
  const detail = JSON.parse(caught.message.slice(start));
  if (detail.expected.count <= 2 && detail.supplied.count <= 2) assert(Buffer.byteLength(caught.message) < 2048, 'common collection errors stay compact');
  for (const name of ['expected', 'supplied', 'missing', 'unknown', 'duplicates']) {
    assert(detail[name].keys.length <= 16); assert.equal(detail[name].omittedCount, detail[name].count - detail[name].keys.length);
  }
  assert.equal(detail.navigationOnly, true);
  assert.deepEqual(detail.recoverWith, { tool: 'rc_skill_care', action: 'inventory', prefix: 'constraint/', offset: 0 });
  return detail;
}

test('skill-ergonomics empty canonical targets reject a foreign baseline key with exact same-basis feedback', async t => {
  const f = await fixture(t, { text: 'Check the current report before finishing.', interpret: unit => interpretSkillUnit(unit) });
  const graph = f.evidence.skillGroundTruth, parent = graph.constraints[0];
  const review = { summary: 'Controlled original review.', completionStatus: 'COMPLETED', findings: [],
    sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId, disposition: 'CONFIRMED',
      reason: 'Explicitly rechecked the complete current original.', actualEvidence: ['skill/SKILL.md'] })),
    conditionalAssessments: [{ constraintId: parent.constraintId, conditionId: 'baseline-only-claim', judgement: 'UNVERIFIED',
      conditionAssessment: { activation: 'UNKNOWN', evidenceKind: 'PROCESS_EVENT', reason: 'Controlled unknown input.' }, actualEvidence: ['skill/SKILL.md'] }] };
  const page = await f.issue('current-original', { action: 'read', id: 'skill/SKILL.md' }); await f.persist(page.event);
  const citations = await f.progress.getSourceCitations(review), before = structuredClone({ review, graph });
  const detail = skillCollectionDiagnostic(() => validateSkillConditionalReview({ review, graph, citations }), 'REVIEW_CONDITION_ASSESSMENT_REQUIRED');
  assert.equal(detail.field, '/conditionalAssessments'); assert.equal(detail.expected.count, 0);
  assert.deepEqual(detail.expected.keys, []); assert.equal(detail.supplied.count, 1); assert.equal(detail.unknown.count, 1);
  assert.deepEqual(detail.unknown.keys, [skillSource.skillConditionKey(review.conditionalAssessments[0])]);
  assert.deepEqual(detail.offendingFields, ['/conditionalAssessments/0/conditionId']);
  assert.equal(detail.basis.skillId, graph.skillId); assert.equal(detail.basis.graphVersion, graph.version);
  assert.equal(detail.basis.graphDigest, sha256(graph)); assert.equal(detail.basis.skillSourceDigest, graph.sourceContract.sourceDigest);
  assert.match(detail.namespace, /Skill graph/); assert.match(detail.namespace, /baseline/i);
  assert.deepEqual({ review, graph }, before, 'feedback never rewrites canonical scope or submitted arrays');
});

test('skill-ergonomics missing duplicate unknown and legacy keys retain the exact rejection contract', async t => {
  const f = await fixture(t, { text: 'If a later correction changes the result, run verification again.',
    interpret: unit => interpretSkillUnit(unit, { scope: 'EXTERNAL_TRIGGER',
      external: [{ condition: 'If a later correction changes the result,', duty: 'run verification again.' }] }) });
  const graph = f.evidence.skillGroundTruth, target = skillConditionalTargets(graph)[0], key = skillSource.skillConditionKey(target);
  const item = { constraintId: target.constraintId, conditionId: target.conditionId, judgement: 'UNVERIFIED',
    conditionAssessment: { activation: 'UNKNOWN', evidenceKind: 'PROCESS_EVENT', reason: 'Honest controlled uncertainty.' }, actualEvidence: ['skill/SKILL.md'] };
  const base = { summary: 'Controlled keys.', completionStatus: 'COMPLETED', findings: [],
    sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId, disposition: 'CONFIRMED',
      reason: 'Original branch and its context read.', actualEvidence: ['skill/SKILL.md'] })) };
  const page = await f.issue('branch-original', { action: 'read', id: 'skill/SKILL.md' }); await f.persist(page.event);
  for (const [items, expected] of [[[], { missing: 1, unknown: 0, duplicates: 0 }], [[item, item], { missing: 0, unknown: 0, duplicates: 1 }],
    [[{ ...item, conditionId: 'foreign-condition' }], { missing: 1, unknown: 1, duplicates: 0 }],
    [[{ ...item, conditionId: undefined }], { missing: 1, unknown: 1, duplicates: 0 }]]) {
    const review = { ...base, conditionalAssessments: items }, citations = await f.progress.getSourceCitations(review);
    const detail = skillCollectionDiagnostic(() => validateSkillConditionalReview({ review, graph, citations }), 'REVIEW_CONDITION_ASSESSMENT_REQUIRED');
    assert.equal(detail.expected.count, 1); assert.deepEqual(detail.expected.keys, [key]); assert.equal(detail.supplied.count, items.length);
    for (const [name, count] of Object.entries(expected)) assert.equal(detail[name].count, count);
    if (expected.unknown) assert(detail.offendingFields.includes('/conditionalAssessments/0/conditionId'));
    if (expected.duplicates) assert(detail.offendingFields.includes('/conditionalAssessments/1/conditionId'));
  }
  const legacy = { skillId: 'legacy', version: 2, constraints: [{ constraintId: 'legacy-target', applicabilityKind: 'CONDITIONAL' }] };
  const detail = skillCollectionDiagnostic(() => validateSkillConditionalReview({ graph: legacy,
    review: { summary: 'Legacy identity.', completionStatus: 'COMPLETED', findings: [], conditionalAssessments: [] } }), 'REVIEW_CONDITION_ASSESSMENT_REQUIRED');
  assert.deepEqual(detail.expected.keys, ['legacy-target']); assert.deepEqual(detail.missing.keys, ['legacy-target']);
});

test('skill-ergonomics diagnostic key previews and whole UTF8 messages are bounded without fake submit IDs', () => {
  const long = 'long-key-示例😀'.repeat(400), graph = { skillId: 'large', version: 1,
    constraints: Array.from({ length: 80 }, (_, i) => ({ constraintId: `${long}-expected-${i}`, applicabilityKind: 'CONDITIONAL' })) };
  const review = { summary: 'Large controlled invalid set.', completionStatus: 'COMPLETED', findings: [],
    conditionalAssessments: Array.from({ length: 80 }, (_, i) => ({ constraintId: `${long}-unknown-${i}` })) };
  const detail = skillCollectionDiagnostic(() => validateSkillConditionalReview({ review, graph }), 'REVIEW_CONDITION_ASSESSMENT_REQUIRED');
  for (const name of ['expected', 'supplied', 'missing', 'unknown']) {
    assert.equal(detail[name].count, 80); assert(detail[name].omittedCount > 0); assert(detail[name].keys.length > 0);
    for (const key of detail[name].keys) {
      assert.equal(key.truncated, true); assert.match(key.notice, /not.*submit-ready/i); assert.match(key.sha256, /^[a-f0-9]{64}$/);
      assert.equal(Object.hasOwn(key, 'key'), false, 'a truncated value must not look like a usable canonical key');
    }
  }
  assert.equal(detail.expected.keys[0].sha256, sha256(graph.constraints[0].constraintId));
});

test('skill-ergonomics missing source reviews identify their field before any condition repair', async t => {
  const f = await fixture(t, { text: 'Review the current delivery.', interpret: unit => interpretSkillUnit(unit) });
  const graph = f.evidence.skillGroundTruth, review = { summary: 'Missing original interpretation.', completionStatus: 'COMPLETED', findings: [],
    conditionalAssessments: [{ constraintId: 'foreign', conditionId: 'foreign' }] };
  const before = structuredClone(review);
  const detail = skillCollectionDiagnostic(() => validateSkillConditionalReview({ review, graph }), 'SKILL_SOURCE_INTERPRETATION_REQUIRED');
  assert.equal(detail.field, '/sourceInterpretationReviews'); assert.equal(detail.supplied.count, 0);
  assert.deepEqual(detail.missing.keys, graph.constraints.map(c => c.constraintId)); assert.deepEqual(review, before);
});

test('skill-ergonomics empty targets cannot turn a workflow interpretation conflict or uncertainty into PASS', async t => {
  // Scope/dispositions are explicit scripted proposals, not a language classifier.
  const f = await fixture(t, { text: 'Create the result. If your later edit changes it, verify the new result again.',
    interpret: unit => interpretSkillUnit(unit, { scope: 'CURRENT_TASK' }) });
  const graph = f.evidence.skillGroundTruth; assert.deepEqual(skillConditionalTargets(graph), []);
  const page = await f.issue('complete-workflow-original', { action: 'read', id: 'skill/SKILL.md' }); await f.persist(page.event);
  for (const disposition of ['CONFLICT', 'UNCERTAIN']) {
    const review = { summary: 'Whole original scope is unresolved.', completionStatus: 'COMPLETED', findings: [], conditionalAssessments: [],
      sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId, disposition,
        reason: 'Same actor does not establish that a later workflow edit is a function-runtime branch.', actualEvidence: ['skill/SKILL.md'] })) };
    const citations = await f.progress.getSourceCitations(review), before = structuredClone({ graph, review });
    const checked = validateSkillConditionalReview({ review, graph, citations });
    assert.equal(checked.unresolved, true); assert.deepEqual(checked.bindings, []); assert.deepEqual({ graph, review }, before);
  }
});

test('critical-path conditional field feedback navigates exact calls but cannot replace native full-window proof', async t => {
  const f = await fixture(t);
  const nav = await f.issue('navigation', { action: 'inventory', prefix: 'execution/' }); await f.persist(nav.event);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  const review = { summary: 'Controlled window.', completionStatus: 'COMPLETED', findings: [], conditionalAssessments: [{ constraintId: 'rerun',
    conditionAssessment: { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_WINDOW', afterCallId: 'execution/1', reason: 'Controlled negative window.' },
    actualEvidence: ['skill/SKILL.md', 'execution/1', 'execution/2', 'execution/3'] }] };
  const context = { graph: f.evidence.skillGroundTruth, snapshot: f.evidence.snapshot, processSource: await captureConditionSnapshot(f.evidence.snapshot, f.transcriptPath) };
  assert.throws(() => validateSkillConditionalReview({ review, ...context }), error => {
    assert.match(error.message, /conditionalAssessments\/0\/conditionAssessment\/afterCallId/); assert.match(error.message, /inventory/); return true;
  });
  review.conditionalAssessments[0].conditionAssessment.afterCallId = 'actual-verify';
  assert.throws(() => validateSkillConditionalReview({ review, ...context }), /EVIDENCE_UNAVAILABLE/);
  for (const [i, id] of ['skill/SKILL.md', 'execution/1', 'execution/2', 'execution/3'].entries()) {
    const page = await f.issue(`actual-${i}`, { action: 'read', id }); await f.persist(page.event);
  }
  const citations = await f.progress.getSourceCitations(review);
  assert.equal(validateSkillConditionalReview({ review, citations, ...context }).unresolved, false);
  const unknown = structuredClone(review);
  unknown.completionStatus = 'NOT_COMPLETED'; unknown.checkerError = 'No reliable process boundary.';
  unknown.conditionalAssessments[0].conditionAssessment = { activation: 'UNKNOWN', evidenceKind: 'PROCESS_WINDOW', reason: 'Honest uncertainty.' };
  assert.equal(validateSkillConditionalReview({ review: unknown, ...context }).unresolved, true);
});

test('critical-path added navigation still requires exact final durable native receipt bytes', async t => {
  const f = await fixture(t), read = await f.issue('navigation-read', { action: 'read', id: 'execution/1' });
  const value = JSON.parse(read.result.content[0].text); assert.equal(value.navigation.calls[0].callId, 'actual-verify');
  value.navigation.calls[0].callId = 'forged';
  const changed = structuredClone(read.event); changed.message.content = [{ type: 'text', text: JSON.stringify(value) }];
  await f.persist(changed); assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  const genuine = await f.issue('genuine-navigation-read', { action: 'read', id: 'execution/1' });
  await f.notify(genuine.event); assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  await f.append(genuine.event.message);
  assert((await f.progress.getSourceCitations(f.report)).some(c => c.readProof.fullFile && c.readProof.processIndex === 1));
});

test('registered Skill reads require original native ACKs and complete pages; same-review coverage is reusable', async t => {
  const f = await fixture(t);
  const first = await f.issue('page-0', { action: 'read', id: 'skill/SKILL.md', offset: 0, limit: 20 });
  assert.deepEqual(await f.progress.getSourceCitations(f.report), [], 'tool execution without persistence is not disclosure');
  await f.persist(first.event);
  assert(!(await f.progress.getSourceCitations(f.report)).some(c => c.readProof.basisComplete));
  let offset = JSON.parse(first.result.content[0].text).nextOffset, i = 0;
  while (offset !== null) {
    const page = await f.issue(`page-${++i}`, { action: 'read', id: 'skill/SKILL.md', offset, limit: 73 });
    await f.persist(page.event); offset = JSON.parse(page.result.content[0].text).nextOffset;
  }
  for (let index = 0; index < 4; index++) {
    const page = await f.issue(`execution-${index}`, { action: 'read', id: `execution/${index}` }); await f.persist(page.event);
  }
  const refs = await f.progress.getSourceCitations(f.report);
  assert.equal(refs.length, 5); assert(refs.every(c => c.readProof.observed && c.readProof.basisComplete));
  assert.equal(refs.find(c => c.readProof.processIndex === 2).readProof.executionEvidence, true);
  assert.equal(refs.find(c => c.readProof.owner === 'BASIS').readProof.executionEvidence, false);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), refs, 'acknowledged unchanged coverage survives same-review follow-up');
});

test('foreign, synthetic, changed, error and late Skill receipts cannot create evidence; navigation is never reading', async t => {
  const f = await fixture(t), page = await f.issue('read-original', { action: 'read', id: 'skill/SKILL.md' });
  const mutations = [e => ({ ...e, isSynthetic: true }), e => ({ ...e, toolCallId: 'foreign' }),
    e => ({ ...e, message: { ...e.message, isError: true } }),
    e => ({ ...e, message: { ...e.message, content: [{ type: 'text', text: 'truncated' }] } })];
  for (const mutate of mutations) { await f.notify(mutate(page.event)); assert.deepEqual(await f.progress.getSourceCitations(f.report), []); }
  for (const ctx of [{ ...f.ctx, sessionId: 'foreign' }, { ...f.ctx, sessionKey: 'agent:other:private' }, { ...f.ctx, runId: 'foreign' }]) {
    await f.notify(page.event, ctx); assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  }
  for (const ctx of [{}, { ...f.hostContext(page.event), sessionKey: undefined },
    { ...f.hostContext(page.event), agentId: 'other' }, { ...f.hostContext(page.event), toolCallId: 'foreign' }]) {
    await f.notify(page.event, ctx); assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  }
  await f.notify(page.event, f.hostContext(page.event), null);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), [], 'matching key and envelope without the owning ALS reviewer is insufficient');
  for (const [id, action] of [['search', 'search'], ['inventory', 'inventory'], ['notes', 'notes']]) {
    const value = await f.issue(id, { action, ...(action === 'search' ? { query: 'verification' } : {}) }); await f.persist(value.event);
  }
  assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  await f.persist(page.event); assert((await f.progress.getSourceCitations(f.report)).some(c => c.readProof.owner === 'BASIS'));
  const late = await f.issue('late', { action: 'read', id: 'execution/0' }); f.close(); await f.persist(late.event);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
});

test('a prewrite hook alone is not durable; changed, orphaned or duplicate persisted results grant no coverage', async t => {
  const f = await fixture(t), page = await f.issue('durable-original', { action: 'read', id: 'skill/SKILL.md' });
  await f.notify(page.event);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), [], 'before_message_write can still drop the prewrite envelope');
  const original = await fs.readFile(f.sessionFile, 'utf8');
  await f.append({ ...page.event.message, content: [{ type: 'text', text: 'post-hook truncation' }] });
  assert.deepEqual(await f.progress.getSourceCitations(f.report), []);
  await fs.writeFile(f.sessionFile, original); await f.append(page.event.message);
  const refs = await f.progress.getSourceCitations(f.report);
  assert(refs.some(c => c.readProof.disclosure === 'HOST_PREWRITE_OBSERVED_AND_SESSION_TRANSCRIPT_VERIFIED'));
  await f.append(page.event.message);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), [], 'ambiguous duplicate results cannot prove the issued read');
  await fs.writeFile(f.sessionFile, JSON.stringify({ type: 'session', id: 'private' }) + '\n'); await f.append(page.event.message);
  assert.deepEqual(await f.progress.getSourceCitations(f.report), [], 'a persisted result needs its original invocation');
});

test('registered semantic reads cover soft/context units and a real compound conditional target without erasing its current M08 duty', async t => {
  const text = 'This skill helps build validator libraries.\n\nYou may inspect examples.\n\nCreate app.mjs. You may inspect examples. If a later correction changes app.mjs, run verification again.';
  const f = await fixture(t, { text, interpret: (unit, i) => i === 0 ? interpretSkillUnit(unit, { normativity: 'DESCRIPTION' })
    : i === 1 ? interpretSkillUnit(unit, { normativity: 'PERMISSION' }) : interpretSkillUnit(unit, { normativity: 'MIXED', scope: 'COMPOUND', current: ['Create app.mjs.'],
      external: [{ condition: 'If a later correction changes app.mjs,', duty: 'run verification again.' }] }) });
  const graph = f.evidence.skillGroundTruth, population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId,
    groundTruth: { claims: [] }, skillDocuments: [graph] });
  assert.equal(population.metrics.M08.length, 1); assert.equal(population.metrics.M08[0].applicabilityKind, 'CURRENT_TASK');
  assert.match(population.metrics.M08[0].description, /You may inspect examples/);
  const targets = skillConditionalTargets(graph); assert.equal(targets.length, 1);
  const review = { summary: 'Original interpretations checked.', completionStatus: 'COMPLETED', findings: [],
    sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId, disposition: 'CONFIRMED', reason: 'Read the complete original context.', actualEvidence: ['skill/SKILL.md'] })),
    conditionalAssessments: [{ constraintId: targets[0].constraintId, conditionId: targets[0].conditionId, judgement: 'NOT_APPLICABLE',
      conditionAssessment: { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'PROCESS_WINDOW', afterCallId: 'actual-verify', reason: 'The actual complete original interval contains no later correction.' },
      actualEvidence: ['execution/0', 'execution/1', 'execution/2', 'execution/3'] }] };
  assert.throws(() => validateSkillConditionalReview({ review, graph }), /INTERPRETATION_EVIDENCE/);
  const sourceRead = await f.issue('semantic-context', { action: 'read', id: 'skill/SKILL.md' }); await f.persist(sourceRead.event);
  const sourceRefs = await f.progress.getSourceCitations(review);
  assert.throws(() => validateSkillConditionalReview({ review: { ...review, conditionalAssessments: [] }, graph, citations: sourceRefs }), /CONDITION_ASSESSMENT_REQUIRED/);
  for (let i = 0; i < f.evidence.snapshot.entries.length; i++) {
    const page = await f.issue(`semantic-process-${i}`, { action: 'read', id: `execution/${i}` }); await f.persist(page.event);
  }
  const citations = await f.progress.getSourceCitations(review), context = { graph, citations, snapshot: f.evidence.snapshot,
    processSource: await captureConditionSnapshot(f.evidence.snapshot, f.transcriptPath) };
  const result = validateSkillConditionalReview({ review, ...context });
  assert.equal(result.unresolved, false); assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].activation, 'INACTIVE_AT_CURRENT_BOUNDARY');
  const missing = { ...review, sourceInterpretationReviews: review.sourceInterpretationReviews.slice(1) };
  assert.throws(() => validateSkillConditionalReview({ review: missing, ...context }), /INTERPRETATION_REQUIRED/);
  const conflicted = { ...review, sourceInterpretationReviews: review.sourceInterpretationReviews.map((r, i) => i ? r : { ...r, disposition: 'CONFLICT', reason: 'The proposal wrongly softened an original duty.' }) };
  assert.equal(validateSkillConditionalReview({ review: conflicted, ...context }).unresolved, true, 'an empty hard denominator cannot hide a semantic conflict');
  assert.throws(() => validateSkillConditionalReview({ review, ...context, graph: { ...graph, version: 2 } }), /INTERPRETATION_EVIDENCE/);
  await fs.appendFile(path.join(f.evidence.skillSource.root, 'SKILL.md'), '\nChanged original authority.');
  assert((await f.progress.getSourceCitations(review)).every(c => c.readProof.basisComplete === false), 'same private session cannot reuse stale original authority');
});

test('native Skill-care never fabricates SOURCE/ARTIFACT owners for implementation or artifact branch fulfillment', async t => {
  for (const verificationTarget of ['IMPLEMENTATION', 'ARTIFACT']) await t.test(verificationTarget, async t => {
    const f = await fixture(t, { text: 'If requested, create the result.', interpret: unit => interpretSkillUnit(unit, {
      scope: 'EXTERNAL_TRIGGER', external: [{ condition: 'If requested,', duty: 'create the result.', verificationTarget }] }) });
    const graph = f.evidence.skillGroundTruth, target = skillConditionalTargets(graph)[0];
    for (const [i, id] of ['skill/SKILL.md', 'execution/0', 'execution/1', 'execution/2', 'execution/3'].entries()) {
      const page = await f.issue(`read-subject-${i}`, { action: 'read', id }); await f.persist(page.event);
    }
    const review = { summary: 'Controlled subject check.', completionStatus: 'COMPLETED', findings: [],
      sourceInterpretationReviews: [{ constraintId: target.constraintId, disposition: 'CONFIRMED', reason: 'Controlled original interpretation.', actualEvidence: ['skill/SKILL.md'] }],
      conditionalAssessments: [{ constraintId: target.constraintId, conditionId: target.conditionId, judgement: 'PASS',
        conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'PROCESS_EVENT', reason: 'Original process establishes the condition, not artifact fulfillment.' },
        actualEvidence: ['execution/0', 'execution/1', 'execution/2', 'execution/3'] }] };
    const citations = await f.progress.getSourceCitations(review);
    assert(citations.every(c => ['BASIS', 'PROCESS'].includes(c.readProof.owner)));
    const checked = validateSkillConditionalReview({ review, graph, citations, snapshot: f.evidence.snapshot });
    assert.equal(checked.unresolved, true); assert.equal(checked.bindings[0].judgement, 'UNVERIFIED');
  });
});

test('required-heading and optional-example fences both reach actual semantic review while only the adopted duty projects M08', async t => {
  const text = '# Verify delivery before completion\n\n```bash\nnode verify.mjs\n```\n\n# Optional example\n\n```python\nprint("示例 😀")\n```\n';
  const f = await fixture(t, { text, interpret: unit => interpretSkillUnit(unit, { normativity: 'DESCRIPTION' }),
    interpretHeading: unit => interpretSkillUnit(unit, unit.start === 1 ? { current: ['# Verify delivery before completion'] } : { normativity: 'DESCRIPTION' }) });
  const graph = f.evidence.skillGroundTruth;
  assert.equal(graph.constraints.length, 4);
  assert.equal(graph.constraints.filter(c => c.sourceInterpretation.sourceOwnership.kind === 'BODY').length, 2);
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: { claims: [] }, skillDocuments: [graph] });
  assert.equal(population.metrics.M08.length, 1);
  const page = await f.issue('heading-fences', { action: 'read', id: 'skill/SKILL.md' }); await f.persist(page.event);
  const review = { summary: 'Controlled adopted-command and example interpretation.', completionStatus: 'COMPLETED', findings: [],
    sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId, disposition: 'CONFIRMED', reason: 'Read the full original including the adopting heading.', actualEvidence: ['skill/SKILL.md'] })) };
  const citations = await f.progress.getSourceCitations(review);
  assert.equal(validateSkillConditionalReview({ review, graph, citations }).unresolved, false);
  assert.throws(() => validateSkillConditionalReview({ review: { ...review, sourceInterpretationReviews: review.sourceInterpretationReviews.slice(0, 1) }, graph, citations }), /INTERPRETATION_REQUIRED/);
});

test('complete original semantic-review pipeline distinguishes descriptive heading context from an omitted BODY duty', async t => {
  // These scripted conclusions test the real disclosure/review guards, not a
  // claim that an offline fixture can determine natural-language entailment.
  for (const omitted of [false, true]) {
    const f = await fixture(t, { text: '# Delivery overview\n\nCreate app.mjs.\n',
      interpret: unit => interpretSkillUnit(unit, { normativity: omitted ? 'DESCRIPTION' : 'MANDATORY' }) });
    const graph = f.evidence.skillGroundTruth, heading = graph.constraints.find(c => c.sourceInterpretation.sourceOwnership.kind === 'HEADING_SCOPE'),
      body = graph.constraints.find(c => c.sourceInterpretation.sourceOwnership.kind === 'BODY');
    assert.equal(heading.modality, 'MAY'); assert.match(heading.sourceText, /Create app\.mjs/);
    const page = await f.issue(`ownership-${omitted}`, { action: 'read', id: 'skill/SKILL.md' }); await f.persist(page.event);
    const review = { summary: 'Explicit controlled original ownership review.', completionStatus: 'COMPLETED', findings: [],
      sourceInterpretationReviews: graph.constraints.map(c => ({ constraintId: c.constraintId,
        disposition: omitted && c.constraintId === body.constraintId ? 'CONFLICT' : 'CONFIRMED',
        reason: c.constraintId === heading.constraintId ? 'Descriptive heading owns no duty; the actual BODY owner must retain the mandatory original.'
          : omitted ? 'The BODY proposal wrongly softened the original Create duty.' : 'The BODY owner preserves the original Create duty.', actualEvidence: ['skill/SKILL.md'] })) };
    const citations = await f.progress.getSourceCitations(review);
    assert.equal(validateSkillConditionalReview({ graph, review, citations }).unresolved, omitted);
    assert.throws(() => validateSkillConditionalReview({ graph, citations,
      review: { ...review, sourceInterpretationReviews: review.sourceInterpretationReviews.filter(r => r.constraintId !== body.constraintId) } }), /INTERPRETATION_REQUIRED/u);
  }
});


function disclosureReview(f) {
  const graph = f.evidence.skillGroundTruth, target = skillConditionalTargets(graph)[0];
  return { summary: 'A complete current original assessment.', completionStatus: 'COMPLETED', findings: [], checkerError: null,
    sourceInterpretationReviews: graph.sourceContract ? graph.constraints.map(c => ({ constraintId: c.constraintId,
      disposition: 'CONFIRMED', reason: 'The current complete original supports this interpretation.', actualEvidence: ['skill/SKILL.md'] })) : [],
    conditionalAssessments: [{ constraintId: target.constraintId, ...(target.conditionId == null ? {} : { conditionId: target.conditionId }),
      judgement: 'PASS', conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'PROCESS_EVENT', afterCallId: 'actual-verify',
        reason: 'Assess the original process using its attributable invocation and result.' },
      actualEvidence: ['skill/SKILL.md', ...f.evidence.snapshot.entries.map((_, i) => `execution/${i}`)] }] };
}

async function disclose(f, id, tag) {
  let offset = 0, page = 0;
  do {
    const issued = await f.issue(`${tag}-${page++}`, { action: 'read', id, offset, limit: 16000 });
    await f.persist(issued.event); offset = JSON.parse(issued.result.content[0].text).nextOffset;
  } while (offset !== null);
}

async function disclosureContext(f, review) {
  return { review, graph: f.evidence.skillGroundTruth, citations: await f.progress.getSourceCitations(review),
    snapshot: f.evidence.snapshot, processSource: await captureConditionSnapshot(f.evidence.snapshot, f.transcriptPath) };
}

function disclosureFailure(context) {
  let error;
  assert.throws(() => validateSkillConditionalReview(context), caught => {
    error = caught; assert.equal(caught.code, 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE'); return true;
  });
  const detail = JSON.parse(error.message.slice(error.message.indexOf('{')));
  assert.equal(detail.navigationOnly, true); assert(detail.missingOriginalIds.length <= 16);
  assert.equal(detail.omittedCount, detail.missingCount - detail.missingOriginalIds.length);
  assert.deepEqual(detail.recoverWith, { tool: 'rc_skill_care', action: 'inventory', prefix: 'execution/', offset: 0 });
  return { error, detail };
}

test('ACTIVE PROCESS result-only disclosure names the invocation and genuinely acknowledged paired reads can recover', async t => {
  const f = await fixture(t, { text: 'If requested, run the public verification.', interpret: unit => interpretSkillUnit(unit, {
    scope: 'EXTERNAL_TRIGGER', external: [{ condition: 'If requested,', duty: 'run the public verification.' }] }) });
  await disclose(f, 'skill/SKILL.md', 'basis'); await disclose(f, 'execution/2', 'result');
  const review = disclosureReview(f), before = structuredClone(review);
  const first = disclosureFailure(await disclosureContext(f, review));
  assert.deepEqual(first.detail.missingOriginalIds, ['execution/1']); assert.equal(first.detail.missingCount, 1);
  assert.match(first.detail.field, /conditionalAssessments\/0\/actualEvidence/);
  assert.deepEqual(review, before, 'diagnostics never rewrite a submitted review or inherit PASS');
  const issued = await f.issue('unacknowledged-invocation', { action: 'read', id: 'execution/1' });
  disclosureFailure(await disclosureContext(f, review));
  await f.persist(issued.event);
  const fresh = disclosureReview(f); fresh.summary = 'Entire fresh review after actual paired original disclosure.';
  const checked = validateSkillConditionalReview(await disclosureContext(f, fresh));
  assert.equal(checked.unresolved, false); assert.equal(checked.bindings[0].judgement, 'PASS');
  assert.deepEqual(review, before, 'the original failed candidate remains unchanged');
});

test('navigation, plain transcript, partial pages and foreign-session writes cannot replace invocation disclosure', async t => {
  for (const mode of ['navigation-and-transcript', 'half-page', 'wrong-session']) await t.test(mode, async t => {
    const f = await fixture(t); await disclose(f, 'skill/SKILL.md', 'basis'); await disclose(f, 'execution/2', 'result');
    if (mode === 'navigation-and-transcript') {
      const nav = await f.issue('inventory-only', { action: 'inventory', prefix: 'execution/' }); await f.persist(nav.event);
      await fs.readFile(f.transcriptPath, 'utf8');
    } else {
      const read = await f.issue('incomplete-or-foreign', { action: 'read', id: 'execution/1', ...(mode === 'half-page' ? { limit: 1 } : {}) });
      await f.persist(read.event, mode === 'wrong-session' ? { ...f.hostContext(read.event), sessionKey: 'agent:other:private' } : undefined);
    }
    const context = await disclosureContext(f, disclosureReview(f)); disclosureFailure(context);
    assert(context.citations.filter(c => c.readProof.owner === 'PROCESS').every(c => !c.readProof.processActionEvidence && !c.readProof.executionEvidence));
  });
});

test('explicit uncertainty, checker errors and DEVIATION keep their original unresolved path without new recovery', async t => {
  const f = await fixture(t); await disclose(f, 'skill/SKILL.md', 'basis'); await disclose(f, 'execution/2', 'result');
  for (const mode of ['UNKNOWN', 'UNVERIFIED', 'checkerError', 'DEVIATION']) {
    const review = disclosureReview(f), item = review.conditionalAssessments[0];
    if (mode === 'UNKNOWN') { item.conditionAssessment.activation = 'UNKNOWN'; item.judgement = 'UNVERIFIED'; }
    if (mode === 'UNVERIFIED') item.judgement = 'UNVERIFIED';
    if (mode === 'checkerError') review.checkerError = 'The original process remains uncertain.';
    if (mode === 'DEVIATION') item.judgement = 'DEVIATION';
    const before = structuredClone(review), checked = validateSkillConditionalReview(await disclosureContext(f, review));
    assert.equal(checked.unresolved, true, mode); assert.equal(checked.bindings[0].judgement, 'UNVERIFIED', mode);
    assert.deepEqual(review, before, mode);
  }
});

test('an independent observed violation survives another condition missing invocation disclosure', async t => {
  const entries = [{ type: 'user', message: { content: 'Deliver the result and preserve the supplied original contract.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'actual-verify', name: 'Bash', input: { command: 'public-verifier' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'actual-verify', content: 'Exit code 0' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'independent-write', name: 'Write', input: { file_path: 'requirements/original-contract.md', content: 'Changed original.' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'independent-write', content: 'Write completed.' }] } },
    { type: 'assistant', message: { content: 'Completed.' } }];
  const f = await fixture(t, { entries, text: 'Keep the supplied original contract read-only.\n\nIf a later correction changes the deliverable, run verification again.',
    interpret: (unit, i) => i === 0 ? interpretSkillUnit(unit) : interpretSkillUnit(unit, { scope: 'EXTERNAL_TRIGGER',
      external: [{ condition: 'If a later correction changes the deliverable,', duty: 'run verification again.' }] }) });
  for (const id of ['skill/SKILL.md', 'execution/2', 'execution/3', 'execution/4', 'execution/5']) await disclose(f, id, id);
  const review = disclosureReview(f), independent = f.evidence.skillGroundTruth.constraints.find(c => !c.sourceInterpretation.externalConditions.length);
  review.conditionalAssessments[0].actualEvidence = ['skill/SKILL.md', 'execution/2', 'execution/5'];
  review.findings = [{ deviationKey: 'independent-readonly-violation', violatedGroundTruthIds: [independent.constraintId],
    reason: 'The original contract is required read-only; the distinct Write invocation and completed result contradict that duty.',
    actualEvidence: ['execution/3', 'execution/4'] }];
  const before = structuredClone(review), checked = validateSkillConditionalReview(await disclosureContext(f, review));
  assert.equal(checked.unresolved, true); assert.equal(checked.bindings[0].judgement, 'UNVERIFIED');
  assert.equal(review.findings.length, 1); assert.deepEqual(review, before, 'no new throw may swallow the independent finding');
});

test('source semantic uncertainty, stale contexts and ambiguous call pairs stay closed', async t => {
  const f = await fixture(t, { text: 'If requested, run the public verification.', interpret: unit => interpretSkillUnit(unit, {
    scope: 'EXTERNAL_TRIGGER', external: [{ condition: 'If requested,', duty: 'run the public verification.' }] }) });
  await disclose(f, 'skill/SKILL.md', 'basis'); await disclose(f, 'execution/2', 'result');
  for (const disposition of ['CONFLICT', 'UNCERTAIN']) {
    const review = disclosureReview(f); review.sourceInterpretationReviews[0].disposition = disposition;
    assert.equal(validateSkillConditionalReview(await disclosureContext(f, review)).unresolved, true, disposition);
  }
  const legacy = await fixture(t); await disclose(legacy, 'skill/SKILL.md', 'basis'); await disclose(legacy, 'execution/2', 'result');
  const context = await disclosureContext(legacy, disclosureReview(legacy));
  for (const changed of [{ ...context, graph: { ...context.graph, version: 999 } },
    { ...context, processSource: { ...context.processSource, complete: false } },
    { ...context, processSource: { ...context.processSource, cursor: 'stale' } },
    { ...context, citations: context.citations.map(c => ({ ...c, readProof: { ...c.readProof, processCursor: 'stale' } })) }])
    assert.equal(validateSkillConditionalReview(changed).unresolved, true);
  const entries = structuredClone(legacy.evidence.snapshot.entries); entries.splice(2, 0, structuredClone(entries[1]));
  const ambiguous = await fixture(t, { entries }); await disclose(ambiguous, 'skill/SKILL.md', 'basis'); await disclose(ambiguous, 'execution/3', 'result');
  assert.equal(validateSkillConditionalReview(await disclosureContext(ambiguous, disclosureReview(ambiguous))).unresolved, true);
  await fs.appendFile(path.join(f.evidence.skillSource.root, 'SKILL.md'), '\nChanged original authority.');
  const staleSource = await disclosureContext(f, disclosureReview(f));
  assert(staleSource.citations.every(c => c.readProof.basisComplete === false));
  assert.throws(() => validateSkillConditionalReview(staleSource), /INTERPRETATION_EVIDENCE/);
});

test('many uniquely current missing invocations have honest bounded previews without echoing long call IDs', async t => {
  const entries = [{ type: 'user', message: { content: 'Complete the requested workflow.' } }], longId = '真实调用🙂'.repeat(300), results = [];
  for (let i = 0; i < 40; i++) {
    const id = `${i}-${longId}`;
    entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'public-verifier' } }] } });
    results.push(entries.length); entries.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Exit code 0' }] } });
  }
  entries.push({ type: 'assistant', message: { content: 'Completed.' } });
  const f = await fixture(t, { entries }); await disclose(f, 'skill/SKILL.md', 'basis');
  for (const index of results) await disclose(f, `execution/${index}`, `result-${index}`);
  const review = disclosureReview(f); delete review.conditionalAssessments[0].conditionAssessment.afterCallId;
  const { error, detail } = disclosureFailure(await disclosureContext(f, review));
  assert.equal(detail.missingCount, 40); assert.equal(detail.missingOriginalIds.length, 16); assert.equal(detail.omittedCount, 24);
  assert(detail.missingOriginalIds.every(id => /^execution\/[0-9]+$/u.test(id)));
  assert(!error.message.includes(longId), 'arbitrary long call IDs are not submit-ready previews');
  assert(Buffer.byteLength(error.message) < 2048, 'leave ample space for the unchanged full-review repair instruction');
});
