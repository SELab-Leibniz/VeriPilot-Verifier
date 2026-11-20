import { randomUUID } from 'node:crypto';
import { sha256 } from './utils.mjs';

export const IMPLEMENTATION_CHALLENGE_VERSION = 'contrary-route-v1';
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 800, pattern: '\\S' };
const span = object({ citeId: text, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } });
const frame = object({ objectId: text, original: span, entry: span, decision: span,
  allowedClass: text, requiredOutcome: text, alternativeRoute: text, predictedOutcome: text, feasibilityReason: text });
const resolution = object({ challengeId: text,
  steps: { type: 'array', minItems: 1, maxItems: 6, items: object({ source: span, valueClass: text,
    decision: { enum: ['TAKEN', 'NOT_TAKEN', 'DIRECT', 'UNKNOWN'] }, consequence: text }) },
  result: span, assessment: { enum: ['REFUTED', 'COUNTEREXAMPLE', 'UNRESOLVED'] }, appraisal: text,
  refutingSource: span, refutationReason: text, correctionReason: text,
}, ['challengeId', 'steps', 'result', 'assessment', 'appraisal']);
export const IMPLEMENTATION_CHALLENGE_SCHEMA = object({ phase: { enum: ['FRAME', 'RESOLVE', 'INSPECT', 'READ'] },
  frames: { type: 'array', minItems: 1, maxItems: 3, items: frame },
  resolutions: { type: 'array', minItems: 1, maxItems: 3, items: resolution },
  challengeId: text, offset: { type: 'integer', minimum: 0 }, recordSha256: text,
}, ['phase']);
export const IMPLEMENTATION_CHALLENGE_REFERENCES = { type: 'array', maxItems: 3,
  items: object({ objectId: text, receiptId: text }) };
export const IMPLEMENTATION_CHALLENGE_INSTRUCTION = 'Optionally challenge at most three selected original production duties before clearing them. FRAME freezes an original allowed condition, its exact current decision source, and a feasible contrary route/result. RESOLVE appraises that frozen route with current source steps and a specific refutation, contradiction or uncertainty. Reuse acknowledged reads. Carry each resolved objectId/receiptId in finish_stop_review.implementationChallenges; any allowed challenged PASS row also supplies implementationChallengeReceiptId; this never permits a fresh PASS where forbidden. After compaction use INSPECT, then follow READ recoverWith offsets for the frozen question, current receipt, appraisal and source bindings. Recovery grants no new evidence. These are reviewer claims, not host-proved semantics. An opened unresolved challenge affects only its own item; unchallenged items keep their existing rules.';

