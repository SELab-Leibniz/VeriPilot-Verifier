// Optional experiment diagnostics. Persist only numeric budgets/counts, never
// URLs, headers, request text, tool arguments, credentials or response bodies.
import fs from 'node:fs';

const nonLatin = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu;
const adjusted = text => text.length - (text.match(/[\uD840-\uD87E][\uDC00-\uDFFF]/g) ?? []).length
  + (text.match(nonLatin) ?? []).length * 3;
const contentChars = value => typeof value === 'string' ? adjusted(value) : Array.isArray(value)
  ? value.reduce((sum, block) => sum + (['image_url', 'input_image'].includes(block?.type) ? 8000
    : typeof block?.text === 'string' ? adjusted(block.text) : adjusted(JSON.stringify(block))), 0) : 0;

export function providerBudget(body) {
  if (!body || !['deepseek-v4-flash', 'deepseek-v4.1-flash'].includes(body.model) || !Array.isArray(body.messages)) return null;
  let chars = 0, briefChars = 0, feedbackChars = 0, rcToolChars = 0;
  const rcCalls = new Set(body.messages.flatMap(message => (message.tool_calls ?? [])
    .filter(call => ['runtime_corrector', 'rc_document', 'rc_progress'].includes(call.function?.name)).map(call => call.id)));
  for (const message of body.messages) {
    chars += contentChars(message.content);
    for (const field of ['reasoning_content', 'reasoning', 'reasoning_details', 'reasoning_text']) chars += contentChars(message[field]);
    if (message.tool_calls !== undefined) chars += adjusted(JSON.stringify(message.tool_calls));
    const text = typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n');
    const briefAt = Math.max(text.indexOf('[RC implementation hints | advisory]'), text.indexOf('【RC 实现提示｜仅供参考】'));
    if (briefAt >= 0) briefChars += text.length - briefAt;
    const feedbackAt = text.indexOf('[runtime-corrector:');
    if (feedbackAt >= 0) feedbackChars += text.length - feedbackAt;
    if (message.role === 'tool' && rcCalls.has(message.tool_call_id)) rcToolChars += text.length;
  }
  if (body.tools?.length) chars += adjusted(JSON.stringify(body.tools));
  if (body.response_format !== undefined) chars += adjusted(JSON.stringify(body.response_format));
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  return { model: body.model, maxTokens: Number.isFinite(maxTokens) ? maxTokens : null,
    messageCount: body.messages.length, toolCount: body.tools?.length ?? 0,
    // Mirrors the pinned 2026.7.1-2 OpenAI serializer, not the host compaction
    // preflight or the provider tokenizer. Categories can overlap.
    serializerEstimatedInputTokens: Math.ceil(chars / 4 * 1.25),
    observedBriefCharacters: briefChars, observedFeedbackCharacters: feedbackChars, observedRcToolCharacters: rcToolChars };
}

export function observeFetch(fetch, record) {
  return function (input, init) {
    try {
      if (typeof init?.body === 'string') {
        const budget = providerBudget(JSON.parse(init.body));
        if (budget) record(budget);
      }
    } catch { /* Observation must never affect the original request. */ }
    return Reflect.apply(fetch, this, [input, init]);
  };
}

if (process.env.RC_PROVIDER_BUDGET_FILE && typeof globalThis.fetch === 'function') {
  let sequence = 0;
  globalThis.fetch = observeFetch(globalThis.fetch, budget => {
    fs.appendFileSync(process.env.RC_PROVIDER_BUDGET_FILE, JSON.stringify({ at: new Date().toISOString(),
      pid: process.pid, request: ++sequence, ...budget }) + '\n');
  });
}
