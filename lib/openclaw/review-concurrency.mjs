import { beforeStopDeadline } from "../runtime-v2/stop-deadline.mjs";

export function createReviewSlots(limit, invalidLimitMessage) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error(invalidLimitMessage);
  let active = 0;
  const queue = [];
  function pump() {
    while (active < limit && queue.length) {
      const item = queue.shift();
      active++;
      let released = false;
      item.release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      item.resolve(item.release);
    }
  }
  return async function acquire({ deadlineAt, signal, code, message }) {
    let item;
    try {
      return await beforeStopDeadline(() => new Promise(resolve => {
        item = { resolve };
        queue.push(item);
        pump();
      }), { deadlineAt, signal, code, message });
    } catch (error) {
      if (item?.release) item.release();
      else if (item) queue.splice(queue.indexOf(item), 1);
      throw error;
    }
  };
}

export function createReviewerAgentPool(limit) {
  const acquire = createReviewSlots(limit, "Invalid agentConcurrency. Expected an integer from 1 to 32.");
  return {
    async run(dispatch, { deadlineAt, signal }) {
      const release = await acquire({ deadlineAt, signal, code: "REVIEWER_DEADLINE",
        message: "The reviewer deadline was reached while waiting for an RC Agent slot." });
      let dispatched = false;
      try {
        return await dispatch(native => {
          // A caller may time out while the host is still running. Only the
          // native promise can give that Agent slot to the next caller.
          dispatched = true;
          void native.then(release, release);
        });
      } finally {
        if (!dispatched) release();
      }
    },
  };
}
