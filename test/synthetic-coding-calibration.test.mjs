import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProviderRequestBudget } from '../scripts/helpers/provider-request-budget.mjs';
import { createSyntheticCalibrationFetch, syntheticOpenAiSseUsage } from '../scripts/helpers/synthetic-calibration-fetch.mjs';

const origin = 'https://open.bigmodel.cn', url = origin + '/api/coding/paas/v4/chat/completions';
const payload = { model: 'glm-5.3', max_tokens: 8192, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'fictional task only' }] };
const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 };
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n';
const finish = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const tail = frame({ choices: [], usage });
const sse = finish + tail + 'data: [DONE]\n\n';
function budget() { return createProviderRequestBudget({ origin, limits: { usd: '0.8192', requests: 2, wallMs: 1000,
  inputPerRequest: 32768, outputPerRequest: 8192, totalInput: 65536, totalOutput: 16384 }, prices: { input: 7, output: 22, cacheRead: 7, cacheWrite: 7 } }); }
const init = value => ({ method: 'POST', body: JSON.stringify(value) });

test('OpenAI total usage accepts separate tail chunks without inventing unreported cache counts', () => {
  const result = syntheticOpenAiSseUsage(sse);
  assert.deepEqual(result.reportedUsage, { ...usage, cached_tokens: null, reasoning_tokens: null });
  assert.deepEqual(result.usage, { input: 20, output: 7, cacheRead: 0, cacheWrite: 0 });
  assert.match(result.usageNormalization, /full input rate.*unknown/u);
  assert(result.termination.doneSeen);
});
test('complete HTTP body plus finish and total usage is sufficient without a DONE sentinel', () => {
  for (const body of [finish + tail, frame({ choices: [{ finish_reason: 'tool_calls' }], usage })]) {
    const result = syntheticOpenAiSseUsage(body);
    assert.equal(result.reportedUsage.prompt_tokens, 20); assert.equal(result.termination.doneSeen, false);
  }
});
test('reported cached tokens stay distinct while ledger charges the whole prompt once', () => {
  const result = syntheticOpenAiSseUsage(frame({ choices: [{ index: 0, finish_reason: 'stop' }], usage: { ...usage,
    prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } } }));
  assert.equal(result.reportedUsage.cached_tokens, 12); assert.equal(result.reportedUsage.reasoning_tokens, 5);
  assert.equal(result.usage.input, 20); assert.equal(result.usage.cacheRead, 0);
});
test('DONE never fills missing totals or finish; malformed, contradictory and truncated evidence stops', () => {
  for (const body of [finish + 'data: [DONE]\n\n', tail + 'data: [DONE]\n\n', 'data: [DONE]\n\n',
    finish + 'data: {"usage":', finish + frame({ usage: { ...usage, total_tokens: 99 } }),
    finish + frame({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 21 } } }),
    finish + frame({ usage: { prompt_tokens: 20 } })]) assert.throws(() => syntheticOpenAiSseUsage(body), { code: 'BUDGET_USAGE_UNKNOWN' });
});
test('actual Coding endpoint, model and stream usage are checked before dispatch', async () => {
  let sent = 0;
  const guarded = createSyntheticCalibrationFetch({ budget: budget(), origin, protocol: 'openai-completions', getApprovedPayload: () => payload,
    fetchImpl: async () => { sent++; return new Response(sse); } });
  for (const wrong of ['/api/anthropic/v1/messages', '/api/paas/v4/chat/completions', '/api/v1/responses'])
    await assert.rejects(guarded(origin + wrong, init(payload)), { code: 'SYNTHETIC_ENDPOINT_DENIED' });
  for (const wrong of [{ ...payload, model: 'other-model' }, { ...payload, stream_options: { include_usage: false } }, { ...payload, max_tokens: 8193 }])
    await assert.rejects(guarded(url, init(wrong)));
  assert.equal(sent, 0);
});
test('wire SSE and provider totals survive guarded delivery; unknown usage halts remaining requests', async () => {
  const ledger = budget(), rows = []; let sent = 0;
  const guarded = createSyntheticCalibrationFetch({ budget: ledger, origin, protocol: 'openai-completions', getApprovedPayload: () => payload,
    onRecord: row => rows.push(row), fetchImpl: async (_input, options) => { assert.equal(options.redirect, 'manual'); sent++; return new Response(sent === 1 ? sse : finish); } });
  assert.equal(await (await guarded(url, init(payload))).text(), sse);
  assert.equal(rows[0].reportedUsage.cached_tokens, null); assert.equal(ledger.snapshot().committedInputTokens, 20);
  await assert.rejects(guarded(url, init(payload)), { code: 'BUDGET_USAGE_UNKNOWN' });
  await assert.rejects(guarded(url, init(payload)), { code: 'BUDGET_USAGE_UNKNOWN' });
  assert.equal(sent, 2); assert.equal(ledger.snapshot().requests, 2);
});

