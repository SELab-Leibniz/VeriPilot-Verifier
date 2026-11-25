import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readOpenClawTranscript } from '../../lib/openclaw/transcript.mjs';
import { loadStopOriginalRequirements } from '../../lib/runtime-v2/production-stop.mjs';
import { loadReviewCheckpoint } from '../../lib/review-task/history-memory.mjs';
import { chineseText, denseText } from './large-context-fixtures.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const markers = ['SDD-OPEN-K12', 'SDD-MIDDLE-F07', 'SDD-SEAL-R93'];
const releaseRule = '密封模式遇到验收失败时，重试上限为零。';
const candidate = 'src/initial-sdd-release.mjs';
const rcScope = { stopClassification: 'TASK_COMPLETE', completionClaim: true };
const messageText = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(block => block.text ?? '').join('');

function specification(rows, format) {
  const series = format === 'dense' ? denseText : chineseText;
  return [
    '# 版本化交付工作流的软件设计规范', '按整份 SDD 交付提案、实施、验证和归档。此消息给出完整规范。',
    '## 适用范围', markers[0] + ' 常规流程保留原有重试次数。实现入口为 ' + candidate + '。',
    '## 提案与实施记录', series(Math.ceil(rows / 2), 3),
    '## 变更后的验证', markers[1] + ' 审批记录须绑定本次提交的修订号，归档时再次核对。',
    '## 验收条件和记录附录', series(Math.floor(rows / 2), 8),
    '## 末尾补充条款', markers[2] + ' ' + releaseRule,
  ].join('\n');
}

// Choose the nearest complete row. The three original markers stay intact.
async function calibrated(target, unit, format, countRaw) {
  async function measure(rows) {
    const text = specification(rows, format);
    const size = unit === 'tokens' ? await countRaw(text) : unit === 'bytes' ? Buffer.byteLength(text) : [...text].length;
    return { text, rows, size };
  }
  let lo = 2, hi = 512;
  while ((await measure(hi)).size < target) { lo = hi; hi *= 2; }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await measure(mid)).size < target) lo = mid;
    else hi = mid;
  }
  const options = [await measure(lo), await measure(hi)];
  const { text, rows } = options.sort((a, b) => Math.abs(a.size - target) - Math.abs(b.size - target))[0];
  const lines = text.split('\n');
  return { text, meta: { unit, target, format, rows, chars: [...text].length, utf8Bytes: Buffer.byteLength(text),
    rawTokens: await countRaw(text), sha256: sha(text), markerLines: markers.map(marker => lines.findIndex(line => line.includes(marker)) + 1) } };
}

function businessReply(calls, proof) {
  let sent = false;
  return payload => {
    if (!sent) {
      sent = true;
      return { calls: calls.map((args, index) => ({ name: 'read', id: 'initialread' + index, args })) };
    }
    const text = payload.messages.filter(message => message.role === 'tool').map(messageText).join('\n');
    assert(proof.every(fragment => text.includes(fragment)), 'Expected original lines in the native read results');
    return { text: '已读取本次验收所需的指定行。' };
  };
}

