#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { simplifySchedule, SCREENING_SAMPLES, STOP_ARMS } from './simplify-experiment-schedule.mjs';
import { scoreCompaction } from './score-simplify-compaction.mjs';

const metricOrder = ['completion', 'elapsedMs', 'tokens'];
const simplicity = ['B12', 'B1', 'B2', 'A'];
const naturalSamples = { 'httpx-frozen': [122, 1272], 'etree-frozen': [52, 15], 'narwhals-frozen': [103, 10093] };
const baseline = { arm: 'S0', sample: 'etree-deepequal-injected', official: { f2p_passed: 48, f2p_total: 52, p2p_passed: 15, p2p_total: 15 },
  source: 'docs/stop-injected-benchmark-acceptance-20261102.json', historical: true };
const number = value => Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const known = value => value !== null && value !== undefined;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const knownMean = values => values.length && values.every(number) ? mean(values) : null;
const range = values => Math.max(...values) - Math.min(...values);
const optionalBool = value => value == null || typeof value === 'boolean';
const ratio = (part, total) => number(part) && number(total) && total > 0 ? part / total : null;

function usageRecord(value, id) {
  const { tokens = null, completeCalls = 0, observedCalls = 0 } = value ?? {};
  if (!integer(completeCalls) || !integer(observedCalls) || completeCalls > observedCalls
    || (completeCalls ? !integer(tokens) : tokens !== null)) throw new Error(`Invalid usage counts for ${id}.`);
  return { tokens, completeCalls, observedCalls, coverage: ratio(completeCalls, observedCalls) };
}

function officialReward(value, id) {
  if (value == null) return null;
  const { f2p_passed, f2p_total, p2p_passed, p2p_total } = value;
  if (![f2p_passed, f2p_total, p2p_passed, p2p_total].every(integer)
    || f2p_total === 0 || p2p_total === 0 || f2p_passed > f2p_total || p2p_passed > p2p_total)
    throw new Error(`Invalid official test counts for ${id}.`);
  return { f2p_passed, f2p_total, p2p_passed, p2p_total };
}

