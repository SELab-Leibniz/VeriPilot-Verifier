// Scripted provider: these check SDK recovery and collection, not model accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '../../lib/review-task/sdk.mjs';
import { createAssistantMessageEventStream } from '../../lib/review-task/sdk.mjs';
import { runReviewTask, contextPolicy, contextSafetyEstimate } from '../../lib/review-task/review-task.mjs';

async function harness(t, choose, { largeHistory = false, setup, task, summarize, contextWindow = 204800, modelMaxTokens = 8192 } = {}) {
  // The Windows sandbox's redirected OS temp denies atomic rename. Keep isolated,
  // inspectable test artifacts beneath the repository's ignored test-output directory.
  const testRoot = fileURLToPath(new URL('../../.runtime-correction/review-task-test-runs/sdk/', import.meta.url));
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'run-'));
  t.diagnostic(`artifacts: ${directory}`);
  const root = path.join(directory, 'source'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'basis.md'), 'Check before save.');
  await fs.writeFile(path.join(root, 'app.py'), 'save()\ncheck()');
  if (largeHistory) await fs.writeFile(path.join(root, 'history.md'), Array.from({ length: 120 }, (_, n) => `${n}: ${'x'.repeat(1000)}`).join('\n'));
  await setup?.({ root, directory });
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  let calls = 0, summaries = 0;
  const contexts = [], requests = [];
  runtime.registerProvider('scripted', { api: 'openai-completions', apiKey: 'offline-placeholder', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'scripted', name: 'scripted', input: ['text'], reasoning: false, contextWindow, maxTokens: modelMaxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      // Pi passes normalized TranscriptContext: the leading system message owns
      // the prompt (Context.systemPrompt has already been folded into messages).
      const isSummary = context.messages[0]?.role === 'system'
        && typeof context.messages[0].content === 'string'
        && context.messages[0].content.startsWith('You are a context summarization assistant.');
      if (isSummary) summaries++; else calls++;
      contexts.push(structuredClone(context));
      requests.push({ isSummary, maxTokens: options?.maxTokens ?? null, modelMaxTokens: model.maxTokens,
        contextWindow: model.contextWindow, sessionId: options?.sessionId });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        let response;
        try { response = isSummary ? (summarize ? await summarize({ context, root, directory }) : { content: [{ type: 'text', text: '## Goal\nReview R04.\n## Progress\nBasis and app.py read. No decision saved.\n## Next Steps\nSubmit the source-backed deviation.\n'+context.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n').replace(/\\+"/gu, '"').match(/\[citeId="[a-f0-9-]+" \| range [^\]]+\]/gu)?.join(' ')  }], stopReason: 'stop' }) : await choose(calls, { context, root, directory }); }
        catch (error) { response = { stopReason: 'error', errorMessage: error.message }; }
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: response.content ?? [], stopReason: response.stopReason ?? 'toolUse', errorMessage: response.errorMessage,
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
        stream.push({ type: 'start', partial: message });
        stream.push(message.stopReason === 'error' ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  return { root, directory, contexts, requests, run: (options = {}) => runReviewTask({ task: task ?? { id: 'R04', requirement: 'Check before save.', basisFiles: ['basis.md'], targetFiles: ['app.py'] },
    root, outputDir: path.join(directory, 'review'), modelRuntime: runtime, model: runtime.getModel('scripted', 'scripted'), ...options }), counts: () => ({ calls, summaries }) };
}
const call = (name, args) => ({ content: [{ type: 'toolCall', id: `call-${crypto.randomUUID()}`, name, arguments: args }] });
const verdict = context => ({ taskId: 'R04', verdict: 'DEVIATION', reason: 'State is saved before validation, so invalid state can persist.', citeIds: citationIds(context, 'app.py').slice(-1) });
function citationIds(context, file) {
  return [...JSON.stringify(context.messages).replace(/\\+"/gu, '"').matchAll(/\[citeId="([a-f0-9-]+)" \| range ([^:]+):/gu)].filter(match => !file || match[2] === file).map(match => match[1]);
}
const done = { content: [{ type: 'text', text: 'No comments.' }], stopReason: 'stop' };

// Frozen from commit 73390e0's six system paragraphs, before prompt injection.
// Runtime tests do not require Git or the historical checkout to verify it.
const ORIGINAL_SYSTEM_SHA256 = 'd7e8379fd3977e5307cf6a464b303c8b6270e940bd6d0e0a05a64d94370fa695';
const systemHash = value => createHash('sha256').update(value).digest('hex');
async function savedPrompt(h) {
  const prompt = await fs.readFile(path.join(h.directory, 'review/prompt.txt'), 'utf8');
  const split = prompt.indexOf('\n\n{"task":');
  assert.ok(split >= 0);
  return { system: prompt.slice(0, split), user: prompt.slice(split + 2) };
}

test('omitted and empty promptAppend preserve the original system prompt bytes', async t => {
  for (const options of [{}, { promptAppend: '' }]) {
    const h = await harness(t, () => done);
    await h.run({ maxAttempts: 1, ...options });
    const prompt = await savedPrompt(h);
    assert.equal(Buffer.byteLength(prompt.system), 1894);
    assert.equal(systemHash(prompt.system), ORIGINAL_SYSTEM_SHA256);
    assert.equal(h.contexts[0].messages[0].sections.preamble, prompt.system, 'the same preamble bytes reach the provider');
  }
});

test('promptAppend changes only system guidance while task tools and limits stay fixed', async t => {
  const baseline = await harness(t, () => done), candidate = await harness(t, () => done);
  const suffix = 'Metric scope: inspect the assigned acceptance coverage; preserve every original condition.';
  const oldResult = await baseline.run({ maxAttempts: 1 });
  const newResult = await candidate.run({ maxAttempts: 1, promptAppend: suffix });
  const oldPrompt = await savedPrompt(baseline), newPrompt = await savedPrompt(candidate);
  assert.equal(systemHash(oldPrompt.system), ORIGINAL_SYSTEM_SHA256);
  assert.equal(newPrompt.system, oldPrompt.system + '\n' + suffix);
  assert.equal(newPrompt.user, oldPrompt.user);
  assert.equal(candidate.contexts[0].messages[0].sections.preamble, newPrompt.system);
  assert.deepEqual(candidate.contexts[0].messages[0].toolsAdded, baseline.contexts[0].messages[0].toolsAdded);
  const taskMessages = h => h.contexts[0].messages.filter(message => message.role !== 'system')
    .map(({ timestamp, ...message }) => message);
  assert.deepEqual(taskMessages(candidate), taskMessages(baseline));
  assert.deepEqual(newResult.limits, oldResult.limits);
  const oldInput = JSON.parse(await fs.readFile(path.join(baseline.directory, 'review/input.json'), 'utf8'));
  const newInput = JSON.parse(await fs.readFile(path.join(candidate.directory, 'review/input.json'), 'utf8'));
  assert.deepEqual(newInput, oldInput, 'guidance does not alter task, files, model, budget or compaction policy');
  assert.deepEqual(candidate.requests.map(({ sessionId, ...request }) => request), baseline.requests.map(({ sessionId, ...request }) => request));
});

test('non-string promptAppend is rejected before creating a review or making a provider call', async t => {
  const h = await harness(t, () => done);
  for (const promptAppend of [null, 7, {}, [], () => 'guidance'])
    await assert.rejects(h.run({ promptAppend }), /promptAppend must be a trusted caller-supplied string/u);
  assert.equal(h.counts().calls, 0);
  await assert.rejects(fs.access(path.join(h.directory, 'review')));
});

test('a valid tool submission is durable before the native session is closed', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : call('submit_review', verdict(context)));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result)); assert.equal(result.verdict, 'DEVIATION');
  assert.equal(h.counts().calls, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.directory, 'review/decision.json'), 'utf8')).verdict, 'DEVIATION');
});

test('one native SDK session saves multiple independent members and continues after the first receipt', async t => {
  const members = ['R1', 'R2'].map(id => ({ id, requirement: `Original independent obligation ${id}`, basisFiles: ['basis.md'], targetFiles: ['app.py'] }));
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' })
    : n === 2 ? call('source_read', { path: 'app.py' })
      : call('submit_review', { ...verdict(context), taskId: n === 3 ? 'R2' : 'R1', verdict: n === 3 ? 'PASS' : 'DEVIATION' }));
  const receipts = [];
  const result = await h.run({ tasks: members, onItemResult: async item => { receipts.push(item.taskId); return { itemId: item.taskId, persisted: true }; } });
  assert.deepEqual(receipts, ['R2', 'R1']);
  assert.equal(result.completed, true);
  assert.equal(result.items.length, 2);
  assert.equal(Object.hasOwn(result, 'verdict'), false, 'Group completion must not masquerade as an individual PASS');
  assert.equal(h.counts().calls, 4);
  assert.equal(new Set(h.requests.map(request => request.sessionId)).size, 1);
  assert.equal(result.items.find(item => item.taskId === 'R1').verdict, 'DEVIATION');
  assert.equal(result.items.find(item => item.taskId === 'R2').verdict, 'PASS');
});

test('native SDK group failure after a receipt retains the saved member without claiming group completion', async t => {
  const members = ['R1', 'R2'].map(id => ({ id, requirement: `Original independent obligation ${id}`, basisFiles: ['basis.md'], targetFiles: ['app.py'] }));
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' })
    : n === 2 ? call('source_read', { path: 'app.py' }) : n === 3 ? call('submit_review', { ...verdict(context), taskId: 'R1' })
      : { stopReason: 'error', errorMessage: 'Controlled provider failure after the first item' });
  const receipts = [];
  const result = await h.run({ tasks: members, onItemResult: async item => { receipts.push(item.taskId); return { itemId: item.taskId }; } });
  assert.equal(result.completed, false);
  assert.deepEqual(receipts, ['R1']);
  assert.deepEqual(result.items.map(item => item.taskId), ['R1']);
  assert.equal(result.items[0].verdict, 'DEVIATION');
});
test('missing submission stops after the finite attempt count and stays UNVERIFIED', async t => {
  const h = await harness(t, () => ({ content: [{ type: 'text', text: 'No comments.' }], stopReason: 'stop' }));
  const result = await h.run();
  assert.equal(result.completed, false); assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.attempts, 2); assert.equal(h.counts().calls, 2, JSON.stringify(result));
});
test('an endless native tool loop stops at the explicit turn safety bound', async t => {
  const h = await harness(t, () => call('source_read', { path: 'basis.md' }));
  const result = await h.run({ maxTurns: 3 });
  assert.equal(result.completed, false); assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.reason, 'TURN_LIMIT'); assert.equal(h.counts().calls, 3);
  assert.deepEqual(result.limits, { maxAttempts: 2, maxTurns: 3, tokenBudget: null, deadline: null });
});
test('the native SDK preserves a submitted decision when post-save tool handling throws', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : call('submit_review', verdict(context)));
  const result = await h.run({ onEvent(event) { if (event.type === 'decision_saved') throw new Error('Injected post-save agent failure'); } });
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.verdict, 'DEVIATION');
  assert.equal(h.counts().calls, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.directory, 'review/decision.json'), 'utf8')).verdict, 'DEVIATION');
  await assert.rejects(fs.access(path.join(h.directory, 'review/decision.json.tmp')));
});
test('a native truncated basis cannot be submitted as PASS or DEVIATION', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' })
    : n === 3 ? call('submit_review', { ...verdict(context), verdict: 'PASS' }) : n === 4 ? call('submit_review', verdict(context)) : done,
  { setup: ({ root }) => fs.writeFile(path.join(root, 'basis.md'), Array.from({ length: 80 }, () => 'condition '.repeat(150)).join('\n')) });
  const result = await h.run();
  assert.equal(result.completed, false); assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.attempts, 2);
  assert.match(JSON.stringify(h.contexts), /Required basis not fully read/u);
  const reads = JSON.parse(await fs.readFile(path.join(h.directory, 'review/reads.json'), 'utf8'));
  assert.ok(reads.find(read => read.path === 'basis.md').end < 80);
  await assert.rejects(fs.access(path.join(h.directory, 'review/decision.json')));
});
test('a native overlong first line is never recorded as read', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' })
    : n === 3 ? call('submit_review', verdict(context)) : done,
  { setup: ({ root }) => fs.writeFile(path.join(root, 'basis.md'), 'x'.repeat(60000) + '\nException') });
  const result = await h.run();
  assert.equal(result.completed, false);
  const reads = JSON.parse(await fs.readFile(path.join(h.directory, 'review/reads.json'), 'utf8'));
  assert.equal(reads.some(read => read.path === 'basis.md'), false);
});
test('cancellation before the submission closes the task without a late decision', async t => {
  const controller = new AbortController();
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : (controller.abort(), call('submit_review', verdict(context))));
  const result = await h.run({ signal: controller.signal });
  assert.equal(result.completed, false); assert.equal(result.verdict, 'UNVERIFIED');
  await assert.rejects(fs.access(path.join(h.directory, 'review/decision.json')));
});
test('cancellation after atomic submission preserves the already saved decision', async t => {
  const controller = new AbortController();
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : call('submit_review', verdict(context)));
  const result = await h.run({ signal: controller.signal, onEvent(event) { if (event.type === 'decision_saved') controller.abort(); } });
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.verdict, 'DEVIATION');
});
test('a post-save source change invalidates and removes the current decision artifact', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : call('submit_review', verdict(context)));
  const result = await h.run({ onEvent(event) { if (event.type === 'decision_saved') writeFileSync(path.join(h.root, 'app.py'), 'changed-after-save()'); } });
  assert.equal(result.completed, false); assert.equal(result.conclusive, false);
  assert.equal(result.verdict, 'UNVERIFIED'); assert.match(result.reason, /STALE/u);
  await assert.rejects(fs.access(path.join(h.directory, 'review/decision.json')));
  assert.equal(JSON.parse(await fs.readFile(path.join(h.directory, 'review/invalidated-decision.json'), 'utf8')).verdict, 'DEVIATION');
  assert.match(await fs.readFile(path.join(h.directory, 'review/invalidated.json'), 'utf8'), /STALE/u);
});
test('tools disclose the fixed copy while changed original source prevents submission', async t => {
  const h = await harness(t, async (n, { root, context }) => {
    if (n === 1) return call('source_read', { path: 'basis.md' });
    if (n === 2) { await fs.writeFile(path.join(root, 'app.py'), 'new-source-secret()'); return call('source_read', { path: 'app.py' }); }
    if (n === 3) {
      const appRead = context.messages.find(message => message.role === 'toolResult' && message.toolName === 'source_read' && message.content[0]?.text.endsWith('save()\ncheck()'));
      assert.ok(appRead, 'source_read must disclose the original fixed snapshot');
      return call('submit_review', verdict(context));
    }
    return done;
  });
  const result = await h.run();
  assert.equal(result.completed, false); assert.match(JSON.stringify(h.contexts), /STALE: input snapshot changed/u);
  await assert.rejects(fs.access(path.join(h.directory, 'review/decision.json')));
});
test('native grep/find expose only captured files and absolute outside reads are rejected', async t => {
  const h = await harness(t, (n, { directory }) => n === 1 ? call('source_grep', { pattern: 'OUTSIDESECRET', path: '.' })
    : n === 2 ? call('source_find', { pattern: '*', path: '.' }) : n === 3 ? call('source_read', { path: path.join(directory, 'secret.txt') }) : done,
  { setup: async ({ root, directory }) => {
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules/secret.txt'), 'OUTSIDESECRET');
    await fs.writeFile(path.join(directory, 'secret.txt'), 'OUTSIDESECRET');
  } });
  const result = await h.run();
  assert.equal(result.completed, false);
  const toolResults = h.contexts.flatMap(context => context.messages.filter(message => message.role === 'toolResult'));
  const navigation = toolResults.filter(message => ['source_grep', 'source_find'].includes(message.toolName));
  assert.equal(navigation.length > 0, true);
  assert.equal(navigation.some(message => message.isError), false, JSON.stringify(navigation));
  assert.doesNotMatch(JSON.stringify(navigation), /secret\.txt|OUTSIDESECRET/u);
  assert.match(JSON.stringify(toolResults), /outside snapshot is forbidden/u);
});
test('native loader disables discovered resources and enables only the explicit memory extension', async t => {
  const h = await harness(t, () => done, { setup: async ({ root }) => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'HOSTILE_CONTEXT_SENTINEL');
    await fs.mkdir(path.join(root, '.pi/extensions'), { recursive: true });
    await fs.writeFile(path.join(root, '.pi/extensions/hostile.js'), 'throw new Error("HOSTILE_EXTENSION_SENTINEL");');
    await fs.mkdir(path.join(root, '.pi/skills/hostile'), { recursive: true });
    await fs.writeFile(path.join(root, '.pi/skills/hostile/SKILL.md'), '---\nname: hostile\ndescription: HOSTILE_SKILL_SENTINEL\n---\nHOSTILE_SKILL_SENTINEL');
  } });
  await h.run();
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const resources = events.find(event => event.type === 'resources');
  for (const field of ['contextFiles', 'skills', 'prompts', 'themes']) assert.equal(resources[field], 0, field);
  assert.equal(resources.extensions, 1);
  const allowed = ['source_read', 'source_grep', 'source_find', 'source_ls', 'review_history', 'submit_review'].sort();
  assert.deepEqual(resources.activeTools.sort(), allowed);
  assert.deepEqual(resources.callableTools.sort(), allowed);
  assert.doesNotMatch(JSON.stringify(h.contexts), /HOSTILE_(CONTEXT|EXTENSION|SKILL)_SENTINEL/u);
});
test('native Pi compaction recovers from an injected provider context overflow', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'basis.md' }) : n === 2 ? call('source_read', { path: 'app.py' }) : n <= 5
    ? call('source_read', { path: 'history.md', offset: 1 + (n - 3) * 40, limit: 40 }) : n === 6
      ? { stopReason: 'error', errorMessage: 'maximum context length is 204800 tokens; input is too long' } : call('submit_review', verdict(context)), { largeHistory: true });
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result)); assert.equal(result.verdict, 'DEVIATION');
  assert.ok(result.metrics.compactions >= 1, JSON.stringify({ result, counts: h.counts(), events: await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8') })); assert.ok(h.counts().summaries >= 1);
  assert.equal(result.attempts, 1);
  const evidence = JSON.parse(await fs.readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.citations[0].text, 'save()\ncheck()', 'compaction cannot replace the original source excerpt');
});

const batch = (...calls) => ({ content: calls.flatMap(item => item.content) });
test('independent source reads can share one native tool batch', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', verdict(context)));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(h.counts().calls, 2);
  const evidence = JSON.parse(await fs.readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.citations[0].text, 'save()\ncheck()');
});

