// Registered-handler and native receipt-event controls. Scripted appraisals are
// transport witnesses, never evidence that a model understood the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { resolveStopReviewPolicy } from '../lib/runtime-v2/metric-policy.mjs';
import { buildMetricPopulation, buildOriginalStopPopulation } from '../lib/runtime-v2/metrics.mjs';
import { recordDeviationFindings } from '../lib/runtime-v2/deviations.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { atomicWriteJson, sha256 } from '../lib/runtime-v2/utils.mjs';
import { observeKnownOriginalObligations, knownOriginalObligations, knownOriginalObligationReader } from '../lib/runtime-v2/known-original-obligations.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { selectImplementationChallengeSubjects } from '../lib/runtime-v2/implementation-challenge.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';

const domains = [
  { name: 'publication', duty: 'Publish an artifact only after its durable transfer succeeds.',
    code: 'export async function send(item) {\n  await store(item);\n  announce(item);\n}\n' },
  { name: 'permission', duty: 'Every mutating dispatch path must check the caller permission.',
    code: 'export function dispatch(caller) {\n  if (!allowed(caller)) return;\n  mutate(caller);\n}\n' },
  { name: 'ownership', duty: 'Transfer a lease only after the previous owner releases it.',
    code: 'export async function transfer(owner) {\n  await released(owner);\n  acquire(owner);\n}\n' },
];
const span = (result, start = 1, end = start) => ({ citeId: result.details.citation.citeId, start, end });
async function savedChallengeItem(handle) {
  const snapshot = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  return JSON.parse(await fs.readFile(path.join(handle.artifacts, 'items', sha256(snapshot.frames[0].objectId) + '.json'))).result;
}

async function fixture(t, { domain = domains[0], extra = false, carry = false, known = false, conditional = false, four = false, unformed = false, sampled = false, omitRole = false } = {}) {
  const f = await stopProtocolFixture(t, 'findings');
  const duty = conditional ? `When transfer is requested, ${domain.duty.toLowerCase()}` : domain.duty;
  const duties = [duty, ...(four ? domains.slice(1).map(item => item.duty) : []), ...(extra || four ? ['Preserve the emitted record identifier.'] : [])];
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  f.input.request.classificationContract = 2;
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, metrics: { M16: true }, ...(sampled ? { implementationChallengeMode: 'sampled' } : {}) });
  f.input.evidence.snapshot.entries[0].message.content = duties.join('\n');
  f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  const file = path.join(f.root, 'producer.mjs'); await fs.writeFile(file, domain.code);
  let candidate;
  if (known) {
    const source = f.input.evidence.originalRequirements.userMessages[0];
    const anchor = createOriginalSourceAnchor({ ref: source.ref, sha256: source.sha256, bytes: Buffer.from(source.text), start: 1, end: 1 });
    const dir = path.join(f.root, 'openspec/changes/ordered-transfer'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'proposal.md'), '# Duty\n' + duty + '\n'); await fs.writeFile(path.join(dir, 'tasks.md'), '- [ ] Preserve the original order.\n');
    const plan = await readOpenSpecPlan(f.root, 'ordered-transfer');
    const owner = { projectRoot: f.root, sessionId: 'protocol-host', sessionKey: 'agent:main:s', scopeTaskId: f.input.taskId,
      projectScope: { fingerprint: 'scope' }, nativeRunId: 'proposal-run', reviewController: new AbortController() };
    assert(await observeKnownOriginalObligations(owner, { file: 'openspec/changes/ordered-transfer/tasks.md', sources: [source],
      receipt: { schemaVersion: 1, runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', scope: plan.documents,
        rows: [{ source: anchor, requirement: duty, disposition: 'COVERED', reason: 'Prior source-bound plan observation.',
          targets: [{ ...plan.documents[0], start: 1, end: 2 }] }] },
      publication: { runId: 'proposal-run', taskId: f.input.taskId, sessionId: 'protocol-host', result: { status: 'passed',
        metadata: { inputs: plan.documents, semanticReview: { status: 'completed' } } } } }));
    candidate = knownOriginalObligations(owner).items[0]; f.input.readKnownOriginalObligations = knownOriginalObligationReader(owner);
  }
  if (carry) {
    const source = f.input.evidence.originalRequirements.userMessages[0];
    const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.input.taskId,
      groundTruth: { version: 0, claims: [] }, persist: false });
    const [object] = buildOriginalStopPopulation({ population, sourceDigest: f.input.evidence.originalRequirements.digest,
      checklist: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', text: duty,
        source: { kind: 'USER_MESSAGE', ref: source.ref, part: 1, sha256: source.sha256, start: 1, end: 1 } }] }).population.metrics.M16;
    const evaluationId = 'stop-0123456789abcdef';
    await recordDeviationFindings({ projectRoot: f.root, taskId: f.input.taskId, pipeline: 'STOP', evaluationId, delivered: true,
      findings: [{ deviationKey: `metric:M16:${object.sourceId}`, rootCauseId: 'REQUIREMENT_OMITTED', severity: 'error',
        reason: 'The earlier delivery omitted the original ordering guarantee.', violatedGroundTruthIds: [object.sourceId] }] });
    await atomicWriteJson(path.join(taskDirectory(f.root, f.input.taskId), 'evaluations', `${evaluationId}.json`), {
      originalRequirementsDigest: f.input.evidence.originalRequirements.digest,
      metricReport: { metrics: [{ objects: [{ ...object, judgement: 'DEVIATION' }] }] },
    });
  }
  async function prepare(tools, { preImplementation = false } = {}) {
    await tools.readAll();
    const original = await tools.read(tools.brief.task.basisFiles.find(p => path.basename(p).startsWith('user-original-0')));
    const page = await tools.submit('set_original_checklist', { items: duties.map((text, i) => ({
      metricId: 'M16', verificationTarget: 'IMPLEMENTATION', ...(!omitRole ? { implementationRole: 'PRODUCTION' } : {}), text,
      ...(known && !unformed && i === 0 ? { text: 'Narrow supplied wording.', knownCandidateId: candidate.id, knownDutyReason: 'The entire cited duty corresponds to the complete retained original candidate.' } : {}),
      ...(unformed && i === 0 ? { text: 'Preserve durable identifiers.' } : {}),
      ...(conditional ? { applicability: 'A caller requests transfer.' } : {}),
      citeId: original.details.citation.citeId, lineStart: i + 1, lineEnd: i + 1,
    })), scope: { stopClassification: preImplementation ? 'STAGE_COMPLETE' : 'TASK_COMPLETE',
      ...(preImplementation ? { stage: 'design' } : {}), completionClaim: true, limit: 20 } });
    const object = unformed ? page.items.find(item => item.metricId === 'M16') : page.items.find(item => item.description === duty);
    const code = await tools.read(file);
    return { object, page, original, code };
  }
  const question = p => ({ objectId: p.object.objectId, original: span(p.original), entry: span(p.code, 1), decision: span(p.code, 2),
    allowedClass: 'A caller invokes the original operation while the prerequisite has not succeeded.',
    requiredOutcome: 'The observable effect must not precede its original prerequisite.',
    alternativeRoute: 'The prerequisite returns without preventing the later effect.',
    predictedOutcome: 'The observable effect occurs before the original prerequisite is satisfied.',
    feasibilityReason: 'Inspect the actual decision and the following effect rather than relying on a report.' });
  const resolve = (p, id, assessment = 'REFUTED', correctionReason) => ({ challengeId: id,
    steps: [{ source: span(p.code, 2), valueClass: 'The prerequisite has not succeeded.', decision: 'NOT_TAKEN',
      consequence: 'The following effect is not reached along this candidate route.' }],
    result: span(p.code, 3), assessment, appraisal: 'This scripted source-linked appraisal tests the actual receipt handlers.',
    ...(assessment === 'REFUTED' ? { refutingSource: span(p.code, 2), refutationReason: 'This selected source step blocks the proposed route.' } : {}),
    ...(correctionReason ? { correctionReason } : {}) });
  const frame = async (tools, p, input = question(p)) => (await tools.submit('review_implementation_challenge', { phase: 'FRAME', frames: [input] })).frames[0];
  const resolved = async (tools, p, id, assessment, correctionReason) => (await tools.submit('review_implementation_challenge', {
    phase: 'RESOLVE', resolutions: [resolve(p, id, assessment, correctionReason)],
  })).resolutions[0];
  const finish = (tools, ref) => tools.submit('finish_stop_review', { summary: 'The bounded scripted appraisal is recorded.',
    ...(ref ? { implementationChallenges: [{ objectId: ref.objectId, receiptId: ref.receiptId }] } : {}) });
  // The reviewer factory may convert a callback failure to a failed review.
  // Propagate every unexpected scripted callback error; partial artifacts are not test success.
  const run = async (script, ...settings) => {
    let assertion;
    try { return await f.run(async tools => {
      try { return await script(tools); }
      catch (error) { assertion ??= error; throw error; }
    }, ...settings); } finally { if (assertion) throw assertion; }
  };
  return { ...f, run, file, duties, candidate, prepare, question, resolve, frame, resolved, finish };
}

