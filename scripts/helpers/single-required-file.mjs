import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReviewCheckpoint } from '../../lib/review-task/history-memory.mjs';
import { PAGE_BYTES, PAGE_LINES, sourcePage, toolText } from '../../lib/review-task/source-tools.mjs';
import { MANDATORY_REFERENCE_BYTES } from '../../lib/runtime-v2/original-requirements.mjs';
import { loadStopOriginalRequirements } from '../../lib/runtime-v2/production-stop.mjs';
import { initialSddText } from './initial-sdd-pressure.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rule = '密封模式遇到验收失败时，重试上限为零。';
const candidate = 'src/initial-sdd-release.mjs';
const marker = 'SDD-SEAL-R93';
const parsePage = text => {
  const match = /\[RC page (\{[^\r\n]*\})\]/u.exec(text);
  return match ? JSON.parse(match[1]) : null;
};
const read = (file, offset, limit) => ({ name: 'source_read', args: { path: file, offset, limit, numbered: true } });

// Each path is a deterministic machine-produced workflow input. Adjacent
// one-digit path components give a dense but valid UTF-8 original.
function pathSpecification(rows, packed = false) {
  const paths = Array.from({ length: rows }, (_, i) => {
    const digits = createHash('sha512').update(String(i)).digest();
    return i + ' C:' + [...digits].map(byte => '\\' + byte % 10).join('');
  });
  return ['# Release workflow', 'The following path entries are mandatory inputs.',
    paths.join(packed ? ' ' : '\n'), marker + ' ' + rule].join('\n');
}

