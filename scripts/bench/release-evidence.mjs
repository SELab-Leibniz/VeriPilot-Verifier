// Release evidence is read from records the product persists in the business
// workspace (task journal, Stop evaluations/terminals, native run records),
// never from transient review requests that the product deletes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { measureSimplifyBenchmark } from '../helpers/simplify-stop-benchmark.mjs';

const missing = fallback => error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fallback; throw error; };
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse, missing(null));
const entries = directory => fs.readdir(directory, { withFileTypes: true }).catch(missing([]));
async function jsonFiles(directory, depth = 0) {
  const found = [];
  for (const entry of await entries(directory)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...await jsonFiles(file, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.json')) { const value = await readJson(file).catch(() => null); if (value) found.push({ file, value }); }
  }
  return found;
}
const at = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const count = value => Array.isArray(value) ? value.length : Number.isSafeInteger(value) ? value : null;
const wall = runs => {
  let sum = 0, latest = 0;
  const spans = runs.filter(run => Number.isFinite(run.startedAt) && Number.isFinite(run.settledAt)).map(run => [run.startedAt, run.settledAt]).sort((a, b) => a[0] - b[0]);
  for (const [start, end] of spans) { sum += Math.max(0, end - Math.max(start, latest)); latest = Math.max(latest, end); }
  return spans.length ? sum : null;
};
const SETTLED_STOP = new Set(['PASS', 'NO_DEVIATION_FOUND', 'DEVIATION']);
const checkBase = id => /^(.+):check-\d+$/u.exec(id ?? '')?.[1] ?? null;
export const DOCUMENT_ONLY = 'STOP_DOCUMENT_ONLY_CHANGES';
// Workflow documents and harness/RC state are not code changes.
export const codeChanged = mutationPaths => Array.isArray(mutationPaths)
  ? mutationPaths.some(file => !/^(?:openspec|\.opencode|\.runtime-corrector|\.runtime-correction)\//u.test(String(file).replaceAll('\\', '/'))) : null;

export async function collectReleaseEvidence({ projectRoot, sessionId = null, nativeRoot = null, turns = [] }) {
  const rc = path.join(projectRoot, '.runtime-correction'), taskIds = [];
  for (const entry of await entries(path.join(rc, 'tasks'))) if (entry.isDirectory()) {
    const task = await readJson(path.join(rc, 'tasks', entry.name, 'task.json'));
    if (task && (!sessionId || task.rootSessionId === sessionId || task.sessionIds?.includes(sessionId))) taskIds.push(entry.name);
  }
  const journal = [], evaluations = [], terminals = new Map();
  for (const taskId of taskIds) {
    const taskRoot = path.join(rc, 'tasks', taskId);
    for (const line of (await fs.readFile(path.join(taskRoot, 'journal/events.jsonl'), 'utf8').catch(missing(''))).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try { journal.push({ taskId, ...JSON.parse(line) }); } catch { /* a torn final line is not evidence */ }
    }
    for (const { file, value } of [...await jsonFiles(path.join(taskRoot, 'evaluations')), ...await jsonFiles(path.join(taskRoot, 'stop-terminals'))]) {
      if (path.basename(file).startsWith('stop-terminal-') || path.basename(path.dirname(file)) === 'stop-terminals') {
        if (value.runId) terminals.set(value.runId, { ...terminals.get(value.runId), ...value });
      } else evaluations.push({ taskId, file, ...value });
    }
  }
  journal.sort((left, right) => at(left.recordedAt) - at(right.recordedAt));
  const nativeStops = (await jsonFiles(path.join(rc, 'openclaw/native-stop-reviews'), 1)).map(row => row.value)
    .filter(value => !sessionId || value.sessionId === sessionId);
  const nativeRuns = (await jsonFiles(path.join(rc, 'openclaw/native-runs'), 1)).map(row => row.value)
    .filter(value => taskIds.includes(value.taskId));
  const materialBasis = (await jsonFiles(path.join(rc, 'openclaw/material-basis'))).filter(row => row.file.endsWith('.unverified.json'))
    .map(row => ({ file: path.basename(row.file), status: row.value.status ?? null, reason: row.value.reason ?? null, recordedAt: row.value.recordedAt ?? null }));
  const cost = async runs => {
    if (!runs.length) return { requests: 0, tokens: 0 };
    if (!nativeRoot) return { requests: null, tokens: null };
    const { usage } = await measureSimplifyBenchmark({ nativeRoot, privateRuns: runs });
    return { requests: usage.observedCalls, tokens: usage.observedCalls === usage.completeCalls ? usage.tokens : null };
  };

  const documentReviews = [];
  let previous = -Infinity;
  for (const event of journal.filter(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW')) {
    const end = at(event.recordedAt), within = row => at(row.recordedAt) > previous && at(row.recordedAt) <= end;
    const meta = event.result?.metadata ?? {}, semantic = meta.semanticReview ?? {};
    const runs = nativeRuns.filter(run => run.role === 'artifact-reviewer' && run.startedAt > previous && run.startedAt <= end);
    const envelopes = journal.filter(row => row.type === 'REVIEWER_ENVELOPE' && row.role === 'artifact-reviewer' && within(row));
    const reasonCode = [meta.reasonCode, event.result?.reasonCode, meta.materialBasis?.reasonCode].find(Boolean)
      ?? (semantic.status && semantic.status !== 'completed' ? `SEMANTIC_${String(semantic.status).toUpperCase()}` : null);
    // Released reviewer sessions leave no frames; the journaled envelopes carry
    // the same provider usage (input + output + cache read/write tokens).
    const measured = await cost(runs), usage = envelopes.map(row => row.reviewerEnvelope?.usage);
    const envelopeTokens = usage.length && usage.every(Boolean) ? usage.reduce((total, value) => total + ['input_tokens', 'output_tokens', 'cache_read_input_tokens',
      'cache_creation_input_tokens'].reduce((part, key) => part + (Number.isSafeInteger(value[key]) ? value[key] : 0), 0), 0) : null;
    documentReviews.push({ kind: 'document', stage: meta.stage ?? null, file: event.file ? path.relative(projectRoot, event.file).replaceAll('\\', '/') : null,
      roundId: meta.roundId ?? null, status: event.result?.status ?? null, semanticStatus: semantic.status ?? null, reasonCode,
      classification: null, fullObjectCount: null, selectedObjectCount: null, scanCompleted: null,
      deviations: semantic.findingCount ?? count(event.result?.diagnostics), editTargets: semantic.editTargetCount ?? null,
      feedbackDelivered: journal.some(row => row.type === 'OPENCLAW_FEEDBACK_DELIVERED' && row.toolCallId === event.toolCallId),
      formatRepairs: journal.filter(row => row.type === 'REVIEWER_OUTPUT_INVALID' && row.role === 'artifact-reviewer' && within(row)).length,
      durationMs: wall(runs) ?? (envelopes.length ? envelopes.reduce((sum, row) => sum + (row.reviewerEnvelope?.duration_ms ?? 0), 0) : null),
      requests: measured.requests, tokens: runs.length && measured.tokens !== null ? measured.tokens : envelopeTokens ?? measured.tokens,
      tokenSource: runs.length && measured.tokens !== null ? 'session' : envelopeTokens !== null ? 'envelope' : null,
      basisBudget: meta.basisBudget ?? null, recordedAt: event.recordedAt ?? null,
      settled: ['passed', 'failed'].includes(event.result?.status) && semantic.status === 'completed' && !/^MATERIAL_BASIS_/u.test(reasonCode ?? '') });
    previous = end;
  }

  const settledEvents = journal.filter(row => row.type === 'STOP_CORRECTION_SETTLED');
  const stageOf = new Map(turns.flatMap(turn => [[turn.runId, turn.stage], [turn.finalRunId, turn.stage]]));
  const runIds = [...new Set([...nativeStops.map(row => row.runId), ...evaluations.map(row => row.core?.stop?.id), ...terminals.keys(),
    ...settledEvents.map(row => row.stopId)].filter(value => typeof value === 'string' && value !== 'null'))];
  // A ledger check "<runId>:check-N" is the review of native run <runId>; the
  // native record then only adds timing, never a second row or status.
  const checked = new Set(runIds.map(checkBase).filter(Boolean));
  const stopReviews = [];
  for (const runId of runIds.filter(id => !checked.has(id))) {
    const base = checkBase(runId), native = nativeStops.find(row => row.runId === (base ?? runId)), terminal = terminals.get(runId);
    const inherited = base ? terminals.get(base) : undefined;
    const evaluation = evaluations.filter(row => row.core?.stop?.id === runId).at(-1)
      ?? evaluations.find(row => native?.evaluationId && row.evaluationId === native.evaluationId);
    const event = settledEvents.filter(row => row.stopId === runId).at(-1);
    const review = evaluation?.review ?? evaluation?.outcome?.review ?? {}, scope = review.scopeSelection ?? {};
    const coverage = evaluation?.coverage ?? review.coverage ?? native?.coverage ?? terminal?.coverage ?? null;
    const ledger = [terminal?.status, event?.status, evaluation?.outcome?.status, evaluation?.core?.stop?.reviewStatus];
    const status = (base ? [...ledger, inherited?.status, native?.reviewStatus] : [native?.reviewStatus, ...ledger]).find(Boolean) ?? null;
    const reasonCode = (base ? [terminal?.reasonCode, event?.reasonCode, evaluation?.outcome?.reasonCode, inherited?.reasonCode, native?.reasonCode]
      : [terminal?.reasonCode, native?.reasonCode, event?.reasonCode, evaluation?.outcome?.reasonCode]).find(Boolean) ?? null;
    const startedAt = (base ? [evaluation?.core?.stop?.startedAt, native?.startedAt] : [native?.startedAt, evaluation?.core?.stop?.startedAt]).find(Number.isFinite) ?? null;
    const finishedAt = (base ? [evaluation?.core?.stop?.assessmentFinishedAt, native?.assessmentCompletedAt, native?.settledAt]
      : [native?.assessmentCompletedAt, evaluation?.core?.stop?.assessmentFinishedAt, native?.settledAt]).find(Number.isFinite) ?? null;
    const runs = Number.isFinite(startedAt) ? nativeRuns.filter(run => ['stop-reviewer', 'ground-truth-extractor'].includes(run.role)
      && run.startedAt >= startedAt && run.startedAt <= (native?.settledAt ?? finishedAt ?? Infinity) + 1000) : [];
    stopReviews.push({ kind: 'stop', runId, stage: stageOf.get(runId) ?? (base && stageOf.get(base)) ?? review.stage ?? scope.stage ?? null, status, reasonCode,
      classification: coverage?.classification ?? scope.classification ?? review.stopClassification ?? null,
      fullObjectCount: coverage?.fullObjectCount ?? scope.fullObjectCount ?? null,
      selectedObjectCount: coverage?.selectedObjectCount ?? scope.selectedObjectCount ?? null,
      scanCompleted: coverage?.scanCompleted ?? review.collection?.complete ?? null,
      coverageSource: coverage ? 'coverage' : evaluation ? 'scopeSelection' : null,
      deviations: count(evaluation?.core?.summary?.deviations) ?? count(evaluation?.core?.stop?.currentDeviations) ?? count(review.findings),
      verificationIncomplete: evaluation?.outcome?.verificationIncomplete ?? null, evaluationId: evaluation?.evaluationId ?? native?.evaluationId ?? terminal?.evaluationId ?? null,
      durationMs: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? finishedAt - startedAt : null, ...await cost(runs),
      basisBudget: coverage?.basisBudget ?? evaluation?.basisBudget ?? review.basisBudget ?? native?.basisBudget ?? null,
      lifecycle: native?.status ?? (event ? 'SETTLED' : null), startedAt });
  }
  stopReviews.sort((left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity));
  return { taskIds, documentReviews, stopReviews, materialBasis,
    counts: Object.fromEntries(['OPENCLAW_ARTIFACT_REVIEW', 'OPENCLAW_FEEDBACK_DELIVERED', 'REVIEWER_ENVELOPE', 'REVIEWER_OUTPUT_INVALID', 'STOP_CORRECTION_SETTLED']
      .map(type => [type, journal.filter(row => row.type === type).length])) };
}

export function finalStopOf(stopReviews, turns = []) {
  const final = turns.at(-1);
  for (const runId of [final?.finalRunId, final?.runId]) {
    const found = runId && stopReviews.findLast(row => row.runId === runId || checkBase(row.runId) === runId);
    if (found) return found;
  }
  return null;
}

// A run "runs through" only when every condition below is independently
// evidenced. Each unmet condition is reported; none is inferred.
export function computeReleaseVerdict({ businessNatural, frameworkError = false, hidden, documentReviews = [], stopReviews = [], materialBasis = [], turns = [], mutationPaths }) {
  const reasons = [], finalStop = finalStopOf(stopReviews, turns), changed = codeChanged(mutationPaths);
  if (frameworkError) reasons.push('FRAMEWORK_ERROR');
  if (businessNatural !== true) reasons.push('BUSINESS_NOT_NATURAL');
  if (hidden?.executed !== true) reasons.push('HIDDEN_NOT_EXECUTED');
  if (!documentReviews.length) reasons.push('NO_DOCUMENT_REVIEW');
  for (const row of documentReviews) if (!row.settled) reasons.push(`DOCUMENT_UNSETTLED:${row.stage ?? row.file}:${row.reasonCode ?? row.status}`);
  for (const row of stopReviews) {
    if (/^MATERIAL_BASIS_/u.test(row.reasonCode ?? '')) reasons.push(`STOP_${row.reasonCode}:${row.runId}`);
    else if (row.status === 'UNVERIFIED') reasons.push(`STOP_UNVERIFIED:${row.reasonCode ?? 'UNKNOWN'}:${row.runId}`);
    else if (!SETTLED_STOP.has(row.status) && !(row.status === 'SKIPPED' && row.reasonCode === DOCUMENT_ONLY)) reasons.push(`STOP_UNSETTLED:${row.status ?? 'MISSING'}:${row.runId}`);
  }
  for (const row of materialBasis) if (/^MATERIAL_BASIS_/u.test(row.reason ?? row.status ?? '') || row.status === 'UNVERIFIED') reasons.push(`MATERIAL_BASIS_UNVERIFIED:${row.reason ?? row.status}`);
  let finalCoverage = 'MISSING';
  if (finalStop) {
    if (finalStop.status === 'SKIPPED' && finalStop.reasonCode === DOCUMENT_ONLY) finalCoverage = changed === false ? 'DOCUMENT_ONLY' : 'SKIPPED_WITH_CODE_CHANGES';
    else if (SETTLED_STOP.has(finalStop.status) && finalStop.selectedObjectCount > 0 && finalStop.scanCompleted === true) finalCoverage = 'COVERED';
    else finalCoverage = SETTLED_STOP.has(finalStop.status) ? `NO_COVERAGE:${finalStop.classification ?? 'UNKNOWN'}:${finalStop.selectedObjectCount ?? '?'}/${finalStop.fullObjectCount ?? '?'}`
      : `UNSETTLED:${finalStop.status ?? 'MISSING'}`;
  }
  if (!['COVERED', 'DOCUMENT_ONLY'].includes(finalCoverage)) reasons.push(`FINAL_STOP_${finalCoverage}`);
  return { runThrough: reasons.length === 0, reasons: [...new Set(reasons)], finalCoverage, finalStop, codeChanged: changed };
}

const sum = (rows, key) => rows.some(row => row[key] === null) ? null : rows.reduce((total, row) => total + (row[key] ?? 0), 0);
export function tokenSplit({ documentCost, stopCost, businessUsage, documentReviews = [], stopReviews = [] }) {
  const rcTokens = documentCost?.usage && stopCost?.usage ? [documentCost.usage.tokens, stopCost.usage.tokens] : [sum(documentReviews, 'tokens'), sum(stopReviews, 'tokens')];
  const rcRequests = documentCost?.usage && stopCost?.usage ? [documentCost.usage.observedCalls, stopCost.usage.observedCalls] : [sum(documentReviews, 'requests'), sum(stopReviews, 'requests')];
  const total = values => values.some(value => value === null || value === undefined) ? null : values.reduce((a, b) => a + b, 0);
  return { rc: { requests: total(rcRequests), tokens: total(rcTokens), document: { requests: rcRequests[0], tokens: rcTokens[0] }, stop: { requests: rcRequests[1], tokens: rcTokens[1] } },
    business: { requests: businessUsage?.observedCalls ?? null, tokens: businessUsage?.tokens ?? null } };
}
export function hiddenScore(hidden) {
  const score = hidden?.score;
  return score ? { executed: hidden.executed === true, f2p: `${score.f2p_passed}/${score.f2p_total}`, p2p: `${score.p2p_passed}/${score.p2p_total}`,
    resolved: score.f2p_passed === score.f2p_total && score.p2p_passed === score.p2p_total } : { executed: hidden?.executed === true, f2p: null, p2p: null, resolved: null };
}