test('submission mixed with a new basis read is rejected until a later assistant response', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'app.py' })
    : n === 2 ? batch(call('source_read', { path: 'basis.md' }), call('submit_review', verdict(context)))
      : call('submit_review', verdict(context)));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(h.counts().calls, 3);
  assert.match(JSON.stringify(h.contexts), /Submit in a separate assistant response/u);
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.findIndex(event => event.type === 'tool' && event.args.path === 'basis.md') < events.findIndex(event => event.type === 'decision_saved'));
  assert.equal(events.filter(event => event.type === 'assistant').length,3);
});

test('citation markers are visible in native content and excerpts preserve BOM CRLF CJK emoji bytes', async t => {
  const text = '\uFEFF先保存😀\r\n后检查🌷\r\n';
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py', offset: 1, limit: 2 }))
    : call('submit_review', verdict(context)), { setup: ({ root }) => fs.writeFile(path.join(root, 'app.py'), text) });
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  const evidence = JSON.parse(await fs.readFile(result.evidencePath, 'utf8')), citation = evidence.citations[0];
  const bytes = await fs.readFile(path.join(h.directory, 'review/frozen-source/app.py'));
  assert.equal(citation.text, text.slice(0,-1));
  assert.deepEqual(Buffer.from(citation.text), bytes.subarray(citation.byteStart,citation.byteEnd));
  const toolResult = h.contexts[1].messages.find(message => message.role === 'toolResult' && message.toolName === 'source_read' && message.content[0].text.includes('range app.py:'));
  assert.match(toolResult.content[0].text, /^\[citeId="[a-f0-9-]{36}" \| range /u);
  assert.equal(citation.rangeKind, 'range');
});