function reviewerFor(material, mode) {
  return (getTask, record) => {
    let phase = 'start', pending = [], sequence = 0, itemId;
    const events = record.materialEvents = [];
    const send = (next, calls) => {
      phase = next;
      pending = calls.map(call => ({ ...call, id: 'material' + (++sequence) }));
      record.calls.push(...pending);
      return { calls: pending };
    };
    const page = (offset, limit, next = 'pages') => send(next, [read(material.file, offset, limit)]);
    const gate = negative => send(negative ? 'negative-gate' : 'gate', [{ name: 'set_original_checklist', args: { items: [{
      metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
      text: rule, path: material.file, lineStart: material.tail, lineEnd: material.tail,
    }] } }]);
    return payload => {
      if (phase === 'ended') return { text: '本对照在读取门槛处结束。' };
      if (phase === 'start') {
        const basis = getTask().basisFiles;
        assert.equal(basis.filter(file => file === material.file).length, 1, 'One physical material must be in the mandatory basis');
        const metadata = basis.filter(file => file !== material.file);
        assert(metadata.length > 0);
        return send('metadata', metadata.map(file => read(file, 1, PAGE_LINES)));
      }
      const wire = new Map(payload.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
      const results = pending.map(call => {
        const text = wire.get(call.id);
        assert.equal(typeof text, 'string', 'The last tool result must be available for the scripted action ' + phase);
        return text;
      });
      const first = results[0];
      if (phase === 'metadata') {
        assert(results.every(text => parsePage(text)?.nextOffset === null), 'Only small ancillary basis files are allowed');
        if (mode === 'max-page') return page(1, PAGE_LINES, 'max-page');
        if (mode === 'long-line') return page(1, 2, 'prefix');
        return page(1, material.linesPerPage);
      }
      if (phase === 'max-page') {
        events.push({ type: 'max-page', toolId: pending[0].id, receivedChars: first.length });
        return gate(true);
      }
      if (phase === 'prefix') {
        assert.equal(parsePage(first)?.end, 2);
        return page(3, PAGE_LINES, 'long-attempt');
      }
      if (phase === 'long-attempt' || phase === 'one-line-retry') {
        events.push({ type: 'line-error', offset: pending[0].args.offset, limit: pending[0].args.limit, error: first.slice(0, 180) });
        if (phase === 'long-attempt') return page(3, 1, 'one-line-retry');
        return page(material.tail, 1, 'tail-only');
      }
      if (phase === 'tail-only') {
        assert(first.includes(rule));
        return gate(true);
      }
      if (phase === 'pages') {
        const received = parsePage(first);
        assert.equal(received?.start, pending[0].args.offset);
        events.push({ type: 'page', toolId: pending[0].id, start: received.start, end: received.end });
        if (received.nextOffset !== null) {
          assert(received.nextOffset > received.start);
          return page(received.nextOffset, material.linesPerPage);
        }
        assert(first.includes(rule), 'Final page must contain the original rule');
        return gate(false);
      }
      if (phase === 'negative-gate') {
        events.push({ type: 'rejected-checklist', result: first.slice(0, 1200) });
        assert(first.includes('Required original basis not fully read') && first.includes(path.basename(material.file)));
        phase = 'ended';
        return { text: '该必读文件仍有原文范围未读。' };
      }
      if (phase === 'gate') {
        assert.equal(JSON.parse(first).saved, true);
        events.push({ type: 'saved-checklist' });
        return send('scope', [{ name: 'review_checklist', args: { stopClassification: 'TASK_COMPLETE', completionClaim: true } }]);
      }
      if (phase === 'scope') {
        itemId = JSON.parse(first).items[0].taskId;
        return send('judge', [read(material.file, material.tail, 1), read(candidate, 1, 1)]);
      }
      if (phase === 'judge') {
        assert(first.includes(rule) && results[1].includes('return 3'));
        return send('submit', [{ name: 'submit_review', args: { taskId: itemId, verdict: 'DEVIATION',
          reason: '密封模式返回 3 次，超过原文约定的零次。', citations: [{ path: candidate, start: 1, end: 1 }] } }]);
      }
      assert.equal(phase, 'submit');
      return send('ended', [{ name: 'finish_stop_review', args: { summary: '核实了末行规定的重试上限偏差。' } }]);
    };
  };
}

function coverage(reads, total) {
  const lines = new Set();
  for (const { start, end } of reads) for (let n = start; n <= end; n++) lines.add(n);
  let firstMissing = 1;
  while (lines.has(firstMissing)) firstMissing++;
  return { lines: lines.size, firstMissing: firstMissing <= total ? firstMissing : null };
}

async function inspect(record, material) {
  const materialReads = record.reads.filter(r => r.path === material.file);
  const acceptedReads = new Map(materialReads.map(r => [r.id, r]));
  const ordinary = record.requests.filter(r => r.kind === 'prompt');
  const firstWire = JSON.parse(await fs.readFile(path.join(record.directory, 'wire-001.json'), 'utf8'));
  const firstMessages = JSON.stringify(firstWire.messages);
  const originalAtStart = { firstAnchor: firstMessages.includes(material.startAnchor), tailAnchor: firstMessages.includes(marker) };
  const seen = new Map();
  let firstOverflow = null, lastAcceptedInput = null, fullInOneAcceptedRequest = false;
  for (const req of ordinary) {
    const exact = req.toolResults.map(result => {
      const receipt = acceptedReads.get(result.id);
      return receipt?.sha256 === result.sha256 ? receipt : null;
    }).filter(Boolean);
    const firstRejection = req.response === 'fixture_context_overflow' && !firstOverflow;
    const previouslySentLines = firstRejection ? coverage(seen.values(), material.lines).lines : null;
    for (const row of exact) seen.set(row.id, row);
    const scope = coverage(exact, material.lines);
    if (firstRejection) {
      firstOverflow = { sequence: req.sequence, input: req.inputTokens, output: req.maxOutputTokens,
        lastAcceptedInput, previouslySentLines, materialLinesByThisRequest: coverage(seen.values(), material.lines).lines };
    } else if (req.response !== 'fixture_context_overflow' && scope.firstMissing === null) fullInOneAcceptedRequest = true;
    if (req.response !== 'fixture_context_overflow') lastAcceptedInput = req.inputTokens;
  }
  const checkpoint = await loadReviewCheckpoint(path.join(record.reviewDirectory, 'review-checkpoint.json'));
  const trimmedIds = new Set(ordinary.flatMap(r => r.toolResults.filter(t => t.truncated).map(t => t.id)));
  const largeRead = record.materialEvents.find(row => row.type === 'max-page');
  const sourceCall = record.calls.findIndex(c => c.args.path === candidate);
  const scopeCall = record.calls.findIndex(c => c.name === 'review_checklist');
  const prechecks = record.pressureLog.filter(line => line.includes('pre-prompt check'));
  const pressure = /\bestimatedPromptTokens=(\d+)/.exec(prechecks.at(-1) ?? '');
  return { name: record.name, mandatory: record.basisFiles.includes(material.file), materialSha256: material.sha256,
    firstInput: ordinary[0].inputTokens, originalAtStart, reserveRequestedOutput: record.reserveOutput,
    covered: coverage(materialReads, material.lines), materialReceipts: materialReads.length, exactReceiptsOnWire: seen.size,
    fullInOneAcceptedRequest, firstProviderOverflow: firstOverflow,
    clippedMaxPage: largeRead ? { receivedChars: largeRead.receivedChars, hostClipped: trimmedIds.has(largeRead.toolId),
      receivedReadCredit: acceptedReads.has(largeRead.toolId) } : null,
    longLineAttempts: record.materialEvents.filter(row => row.type === 'line-error'),
    unreadGate: record.materialEvents.find(row => row.type === 'rejected-checklist')?.result ?? null,
    checklistSaved: record.materialEvents.some(event => event.type === 'saved-checklist'), completed: record.result.reviewCompleted === true,
    resultCode: record.result.code ?? record.result.collection?.failures?.[0]?.code ?? null,
    judgements: record.result.review?.metricObjectJudgements?.map(row => row.judgement) ?? [],
    candidateOnlyAfterChecklist: sourceCall === -1 || (scopeCall >= 0 && scopeCall < sourceCall),
    executionReads: record.reads.filter(r => r.category === 'execution').length,
    checkpointPending: checkpoint.taskState.pendingCount, ordinaryRequests: ordinary.length,
    ordinaryPeak: Math.max(0, ...ordinary.map(r => r.inputTokens)), summaryRequests: record.requests.filter(r => r.kind === 'compaction').length,
    compactBoundaries: record.hostCompactions.length, lastPrecheck: pressure ? Number(pressure[1]) : null,
    nativeErrors: record.nativeResults.flatMap(result => result.meta?.error ? [result.meta.error] : []),
    noHistoryToCompact: record.pressureLog.filter(line => line.includes('no real conversation messages')).length,
    transportErrors: record.transportErrors ?? [], evidence: record.name + '/evidence.json' };
}

export async function runSingleRequiredFile({ outputRoot, repo, count, model, modelWindow, toolResultCap, review }) {
  const study = { model: model.review, providerWindow: modelWindow, toolResultCap, pageBytes: PAGE_BYTES, pageLines: PAGE_LINES,
    probeSha256: sha(await fs.readFile(new URL(import.meta.url))), materials: {}, cases: [], failures: [] };
  const save = () => fs.writeFile(path.join(outputRoot, 'single-required-study.json'), JSON.stringify(study, null, 2) + '\n');
  const implementation = path.join(repo, candidate);
  await fs.writeFile(implementation, 'export function retryLimit(mode) { return 3; }\n');
  assert.equal((await import(pathToFileURL(implementation).href)).retryLimit('sealed'), 3);
  const documents = [
    { key: 'lines', rel: 'contracts/examples.md', body: pathSpecification(452), modes: ['paged'], linesPerPage: 100 },
    { key: 'packed', rel: 'contracts/packed.md', body: pathSpecification(452, true), modes: ['long-line'], linesPerPage: 100 },
    { key: 'dense', rel: 'contracts/path-table.md', body: pathSpecification(1818), modes: ['max-page', 'paged', 'input-only'], linesPerPage: 112 },
    { key: 'zh', rel: 'AGENTS.md', body: initialSddText(4547, 'chinese'), modes: ['paged', 'wide-host'], linesPerPage: 125 },
  ];
  for (const doc of documents) {
    const file = path.join(repo, doc.rel);
    await fs.writeFile(file, doc.body);
    const bytes = await fs.readFile(file), lines = doc.body.split('\n');
    const snapshot = { entries: [{ type: 'user', uuid: 'single-file-user', message: {
      content: '请依照 ' + doc.rel + ' 的完整规范验收密封模式。' } },
      { type: 'assistant', uuid: 'single-file-final', message: { content: '密封模式实现已提交，请验收。' } }] };
    const manifest = await loadStopOriginalRequirements({ projectRoot: repo, snapshot, referenceTier: true });
    const project = manifest.projectFiles.find(f => f.path === doc.rel);
    const ref = project ?? manifest.referencedFiles.find(f => f.path === doc.rel);
    assert(ref && ref.mandatory !== false && ref.sha256 === sha(bytes), 'Material must be mandatory in the production manifest');
    const firstPage = sourcePage(bytes, { offset: 1, limit: PAGE_LINES, numbered: true });
    const material = { bytes: bytes.length, lines: lines.length, sha256: ref.sha256, originalKind: project ? 'PROJECT_FILE' : 'NAMED_FILE',
      rawTokens: (await count({ model: model.review, rawText: doc.body })).tokens,
      businessRawTokens: (await count({ model: model.business, rawText: doc.body })).tokens,
      longestLineBytes: Math.max(...lines.map(s => Buffer.byteLength(s))), rel: doc.rel,
      startAnchor: project ? 'SDD-OPEN-K12' : 'The following path entries are mandatory inputs.',
      firstSourcePage: { ...firstPage.details.page, textChars: toolText(firstPage).length } };
    study.materials[doc.key] = material;
    for (const mode of doc.modes) {
      const name = 'one-' + doc.key + '-' + mode;
      const record = await review({ name, snapshot, contract: file, maxOutput: 8192, providerWindow: modelWindow, reserveOutput: mode !== 'input-only',
        ...(mode === 'wide-host' ? { window: 400000 } : {}),
        deviationOnly: false, makeReply: reviewerFor({ ...material, file, tail: lines.length, linesPerPage: doc.linesPerPage }, mode) });
      const result = await inspect(record, { ...material, file });
      study.cases.push(result);
      await save();
      console.log(JSON.stringify({ name, lines: result.covered.lines, total: lines.length, completed: result.completed,
        rejectedInput: result.firstProviderOverflow?.input, compacts: result.compactBoundaries }));
    }
  }
  const check = (ok, message) => { if (!ok) study.failures.push(message); };
  const find = name => study.cases.find(row => row.name === name);
  const small = find('one-lines-paged'), packed = find('one-packed-long-line'), wide = find('one-dense-max-page');
  const dense = find('one-dense-paged'), inputOnly = find('one-dense-input-only'), zh = find('one-zh-paged');
  check(study.materials.dense.bytes <= MANDATORY_REFERENCE_BYTES && study.materials.dense.rawTokens > modelWindow,
    'One ordinary mandatory file must exceed the actual model window in bare tokens');
  check(study.cases.every(r => r.mandatory && !r.transportErrors.length && r.candidateOnlyAfterChecklist && r.executionReads === 0
    && !r.originalAtStart.firstAnchor && !r.originalAtStart.tailAnchor),
    'One large mandatory material must account for the reading pressure');
  check(small?.completed && small.judgements.includes('DEVIATION') && small.covered.firstMissing === null, 'Multiline positive control');
  check(study.materials.packed.bytes === study.materials.lines.bytes && study.materials.packed.rawTokens < modelWindow
    && packed?.covered.firstMissing === 3 && packed.longLineAttempts.length === 2 && packed.longLineAttempts.every(v => v.error.includes('page byte limit'))
    && packed.unreadGate && !packed.checklistSaved, 'Overlong indivisible line blocks the file while the input fits');
  check(wide?.clippedMaxPage?.hostClipped && !wide.clippedMaxPage.receivedReadCredit && wide.unreadGate, 'Largest first page is clipped and earns no read coverage');
  check(dense?.firstProviderOverflow && dense.firstProviderOverflow.materialLinesByThisRequest < study.materials.dense.lines
    && dense.compactBoundaries > 0 && dense.completed && dense.judgements.includes('DEVIATION')
    && dense.covered.firstMissing === null && !dense.fullInOneAcceptedRequest, 'Single over-window file crosses the wire limit during paging and recovers');
  check(inputOnly?.firstProviderOverflow?.input > modelWindow && inputOnly.firstProviderOverflow.materialLinesByThisRequest < study.materials.dense.lines
    && inputOnly.completed && inputOnly.judgements.includes('DEVIATION') && !inputOnly.fullInOneAcceptedRequest,
    'Reading this one file also overflows strictly on input, independent of output reservation');
  check(study.materials.zh.sha256 === 'cf01ab06a64b204b09ba2d9f4dedbf3e5bb5c89475c2d23a235b8f0a05c69043'
    && zh?.mandatory && zh.materialReceipts > 0 && zh.covered.firstMissing !== null && !zh.checklistSaved && !zh.completed
    && zh.compactBoundaries > 0 && zh.nativeErrors.some(error => error.kind === 'context_overflow'),
    'The host stopped mid-file after compaction reading the same 164K Chinese SDD as one mandatory project file');
  const zhWide = find('one-zh-wide-host');
  check(zhWide?.materialSha256 === zh.materialSha256 && zhWide.covered.firstMissing === null
    && zhWide.completed && zhWide.judgements.includes('DEVIATION'), 'Wider host precheck control finishes the same physical Chinese material');
  study.verified = study.failures.length === 0;
  await save();
  return study;
}