for (const domain of domains) test(`registered challenge binds a refuted ${domain.name} route without a new read`, async t => {
  const f = await fixture(t, { domain });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p);
    assert.equal(frame.actualDecision.selection.citeId, p.code.details.citation.citeId);
    assert.equal(frame.actualDecision.previewComplete, true);
    const result = await f.resolved(tools, p, frame.challengeId);
    assert.equal(result.assessment, 'REFUTED');
    assert.equal((await f.finish(tools, result)).complete, true);
  });
  assert.equal(handle.reviewCompleted, true);
  const review = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'review.json')));
  assert.equal(review.reviewEvidence.implementationChallenges.status, 'PARTIAL_SCOPE');
  assert.equal(review.reviewEvidence.implementationChallenges.semanticsVerified, false);
  assert.equal(review.unverifiedItems.length, 0);
});

test('no opened challenge preserves the ordinary method-not-exercised result', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => { await f.prepare(tools); await f.finish(tools); });
  const review = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'review.json')));
  assert.equal(review.reviewEvidence.implementationChallenges.status, 'METHOD_NOT_EXERCISED');
  assert.equal(review.unverifiedItems.length, 0);
});

for (const assessment of ['PENDING', 'UNRESOLVED', 'COUNTEREXAMPLE'])
  test(`an opened ${assessment} challenge affects only its own object`, async t => {
    const f = await fixture(t, { extra: true }); let challenged, other;
    const handle = await f.run(async tools => {
      const p = await f.prepare(tools); challenged = p.object.objectId;
      other = p.page.items.find(item => item.objectId !== challenged).objectId;
      const framed = await f.frame(tools, p);
      const result = assessment === 'PENDING' ? null : await f.resolved(tools, p, framed.challengeId, assessment);
      await f.finish(tools, result);
    });
    assert(handle.result.unverifiedItems.some(item => item.objectId === challenged));
    assert(!handle.result.unverifiedItems.some(item => item.objectId === other));
    assert.equal(handle.result.metricObjectJudgements.length, 0, 'challenge prose never mints a saved deviation');
  });

test('a concrete contrary route still needs the existing saved deviation', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p);
    const result = await f.resolved(tools, p, framed.challengeId, 'COUNTEREXAMPLE');
    await tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'DEVIATION',
      reason: 'The cited producer reaches its effect before the required prerequisite.', citeIds: [p.code.details.citation.citeId] });
    await f.finish(tools, result);
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'DEVIATION');
});

test('foreign, pending and synthetic source offers cannot frame a challenge', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    await assert.rejects(f.frame(tools, p, { ...f.question(p), objectId: 'M16:foreign' }), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' });
    await assert.rejects(tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'UNVERIFIED', reason: 'No challenge is open.', implementationChallengeReceiptId: 'unowned' }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    const pending = await tools.read(f.file, { receipt: false });
    await assert.rejects(f.frame(tools, p, { ...f.question(p), decision: span(pending, 2) }), { code: 'IMPLEMENTATION_CHALLENGE_EVIDENCE' });
    const altered = await tools.read(f.file, { alter: true });
    await assert.rejects(f.frame(tools, p, { ...f.question(p), decision: span(altered, 2) }), { code: 'IMPLEMENTATION_CHALLENGE_EVIDENCE' });
    const fake = { ...f.resolve(p, 'guessed-unissued-frame') };
    await assert.rejects(tools.submit('review_implementation_challenge', { phase: 'RESOLVE', resolutions: [fake] }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await assert.rejects(f.finish(tools, { objectId: p.object.objectId, receiptId: 'guessed-unissued-result' }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await f.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 0);
});

test('frames are immutable and exactly one explicit resolution correction is retained', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p);
    assert.equal((await f.frame(tools, p)).challengeId, framed.challengeId);
    await assert.rejects(f.frame(tools, p, { ...f.question(p), alternativeRoute: 'A different question.' }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    const first = await f.resolved(tools, p, framed.challengeId, 'UNRESOLVED');
    const second = await f.resolved(tools, p, framed.challengeId, 'REFUTED', 'The current source resolves the earlier uncertainty.');
    assert.notEqual(first.receiptId, second.receiptId);
    assert.equal((await f.resolved(tools, p, framed.challengeId, 'REFUTED', 'The current source resolves the earlier uncertainty.')).receiptId, second.receiptId);
    await assert.rejects(f.resolved(tools, p, framed.challengeId, 'REFUTED', 'A third changed resolution.'), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await f.finish(tools, second);
  });
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames[0].resolutions.length, 2);
});

test('a retained prior receipt cannot clear a corrected challenge', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p);
    const prior = await f.resolved(tools, p, framed.challengeId, 'UNRESOLVED');
    await f.resolved(tools, p, framed.challengeId, 'REFUTED', 'The current cited step resolves the question.');
    await f.finish(tools, prior);
  });
  assert.equal(handle.result.unverifiedItems.length, 1);
});