function recordRun(slot, raw) {
  if (!raw) return { ...slot, state: 'not-run' };
  const { id, state, completedInBudget = null, elapsedMs = null, rcElapsedMs = null,
    artifactSha256, configurationSummary, evidence, reason = null } = raw;
  if (!['completed', 'failed', 'timed-out', 'rate-limited', 'interrupted'].includes(state)
    || !optionalBool(completedInBudget) || ![elapsedMs, rcElapsedMs].every(value => value == null || number(value))
    || !/^[a-f0-9]{64}$/iu.test(artifactSha256 ?? '') || typeof configurationSummary !== 'string' || !configurationSummary.trim()
    || typeof evidence !== 'string' || !evidence.trim() || reason != null && typeof reason !== 'string')
    throw new Error(`Invalid run state, timing, package SHA256, configuration or evidence for ${id}.`);
  const record = { ...slot, state, completedInBudget, elapsedMs, rcElapsedMs, artifactSha256, configurationSummary, evidence, reason,
    usage: usageRecord(raw.usage, id) };
  if (slot.round === 'C') {
    const { firstCompactedAt = null, injections = [], assessment } = raw.compaction ?? {};
    if (firstCompactedAt !== null && !integer(firstCompactedAt) || !Array.isArray(injections)
      || injections.some(item => !integer(item?.at) || !integer(item?.length))) throw new Error(`Invalid compaction events for ${id}.`);
    if (state === 'completed' && (!firstCompactedAt || !assessment || !number(elapsedMs) || elapsedMs > slot.timeoutMs))
      throw new Error(`Completed C run ${id} needs a real compaction, graded answer and duration within the cap.`);
    const injectionProtocol = !firstCompactedAt ? null : slot.arm === 'C-off' ? injections.length === 0
      : injections.length === 1 && injections[0].at >= firstCompactedAt && injections[0].length > 0;
    return { ...record, compaction: { firstCompactedAt, injections, injectionProtocol, grading: assessment ? scoreCompaction(assessment) : null } };
  }
  const { repairFeedback = null, matchesDefect = null, ungroundedFeedback = null } = raw;
  if (![repairFeedback, matchesDefect, ungroundedFeedback].every(optionalBool)
    || repairFeedback === null && (known(matchesDefect) || known(ungroundedFeedback))
    || repairFeedback === false && (matchesDefect === true || ungroundedFeedback === true))
    throw new Error(`Invalid observations of actual repair feedback for ${id}.`);
  const official = slot.round === '2' ? { before: officialReward(raw.official?.before, id), after: officialReward(raw.official?.after, id) } : null;
  const baselineCost = slot.round === '2' && slot.arm === 'A' ? (raw.baselineCost ?? {}) : {};
  if (Object.values(baselineCost).some(value => value !== null && !number(value))
    || number(baselineCost.elapsedMs) && number(rcElapsedMs) && baselineCost.elapsedMs > rcElapsedMs
    || number(baselineCost.tokens) && number(record.usage.tokens) && baselineCost.tokens > record.usage.tokens)
    throw new Error(`Invalid baseline cost for ${id}.`);
  const feedback = { sent: repairFeedback, matchesDefect: repairFeedback === false ? false : matchesDefect,
    ungrounded: repairFeedback === false ? false : ungroundedFeedback };
  return { ...record, feedback, official, baselineCost: slot.round === '2' && slot.arm === 'A' ? {
    elapsedMs: baselineCost.elapsedMs ?? null, tokens: baselineCost.tokens ?? null,
    elapsedShare: ratio(baselineCost.elapsedMs, rcElapsedMs), tokenShare: record.usage.coverage === 1 ? ratio(baselineCost.tokens, record.usage.tokens) : null,
  } : null };
}

function secondary(rows, arm) {
  const metrics = {
    completion: { read: row => known(row.completedInBudget) ? Number(row.completedInBudget) : null, direction: 1 },
    elapsedMs: { read: row => row.rcElapsedMs, direction: -1 },
    tokens: { read: row => row.usage?.coverage === 1 ? row.usage.tokens : null, direction: -1 },
  };
  const samples = [...new Set(rows.map(row => row.sample))];
  return Object.fromEntries(Object.entries(metrics).map(([metric, { read, direction }]) => {
    const bySample = samples.map(sample => {
      const control = rows.filter(row => row.sample === sample && row.arm === 'A').map(read);
      const candidate = rows.filter(row => row.sample === sample && row.arm === arm).map(read);
      const controlMean = knownMean(control), candidateMean = knownMean(candidate);
      const noise = controlMean === null ? null : range(control);
      const delta = controlMean === null || candidateMean === null ? null : candidateMean - controlMean;
      const change = delta === null ? 'incomparable' : Math.abs(delta) <= noise ? 'tied' : delta * direction > 0 ? 'improved' : 'regressed';
      return { sample, control, candidate, controlMean, candidateMean, noise, delta, change };
    });
    const wins = bySample.filter(row => row.change === 'improved').length;
    const losses = bySample.filter(row => row.change === 'regressed').length;
    const incomparable = bySample.filter(row => row.change === 'incomparable').length;
    return [metric, { bySample, wins, losses, incomparable, net: wins - losses }];
  }));
}

function rankArms(rows) {
  const comparable = metricOrder.filter(metric => rows.every(row => row.secondary[metric].incomparable === 0));
  const sorted = [...rows].sort((left, right) => {
    for (const metric of comparable) {
      const difference = right.secondary[metric].net - left.secondary[metric].net;
      if (difference) return difference;
    }
    return simplicity.indexOf(left.arm) - simplicity.indexOf(right.arm);
  });
  return { sorted, rankingOmissions: metricOrder.filter(metric => !comparable.includes(metric)) };
}

