// Test-only fixed parent clock. No production budget, guard or model is changed.
const coded = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
export function fixtureRuntimeHealth(state) {
  return { nativeInvalidated: state?.nativeInvalidated === true,
    reviewControllerAborted: state?.reviewController?.signal.aborted === true,
    abortReasonCode: coded(state?.reviewController?.signal.reason?.code),
    hotReviewWorkPresent: Boolean(state?.hotReviewWork), hotReviewWorkStarted: state?.hotReviewWork?.started === true };
}
export function createFixtureDeadline(t, { timeoutMs = 30000, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('INVALID_FIXTURE_TIMEOUT');
  const startedAt = now(), deadlineAt = startedAt + timeoutMs, controller = new AbortController();
  const expired = () => Object.assign(new Error('The original fixture deadline expired.'), { code: 'RC_FIXTURE_DEADLINE' });
  const timer = setTimer(() => controller.abort(expired()), timeoutMs);
  const close = () => clearTimer(timer); t?.after(close);
  const remaining = () => Math.max(0, deadlineAt - now());
  async function wait(promise, description, { state, work, maxWaitMs = Infinity } = {}) {
    const budget = Math.min(remaining(), maxWaitMs);
    if (controller.signal.aborted || budget <= 0) throw controller.signal.reason ?? expired();
    if (state?.reviewController?.signal.aborted) throw Object.assign(new Error('Fixture review aborted before observation.'),
      { code: 'RC_FIXTURE_REVIEW_ABORTED', causeCode: coded(state.reviewController.signal.reason?.code) });
    let waitTimer, abort, reviewAbort;
    const parent = new Promise((_, reject) => {
      abort = () => reject(controller.signal.reason ?? expired());
      controller.signal.addEventListener('abort', abort, { once: true });
      waitTimer = setTimer(() => reject(Object.assign(new Error(`Fixture observation expired: ${description}`),
        { code: 'RC_FIXTURE_OBSERVATION_DEADLINE' })), budget);
    });
    const review = state?.reviewController?.signal;
    const cancelled = new Promise((_, reject) => {
      reviewAbort = () => reject(Object.assign(new Error('Fixture review aborted before observation.'),
        { code: 'RC_FIXTURE_REVIEW_ABORTED', causeCode: coded(review.reason?.code) }));
      review?.addEventListener('abort', reviewAbort, { once: true });
    });
    const settled = work?.promise?.then(() => { throw Object.assign(new Error('Detached work settled before its expected callback.'),
      { code: 'RC_FIXTURE_WORK_SETTLED_WITHOUT_OBSERVATION' }); });
    try { return await Promise.race([promise, parent, cancelled, ...(settled ? [settled] : [])]); }
    finally { clearTimer(waitTimer); controller.signal.removeEventListener('abort', abort); review?.removeEventListener('abort', reviewAbort); }
  }
  return { startedAt, deadlineAt, remaining, controller, signal: controller.signal, wait, close };
}
