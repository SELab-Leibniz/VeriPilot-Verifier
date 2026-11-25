import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewerReadLoopGuard } from '../lib/openclaw/reviewer-read-loop.mjs';
import { createOwnedReadLoopObserver } from '../lib/openclaw/owned-read-loop-observer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const owner = { sessionId: 'owned-review-session', leaseId: 'owned-review-lease',
  role: 'artifact-reviewer', requestSha256: hash('current request') };
const setup = (limits = {}) => {
  let now = 1000, sequence = 0;
  const g = createReviewerReadLoopGuard({ owner, deadlineAt: 10000, now: () => now, limits });
  g.activateRun('native-a');
  const event = (page = 1, more = {}) => ({ runId: 'native-a', callId: `call-${++sequence}`,
    assistantTurn: sequence, subjectId: hash('declared subject'), sourceSha256: hash('complete version A'),
    readIdentity: hash(`range-${page}`), start: page, count: 10, eof: false, ...more });
  const run = (e, payload = hash('returned bytes'), isError = false) => {
    const before = g.before(e);
    return { before, result: before.kind === 'ALLOW' ? g.result({ ...e, payloadSha256: payload, isError }) : null };
  };
  return { g, event, run, time: value => { now = value; } };
};

test('distinct current chunks remain allowed even when their displayed contents are identical', () => {
  const s = setup();
  for (let i = 1; i <= 80; i++) assert.equal(s.run(s.event(i)).result.kind, 'NOVEL_OBSERVATION');
  assert.equal(s.g.snapshot().notices, 0); assert.equal(s.g.snapshot().terminal, null);
});

test('specific-clause rereads stay allowed within the conservative repetition allowance', () => {
  const s = setup();
  s.run(s.event(1));
  for (let i = 0; i < 3; i++) assert.equal(s.run(s.event(1)).before.kind, 'ALLOW');
  assert.equal(s.run(s.event(2)).result.kind, 'NOVEL_OBSERVATION');
  assert.equal(s.g.snapshot().repeatedSinceNovelObservation, 0);
});

test('a mixed unchanged read cycle receives exactly one notice then bounded UNVERIFIED termination', () => {
  const s = setup({ beforeNotice: 4, sameOutcome: 3, afterNotice: 3 });
  for (const page of [1, 2, 3]) s.run(s.event(page));
  let notices = 0, terminal;
  for (let i = 0; i < 30 && !terminal; i++) {
    const step = s.run(s.event(i % 3 + 1));
    if (step.before.kind === 'COACH_ONCE') { notices++; assert.match(step.before.blockReason, /UNVERIFIED/u); }
    if (step.result?.kind === 'TERMINATE_UNVERIFIED') terminal = step.result;
  }
  assert.equal(notices, 1); assert.equal(terminal.code, 'REVIEWER_NO_PROGRESS_UNVERIFIED');
  assert.equal(terminal.classification, 'UNVERIFIED'); assert.equal(s.g.snapshot().deadlineAt, 10000);
  assert.equal(s.g.snapshot().assessmentAuthority, false); assert.equal(s.g.snapshot().repairAuthority, false);
});

test('host-proved EOF addresses share one outcome while closing-only text is ordinary range data', () => {
  const s = setup({ beforeNotice: 2, sameOutcome: 2 });
  s.run(s.event(3)); s.run(s.event(4));
  assert.equal(s.g.snapshot().novelObservations, 2);
  for (let i = 0; i < 4; i++) s.run(s.event(100 + i, { eof: true }));
  assert.equal(s.g.snapshot().notices, 1);
});

test('a genuine host source revision or new returned content permits renewed investigation', () => {
  const s = setup({ beforeNotice: 3, sameOutcome: 2 });
  s.run(s.event()); s.run(s.event());
  const changed = s.event(1, { sourceSha256: hash('complete actual version B') });
  assert.equal(s.run(changed).result.kind, 'NOVEL_OBSERVATION');
  assert.equal(s.g.snapshot().repeatedSinceNovelObservation, 0);
  assert.equal(s.run(s.event()).result.kind, 'REPEATED_OBSERVATION');
  assert.equal(s.run(s.event(), hash('genuinely changed returned content')).result.kind, 'NOVEL_OBSERVATION');
});

