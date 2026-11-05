#!/usr/bin/env node
// Summarizes a run root of scripts/run-original-basis-release.mjs from its
// persisted evidence. Hidden grading contributes pass counts only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { collectReleaseEvidence, computeReleaseVerdict, documentCorrectionEnabled, hiddenScore, tokenSplit } from './bench/release-evidence.mjs';

const usage = 'node scripts/summarize-original-basis-release.mjs --root=<run root> --out=<directory> [--openclaw-profile=<profile> (scan outputs)]';
const missing = fallback => error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fallback; throw error; };
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse, missing(null));
const limited = row => ['rate-limited', 'peer-paused'].includes(row.state);
const countOf = value => Array.isArray(value) ? value.length : Number.isSafeInteger(value) ? value : null;

async function attempts(batch) {
  const names = (await fs.readdir(batch).catch(missing([]))).filter(name => /-attempt-\d+$/u.test(name));
  const rows = [];
  for (const name of names) {
    const observation = await readJson(path.join(batch, name, 'observation.json'));
    if (observation) rows.push({ directory: path.join(batch, name), observation, leak: await readJson(path.join(batch, name, 'leak-scan.json')) });
  }
  const slots = new Map();
  for (const row of rows.sort((left, right) => left.observation.attempt - right.observation.attempt)) {
    const list = slots.get(row.observation.slot) ?? [];
    list.push(row); slots.set(row.observation.slot, list);
  }
  // The retained attempt is the first one without an infrastructure error or rate limit.
  return [...slots].map(([slot, list]) => ({ slot, attempts: list.length,
    chosen: list.find(row => !row.observation.frameworkError && !limited(row.observation)) ?? list.at(-1), all: list }));
}

const evidenceOf = async (directory, result, manifest) => {
  const projectRoot = manifest?.projectRoot ?? result?.projectRoot;
  if (projectRoot && await fs.stat(path.join(projectRoot, '.runtime-correction')).catch(() => null))
    return { source: 'persisted', ...await collectReleaseEvidence({ projectRoot, sessionId: result?.sessionId ?? null,
      nativeRoot: path.join(directory, 'evaluation/native-host'), turns: result?.turns ?? [] }) };
  return result?.stopReviews ? { source: 'result', documentReviews: result.documentReviews ?? [], stopReviews: result.stopReviews, materialBasis: result.materialBasis ?? [] }
    : { source: 'missing', documentReviews: [], stopReviews: [], materialBasis: [] };
};
const reviewRow = row => ({ kind: row.kind, stage: row.stage, status: row.status, reasonCode: row.reasonCode, classification: row.classification,
  fullObjectCount: row.fullObjectCount, selectedObjectCount: row.selectedObjectCount, deviations: row.deviations, durationMs: row.durationMs,
  requests: row.requests, tokens: row.tokens, ...(row.kind === 'stop' ? { runId: row.runId, scanCompleted: row.scanCompleted, coverageSource: row.coverageSource }
    : { file: row.file, settled: row.settled, feedbackDelivered: row.feedbackDelivered }) });

export async function quickRow({ slot, attempts: count, chosen }) {
  const { observation, directory, leak } = chosen, result = observation.result;
  const sample = /ceiling/u.test(slot) ? 'ceiling' : /correct/u.test(slot) ? 'correct' : 'other';
  const manifest = await readJson(path.join(directory, 'evaluation/manifest.json'));
  const evidence = await evidenceOf(directory, result, manifest), ledger = result?.firstStop;
  // Without a persisted evaluation the runner's ledger snapshot is the record.
  const first = evidence.stopReviews.find(row => row.runId === ledger?.id) ?? (ledger ? { kind: 'stop', runId: ledger.id, stage: null,
    status: ledger.reviewStatus ?? null, reasonCode: ledger.releaseReason ?? null, classification: null, fullObjectCount: null, selectedObjectCount: null,
    scanCompleted: ledger.progress?.complete ?? null, coverageSource: 'ledger', deviations: countOf(ledger.currentDeviations),
    durationMs: Number.isFinite(ledger.assessmentFinishedAt) ? ledger.assessmentFinishedAt - ledger.startedAt : null, requests: null, tokens: null }
    : evidence.stopReviews[0] ?? null);
  const feedback = result?.repairFeedback === true;
  const deviations = first?.deviations ?? null;
  const judgement = !result || observation.frameworkError || limited(observation) || result.nativeStopSettled === false ? 'INVALID'
    : sample === 'ceiling' ? (feedback && (deviations > 0 || first?.status === 'DEVIATION') ? 'DETECTED' : 'MISSED')
      : sample === 'correct' ? (feedback ? 'FALSE_POSITIVE' : 'NO_FALSE_POSITIVE') : null;
  return { slot, sample, attempts: count, state: observation.state, reason: observation.reason, frameworkError: observation.frameworkError,
    repairFeedback: feedback, judgement, firstStop: first && reviewRow(first), stopReviews: evidence.stopReviews.map(reviewRow), evidenceSource: evidence.source,
    nativeStopSettled: result?.nativeStopSettled ?? null, startHead: result?.startHead ?? null, patchApplied: result?.patchApplied ?? null,
    corrections: result?.corrections ?? null, modelRequests: observation.modelRequests ?? result?.modelRequests ?? null,
    tokens: result?.totalUsage?.tokens ?? result?.usage?.tokens ?? null, elapsedMs: observation.elapsedMs, leakMatches: leak?.matches ?? null };
}