function reviewerReply(getTask, record) {
  let phase = 'early', pending = [], nextId = 0, queue;
  let tailSource, itemId;
  const send = calls => {
    pending = calls.map(call => ({ ...call, id: 'inlinebasis' + (++nextId) }));
    record.calls.push(...pending);
    return { calls: pending };
  };
  const read = (file, offset = 1, limit = 400) => ({ name: 'source_read', args: { path: file, offset, limit, numbered: true } });
  const submit = (name, args) => send([{ name, args }]);
  return async payload => {
    const task = getTask();
    if (!queue) {
      queue = task.basisFiles.map(file => read(file));
      const originals = task.basisFiles.filter(file => path.basename(file).startsWith('user-original-'));
      for (const file of originals) {
        const line = (await fs.readFile(file, 'utf8')).split('\n').findIndex(value => value.includes(markers[2]) && value.includes(releaseRule));
        if (line !== -1) tailSource = { path: file, lineStart: line + 1, lineEnd: line + 1 };
      }
      assert(tailSource, 'The terminal rule must have an exact fixture coordinate');
    }
    const results = new Map(payload.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, messageText(message)]));
    for (const call of pending) {
      const text = results.get(call.id);
      if (!text) continue;
      if (call.name === 'source_read') {
        const page = /\[RC page (\{[^\r\n]*\})\]/u.exec(text);
        const next = page && JSON.parse(page[1]).nextOffset;
        if (phase === 'read' && next != null) queue.unshift(read(call.args.path, next, call.args.limit));
      } else {
        let parsed;
        try { parsed = JSON.parse(text); } catch { /* host tool errors may be plain text */ }
        record.submissions.push({ name: call.name, saved: parsed?.saved, completed: parsed?.complete,
          ...(parsed?.classification ? { classification: parsed.classification.stopClassification } : {}),
          ...(!parsed || parsed.error ? { error: (typeof parsed?.error === 'string' ? parsed.error : text).slice(0, 500) } : {}) });
        if (call.name === 'review_checklist') itemId = parsed?.items?.[0]?.taskId;
      }
    }
    const items = [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
      text: releaseRule, ...tailSource }];
    if (phase === 'early') {
      phase = 'read';
      return submit('set_original_checklist', { items });
    }
    if (queue.length) return send(queue.splice(0, 3));
    if (phase === 'read') { phase = 'scope'; return submit('set_original_checklist', { items }); }
    if (phase === 'scope') { phase = 'source'; return submit('review_checklist', rcScope); }
    if (phase === 'source') {
      phase = 'verdict';
      return send([read(tailSource.path, tailSource.lineStart, 1), read(candidate, 1, 1)]);
    }
    if (phase === 'verdict') {
      const cited = pending.map(call => results.get(call.id) ?? '');
      assert(cited[0]?.includes(releaseRule) && cited[1]?.includes('return 3'), 'Original rule and candidate must both reach the decision request');
      phase = 'finish';
      return submit('submit_review', { taskId: itemId, verdict: 'DEVIATION', reason: '密封模式实际返回 3 次，超过末尾条款的零次上限。',
        citations: [{ path: candidate, start: 1, end: 1 }] });
    }
    if (phase === 'finish') { phase = 'done'; return submit('finish_stop_review', { summary: '已核实本用例预埋的重试上限偏差。' }); }
    return { text: '指定取证完成。' };
  };
}

function pressure(record) {
  const pre = record.pressureLog.filter(line => line.includes('pre-prompt check'));
  const number = (line, field) => Number(new RegExp('\\b' + field + '=(\\d+)').exec(line)?.[1] ?? NaN);
  return { estimate: pre.length ? number(pre[0], 'estimatedPromptTokens') : null,
    finalEstimate: pre.length ? number(pre.at(-1), 'estimatedPromptTokens') : null,
    finalReducibleChars: pre.length ? number(pre.at(-1), 'toolResultReducibleChars') : null,
    inputBudget: pre.length ? number(pre[0], 'promptBudgetBeforeReserve') : null,
    initialHistory: pre.length ? number(pre[0], 'messages') : null,
    initialReducibleChars: pre.length ? number(pre[0], 'toolResultReducibleChars') : null,
    compactionAttempts: record.pressureLog.filter(line => line.startsWith('[compaction-diag] start')).length,
    emptyCompactionSkips: record.pressureLog.filter(line => line.includes('no real conversation messages')).length,
    compactionBoundaries: record.hostCompactions.length };
}

