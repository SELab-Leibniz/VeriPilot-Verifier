export async function boundedRead(operation, ms, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Status query deadline expired; native work was not stopped'),
    { code: 'STATUS_QUERY_TIMEOUT' })), Math.max(1, ms));
  let onAbort;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    clearTimeout(timer); parentSignal?.removeEventListener('abort', abort);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}
