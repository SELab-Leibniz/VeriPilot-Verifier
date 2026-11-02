// Development-only admission guard. A qualified transport must supply a real
// input-token upper bound and enforce maxOutputTokens on the outgoing request.
// This ledger neither tokenizes prompts nor grants permission to send them.
const scale = 1_000_000_000n;
function money(value) {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/u.exec(String(value));
  if (!match) throw new Error('Invalid nonnegative USD amount');
  return BigInt(match[1]) * scale + BigInt((match[2] ?? '').padEnd(9, '0'));
}
const integer = (n, label) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${label}`);
  return n;
};
const fail = code => Object.assign(new Error(code), { code });
function originOf(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw fail('BUDGET_ORIGIN_INVALID');
  return url.origin;
}

export function createProviderRequestBudget({ origin, limits, prices, now = Date.now }) {
  const allowedOrigin = originOf(origin), startedAt = now();
  const cap = money(limits.usd);
  if (!cap) throw new Error('A positive USD ceiling is required');
  const maximum = Object.fromEntries(['requests', 'wallMs', 'inputPerRequest', 'outputPerRequest', 'totalInput', 'totalOutput']
    .map(key => [key, integer(limits[key], key)]));
  const rates = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, money(prices[key])]));
  if (!rates.input || !rates.output) throw new Error('Explicit positive input/output reference rates are required');
  const maxInputRate = [rates.input, rates.cacheRead, rates.cacheWrite].reduce((a,b) => a > b ? a : b);
  const cost = (input, output, inputRate = maxInputRate) => (BigInt(input) * inputRate + BigInt(output) * rates.output + 999_999n) / 1_000_000n;
  const maxConcurrent = integer(limits.maxConcurrent ?? 1, 'maximum concurrent requests');
  if (maxConcurrent > 4) throw new Error('Maximum concurrent requests must be at most four');
  let requests = 0, input = 0, output = 0, committed = 0n, activeRequests = 0, inFlightRequests = 0, halted = null;
  const snapshot = () => ({ origin: allowedOrigin, requests, committedInputTokens: input, committedOutputTokens: output,
    estimatedCommittedUsd: Number(committed) / Number(scale), active: activeRequests > 0, inFlightRequests, halted, elapsedMs: now() - startedAt,
    rateKind: 'explicit_reference_estimate_not_verified_bill' });
  return {
    snapshot,
    async run(request, dispatch) {
      if (halted) throw fail(halted);
      if (originOf(request.origin) !== allowedOrigin) throw fail('BUDGET_ORIGIN_MISMATCH');
      if (typeof dispatch !== 'function') throw new Error('A dispatch function is required');
      if (activeRequests >= maxConcurrent) throw fail('BUDGET_CONCURRENT_DISPATCH');
      const remaining = maximum.wallMs - (now() - startedAt);
      if (remaining <= 0) { halted = 'BUDGET_WALL_LIMIT'; throw fail(halted); }
      const inCap = integer(request.inputTokensUpperBound, 'input token upper bound');
      const outCap = integer(request.maxOutputTokens, 'output token limit');
      if (inCap > maximum.inputPerRequest || outCap > maximum.outputPerRequest) throw fail('BUDGET_REQUEST_TOKEN_LIMIT');
      const reserved = cost(inCap, outCap);
      if (requests >= maximum.requests) throw fail('BUDGET_REQUEST_LIMIT');
      if (input + inCap > maximum.totalInput || output + outCap > maximum.totalOutput) throw fail('BUDGET_TOTAL_TOKEN_LIMIT');
      if (committed + reserved > cap) throw fail('BUDGET_COST_LIMIT');
      // All admissions above are synchronous: concurrent callers cannot spend
      // the same remaining balance. Failed requests never regain their slot.
      requests++; input += inCap; output += outCap; committed += reserved; activeRequests++;
      const controller = new AbortController(); let timer;
      try {
        inFlightRequests++;
        const invocation = Promise.resolve().then(() => dispatch({ signal: controller.signal, maxOutputTokens: outCap }))
          .finally(() => { inFlightRequests--; });
        const result = await Promise.race([
          invocation,
          new Promise((_, reject) => { timer = setTimeout(() => {
            const error = fail('BUDGET_WALL_LIMIT'); controller.abort(error); reject(error);
          }, remaining); }),
        ]);
        const usage = result?.usage;
        if (!usage || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0))
          throw fail('BUDGET_USAGE_UNKNOWN');
        const usedInput = usage.input + usage.cacheRead + usage.cacheWrite;
        if (!Number.isSafeInteger(usedInput)) throw fail('BUDGET_USAGE_UNKNOWN');
        const actual = (BigInt(usage.input) * rates.input + BigInt(usage.cacheRead) * rates.cacheRead
          + BigInt(usage.cacheWrite) * rates.cacheWrite + BigInt(usage.output) * rates.output + 999_999n) / 1_000_000n;
        input += usedInput - inCap; output += usage.output - outCap; committed += actual - reserved;
        if (usedInput > inCap || usage.output > outCap || actual > reserved) throw fail('BUDGET_USAGE_EXCEEDS_RESERVATION');
        if (now() - startedAt >= maximum.wallMs) throw fail('BUDGET_WALL_LIMIT');
        return result.value;
      } catch (error) {
        // Unknown consumption retains its worst-case reservation and halts
        // further dispatch. Aborting a signal does not prove upstream ended:
        // inFlightRequests stays positive until that invocation really settles.
        halted ??= typeof error?.code === 'string' && error.code.startsWith('BUDGET_') ? error.code : 'BUDGET_USAGE_UNKNOWN';
        throw error;
      } finally { clearTimeout(timer); activeRequests--; }
    },
  };
}
