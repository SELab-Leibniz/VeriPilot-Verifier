// Semantic fixture time is explicit. Only its declared role-budget timer is
// virtual; filesystem retry backoffs and the runner watchdog remain real.
const clocks = new WeakMap();

export function semanticReviewClock(t, { timeoutMs = null } = {}) {
  const existing = clocks.get(t);
  if (existing) {
    if (timeoutMs !== null && existing.timeoutMs !== timeoutMs) throw new Error('A test cannot mix semantic clock budgets.');
    return existing;
  }
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw new RangeError('The virtual role timeout must be positive whole milliseconds.');
  let now = Date.now(), sequence = 0;
  const pending = new Map(), issued = new WeakSet();
  const mockedNow = t.mock.method(Date, 'now', () => now);
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let mockedSetTimeout, mockedClearTimeout;
  if (timeoutMs !== null) {
    mockedSetTimeout = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (Number(delay) !== timeoutMs || typeof callback !== 'function') return realSetTimeout(callback, delay, ...args);
      const handle = { ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
      issued.add(handle);
      pending.set(handle, { at: now + timeoutMs, sequence: sequence++, callback, args });
      return handle;
    });
    mockedClearTimeout = t.mock.method(globalThis, 'clearTimeout', handle => {
      if (handle && typeof handle === 'object' && issued.has(handle)) pending.delete(handle);
      else realClearTimeout(handle);
    });
  }
  const clock = {
    timeoutMs,
    now: () => now,
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('Clock advance must be nonnegative whole milliseconds.');
      now += ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[1].sequence - b[1].sequence)[0];
        if (!due) break;
        pending.delete(due[0]); due[1].callback(...due[1].args);
      }
    },
  };
  clocks.set(t, clock);
  t.after(() => {
    pending.clear();
    mockedSetTimeout?.mock.restore(); mockedClearTimeout?.mock.restore();
    mockedNow.mock.restore();
  });
  return clock;
}