export function createImplementationChallenges({ contextId, subject, source, current, persist, error }) {
  const frames = new Map(), byObject = new Map();
  let sequence = 0;
  const invalid = message => error('IMPLEMENTATION_CHALLENGE_INVALID', message);
  const clone = value => structuredClone(value);
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const bounded = value => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || bytes(value) > 4096)
      throw invalid('Supply one plain, bounded contrary-route witness (at most 4096 UTF-8 bytes).');
    const blank = item => typeof item === 'string' ? !item.trim()
      : item && typeof item === 'object' ? Object.values(item).some(blank) : false;
    if (blank(value))
      throw invalid('A contrary-route witness must contain substantive question and appraisal fields.');
  };
  const snapshot = () => ({ version: IMPLEMENTATION_CHALLENGE_VERSION, contextId,
    semanticsVerified: false, appraisalAuthority: 'REVIEWER_CLAIM', frames: [...frames.values()].map(clone) });
  const record = async updates => {
    const next = new Map(frames);
    for (const update of updates) next.set(update.challengeId, update);
    await current();
    await persist({ version: IMPLEMENTATION_CHALLENGE_VERSION, contextId, semanticsVerified: false,
      appraisalAuthority: 'REVIEWER_CLAIM', frames: [...next.values()].map(clone) });
    await current();
    for (const update of updates) { frames.set(update.challengeId, update); byObject.set(update.objectId, update.challengeId); }
  };
  async function sameSubject(retained) {
    const actual = await subject(retained.objectId);
    if (sha256(actual) !== retained.subjectDigest) throw invalid('The challenge belongs to another current original subject.');
    return actual;
  }
  async function referencesCurrent(retained) {
    const actual = await sameSubject(retained);
    for (const ref of retained.references) {
      const now = await source(ref.selection, actual, ref.original);
      if (sha256(now) !== sha256(ref)) throw invalid('A challenge source binding changed.');
    }
  }
  const recover = async value => {
    if (value.frames !== undefined || value.resolutions !== undefined)
      throw invalid('Recovery cannot submit or change a question or appraisal.');
    const offset = value.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Use the actual nonnegative recovery offset.');
    await current();
    if (value.phase === 'INSPECT') {
      if (value.challengeId !== undefined || value.recordSha256 !== undefined)
        throw invalid('INSPECT pages the current task index without a supplied challenge or record digest.');
      const retained = [...frames.values()];
      if (offset > retained.length) throw invalid('Recovery index offset is outside the current task.');
      const page = retained.slice(offset, offset + 1);
      for (const item of page) await referencesCurrent(item);
      await current();
      const nextOffset = offset + page.length < retained.length ? offset + page.length : null;
      return { navigationOnly: true, semanticsVerified: false, status: frames.size ? 'PARTIAL_SCOPE' : 'METHOD_NOT_EXERCISED',
        items: page.map(item => ({ challengeId: item.challengeId, objectId: item.objectId,
          questionDigest: item.inputDigest, latestReceiptId: item.resolutions.at(-1)?.receiptId ?? null,
          correctionRemaining: Math.max(0, 2 - item.resolutions.length - Number(!item.resolutions.length)) })),
        nextOffset, recoverWith: nextOffset === null ? null
          : { tool: 'review_implementation_challenge', arguments: { phase: 'INSPECT', offset: nextOffset } },
        readWith: page.length ? { tool: 'review_implementation_challenge', arguments: { phase: 'READ', challengeId: page[0].challengeId, offset: 0 } } : null };
    }
    const retained = frames.get(value.challengeId);
    if (!retained) throw invalid('Recover an actual host-issued challenge from this current task.');
    await referencesCurrent(retained); await current();
    const latest = retained.resolutions.at(-1), data = Buffer.from(JSON.stringify({
      version: IMPLEMENTATION_CHALLENGE_VERSION, contextId, challengeId: retained.challengeId, objectId: retained.objectId,
      question: retained.question, questionDigest: retained.inputDigest, subject: retained.subject,
      subjectDigest: retained.subjectDigest, sourceBindings: retained.references,
      latest: latest ? { receiptId: latest.receiptId, appraisal: latest.appraisal, resolveSequence: latest.resolveSequence } : null,
      priorReceiptIds: retained.resolutions.slice(0, -1).map(item => item.receiptId),
      correctionRemaining: Math.max(0, 2 - retained.resolutions.length - Number(!retained.resolutions.length)),
      semanticsVerified: false, appraisalAuthority: 'REVIEWER_CLAIM',
    }));
    const recordSha256 = sha256(data);
    if ((value.recordSha256 !== undefined && value.recordSha256 !== recordSha256)
      || (offset && value.recordSha256 === undefined)) throw invalid('Continue the exact current recovery record digest.');
    if (offset >= data.length || (data[offset] & 0xc0) === 0x80)
      throw invalid('Use an actual UTF-8 recovery boundary returned in nextOffset.');
    let end = Math.min(data.length, offset + 4096), result;
    do {
      while (end < data.length && (data[end] & 0xc0) === 0x80) end--;
      const nextOffset = end < data.length ? end : null;
      result = { navigationOnly: true, semanticsVerified: false, challengeId: retained.challengeId,
        objectId: retained.objectId, encoding: 'UTF-8 JSON', recordSha256, totalBytes: data.length, offset,
        text: data.subarray(offset, end).toString('utf8'), nextOffset,
        recoverWith: nextOffset === null ? null : { tool: 'review_implementation_challenge',
          arguments: { phase: 'READ', challengeId: retained.challengeId, offset: nextOffset, recordSha256 } } };
      if (Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] })) <= 8192) return result;
      end -= Math.min(256, end - offset);
    } while (end > offset);
    throw invalid('The current recovery metadata cannot fit its bounded response.');
  };
  return {
    async submit(value) {
      if (bytes(value) > 16384) throw invalid('Challenge batches are limited to 16384 UTF-8 bytes.');
      await current();
      if (value.phase === 'INSPECT' || value.phase === 'READ') return recover(value);
      if (value.challengeId !== undefined || value.offset !== undefined || value.recordSha256 !== undefined)
        throw invalid('Recovery fields cannot alter a submitted question or appraisal.');
      if (value.phase === 'FRAME') {
        if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > 3 || value.resolutions !== undefined)
          throw invalid('FRAME takes one to three frames, without resolutions.');
        const updates = [], seen = new Set();
        for (const input of value.frames) {
          bounded(input);
          if (seen.has(input.objectId)) throw invalid('One batch cannot frame the same object twice.');
          seen.add(input.objectId);
          const existing = frames.get(byObject.get(input.objectId));
          if (existing) {
            if (existing.inputDigest !== sha256(input)) throw invalid('A frozen contrary question cannot be silently replaced.');
            await referencesCurrent(existing); updates.push(existing); continue;
          }
          const actual = await subject(input.objectId);
          const refs = await Promise.all([source(input.original, actual, true),
            source(input.entry, actual, false), source(input.decision, actual, false)]);
          updates.push({ challengeId: randomUUID(), objectId: input.objectId, contextId,
            subject: clone(actual), subjectDigest: sha256(actual), inputDigest: sha256(input),
            question: clone(input), references: refs, frameSequence: ++sequence, resolutions: [] });
        }
        if (frames.size + updates.filter(update => !frames.has(update.challengeId)).length > 3)
          throw invalid('This review may open at most three challenges.');
        await record(updates);
        return { saved: true, semanticsVerified: false, frames: updates.map(({ challengeId, objectId, question, references }) =>
          ({ challengeId, objectId, questionDigest: sha256(question), actualDecision: references[2], next: 'RESOLVE' })) };
      }
      if (value.phase !== 'RESOLVE' || !Array.isArray(value.resolutions) || !value.resolutions.length
        || value.resolutions.length > 3 || value.frames !== undefined) throw invalid('RESOLVE takes one to three resolutions, without frames.');
      const updates = [], seen = new Set();
      for (const input of value.resolutions) {
        bounded(input);
        if (seen.has(input.challengeId)) throw invalid('One batch cannot resolve the same challenge twice.');
        seen.add(input.challengeId);
        const retained = frames.get(input.challengeId);
        if (!retained) throw invalid('Use an actual host-issued challenge from this review.');
        await referencesCurrent(retained);
        const prior = retained.resolutions.at(-1);
        if (prior?.inputDigest === sha256(input)) { updates.push(retained); continue; }
        if (retained.resolutions.length >= 2 || (prior ? !input.correctionReason?.trim() : input.correctionReason !== undefined))
          throw invalid('Only one explicit correction is allowed; prior appraisal records remain retained.');
        if (input.assessment === 'REFUTED' && (!input.refutingSource || !input.refutationReason?.trim()))
          throw invalid('REFUTED needs a specific source-linked refuting step and explanation.');
        if (input.assessment !== 'REFUTED' && (input.refutingSource !== undefined || input.refutationReason !== undefined))
          throw invalid('A non-refuted appraisal must not claim a refuting step.');
        const actual = await sameSubject(retained);
        const spans = [...input.steps.map(step => step.source), input.result,
          ...(input.refutingSource ? [input.refutingSource] : [])];
        const refs = await Promise.all(spans.map(ref => source(ref, actual, false)));
        updates.push({ ...clone(retained), references: [...retained.references, ...refs],
          resolutions: [...retained.resolutions, { receiptId: randomUUID(), inputDigest: sha256(input),
            resolveSequence: ++sequence, appraisal: clone(input), references: refs, semanticsVerified: false }] });
      }
      await record(updates);
      return { saved: true, semanticsVerified: false, resolutions: updates.map(update => ({ objectId: update.objectId,
        challengeId: update.challengeId, receiptId: update.resolutions.at(-1).receiptId,
        assessment: update.resolutions.at(-1).appraisal.assessment,
        correctionRemaining: update.resolutions.length < 2, next: 'finish_stop_review' })) };
    },
    async assess(objectId, references = []) {
      const retained = frames.get(byObject.get(objectId));
      if (!retained) return null;
      await current(); await referencesCurrent(retained);
      const matching = references.filter(ref => ref.objectId === objectId), latest = retained.resolutions.at(-1);
      if (matching.length !== 1 || !latest || matching[0].receiptId !== latest.receiptId)
        return { objectId, reason: 'An opened contrary-route challenge lacks its current resolved receipt.', code: 'IMPLEMENTATION_CHALLENGE_PENDING' };
      if (latest.appraisal.assessment !== 'REFUTED') return { objectId,
        reason: latest.appraisal.assessment === 'COUNTEREXAMPLE'
          ? 'The opened contrary route claims a contradiction; submit its concrete evidence through the existing deviation tool or retain uncertainty.'
          : 'The opened contrary route remains unresolved.', code: 'IMPLEMENTATION_CHALLENGE_UNRESOLVED' };
      return { objectId, receiptId: latest.receiptId, status: 'REVIEWER_REFUTED', semanticsVerified: false };
    },
    validateReferences(references = []) {
      const seen = new Set();
      for (const ref of references) {
        if (seen.has(ref.objectId) || !byObject.has(ref.objectId))
          throw invalid('Use at most one receipt for each actually opened challenge object.');
        seen.add(ref.objectId);
      }
    },
    summary() {
      return { version: IMPLEMENTATION_CHALLENGE_VERSION,
        status: frames.size ? 'PARTIAL_SCOPE' : 'METHOD_NOT_EXERCISED', exhaustive: false, semanticsVerified: false,
        recoverWith: { tool: 'review_implementation_challenge', arguments: { phase: 'INSPECT', offset: 0 } },
        frames: [...frames.values()].map(value => ({ objectId: value.objectId, challengeId: value.challengeId,
          resolutionCount: value.resolutions.length, assessment: value.resolutions.at(-1)?.appraisal.assessment ?? 'PENDING' })) };
    },
    has: id => byObject.has(id), snapshot,
  };
}