test('basis anchors come from the task rather than model-selected lines', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', verdict(context)), { task: { id: 'R04', requirement: 'Check before save.', scope: 'SOURCE_IMPLEMENTATION',
      basisFiles: ['basis.md'], targetFiles: ['app.py'], basisAnchors: [{ claimId: 'R04', path: 'basis.md', start: 1, end: 1 }] } });
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.scope, 'SOURCE_IMPLEMENTATION');
  const evidence = JSON.parse(await fs.readFile(result.evidencePath, 'utf8'));
  assert.deepEqual(evidence.basisAnchors.map(({ claimId, path, text }) => ({ claimId, path, text })), [{ claimId:'R04', path:'basis.md', text:'Check before save.' }]);
});

test('an overlong diagnosis is saved completely and feedback only points to its file', async t => {
  const reason = '原因为保存先于校验，导致无效状态已经持久化。'.repeat(100);
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', { ...verdict(context), reason }));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(JSON.parse(await fs.readFile(path.join(h.directory, 'review/decision.json'), 'utf8')).reason, reason);
  const feedback = await fs.readFile(path.join(h.directory, 'review/feedback.txt'), 'utf8');
  assert.match(feedback, /Diagnosis exceeds the inline limit/u);
  assert.doesNotMatch(feedback, /原因为保存先于校验/u);
});

