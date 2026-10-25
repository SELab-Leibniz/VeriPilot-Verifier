import { beforeStopDeadline, scheduleStopDeadline } from "./stop-deadline.mjs";

/** One sequential agent per group, one program-owned receipt per item. No
 * retries, summaries-as-results, or fallback reviewer lives in this runner. */
export async function runStopReviewRound({ store, roundId, stopId, items, groupSize = 3, deadlineAt,
  reviewGroup, signal, isCurrent = async () => true, groupTimeoutMs = Infinity, now = Date.now, settlementDeadlineAt = Infinity, settlementSignal }) {
  if (typeof reviewGroup !== "function" || !(groupTimeoutMs > 0)) throw new Error("A group reviewer and positive group timeout are required.");
  await store.beginRound({ roundId, stopId, items, groupSize, deadlineAt, signal });
  const failures = [];
  let reasonCode = "COMPLETED";
  const signalReason = () => signal?.reason?.code === "STOP_REVIEW_DEADLINE" ? "REVIEW_DEADLINE_EXPIRED" : "CANCELLED_OR_STALE";
  while (now() < deadlineAt) {
    if (signal?.aborted) { reasonCode = signalReason(); break; }
    try {
      if (!await beforeStopDeadline(isCurrent, { deadlineAt, signal, now, code: "STOP_REVIEW_DEADLINE" })) { reasonCode = "CANCELLED_OR_STALE"; break; }
    } catch (cause) { reasonCode = cause.code === "STOP_REVIEW_DEADLINE" ? "REVIEW_DEADLINE_EXPIRED" : signalReason(); break; }
    let group;
    try { group = await store.dispatch({ roundId, groupDeadlineAt: now() + groupTimeoutMs, signal }); }
    catch (error) {
      failures.push({ phase: "dispatch", code: error.code ?? "STOP_REVIEW_DISPATCH_FAILED", reason: error.message });
      reasonCode = ["STOP_REVIEW_ROUND_CLOSED", "STOP_REVIEW_DEADLINE"].includes(error.code) || now() >= deadlineAt
        ? "REVIEW_DEADLINE_EXPIRED" : signal?.aborted ? signalReason() : "STOP_REVIEW_DISPATCH_FAILED";
      break;
    }
    if (!group) break;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let cancelTimer, completed = false, groupReason = "COMPLETED";
    const submit = async submission => {
      if (completed || controller.signal.aborted || signal?.aborted || now() >= deadlineAt || !await beforeStopDeadline(isCurrent,
        { deadlineAt: group.deadlineAt, signal: controller.signal, now, code: "STOP_REVIEW_GROUP_CLOSED" }))
        throw Object.assign(new Error("The review group is no longer current."), { code: "STOP_REVIEW_GROUP_CLOSED" });
      if (!submission || Object.keys(submission).some(key => !["objectId", "revisionId", "result"].includes(key)))
        throw Object.assign(new Error("Only item identity, revision and a structured result may be submitted."), { code: "STOP_REVIEW_OWNERSHIP_INVALID" });
      const member = group.members.find(member => member.objectId === submission.objectId);
      return store.submit({ groupId: group.id, token: group.token, objectId: submission.objectId,
        revisionId: submission.revisionId, basisKey: member?.basisKey, result: submission.result, signal: controller.signal });
    };
    try {
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        if (now() >= group.deadlineAt) throw Object.assign(new Error("Review group cutoff reached before launch."), { code: "STOP_REVIEW_GROUP_TIMEOUT" });
        return reviewGroup({ brief: {
          groupId: group.id, stopId, roundId, metricId: group.metricId, priority: group.priority,
          items: structuredClone(group.items), deadlineAt: group.deadlineAt,
        }, submit, signal: controller.signal });
      });
      // Observe a broken/late backend without keeping it on the publication path.
      void work.catch(() => {});
      await Promise.race([work, new Promise((_, reject) => {
        const rejectAbort = () => reject(Object.assign(new Error("Review cancelled."), { code: "STOP_REVIEW_CANCELLED" }));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
        cancelTimer = scheduleStopDeadline(() => {
          reject(Object.assign(new Error("Review group reached its shared cutoff."), { code: "STOP_REVIEW_GROUP_TIMEOUT" }));
          controller.abort();
        }, group.deadlineAt, now);
      })]);
    } catch (error) {
      groupReason = error.code ?? "STOP_REVIEW_GROUP_FAILED";
      failures.push({ groupId: group.id, metricId: group.metricId, code: groupReason, reason: error.message });
      if (signal?.aborted) reasonCode = signalReason();
      else if (now() >= deadlineAt) reasonCode = "REVIEW_DEADLINE_EXPIRED";
    } finally {
      completed = true;
      cancelTimer?.();
      signal?.removeEventListener("abort", abort);
      controller.abort();
      await store.finishGroup({ groupId: group.id, token: group.token, reasonCode: groupReason });
    }
    if (reasonCode !== "COMPLETED") break;
  }
  if (reasonCode === "COMPLETED" && now() >= deadlineAt) reasonCode = "REVIEW_DEADLINE_EXPIRED";
  const summary = await store.finishRound({ roundId, reasonCode, settlementDeadlineAt, signal: settlementSignal });
  return { ...summary, failures, reasonCode };
}
