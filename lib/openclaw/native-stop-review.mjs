import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateJson } from "./controller-store.mjs";

// A per-terminal checkpoint, not a business executor or a durable scheduler.
// Terminal delivery waits only for registration. New business turns can await
// released without holding the old business run or waiting for reviewer cleanup.
export function createNativeStopReviews(jobs = new Map(), owner) {
  const digest = value => createHash("sha256").update(value).digest("hex");
  return {
    async schedule({ projectRoot, sessionId, sessionKey, runId, signal, budgetMs, run, onCancel, onSettled, waitMode = "assessment" }) {
      const identity = JSON.stringify([projectRoot, sessionKey, sessionId, runId]);
      if (jobs.has(identity)) return jobs.get(identity).registered;
      const file = path.join(projectRoot, ".runtime-correction/openclaw/native-stop-reviews",
        digest(JSON.stringify([sessionKey, sessionId])), `${digest(runId)}.json`);
      const record = { sessionId, sessionKey, runId, ownerPid: process.pid, status: "PENDING", waitMode,
        createdAt: Date.now(), deadlineAt: Date.now() + budgetMs, budgetMs };
      const controller = new AbortController();
      let closed = false, committed = null, writes = Promise.resolve(), finalWrite, timer, release;
      const released = new Promise(resolve => { release = resolve; });
      const persist = value => {
        const snapshot = structuredClone(value);
        writes = writes.catch(() => {}).then(() => privateJson(file, snapshot));
        return writes;
      };
      const settle = result => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        Object.assign(record, committed ?? {}, result, { status: "SETTLED", settledAt: Date.now() });
        if (committed) Object.assign(record, committed); // A new corrective run cannot erase a committed assessment.
        record.evaluationId ??= null;
        finalWrite = persist(record).catch(() => {});
        const snapshot = structuredClone(record);
        // Release is independent of disk/notification/backend cleanup liveness.
        release(snapshot);
        void Promise.resolve().then(() => onSettled?.(snapshot)).catch(() => {});
      };
      const cancel = reason => {
        if (closed) return;
        // The continuation may reenter the plugin while its admission call is
        // unwinding. Finish that bounded dispatch before releasing outsiders.
        if (committed && reason?.message === "Native run replaced.") { controller.abort(reason); return; }
        settle({ reviewStatus: "CANCELLED", reasonCode: reason?.code ?? "RC_STOP_CANCELLED" });
        controller.abort(reason);
        void Promise.resolve().then(() => onCancel?.(reason)).catch(() => {});
      };
      const aborted = () => cancel(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      const expire = () => {
        if (closed) return;
        const error = Object.assign(new Error("RC Stop assessment deadline expired."), { code: "REVIEW_DEADLINE_EXPIRED" });
        settle({ reviewStatus: "UNVERIFIED", reasonCode: error.code });
        controller.abort(error);
        void Promise.resolve().then(() => onCancel?.(error)).catch(() => {});
      };
      timer = setTimeout(expire, Math.max(1, record.deadlineAt - Date.now()));
      const assertCurrent = () => {
        if (closed || controller.signal.aborted || Date.now() >= record.deadlineAt) {
          throw Object.assign(new Error("RC Stop assessment is no longer current."), { code: "RC_STOP_REVIEW_STALE" });
        }
      };
      const registered = (async () => {
        let old;
        try { old = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (closed) return record;
        if (old) {
          if (["PENDING", "RUNNING"].includes(old.status)) {
            Object.assign(old, { status: "SETTLED", reviewStatus: old.assessmentCompletedAt ? old.reviewStatus : "UNVERIFIED",
              reasonCode: "REVIEW_OWNER_LOST", settledAt: Date.now() });
            await persist(old);
          }
          return { ...old, reused: true };
        }
        if (!closed) await persist(record);
        return record;
      })();
      const work = registered.then(async saved => {
        if (saved.reused) { settle(saved); return; }
        const execute = async ({ ownerSignal } = {}) => {
          if (closed || signal.aborted || ownerSignal?.aborted) return { reviewStatus: "CANCELLED" };
          if (Date.now() >= record.deadlineAt) return { reviewStatus: "UNVERIFIED", reasonCode: "REVIEW_DEADLINE_EXPIRED" };
          Object.assign(record, { status: "RUNNING", startedAt: Date.now() });
          await persist(record);
          assertCurrent();
          return run({ deadlineAt: record.deadlineAt, ownerSignal, signal: controller.signal, commit: async assessment => {
            assertCurrent();
            const value = { ...assessment, assessmentCompletedAt: Date.now() };
            await persist({ ...record, ...value });
            assertCurrent();
            committed = value;
            Object.assign(record, value);
          } });
        };
        if (owner) return owner.execute({ id: digest(identity), signal: controller.signal, run: execute });
        // The pinned legacy host has no service scheduler contract.
        await new Promise(resolve => setImmediate(resolve));
        return execute();
      }).then(result => {
        if (closed) return;
        settle({
          reviewStatus: result?.reviewStatus ?? (signal.aborted ? "CANCELLED" : "UNVERIFIED"),
          evaluationId: result?.evaluationId ?? null, ...(result?.reasonCode ? { reasonCode: result.reasonCode } : {}),
          ...(result?.followupStatus ? { followupStatus: result.followupStatus } : {}),
          ...(result?.feedbackOnly === true ? { feedbackOnly: true } : {}) });
      }).catch(error => {
        settle({
          reviewStatus: record.assessmentCompletedAt ? record.reviewStatus : (signal.aborted
            || error.code === "RC_STOP_OWNER_CANCELLED" ? "CANCELLED" : "UNVERIFIED"), reasonCode: error.code ?? error.name });
      });
      const done = released.then(async result => { await finalWrite; return result; });
      jobs.set(identity, { projectRoot, registered, done, released, work, record, expire, get pending() { return !closed; } });
      if (signal.aborted) aborted();
      return registered;
    },
    pending({ projectRoot, sessionId, sessionKey }, exceptRunId) {
      return [...jobs.values()].filter(job => job.pending && job.record.sessionKey === sessionKey
        && job.record.sessionId === sessionId && job.record.runId !== exceptRunId
        && job.projectRoot === projectRoot);
    },
    async wait({ drain = false } = {}) {
      return Promise.all([...jobs.values()].map(async job => {
        const result = await job.done;
        if (drain) await job.work;
        return result;
      }));
    },
  };
}