test('grep bytes and all native tool bytes are counted separately from source reads', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }), call('source_grep', { path:'.', pattern:'save' }))
    : call('submit_review', verdict(context)));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.ok(result.metrics.grepBytes > 0);
  assert.ok(result.metrics.totalToolBytes > result.metrics.readBytes + result.metrics.grepBytes);
  assert.equal(result.metrics.toolCalls, 4);
});

test('the truncated read cite never includes undisclosed tail bytes', async t => {
  const text = Array.from({ length: 2200 }, (_, n) => `line ${n}`).join('\n');
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', verdict(context)), { setup: ({ root }) => fs.writeFile(path.join(root,'app.py'), text) });
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  const evidence = JSON.parse(await fs.readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.citations[0].end, 2000);
  assert.equal(evidence.citations[0].text, text.split('\n').slice(0,2000).join('\n'));
  assert.doesNotMatch(evidence.citations[0].text, /line 2000/u);
});

test('a read whose wrapper fails before native delivery cannot satisfy the mandatory basis', async t => {
  const h = await harness(t, (n, { context }) => n === 1 ? call('source_read', { path: 'app.py' })
    : n === 2 ? call('source_read', { path: 'basis.md' }) : n === 3 ? call('submit_review', verdict(context)) : done);
  const result = await h.run({ onEvent(event) {
    if (event.type === 'tool' && event.args.path === 'basis.md') throw new Error('Injected failure before native tool delivery');
  } });
  assert.equal(result.completed, false, JSON.stringify(result));
  assert.equal(result.verdict, 'UNVERIFIED');
  const reads = JSON.parse(await fs.readFile(path.join(h.directory,'review/reads.json'),'utf8'));
  assert.equal(reads.some(read => read.path === 'basis.md'), false);
  assert.match(JSON.stringify(h.contexts), /Required basis not fully read/u);
});

