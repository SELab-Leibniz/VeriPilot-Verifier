// One trusted model-start event counts as one repair step. This never owns an
// original user run, and duplicate diagnostic delivery cannot spend twice.
export function createRepairStepBudget({ runId, sessionId, sessionKey, maxSteps }) {
  if (!/^rc-stop-[a-f0-9]{64}$/u.test(runId ?? '') || !sessionId || !sessionKey)
    throw new Error('An exact plugin-created repair identity is required');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('Invalid repair step budget');
  const seen = new Set();
  let limited = false;
  return {
    observe(event) {
      if (event.type !== 'model.call.started' || event.runId !== runId || event.sessionId !== sessionId
        || event.sessionKey !== sessionKey || !Number.isSafeInteger(event.seq) || seen.has(event.seq))
        return { steps: seen.size, firstExceeded: false };
      seen.add(event.seq);
      const firstExceeded = !limited && seen.size > maxSteps;
      if (firstExceeded) limited = true;
      return { steps: seen.size, firstExceeded };
    },
  };
}