for (const stage of ['resolve', 'finish']) test(`source mutation before ${stage} cannot publish a retained witness`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p);
    const result = stage === 'finish' ? await f.resolved(tools, p, framed.challengeId) : null;
    await fs.appendFile(f.file, '// changed source\n');
    if (stage === 'resolve') await f.resolved(tools, p, framed.challengeId);
    else await f.finish(tools, result);
  }), /CHANGED|changed/);
});

test('a challenged carried PASS needs its own current resolved receipt', async t => {
  const f = await fixture(t, { carry: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert(p.object.previousDeviation);
    const framed = await f.frame(tools, p);
    await assert.rejects(tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'PASS',
      reason: 'The carried obligation was checked.', citeIds: [p.code.details.citation.citeId] }), { code: 'IMPLEMENTATION_CHALLENGE_PENDING' });
    const result = await f.resolved(tools, p, framed.challengeId);
    await tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'PASS',
      reason: 'The current source supports this scripted carried assessment.', citeIds: [p.code.details.citation.citeId],
      implementationChallengeReceiptId: result.receiptId });
    await f.finish(tools, result);
  });
  assert.equal((await savedChallengeItem(handle)).judgement, 'PASS');
});

test('well-formed but wrong semantic appraisal is not host-proved truth', async t => {
  const f = await fixture(t, { domain: { ...domains[1], code: 'export function dispatch(caller) {\n  mutate(caller);\n  if (!allowed(caller)) return;\n}\n' } });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p);
    const result = await f.resolved(tools, p, framed.challengeId);
    await f.finish(tools, result);
  });
  const record = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(record.semanticsVerified, false);
  assert.equal(record.appraisalAuthority, 'REVIEWER_CLAIM');
  assert.equal(handle.result.unverifiedItems.length, 0, 'binding validation intentionally is not a semantic oracle');
});

test('the complete known canonical duty remains bound to the challenge subject', async t => {
  const f = await fixture(t, { known: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert.equal(p.object.description, f.duties[0]);
    const framed = await f.frame(tools, p), result = await f.resolved(tools, p, framed.challengeId);
    await tools.submit('finish_stop_review', { summary: 'The complete known subject was appraised.',
      implementationChallenges: [{ objectId: result.objectId, receiptId: result.receiptId }],
      knownObligations: [{ id: f.candidate.id, disposition: 'CURRENT', objectId: p.object.objectId,
        verdict: 'NO_CONFIRMED_DEVIATION', reason: 'This scripted current-source appraisal retains the complete original subject.',
        citeIds: [p.code.details.citation.citeId] }] });
  });
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames[0].subject.description, f.duties[0]);
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'CURRENT');
});

test('an actual conditional exclusion keeps its existing evidence rules despite an opened frame', async t => {
  const f = await fixture(t, { conditional: true, known: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); await f.frame(tools, p);
    await assert.rejects(tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'This channel does not admit fresh positive or exclusion rows.' }), { code: 'TASK_SUBMISSION_INVALID' });
    const result = await tools.submit('finish_stop_review', { summary: 'The actual current known exclusion channel is used.',
      knownObligations: [{ id: f.candidate.id, disposition: 'CURRENT', objectId: p.object.objectId,
        verdict: 'NOT_APPLICABLE', reason: 'Current source facts establish the original trigger is inactive.',
        citeIds: [p.code.details.citation.citeId], conditionAssessment: { activation: 'INACTIVE_AT_CURRENT_BOUNDARY',
          evidenceKind: 'TARGET_FACTS', reason: 'Current source facts support the original conditional exclusion.' } }] });
    assert.equal(result.complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].verdict, 'NOT_APPLICABLE');
  assert.equal(handle.result.unverifiedItems.length, 0);
});

test('pre-implementation scope cannot open a production challenge', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools, { preImplementation: true });
    await assert.rejects(f.frame(tools, { ...p, object: { objectId: 'M16:unselected' } }), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' });
    await f.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 0);
});

test('UTF-8 witness size and the three-object bound do not spill into other items', async t => {
  const f = await fixture(t, { four: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    const large = '界'.repeat(700);
    await assert.rejects(f.frame(tools, p, { ...f.question(p), allowedClass: large, requiredOutcome: large, alternativeRoute: large }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    const frames = f.duties.slice(0, 3).map((duty, index) => ({ ...f.question(p),
      objectId: p.page.items.find(item => item.description === duty).objectId, original: span(p.original, index + 1) }));
    await tools.submit('review_implementation_challenge', { phase: 'FRAME', frames });
    const last = { ...f.question(p), objectId: p.page.items.find(item => item.description === f.duties[3]).objectId, original: span(p.original, 4) };
    await assert.rejects(f.frame(tools, p, last), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await f.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 3);
});

test('a late canonical correspondence cannot borrow a narrower challenge subject', async t => {
  const f = await fixture(t, { known: true, unformed: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert.notEqual(p.object.description, f.duties[0]);
    const frame = await f.frame(tools, p), result = await f.resolved(tools, p, frame.challengeId);
    const final = { summary: 'The broader retained subject cannot borrow a narrow witness.',
      implementationChallenges: [{ objectId: result.objectId, receiptId: result.receiptId }],
      knownObligations: [{ id: f.candidate.id, disposition: 'CURRENT', objectId: p.object.objectId, verdict: 'NO_CONFIRMED_DEVIATION',
        reason: 'The complete current retained duty is submitted for accounting.', citeIds: [p.code.details.citation.citeId],
        corroboration: { citeId: p.original.details.citation.citeId, start: 1, end: 1, reason: 'The full current original span corresponds to the complete retained duty.' } }] };
    const offered = await tools.submit('finish_stop_review', final);
    assert.equal(offered.complete, false);
    assert.equal(offered.pendingKnownOriginalCount, 1);
    assert.equal((await tools.submit('finish_stop_review', final)).complete, true);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
});

test('same-assistant guessed resolution cannot borrow a newly generated frame', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), tool = tools.tools.get('review_implementation_challenge');
    tools.advance();
    const [first, forged] = await Promise.allSettled([
      tool.execute('batch-frame', { phase: 'FRAME', frames: [f.question(p)] }),
      tool.execute('batch-resolve', { phase: 'RESOLVE', resolutions: [f.resolve(p, 'guessed-future-frame')] }),
    ]);
    assert.equal(first.status, 'fulfilled'); assert.equal(forged.status, 'rejected');
    assert.equal(forged.reason.code, 'IMPLEMENTATION_CHALLENGE_INVALID');
    const framed = JSON.parse(first.value.content[0].text).frames[0];
    const resolved = await f.resolved(tools, p, framed.challengeId);
    await f.finish(tools, resolved);
  });
  assert.equal(handle.result.unverifiedItems.length, 0);
});

test('a real receipt from another review cannot resolve the current frame', async t => {
  const first = await fixture(t); let foreign;
  await first.run(async tools => { const p = await first.prepare(tools); foreign = await first.frame(tools, p); await first.finish(tools); });
  const second = await fixture(t);
  const handle = await second.run(async tools => {
    const p = await second.prepare(tools);
    await assert.rejects(second.resolved(tools, p, foreign.challengeId), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await second.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 0);
});

test('an opened challenge cannot renew the original reviewer deadline', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p), future = Date.now() + 600000;
    const mocked = t.mock.method(Date, 'now', () => future);
    try { await f.resolved(tools, p, framed.challengeId); } finally { mocked.mock.restore(); }
  }), /DEADLINE|deadline/);
  assert.equal(f.calls.length, 1);
});