const seededObservations = () => Array.from({ length: 24 }, (_, index) => ({ kind: 'tool_observation', sourceId: `old-${index}`,
  text: `${index === 0 ? 'public observation\n' + 'p'.repeat(3000) + '\nARCHIVED_WITNESS: validation must precede save.\n' : ''}${'old-observation '.repeat(1850)}` }));

test('policy uses the original window and reserves earlier compaction space', () => {
  assert.deepEqual(contextPolicy({ contextWindow: 204800 }), { enabled: true, reserveTokens: 61440, keepRecentTokens: 20000 });
  assert.throws(() => contextPolicy({ contextWindow: 0 }), /known context window/u);
});

test('a directly seeded long stage compacts before the first main request and retrieves omitted old evidence', async t => {
  const h = await harness(t, (n, { context }) => {
    if (n === 1) {
      assert.ok(h.counts().summaries > 0, 'native threshold compaction must happen before the first main request');
      assert.doesNotMatch(JSON.stringify(context), /ARCHIVED_WITNESS/u, 'the summary deliberately did not preserve the witness');
      return call('review_history', { mode: 'search', query: 'ARCHIVED_WITNESS' });
    }
    if (n === 2) {
      const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'review_history');
      const found = JSON.parse(message.content[0].text).matches[0];
      assert.equal(found.sourceEntryId, 'old-0');
      return call('review_history', { mode: 'read', entryId: found.entryId, offset: found.matchOffset, limit: 512 });
    }
    if (n === 3) {
      const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolName === 'review_history');
      assert.match(JSON.parse(message.content[0].text).text, /ARCHIVED_WITNESS: validation must precede save/u);
      return batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }));
    }
    return call('submit_review', verdict(context));
  }, { summarize: ({ context }) => {
    assert.doesNotMatch(JSON.stringify(context), /ARCHIVED_WITNESS/u, 'Pi summary serialization truncates old long tool bodies');
    return { content: [{ type:'text', text:'## Goal\nCheck R04 against originals.\n## Progress\nOld public observations archived.\n## Next\nUse review_history, then read authoritative basis and current source.' }], stopReason:'stop' };
  } });
  const result = await h.run({ initialHistory: seededObservations() });
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.verdict, 'DEVIATION'); assert.ok(result.metrics.compactions >= 1);
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const start = events.findIndex(event => event.type === 'compaction_start');
  assert.equal(events[start].reason, 'threshold');
  assert.ok(start < events.findIndex(event => event.type === 'assistant'));
  assert.equal(result.metrics.unsafeRequestsPrevented, 0);
  assert.ok((await fs.stat(path.join(h.directory, 'review/review-checkpoint.json'))).size > 0);
});

