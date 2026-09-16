import { withTaskState, decisionGuard } from "../runtime-v2/task-store.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";

// ACKED means native transcript persistence acknowledged. It never asserts
// that a web browser or a human has read the message.
export async function sendWithReceipt({ projectRoot, taskId, deliveryId, generation, message, verified = false,
  evidenceMatches = async () => true, cancelled = () => false }, send) {
  const target = { projectRoot, taskId };
  const digest = sha256(message);
  await withTaskState(target, (state) => {
    if (state.delivery?.id === deliveryId) {
      if (state.delivery.digest !== digest) throw new Error("Delivery ID payload conflict.");
      return;
    }
    if (state.control?.generation !== generation || state.control?.cancelled || cancelled()) throw new Error("Delivery cancelled before preparation.");
    state.delivery = { id: deliveryId, digest, status: "READY", guard: decisionGuard(state), verified, preparedAt: Date.now() };
  });
  let dispatch = false;
  const existing = await withTaskState(target, async (state) => {
    const delivery = state.delivery;
    if (delivery.id !== deliveryId) throw new Error("Delivery superseded.");
    if (delivery.status !== "READY") return structuredClone(delivery);
    if (state.control?.generation !== generation || state.control?.cancelled || state.control?.pendingRequirement || cancelled()) throw new Error("Delivery cancelled before send commit.");
    if (JSON.stringify(delivery.guard) !== JSON.stringify(decisionGuard(state))) throw new Error("Delivery context changed.");
    if (verified && (state.status !== "COMPLETED" || state.verification?.status !== "PASS"
      || state.verification.requirementVersion !== state.groundTruth.version
      || state.verification.requirementDigest !== state.groundTruth.digest
      || !state.verification.evidence || !state.verification.rulesDigest || !state.verification.assessmentId
      || state.verification.generation !== generation || state.verification.cancelEpoch !== state.control.cancelEpoch
      || !await evidenceMatches())) throw new Error("Current completion evidence is unavailable.");
    delivery.status = "SEND_COMMITTED"; delivery.sendCommittedAt = Date.now();
    dispatch = true;
    return structuredClone(delivery);
  });
  if (!dispatch) return existing; // UNKNOWN is reconciled, never resent.
  let ack, error;
  try { ack = await send(); } catch (caught) { error = caught; }
  return withTaskState(target, (state) => {
    const delivery = state.delivery;
    const audit = { id: deliveryId, status: ack?.messageId ? "ACKED" : "UNKNOWN",
      messageId: ack?.messageId ?? null, acknowledgement: "native_transcript", acknowledgedAt: Date.now(),
      error: error ? "SEND_RESULT_UNKNOWN" : null, cancelled: state.control?.cancelled === true };
    state.deliveryAudit ??= [];
    state.deliveryAudit.push(audit);
    if (delivery.id === deliveryId) Object.assign(delivery, audit);
    return audit;
  });
}

export async function reconcileDelivery(binding, deliveryId) {
  const { promises: fs } = await import("node:fs");
  const { findTask } = await import("../runtime-v2/task-store.mjs");
  const task = await findTask({ projectRoot: binding.workspaceDir, sessionId: binding.sessionId });
  if (!task?.delivery || task.delivery.id !== deliveryId) return { status: "NOT_FOUND" };
  if (task.delivery.status === "READY") return task.delivery;
  let records = [];
  try { records = (await fs.readFile(binding.sessionFile, "utf8")).split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const record = records.find((entry) => entry.message?.role === "assistant" && entry.message?.idempotencyKey === deliveryId);
  return withTaskState({ projectRoot: binding.workspaceDir, taskId: task.taskId }, (state) => {
    if (state.delivery?.id !== deliveryId) return { status: "SUPERSEDED" };
    const audit = { id: deliveryId, status: record?.id ? "ACKED" : state.delivery.status === "ACKED" ? "ACKED" : "UNKNOWN",
      messageId: record?.id ?? state.delivery.messageId ?? null, acknowledgement: "native_transcript", reconciledAt: Date.now(),
      cancelled: state.control?.cancelled === true };
    state.deliveryAudit ??= []; state.deliveryAudit.push(audit);
    Object.assign(state.delivery, audit);
    return audit;
  });
}
