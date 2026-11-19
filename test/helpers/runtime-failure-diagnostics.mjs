// Failure-only projections for synthetic fixtures. Never print prompts, source,
// arbitrary error prose, identifiers or tool payloads into CI logs.
import fs from 'node:fs/promises';
import path from 'node:path';

const token = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
const role = value => ['ground-truth-extractor', 'artifact-reviewer', 'skill-reviewer', 'stop-reviewer'].includes(value) ? value : undefined;
const number = value => Number.isFinite(value) ? value : undefined;
const count = value => Array.isArray(value) ? value.length : 0;
const deadline = (value, now) => Number.isFinite(value) ? { remainingMs: value - now, expired: value <= now } : undefined;
const reasonMarkers = value => ['REVIEWER_DEADLINE', 'BASELINE_AUDIT_INCOMPLETE', 'BASELINE_COVERAGE_UNVERIFIED',
  'BASELINE_REPAIR_LIMIT', 'REVIEWER_OUTPUT_LIMIT'].filter(code => typeof value === 'string' && value.includes(code));

async function readBounded(file, maxBytes, tail = false) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (!tail && size > maxBytes) return { unavailable: 'SIZE_LIMIT' };
    const start = tail ? Math.max(0, size - maxBytes) : 0, buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0 };
  } catch (error) { return { unavailable: ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'READ_FAILED' }; }
  finally { await handle?.close(); }
}

function taskProjection(task) {
  return { status: token(task?.status), verification: { status: token(task?.verification?.status),
    reasonCode: token(task?.verification?.reasonCode) }, documentCoverage: token(task?.documentCoverage?.status),
    groundTruthVersion: number(task?.groundTruth?.version), onboardingPending: count(task?.groundTruth?.onboardingPending),
    watchers: Object.values(task?.watchers ?? {}).slice(0, 16).map(watcher => ({ status: token(watcher.status),
      pendingSelection: Boolean(watcher.pendingSelection), sourceInterpretationChecked: watcher.sourceInterpretationChecked === true })) };
}

// Call this only inside a failing assertion branch. Reads are bounded to four
// task records and 64 KiB of each journal; the last relevant events are selected.
export async function runtimeFailureDiagnostics({ root, task, events, post, calls = [], warnings = [],
  submissions = [], launches = [], witnesses = {}, now = Date.now() } = {}) {
  const tasks = [], journal = [];
  if (task) tasks.push(taskProjection(task));
  if (events) journal.push(...events.slice(-128));
  if (root && !task) {
    const directory = path.join(root, '.runtime-correction/tasks');
    const names = await fs.readdir(directory).catch(() => []);
    for (const name of names.slice(0, 4)) {
      const record = await readBounded(path.join(directory, name, 'task.json'), 1024 * 1024);
      try { tasks.push(record.text ? taskProjection(JSON.parse(record.text)) : { unavailable: record.unavailable }); }
      catch { tasks.push({ unavailable: 'INVALID_JSON' }); }
      const log = await readBounded(path.join(directory, name, 'journal/events.jsonl'), 64 * 1024, true);
      for (const line of (log.text ?? '').trim().split('\n').slice(-128)) {
        try { journal.push(JSON.parse(line)); } catch { /* A truncated/in-flight final line is not a new event. */ }
      }
    }
  }
  const relevant = journal.filter(event => /REVIEW|BASELINE|GROUND_TRUTH|SKILL|STOP/u.test(event.type ?? '')).slice(-12);
  return { tasks, events: relevant.map(event => ({ type: token(event.type), code: token(event.code),
    reasonCode: token(event.reasonCode), status: token(event.status), phase: token(event.phase), role: role(event.role),
    reasonMarkers: [...new Set([...reasonMarkers(event.reason), ...reasonMarkers(event.error)])], timeoutMs: number(event.timeoutMs),
    deadline: deadline(event.deadlineAt, now), sharedDeadline: deadline(event.sharedDeadlineAt, now),
    // Comparison at event emission separates historical expiry from later diagnostic reads.
    deadlineExpiredAtEvent: Number.isFinite(Date.parse(event.recordedAt)) && Number.isFinite(event.deadlineAt)
      ? Date.parse(event.recordedAt) >= event.deadlineAt : undefined })),
    post: post ? { phase: token(post.phase), reviewStatus: token(post.reviewStatus), reasonCode: token(post.reasonCode ?? post.reason),
      deadline: deadline(post.deadlineAt, now), candidatePresent: Boolean(post.candidate) } : undefined,
    calls: { total: calls.length, roles: calls.slice(-16).map(call => role(call.role)).filter(Boolean),
      warnings: warnings.length + calls.filter(call => Object.hasOwn(call, 'warning')).length },
    witnesses: { artifacts: count(witnesses.artifacts), stop: count(witnesses.stop), m08: count(witnesses.m08) },
    auditCounts: { launches: launches.length, submissions: submissions.length },
    // Launch elapsed/expiry is measured at diagnostic entry, after hook return;
    // it cannot establish whether a deadline caused the earlier audit failure.
    launches: launches.slice(-4).map(launch => ({ timeoutMs: number(launch.timeoutMs),
      originalBudgetRemainingMs: number(launch.originalBudgetRemainingMs),
      elapsedAtDiagnosticMs: Number.isFinite(launch.startedAt) ? now - launch.startedAt : undefined,
      originalBudgetAtDiagnostic: deadline(launch.originalDeadlineAt, now) })),
    submissions: submissions.slice(-4).map(submission => {
      let receipt;
      try { receipt = JSON.parse((submission.result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')); }
      catch { /* The count/error bit remains useful for malformed feedback. */ }
      return { attempt: number(submission.attempt), isError: submission.result?.isError === true,
        accepted: typeof receipt?.accepted === 'boolean' ? receipt.accepted : undefined,
        complete: typeof receipt?.complete === 'boolean' ? receipt.complete : undefined, code: token(receipt?.code),
        pending: count(receipt?.pending), receiptParsed: Boolean(receipt) };
    }) };
}