test('new host-accepted checkpoints advance scheduling; repeated checkpoint/notes cannot refill it', () => {
  const s = setup(); s.run(s.event()); s.run(s.event());
  assert.equal(s.g.acceptedCheckpoint(hash('accepted complete row')).kind, 'ACCEPTED_STATE_ADVANCE');
  s.run(s.event());
  assert.equal(s.g.acceptedCheckpoint(hash('accepted complete row')).kind, 'IGNORED');
  assert.equal(s.g.snapshot().repeatedSinceNovelObservation, 1);
});

test('one compaction rehydration pass is allowed without renewing the deadline', () => {
  const s = setup({ beforeNotice: 2, sameOutcome: 2, afterNotice: 2 });
  for (const page of [1, 2, 3]) s.run(s.event(page));
  s.g.compactionCompleted('genuine-compaction-1');
  for (const page of [1, 2, 3]) assert.equal(s.run(s.event(page)).result.kind, 'REHYDRATION_READ');
  assert.equal(s.g.snapshot().notices, 0);
  s.g.compactionCompleted('genuine-compaction-2');
  assert.notEqual(s.run(s.event(1)).result.kind, 'REHYDRATION_READ');
  assert.equal(s.g.snapshot().deadlineAt, 10000);
});

test('duplicate, unmatched and foreign-run callbacks do not consume read scheduling', () => {
  const s = setup(); const e = s.event(); s.run(e);
  assert.equal(s.g.result({ ...e, payloadSha256: hash('returned bytes'), isError: false }).kind, 'IGNORED');
  assert.equal(s.run(s.event(1, { runId: 'foreign-native' })).before.kind, 'IGNORED');
  const result = s.g.result({ ...s.event(), payloadSha256: hash('fabricated callback'), isError: false });
  assert.equal(result.kind, 'IGNORED'); assert.equal(s.g.snapshot().matchedResults, 1);
});

test('native attempt transitions keep one worker budget but scope call IDs to actual run', () => {
  const s = setup(); const e = s.event(); s.run(e);
  s.g.activateRun('native-b');
  assert.equal(s.run({ ...e, runId: 'native-b' }).before.kind, 'ALLOW');
  assert.equal(s.g.snapshot().matchedResults, 2);
  assert.equal(s.g.before({ ...s.event(), runId: 'native-a' }).kind, 'IGNORED');
});

test('a persist/prewrite assertion alone never qualifies coaching delivery', () => {
  const s = setup({ beforeNotice: 1, sameOutcome: 2 });
  s.run(s.event()); s.run(s.event()); const coach = s.run(s.event());
  assert.equal(coach.before.kind, 'COACH_ONCE');
  assert.equal(s.g.acknowledgeCoach, undefined, 'no boolean or prewrite event can manufacture a delivery ACK');
  assert.equal(s.g.snapshot().coaching.delivery, 'ISSUED_UNCONFIRMED');
  assert.equal(s.g.snapshot().semanticProgressProven, false);
});

test('deadline exhaustion is never repaired by compaction, checkpoint or a new native attempt', () => {
  const s = setup(); s.time(10000);
  s.g.compactionCompleted('late'); s.g.acceptedCheckpoint(hash('late')); s.g.activateRun('late');
  assert.equal(s.g.before(s.event()).code, 'REVIEWER_DEADLINE');
  assert.equal(s.g.snapshot().deadlineAt, 10000);
});

