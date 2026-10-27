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
  cancelCorrection, concurrency = 3, onError = () => {} }) {
  const records = new Map(), work = new Map(), controllers = new Map(), timers = new Map();
  const pool = createPostRunReviewPool(concurrency);
  let closed = false;
  const operations = new Set();
  const reportError = error => { try { onError(error); } catch {} };
  const file = record => path.join(record.directory, `${record.id}.json`);
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
  const reconcileLater = record => {
    cancelTimer(record.id);
    if (closed || record.phase === "CLOSED") return;
    const timer = setTimeout(() => { timers.delete(record.id); spawn(record.id, () => reconcile(record)); }, 5000);
    timer.unref?.(); timers.set(record.id, timer);
  };
  async function reconcile(record) {
    if (closed || !busy(record)) return;
    const ownerRunId = record.runId, runId = record.terminalRelease?.runId ?? record.correctionRunId ?? ownerRunId;
    if (!await validate(record)) return api.close(record, "SESSION_REPLACED");
    let terminal;
    const controller = new AbortController(); controllers.set(record.id, controller);
    try { terminal = await beforeStopDeadline(() => waitTerminal(copy(record), runId, Date.now() + 5000, controller.signal),
      { deadlineAt: Date.now() + 5000, signal: controller.signal }); } catch { /* Unknown is never a retry. */ }
    finally { if (controllers.get(record.id) === controller) controllers.delete(record.id); }
    if (closed || record.runId !== ownerRunId || record.phase === "CLOSED") return;
    if (["ok", "error"].includes(terminal?.status)) {
      if (record.phase === "RELEASING") return finish(record, ownerRunId,
        record.terminalRelease?.status ?? "UNVERIFIED", record.terminalRelease?.reason ?? "POST_RUN_OWNER_RECOVERED", { confirmedRunId: runId });
      const candidate = record.candidate;
      if (terminal.status === "ok" && candidate?.runId === runId && !record.completedRuns.includes(runId)) {
        if (record.phase.startsWith("REVIEW") && record.deadlineAt) {
          candidate.reviewBudgetMs = Math.min(candidate.reviewBudgetMs, record.deadlineAt - Date.now());
          if (candidate.reviewBudgetMs <= 0) return finish(record, ownerRunId, "UNVERIFIED", "POST_RUN_OWNER_RECOVERED");
        }
        await locked(record, async r => { r.candidate = null; r.phase = "RUNNING"; await save(r); });
        await api.candidate(record, { ...candidate, terminalBudgetMs: 5000 });
      } else await finish(record, ownerRunId, "UNVERIFIED", "POST_RUN_OWNER_RECOVERED");
    } else {
      await locked(record, async r => { if (r.runId === ownerRunId && busy(r)) { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); } });
      reconcileLater(record);
    }
  }
  async function dispatchUser(record) {
    let task;
    await locked(record, async r => {
      if (closed || r.phase !== "IDLE" || !r.pending.length) return;
      task = r.pending.shift();
      r.dispatching = { ...task, status: "DISPATCHING", runId: `rc-user-${task.id}`, claimedAt: Date.now() };
      r.phase = "USER_DISPATCHING"; r.runId = r.dispatching.runId;
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
        await save(r);
      });
    } catch (error) {
      await locked(record, async r => {
        if (r.dispatching?.id !== task.id) return;
        r.dispatching.status = "UNKNOWN"; r.reason = error.code ?? "USER_DISPATCH_UNKNOWN";
        await save(r);
      });
    }
    if (record.phase === "USER_DISPATCHING") reconcileLater(record);
  }
  async function finish(record, runId, status, reason, { cancel = false, stillCurrent = () => true, confirmedRunId } = {}) {
    let ready = false, owned, ownedStopId, hostTerminalKnown;
    await locked(record, async r => {
      if (r.runId !== runId || !busy(r) || !stillCurrent(r)) return;
      if (r.phase === "RELEASING" && (cancel || confirmedRunId !== (r.terminalRelease?.runId ?? runId))) return;
      owned = r.correctionRunId; ownedStopId = r.correctionStopId;
      hostTerminalKnown = confirmedRunId === (owned ?? runId)
        || (!owned || owned === runId) && ["REVIEW_QUEUED", "REVIEWING"].includes(r.phase);
      cancelTimer(r.id);
      r.phase = cancel ? "RELEASING" : "IDLE"; r.reviewStatus = status; r.reason = reason ?? null;
      for (const ended of [runId, cancel && r.correctionRunId].filter(Boolean)) {
        if (!r.completedRuns.includes(ended)) r.completedRuns.push(ended);
      }
      r.completedRuns = r.completedRuns.slice(-200);
      r.correctionRunId = null; r.correctionStopId = null; r.candidate = null; r.updatedAt = Date.now();
      r.terminalRelease = cancel ? { runId: owned ?? runId, status, reason: reason ?? null } : null;
      if (r.dispatching?.runId === runId) { r.lastDispatched = { ...r.dispatching, status: "FINISHED" }; r.dispatching = null; }
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
        if (["ok", "error"].includes(terminal?.status)) { r.phase = "IDLE"; r.reason = reason ?? null; r.terminalRelease = null; }
        else { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; ready = false; reconcileNeeded = true; }
        await save(r);
      });
      if (reconcileNeeded) reconcileLater(record);
    }
    if (ready) await dispatchUser(record);
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
      } else if (record.phase === "IDLE" && record.pending.length) spawn(id, () => dispatchUser(record));
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
        if (r.dispatching?.runId === runId) { r.lastDispatched = r.dispatching; r.dispatching = null; }
        if (correction && trustedCorrection) r.deadlineAt = Date.now() + repairBudgetMs;
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
        if (remove) r.pending = r.pending.filter(item => item.id !== id);
        else {
          if (typeof text !== "string" || !text.trim() || text.length > 200000) throw new Error("Invalid task text.");
          task.text = text; task.revision++;
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
          if (r.phase === "FINALIZING") { r.candidate.text = text; r.candidate.needsReview = needsReview; await save(r); }
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
      spawn(record.id, async () => {
        const controller = new AbortController(); controllers.set(record.id, controller);
        let terminalConfirmed = false;
        try {
          const terminalDeadlineAt = record.candidate.terminalDeadlineAt;
          const terminal = await beforeStopDeadline(() => waitTerminal(copy(record), runId, terminalDeadlineAt, controller.signal),
            { deadlineAt: terminalDeadlineAt, signal: controller.signal });
          if (closed || record.runId !== runId || record.phase === "CLOSED") return;
          if (!terminal) {
            await locked(record, async r => { if (r.runId === runId && busy(r)) { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); } });
            reconcileLater(record); return;
          }
          terminalConfirmed = true;
          if (terminal.status !== "ok") return finish(record, runId, "UNVERIFIED", "HOST_RUN_NOT_COMPLETED");
          if (!await validate(record)) return this.close(identity, "SESSION_REPLACED");
          if (closed || record.runId !== runId || record.phase !== "FINALIZING") return;
          if (!record.candidate.needsReview) return finish(record, runId, "DISABLED", "STOP_NOT_REQUIRED");
          const deadlineAt = Date.now() + reviewBudgetMs;
          await locked(record, async r => {
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
            if (record.runId !== runId || record.phase === "CLOSED") return;
            if (["WAIT_CORRECTION", "CORRECTING"].includes(record.phase)) return;
            await finish(record, runId, result?.reviewStatus ?? "UNVERIFIED", result?.reasonCode);
          }, { deadlineAt, signal: controller.signal });
        } catch (error) {
          if (!closed && record.runId === runId && record.phase !== "CLOSED") {
            if (terminalConfirmed) await finish(record, runId, "UNVERIFIED", error.code ?? "POST_RUN_REVIEW_FAILED", { cancel: true, confirmedRunId: runId });
            else { await locked(record, async r => { r.reason = "HOST_RUN_RECONCILIATION_REQUIRED"; await save(r); }); reconcileLater(record); }
          }
        } finally {
          if (controllers.get(record.id) === controller) controllers.delete(record.id);
          await locked(record, async r => {
            if (r.phase !== "FINALIZING" && !r.completedRuns.includes(runId)) r.completedRuns.push(runId);
            r.completedRuns = r.completedRuns.slice(-200); await save(r);
          });
        }
      });
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
    release(identity, reason) {
      if (closed) return Promise.resolve();
      const record = this.get(identity);
      if (!record) return Promise.resolve();
      const operation = finish(record, record.runId, "UNVERIFIED", reason, { cancel: true }).catch(reportError);
      operations.add(operation); void operation.finally(() => operations.delete(operation));
      return operation;
    },
    async close(identity, reason = "SESSION_CLOSED") {
      const record = this.get(identity);
      if (!record) return;
      cancelTimer(record.id);
      await locked(record, async r => { r.phase = "CLOSED"; r.reason = reason; await save(r); });
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