test('large model output capacity is not mistaken for the compaction reserve after a successful summary', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', verdict(context)), { contextWindow: 204800, modelMaxTokens: 131072,
    summarize: () => ({ content: [{ type: 'text', text: '## Goal\nReview R04 against original basis and source.\n## Archived navigation\n' + '汉'.repeat(28000) }], stopReason: 'stop' }) });
  const result = await h.run({ initialHistory: seededObservations() });
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.verdict, 'DEVIATION');
  assert.ok(result.metrics.compactions >= 1);
  assert.equal(result.metrics.unsafeRequestsPrevented, 0);
  assert.equal(h.counts().calls, 2, 'the first main request must actually reach the provider after compaction');
  const main = h.requests.filter(request => !request.isSummary);
  const summaries = h.requests.filter(request => request.isSummary);
  assert.ok(summaries.length > 0);
  assert.ok(main.every(request => request.maxTokens === 8192 && request.modelMaxTokens === 131072 && request.contextWindow === 204800));
  assert.ok(summaries.every(request => request.maxTokens === null), 'native summary options are not capped by the main review option');
  assert.ok(summaries.every(request => request.sessionId !== main[0].sessionId), 'native summary routing identifies a separate request kind');
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const first = events.find(event => event.type === 'context_check');
  assert.equal(first.reserveTokens, 61440);
  assert.equal(first.outputReserve, 8192);
  assert.ok(first.estimatedTokens + first.reserveTokens >= first.contextWindow, 'this projection reproduces the former false rejection');
  assert.ok(first.estimatedTokens + first.outputReserve < first.contextWindow);
  assert.equal(events.find(event => event.type === 'request_options' && event.requestKind === 'review').maxTokens, first.outputReserve);
  assert.equal(events.find(event => event.type === 'request_options' && event.requestKind === 'native_summary').maxTokens, null);
});

