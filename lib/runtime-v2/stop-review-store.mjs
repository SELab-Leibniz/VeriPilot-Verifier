import path from "node:path";
import { randomUUID } from "node:crypto";
import { outsideDecision } from "./decision-scope.mjs";
import { withTaskResourceLock } from "./task-store.mjs";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { METRIC_IDS } from "./metric-policy.mjs";
import { beforeStopDeadline } from "./stop-deadline.mjs";

const schemaVersion = "runtime-corrector.stop-review-scope.v1";
const conclusive = result => ["PASS", "DEVIATION"].includes(result?.judgement);
const failure = (code, message) => { throw Object.assign(new Error(message), { code }); };
const keyOf = item => `${item.metricId}:${item.objectId}`;
const basisOf = item => sha256({ revisionId: item.revisionId, basis: item.basis, dependencies: item.dependencies });
const priorityOf = item => item.history.some(entry => conclusive(entry.result)) ? 2 : item.attempts.length ? 1 : 0;
const isCurrent = item => item.current && item.current.basisKey === item.basisKey && item.current.valid !== false;
const reusable = item => isCurrent(item) && conclusive(item.current.result);

/** Program-owned state, independent of group size, agent summaries and GT's
 * global version. The caller supplies per-item required dependencies. */
export function createStopReviewStore({ directory, sessionId, scopeId, now = Date.now, validateResult, dependenciesCurrent }) {
  if (!path.isAbsolute(directory ?? "") || !sessionId || !scopeId) throw new Error("An absolute store directory, session and frozen review scope are required.");
  if (typeof validateResult !== "function" || typeof dependenciesCurrent !== "function")
    throw new Error("Program-owned result validation and dependency checks are required.");
  const storeKey = sha256([sessionId, scopeId]);
  const file = path.join(directory, "review-scopes", `${storeKey}.json`);
  const transaction = update => outsideDecision(() => withTaskResourceLock({ projectRoot: directory,
    taskId: storeKey, resource: "stop-review-scope", reclaimDeadOwner: true }, async () => {
    const state = await readJson(file) ?? { schemaVersion, sessionId, scopeId, items: {}, queues: {},
      nextMetric: { 0: "M01", 1: "M01", 2: "M01" }, rounds: {}, groups: {}, receipts: {}, conflicts: [] };
    if (state.schemaVersion !== schemaVersion || state.sessionId !== sessionId || state.scopeId !== scopeId)
      failure("STOP_REVIEW_STORE_INVALID", "Review scope identity/schema mismatch.");
    const result = await update(state);
    state.updatedAt = now();
    await atomicWriteJson(file, state);
    return structuredClone(result);
  }));
  const invalidate = (item, reason) => {
    if (item.current?.valid !== false && item.current) {
      item.invalidations.push({ receiptId: item.current.receiptId, reason, at: now() });
      item.current.valid = false;
    }
  };
  const refresh = async (state, deadlineAt = Infinity, signal) => {
    for (const item of Object.values(state.items).filter(item => item.active && isCurrent(item)))
      if (!await beforeStopDeadline(() => dependenciesCurrent(structuredClone(item.definition), structuredClone(item.current)),
        { deadlineAt, signal, now, code: "STOP_REVIEW_ROUND_CLOSED" })) invalidate(item, "NECESSARY_DEPENDENCY_CHANGED");
  };
  const roundFor = (state, roundId) => {
    const round = state.rounds[roundId];
    if (!round || state.activeRoundId !== roundId || round.closedAt !== undefined || now() >= round.deadlineAt)
      failure("STOP_REVIEW_ROUND_CLOSED", "The review round is closed, replaced, or past its review cutoff.");
    return round;
  };
  const currentView = state => Object.values(state.items).filter(item => item.active).map(item => ({
    objectId: item.definition.objectId, metricId: item.definition.metricId, revisionId: item.definition.revisionId,
    basisKey: item.basisKey, priority: priorityOf(item), attempts: item.attempts.length,
    result: isCurrent(item) ? item.current.result : { judgement: "UNVERIFIED", reason: item.history.length ? "HISTORICAL_RESULT_PENDING_REVIEW" : "NOT_REVIEWED", evidence: [] },
    receiptId: isCurrent(item) ? item.current.receiptId : null, historicalDeviation: item.history.some(entry => entry.result.judgement === "DEVIATION"),
    invalidations: item.invalidations,
  }));
  return {
    file,
    async inspect() { return outsideDecision(() => readJson(file)); },
    async beginRound({ roundId, stopId, deadlineAt, groupSize = 3, items, signal }) {
      if (typeof roundId !== "string" || !roundId || Object.hasOwn(Object.prototype, roundId) || !stopId || !Number.isFinite(deadlineAt) || !Number.isSafeInteger(groupSize) || groupSize < 1 || !Array.isArray(items))
        failure("STOP_REVIEW_SCOPE_INVALID", "A round needs Stop identity, cutoff, positive group size and frozen items.");
      const identities = new Set();
      for (const item of items) {
        if (!item.objectId || !METRIC_IDS.includes(item.metricId) || !item.revisionId || item.basis === undefined
          || !Array.isArray(item.dependencies) || identities.has(keyOf(item)))
          failure("STOP_REVIEW_SCOPE_INVALID", "Each item needs a unique metric identity, revision, unchanged basis and necessary dependency list.");
        identities.add(keyOf(item));
      }
      return transaction(async state => {
        signal?.throwIfAborted();
        if (state.rounds[roundId]) return state.rounds[roundId];
        if (state.activeRoundId && state.rounds[state.activeRoundId].closedAt === undefined) {
          state.rounds[state.activeRoundId].closedAt = now();
          state.rounds[state.activeRoundId].closeReason = "SUPERSEDED";
        }
        for (const [key, item] of Object.entries(state.items)) {
          item.active = identities.has(key);
          if (!item.active) invalidate(item, "LEFT_CURRENT_SCOPE");
        }
        for (const definition of items) {
          const key = keyOf(definition), basisKey = basisOf(definition);
          let item = state.items[key];
          if (!item) {
            item = state.items[key] = { definition: structuredClone(definition), basisKey, active: true, history: [], attempts: [], invalidations: [] };
            (state.queues[definition.metricId] ??= []).push(key);
          } else {
            if (basisKey !== item.basisKey) invalidate(item, "REQUIREMENT_OR_DEPENDENCY_VERSION_CHANGED");
            item.definition = structuredClone(definition); item.basisKey = basisKey; item.active = true;
          }
          if (definition.recheckRequestId && definition.recheckRequestId !== item.lastRecheckRequestId) {
            invalidate(item, "EXPLICIT_REVIEW_REQUEST");
            item.lastRecheckRequestId = definition.recheckRequestId;
          }
        }
        await refresh(state, deadlineAt, signal);
        signal?.throwIfAborted();
        const round = state.rounds[roundId] = { id: roundId, stopId, deadlineAt, groupSize, createdAt: now(), dispatchedKeys: [], groupIds: [] };
        state.activeRoundId = roundId;
        return round;
      });
    },
    async dispatch({ roundId, groupDeadlineAt = Infinity, signal }) {
      if (!(Number.isFinite(groupDeadlineAt) || groupDeadlineAt === Infinity)) failure("STOP_REVIEW_SCOPE_INVALID", "Invalid group cutoff.");
      return transaction(async state => {
        signal?.throwIfAborted();
        const round = roundFor(state, roundId);
        await refresh(state, round.deadlineAt, signal);
        signal?.throwIfAborted();
        roundFor(state, roundId);
        const already = new Set(round.dispatchedKeys);
        for (const priority of [0, 1, 2]) {
          const start = METRIC_IDS.indexOf(state.nextMetric[priority]);
          for (let offset = 0; offset < METRIC_IDS.length; offset++) {
            const metricIndex = (start + offset) % METRIC_IDS.length, metricId = METRIC_IDS[metricIndex];
            const eligible = (state.queues[metricId] ?? []).filter(key => {
              const item = state.items[key];
              return item.active && !reusable(item) && !already.has(key) && priorityOf(item) === priority;
            });
            if (!eligible.length) continue;
            const keys = eligible.slice(0, round.groupSize), groupId = randomUUID(), token = randomUUID();
            const group = state.groups[groupId] = { id: groupId, token, roundId, stopId: round.stopId, metricId, priority,
              createdAt: now(), deadlineAt: Math.min(round.deadlineAt, groupDeadlineAt),
              members: keys.map(key => ({ key, objectId: state.items[key].definition.objectId,
                revisionId: state.items[key].definition.revisionId, basisKey: state.items[key].basisKey })) };
            round.groupIds.push(groupId); round.dispatchedKeys.push(...keys);
            for (const key of keys) state.items[key].attempts.push({ roundId, groupId, at: now(), priority });
            // Commit the opportunity and cursor BEFORE starting the agent.
            state.nextMetric[priority] = METRIC_IDS[(metricIndex + 1) % METRIC_IDS.length];
            const moved = new Set(keys);
            state.queues[metricId] = [...state.queues[metricId].filter(key => !moved.has(key)), ...keys];
            return { ...group, items: keys.map(key => state.items[key].definition) };
          }
        }
        return null;
      });
    },
    async submit({ groupId, token, objectId, revisionId, basisKey, result, signal }) {
      return transaction(async state => {
        const group = state.groups[groupId];
        if (!group || group.token !== token) failure("STOP_REVIEW_OWNERSHIP_INVALID", "Invalid group submission capability.");
        const member = group.members.find(member => member.objectId === objectId);
        if (!member || member.revisionId !== revisionId || member.basisKey !== basisKey)
          failure("STOP_REVIEW_OWNERSHIP_INVALID", "Wrong member, requirement revision or review basis.");
        const item = state.items[member.key];
        if (item.basisKey !== basisKey || !item.active) failure("STOP_REVIEW_STALE", "The item's current scope or necessary basis has changed.");
        if (!result || !["PASS", "DEVIATION", "UNVERIFIED", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "BASIS_PENDING"].includes(result.judgement)
          || typeof result.reason !== "string" || !result.reason.trim() || !Array.isArray(result.evidence)
          || result.evidence.some(ref => typeof ref !== "string" || !ref.trim())
          || Object.keys(result).some(key => !["judgement", "reason", "evidence", "productionTrace"].includes(key)))
          failure("STOP_REVIEW_RESULT_INVALID", "Submit an item verdict, reason and evidence; paths and new identities are program-owned.");
        const submissionKey = sha256([groupId, objectId, revisionId, basisKey, result]);
        if (state.receipts[submissionKey]) return state.receipts[submissionKey];
        signal?.throwIfAborted();
        roundFor(state, group.roundId);
        if (group.closedAt !== undefined || now() >= group.deadlineAt) failure("STOP_REVIEW_GROUP_CLOSED", "The review group already ended.");
        // Validation returns the canonical checked record, including observed
        // source citations. A model filename or final summary is never a receipt.
        const checked = await beforeStopDeadline(() => validateResult({ item: structuredClone(item.definition), result: structuredClone(result), group: structuredClone(group) }),
          { deadlineAt: group.deadlineAt, signal, now, code: "STOP_REVIEW_ROUND_CLOSED" });
        if (!checked || checked.result?.judgement !== result.judgement) failure("STOP_REVIEW_RESULT_INVALID", "Result validation did not confirm this verdict.");
        if (!await beforeStopDeadline(() => dependenciesCurrent(structuredClone(item.definition), checked),
          { deadlineAt: group.deadlineAt, signal, now, code: "STOP_REVIEW_ROUND_CLOSED" })) failure("STOP_REVIEW_STALE", "Necessary evidence changed before persistence.");
        signal?.throwIfAborted();
        if (now() >= group.deadlineAt) failure("STOP_REVIEW_GROUP_CLOSED", "The group's review deadline expired before persistence.");
        roundFor(state, group.roundId);
        const snapshotKey = sha256([basisKey, checked.snapshotKey]);
        if (typeof checked.snapshotKey !== "string" || !checked.snapshotKey) failure("STOP_REVIEW_RESULT_INVALID", "The validator must bind a review snapshot.");
        const previous = item.history.filter(entry => entry.basisKey === basisKey && entry.snapshotKey === snapshotKey);
        const conflict = previous.some(entry => entry.result.judgement !== result.judgement);
        const receipt = { id: randomUUID(), groupId, roundId: group.roundId, objectId, revisionId, basisKey,
          snapshotKey, persistedAt: now(), conflict, resultHash: sha256(checked.result) };
        const entry = { ...structuredClone(checked), receiptId: receipt.id, basisKey, snapshotKey, groupId, at: now(), valid: !conflict };
        item.history.push(structuredClone(entry));
        if (conflict) {
          state.conflicts.push({ objectId, receiptIds: [...previous.map(value => value.receiptId), receipt.id], at: now() });
          // A same-snapshot disagreement cannot erase confirmed deviation or
          // turn into PASS. New-version reverification uses a different basis.
          const deviation = [...previous, entry].find(value => value.result.judgement === "DEVIATION");
          item.current = deviation ? { ...structuredClone(deviation), valid: true, conflict: true }
            : { ...entry, valid: true, result: { judgement: "UNVERIFIED", reason: "CONFLICTING_SAME_SNAPSHOT_RESULTS", evidence: [] }, conflict: true };
        } else item.current = entry;
        state.receipts[submissionKey] = receipt;
        return receipt;
      });
    },
    async finishGroup({ groupId, token, reasonCode = "COMPLETED" }) {
      return transaction(state => {
        const group = state.groups[groupId];
        if (!group || group.token !== token) failure("STOP_REVIEW_OWNERSHIP_INVALID", "Invalid group capability.");
        group.closedAt ??= now(); group.closeReason ??= reasonCode;
        // No receipts are inferred from successful group termination.
        return group;
      });
    },
    async finishRound({ roundId, reasonCode = "COMPLETED", settlementDeadlineAt = Infinity, signal }) {
      return transaction(async state => {
        const round = state.rounds[roundId];
        if (!round) failure("STOP_REVIEW_SCOPE_INVALID", "Unknown review round.");
        if (round.summary) return round.summary;
        if (state.activeRoundId !== roundId) failure("STOP_REVIEW_ROUND_CLOSED", "A superseded round cannot publish a new current summary.");
        round.closedAt ??= now(); round.closeReason ??= reasonCode;
        if (state.activeRoundId === roundId && !["CANCELLED_OR_STALE", "SUPERSEDED"].includes(reasonCode)) await refresh(state, settlementDeadlineAt, signal);
        const items = currentView(state);
        const deviations = items.filter(item => item.result.judgement === "DEVIATION");
        const complete = items.length > 0 && items.every(item => item.receiptId && item.result.judgement !== "UNVERIFIED")
          && items.every(item => !state.items[`${item.metricId}:${item.objectId}`].current.conflict);
        const allExcluded = !items.length || items.every(item => item.result.judgement === "NOT_APPLICABLE");
        const passed = complete && items.every(item => ["PASS", "NOT_APPLICABLE"].includes(item.result.judgement));
        const summary = { round: structuredClone(round), items, deviations, complete, status: deviations.length ? "DEVIATION"
          : allExcluded ? "SKIPPED" : passed ? "PASS" : "UNVERIFIED",
        progress: { total: items.length, completed: items.filter(item => item.receiptId).length,
          deviations: deviations.length, unverified: items.filter(item => item.result.judgement === "UNVERIFIED").length,
          groups: round.groupIds.length, reused: items.filter(item => item.receiptId
            && !round.groupIds.includes(state.items[`${item.metricId}:${item.objectId}`].current.groupId)).length } };
        if (["CANCELLED_OR_STALE", "SUPERSEDED"].includes(reasonCode)) {
          summary.status = "UNVERIFIED"; summary.complete = false; summary.deviations = [];
        }
        round.summary = structuredClone(summary);
        return summary;
      });
    },
  };
}