function screen(rows) {
  const arms = Object.keys(STOP_ARMS).map(arm => {
    const subset = rows.filter(row => row.arm === arm);
    const injected = subset.filter(row => SCREENING_SAMPLES[row.sample] === 'injected');
    const correct = subset.filter(row => SCREENING_SAMPLES[row.sample] === 'correct');
    const process = subset.filter(row => SCREENING_SAMPLES[row.sample] === 'no-feedback');
    const detectRate = knownMean(injected.map(row => known(row.feedback?.matchesDefect) ? Number(row.feedback.matchesDefect) : null));
    const falseCount = records => records.every(row => known(row.feedback?.ungrounded)) ? records.filter(row => row.feedback.ungrounded).length : null;
    const strictFalseAlarms = falseCount(correct), processFalseAlarms = falseCount(process);
    return { arm, detectRate, strictFalseAlarms, processFalseAlarms,
      falseAlarms: known(strictFalseAlarms) && known(processFalseAlarms) ? strictFalseAlarms + processFalseAlarms : null,
      completeRate: knownMean(subset.map(row => known(row.completedInBudget) ? Number(row.completedInBudget) : null)), secondary: secondary(rows, arm) };
  });
  const control = arms[0];
  for (const row of arms) row.disposition = row.arm === 'A' ? 'control'
    : [row.detectRate, row.falseAlarms, control.detectRate, control.falseAlarms].some(value => value === null) ? 'unscored'
      : row.detectRate < control.detectRate || row.falseAlarms > control.falseAlarms ? 'eliminated' : 'eligible';
  const ready = rows.every(row => row.state !== 'not-run') && arms.every(arm => arm.detectRate !== null && arm.falseAlarms !== null);
  const { sorted, rankingOmissions } = rankArms(arms.filter(arm => arm.disposition === 'eligible'));
  return { arms, ready, promotions: ready ? sorted.slice(0, 2).map(row => row.arm) : null, rankingOmissions };
}

function finalComparison(rows, screened, promoted) {
  const ready = rows.length > 0 && rows.every(row => row.state !== 'not-run');
  const arms = ['A', ...promoted].map(arm => {
    const selected = rows.filter(row => row.arm === arm);
    const injected = selected.filter(row => row.sample === 'etree-deepequal-injected');
    const frozen = selected.filter(row => Object.hasOwn(naturalSamples, row.sample));
    const detected = knownMean(injected.map(row => known(row.feedback?.matchesDefect) ? Number(row.feedback.matchesDefect) : null));
    const officialValid = injected.length === 2 && injected.every(row => row.official?.after?.f2p_total === baseline.official.f2p_total
      && row.official.after.p2p_total === baseline.official.p2p_total);
    const frozenScored = frozen.length === Object.keys(naturalSamples).length * 2 && frozen.every(row => {
      const [added, regressions] = naturalSamples[row.sample];
      return row.official?.before?.f2p_total === added && row.official.before.p2p_total === regressions
        && known(row.feedback?.matchesDefect) && known(row.feedback?.ungrounded);
    });
    const frozenCorrectFalseAlarms = frozenScored ? frozen.filter(row => {
      const result = row.official.before;
      return result.f2p_passed === result.f2p_total && result.p2p_passed === result.p2p_total && row.feedback.ungrounded;
    }).length : null;
    return { arm, detected, frozenCorrectFalseAlarms,
      frozenDetections: frozenScored ? frozen.filter(row => row.feedback.matchesDefect).length : null,
      frozenFalseAlarms: frozenScored ? frozen.filter(row => row.feedback.ungrounded).length : null,
      finalOfficialAddedMean: officialValid ? mean(injected.map(row => row.official.after.f2p_passed)) : null,
      secondary: secondary(rows, arm) };
  });
  const control = arms[0];
  for (const arm of arms) {
    const first = screened.arms.find(row => row.arm === arm.arm);
    arm.primary = arm.arm === 'A' ? 'control'
      : [arm.detected, control.detected, arm.frozenCorrectFalseAlarms, control.frozenCorrectFalseAlarms,
        arm.finalOfficialAddedMean, control.finalOfficialAddedMean].some(value => value === null) ? 'unscored'
        : first.strictFalseAlarms > screened.arms[0].strictFalseAlarms || arm.detected < control.detected
          || arm.frozenCorrectFalseAlarms > control.frozenCorrectFalseAlarms || arm.finalOfficialAddedMean < control.finalOfficialAddedMean
          ? 'inferior' : 'meets-control';
  }
  if (!screened.ready) return { arms, recommendation: null, reason: 'round-1-incomplete' };
  if (!screened.promotions.length) return { arms, recommendation: 'A', reason: 'no-candidate-survived-round-1' };
  if (!ready || arms.some(arm => arm.primary === 'unscored')) return { arms, recommendation: null, reason: 'round-2-unscored' };
  const { sorted, rankingOmissions } = rankArms(arms.filter(arm => ['control', 'meets-control'].includes(arm.primary)));
  const incomparable = sorted.length > 1 && rankingOmissions.length > 0;
  return { arms, recommendation: incomparable ? null : sorted[0].arm, rankingOmissions,
    reason: incomparable ? 'secondary-metrics-incomparable' : 'ranked-by-preregistered-metrics' };
}