test('cancellation remains authoritative after a frame is recorded', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  let actualAbortObserved = false;
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), framed = await f.frame(tools, p); controller.abort(new Error('Owned challenge cancelled'));
    await assert.rejects(f.resolved(tools, p, framed.challengeId), error => {
      actualAbortObserved = error === controller.signal.reason;
      return actualAbortObserved;
    });
    throw controller.signal.reason;
  }), error => error === controller.signal.reason);
  assert.equal(actualAbortObserved, true);
  assert.equal(f.calls.length, 1);
});


test('concurrent registered FRAME calls retain one immutable frame for the same object', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), tool = tools.tools.get('review_implementation_challenge');
    tools.advance();
    const values = await Promise.all(Array.from({ length: 4 }, (_, i) => tool.execute(`parallel-same-${i}`, { phase: 'FRAME', frames: [f.question(p)] })));
    const frames = values.map(value => JSON.parse(value.content[0].text).frames[0]);
    assert.equal(new Set(frames.map(value => value.challengeId)).size, 1);
    const result = await f.resolved(tools, p, frames[0].challengeId);
    await f.finish(tools, result);
  });
  assert.equal(handle.reviewCompleted, true);
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames.length, 1); assert.equal(saved.frames[0].resolutions.length, 1);
});

test('concurrent registered distinct FRAME calls preserve the three-object cap and all stored frames', async t => {
  const f = await fixture(t, { four: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), tool = tools.tools.get('review_implementation_challenge');
    const inputs = f.duties.map((duty, index) => ({ ...f.question(p), objectId: p.page.items.find(item => item.description === duty).objectId,
      original: span(p.original, index + 1) }));
    tools.advance();
    const results = await Promise.allSettled(inputs.map((input, i) => tool.execute(`parallel-distinct-${i}`, { phase: 'FRAME', frames: [input] })));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 3);
    const rejected = results.filter(value => value.status === 'rejected');
    assert.equal(rejected.length, 1); assert.equal(rejected[0].reason.code, 'IMPLEMENTATION_CHALLENGE_INVALID');
    await f.finish(tools);
  });
  assert.equal(handle.reviewCompleted, true);
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames.length, 3); assert.equal(new Set(saved.frames.map(value => value.objectId)).size, 3);
  assert.equal(handle.result.unverifiedItems.length, 3);
});

test('concurrent registered RESOLVE calls retain one correction and cannot erase prior appraisals', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p), tool = tools.tools.get('review_implementation_challenge');
    const first = await f.resolved(tools, p, frame.challengeId, 'UNRESOLVED');
    tools.advance();
    const resolutions = [f.resolve(p, frame.challengeId, 'REFUTED', 'The selected source refutes the first uncertainty.'),
      f.resolve(p, frame.challengeId, 'REFUTED', 'A second distinct correction must not overwrite the first one.')];
    const results = await Promise.allSettled(resolutions.map((input, i) => tool.execute(`parallel-resolve-${i}`, { phase: 'RESOLVE', resolutions: [input] })));
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'IMPLEMENTATION_CHALLENGE_INVALID');
    const current = JSON.parse(results[0].value.content[0].text).resolutions[0];
    assert.notEqual(first.receiptId, current.receiptId); await f.finish(tools, current);
  });
  assert.equal(handle.reviewCompleted, true);
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames[0].resolutions.length, 2);
  assert.equal(saved.frames[0].resolutions[0].appraisal.assessment, 'UNRESOLVED');
  assert.equal(saved.frames[0].resolutions[1].appraisal.correctionReason, 'The selected source refutes the first uncertainty.');
});

test('nested whitespace witness fields cannot acquire a resolved receipt', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p);
    for (const field of ['valueClass', 'consequence']) {
      const input = f.resolve(p, frame.challengeId); input.steps[0][field] = ' \t\n ';
      await assert.rejects(tools.submit('review_implementation_challenge', { phase: 'RESOLVE', resolutions: [input] }), { code: 'TASK_SUBMISSION_INVALID' });
    }
    const result = await f.resolved(tools, p, frame.challengeId); await f.finish(tools, result);
  });
  assert.equal(handle.reviewCompleted, true);
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames[0].resolutions.length, 1);
});


async function recoverChallenge(tools, challengeId) {
  let args = { phase: 'READ', challengeId, offset: 0 }, text = '', digest, pages = 0;
  for (;;) {
    const page = await tools.submit('review_implementation_challenge', args); pages++;
    assert.equal(page.navigationOnly, true); assert.equal(page.semanticsVerified, false);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert.equal(Buffer.from(page.text).toString('utf8'), page.text);
    assert.equal(page.offset, Buffer.byteLength(text));
    digest ??= page.recordSha256; assert.equal(page.recordSha256, digest);
    text += page.text;
    if (page.nextOffset === null) break;
    assert.deepEqual(page.recoverWith.arguments, { phase: 'READ', challengeId, offset: page.nextOffset, recordSha256: digest });
    args = page.recoverWith.arguments;
  }
  assert.equal(sha256(Buffer.from(text)), digest);
  return { record: JSON.parse(text), pages };
}

test('compacted local arguments recover from retained host state without rereading or consuming a correction', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    let frame = await f.frame(tools, p), resolution = await f.resolved(tools, p, frame.challengeId, 'UNRESOLVED');
    assert.equal(typeof tools.params.onAgentEvent, 'function');
    await tools.params.onAgentEvent({ stream: 'compaction', data: { summary: 'Earlier local arguments omitted.' } });
    frame = resolution = null;
    const index = await tools.submit('review_implementation_challenge', { phase: 'INSPECT' });
    assert.equal(index.items.length, 1); assert.equal(index.nextOffset, null);
    const { record } = await recoverChallenge(tools, index.items[0].challengeId);
    assert.deepEqual(record.question, f.question(p)); assert.equal(record.latest.appraisal.assessment, 'UNRESOLVED');
    assert.equal(record.latest.receiptId, index.items[0].latestReceiptId); assert.equal(record.correctionRemaining, 1);
    assert(record.sourceBindings.every(ref => ref.selection.citeId && ref.sha256 && ref.rangeSha256));
    const result = await f.resolved(tools, p, record.challengeId, 'REFUTED', 'Current retained source resolves the recorded uncertainty.');
    await f.finish(tools, result);
  });
  assert.equal(handle.reviewCompleted, true); assert.equal(f.calls.length, 1);
});