test('a requested per-reply generation limit and the health guard share the model-clamped option', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path: 'basis.md' }), call('source_read', { path: 'app.py' }))
    : call('submit_review', verdict(context)), { modelMaxTokens: 1024 });
  const result = await h.run({ maxTokens: 2048 });
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.ok(h.requests.every(request => request.maxTokens === 1024));
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.filter(event => event.type === 'context_check').every(event => event.outputReserve === 1024));
  await assert.rejects(h.run({ maxTokens: 0 }), /maxTokens must be a positive integer/u);
});

test('summary failure prevents the next main provider request and preserves a recoverable checkpoint', async t => {
  const h = await harness(t, () => done, { summarize: () => { throw new Error('Invalid summary response schema'); } });
  const result = await h.run({ initialHistory: seededObservations() });
  assert.equal(result.completed, false); assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(h.counts().calls, 0, 'no unsafe unchanged main context may reach the provider');
  assert.ok(result.metrics.compactionFailures >= 1);
  assert.ok(result.metrics.unsafeRequestsPrevented >= 1);
  assert.match(result.reason, /CONTEXT_COMPACTION_FAILED/u);
  assert.ok((await fs.stat(path.join(h.directory, 'review/history-index.json'))).size > 0);
});

test('one oversized parallel batch is compacted or safely stopped before an unsafe main request', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path:'basis.md' }), call('source_read', { path:'app.py' }), ...['a','b','c'].map(name => call('source_read', { path:`${name}.txt` })))
    : call('submit_review', verdict(context)), { contextWindow: 32768,
    setup: async ({ root }) => { for (const name of ['a','b','c']) await fs.writeFile(path.join(root,`${name}.txt`), 'archived payload\n' + 'x'.repeat(44000)); } });
  const result = await h.run();
  assert.ok(result.metrics.compactions >= 1);
  if (result.completed) assert.equal(h.counts().calls, 2);
  else {
    assert.equal(result.verdict, 'UNVERIFIED');
    assert.match(result.reason, /CONTEXT_UNSAFE/u);
    assert.equal(h.counts().calls, 1);
    assert.equal(result.metrics.unsafeRequestsPrevented, 1);
  }
});

