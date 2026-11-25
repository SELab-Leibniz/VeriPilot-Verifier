import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const LIMITS = Object.freeze({ beforeNotice: 12, sameOutcome: 3, afterNotice: 8,
  signatures: 256, callIds: 2048, pending: 64, rehydration: 32 });
export const READ_LOOP_NOTICE = 'RC_REVIEWER_READ_LOOP_NOTICE: Owned read requests have repeatedly returned identical outcomes without a new observed range, content revision or accepted review checkpoint. This is navigation metadata, not proof of coverage or correctness. Identify the specific unresolved question. Continue a distinct needed read or a justified reread. When sufficient, submit the required structured assessment; otherwise preserve every duty and use the available UNVERIFIED disposition. Do not infer a violation or start coding/repair from missing evidence. Unchanged tail/empty reads do not supply new evidence. The original deadline remains in force.';

// Pure host-owned scheduling state. Call IDs, source versions and accepted
// checkpoints must come from the owning native invocation, never model JSON.
// This is an information-repetition heuristic, not a semantic-progress oracle.
export function createReviewerReadLoopGuard({ owner, deadlineAt, now = Date.now, limits = {} }) {
  if (!owner || !textId(owner.sessionId) || !textId(owner.leaseId) || !textId(owner.role)
    || !hex(owner.requestSha256) || !Number.isFinite(deadlineAt) || deadlineAt <= now())
    throw new Error('READ_LOOP_OWNED_ORIGINAL_BUDGET_REQUIRED');
  const budget = { ...LIMITS, ...limits };
  for (const [key, value] of Object.entries(budget))
    if (!Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > 4096)
      throw new Error('READ_LOOP_INVALID_LIMIT');
  const ownerDigest = sha(owner), pending = new Map(), completed = new Set(), outcomes = new Map();
  const requests = new Map(), checkpoints = new Set(), compactions = new Set();
  const grace = new Set(), rehydrated = new Set();
  const stats = { matchedResults: 0, novelObservations: 0, repeatedObservations: 0,
    ignoredEvents: 0, rehydrationReads: 0, acceptedCheckpointChanges: 0, notices: 0,
    sameOrEarlierTurnResultsAfterNotice: 0 };
  let runId = null, duplicateRun = 0, postNoticeDuplicates = 0, notice = null, terminal = null;
  const trim = (collection, maximum) => { while (collection.size > maximum) collection.delete(collection.keys().next().value); };
  const active = () => {
    if (!terminal && now() >= deadlineAt) terminal = { code: 'REVIEWER_DEADLINE', classification: 'UNVERIFIED' };
    return !terminal;
  };
  const ignored = () => { stats.ignoredEvents++; return { kind: 'IGNORED', navigationOnly: true }; };
  const eligible = e => e && e.runId === runId && textId(e.callId) && hex(e.readIdentity)
    && hex(e.subjectId) && hex(e.sourceSha256) && Number.isSafeInteger(e.start) && e.start >= 1
    && (e.count === null || Number.isSafeInteger(e.count) && e.count >= 1)
    && typeof e.eof === 'boolean' && Number.isSafeInteger(e.assistantTurn) && e.assistantTurn >= 1;
  const requestKey = e => sha([e.subjectId, e.sourceSha256, e.eof ? 'EOF' : e.readIdentity]);
  const callKey = e => `${e.runId}\0${e.callId}`;
  const fail = () => {
    terminal = { code: 'REVIEWER_NO_PROGRESS_UNVERIFIED', classification: 'UNVERIFIED',
      coaching: notice?.delivery ?? 'NOT_ISSUED' };
    return { kind: 'TERMINATE_UNVERIFIED', ...terminal, navigationOnly: true };
  };
  const advance = () => {
    duplicateRun = 0; postNoticeDuplicates = 0; grace.clear(); rehydrated.clear();
  };
  const current = () => ({ ...stats, ownerDigest, deadlineAt, runId,
    state: terminal ? 'TERMINATED_UNVERIFIED' : notice ? 'COACHED_MONITORING' : 'MONITORING',
    repeatedSinceNovelObservation: duplicateRun, repeatedSinceNoticeOrNovelObservation: postNoticeDuplicates,
    storedSignatures: outcomes.size, pendingCalls: pending.size,
    coaching: notice ? { callId: notice.callId, runId: notice.runId, delivery: notice.delivery,
      textSha256: notice.textSha256, assistantTurn: notice.assistantTurn } : null, terminal: terminal && { ...terminal },
    navigationOnly: true, semanticProgressProven: false, sourceReadProof: false,
    assessmentAuthority: false, repairAuthority: false, originalDeadlineRenewed: false });
  return Object.freeze({
    activateRun(value) {
      if (!active() || !textId(value)) return ignored();
      // A format-repair transport can share this worker, but cannot reset its
      // original clock, one-notice cap or repetition state. Old results expire.
      runId = value; pending.clear(); return { kind: 'OWNED_RUN_BOUND', navigationOnly: true };
    },
    before(e) {
      if (!active()) return { kind: 'TERMINATE_UNVERIFIED', ...terminal, navigationOnly: true };
      if (!eligible(e) || completed.has(callKey(e)) || pending.has(callKey(e))) return ignored();
      if (pending.size >= budget.pending) return ignored();
      const key = requestKey(e), prior = requests.get(key);
      const mayRehydrate = prior && grace.has(prior.outcome);
      if (!notice && prior && !mayRehydrate && duplicateRun >= budget.beforeNotice
        && (outcomes.get(prior.outcome)?.count ?? 0) >= budget.sameOutcome) {
        const text = READ_LOOP_NOTICE + ` Notice ${ownerDigest.slice(0, 16)}.`;
        notice = { callId: e.callId, runId, assistantTurn: e.assistantTurn, textSha256: createHash('sha256').update(text).digest('hex'), delivery: 'ISSUED_UNCONFIRMED' };
        stats.notices++; completed.add(callKey(e)); trim(completed, budget.callIds);
        return { kind: 'COACH_ONCE', block: true, blockReason: text, navigationOnly: true };
      }
      pending.set(callKey(e), { ...e, key });
      return { kind: 'ALLOW', navigationOnly: true };
    },
    result(e) {
      if (!active()) return { kind: 'TERMINATE_UNVERIFIED', ...terminal, navigationOnly: true };
      const issued = e && pending.get(callKey(e));
      if (!eligible(e) || !issued || completed.has(callKey(e)) || e.readIdentity !== issued.readIdentity
        || e.subjectId !== issued.subjectId || !hex(e.payloadSha256) || typeof e.isError !== 'boolean') return ignored();
      pending.delete(callKey(e)); completed.add(callKey(e)); trim(completed, budget.callIds);
      stats.matchedResults++;
      // A trusted actual content revision can change between call and result.
      // No read receipt, coverage, freshness or correctness is inferred here.
      const key = requestKey(e), outcome = sha([key, e.payloadSha256, e.isError]);
      const before = outcomes.get(outcome), count = (before?.count ?? 0) + 1;
      outcomes.delete(outcome); outcomes.set(outcome, { count }); trim(outcomes, budget.signatures);
      requests.delete(key); requests.set(key, { outcome }); trim(requests, budget.signatures);
      if (!before) {
        stats.novelObservations++; advance(); return { kind: 'NOVEL_OBSERVATION', navigationOnly: true };
      }
      if (grace.delete(outcome)) {
        rehydrated.add(outcome); stats.rehydrationReads++;
        return { kind: 'REHYDRATION_READ', navigationOnly: true };
      }
      stats.repeatedObservations++; duplicateRun++;
      // A notice blocks one call in an existing assistant tool batch. Reads
      // already issued in that batch (including late results) must not count
      // as continued looping after the model could receive its result. Only
      // calls issued in a later host-observed assistant-message boundary can consume
      // this allowance; delivery still remains ISSUED_UNCONFIRMED.
      if (notice && issued.assistantTurn <= notice.assistantTurn)
        stats.sameOrEarlierTurnResultsAfterNotice++;
      if (notice && issued.assistantTurn > notice.assistantTurn) {
        postNoticeDuplicates++;
        if (postNoticeDuplicates >= budget.afterNotice) return fail();
      }
      return { kind: 'REPEATED_OBSERVATION', navigationOnly: true };
    },
    acceptedCheckpoint(digest) {
      if (!active() || !hex(digest) || checkpoints.has(digest)) return ignored();
      // Caller supplies a digest of genuinely host-accepted changed review
      // state, excluding timestamps, read counters, notes and raw model JSON.
      checkpoints.add(digest); trim(checkpoints, budget.signatures);
      stats.acceptedCheckpointChanges++; advance(); return { kind: 'ACCEPTED_STATE_ADVANCE', navigationOnly: true };
    },
    compactionCompleted(id) {
      if (!active() || !textId(id) || compactions.has(id)) return ignored();
      compactions.add(id); trim(compactions, budget.signatures);
      // At most one rehydration pass per unchanged information epoch. Repeated
      // compactions cannot renew the clock or refill the same page's credits.
      for (const key of [...outcomes.keys()].slice(-budget.rehydration))
        if (!rehydrated.has(key)) grace.add(key);
      return { kind: 'BOUNDED_REHYDRATION_AVAILABLE', navigationOnly: true };
    },
    snapshot: current,
  });
}
