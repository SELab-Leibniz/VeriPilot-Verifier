// Semantic fixture time is explicit. Only its declared role-budget timer is
// virtual; filesystem retry backoffs and the runner watchdog remain real.
const clocks = new WeakMap();

export function semanticReviewClock(t, { timeoutMs = null, originalRoleDeadline, collectorGraceMs } = {}) {
  const existing = clocks.get(t);
  if (existing) {
    if (timeoutMs !== null && existing.timeoutMs !== timeoutMs) throw new Error('A test cannot mix semantic clock budgets.');
    if (originalRoleDeadline !== undefined && existing.originalRoleDeadline !== originalRoleDeadline)
      throw new Error('A test cannot mix semantic role timer modes.');
    if (collectorGraceMs !== undefined && existing.collectorGraceMs !== collectorGraceMs)
      throw new Error('A test cannot mix semantic collector grace windows.');
    return existing;
  }
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw new RangeError('The virtual role timeout must be positive whole milliseconds.');
  if (originalRoleDeadline !== undefined && typeof originalRoleDeadline !== 'boolean')
    throw new TypeError('The original-role-deadline mode must be boolean.');
  if (originalRoleDeadline && timeoutMs === null) throw new Error('An original role deadline needs its declared timeout.');
  if (collectorGraceMs !== undefined && (timeoutMs === null || !Number.isSafeInteger(collectorGraceMs) || collectorGraceMs < 0))
    throw new RangeError('A semantic collector grace needs a declared role timeout and nonnegative whole milliseconds.');
  let now = Date.now(), sequence = 0;
  const roleDeadlineAt = timeoutMs === null ? null : now + timeoutMs;
  const pending = new Map(), issued = new WeakSet();
  const mockedNow = t.mock.method(Date, 'now', () => now);
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let mockedSetTimeout, mockedClearTimeout;
  if (timeoutMs !== null) {
    mockedSetTimeout = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      const remaining = roleDeadlineAt - now;
      // Only the existing native reviewer deadline callback belongs to this
      // optional mode. Equal-delay I/O backoffs and watchdogs stay real.
      const roleCallback = typeof callback === 'function' && Function.prototype.toString.call(callback)
        .includes('OpenClaw reviewer absolute deadline exhausted.');
      const declaredTimer = originalRoleDeadline
        ? remaining > 0 && Number(delay) === remaining && roleCallback
        : Number(delay) === timeoutMs;
      // The collector's existing timeout+grace wrapper belongs to the same
      // explicit fixture clock. Equal-delay I/O and watchdog callbacks stay real.
      const collectorTimer = collectorGraceMs !== undefined && typeof callback === 'function'
        && Number(delay) === timeoutMs + collectorGraceMs
        && Function.prototype.toString.call(callback).includes('REVIEW_ITEM_TIMEOUT');
      if ((!declaredTimer && !collectorTimer) || typeof callback !== 'function') return realSetTimeout(callback, delay, ...args);
      const handle = { ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
      issued.add(handle);
      pending.set(handle, { at: originalRoleDeadline && !collectorTimer ? roleDeadlineAt : now + Number(delay), sequence: sequence++, callback, args });
      return handle;
    });
    mockedClearTimeout = t.mock.method(globalThis, 'clearTimeout', handle => {
      if (handle && typeof handle === 'object' && issued.has(handle)) pending.delete(handle);
      else realClearTimeout(handle);
    });
  }
  const clock = {
    timeoutMs, originalRoleDeadline: originalRoleDeadline === true, collectorGraceMs,
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