for (const status of [200, 500]) test(`installed serializer and guarded fetch preserve protocol and maxRetries=0 with controlled HTTP ${status}`, {
  skip: !process.env.RC_OPENCLAW_HOST_ROOT,
}, async () => {
  const sdk = new URL(`file://${process.env.RC_OPENCLAW_HOST_ROOT}/node_modules/@openclaw/ai/dist/openai-completions-B9QLIq2U.mjs`).href;
  const guardSource = new URL('../scripts/helpers/provider-request-budget.mjs', import.meta.url).href;
  const fetchSource = new URL('../scripts/helpers/synthetic-calibration-fetch.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';import net from 'node:net';
    import {createProviderRequestBudget}from${JSON.stringify(guardSource)};import{createSyntheticCalibrationFetch}from${JSON.stringify(fetchSource)};
    let entries=0,sends=0,approved,fetch;net.Socket.prototype.connect=function(){throw new Error('OFFLINE_SOCKET_FORBIDDEN')};
    globalThis.fetch=(...args)=>{entries++;return fetch(...args)};
    const {r:stream}=await import(${JSON.stringify(sdk)});
    // Cold SDK loading is fixture setup, outside the unchanged request deadline.
    const budget=createProviderRequestBudget({origin:${JSON.stringify(origin)},limits:{usd:1,requests:2,wallMs:2000,inputPerRequest:32768,outputPerRequest:8192,totalInput:65536,totalOutput:16384},prices:{input:7,output:22,cacheRead:7,cacheWrite:7}});
    fetch=createSyntheticCalibrationFetch({budget,origin:${JSON.stringify(origin)},protocol:'openai-completions',getApprovedPayload:()=>approved,
      fetchImpl:async()=>{sends++;return new Response(${JSON.stringify(status === 200 ? sse : '{"error":{"message":"fictional transport failure"}}')},{status:${status},headers:{'content-type':${JSON.stringify(status === 200 ? 'text/event-stream' : 'application/json')}}})}});
    const model={id:'glm-5.3',name:'synthetic',provider:'review',api:'openai-completions',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:7,output:22,cacheRead:7,cacheWrite:7},compat:{supportsUsageInStreaming:true,maxTokensField:'max_tokens',supportsStore:false,supportsDeveloperRole:false}};
    const result=await stream(model,{messages:[{role:'user',content:[{type:'text',text:'new fictional input'}],timestamp:1}]},{apiKey:'synthetic-not-real',maxTokens:8192,maxRetries:0,onPayload:p=>{approved=p}}).result();
    assert.equal(entries,1);assert.equal(sends,1);assert.equal(approved.stream_options.include_usage,true);assert.equal(approved.max_tokens,8192);
    assert.equal(result.stopReason,${JSON.stringify(status === 200 ? 'stop' : 'error')});console.log(JSON.stringify({entries,sends,stopReason:result.stopReason,halted:budget.snapshot().halted}));`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(JSON.parse(result.stdout.trim()).entries, 1);
});
