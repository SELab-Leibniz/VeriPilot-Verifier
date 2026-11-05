import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateJson } from "./controller-store.mjs";
import { readJson, sha256 } from "../runtime-v2/utils.mjs";
import { withTaskResourceLock } from "../runtime-v2/task-store.mjs";
import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";

const copy = value => structuredClone(value);
const busy = record => !["IDLE", "CLOSED"].includes(record.phase);
const conflict = message => Object.assign(new Error(message), { code: "CONFLICT" });
const same = (a, b) => ["agentId", "sessionKey", "sessionId", "projectRoot", "scopeFingerprint", "scopeTaskId"].every(k => a[k] === b[k]) && (a.controlRevision ?? 0) === (b.controlRevision ?? 0);
const identityKeys = ["agentId", "sessionKey", "sessionId", "projectRoot", "scopeFingerprint", "scopeTaskId", "controlRevision"];
const successorKeys = new Set(["identity", "predecessorRunId", "checkpointDigest", "runId", "text", "needsReview", "reviewBudgetMs", "terminalBudgetMs"]);
function successorFor(value, record) {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !successorKeys.has(key))
    || !value.identity || Object.keys(value.identity).some(key => !identityKeys.includes(key)) || !same(value.identity, record)
    || identityKeys.some(key => value.identity[key] !== undefined && (key === "controlRevision"
      ? !Number.isSafeInteger(value.identity[key]) || value.identity[key] < 0
      : typeof value.identity[key] !== "string" || !value.identity[key] || value.identity[key].length > 16384))
    || typeof value.runId !== "string" || !value.runId || value.runId.length > 512 || value.runId === record.runId
    || value.predecessorRunId !== record.runId || typeof value.checkpointDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.checkpointDigest)
    || typeof value.text !== "string" || value.text.length > 200000 || typeof value.needsReview !== "boolean"
    || [value.reviewBudgetMs, value.terminalBudgetMs].some(ms => !Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647)) return null;
  return copy(value);
}
export const POST_RUN_RECONCILIATION = Object.freeze({ intervalMs: 5000, maxRetries: 12, escalationMs: 60000 });

/** A FIFO pool shared by sessions; waiting consumes the existing review window. */
export function createPostRunReviewPool(limit = 3) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error("Invalid Stop review concurrency.");
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const item = queue.shift();
      if (item.cancelled) continue;
      active++;
      let released = false;
      item.release = () => { if (!released) { released = true; active--; pump(); } };
      item.resolve(item.release);
    }
  };
  return {
    async run(run, { deadlineAt, signal } = {}) {
      let item, release;
      try {
        release = await beforeStopDeadline(() => new Promise(resolve => {
          item = { resolve }; queue.push(item); pump();
        }), { deadlineAt, signal });
      } catch (error) { if (item) { item.cancelled = true; item.release?.(); } throw error; }
      try { return await beforeStopDeadline(run, { deadlineAt, signal }); } finally { release(); }
    },
  };
}

/**
 * Durable scheduling between fully ended host runs. No browser owns execution,
 * no dispatch request waits for a review, and no network/model call holds a lock.
 */