async function businessSummary(record, doc, prompt) {
  const requests = [];
  for (const req of record.requests) {
    const file = path.join(record.directory, 'wire-' + String(req.sequence).padStart(3, '0') + '.json');
    const wire = JSON.parse(await fs.readFile(file, 'utf8'));
    const user = wire.messages.filter(row => row.role === 'user').map(messageText);
    const fullSddCopies = user.reduce((copies, text) => copies + text.split(doc.text).length - 1, 0);
    requests.push({ kind: req.kind, tokens: req.inputTokens, output: req.maxOutputTokens, userMessages: user.length, toolResults: req.toolResults.length,
      fullSddCopies, markersInUser: markers.map(value => user.some(text => text.includes(value))),
      response: req.response });
  }
  const entries = await readOpenClawTranscript(record.sessionFile).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
  const users = entries.filter(entry => entry.type === 'user' && !entry.isMeta);
  return { name: record.name, inputSha256: sha(prompt), transportRequests: requests.length, transportErrors: record.transportErrors ?? [],
    delivered: record.result.text?.includes('已读取本次验收所需的指定行。') ?? false,
    hostStatus: record.result.meta?.error?.kind ?? record.result.meta?.stopReason ?? record.result.code,
    promptOnlyWithTemplateTokens: record.before.tokens, ...pressure(record), requests,
    userMessagesInTranscript: users.length, fullInTranscript: users.some(entry => messageText(entry.message).includes(doc.text)),
    evidence: path.relative(path.dirname(record.directory), path.join(record.directory, 'evidence.json')).replaceAll('\\', '/') };
}

async function reviewSummary(record, document) {
  const files = record.basisFiles.filter(file => path.basename(file).startsWith('user-original-')).sort();
  const buffers = [];
  let fullParts = 0, coveredBytes = 0;
  for (const file of files) {
    const bytes = await fs.readFile(file);
    buffers.push(bytes);
    const count = bytes.toString('utf8').split('\n').length;
    const rows = record.reads.filter(row => row.path === file).sort((a, b) => a.start - b.start);
    let end = 0;
    for (const row of rows) { if (row.start > end + 1) break; end = Math.max(end, row.end); }
    if (end >= count) { fullParts++; coveredBytes += bytes.length; }
  }
  const ordinary = record.requests.filter(row => row.kind === 'prompt');
  const checkpoint = await loadReviewCheckpoint(path.join(record.reviewDirectory, 'review-checkpoint.json'));
  const summaryCalls = record.requests.filter(row => row.kind === 'compaction');
  const frequency = new Map();
  const receiptHashes = new Map(record.reads.map(row => [row.id, row.sha256]));
  const readReceiptsSeenOnWire = new Set();
  for (const req of ordinary) for (const tool of req.toolResults) {
    frequency.set(tool.id, 1 + (frequency.get(tool.id) ?? 0));
    if (receiptHashes.get(tool.id) === tool.sha256) readReceiptsSeenOnWire.add(tool.id);
  }
  const source = Buffer.concat(buffers);
  return { name: record.name, reviewCompleted: record.result.reviewCompleted ?? false,
    failure: record.result.code ?? record.result.collection?.failures?.[0]?.code ?? null,
    judgements: record.result.review?.metricObjectJudgements?.map(row => row.judgement) ?? [],
    inputSha256: sha(source), rawInlineIdentical: source.equals(Buffer.from(document.text)), sourceBytes: source.length,
    mandatoryOriginalParts: files.length, fullParts, coveredBytes, totalReadReceipts: record.reads.length,
    namedReferences: record.namedReferences, earlyGateBlocked: record.submissions.some(row => row.error?.includes('Required original basis not fully read')),
    checklistSaved: record.submissions.some(row => row.name === 'set_original_checklist' && row.saved),
    ordinaryRequests: ordinary.length, ordinaryPeak: Math.max(0, ...ordinary.map(row => row.inputTokens)),
    transportErrors: record.transportErrors ?? [], checkpointPendingBasisFiles: checkpoint.taskState.pendingCount,
    ordinaryInputTotal: ordinary.reduce((sum, req) => sum + req.inputTokens, 0),
    clippedToolResultIds: [...new Set(ordinary.flatMap(req => req.toolResults.filter(tool => tool.truncated).map(tool => tool.id)))],
    maxToolResultAppearances: Math.max(0, ...frequency.values()), readReceiptsSeenOnWire: readReceiptsSeenOnWire.size, summaryRequests: summaryCalls.length,
    summaryCalls: summaryCalls.map(req => ({ inputTokens: req.inputTokens, response: req.response })),
    rejectedOrdinary: ordinary.filter(req => req.response === 'fixture_context_overflow').map(req => ({ inputTokens: req.inputTokens, output: req.maxOutputTokens })),
    ...pressure(record), evidence: path.relative(path.dirname(record.directory), path.join(record.directory, 'evidence.json')).replaceAll('\\', '/') };
}