test('the real-shaped private callback seam blocks once and aborts only its provided reviewer controller', async () => {
  const s = setup({ beforeNotice: 2, sameOutcome: 2, afterNotice: 2 });
  const aborted = [], decisions = []; let turn = 0, notice;
  const observer = createOwnedReadLoopObserver({ guard: s.g, runId: 'native-a',
    turnFor: () => turn, sourceFor: async () => ({ subjectId: hash('declared source'), sha256: hash('full source'), lineCount: 30 }),
    abortOwnedReviewer: error => aborted.push(error), onDecision: d => decisions.push(d.kind) });
  for (let i = 0; i < 12 && !aborted.length; i++) {
    turn++;
    const id = `native-read-${i}`, args = { path: 'host-catalog-key', offset: 30, limit: 2 };
    const result = await observer('read', args, { toolCallId: id });
    if (result?.block) notice = { id, args, text: result.blockReason };
    if (!result?.block) await observer('read:result', { toolName: 'read', toolCallId: id, args,
      result: { content: [{ type: 'text', text: '\n}' }] }, isError: false });
  }
  assert.equal(decisions.filter(x => x === 'COACH_ONCE').length, 1);
  assert.equal(aborted.length, 1); assert.equal(aborted[0].code, 'REVIEWER_NO_PROGRESS_UNVERIFIED');
  assert.equal(aborted[0].reviewerRuntimeFailure, true);
  const blocked = { toolName: 'read', toolCallId: notice.id, args: notice.args,
    result: { content: [{ type: 'text', text: notice.text }], details: {
      status: 'blocked', deniedReason: 'plugin-before-tool-call', reason: notice.text } } };
  assert.equal(observer.isCoachingResult('read:result', blocked), true, 'late exact host veto stays non-proof after abort');
  assert.equal(observer.isCoachingResult('read:result', { ...blocked, toolCallId: 'ordinary-call' }), false);
  assert.equal(observer.isCoachingResult('read:result', { ...blocked, result: { content: blocked.result.content } }), false,
    'matching model-readable text alone never declares a veto');
});

test('supplemental foreign native/session identities never borrow an owned call ID', async () => {
  const s = setup();
  const observer = createOwnedReadLoopObserver({ guard: s.g, runId: 'native-a', sessionId: 'own-session',
    sessionKey: 'own-key', agentId: 'main',
    turnFor: () => 1, sourceFor: async () => ({ subjectId: hash('source'), sha256: hash('version'), lineCount: 2 }),
    abortOwnedReviewer: () => assert.fail('foreign callbacks must not abort any worker') });
  const args = { path: 'declared-host-source', offset: 1, limit: 1 };
  await observer('read', args, { toolCallId: 'call', runId: 'native-a', sessionId: 'own-session' });
  await observer('read:result', { toolName: 'read', toolCallId: 'call', args,
    result: { content: [{ type: 'text', text: 'unchanged' }] } }, { runId: 'foreign-native' });
  assert.equal(s.g.snapshot().matchedResults, 0);
  await observer('read:result', { toolName: 'read', toolCallId: 'call', args,
    result: { content: [{ type: 'text', text: 'unchanged' }] } }, { runId: 'native-a', sessionId: 'own-session' });
  assert.equal(s.g.snapshot().matchedResults, 1);
});


test('notice does not terminate from same-turn queued or late results before a later assistant turn', () => {
  const s = setup({ beforeNotice: 1, sameOutcome: 2, afterNotice: 3 });
  s.run(s.event(1, { assistantTurn: 1 }));
  const queued = Array.from({ length: 8 }, () => s.event(1, { assistantTurn: 1 }));
  for (const e of queued) assert.equal(s.g.before(e).kind, 'ALLOW');
  s.run(s.event(1, { assistantTurn: 1 }));
  assert.equal(s.g.before(s.event(1, { assistantTurn: 2 })).kind, 'COACH_ONCE');
  for (const e of queued) assert.equal(s.g.result({ ...e, payloadSha256: hash('returned bytes'), isError: false }).kind, 'REPEATED_OBSERVATION');
  for (let i = 0; i < 8; i++) assert.equal(s.run(s.event(1, { assistantTurn: 2 })).result.kind, 'REPEATED_OBSERVATION');
  assert.equal(s.g.snapshot().terminal, null);
  assert.equal(s.g.snapshot().repeatedSinceNoticeOrNovelObservation, 0);
  for (let i = 0; i < 2; i++) assert.equal(s.run(s.event(1, { assistantTurn: 3 })).result.kind, 'REPEATED_OBSERVATION');
  assert.equal(s.run(s.event(1, { assistantTurn: 3 })).result.code, 'REVIEWER_NO_PROGRESS_UNVERIFIED');
  assert.equal(s.g.snapshot().coaching.delivery, 'ISSUED_UNCONFIRMED');
});