test('tampering with the diagnostic JSON cannot change the retained recovery question or receipt', async t => {
  const f = await fixture(t); let artifacts;
  f.input.onPrepared = ({ requestDirectory }) => { artifacts = requestDirectory; };
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p), resolved = await f.resolved(tools, p, frame.challengeId);
    const artifact = path.join(artifacts, 'implementation-challenges.json');
    const changed = JSON.parse(await fs.readFile(artifact)); changed.frames[0].question.allowedClass = 'Forged replacement data';
    changed.frames[0].resolutions[0].receiptId = 'forged-receipt'; await fs.writeFile(artifact, JSON.stringify(changed));
    const { record } = await recoverChallenge(tools, frame.challengeId);
    assert.deepEqual(record.question, f.question(p)); assert.equal(record.latest.receiptId, resolved.receiptId);
    await f.finish(tools, resolved);
  });
  assert.equal(handle.reviewCompleted, true);
});

test('paged recovery roundtrips Unicode questions and source bindings under the response byte cap', async t => {
  const f = await fixture(t, { four: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    const inputs = f.duties.slice(0, 3).map((duty, index) => ({ ...f.question(p),
      objectId: p.page.items.find(item => item.description === duty).objectId, original: span(p.original, index + 1),
      allowedClass: '界'.repeat(550) }));
    const frames = (await tools.submit('review_implementation_challenge', { phase: 'FRAME', frames: inputs })).frames;
    for (const frame of frames) {
      const input = { ...f.resolve(p, frame.challengeId), appraisal: '界'.repeat(550) };
      await tools.submit('review_implementation_challenge', { phase: 'RESOLVE', resolutions: [input] });
    }
    const index = []; let args = { phase: 'INSPECT', offset: 0 };
    do {
      const page = await tools.submit('review_implementation_challenge', args);
      assert(Buffer.byteLength(JSON.stringify(page)) <= 8192); index.push(...page.items); args = page.recoverWith?.arguments;
    } while (args);
    assert.equal(index.length, 3);
    const refs = [];
    for (const [i, item] of index.entries()) {
      const { record, pages } = await recoverChallenge(tools, item.challengeId);
      assert(pages >= 2); assert.deepEqual(record.question, inputs[i]); assert.equal(record.latest.appraisal.appraisal, '界'.repeat(550));
      assert.equal(record.correctionRemaining, 1); refs.push({ objectId: item.objectId, receiptId: record.latest.receiptId });
    }
    await assert.rejects(tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: index[0].challengeId, offset: 1 }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await assert.rejects(tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: index[0].challengeId, recordSha256: 'foreign-digest' }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    await tools.submit('finish_stop_review', { summary: 'Only retained source-bound records were recovered.', implementationChallenges: refs });
  });
  assert.equal(handle.reviewCompleted, true);
  const saved = JSON.parse(await fs.readFile(path.join(handle.artifacts, 'implementation-challenges.json')));
  assert.equal(saved.frames.length, 3); assert(saved.frames.every(frame => frame.resolutions.length === 1));
});

test('foreign review challenges cannot be recovered by a fresh worker', async t => {
  const first = await fixture(t); let foreign;
  await first.run(async tools => { const p = await first.prepare(tools); foreign = await first.frame(tools, p); await first.finish(tools); });
  const second = await fixture(t);
  const handle = await second.run(async tools => {
    await second.prepare(tools);
    await assert.rejects(tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: foreign.challengeId }), { code: 'IMPLEMENTATION_CHALLENGE_INVALID' });
    const index = await tools.submit('review_implementation_challenge', { phase: 'INSPECT' }); assert.equal(index.items.length, 0);
    assert.equal(index.status, 'METHOD_NOT_EXERCISED'); await second.finish(tools);
  });
  assert.equal(handle.reviewCompleted, true);
});

test('current source mutation rejects recovery before it can return an old record', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p); await fs.appendFile(f.file, '// source changed\n');
    await tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: frame.challengeId });
  }), /CHANGED|changed/);
});

test('recovery retains the original cancellation check', async t => {
  const f = await fixture(t), controller = new AbortController(); f.input.abortSignal = controller.signal;
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p); controller.abort(new Error('Owned recovery cancelled'));
    await tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: frame.challengeId });
  }), error => error === controller.signal.reason);
});

test('recovery cannot renew an expired original deadline', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async tools => {
    const p = await f.prepare(tools), frame = await f.frame(tools, p), future = Date.now() + 600000;
    const mocked = t.mock.method(Date, 'now', () => future);
    try { await tools.submit('review_implementation_challenge', { phase: 'READ', challengeId: frame.challengeId }); }
    finally { mocked.mock.restore(); }
  }), /DEADLINE|deadline/);
  assert.equal(f.calls.length, 1);
});

test('the test harness exposes intentional callback assertions and unexpected callback errors', async t => {
  for (const unexpected of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(f.run(async tools => {
      const p = await f.prepare(tools); await f.frame(tools, p);
      if (unexpected) throw new TypeError('Owned unexpected callback failure');
      assert.fail('Owned callback assertion witness');
    }), error => unexpected ? error instanceof TypeError && error.message === 'Owned unexpected callback failure'
      : error.code === 'ERR_ASSERTION' && error.message === 'Owned callback assertion witness');
  }
});


const sampling = handle => handle.reviewEvidence.implementationChallenges;
const selectedPageObjects = p => p.page.implementationChallenges.selection.selected.map(({ objectId }) => p.page.items.find(item => item.objectId === objectId));
const questionFor = (f, p, object) => ({ ...f.question({ ...p, object }), original: span(p.original, f.duties.indexOf(object.description) + 1) });
async function resolveSelected(f, tools, p, object) {
  const local = { ...p, object };
  const frame = await f.frame(tools, local, questionFor(f, p, object));
  return f.resolved(tools, local, frame.challengeId);
}