export function createPostRunDispatcher({ directoryFor, defaultDirectory, validate, waitTerminal, review, sendUser,
  cancelCorrection, beforeReview, concurrency = 3, onError = () => {}, reconciliation = POST_RUN_RECONCILIATION }) {
  const policy = { ...POST_RUN_RECONCILIATION, ...reconciliation };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid reconciliation policy.");
  const records = new Map(), work = new Map(), controllers = new Map(), timers = new Map();
  const pool = createPostRunReviewPool(concurrency);
  let closed = false;
  const operations = new Set();
  const reportError = error => { try { onError(error); } catch {} };
  const file = record => path.join(record.directory, `${record.id}.json`);
  const audit = async (record, action, actor, details = {}) => {
    if (typeof actor !== "string" || !actor || actor.length > 160) throw new Error("Authenticated actor required.");
    const row = { id: randomUUID(), action, actor, runId: record.runId, at: Date.now(), ...details };
    await fs.appendFile(path.join(record.directory, `${record.id}.audit.jsonl`), JSON.stringify(row) + "\n", { mode: 0o600 });
    record.recoveryAudit = [...record.recoveryAudit ?? [], row].slice(-50);
  };
  const assertRecovery = (record, { runId, version }) => {
    if (closed || !busy(record) || record.runId !== runId || record.version !== version)
      throw conflict("Run or session state changed; refresh before recovery.");
  };
  const taskHistory = (record, task, status, extra = {}) => {
    record.history ??= [];
    let row = record.history.find(row => row.id === task.id);
    if (!row) { row = { id: task.id, createdAt: task.createdAt }; record.history.push(row); }
    Object.assign(row, { text: task.text.slice(0, 4000), truncated: task.text.length > 4000,
      revision: task.revision, status, updatedAt: Date.now() }, extra);
    record.history = record.history.slice(-50);
  };
  const save = async record => {
    record.version++; record.updatedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      try { return await privateJson(file(record), record); }
      catch (error) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error.code) || attempt >= 7) throw error;
        // Windows scanners can briefly hold the destination across an atomic
        // rename. Retain private file permissions and the same task intent.
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 250)));
      }
    }
  };
  const locked = (record, callback) => withTaskResourceLock({ projectRoot: record.directory,
    taskId: record.id, resource: "post-run", reclaimDeadOwner: true, timeoutMs: 3000 }, async () => {
    const current = await readJson(file(record));
    if (current) { Object.assign(record, current); records.set(record.id, record); }
    return callback(record);
  });
  const spawn = (id, run) => {
    const previous = work.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run).catch(reportError);
    work.set(id, next);
    void next.finally(() => { if (work.get(id) === next) work.delete(id); });
    return next;
  };
  const cancelTimer = id => { clearTimeout(timers.get(id)); timers.delete(id); };
  const arm = record => {
    cancelTimer(record.id);
    if (!["WAIT_CORRECTION", "CORRECTING"].includes(record.phase)) return;
    // Only an explicitly unbounded, already-started business correction may
    // omit its deadline. Admission and semantic review remain time-bounded.
    if (record.phase === "CORRECTING" && record.deadlineAt === null) return;
    const { runId, correctionRunId, deadlineAt } = record;
    // A fired timer can still be waiting behind review work when a trusted start
    // replaces the admission window with a fresh execution window.
    const timer = setTimeout(() => { spawn(record.id, () =>
      finish(record, runId, "UNVERIFIED", "POST_RUN_EXECUTION_TIMEOUT", { cancel: true, stillCurrent: current =>
        current.correctionRunId === correctionRunId && current.deadlineAt === deadlineAt
        && ["WAIT_CORRECTION", "CORRECTING"].includes(current.phase) }));
    }, Math.max(1, deadlineAt - Date.now()));
    timer.unref?.(); timers.set(record.id, timer);
  };
  const reconcileLater = async (record, ownerRunId = record.runId) => {
    let delay;
    await locked(record, async r => {
      if (closed || !busy(r) || r.runId !== ownerRunId) return;
      cancelTimer(r.id);
      const runId = r.terminalRelease?.runId ?? r.correctionRunId ?? r.runId;
      if (r.reconciliation?.runId !== runId) r.reconciliation = { runId, status: "UNKNOWN", attempts: 0, startedAt: Date.now() };
      const check = r.reconciliation;
      if (check.escalatedAt || check.attempts >= policy.maxRetries || Date.now() >= check.startedAt + policy.escalationMs) {
        check.escalatedAt ??= Date.now(); r.reason = "HOST_RUN_RECONCILIATION_ESCALATED";
      } else delay = Math.max(1, Math.min(policy.intervalMs, check.startedAt + policy.escalationMs - Date.now()));
      await save(r);
    });
    if (delay === undefined || closed) return;
    const timer = setTimeout(() => { timers.delete(record.id); spawn(record.id, () => reconcile(record, { ownerRunId })); }, delay);
    timer.unref?.(); timers.set(record.id, timer);
  };
  const armCoexistence = (record, ownerRunId) => {
    if (closed || record.phase !== "COEXIST_WAIT" || record.runId !== ownerRunId) return;
    cancelTimer(record.id);
    const timer = setTimeout(() => { timers.delete(record.id); spawn(record.id, () => resumeCoexistence(record, ownerRunId)); }, policy.intervalMs);
    timer.unref?.(); timers.set(record.id, timer);
  };
  async function coexistenceGate(record, signal) {
    const observed = copy(record), expected = copy(observed);
    let gate;
    try { gate = await beforeStopDeadline(() => beforeReview(observed), { deadlineAt: Date.now() + 3000, signal }); }
    catch (error) { gate = { coexistence: { status: "UNKNOWN", reason: error.code ?? "AUTOPILOT_STATUS_UNAVAILABLE" } }; }
    const coexistence = { ...gate?.coexistence, updatedAt: Date.now() };
    if (!["RUNNING", "UNKNOWN", "IDLE"].includes(coexistence.status)) coexistence.status = "UNKNOWN";
    const hold = gate?.hold === true && coexistence.status === "RUNNING";
    return { hold, coexistence, version: expected.version, successorCandidate: successorFor(gate?.successorCandidate, expected),
      isSuccessorCurrent: gate?.isSuccessorCurrent, onSuccessorAdopted: gate?.onSuccessorAdopted };
  }
  const knownTerminal = record => Number.isFinite(record.candidate?.terminalConfirmedAt) && record.candidate?.runId === record.runId
    && ["ok", "error"].includes(record.candidate.terminalStatus ?? "ok")
    ? { runId: record.runId, status: record.candidate.terminalStatus ?? "ok", confirmedAt: record.candidate.terminalConfirmedAt }
    : record.lastTerminal?.runId === record.runId && Number.isFinite(record.lastTerminal.confirmedAt)
      && ["ok", "error"].includes(record.lastTerminal.status) ? record.lastTerminal : null;
  async function adoptSuccessor(record, gate, signal) {
    const successor = gate.successorCandidate, terminal = knownTerminal(record);
    let current = false;
    if (successor) try {
      const result = typeof gate.isSuccessorCurrent === "function" ? gate.isSuccessorCurrent() : false;
      current = result === true;
      if (result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    } catch { /* Reject unverifiable ownership. */ }
    if (!successor || !terminal || !current || closed || signal?.aborted || record.successorAdmissionClosed
      || record.version !== gate.version || record.reconciliation?.status === "UNKNOWN" || record.terminalRelease
      || record.correctionRunId || record.dispatching || record.completedRuns.includes(successor.runId)) return null;
    cancelTimer(record.id);
    const { identity, predecessorRunId, checkpointDigest, terminalBudgetMs, ...candidate } = successor;
    const promotion = { predecessorRunId, runId: candidate.runId, checkpointDigest, identity,
      terminalConfirmedAt: terminal.confirmedAt, terminalStatus: terminal.status, terminalRunId: terminal.terminalRunId ?? terminal.runId,
      adoptedAt: Date.now(), adoptedVersion: record.version + 1 };
    record.completedRuns = [...new Set([...record.completedRuns, record.runId])].slice(-200);
    record.runId = candidate.runId; record.phase = "FINALIZING"; record.deadlineAt = null; record.reason = null;
    record.candidate = { ...candidate, terminalDeadlineAt: Date.now() + terminalBudgetMs };
    record.promotion = promotion; record.coexistence = gate.coexistence; record.reconciliation = null; record.recoveryConfirmation = null; record.ownerPid = process.pid;
    await save(record);
    return { ...copy(promotion), version: record.version };
  }
  async function continuePromotion(record, gate, promotion, signal) {
    queueCandidate(record, promotion.runId);
    if (typeof gate.onSuccessorAdopted === "function") try {
      await beforeStopDeadline(() => gate.onSuccessorAdopted({ provenance: promotion }), { deadlineAt: Date.now() + 3000, signal });
    } catch (error) { reportError(error); }
  }
  async function holdForCoexistence(record, runId, signal) {
    if (typeof beforeReview !== "function") return false;
    const gate = await coexistenceGate(record, signal), { coexistence, successorCandidate } = gate;
    let current = false, held = false, promotion;
    await locked(record, async r => {
      if (closed || r.runId !== runId || !["FINALIZING", "COEXIST_WAIT"].includes(r.phase) || r.candidate?.runId !== runId) return;
      const confirmed = Boolean(knownTerminal(r));
      promotion = await adoptSuccessor(r, gate, signal);
      if (promotion) return;
      r.coexistence = coexistence; current = true;
      held = gate.hold && r.candidate.terminalStatus !== "error";
      // A changed record invalidates the proposal, not the already confirmed
      // terminal. Recheck without admitting stale data or losing its wakeup.
      if (successorCandidate && confirmed && !r.successorAdmissionClosed && !r.completedRuns.includes(successorCandidate.runId)) held = true;
      if (held) { r.phase = "COEXIST_WAIT"; r.deadlineAt = null; r.reason = gate.hold ? "AUTOPILOT_RUNNING"
        : r.version !== gate.version ? "SUCCESSOR_CHECK_STALE" : "SUCCESSOR_CURRENT_UNVERIFIED"; }
      else if (r.phase === "COEXIST_WAIT") { r.phase = "FINALIZING"; r.reason = null; }
      await save(r);
    });
    if (promotion) {
      await continuePromotion(record, gate, promotion, signal);
      return true;
    }
    if (current && held) armCoexistence(record, runId);
    return !current || held;
  }
  async function resumeCoexistence(record, ownerRunId) {
    if (closed || record.phase !== "COEXIST_WAIT" || record.runId !== ownerRunId) return;
    if (record.reconciliation?.status === "UNKNOWN") return reconcile(record, { ownerRunId });
    if (!await validate(record)) return api.close(record, "SESSION_REPLACED");
    if (await holdForCoexistence(record, ownerRunId)) return;
    let candidate;
    await locked(record, async r => {
      if (closed || r.phase !== "FINALIZING" || r.runId !== ownerRunId || r.candidate?.runId !== ownerRunId) return;
      candidate = copy(r.candidate); r.candidate = null; r.phase = "RUNNING"; await save(r);
    });
    if (candidate) await api.candidate(record, { ...candidate, terminalBudgetMs: 5000 });
  }
  async function reconcile(record, { manual = false, ownerRunId = record.runId } = {}) {
    if (closed || !busy(record)) return;
    if (record.phase === "COEXIST_WAIT" && record.reconciliation?.status !== "UNKNOWN") return resumeCoexistence(record, ownerRunId);
    let admitted = false;
    await locked(record, async r => {
      if (closed || !busy(r) || r.runId !== ownerRunId) return;
      const runId = r.terminalRelease?.runId ?? r.correctionRunId ?? ownerRunId;
      if (r.reconciliation?.runId !== runId) r.reconciliation = { runId, status: "UNKNOWN", attempts: 0, startedAt: Date.now() };
      const check = r.reconciliation;
      if (!manual && (check.escalatedAt || check.attempts >= policy.maxRetries || Date.now() >= check.startedAt + policy.escalationMs)) {
        check.escalatedAt ??= Date.now(); r.reason = "HOST_RUN_RECONCILIATION_ESCALATED";
      } else { if (!manual) check.attempts++; admitted = true; }
      await save(r);
    });
    if (!admitted) return;
    const runId = record.terminalRelease?.runId ?? record.correctionRunId ?? ownerRunId;
    if (!await validate(record)) return api.close(record, "SESSION_REPLACED");
    let terminal;
    const controller = new AbortController(); controllers.set(record.id, controller);
    const deadlineAt = Date.now() + (manual ? 5000 : Math.max(1, Math.min(5000, record.reconciliation.startedAt + policy.escalationMs - Date.now())));
    try { terminal = await beforeStopDeadline(() => waitTerminal(copy(record), runId, deadlineAt, controller.signal),
      { deadlineAt, signal: controller.signal }); } catch { /* Unknown is never a resend. */ }
    finally { if (controllers.get(record.id) === controller) controllers.delete(record.id); }
    if (closed || record.runId !== ownerRunId || record.phase === "CLOSED") return;
    if (["ok", "error"].includes(terminal?.status)) {
      let confirmed = false;
      await locked(record, async r => {
        if (closed || r.runId !== ownerRunId || !busy(r)
          || (r.terminalRelease?.runId ?? r.correctionRunId ?? r.runId) !== runId) return;
        // This probe is real host evidence, including an error terminal. Keep
        // it when finish clears the old candidate or recovery had none at all.
        r.lastTerminal = { runId: ownerRunId, terminalRunId: runId, status: terminal.status, confirmedAt: Date.now() };
        r.reconciliation = null; await save(r); confirmed = true;
      });
      if (!confirmed || record.runId !== ownerRunId || !busy(record)) return;
      if (record.phase === "RELEASING") return finish(record, ownerRunId,
        record.terminalRelease?.status ?? "UNVERIFIED", record.terminalRelease?.reason ?? "POST_RUN_OWNER_RECOVERED", { confirmedRunId: runId });
      const candidate = record.candidate;
      if (terminal.status === "ok" && candidate?.runId === runId && !record.completedRuns.includes(runId)) {
        if (record.phase.startsWith("REVIEW") && record.deadlineAt) {
          candidate.reviewBudgetMs = Math.min(candidate.reviewBudgetMs, record.deadlineAt - Date.now());
          if (candidate.reviewBudgetMs <= 0) return finish(record, ownerRunId, "UNVERIFIED", "POST_RUN_OWNER_RECOVERED");
        }
        let resumed = false;
        await locked(record, async r => {
          if (closed || r.runId !== ownerRunId || r.candidate?.runId !== runId || r.terminalRelease
            || r.correctionRunId || r.dispatching || !["FINALIZING", "COEXIST_WAIT", "REVIEW_QUEUED", "REVIEWING"].includes(r.phase)) return;
          r.candidate = null; r.phase = "RUNNING"; await save(r); resumed = true;
        });
        if (resumed) await api.candidate(record, { ...candidate, terminalBudgetMs: 5000 });
      } else await finish(record, ownerRunId, "UNVERIFIED", "POST_RUN_OWNER_RECOVERED");
    } else {
      await locked(record, async r => { if (r.runId === ownerRunId && busy(r)) { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); } });
      await reconcileLater(record, ownerRunId);
    }
  }
  async function dispatchUser(record) {
    if (typeof beforeReview === "function" && !closed && record.phase === "IDLE"
      && (record.pending.length || !record.successorAdmissionClosed && knownTerminal(record))) {
      if (!await validate(record)) return api.close(record, "SESSION_REPLACED");
      const ownerRunId = record.runId, gate = await coexistenceGate(record);
      let held = false, promotion;
      await locked(record, async r => {
        if (closed || r.phase !== "IDLE" || r.runId !== ownerRunId) return;
        promotion = await adoptSuccessor(r, gate);
        if (promotion) return;
        r.coexistence = gate.coexistence;
        held = gate.hold || Boolean(gate.successorCandidate && knownTerminal(r)
          && !r.successorAdmissionClosed && !r.completedRuns.includes(gate.successorCandidate.runId));
        if (held) r.reason = gate.hold ? "AUTOPILOT_RUNNING" : "SUCCESSOR_CHECK_UNVERIFIED";
        await save(r);
      });
      if (promotion) return continuePromotion(record, gate, promotion);
      if (held) {
        if (closed || record.phase !== "IDLE" || record.runId !== ownerRunId) return;
        cancelTimer(record.id);
        const timer = setTimeout(() => { timers.delete(record.id); spawn(record.id, () => dispatchUser(record)); }, policy.intervalMs);
        timer.unref?.(); timers.set(record.id, timer); return;
      }
    }
    let task;
    await locked(record, async r => {
      if (closed || r.phase !== "IDLE" || !r.pending.length) return;
      task = r.pending.shift();
      r.dispatching = { ...task, status: "DISPATCHING", runId: `rc-user-${task.id}`, claimedAt: Date.now() };
      r.phase = "USER_DISPATCHING"; r.runId = r.dispatching.runId;
      taskHistory(r, task, 'DISPATCHING', { runId: r.runId });
      await save(r);
    });
    if (!task) return;
    try {
      if (!await validate(record)) throw conflict("Session or project changed before task start.");
      if (closed || record.phase !== "USER_DISPATCHING" || record.dispatching?.id !== task.id) return;
      // The persisted intent is never automatically replayed after an unknown ACK.
      const response = await sendUser(copy(record), copy(record.dispatching));
      await locked(record, async r => {
        if (r.dispatching?.id !== task.id) return;
        r.dispatching.status = response?.runId === r.dispatching.runId ? "QUEUED" : "UNKNOWN";
        taskHistory(r, r.dispatching, r.dispatching.status, { runId: r.dispatching.runId });
        await save(r);
      });
    } catch (error) {
      await locked(record, async r => {
        if (r.dispatching?.id !== task.id) return;
        r.dispatching.status = "UNKNOWN"; r.reason = error.code ?? "USER_DISPATCH_UNKNOWN";
        taskHistory(r, r.dispatching, 'UNKNOWN', { runId: r.dispatching.runId, reason: r.reason });
        await save(r);
      });
    }
    if (record.phase === "USER_DISPATCHING") await reconcileLater(record, `rc-user-${task.id}`);
  }
  async function finish(record, runId, status, reason, { cancel = false, stillCurrent = () => true, confirmedRunId, dispatch = true } = {}) {
    let ready = false, owned, ownedStopId, hostTerminalKnown;
    await locked(record, async r => {
      if (r.runId !== runId || !busy(r) || !stillCurrent(r)) return;
      if (r.phase === "RELEASING" && (cancel || confirmedRunId !== (r.terminalRelease?.runId ?? runId))) return;
      owned = r.correctionRunId; ownedStopId = r.correctionStopId;
      hostTerminalKnown = confirmedRunId === (owned ?? runId)
        || (!owned || owned === runId) && ["REVIEW_QUEUED", "REVIEWING"].includes(r.phase);
      const terminal = knownTerminal(r);
      if (hostTerminalKnown || terminal && !owned) r.lastTerminal = { runId, terminalRunId: confirmedRunId ?? terminal?.terminalRunId ?? owned ?? runId,
        status: terminal?.status ?? "ok", confirmedAt: terminal?.confirmedAt ?? Date.now() };
      if (["USER_CONFIRMED_CANCEL", "USER_SAFE_RELEASE"].includes(reason)) r.successorAdmissionClosed = true;
      cancelTimer(r.id);
      r.phase = cancel ? "RELEASING" : "IDLE"; r.reviewStatus = status; r.reason = reason ?? null;
      for (const ended of [runId, cancel && r.correctionRunId].filter(Boolean)) {
        if (!r.completedRuns.includes(ended)) r.completedRuns.push(ended);
      }
      r.completedRuns = r.completedRuns.slice(-200);
      r.correctionRunId = null; r.correctionStopId = null; r.candidate = null; r.updatedAt = Date.now();
      r.terminalRelease = cancel ? { runId: owned ?? runId, status, reason: reason ?? null } : null;
      if (r.dispatching?.runId === runId) { r.lastDispatched = { ...r.dispatching, status: "FINISHED" }; r.dispatching = null; }
      if (r.lastDispatched?.runId === runId) {
        r.lastDispatched.status = cancel ? 'CANCEL_PENDING' : 'FINISHED';
        taskHistory(r, r.lastDispatched, r.lastDispatched.status, { runId, reviewStatus: status, reason, endedAt: cancel ? null : Date.now() });
      }
      await save(r); ready = true;
    });
    if (!ready) return;
    if (cancel) {
      controllers.get(record.id)?.abort(Object.assign(new Error(reason), { code: reason }));
      if (owned) await beforeStopDeadline(() => cancelCorrection?.({ ...copy(record), correctionStopId: ownedStopId }, owned, reason),
        { deadlineAt: Date.now() + 15000 }).catch(reportError);
      // An abort acknowledgement or RC failure does not prove that the host
      // finished draining the run. Persist the exact run and reconcile it before
      // releasing a task, including after a Gateway restart.
      let terminal = hostTerminalKnown ? { status: "ok" } : null;
      if (!hostTerminalKnown) {
        const controller = new AbortController();
        if (closed) controller.abort(); else controllers.set(record.id, controller);
        try { terminal = await beforeStopDeadline(() => waitTerminal(copy(record), owned ?? runId, Date.now() + 5000, controller.signal),
          { deadlineAt: Date.now() + 5000, signal: controller.signal }); } catch { /* Unknown keeps the queue held. */ }
        finally { if (controllers.get(record.id) === controller) controllers.delete(record.id); }
      }
      let reconcileNeeded = false;
      await locked(record, async r => {
        ready = r.phase === "RELEASING" && r.runId === runId;
        if (!ready) return;
        if (["ok", "error"].includes(terminal?.status)) { r.phase = "IDLE"; r.reason = reason ?? null; r.terminalRelease = null; r.reconciliation = null;
          r.lastTerminal = { runId, terminalRunId: owned ?? runId, status: terminal.status, confirmedAt: Date.now() };
          if (r.lastDispatched?.runId === runId) taskHistory(r, r.lastDispatched, 'FINISHED', { runId, reviewStatus: status, reason, endedAt: Date.now() }); }
        else { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; ready = false; reconcileNeeded = true; }
        await save(r);
      });
      if (reconcileNeeded) await reconcileLater(record, runId);
    }
    if (ready && dispatch) await dispatchUser(record);
  }
  function queueCandidate(record, runId) {
    return spawn(record.id, async () => {
      if (closed || record.runId !== runId || record.phase !== "FINALIZING" || record.candidate?.runId !== runId) return;
      const reviewBudgetMs = record.candidate.reviewBudgetMs;
      const controller = new AbortController(); controllers.set(record.id, controller);
      let terminalConfirmed = false;
      try {
        const terminalDeadlineAt = record.candidate.terminalDeadlineAt;
        const terminal = await beforeStopDeadline(() => waitTerminal(copy(record), runId, terminalDeadlineAt, controller.signal),
          { deadlineAt: terminalDeadlineAt, signal: controller.signal });
        if (closed || record.runId !== runId || record.phase === "CLOSED") return;
        if (!["ok", "error"].includes(terminal?.status)) {
          await locked(record, async r => { if (r.runId === runId && busy(r)) { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); } });
          await reconcileLater(record, runId); return;
        }
        terminalConfirmed = true;
        if (!await validate(record)) return api.close(record, "SESSION_REPLACED");
        if (closed || record.runId !== runId || record.phase !== "FINALIZING") return;
        await locked(record, async r => {
          if (r.runId !== runId || r.phase !== "FINALIZING" || r.candidate?.runId !== runId) return;
          r.candidate.terminalConfirmedAt ??= Date.now(); r.candidate.terminalStatus = terminal.status; await save(r);
        });
        if (await holdForCoexistence(record, runId, controller.signal)) return;
        if (terminal.status !== "ok") return finish(record, runId, "UNVERIFIED", "HOST_RUN_NOT_COMPLETED");
        if (!record.candidate.needsReview) return finish(record, runId, "DISABLED", "STOP_NOT_REQUIRED");
        const deadlineAt = Date.now() + reviewBudgetMs;
        await locked(record, async r => {
          if (r.runId !== runId) return;
          if (r.phase !== "FINALIZING" || r.runId !== runId) return;
          r.phase = "REVIEW_QUEUED"; r.deadlineAt = deadlineAt; await save(r);
        });
        await pool.run(async () => {
          let admitted = false;
          await locked(record, async r => {
            if (closed || r.phase !== "REVIEW_QUEUED" || r.runId !== runId) return;
            r.phase = "REVIEWING"; await save(r); admitted = true;
          });
          if (!admitted) return;
          const result = await review(copy(record), { deadlineAt, signal: controller.signal });
          if (controller.signal.aborted || record.runId !== runId
            || !["REVIEWING", "WAIT_CORRECTION", "CORRECTING"].includes(record.phase)) return;
          if (result?.reviewSummary) await locked(record, async r => {
            if (!controller.signal.aborted && r.runId === runId && ["REVIEWING", "WAIT_CORRECTION", "CORRECTING"].includes(r.phase)) {
              r.reviewSummary = result.reviewSummary; await save(r);
            }
          });
          if (["WAIT_CORRECTION", "CORRECTING"].includes(record.phase)) return;
          await finish(record, runId, result?.reviewStatus ?? "UNVERIFIED", result?.reasonCode);
        }, { deadlineAt, signal: controller.signal });
      } catch (error) {
        if (!closed && record.runId === runId && record.phase !== "CLOSED") {
          if (terminalConfirmed) await finish(record, runId, "UNVERIFIED", error.code ?? "POST_RUN_REVIEW_FAILED", { cancel: true, confirmedRunId: runId });
          else { await locked(record, async r => { if (r.runId === runId && busy(r)) { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); } }); await reconcileLater(record, runId); }
        }
      } finally {
        if (controllers.get(record.id) === controller) controllers.delete(record.id);
        await locked(record, async r => {
          if (r.runId !== runId) return;
          if (!["FINALIZING", "COEXIST_WAIT"].includes(r.phase) && !r.completedRuns.includes(runId)) r.completedRuns.push(runId);
          r.completedRuns = r.completedRuns.slice(-200); await save(r);
        });
      }
    });
  }
  const api = {
    get closed() { return closed; },
    byId(id) { const record = records.get(id); return record ? copy(record) : null; },
    get(identity) { return [...records.values()].find(r => same(r, identity)); },
    busy(identity) { const record = this.get(identity); return Boolean(record && busy(record)); },
    async register(identity) {
      identity = Object.fromEntries(["agentId", "sessionKey", "sessionId", "projectRoot", "scopeFingerprint", "controlRevision", "scopeTaskId", "label"]
        .filter(key => identity[key] !== undefined).map(key => [key, identity[key]]));
      if (["agentId", "sessionKey", "sessionId", "projectRoot", "scopeFingerprint"].some(key => typeof identity[key] !== "string" || !identity[key]))
        throw new Error("Complete Session identity required.");
      const directory = directoryFor(identity);
      if (!directory) throw new Error("RC dispatch state directory unavailable.");
      const id = sha256([identity.agentId, identity.sessionKey, identity.sessionId, identity.projectRoot, identity.scopeFingerprint,
        identity.controlRevision ?? 0, identity.scopeTaskId ?? null]);
      let record = records.get(id);
      if (record) return record;
      const saved = await readJson(path.join(directory, `${id}.json`));
      // Concurrent first hooks must share one in-memory owner after disk I/O.
      record = records.get(id);
      if (record) return record;
      record = saved ?? { schemaVersion: 1, id, directory, ...identity, version: 0, phase: "IDLE", pending: [],
        deferredSources: [], completedRuns: [], createdAt: Date.now() };
      records.set(id, record);
      if (!saved) await locked(record, save);
      else if (busy(record)) {
        // Crash recovery checks the host before continuing; submitted intents are never replayed.
        spawn(id, () => reconcile(record));
      } else if (record.phase === "IDLE" && (record.pending.length
        || typeof beforeReview === "function" && !record.successorAdmissionClosed && knownTerminal(record)))
        spawn(id, () => dispatchUser(record));
      return record;
    },
    async load() {
      if (!defaultDirectory) return;
      for (const name of await fs.readdir(defaultDirectory).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        try {
          const record = await readJson(path.join(defaultDirectory, name));
          if (record?.schemaVersion === 1 && record.id === name.slice(0, -5)) await this.register(record);
        } catch (error) { reportError(error); }
      }
    },
    async started(identity, runId, repairBudgetMs = 3600000, trustedCorrection = true) {
      if (closed) return;
      const record = await this.register(identity);
      await locked(record, async r => {
        if (closed || r.phase === "CLOSED" || r.completedRuns.includes(runId)) return;
        if (busy(r) && r.runId !== runId && r.correctionRunId !== runId && r.dispatching?.runId !== runId)
          throw conflict("Another run owns this Session.");
        // Delivery/model-start hooks can arrive after finalization or repeat
        // during execution. They cannot rewind review or renew its deadline.
        if (r.runId === runId && !["IDLE", "WAIT_CORRECTION", "USER_DISPATCHING"].includes(r.phase)) return;
        const correction = r.correctionRunId === runId;
        cancelTimer(r.id);
        r.runId = runId; r.phase = correction ? trustedCorrection ? "CORRECTING" : "WAIT_CORRECTION" : "RUNNING";
        r.reason = null; r.ownerPid = process.pid;
        r.reconciliation = null; r.recoveryConfirmation = null; r.successorAdmissionClosed = false;
        if (r.dispatching?.runId === runId) { r.lastDispatched = { ...r.dispatching, status: 'RUNNING' }; r.dispatching = null;
          taskHistory(r, r.lastDispatched, 'RUNNING', { runId, startedAt: Date.now() }); }
        if (correction && trustedCorrection) r.deadlineAt = repairBudgetMs === null ? null : Date.now() + repairBudgetMs;
        await save(r); arm(r);
      });
    },
    async defer(identity, { sourceId, text, options = {} }) {
      if (closed) throw conflict("Scheduler is stopping.");
      if (typeof text !== "string" || !text.trim() || text.length > 200000) throw new Error("Invalid pending task text.");
      const record = await this.register(identity);
      let result;
      await locked(record, async r => {
        if (r.phase === "CLOSED") throw conflict("Session is closed.");
        const duplicate = sourceId && r.deferredSources.find(s => s.sourceId === sourceId);
        if (duplicate) { if (duplicate.digest && duplicate.digest !== sha256([text, options])) throw conflict("Command ID already used for different task text."); result = { id: duplicate.taskId, duplicate: true }; return; }
        if (r.pending.length >= 100) throw conflict("This Session already has 100 pending tasks.");
        const task = { id: randomUUID(), revision: 1, text, options, createdAt: Date.now() };
        r.pending.push(task);
        taskHistory(r, task, 'PENDING');
        if (sourceId) r.deferredSources.push({ sourceId, taskId: task.id, digest: sha256([text, options]) });
        await save(r); result = copy(task);
      });
      if (record.phase === "IDLE") spawn(record.id, () => dispatchUser(record));
      return result;
    },
    async mutate(identity, { id, revision, text, remove = false }) {
      if (closed) throw conflict("Scheduler is stopping.");
      const record = await this.register(identity);
      if (!await validate(record)) throw conflict("Session or project changed.");
      return locked(record, async r => {
        if (r.phase === "CLOSED") throw conflict("Session is closed.");
        const task = r.pending.find(item => item.id === id);
        if (!task || task.revision !== revision) throw conflict("Task changed or has already started; refresh first.");
        if (remove) { r.pending = r.pending.filter(item => item.id !== id); taskHistory(r, task, 'REMOVED', { endedAt: Date.now() }); }
        else {
          if (typeof text !== "string" || !text.trim() || text.length > 200000) throw new Error("Invalid task text.");
          task.text = text; task.revision++;
          taskHistory(r, task, 'PENDING');
        }
        await save(r); return copy(r);
      });
    },
    async candidate(identity, { runId, text, reviewBudgetMs, terminalBudgetMs = 30000, needsReview = true }) {
      if (closed) return;
      const record = await this.register(identity);
      let execute = false;
      await locked(record, async r => {
        if (closed || r.phase === "CLOSED" || r.completedRuns.includes(runId)) return;
        if (r.candidate?.runId === runId) {
          if (r.phase !== "FINALIZING") return;
          r.candidate.text = text; r.candidate.needsReview = needsReview;
          // A later agent_end of the same run proves a host retry outlived the
          // terminal wait; an escalation for that run no longer describes the host.
          if (r.reconciliation?.runId === runId && !Number.isFinite(r.candidate.terminalConfirmedAt)
            && !r.terminalRelease && !r.correctionRunId && !r.dispatching) {
            cancelTimer(r.id);
            r.reconciliation = null; r.reason = null;
            r.candidate.terminalDeadlineAt = Date.now() + terminalBudgetMs;
            execute = true;
          }
          await save(r);
          return;
        }
        if (r.runId && r.runId !== runId) return;
        cancelTimer(r.id);
        r.runId = runId; r.phase = "FINALIZING";
        r.candidate = { runId, text, needsReview, reviewBudgetMs, terminalDeadlineAt: Date.now() + terminalBudgetMs };
        r.ownerPid = process.pid;
        await save(r); execute = true;
      });
      if (!execute) return;
      queueCandidate(record, runId);
    },
    async correction(identity, runId, deadlineAt, stopId, parentRunId = identity.runId) {
      const record = await this.register(identity);
      await locked(record, async r => {
        if (r.phase !== "REVIEWING" || !parentRunId || r.runId !== parentRunId)
          throw conflict("Review no longer owns this Session.");
        r.correctionRunId = runId; r.correctionStopId = stopId; r.phase = "WAIT_CORRECTION"; r.deadlineAt = deadlineAt;
        await save(r); arm(r);
      });
    },
    async noteCoexistence(identity, coexistence) {
      const record = this.get(identity);
      if (!record) return null;
      if (!["RUNNING", "UNKNOWN", "IDLE"].includes(coexistence?.status)) throw new Error("Explicit autopilot status required.");
      return locked(record, async r => {
        if (closed || identity.runId && identity.runId !== r.runId) throw conflict("Run changed before coexistence update.");
        r.coexistence = copy(coexistence); await save(r); return copy(r);
      });
    },
    async externalStarted(identity, runId, coexistence) {
      if (!["RUNNING", "UNKNOWN", "IDLE"].includes(coexistence?.status) || typeof runId !== "string" || !runId) throw conflict("Explicit coexistence status and trusted host run required.");
      const record = await this.register(identity);
      if (!await validate(record)) throw conflict("Session or project changed.");
      return locked(record, async r => {
        if (closed || r.reconciliation?.status === "UNKNOWN" || r.dispatching || r.correctionRunId
          || !(r.phase === "COEXIST_WAIT" && r.candidate?.runId === r.runId && Number.isFinite(r.candidate.terminalConfirmedAt)
            || r.phase === "RUNNING" && r.runId === runId))
          throw conflict("Only a held candidate may yield to an autopilot continuation.");
        const priorRunId = r.runId;
        await audit(r, "HOST_CONTINUATION_ADMITTED", "host:continuation", { priorRunId, nextRunId: runId, coexistenceStatus: coexistence.status });
        cancelTimer(r.id);
        if (priorRunId !== runId && !r.completedRuns.includes(priorRunId)) r.completedRuns.push(priorRunId);
        r.completedRuns = r.completedRuns.slice(-200);
        r.runId = runId; r.phase = "RUNNING"; r.candidate = null; r.deadlineAt = null; r.reason = null;
        r.coexistence = copy(coexistence); r.recoveryConfirmation = null; r.successorAdmissionClosed = false;
        await save(r); return copy(r);
      });
    },
    async recheck(identity, options) {
      const record = this.get(identity);
      if (!record || !await validate(record)) throw conflict("Session or project changed.");
      await locked(record, async r => { assertRecovery(r, options); await audit(r, "RECHECK", options.actor); await save(r); });
      await spawn(record.id, () => reconcile(record, { manual: true, ownerRunId: options.runId }));
      return copy(record);
    },
    async confirmCancel(identity, options) {
      const record = this.get(identity);
      if (!record || !await validate(record)) throw conflict("Session or project changed.");
      await locked(record, async r => { assertRecovery(r, options); await audit(r, "CANCEL_REQUESTED", options.actor); await save(r); });
      await this.release(identity, "USER_CONFIRMED_CANCEL", { runId: options.runId });
      return copy(record);
    },
    async prepareRelease(identity, options) {
      const record = this.get(identity);
      if (!record || !await validate(record)) throw conflict("Session or project changed.");
      return locked(record, async r => {
        assertRecovery(r, options);
        if (r.reconciliation?.status !== "UNKNOWN") throw conflict("Reconcile the unknown host state before release.");
        const token = randomUUID(), expiresAt = Date.now() + 60000;
        await audit(r, "RELEASE_CONFIRMATION_REQUESTED", options.actor);
        r.recoveryConfirmation = { digest: sha256(token), actor: options.actor, runId: r.runId, version: r.version + 1, expiresAt };
        await save(r);
        return { confirmationToken: token, runId: r.runId, version: r.version, expiresAt,
          warning: "宿主终态仍为 UNKNOWN，不表示宿主已结束或已取消。解除只停止 RC 对此会话的调度；未确认的运行和待办不会重发，任务验收仍为 UNVERIFIED。" };
      });
    },
    async safeRelease(identity, options) {
      const record = this.get(identity);
      if (!record || !await validate(record)) throw conflict("Session or project changed.");
      await locked(record, async r => {
        assertRecovery(r, options);
        const confirmation = r.recoveryConfirmation;
        if (!confirmation || confirmation.actor !== options.actor || confirmation.runId !== r.runId
          || confirmation.version !== r.version || confirmation.expiresAt <= Date.now()
          || typeof options.confirmationToken !== "string" || sha256(options.confirmationToken) !== confirmation.digest)
          throw conflict("A current second confirmation from the same operator is required.");
        await audit(r, "SAFE_RELEASE_CONFIRMED", options.actor, { hostStatus: "UNKNOWN" });
        r.recoveryConfirmation = null; await save(r);
      });
      await this.release(identity, "USER_SAFE_RELEASE", { runId: options.runId, holdQueue: true });
      cancelTimer(record.id);
      await locked(record, async r => {
        if (r.runId !== options.runId) throw conflict("Run changed before release.");
        r.phase = "CLOSED"; r.reviewStatus = "UNVERIFIED"; r.reason = "USER_SAFE_RELEASE_UNKNOWN";
        r.reconciliation = { ...r.reconciliation, status: "UNKNOWN", detachedAt: Date.now() };
        if (r.lastDispatched?.runId === r.runId) taskHistory(r, r.lastDispatched, "UNKNOWN", { runId: r.runId, reason: r.reason, endedAt: null });
        await audit(r, "SAFE_RELEASED", options.actor, { hostStatus: "UNKNOWN", heldPendingTasks: r.pending.length }); await save(r);
      });
      controllers.get(record.id)?.abort();
      return copy(record);
    },
    release(identity, reason, { runId, holdQueue = false } = {}) {
      if (closed) return Promise.resolve();
      const record = this.get(identity);
      if (!record) return Promise.resolve();
      const operation = finish(record, runId ?? record.runId, "UNVERIFIED", reason, { cancel: true, dispatch: !holdQueue }).catch(reportError);
      operations.add(operation); void operation.finally(() => operations.delete(operation));
      return operation;
    },
    async close(identity, reason = "SESSION_CLOSED") {
      const record = this.get(identity);
      if (!record) return;
      cancelTimer(record.id);
      await locked(record, async r => { r.phase = "CLOSED"; r.reason = reason;
        for (const task of r.pending) taskHistory(r, task, 'CLOSED', { reason });
        await save(r); });
      controllers.get(record.id)?.abort();
    },
    project(identity, recordsToProject) {
      const record = this.get(identity);
      if (!record) return recordsToProject;
      const deferred = new Set(record.deferredSources.map(s => s.sourceId));
      return recordsToProject.filter(r => !deferred.has(r.id) && !deferred.has(r.message?.id));
    },
    snapshot(identity) { const record = this.get(identity); return record ? copy(record) : null; },
    list({ offset = 0, limit = 100, search = "", filter = "all" } = {}) {
      const query = String(search).trim().toLowerCase();
      const values = [...records.values()].filter(r => (!query || `${r.label ?? ""} ${r.sessionKey} ${r.projectRoot}`.toLowerCase().includes(query))
        && (filter === "all" || filter === "pending" && r.pending.length > 0 || filter === "active" && busy(r))).sort((a, b) => b.updatedAt - a.updatedAt);
      return { total: values.length, sessions: values.slice(offset, offset + limit).map(r => ({ id: r.id,
        agentId: r.agentId, sessionKey: r.sessionKey, sessionId: r.sessionId, projectRoot: r.projectRoot,
        scopeFingerprint: r.scopeFingerprint, label: r.label, phase: r.phase, reviewStatus: r.reviewStatus,
        reason: r.reason, pendingCount: r.pending.length, version: r.version, updatedAt: r.updatedAt })) };
    },
    async drain() { while (work.size) await Promise.all([...work.values()]); },
    async dispose() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      for (const controller of controllers.values()) controller.abort();
      timers.clear();
      await this.drain();
      while (operations.size) await Promise.all([...operations]);
    },
  };
  return api;
}