export async function runInitialSdd({ outputRoot, repo, count, model, modelWindow, business, review }) {
  const countRaw = async text => (await count({ model: model.business, rawText: text })).tokens;
  const documents = {};
  const fixtures = path.join(outputRoot, 'initial-sdd-originals');
  await fs.mkdir(fixtures);
  for (const [id, size, unit, format] of [
    ['zh', 164000, 'tokens', 'chinese'], ['machine', 164000, 'tokens', 'dense'],
    ['chars', 164000, 'chars', 'chinese'], ['kib', 164 * 1024, 'bytes', 'chinese'],
  ]) {
    documents[id] = await calibrated(size, unit, format, countRaw);
    await fs.writeFile(path.join(fixtures, id + '.md'), documents[id].text, 'utf8');
  }
  const src = path.join(repo, candidate);
  await fs.writeFile(src, 'export function retryLimit(mode) { return 3; }\n');
  const { retryLimit } = await import(pathToFileURL(src).href);
  assert.equal(retryLimit('sealed'), 3);
  const includedFile = 'contracts/initial-sdd-full.md';
  await fs.writeFile(path.join(repo, includedFile), documents.zh.text);
  const wide = { hostBudget: 400000, catalogWindow: 400000 };
  const study = { probeSha256: sha(await fs.readFile(new URL(import.meta.url))), definitions: { tokenTarget: 164000, testProviderWindow: modelWindow, policy: 'input plus requested output must fit for these cases' },
    documents: Object.fromEntries(Object.entries(documents).map(([id, doc]) => [id, doc.meta])), business: [], reviews: [], failures: [] };
  const resultFile = path.join(outputRoot, 'initial-sdd-study.json');
  let admittedTranscript;
  for (const [name, docId, output, overrides] of [
    ['initial-zh-regular', 'zh', 65536, {}], ['initial-zh-small-output', 'zh', 8192, {}],
    ['initial-zh-admit', 'zh', 8192, wide], ['initial-zh-output-control', 'zh', 65536, wide],
    ['initial-dense', 'machine', 8192, {}], ['initial-characters', 'chars', 8192, {}], ['initial-kib', 'kib', 8192, {}],
    ['initial-file', 'zh', 8192, {}],
  ]) {
    const doc = documents[docId], pointer = name === 'initial-file';
    const prompt = pointer ? '请按 ' + includedFile + ' 的完整版本核验本次工作流，先确认范围、变更验证和末尾例外。' : doc.text;
    const calls = pointer ? doc.meta.markerLines.map(offset => ({ path: includedFile, offset, limit: 1 }))
      : [{ path: candidate, offset: 1, limit: 1 }];
    const rec = await business({ name, initialPrompt: prompt, ...overrides, maxOutput: output, reserveOutput: true, providerWindow: modelWindow,
      reply: businessReply(calls, pointer ? markers : ['return 3']) });
    const result = await businessSummary(rec, doc, prompt);
    if (pointer) {
      const manifest = await loadStopOriginalRequirements({ projectRoot: repo,
        snapshot: { entries: await readOpenClawTranscript(rec.sessionFile) }, referenceTier: true });
      const named = manifest.referencedFiles.find(file => file.path === includedFile);
      result.namedBasis = named ? { sha256: named.sha256, bytes: named.bytes, mandatory: named.mandatory !== false } : null;
    }
    if (name === 'initial-zh-admit' && result.delivered && result.fullInTranscript) admittedTranscript = rec.sessionFile;
    study.business.push(result);
    await writeJson(resultFile, study);
    console.log(JSON.stringify({ case: name, estimated: result.estimate, wire: result.requests.map(r => r.tokens), status: result.hostStatus }));
  }
  if (admittedTranscript) {
    const snapshot = { entries: await readOpenClawTranscript(admittedTranscript) };
    for (const [name, window] of [['initial-review-default', undefined], ['initial-review-wide', 400000]]) {
      const rec = await review({ name, snapshot, window, providerWindow: modelWindow, reserveOutput: true, maxOutput: 8192,
        deviationOnly: false, makeReply: reviewerReply });
      const result = await reviewSummary(rec, documents.zh);
      study.reviews.push(result);
      await writeJson(resultFile, study);
      console.log(JSON.stringify({ case: name, fullParts: result.fullParts, total: result.mandatoryOriginalParts, completed: result.reviewCompleted }));
    }
  }
  const check = (ok, message) => { if (!ok) study.failures.push(message); };
  for (const [id, doc] of Object.entries(study.documents)) {
    const actual = doc.unit === 'tokens' ? doc.rawTokens : doc.unit === 'bytes' ? doc.utf8Bytes : doc.chars;
    check(Math.abs(actual - doc.target) <= 150 && doc.markerLines.every(n => n > 0), id + ': fixture sizing and markers');
  }
  const by = Object.fromEntries(study.business.map(v => [v.name, v]));
  const blocked = by['initial-zh-regular'];
  for (const row of [blocked, by['initial-zh-small-output']]) check(row.hostStatus === 'context_overflow' && row.transportRequests === 0
    && row.estimate > row.inputBudget && row.initialHistory === 0 && row.initialReducibleChars === 0
    && row.emptyCompactionSkips > 0 && row.compactionBoundaries === 0, row.name + ': initial precheck and empty history');
  const positive = by['initial-zh-admit'];
  check(positive.inputSha256 === blocked.inputSha256 && positive.delivered && positive.fullInTranscript
    && positive.requests.filter(r => r.kind === 'prompt').length === 2
    && positive.requests.every(r => r.fullSddCopies === 1 && r.tokens + r.output <= modelWindow)
    && positive.requests[0]?.userMessages === 1 && positive.requests[0]?.toolResults === 0 && positive.requests[1]?.toolResults === 1,
    'Same complete inline bytes on both admitted requests');
  for (const name of ['initial-dense', 'initial-characters', 'initial-kib']) {
    const t = by[name]; check(t.delivered && t.requests.every(r => r.fullSddCopies === 1) && t.initialHistory === 0, name + ': initial input and transport');
  }
  const dense = by['initial-dense'];
  check(blocked.estimate > positive.requests[0]?.tokens && dense.estimate < dense.requests[0]?.tokens,
    'Opposite estimation errors for Chinese and dense JSON/path inputs at the same token target');
  check(by['initial-file'].delivered && by['initial-file'].requests.every(r => r.fullSddCopies === 0)
    && by['initial-file'].namedBasis?.sha256 === documents.zh.meta.sha256 && by['initial-file'].namedBasis?.mandatory === false, 'File transport, three original lines and Stop authority');
  check(by['initial-zh-output-control'].requests.some(r => r.kind === 'prompt' && r.fullSddCopies === 1
    && r.tokens < modelWindow && r.tokens + r.output > modelWindow && r.response === 'fixture_context_overflow'), 'Output reservation control');
  check(study.reviews.length === 2 && study.reviews.every(r => r.rawInlineIdentical && r.namedReferences === 0
    && r.mandatoryOriginalParts > 1 && r.earlyGateBlocked), 'RC rebound the exact inline original, gated mandatory sections');
  const normal = study.reviews.find(r => r.name === 'initial-review-default');
  check(normal && !normal.reviewCompleted && !normal.checklistSaved && normal.fullParts < normal.mandatoryOriginalParts
    && normal.checkpointPendingBasisFiles > 0 && normal.compactionBoundaries > 0 && normal.maxToolResultAppearances > 1
    && normal.readReceiptsSeenOnWire > 0 && normal.readReceiptsSeenOnWire < normal.totalReadReceipts,
    'Default reviewer stopped with unmet basis coverage after native compaction');
  check(study.reviews.some(r => r.reviewCompleted && r.fullParts === r.mandatoryOriginalParts && r.judgements.includes('DEVIATION')
    && r.rejectedOrdinary.length > 0 && r.compactionBoundaries > 0 && r.summaryCalls.some(s => s.response === 'fixture_summary')),
    'Successful downstream Stop control with original evidence and actual runtime mismatch');
  check([...study.business, ...study.reviews].every(row => row.transportErrors.length === 0), 'The scripted transport encountered an unexpected error');
  study.verified = study.failures.length === 0;
  await writeJson(resultFile, study);
  return study;
}
