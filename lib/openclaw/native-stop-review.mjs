import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateJson } from "./controller-store.mjs";

// A per-terminal checkpoint, not a business executor or a durable scheduler.
// The host Hook waits only for this receipt. The RC-owned work keeps its own
// deadline and is still cancelled by the session's work-admission signal.
export function createNativeStopReviews(jobs = new Map()) {
  const digest = value => createHash("sha256").update(value).digest("hex");
  return {
    async schedule({ projectRoot, sessionId, sessionKey, runId, signal, budgetMs, run }) {
      const identity = JSON.stringify([projectRoot, sessionKey, sessionId, runId]);
      if (jobs.has(identity)) return jobs.get(identity).registered;
      const file = path.join(projectRoot, ".runtime-correction/openclaw/native-stop-reviews",
        digest(JSON.stringify([sessionKey, sessionId])), `${digest(runId)}.json`);
      const record = { sessionId, sessionKey, runId, ownerPid: process.pid, status: "PENDING",
        createdAt: Date.now(), deadlineAt: Date.now() + budgetMs, budgetMs };
      const registered = (async () => {
        let old;
        try { old = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (old) {
          if (["PENDING", "RUNNING"].includes(old.status)) {
            Object.assign(old, { status: "SETTLED", reviewStatus: "UNVERIFIED",
              reasonCode: "REVIEW_OWNER_LOST", settledAt: Date.now() });
            await privateJson(file, old);
          }
          return { ...old, reused: true };
        }
        await privateJson(file, record);
        return record;
      })();
      const done = registered.then(async saved => {
        if (saved.reused) return saved;
        // Leave the caller's Hook before starting any model or long work.
        await new Promise(resolve => setImmediate(resolve));
        if (signal.aborted) return { reviewStatus: "CANCELLED" };
        Object.assign(record, { status: "RUNNING", startedAt: Date.now() });
        await privateJson(file, record);
        return run({ deadlineAt: record.deadlineAt });
      }).then(async result => {
        if (result?.reused) return result;
        Object.assign(record, { status: "SETTLED", settledAt: Date.now(),
          reviewStatus: result?.reviewStatus ?? (signal.aborted ? "CANCELLED" : "UNVERIFIED"),
          evaluationId: result?.evaluationId ?? null });
        await privateJson(file, record);
        return record;
      }).catch(async error => {
        Object.assign(record, { status: "SETTLED", settledAt: Date.now(),
          reviewStatus: signal.aborted ? "CANCELLED" : "UNVERIFIED", reasonCode: error.code ?? error.name });
        // Diagnostics must not turn an unobserved background rejection into a
        // process error. Raw model/request errors are not copied into receipts.
        await privateJson(file, record).catch(() => {});
        return record;
      });
      jobs.set(identity, { registered, done });
      return registered;
    },
    async wait() { return Promise.all([...jobs.values()].map(job => job.done)); },
  };
}