export function summarizeSimplifyExperiment({ records, promoted = [] }) {
  if (!Array.isArray(records) || !Array.isArray(promoted)) throw new Error('Provide records and optional promoted arms.');
  const schedule = [...simplifySchedule('1'), ...(promoted.length ? simplifySchedule('2', promoted) : []), ...simplifySchedule('C')];
  const expected = new Set(schedule.map(row => row.id)), byId = new Map();
  for (const record of records) {
    if (!expected.has(record.id) || byId.has(record.id)) throw new Error(`Unexpected or repeated run ID ${record.id}.`);
    byId.set(record.id, record);
  }
  const runs = schedule.map(slot => recordRun(slot, byId.get(slot.id)));
  for (const group of [Object.keys(STOP_ARMS), ['C-off', 'C-on']]) {
    const hashes = new Set(runs.filter(row => group.includes(row.arm) && row.artifactSha256).map(row => row.artifactSha256.toLowerCase()));
    if (hashes.size > 1) throw new Error(`Package changed within ${group.join('/')}.`);
  }
  const round1 = screen(runs.filter(row => row.round === '1'));
  if (promoted.length && JSON.stringify(promoted) !== JSON.stringify(round1.promotions))
    throw new Error('Round 2 promotions do not match the scored round 1 selection.');
  const round2 = finalComparison(runs.filter(row => row.round === '2'), round1, promoted);
  const baselineRuns = runs.filter(row => row.round === '2' && row.arm === 'A');
  const baselineShare = (key, total) => baselineRuns.length && baselineRuns.every(row => number(row.baselineCost?.[key]) && number(total(row)))
    ? ratio(baselineRuns.reduce((sum, row) => sum + row.baselineCost[key], 0), baselineRuns.reduce((sum, row) => sum + total(row), 0)) : null;
  const baselineUpperBound = { elapsedShare: baselineShare('elapsedMs', row => row.rcElapsedMs),
    tokenShare: baselineRuns.every(row => row.usage?.coverage === 1) ? baselineShare('tokens', row => row.usage.tokens) : null };
  const compaction = Object.fromEntries(['C-off', 'C-on'].map(arm => {
    const selected = runs.filter(row => row.arm === arm);
    const scores = selected.map(row => row.state === 'completed' ? row.compaction?.grading?.score ?? null : null);
    return [arm, { scores, mean: knownMean(scores), noise: scores.every(number) ? range(scores) : null,
      injectionProtocol: selected.map(row => row.compaction?.injectionProtocol ?? null) }];
  }));
  const control = compaction['C-off'], restored = compaction['C-on'];
  const delta = control.mean === null || restored.mean === null ? null : restored.mean - control.mean;
  const protocolValid = [control, restored].every(arm => arm.injectionProtocol.every(value => value === true));
  const compactionComparison = { delta, noise: control.noise, protocolValid,
    change: delta === null || !protocolValid ? 'inconclusive' : Math.abs(delta) <= control.noise ? 'tied' : delta > 0 ? 'improved' : 'regressed' };
  return { historical: [baseline], runs, round1, round2, baselineUpperBound, compaction, compactionComparison,
    baselineRemoval: round2.recommendation && STOP_ARMS[round2.recommendation].originalRequirementsBasis
      ? 'consider-separate-review' : 'retain', generatedAt: new Date().toISOString() };
}