test('sample selection is capped and stable under frozen cohort enumeration reorder', () => {
  const subjects = Array.from({ length: 7 }, (_, i) => ({ objectId: `host-${i}`, sourceRevisionId: `duty-${i}@1`,
    description: `Preserve original production duty ${i}.`, originalSource: { ref: 'original-user', sha256: 'a'.repeat(64), start: i + 1, end: i + 1 },
    applicabilityKind: 'CURRENT_TASK', proofOwners: ['SOURCE'] }));
  const first = selectImplementationChallengeSubjects(subjects), second = selectImplementationChallengeSubjects([...subjects].reverse());
  assert.deepEqual(first, second); assert.equal(first.selected.length, 3); assert.equal(first.eligibleCount, 7);
  assert.equal(new Set(first.selected.map(item => item.objectId)).size, 3); assert.equal(first.semanticsVerified, false);
  const changed = structuredClone(subjects); changed[0].description += ' Preserve the original refusal branch.';
  assert.notEqual(selectImplementationChallengeSubjects(changed).cohortDigest, first.cohortDigest);
  assert.throws(() => selectImplementationChallengeSubjects([subjects[0], subjects[0]]), /unique host object IDs/);
});

test('sampled mode announces a frozen host cohort early and missing method affects only selected duties', async t => {
  const f = await fixture(t, { sampled: true, four: true }); let selectedIds, other;
  const handle = await f.run(async tools => {
    assert.match(tools.params.extraSystemPrompt, /Experimental sampled challenge mode/);
    const p = await f.prepare(tools), plan = p.page.implementationChallenges.selection;
    assert.equal(plan.status, 'SELECTED'); assert.equal(plan.selected.length, 3); assert.equal(plan.eligibleCount, 4);
    selectedIds = plan.selected.map(item => item.objectId); other = p.page.items.find(item => !selectedIds.includes(item.objectId)).objectId;
    assert(p.page.items.filter(item => item.implementationChallengeRequired).every(item => selectedIds.includes(item.objectId)));
    const again = await tools.submit('review_checklist', { offset: 0, limit: 20 });
    assert.deepEqual(again.implementationChallenges.selection, plan);
    const pending = await tools.submit('review_checklist', { view: 'pending', offset: 0, limit: 20 });
    assert.deepEqual(pending.items.filter(item => item.type === 'IMPLEMENTATION_CHALLENGE').map(item => item.objectId).sort(), [...selectedIds].sort());
    await f.finish(tools);
  });
  assert.deepEqual(handle.result.unverifiedItems.map(item => item.objectId).sort(), [...selectedIds].sort());
  assert(!handle.result.unverifiedItems.some(item => item.objectId === other)); assert.equal(handle.result.metricObjectJudgements.length, 0);
  assert.equal(sampling(handle).status, 'METHOD_NOT_EXERCISED'); assert(sampling(handle).outcomes.every(item => item.state === 'NOT_EXERCISED'));
  assert.equal(f.calls.length, 1);
});

test('sampled mode admits its three resolved duties and rejects a model-selected substitute', async t => {
  const f = await fixture(t, { sampled: true, four: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), objects = selectedPageObjects(p), other = p.page.items.find(item => !objects.includes(item));
    await assert.rejects(f.frame(tools, { ...p, object: other }, questionFor(f, p, other)), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' });
    const refs = [];
    for (const object of objects) refs.push(await resolveSelected(f, tools, p, object));
    await tools.submit('finish_stop_review', { summary: 'The fixed partial sample was appraised, not host-proved.', implementationChallenges: refs.map(({ objectId, receiptId }) => ({ objectId, receiptId })) });
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).status, 'PARTIAL_SCOPE');
  assert.equal(sampling(handle).frames.length, 3); assert(sampling(handle).outcomes.every(item => item.state === 'RESOLVED_REFUTED'));
  assert.equal(sampling(handle).semanticsVerified, false); assert.equal(sampling(handle).exhaustive, false); assert.equal(f.calls.length, 1);
});

test('sampled missing, resolved and unselected items retain independent outcomes', async t => {
  const f = await fixture(t, { sampled: true, four: true }); let missing;
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), objects = selectedPageObjects(p); missing = objects.slice(1).map(item => item.objectId);
    const ref = await resolveSelected(f, tools, p, objects[0]); await f.finish(tools, ref);
  });
  assert.deepEqual(handle.result.unverifiedItems.map(item => item.objectId).sort(), missing.sort());
  assert.equal(handle.result.metricObjectJudgements.length, 0); assert.equal(sampling(handle).frames.length, 1);
});

test('sampled source-backed deviation and honest uncertainty skip without refilling the sample', async t => {
  const f = await fixture(t, { sampled: true, four: true }); let deviation, uncertain;
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), [clean, deviating, unverified] = selectedPageObjects(p);
    deviation = deviating.objectId; uncertain = unverified.objectId;
    const ref = await resolveSelected(f, tools, p, clean);
    await tools.submit('submit_review', { taskId: deviation, verdict: 'DEVIATION', reason: 'The source-linked actual route contradicts this scripted original duty.', citeIds: [p.code.details.citation.citeId] });
    await tools.submit('submit_review', { taskId: uncertain, verdict: 'UNVERIFIED', reason: 'The required source relationship remains unknown.' });
    await f.finish(tools, ref);
  });
  assert.deepEqual(handle.result.unverifiedItems.map(item => item.objectId), [uncertain]);
  assert.equal(handle.result.metricObjectJudgements.find(item => item.objectId === deviation).judgement, 'DEVIATION');
  assert.equal(sampling(handle).selection.selected.length, 3); assert.equal(sampling(handle).frames.length, 1);
  assert(sampling(handle).outcomes.some(item => item.state === 'SKIPPED_EXISTING_DEVIATION'));
  assert(sampling(handle).outcomes.some(item => item.state === 'SKIPPED_UNVERIFIED'));
});

for (const valid of [true, false]) test(`sampled conditional ${valid ? 'supported exclusion skips' : 'missing activation stays unverified'}`, async t => {
  const f = await fixture(t, { sampled: true, conditional: true, known: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    const final = { summary: 'Applicability retains its own original proof guard.', knownObligations: [{ id: f.candidate.id,
      disposition: 'CURRENT', objectId: p.object.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'Current source facts establish this original trigger is inactive.', citeIds: [p.code.details.citation.citeId],
      ...(valid ? { conditionAssessment: { activation: 'INACTIVE_AT_CURRENT_BOUNDARY', evidenceKind: 'TARGET_FACTS', reason: 'Current source supports this original conditional exclusion.' } } : {}) }] };
    const first = await tools.submit('finish_stop_review', final);
    if (!valid) { assert.equal(first.complete, false); await tools.submit('finish_stop_review', final); }
  });
  assert.equal(handle.result.unverifiedItems.length === 0, valid);
  assert.equal(sampling(handle).outcomes[0].state, valid ? 'SKIPPED_NOT_APPLICABLE' : 'SKIPPED_UNVERIFIED');
  assert.equal(sampling(handle).status, 'METHOD_NOT_EXERCISED');
});

