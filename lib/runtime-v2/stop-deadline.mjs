const expired = code => Object.assign(new Error("The shared Stop deadline was reached."), { code });

/** Absolute timer, including long user-configured windows that exceed Node's
 * single-timer range. Re-arming never moves the original deadline. */
export function scheduleStopDeadline(callback, deadlineAt, now = Date.now) {
  if (!Number.isFinite(deadlineAt)) throw new Error("An absolute finite Stop deadline is required.");
  let timer, cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = deadlineAt - now();
    timer = setTimeout(() => {
      if (cancelled) return;
      if (now() >= deadlineAt) callback(); else arm();
    }, Math.max(0, Math.min(remaining, 2 ** 31 - 1)));
  };
  arm();
  return () => { cancelled = true; clearTimeout(timer); };
}

/** Callbacks are read-only program checks. A late result has no commit path. */
export async function beforeStopDeadline(operation, { deadlineAt, signal, now = Date.now, code = "STOP_DEADLINE_EXPIRED" }) {
  if (!(Number.isFinite(deadlineAt) || deadlineAt === Infinity)) throw new Error("Invalid Stop deadline.");
  signal?.throwIfAborted();
  if (now() >= deadlineAt) throw expired(code);
  let cancelTimer, abort;
  const work = Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); });
  void work.catch(() => {});
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? expired("STOP_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      if (Number.isFinite(deadlineAt)) cancelTimer = scheduleStopDeadline(() => reject(expired(code)), deadlineAt, now);
    })]);
  } finally { cancelTimer?.(); signal?.removeEventListener("abort", abort); }
}