export async function e2eRow({ slot, attempts: count, chosen }) {
  const { observation, directory, leak } = chosen, result = observation.result;
  const manifest = await readJson(path.join(directory, 'evaluation/manifest.json'));
  const evidence = await evidenceOf(directory, result, manifest);
  const projectRoot = manifest?.projectRoot ?? result?.projectRoot;
  const documentCorrection = projectRoot ? await documentCorrectionEnabled(projectRoot) : true;
  const verdict = computeReleaseVerdict({ businessNatural: result?.businessNatural, frameworkError: observation.frameworkError, hidden: observation.hidden,
    documentReviews: evidence.documentReviews, stopReviews: evidence.stopReviews, materialBasis: evidence.materialBasis, turns: result?.turns ?? [],
    mutationPaths: result?.frozen?.mutationPaths, nativeStopRecords: evidence.nativeStopRecords ?? result?.nativeStopRecords ?? [],
    nativeStopSettled: result?.nativeStopSettled ?? null, documentCorrection });
  const tokens = tokenSplit({ documentCost: result?.documentCost, stopCost: result?.stopCost, businessUsage: result?.businessUsage,
    documentReviews: evidence.documentReviews, stopReviews: evidence.stopReviews });
  return { slot, attempts: count, state: observation.state, reason: observation.reason, frameworkError: observation.frameworkError,
    businessNatural: result?.businessNatural ?? null, documentCorrection, hidden: hiddenScore(observation.hidden), runThrough: verdict.runThrough, reasons: verdict.reasons,
    finalCoverage: verdict.finalCoverage, finalStop: verdict.finalStop && reviewRow(verdict.finalStop), codeChanged: verdict.codeChanged,
    recordedRunThrough: observation.ranThrough ?? null, evidenceSource: evidence.source,
    reviews: [...evidence.documentReviews, ...evidence.stopReviews].map(reviewRow), materialBasis: evidence.materialBasis, tokens,
    java: observation.java ?? manifest?.java ?? null, elapsedMs: observation.elapsedMs, leakMatches: leak?.matches ?? null };
}

const dash = value => value === null || value === undefined || value === '' ? '—' : value;
const num = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
const sec = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : '—';
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell => String(dash(cell)).replaceAll('|', '\\|')).join(' | ')} |`).join('\n');
const label = { DETECTED: '检出', MISSED: '漏检', FALSE_POSITIVE: '误报', NO_FALSE_POSITIVE: '无误报', INVALID: '无效' };
const coverage = row => row ? `${dash(row.selectedObjectCount)}/${dash(row.fullObjectCount)}${row.scanCompleted === false ? '（未扫完）' : ''}` : '—';

export function renderMarkdown(summary) {
  const lines = [`# RC 原文简化版评测汇总`, '', `- 运行目录　${summary.root}`, `- 生成时间　${summary.generatedAt}`,
    `- 凭据泄漏扫描　${summary.leakScan.status}（命中 ${summary.leakScan.matches}，已扫描 ${summary.leakScan.scanned} 份记录${summary.leakScan.unscanned ? `，缺少 ${summary.leakScan.unscanned} 份` : ''}）`, ''];
  if (summary.quick.length) lines.push('## 冻结对象快速验证', '',
    '天花板对象：发出带偏差的修复反馈即为检出。正确对象：发出修复反馈即为误报。', '',
    table(['槽位', '对象', '尝试', '状态', '原因', '首次 Stop', '覆盖（选中/全部）', '偏差', '修复反馈', '判定', '请求', 'Tokens', '用时'],
      summary.quick.map(row => [row.slot, row.sample, row.attempts, row.state, row.reason,
        row.firstStop ? `${dash(row.firstStop.status)} / ${dash(row.firstStop.reasonCode)}` : '—', coverage(row.firstStop), row.firstStop?.deviations,
        row.repairFeedback ? '是' : '否', label[row.judgement] ?? row.judgement, num(row.modelRequests), num(row.tokens), sec(row.elapsedMs)])), '');
  if (summary.e2e.length) {
    lines.push('## 端到端', '', table(['槽位', '尝试', '状态', '业务自然结束', '隐藏评分', 'F2P', 'P2P', '最终 Stop', '最终覆盖', '跑通', '未跑通原因',
      'RC 请求', 'RC Tokens（文档/Stop）', '业务请求', '业务 Tokens'],
    summary.e2e.map(row => [row.slot, row.attempts, row.state, row.businessNatural ? '是' : '否', row.hidden.executed ? '已执行' : '未执行', row.hidden.f2p, row.hidden.p2p,
      row.finalStop ? `${dash(row.finalStop.status)} / ${dash(row.finalStop.reasonCode)}` : '—', row.finalCoverage, row.runThrough ? '是' : '否',
      row.reasons.join('；') || '—', num(row.tokens.rc.requests), `${num(row.tokens.rc.tokens)}（${num(row.tokens.rc.document.tokens)}/${num(row.tokens.rc.stop.tokens)}）`,
      num(row.tokens.business.requests), num(row.tokens.business.tokens)])), '');
    for (const row of summary.e2e) lines.push(`### ${row.slot} 逐次审查`, '', table(['类型', '阶段', '状态', '原因码', '分类', '全部对象', '选中对象', '偏差', '用时', '请求', 'Tokens'],
      row.reviews.map(review => [review.kind === 'document' ? '文档' : 'Stop', review.stage, review.status, review.reasonCode, review.classification,
        review.fullObjectCount, review.selectedObjectCount, review.deviations, sec(review.durationMs), num(review.requests), num(review.tokens)])), '');
  }
  const t = summary.totals;
  lines.push('## 合计', '', table(['范围', '请求', 'Tokens'], [
    ['快速验证（全部审查）', num(t.quick.requests), num(t.quick.tokens)], ['端到端 RC', num(t.e2e.rc.requests), num(t.e2e.rc.tokens)],
    ['端到端业务', num(t.e2e.business.requests), num(t.e2e.business.tokens)]]), '',
  `- 快速验证判定　${Object.entries(t.quick.judgements).map(([key, value]) => `${label[key] ?? key} ${value}`).join('，') || '—'}`,
  `- 端到端跑通　${t.e2e.runThrough}/${summary.e2e.length}`, '');
  return lines.join('\n');
}