test('sampled active conditional clean accounting cannot omit its selected method', async t => {
  const f = await fixture(t, { sampled: true, conditional: true, known: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), final = { summary: 'An active original duty still needs its sample.', knownObligations: [{ id: f.candidate.id,
      disposition: 'CURRENT', objectId: p.object.objectId, verdict: 'NO_CONFIRMED_DEVIATION', reason: 'This active duty is claimed conforming.',
      citeIds: [p.code.details.citation.citeId], conditionAssessment: { activation: 'ACTIVE', evidenceKind: 'TARGET_FACTS', reason: 'Current source facts support the original activation.' } }] };
    await tools.submit('finish_stop_review', final); await tools.submit('finish_stop_review', final);
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, 'UNVERIFIED');
  assert(handle.result.unverifiedItems.length > 0); assert.equal(sampling(handle).status, 'METHOD_NOT_EXERCISED');
});

test('sampled pre-implementation has an explicit nonapplicable empty cohort', async t => {
  const f = await fixture(t, { sampled: true });
  const handle = await f.run(async tools => { const p = await f.prepare(tools, { preImplementation: true });
    assert.equal(p.page.implementationChallenges.selection.status, 'NOT_APPLICABLE'); assert.equal(p.page.implementationChallenges.selection.selected.length, 0); await f.finish(tools); });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).status, 'METHOD_NOT_EXERCISED');
});

for (const failure of ['foreign', 'pending', 'sourceChanged', 'deadline', 'cancelled']) test(`sampled preserves the existing ${failure} guard`, async t => {
  const f = await fixture(t, { sampled: true }), controller = new AbortController();
  if (failure === 'cancelled') f.input.abortSignal = controller.signal;
  const run = () => f.run(async tools => {
    const p = await f.prepare(tools);
    if (failure === 'foreign') { await assert.rejects(f.frame(tools, p, { ...f.question(p), objectId: 'M16:foreign' }), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' }); await f.finish(tools); return; }
    if (failure === 'pending') { const unread = await tools.read(f.file, { receipt: false }); await assert.rejects(f.frame(tools, p, { ...f.question(p), decision: span(unread, 2) }), { code: 'IMPLEMENTATION_CHALLENGE_EVIDENCE' }); await f.finish(tools); return; }
    const frame = await f.frame(tools, p);
    if (failure === 'sourceChanged') await fs.appendFile(f.file, '// actual source changed\n');
    if (failure === 'cancelled') { controller.abort(new Error('sampled owned cancellation')); throw controller.signal.reason; }
    if (failure === 'deadline') {
      const future = Date.now() + 600000, mock = t.mock.method(Date, 'now', () => future);
      try { await f.resolved(tools, p, frame.challengeId); } finally { mock.mock.restore(); }
    } else await f.resolved(tools, p, frame.challengeId);
  });
  if (['sourceChanged', 'deadline', 'cancelled'].includes(failure)) await assert.rejects(run(), /CHANGED|changed|DEADLINE|deadline|cancel/);
  else { const handle = await run(); assert.equal(handle.result.unverifiedItems.length, 1); }
  assert.equal(f.calls.length, 1);
});


test('sampled mode cannot reactivate disabled M16 or manufacture an eligible duty', async t => {
  const f = await fixture(t, { sampled: true });
  f.input.request.population.reviewPolicy = resolveStopReviewPolicy({ deviationOnly: true, implementationChallengeMode: 'sampled', metrics: { M16: false } });
  const handle = await f.run(async tools => {
    await tools.readAll(); assert.equal(tools.tools.has('review_implementation_challenge'), false);
    const page = await tools.submit('set_original_checklist', { items: [], scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
    assert.equal(page.implementationChallenges.selection.status, 'NOT_APPLICABLE'); assert.equal(page.implementationChallenges.selection.selected.length, 0);
    await f.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).frames?.length ?? 0, 0);
});

test('sampled carried PASS still requires a current resolved selected receipt', async t => {
  const f = await fixture(t, { sampled: true, carry: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert(p.object.previousDeviation);
    await assert.rejects(tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'PASS', reason: 'An unchallenged carried item cannot clear.' }), { code: 'IMPLEMENTATION_CHALLENGE_PENDING' });
    const framed = await f.frame(tools, p), result = await f.resolved(tools, p, framed.challengeId);
    await assert.rejects(tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'PASS', reason: 'A foreign receipt cannot clear this item.',
      citeIds: [p.code.details.citation.citeId], implementationChallengeReceiptId: 'foreign-current-receipt' }), { code: 'IMPLEMENTATION_CHALLENGE_PENDING' });
    await tools.submit('submit_review', { taskId: p.object.objectId, verdict: 'PASS', reason: 'The original current source and selected appraisal are supplied.',
      citeIds: [p.code.details.citation.citeId], implementationChallengeReceiptId: result.receiptId }); await f.finish(tools, result);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).outcomes[0].state, 'RESOLVED_REFUTED');
});


test('sampled M16 admits the original checklist contract with omitted production role', async t => {
  const f = await fixture(t, { sampled: true, omitRole: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert.equal(p.object.implementationRole, undefined);
    assert.equal(p.page.implementationChallenges.selection.selected.length, 1);
    const framed = await f.frame(tools, p), result = await f.resolved(tools, p, framed.challengeId); await f.finish(tools, result);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).status, 'PARTIAL_SCOPE');
});


test('optional M16 challenge also admits the existing omitted production-role contract', async t => {
  const f = await fixture(t, { omitRole: true });
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); assert.equal(p.object.implementationRole, undefined);
    const framed = await f.frame(tools, p), result = await f.resolved(tools, p, framed.challengeId); await f.finish(tools, result);
  });
  assert.equal(handle.result.unverifiedItems.length, 0); assert.equal(sampling(handle).status, 'PARTIAL_SCOPE');
});

test('typed M16 compatibility still rejects nonproduction roles and wrong proof types', async t => {
  for (const invalid of [{ implementationRole: 'TEST' }, { implementationRole: 'SUPPORT' }, { verificationTarget: 'PROCESS' }, { implementationRole: null }]) {
    const f = await fixture(t, { omitRole: true });
    const handle = await f.run(async tools => {
      await tools.readAll(); const original = await tools.read(tools.brief.task.basisFiles.find(p => path.basename(p).startsWith('user-original-0')));
      await assert.rejects(tools.submit('set_original_checklist', { items: [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
        text: f.duties[0], citeId: original.details.citation.citeId, lineStart: 1, lineEnd: 1, ...invalid }] }),
      error => ['STOP_ORIGINAL_CHECKLIST_INVALID', 'TASK_SUBMISSION_INVALID'].includes(error.code));
      const p = await f.prepare(tools); const framed = await f.frame(tools, p), resolved = await f.resolved(tools, p, framed.challengeId); await f.finish(tools, resolved);
    });
    assert.equal(handle.result.unverifiedItems.length, 0);
  }
});