function markdown(report) {
  const format = value => value == null ? '—' : typeof value === 'number' ? String(Number(value.toFixed(3))) : String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, ' ');
  const row = (...cells) => `| ${cells.map(format).join(' | ')} |`;
  const yesNo = value => typeof value === 'boolean' ? value ? '是' : '否' : null;
  const cost = data => data?.coverage == null ? null : `${data.completeCalls}/${data.observedCalls}`;
  const official = value => value ? `${value.f2p_passed}/${value.f2p_total}；${value.p2p_passed}/${value.p2p_total}` : null;
  const table = (headers, rows) => [row(...headers), row(...headers.map(() => '---')), ...rows];
  const secondaryRows = (round, arms) => arms.filter(arm => arm.arm !== 'A').flatMap(arm => metricOrder.flatMap(metric =>
    arm.secondary[metric].bySample.map(item => row(round, arm.arm, item.sample, metric, item.controlMean, item.candidateMean, item.noise, item.delta, item.change))));
  return ['# RC Stop 简化对照实验结果', '', `推荐臂 ${report.round2.recommendation ?? '未能判定'}。基线代码建议 ${report.baselineRemoval === 'retain' ? '保留' : '另行审议是否删除'}。`, '',
    'S0 引用既有 etree 注入后首稿，官方新增项 48/52、回归项 15/15。', '',
    '## 第一轮', '', ...table(['臂', '检出率', '正确实现误报', '缺运行证据误报', '总误报', '预算内完成率', '判定'],
      report.round1.arms.map(arm => row(arm.arm, arm.detectRate, arm.strictFalseAlarms, arm.processFalseAlarms, arm.falseAlarms, arm.completeRate, arm.disposition))), '',
    `入围臂 ${report.round1.promotions?.join('、') || (report.round1.ready ? '无' : '待判定')}。`,
    ...(report.round1.rankingOmissions.length ? [`次指标缺少可比用量或观测 ${report.round1.rankingOmissions.join('、')}。`] : []), '',
    '## 第二轮', '', ...table(['臂', '注入检出率', '冻结首稿检出', '冻结首稿误报', '正确首稿误报', 'etree 官方新增项均值', '主指标判定'],
      report.round2.arms.map(arm => row(arm.arm, arm.detected, arm.frozenDetections, arm.frozenFalseAlarms, arm.frozenCorrectFalseAlarms, arm.finalOfficialAddedMean, arm.primary))), '',
    '## 次指标与噪声', '', ...table(['轮次', '臂', '样例', '指标', 'A 均值', '候选均值', 'A 极差', '候选减 A', '方向'], [
      ...secondaryRows('1', report.round1.arms), ...secondaryRows('2', report.round2.arms),
    ]), '',
    '## A 的基线提取与审计', '',
    `第二轮整体可节省上限估计，耗时占比 ${format(report.baselineUpperBound.elapsedShare)}，token 占比 ${format(report.baselineUpperBound.tokenShare)}。`, '',
    ...table(['样例', '序号', '基线 ms', '占 RC 耗时', '基线 token', '占 RC token'],
      report.runs.filter(run => run.baselineCost).map(run => row(run.sample, run.repeat, run.baselineCost.elapsedMs,
        run.baselineCost.elapsedShare, run.baselineCost.tokens, run.baselineCost.tokenShare))), '',
    '## C 的检查得分', '', ...table(['臂', '三次得分', '均值', '极差', '注入符合预期'], Object.entries(report.compaction).map(([arm, data]) =>
      row(arm, data.scores.map(format).join(' / '), data.mean, data.noise, data.injectionProtocol.map(value => format(yesNo(value))).join(' / ')))), '',
    `C 开减 C 关得分差 ${format(report.compactionComparison.delta)}，C 关极差 ${format(report.compactionComparison.noise)}，判定 ${report.compactionComparison.change}。`, '',
    ...table(['臂', '序号', '首次压缩时间', '注入次数', '注入长度', '得分'], report.runs.filter(run => run.round === 'C').map(run => row(run.arm,
      run.repeat, run.compaction?.firstCompactedAt, run.compaction?.injections.length,
      run.compaction?.injections.map(item => item.length).join(' / '), run.compaction?.grading?.score))), '',
    '## 逐次记录', '', ...table(['臂', '样例', '序号', '状态', '修复反馈', '命中', '误报', '预算内', '耗时 ms', 'RC ms', 'token', '用量覆盖', '官方首稿', '官方最终', '安装包 SHA256', '配置', '证据', '原因'],
      report.runs.map(run => row(run.arm, run.sample, run.repeat, run.state, yesNo(run.feedback?.sent), yesNo(run.feedback?.matchesDefect),
        yesNo(run.feedback?.ungrounded), yesNo(run.completedInBudget), run.elapsedMs, run.rcElapsedMs, run.usage?.tokens, cost(run.usage),
        official(run.official?.before), official(run.official?.after), run.artifactSha256, run.configurationSummary, run.evidence, run.reason))), '',
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, 'output-dir': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/summarize-simplify-experiment.mjs --input <json> --output-dir <existing directory>');
    console.log('Input: { promoted?: string[], records: Array<{ id, state, artifactSha256, configurationSummary, evidence, reason?, completedInBudget?, elapsedMs?, rcElapsedMs?, usage?: { tokens, completeCalls, observedCalls }, repairFeedback?, matchesDefect?, ungroundedFeedback?, official?: { before, after }, baselineCost?: { elapsedMs, tokens }, compaction?: { firstCompactedAt, injections: [{ at, length }], assessment } }> }.');
    console.log('Use the scheduled IDs and one integration package across all four Stop arms. Leave C calibration outside the scored records. Evidence points to the original record. Stop grades apply to repair feedback and official reward. Use null for missing measurements. Writes fresh Markdown and JSON only.');
    return;
  }
  if (!values.input || !values['output-dir']) throw new Error('--input and --output-dir are required.');
  const report = summarizeSimplifyExperiment(JSON.parse(await fs.readFile(values.input, 'utf8')));
  const contents = { json: JSON.stringify(report, null, 2) + '\n', md: markdown(report) };
  for (const key of ['RC_EVAL_API_KEY', 'RC_NATIVE_STOP_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const secret = process.env[key];
    if (secret && Object.values(contents).some(value => value.includes(secret))) throw new Error('Input contains a configured credential; no report was written.');
  }
  const destination = extension => path.join(values['output-dir'], `simplify-experiment-results.${extension}`);
  for (const extension of Object.keys(contents)) {
    if (await fs.stat(destination(extension)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
      throw new Error(`Report ${extension} already exists.`);
  }
  for (const [extension, content] of Object.entries(contents)) await fs.writeFile(destination(extension), content, { flag: 'wx' });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