const total = values => values.some(value => !Number.isFinite(value)) ? null : values.reduce((sum, value) => sum + value, 0);
export async function summarizeRun(root) {
  const quick = await Promise.all((await attempts(path.join(root, 'quick'))).map(quickRow));
  const e2e = await Promise.all((await attempts(path.join(root, 'e2e'))).map(e2eRow));
  const scans = [];
  for (const phase of ['quick', 'e2e']) for (const slot of await attempts(path.join(root, phase)))
    for (const row of slot.all) scans.push({ file: path.join(row.directory, 'leak-scan.json'), matches: row.leak?.matches ?? null });
  for (const name of (await fs.readdir(root).catch(missing([]))).filter(name => name.endsWith('leak-scan.json')))
    scans.push({ file: path.join(root, name), matches: (await readJson(path.join(root, name)))?.matches ?? null });
  const matches = scans.reduce((sum, row) => sum + (row.matches ?? 0), 0), unscanned = scans.filter(row => !Number.isSafeInteger(row.matches)).length;
  const judgements = {};
  for (const row of quick) judgements[row.judgement] = (judgements[row.judgement] ?? 0) + 1;
  return { kind: 'original-basis-release-summary', root, generatedAt: new Date().toISOString(),
    leakScan: { status: matches ? 'FAIL' : unscanned ? 'INCOMPLETE' : 'PASS', matches, scanned: scans.length - unscanned, unscanned, files: scans },
    quick, e2e, totals: { quick: { requests: total(quick.map(row => row.modelRequests)), tokens: total(quick.map(row => row.tokens)), judgements },
      e2e: { runThrough: e2e.filter(row => row.runThrough).length,
        rc: { requests: total(e2e.map(row => row.tokens.rc.requests)), tokens: total(e2e.map(row => row.tokens.rc.tokens)) },
        business: { requests: total(e2e.map(row => row.tokens.business.requests)), tokens: total(e2e.map(row => row.tokens.business.tokens)) } } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values: args } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' }, 'openclaw-profile': { type: 'string' }, help: { type: 'boolean' } } });
  if (args.help || !args.root || !args.out) { console.log(usage); process.exit(args.help ? 0 : 2); }
  const summary = await summarizeRun(path.resolve(args.root)), out = path.resolve(args.out);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  await fs.writeFile(path.join(out, 'summary.md'), renderMarkdown(summary));
  if (args['openclaw-profile']) {
    const { countProfileCredentialMatches, resolveSimplifyProvider } = await import('./helpers/simplify-native-evaluation.mjs');
    const { credential } = await resolveSimplifyProvider('host-profile', 'deepseek-v4-flash', args['openclaw-profile']);
    const found = await countProfileCredentialMatches(out, credential);
    await fs.writeFile(path.join(out, 'leak-scan.json'), JSON.stringify({ matches: found }) + '\n');
    if (found) { await fs.rm(path.join(out, 'results.json')); await fs.rm(path.join(out, 'summary.md')); throw new Error('Credential found in summary output; removed.'); }
  }
  console.log(JSON.stringify({ out, leakScan: summary.leakScan.status, quick: summary.totals.quick.judgements, e2eRunThrough: summary.totals.e2e.runThrough }));
}
