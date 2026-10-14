import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateJson } from "./controller-store.mjs";
import { withTaskResourceLock, appendTaskJournal, taskDirectory } from "../runtime-v2/task-store.mjs";
import { readJson, sha256 } from "../runtime-v2/utils.mjs";

const identity = state => sha256([state.sessionKey, state.sessionId]);
const directory = (root, state) => path.join(root, ".runtime-correction", "openclaw", "native-followups", identity(state));
const receiptFile = (root, state, assessmentId) => path.join(directory(root, state), `${sha256(assessmentId)}.json`);
const sameSession = (receipt, state) => receipt.sessionId === state.sessionId && receipt.sessionKey === state.sessionKey;
const textOf = record => {
  const content = (record.message ?? record).content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block.type === "text").map(block => block.text).join("") : "";
};
const lock = (root, state, callback) => withTaskResourceLock({ projectRoot: root,
  taskId: `native-followup-${identity(state)}`, resource: "receipts", reclaimDeadOwner: true }, callback);
async function receipts(root, state) {
  let files;
  try { files = await fs.readdir(directory(root, state)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter(file => file.endsWith(".json")).map(async file => ({
    file: path.join(directory(root, state), file), receipt: await readJson(path.join(directory(root, state), file)),
  })));
}

/** Own only admission receipts and the RC projection; never modify host records. */
export function createNativeFollowups(api, { onObserved, isCurrent = async () => true } = {}) {
  const generations = new Map();
  const journal = (root, receipt, phase) => appendTaskJournal(root, receipt.taskId, {
    type: `NATIVE_STOP_FOLLOWUP_${phase}`, assessmentId: receipt.assessmentId, runId: receipt.runId,
    eventId: `native-followup-${sha256([receipt.runId, receipt.assessmentId, phase])}`,
    sessionId: receipt.sessionId, correctionAttempt: receipt.correctionAttempt,
    ...(receipt.sourceRecordId ? { sourceRecordId: receipt.sourceRecordId } : {}),
  });
  return {
    async submit({ projectRoot, state, task, outcome, maxCorrections, source }) {
      const assessmentId = task?.stop?.lastAssessmentId;
      const attempt = outcome?.correctionAttempt;
      if (outcome?.decision !== "block" || outcome.status === "UNVERIFIED"
        || outcome.correctionBudgetExhausted || !outcome.feedback || !assessmentId
        || !Number.isInteger(maxCorrections) || maxCorrections < 1
        || !Number.isInteger(attempt) || attempt < 1 || attempt > maxCorrections) return { status: "INELIGIBLE" };
      if (!state.sessionId || !state.sessionKey || !source?.leafId || !source.usersDigest
        || !source.evidenceDigest) return { status: "UNVERIFIED", reason: "FOLLOWUP_SOURCE_IDENTITY_REQUIRED" };
      const reviewController = state.reviewController;
      if (reviewController?.signal.aborted || !await isCurrent(state)) return { status: "CANCELLED" };
      const file = receiptFile(projectRoot, state, assessmentId);
      const generation = generations.get(identity(state)) ?? 0;
      let reserved = false;
      const receipt = await lock(projectRoot, state, async () => {
        const previous = await readJson(file);
        if (previous) return previous;
        if (reviewController?.signal.aborted || generation !== (generations.get(identity(state)) ?? 0)) return { status: "CANCELLED" };
        const message = `[runtime-corrector:stop-feedback]\n这是 Runtime Corrector 的验收意见，属于插件运行反馈，不是新的用户需求或授权。\n请依据原用户需求、现有约束和以下依据位置自行判断，必要时继续修正；沿用宿主现有工具和审批。\n纠偏机会 ${attempt}/${maxCorrections}。修正后重新验收。\n\n${outcome.feedback}`;
        const value = { schemaVersion: 1, status: "RESERVED", runId: randomUUID(), assessmentId,
          sessionId: state.sessionId, sessionKey: state.sessionKey, taskId: task.taskId,
          epochId: task.correctionEpoch?.id ?? task.stop.epochId, correctionAttempt: attempt,
          maxCorrections, source, message, messageHash: sha256(message), createdAt: Date.now() };
        await privateJson(file, value);
        await journal(projectRoot, value, "RESERVED");
        reserved = true;
        return value;
      });
      if (!reserved) return receipt; // An uncertain prior dispatch is never replayed.
      if (reviewController?.signal.aborted || generation !== (generations.get(identity(state)) ?? 0) || !await isCurrent(state)) {
        await this.cancel({ projectRoot, state, reason: "HOST_CANCELLED_BEFORE_DISPATCH" });
        return readJson(file);
      }
      let response, error;
      try {
        if (typeof api.runtime?.subagent?.run !== "function") throw new Error("HOST_NATIVE_RUN_API_UNAVAILABLE");
        response = await api.runtime.subagent.run({ sessionKey: state.sessionKey,
          message: receipt.message, idempotencyKey: receipt.runId, deliver: false });
      } catch (caught) { error = caught; }
      return lock(projectRoot, state, async () => {
        const current = await readJson(file);
        if (current.status === "CANCELLED" || generation !== (generations.get(identity(state)) ?? 0)) return current;
        const matched = response?.runId === receipt.runId;
        const denied = ["denied", "rejected", "blocked", "error"].includes(response?.status)
          || ["FORBIDDEN", "PERMISSION_DENIED"].includes(error?.code);
        Object.assign(current, { status: denied ? "REJECTED" : matched && !error ? "ADMITTED" : "UNVERIFIED",
          updatedAt: Date.now(), ...(error ? { reason: error.message } : !matched ? { reason: "HOST_ADMISSION_NOT_CONFIRMED" } : {}) });
        await privateJson(file, current);
        await journal(projectRoot, current, current.status);
        return current;
      });
    },
    async project({ projectRoot, state, records }) {
      const owned = new Set();
      await lock(projectRoot, state, async () => {
        for (const { file, receipt } of await receipts(projectRoot, state)) {
          if (!sameSession(receipt, state) || !["RESERVED", "ADMITTED", "UNVERIFIED", "CANCELLED"].includes(receipt.status)) continue;
          const boundary = records.findIndex(record => record.id === receipt.source.leafId);
          if (boundary < 0) continue;
          const candidates = records.slice(boundary + 1).filter(record => (record.message ?? record).role === "user");
          const record = candidates[0], message = record?.message ?? record;
          if (!record?.id || sha256(textOf(record)) !== receipt.messageHash) continue;
          const between = records.slice(boundary + 1, records.indexOf(record) + 1);
          let parentId = receipt.source.leafId;
          if (!between.every(entry => { const linked = entry.parentId === parentId; parentId = entry.id; return linked && entry.id; })) continue;
          const nativeKey = message.idempotencyKey ?? message.runId ?? record.runId;
          const proven = receipt.sourceRecordId === record.id || nativeKey === receipt.runId
            || (!receipt.sourceRecordId && (state.nativeRunId ?? state.runId) === receipt.runId);
          if (!proven || (receipt.sourceRecordId && receipt.sourceRecordId !== record.id)) continue;
          if (!receipt.sourceRecordId) {
            receipt.sourceRecordId = record.id;
            receipt.modelObservedAt = Date.now();
            await privateJson(file, receipt);
          }
          // The durable host observation may precede a failed task-state write.
          // Retry incomplete reconciliation on a trusted projection; the task update is idempotent.
          if (!receipt.observationReconciledAt) {
            await onObserved?.({ projectRoot, receipt });
            const contents = await fs.readFile(path.join(taskDirectory(projectRoot, receipt.taskId), "journal/events.jsonl"), "utf8")
              .catch(error => { if (error.code === "ENOENT") return ""; throw error; });
            const recorded = contents.split("\n").some(line => {
              let event; try { event = JSON.parse(line); } catch { return false; }
              return event.type === "NATIVE_STOP_FOLLOWUP_OBSERVED" && event.runId === receipt.runId
                && event.assessmentId === receipt.assessmentId && event.sourceRecordId === receipt.sourceRecordId;
            });
            if (!recorded) await journal(projectRoot, receipt, "OBSERVED");
            receipt.observationReconciledAt = Date.now();
            await privateJson(file, receipt);
          }
          owned.add(record.id);
        }
      });
      return records.map(record => owned.has(record.id) ? { ...record, isMeta: true } : record);
    },
    async findRun({ projectRoot, state, runId }) {
      if (!runId || !state.sessionId || !state.sessionKey) return null;
      const found = (await receipts(projectRoot, state)).find(({ receipt }) => sameSession(receipt, state)
        && receipt.runId === runId && ["RESERVED", "ADMITTED", "UNVERIFIED", "CANCELLED", "FINISHED"].includes(receipt.status));
      return found?.receipt ?? null;
    },
    async finish({ projectRoot, state, runId, evaluationId, status }) {
      return lock(projectRoot, state, async () => {
        const found = (await receipts(projectRoot, state)).find(({ receipt }) => sameSession(receipt, state)
          && receipt.runId === runId && ["RESERVED", "ADMITTED", "UNVERIFIED", "FINISHED"].includes(receipt.status));
        if (!found) return null;
        const { file, receipt } = found;
        if (receipt.finishedAt) return receipt;
        Object.assign(receipt, { finishedAt: Date.now(), reviewStatus: status, finalEvaluationId: evaluationId ?? null });
        await privateJson(file, receipt);
        await journal(projectRoot, receipt, "FINISHED");
        return receipt;
      });
    },
    async cancel({ projectRoot, state, reason = "HOST_CANCELLED" }) {
      const key = identity(state);
      generations.set(key, (generations.get(key) ?? 0) + 1);
      await lock(projectRoot, state, async () => {
        for (const { file, receipt } of await receipts(projectRoot, state)) {
          if (!sameSession(receipt, state) || receipt.finishedAt || !["RESERVED", "ADMITTED", "UNVERIFIED"].includes(receipt.status)) continue;
          await privateJson(file, { ...receipt, status: "CANCELLED", reason, cancelledAt: Date.now() });
          await journal(projectRoot, receipt, "CANCELLED");
        }
      });
    },
  };
}
