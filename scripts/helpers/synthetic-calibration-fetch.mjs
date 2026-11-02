// Narrow, development-only wiring for the approved synthetic provider probe.
// The installed serializer supplies the reviewed payload; all HTTP attempts
// through this fetch boundary share one budget. No headers enter records.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });

export function syntheticSseUsage(text) {
  let input, output, cacheRead, cacheWrite, ended = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data: ')) continue;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { throw fail('BUDGET_USAGE_UNKNOWN'); }
    if (event.type === 'message_start') {
      const usage = event.message?.usage;
      input = usage?.input_tokens;
      cacheRead = usage?.cache_read_input_tokens;
      cacheWrite = usage?.cache_creation_input_tokens;
    }
    if (event.type === 'message_delta' && event.usage?.output_tokens !== undefined) output = event.usage.output_tokens;
    if (event.type === 'message_stop') ended = true;
  }
  if (!ended || [input, output, cacheRead, cacheWrite].some(n => !Number.isSafeInteger(n) || n < 0))
    throw fail('BUDGET_USAGE_UNKNOWN');
  return { input, output, cacheRead, cacheWrite };
}

export function syntheticOpenAiSseUsage(text) {
  let reported, finishReason = null, doneSeen = false;
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data) continue;
    if (data === '[DONE]') { doneSeen = true; continue; }
    if (doneSeen) throw fail('BUDGET_USAGE_UNKNOWN');
    let event;
    try { event = JSON.parse(data); } catch { throw fail('BUDGET_USAGE_UNKNOWN'); }
    if (event.error) throw fail('BUDGET_USAGE_UNKNOWN');
    const choice = event.choices?.find(choice => choice.index === 0)
      ?? (event.choices?.[0]?.index === undefined ? event.choices?.[0] : null);
    const reason = choice?.finish_reason;
    if (typeof reason === 'string' && reason) finishReason = reason;
    if (event.usage) reported = event.usage;
  }
  const input = reported?.prompt_tokens, output = reported?.completion_tokens;
  if (!finishReason || [input, output].some(n => !Number.isSafeInteger(n) || n < 0)
    || !Number.isSafeInteger(input + output)) throw fail('BUDGET_USAGE_UNKNOWN');
  const total = reported.total_tokens;
  if (total !== undefined && total !== input + output) throw fail('BUDGET_USAGE_UNKNOWN');
  const cached = reported.prompt_tokens_details?.cached_tokens;
  const reasoning = reported.completion_tokens_details?.reasoning_tokens;
  if (cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > input)) throw fail('BUDGET_USAGE_UNKNOWN');
  if (reasoning !== undefined && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output)) throw fail('BUDGET_USAGE_UNKNOWN');
  return {
    // These zero allocations grant no cache discount; they are NOT claims
    // that the provider reported zero cache activity. Prompt includes cache.
    usage: { input, output, cacheRead: 0, cacheWrite: 0 },
    reportedUsage: { prompt_tokens: input, completion_tokens: output, total_tokens: total ?? null,
      cached_tokens: cached ?? null, reasoning_tokens: reasoning ?? null },
    usageNormalization: 'Entire reported prompt total charged at full input rate; unreported cache breakdown remains unknown.',
    termination: { httpBodyComplete: true, finishReason, doneSeen },
  };
}

export function createSyntheticCalibrationFetch({ budget, origin, fetchImpl, getApprovedPayload, onRecord = () => {},
  onResponseBody = async () => {}, maxOutputTokens = 8192, inputTokensUpperBound = 32768, protocol = 'anthropic-messages' }) {
  if (!['anthropic-messages', 'openai-completions'].includes(protocol)) throw fail('SYNTHETIC_PROTOCOL_DENIED');
  const coding = protocol === 'openai-completions';
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw fail('BUDGET_ORIGIN_MISMATCH');
    if (url.pathname !== (coding ? '/api/coding/paas/v4/chat/completions' : '/api/anthropic/v1/messages')) throw fail('SYNTHETIC_ENDPOINT_DENIED');
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw fail('SYNTHETIC_PAYLOAD_DENIED');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload, JSON.parse(JSON.stringify(getApprovedPayload())), 'wire payload differs from the approved synthetic serializer output');
    if (coding && (payload.model !== 'glm-5.3' || payload.stream !== true || payload.stream_options?.include_usage !== true
      || Object.hasOwn(payload, 'max_completion_tokens'))) throw fail('SYNTHETIC_PAYLOAD_DENIED');
    if (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > maxOutputTokens)
      throw fail('BUDGET_REQUEST_TOKEN_LIMIT');
    // A small text-only JSON envelope plus an 8192-token protocol allowance.
    // The admitted 32768 bound is the conservative calibration assumption,
    // checked again against complete provider usage; not a general tokenizer.
    if (inputTokensUpperBound !== 32768 || Buffer.byteLength(init.body) > 24576 || payload.messages?.length > 12)
      throw fail('BUDGET_INPUT_ENVELOPE_LIMIT');
    const publicRecord = { origin: url.origin, pathname: url.pathname, protocol, model: payload.model,
      maxTokens: payload.max_tokens, inputTokensUpperBound, payloadBytes: Buffer.byteLength(init.body),
      payloadSha256: crypto.createHash('sha256').update(init.body).digest('hex') };
    return budget.run({ origin: url.origin, inputTokensUpperBound, maxOutputTokens: payload.max_tokens }, async ({ signal }) => {
      const response = await fetchImpl(input, { ...init, redirect: 'manual',
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) throw fail('BUDGET_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (response.ok) await onResponseBody(bytes);
      try {
        if (!response.ok) throw fail('BUDGET_USAGE_UNKNOWN');
        const details = coding ? syntheticOpenAiSseUsage(bytes.toString('utf8')) : { usage: syntheticSseUsage(bytes.toString('utf8')) };
        const { usage } = details;
        onRecord({ ...publicRecord, status: response.status, ...details });
        return { value: new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers }), usage };
      } catch (error) {
        onRecord({ ...publicRecord, status: response.status, usage: null, errorCode: error.code ?? 'BUDGET_USAGE_UNKNOWN' });
        throw error;
      }
    });
  };
}