test('history lookup and submission cannot share a decision batch', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path:'basis.md' }), call('source_read', { path:'app.py' }))
    : n === 2 ? batch(call('review_history', { mode:'state' }), call('submit_review', verdict(context)))
      : call('submit_review', verdict(context)));
  const result = await h.run();
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.match(JSON.stringify(h.contexts), /Submit in a separate assistant response/u);
  assert.equal(h.counts().calls, 3);
});

test('CJK tool batches that appear small under chars/4 are stopped before another main provider call', async t => {
  const h = await harness(t, (n, { context }) => n === 1
    ? batch(call('source_read', { path:'basis.md' }), call('source_read', { path:'app.py' }), ...['a','b','c'].map(name => call('source_read', { path:`${name}.txt` })))
    : call('submit_review', verdict(context)), { contextWindow: 32768,
    setup: async ({ root }) => { for (const name of ['a','b','c']) await fs.writeFile(path.join(root,`${name}.txt`), '汉'.repeat(4200)); } });
  const result = await h.run();
  assert.equal(result.verdict, 'UNVERIFIED'); assert.equal(result.completed, false);
  assert.match(result.reason, /CONTEXT_UNSAFE/u);
  assert.equal(h.counts().calls, 1, 'the second main provider call must not be sent');
  assert.equal(result.metrics.compactions, 0, 'native chars/4 never reached its compaction threshold');
  const events = (await fs.readFile(path.join(h.directory, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const last = events.findLast(event => event.type === 'context_check');
  assert.ok(last.piEstimate + last.outputReserve < last.contextWindow);
  assert.ok(last.byteMargin + last.outputReserve >= last.contextWindow);
  assert.equal(last.providerPrefixTokens, 110);
  assert.equal(last.exactTokenizer, false);
});

test('unknown usage after compaction never anchors the old provider prefix', () => {
  const messages = [{ role:'assistant', stopReason:'stop', content:[{type:'text',text:'old response'}],
    usage:{input:190000,output:100,cacheRead:0,cacheWrite:0} }, {role:'user',content:[{type:'text',text:'new small projection'}]}];
  const unknown = contextSafetyEstimate(messages, false);
  assert.equal(unknown.providerPrefixTokens, null);
  assert.ok(unknown.estimatedTokens < 10000);
  assert.equal(contextSafetyEstimate(messages, true).providerPrefixTokens, 190100);
});