test('omitted role compatibility never turns a non-M16 item into a challenge subject', async t => {
  const f = await fixture(t);
  const handle = await f.run(async tools => {
    await tools.readAll(); const original = await tools.read(tools.brief.task.basisFiles.find(p => path.basename(p).startsWith('user-original-0')));
    const page = await tools.submit('set_original_checklist', { items: [{ metricId: 'M12', verificationTarget: 'IMPLEMENTATION',
      text: f.duties[0], citeId: original.details.citation.citeId, lineStart: 1, lineEnd: 1 }],
      scope: { stopClassification: 'TASK_COMPLETE', completionClaim: true } });
    const p = { page, object: page.items[0], original, code: await tools.read(f.file) };
    await assert.rejects(f.frame(tools, p), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' }); await f.finish(tools);
  });
  assert.equal(handle.result.unverifiedItems.length, 0);
});

for (const sampled of [false, true]) test(`${sampled ? 'sampled' : 'optional'} omitted-role compatibility still excludes actual program-standing regression`, async t => {
  const f = await fixture(t, { sampled, omitRole: true });
  f.input.request.taskChanges = { startHead: null, changes: [{ path: 'producer.mjs', status: 'MODIFIED' }] };
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools), standing = p.page.items.find(item => item.programStanding);
    assert(standing); assert.equal(standing.metricId, 'M16'); assert.equal(standing.implementationRole, 'PRODUCTION');
    await assert.rejects(f.frame(tools, { ...p, object: standing }), { code: 'IMPLEMENTATION_CHALLENGE_SCOPE' });
    if (sampled) assert(!p.page.implementationChallenges.selection.selected.some(item => item.objectId === standing.objectId));
    const framed = await f.frame(tools, p), result = await f.resolved(tools, p, framed.challengeId); await f.finish(tools, result);
  });
  assert.equal(sampling(handle).frames.length, 1); assert.equal(handle.result.unverifiedItems.length, 0);
});


for (const superseded of [false, true]) test(`sampled validated ${superseded ? 'supersession' : 'nonbinding original'} is not a current challenge duty`, async t => {
  const f = await fixture(t, { sampled: true, known: true,
    ...(!superseded ? { domain: { ...domains[0], duty: 'You may publish an optional artifact if useful.' } } : {}) });
  if (superseded) {
    f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'Amend the earlier publication requirement: this task must not publish an artifact.' } });
    f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  }
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools);
    const later = superseded ? tools.brief.task.basisFiles.find(file => path.basename(file).startsWith('user-original-1')) : null;
    const source = later ? await tools.read(later) : p.original;
    await tools.submit('finish_stop_review', { summary: 'Only the exact source-grounded noncurrent duty is excluded.',
      knownObligations: [{ id: f.candidate.id, disposition: superseded ? 'SUPERSEDED' : 'NOT_BINDING',
        reason: 'The acknowledged original wording or later amendment removes this exact duty.', citeIds: [source.details.citation.citeId] }] });
  });
  assert.equal(handle.result.knownOriginalCoverage.items[0].disposition, superseded ? 'SUPERSEDED' : 'NOT_BINDING');
  assert.equal(handle.result.unverifiedItems.length, 0);
  assert.equal(sampling(handle).outcomes[0].state, 'SKIPPED_NOT_CURRENT');
  assert.equal(sampling(handle).status, 'METHOD_NOT_EXERCISED');
});


for (const uncertain of [false, true]) test(`sampled exact noncurrent binding preserves a separate current duty${uncertain ? ' and its saved uncertainty' : ''}`, async t => {
  const f = await fixture(t, { sampled: true, known: true, extra: true,
    domain: { ...domains[0], duty: 'You may publish an optional artifact if useful.' } }); let due, excluded;
  const handle = await f.run(async tools => {
    const p = await f.prepare(tools); excluded = p.object.objectId;
    due = p.page.items.find(item => item.objectId !== excluded).objectId;
    // A current-duty correspondence cannot be smuggled through an exclusion.
    await assert.rejects(tools.submit('finish_stop_review', { summary: 'Foreign current association cannot travel with an exclusion.',
      knownObligations: [{ id: f.candidate.id, disposition: 'NOT_BINDING', reason: 'An original optional clause is nonbinding.',
        citeIds: [p.original.details.citation.citeId], corroboration: { citeId: p.original.details.citation.citeId, start: 2, end: 2, reason: 'Another duty span cannot substitute.' } }] }), { code: 'KNOWN_ORIGINAL_BINDING_INVALID' });
    if (uncertain) await tools.submit('submit_review', { taskId: excluded, verdict: 'UNVERIFIED', reason: 'An existing current source uncertainty remains unresolved.' });
    await tools.submit('finish_stop_review', { summary: 'The exact advisory binding is excluded without touching the current sibling.',
      knownObligations: [{ id: f.candidate.id, disposition: 'NOT_BINDING', reason: 'This exact original clause is explicitly optional.', citeIds: [p.original.details.citation.citeId] }] });
  });
  assert.deepEqual(handle.result.unverifiedItems.map(item => item.objectId).sort(), (uncertain ? [due, excluded] : [due]).sort());
  assert.equal(sampling(handle).selection.selected.length, 2);
  assert.equal(sampling(handle).outcomes.find(item => item.objectId === excluded).state, uncertain ? 'SKIPPED_UNVERIFIED' : 'SKIPPED_NOT_CURRENT');
  assert.equal(sampling(handle).outcomes.find(item => item.objectId === due).state, 'NOT_EXERCISED');
});

for (const proof of ['foreign', 'old-source', 'stale']) test(`sampled noncurrent skip cannot bypass ${proof} exclusion evidence`, async t => {
  const f = await fixture(t, { sampled: true, known: true });
  if (proof === 'old-source') {
    f.input.evidence.snapshot.entries.push({ type: 'user', uuid: 'U2', message: { content: 'The original publication duty is unchanged.' } });
    f.input.evidence.originalRequirements = await loadStopOriginalRequirements({ projectRoot: f.root, snapshot: f.input.evidence.snapshot });
  }
  const run = () => f.run(async tools => {
    const p = await f.prepare(tools);
    if (proof === 'stale') await fs.appendFile(p.original.details.citation.path, '\nChanged original snapshot.\n');
    const final = { summary: 'Unsupported exclusion evidence stays unverified.', knownObligations: [{ id: f.candidate.id,
      disposition: proof === 'old-source' ? 'SUPERSEDED' : 'NOT_BINDING', reason: 'A claimed exclusion cannot replace proof.',
      citeIds: [proof === 'foreign' ? 'unissued-foreign-original-citation' : p.original.details.citation.citeId] }] };
    const first = await tools.submit('finish_stop_review', final);
    if (!first.complete) await tools.submit('finish_stop_review', final);
  });
  if (proof === 'stale') await assert.rejects(run(), /CHANGED|changed|CITATION|citation/);
  else { const handle = await run(); assert(handle.result.unverifiedItems.length > 0);
    assert.notEqual(sampling(handle).outcomes[0].state, 'SKIPPED_NOT_CURRENT'); }
});
