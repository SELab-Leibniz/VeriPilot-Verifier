// Offline aggregation only. Never imports the worker, runtime, model SDK or auth.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveFixtureList, resolveFixturePaths } from './fixture-paths.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('Usage: node summarize.mjs [--exp PATH | --exp=PATH]\nWrites EXP/summary.json, EXP/reuse-ledger.json and EXP/results.md only after all final reports and independent audits are present. Existing outputs are never overwritten.');
  process.exit(0);
}
let experiment = fileURLToPath(new URL('../../../prompt-accuracy-20261024-01/', import.meta.url));
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--exp' && argv[i + 1]) experiment = argv[++i];
  else if (argv[i].startsWith('--exp=')) experiment = argv[i].slice(6);
  else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
}
const EXP = await fs.realpath(path.resolve(experiment));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = new Map();
async function bytes(file) {
  const absolute = path.resolve(EXP, file);
  const value = await fs.readFile(absolute); // explicit paths; no runtime/auth discovery
  const digest = hash(value);
  if (sources.has(absolute)) assert.equal(sources.get(absolute), digest, `Source changed while reading: ${absolute}`);
  sources.set(absolute, digest);
  return value;
}
const json = async file => JSON.parse((await bytes(file)).toString('utf8'));
const sorted = values => [...values].sort((a, b) => a.localeCompare(b));
function sameIds(actual, expected, context) {
  assert.equal(new Set(actual).size, actual.length, `Duplicate case IDs: ${context}`);
  assert.deepEqual(sorted(actual), sorted(expected), `Unexpected or missing cases: ${context}`);
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function snapshot(root) {
  const result = [];
  const realRoot = await fs.realpath(root);
  assert(inside(path.join(EXP, 'fixtures'), realRoot), `Workspace outside frozen fixtures: ${root}`);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected fixture symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const value = await bytes(absolute);
        result.push([path.relative(realRoot, absolute).replaceAll('\\', '/'), { sha256: hash(value), lines: value.toString('utf8').split('\n').length }]);
      }
    }
  }
  await visit(realRoot);
  return result.sort(([a], [b]) => a.localeCompare(b));
}

const freeze = await json('freeze.json');
const extension = await json('freeze-extension.json');
assert.equal(extension.initialFreezeSha256, hash(await bytes('freeze.json')));
const descriptors = (await Promise.all(['kitchen', 'flower'].map(domain => json(`fixtures/${domain}/cases.json`))))
  .flatMap(value => Array.isArray(value) ? value : value.cases);
descriptors.push(...extension.descriptors);
const catalog = await resolveFixtureList(EXP, descriptors);
sameIds(catalog.map(item => item.caseId), [...Object.keys(freeze.cases), ...Object.keys(extension.cases)], 'frozen catalog');
assert.equal(catalog.length, 21);
const frozen = new Map();
for (const descriptor of catalog) {
  const task = await json(descriptor.task), oracle = await json(descriptor.oracle);
  const files = await snapshot(descriptor.workspace);
  const fingerprint = { inputFingerprint: hash(JSON.stringify(files)), taskSha256: hash(await bytes(descriptor.task)), oracleSha256: hash(await bytes(descriptor.oracle)) };
  assert.deepEqual(fingerprint, freeze.cases[descriptor.caseId] ?? extension.cases[descriptor.caseId], `Frozen input changed: ${descriptor.caseId}`);
  assert.equal(task.metricId, descriptor.metricId);
  assert.equal(task.scope, oracle.scope);
  frozen.set(descriptor.caseId, { ...descriptor, task, oracle, files, fingerprint });
}
const profileNames = ['baseline', 'rubric-v1', 'rubric-v2', 'selected'];
const profiles = Object.fromEntries(await Promise.all(profileNames.map(async name => [name, await json(`profiles/${name}.json`)])));
const profileHash = Object.fromEntries(await Promise.all(profileNames.map(async name => [name, hash(await bytes(`profiles/${name}.json`))])));
const selection = await json('development-selection.json');
assert.equal(selection.selectedSha256, profileHash.selected);
assert.equal(extension.selectedProfileSha256, profileHash.selected);
assert.equal(profiles.selected.metricPrompts.M01, profiles['rubric-v1'].metricPrompts.M01);
assert.equal(profiles.selected.metricPrompts.M05, profiles.baseline.metricPrompts.M05);
assert.equal(profiles.selected.metricPrompts.M12, profiles['rubric-v2'].metricPrompts.M12);
assert.equal(profiles.selected.scopeOverrides?.M12?.RUNTIME_ACCEPTANCE, profiles.baseline.metricPrompts.M12);
for (const metric of ['M01', 'M05', 'M12']) assert.equal(profiles.baseline.metricPrompts[metric], '');
const appendFor = (profile, task) => profile.scopeOverrides?.[task.metricId]?.[task.scope] ?? profile.metricPrompts[task.metricId];

const dev = freeze.developmentCases;
const originalHoldout = freeze.holdoutCases;
const extensionIds = Object.keys(extension.cases);
const plans = [
  { run: 'baseline-dev-01', variant: 'baseline', partition: 'development', tags: ['A1', 'A2'], ids: dev },
  { run: 'rubric-v1-dev-01', variant: 'rubric-v1', partition: 'development', tags: ['B1', 'B2'], ids: dev },
  { run: 'rubric-v2-dev-01', variant: 'rubric-v2', partition: 'development', tags: ['C1', 'C2'], ids: dev.filter(id => frozen.get(id).metricId !== 'M01') },
  { run: 'baseline-holdout-01', variant: 'baseline', partition: 'original-holdout', tags: ['D1', 'D2'], ids: originalHoldout },
  { run: 'selected-holdout-01', variant: 'selected', partition: 'original-holdout', tags: ['E1', 'E2'], ids: ['K03', 'F03'] },
  { run: 'baseline-extension-01', variant: 'baseline', partition: 'prospective-extension', tags: ['G1', 'G2'], ids: extensionIds },
  { run: 'selected-extension-01', variant: 'selected', partition: 'prospective-extension', tags: ['H1', 'H2'], ids: extensionIds },
];
const ORIGINAL_SYSTEM_HASH = 'd7e8379fd3977e5307cf6a464b303c8b6270e940bd6d0e0a05a64d94370fa695';
const ORIGINAL_SYSTEM_BYTES = 1894;
const rawReports = {}, allRows = [], byKey = new Map(), reviewDirectories = new Set();
let originalSystem;
for (const plan of plans) {
  // A missing final report is fatal: progress.json is deliberately never a fallback.
  const run = await json(`${plan.run}/run.json`), report = await json(`${plan.run}/report.json`);
  assert.equal(run.variant, plan.variant); assert.equal(report.variant, plan.variant);
  assert.equal(run.live, true); assert.equal(report.mode, 'LIVE_REVIEW_STAGE');
  assert.equal(run.profileSha256, profileHash[plan.variant]);
  assert.equal(run.frozenCasesSha256, hash(await bytes('freeze.json')));
  if (plan.partition === 'prospective-extension') assert.equal(run.extensionFreezeSha256, hash(await bytes('freeze-extension.json')));
  sameIds(run.caseIds, plan.ids, `${plan.run}/run.json`);
  sameIds(report.rows.map(row => row.caseId), plan.ids, `${plan.run}/report.json`);
  rawReports[plan.run] = { status: report.status, variant: report.variant, split: report.split, completedCases: report.completedCases,
    elapsedMs: report.elapsedMs, protectedInputs: report.protectedInputs, repositoryUnchanged: report.repositoryUnchanged,
    configurationUnchanged: report.configurationUnchanged, profileUnchanged: report.profileUnchanged,
    originalProjectOrSessionWritten: report.originalProjectOrSessionWritten, businessExecution: report.businessExecution,
    productionStopIntegrated: report.productionStopIntegrated, runControls: run.controls, workerSha256: run.workerSha256 };
  const judgments = new Map();
  for (const tag of plan.tags) {
    const audit = await json(`semantic-audits/${tag}.json`), packet = await json(`semantic-input/${tag}.json`);
    assert.equal(audit.tag, tag); assert.equal(packet.tag, tag);
    sameIds(audit.cases.map(item => item.caseId), packet.rows.map(item => item.caseId), `audit ${tag}`);
    for (const item of audit.cases) {
      assert(!judgments.has(item.caseId), `Duplicate audit ${tag}/${item.caseId}`);
      for (const flag of ['labelCorrect', 'diagnosisSupported', 'scopeCorrect', 'groundedCorrect']) assert.equal(typeof item[flag], 'boolean', `${tag}/${item.caseId}/${flag}`);
      judgments.set(item.caseId, { tag, judgment: item, packet: packet.rows.find(row => row.caseId === item.caseId) });
    }
  }
  sameIds([...judgments.keys()], plan.ids, `${plan.run} semantic judgments`);
  for (const row of report.rows) {
    const key = `${plan.run}/${row.caseId}`;
    assert(!byKey.has(key), `Duplicate actual review: ${key}`);
    assert.deepEqual(await json(`${key}/report.json`), row, `Root/case report mismatch: ${key}`);
    const fixture = frozen.get(row.caseId), audited = judgments.get(row.caseId), result = row.result;
    assert.equal(row.metricId, fixture.metricId); assert.equal(row.domain, fixture.domain);
    assert.deepEqual(audited.packet.task, fixture.task, `Audit task mismatch: ${key}`);
    assert.deepEqual(audited.packet.oracle, fixture.oracle, `Audit oracle mismatch: ${key}`);
    const packetFixture = await resolveFixturePaths(EXP, { caseId: row.caseId, domain: row.domain, workspace: audited.packet.inputWorkspace });
    assert.equal(packetFixture.workspace, fixture.workspace, `Historical audit workspace identity mismatch: ${key}`);
    assert.deepEqual(audited.packet.actual, { completed: result?.completed ?? false, scope: result?.scope ?? null,
      verdict: result?.verdict ?? null, reason: result?.reason ?? row.error, refs: result?.refs ?? [], citationIntegrity: row.citationIntegrity ?? false }, `Audit does not bind to actual result: ${key}`);
    const completed = result?.completed === true;
    let promptInfo = null, eventErrors = [], overflowEvents = [], usage = null, feedbackBound = null;
    if (result) {
      const directory = await fs.realpath(path.join(EXP, key, 'review'));
      assert(!reviewDirectories.has(directory), `Reused artifact counted as another actual call: ${key}`);
      reviewDirectories.add(directory);
      const input = await json(`${key}/review/input.json`);
      assert.deepEqual(input.task, fixture.task, `Actual task differs: ${key}`);
      assert.equal(input.model?.id, 'deepseek-v4-flash', `Model differs: ${key}`);
      assert.equal(input.model?.contextWindow, 204800, `Model context window differs: ${key}`);
      assert.deepEqual([...input.files].sort(([a], [b]) => a.localeCompare(b)), fixture.files, `Actual workspace differs: ${key}`);
      const prompt = (await bytes(`${key}/review/prompt.txt`)).toString('utf8');
      const boundary = prompt.lastIndexOf('\n\n{"task":');
      assert(boundary > 0, `Missing actual task prompt: ${key}`);
      const system = prompt.slice(0, boundary), taskPrompt = JSON.parse(prompt.slice(boundary + 2));
      assert.deepEqual(taskPrompt.task, fixture.task);
      const append = appendFor(profiles[plan.variant], fixture.task);
      assert.equal(typeof append, 'string');
      const base = append ? system.slice(0, -(append.length + 1)) : system;
      assert.equal(system, base + (append ? `\n${append}` : ''), `Actual append differs: ${key}`);
      assert.equal(Buffer.byteLength(base), ORIGINAL_SYSTEM_BYTES, `Original prompt byte count: ${key}`);
      assert.equal(hash(base), ORIGINAL_SYSTEM_HASH, `Original six-paragraph prompt changed: ${key}`);
      originalSystem ??= base; assert.equal(base, originalSystem);
      assert.equal(hash(prompt), row.measured.promptSha256, `Actual prompt hash differs: ${key}`);
      if (row.measured.promptAppendSha256 != null) assert.equal(hash(append), row.measured.promptAppendSha256);
      promptInfo = { originalSystemSha256: hash(base), originalSystemBytes: Buffer.byteLength(base), appendSha256: hash(append), appendBytes: Buffer.byteLength(append), actualPromptSha256: hash(prompt), actualTaskMatchesFrozen: true, actualWorkspaceMatchesFrozen: true };
      const feedback = await bytes(`${key}/review/feedback.txt`);
      assert.equal(feedback.length, row.measured.feedbackBytes, `Feedback byte measurement differs: ${key}`);
      const diagnostic = Buffer.byteLength(result.reason) <= 600 ? result.reason : 'Diagnosis exceeds the inline limit; read the result file.';
      const historicalPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(result.artifacts) ? path.win32 : path.posix;
      const resultPath = historicalPath.join(result.artifacts, 'result.json');
      const expectedFeedback = `${fixture.task.id} | ${result.verdict} | ${diagnostic}\nDetails: ${resultPath}\n`;
      assert.equal(feedback.toString('utf8'), expectedFeedback, `Feedback envelope differs: ${key}`);
      feedbackBound = Buffer.byteLength(`${fixture.task.id} | ${result.verdict} | \nDetails: ${resultPath}\n`) + 600;
      assert(feedback.length <= feedbackBound);
      const eventsText = (await bytes(`${key}/review/events.jsonl`)).toString('utf8').trim();
      const events = eventsText ? eventsText.split(/\r?\n/u).map(JSON.parse) : [];
      eventErrors = events.filter(event => event.type === 'assistant' && event.stopReason === 'error');
      overflowEvents = events.filter(event => /context.{0,15}(overflow|length|exceed)|maximum context|CONTEXT_UNSAFE|CONTEXT_COMPACTION_FAILED/iu.test(String(event.error ?? '')));
      const measured = row.measured;
      const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      for (const name of ['noncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'submitCalls', 'submitErrors', 'maxSubmitBytes', 'feedbackBytes']) assert(validNumber(measured[name]), `Missing usage ${key}/${name}`);
      usage = { inputTokensIncludingCache: measured.noncachedInputTokens + measured.cacheReadTokens + measured.cacheWriteTokens,
        inputTokensExcludingCache: measured.noncachedInputTokens, cacheReadTokens: measured.cacheReadTokens, cacheWriteTokens: measured.cacheWriteTokens,
        outputTokens: measured.outputTokens, totalTokensIncludingCache: measured.noncachedInputTokens + measured.cacheReadTokens + measured.cacheWriteTokens + measured.outputTokens,
        totalTokensExcludingCache: measured.noncachedInputTokens + measured.outputTokens, turns: result.metrics.turns,
        attempts: result.attempts, elapsedMs: result.elapsedMs, toolCalls: result.metrics.toolCalls, repeatedLines: result.metrics.repeatedLines,
        compactions: result.metrics.compactions, compactionFailures: result.metrics.compactionFailures, unsafeRequestsPrevented: result.metrics.unsafeRequestsPrevented,
        submitCalls: measured.submitCalls, submitErrors: measured.submitErrors, maxSubmitBytes: measured.maxSubmitBytes, feedbackBytes: measured.feedbackBytes };
    }
    const semantic = audited.judgment;
    const evaluation = { completed, labelCorrect: completed && semantic.labelCorrect, diagnosisSupported: completed && semantic.diagnosisSupported,
      scopeCorrect: completed && semantic.scopeCorrect, citationIntegrity: row.citationIntegrity === true,
      auditGroundedCorrect: semantic.groundedCorrect,
      groundedCorrect: completed && semantic.labelCorrect && semantic.diagnosisSupported && semantic.scopeCorrect && semantic.groundedCorrect && row.citationIntegrity === true && row.frozenInputUnchanged === true,
      oracleLabelAgreement: completed && result.verdict === (fixture.oracle.expectedVerdict ?? fixture.oracle.expected),
      infrastructureFailure: Boolean(row.error) || !completed, providerErrorEvents: eventErrors.length, overflowEvents: overflowEvents.length };
    const merged = { executionId: key, run: plan.run, variant: plan.variant, partition: plan.partition, caseId: row.caseId, metricId: row.metricId,
      domain: row.domain, proofScope: fixture.task.scope, expectedVerdict: fixture.oracle.expectedVerdict ?? fixture.oracle.expected,
      actualVerdict: result?.verdict ?? null, reason: result?.reason ?? row.error, originalSemanticValidation: row.semanticValidation,
      frozenInputUnchanged: row.frozenInputUnchanged, evaluation, semanticAudit: { tag: audited.tag, ...semantic }, prompt: promptInfo, usage,
      inlineDiagnosticByteLimit: 600, feedbackEnvelopeByteBound: feedbackBound };
    byKey.set(key, merged); allRows.push(merged);
  }
}
assert.equal(allRows.length, 46, 'Expected 32 development + 8 original holdout + 6 extension actual reviews');
assert.equal(new Set(allRows.map(row => row.executionId)).size, 46, 'Actual calls are not deduplicated');
const allCompleted = allRows.every(row => row.evaluation.completed);
if (allCompleted) assert.equal(reviewDirectories.size, 46, 'Completed calls share artifact directories');
assert.equal(new Set(Object.values(rawReports).map(report => report.workerSha256)).size, 1, 'Worker versions differ');

function aggregate(rows) {
  const count = field => rows.filter(row => row.evaluation[field]).length;
  const total = field => rows.every(row => typeof row.usage?.[field] === 'number') ? rows.reduce((sum, row) => sum + row.usage[field], 0) : null;
  const maximum = field => rows.length && rows.every(row => typeof row.usage?.[field] === 'number') ? Math.max(...rows.map(row => row.usage[field])) : null;
  return { cases: rows.length, completed: count('completed'), labelCorrect: count('labelCorrect'), diagnosisSupported: count('diagnosisSupported'),
    scopeCorrect: count('scopeCorrect'), groundedCorrect: count('groundedCorrect'), citationIntegrity: count('citationIntegrity'),
    incorrectPasses: rows.filter(row => row.actualVerdict === 'PASS' && !row.evaluation.labelCorrect).length,
    falseAlarms: rows.filter(row => row.expectedVerdict === 'PASS' && row.actualVerdict === 'DEVIATION').length,
    missedDeviations: rows.filter(row => row.expectedVerdict === 'DEVIATION' && row.actualVerdict !== 'DEVIATION').length,
    excessiveAbstentions: rows.filter(row => row.actualVerdict === 'UNVERIFIED' && row.evaluation.completed && !row.evaluation.labelCorrect).length,
    correctUnverified: rows.filter(row => row.actualVerdict === 'UNVERIFIED' && row.evaluation.groundedCorrect).length,
    infrastructureFailures: count('infrastructureFailure'), overflowEvents: rows.reduce((sum, row) => sum + row.evaluation.overflowEvents, 0),
    providerErrorEvents: rows.reduce((sum, row) => sum + row.evaluation.providerErrorEvents, 0),
    usage: Object.fromEntries(['inputTokensIncludingCache', 'inputTokensExcludingCache', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
      'totalTokensIncludingCache', 'totalTokensExcludingCache', 'turns', 'attempts', 'elapsedMs', 'toolCalls', 'repeatedLines', 'compactions',
      'compactionFailures', 'unsafeRequestsPrevented', 'submitCalls', 'submitErrors'].map(field => [field, total(field)])),
    maximumFeedbackBytes: maximum('feedbackBytes'), maximumSubmitBytes: maximum('maxSubmitBytes'), inlineDiagnosticByteLimit: 600,
    maximumFeedbackEnvelopeByteBound: rows.length ? Math.max(...rows.map(row => row.feedbackEnvelopeByteBound ?? 0)) : null,
    missingUsageCases: rows.filter(row => !row.usage).map(row => row.executionId),
    actualExecutionIds: rows.map(row => row.executionId) };
}
function group(rows, key) {
  return Object.fromEntries([...new Set(rows.map(row => row[key]))].sort().map(value => [value, aggregate(rows.filter(row => row[key] === value))]));
}
const get = (run, id) => { const row = byKey.get(`${run}/${id}`); assert(row, `Missing view source: ${run}/${id}`); return row; };
const selectedDev = dev.map(id => get(({ M01: 'rubric-v1-dev-01', M05: 'baseline-dev-01', M12: 'rubric-v2-dev-01' })[frozen.get(id).metricId], id));
assert.equal(selectedDev.length, 12);
const reuse = [];
const selectedHoldout = originalHoldout.map(id => {
  if (['K03', 'F03'].includes(id)) return get('selected-holdout-01', id);
  const row = get('baseline-holdout-01', id), fixture = frozen.get(id);
  assert(['K06', 'K09', 'F06', 'F09'].includes(id));
  assert.equal(appendFor(profiles.selected, fixture.task), '', `Selected holdout route is not empty: ${id}`);
  assert.equal(row.prompt.appendBytes, 0);
  assert.equal(row.prompt.originalSystemSha256, ORIGINAL_SYSTEM_HASH);
  reuse.push({ caseId: id, sourceExecutionId: row.executionId, selectedView: 'selected-original-holdout', newlyExecuted: false,
    taskSha256: fixture.fingerprint.taskSha256, workspaceFingerprint: fixture.fingerprint.inputFingerprint,
    actualTaskMatchesFrozen: row.prompt.actualTaskMatchesFrozen, actualWorkspaceMatchesFrozen: row.prompt.actualWorkspaceMatchesFrozen,
    actualOriginalSystemSha256: row.prompt.originalSystemSha256, actualOriginalSystemBytes: row.prompt.originalSystemBytes,
    actualPromptSha256: row.prompt.actualPromptSha256, baselineAppendBytes: 0, selectedAppendBytes: 0,
    selectedWouldRenderIdenticalPrompt: true, reason: '同一冻结 task/workspace；实际原六段提示基段逐字节核验，selected 该路由 append 为空，因此复用既有 baseline 调用。' });
  return row;
});
sameIds(selectedHoldout.map(row => row.caseId), originalHoldout, 'selected original holdout view');
assert.equal(reuse.length, 4);
const devLedger = selectedDev.map(row => ({ caseId: row.caseId, metricId: row.metricId, sourceExecutionId: row.executionId,
  selectedView: 'selected-development-post-hoc', newlyExecuted: false, sourceVariant: row.variant,
  reason: '开发集事后按 M01=v1、M05=baseline、M12=v2 组合；不是新的 12 次模型调用。' }));
const revision = await json('fixtures/flower/F10/oracle-revision.json');
assert.equal(revision.initialExpected, 'PASS'); assert.equal(revision.finalExpected, 'DEVIATION');
assert.equal(hash(await bytes('fixtures/flower/F10/oracle-initial-rejected.json')), revision.initialOracleSha256);
assert.equal(hash(await bytes('fixtures/flower/F10/oracle.json')), revision.finalOracleSha256);
assert.equal(extension.cases.F10.oracleSha256, revision.finalOracleSha256);
if (revision.beforeAnyModelRun !== undefined) assert.equal(revision.beforeAnyModelRun, true);
const limitations = [
  '只评冻结单对象的 Review 阶段，不代表整个 M01/M05/M12 分母、完整 15 指标或项目验收。',
  '开发集用于选择提示，selected 开发 12 例是已有调用的事后组合，不能作为新增独立验证或新的 12 次调用。',
  '原复核 selected 6 例仅 2 例新运行、4 例经 task/workspace 与实际原提示及空 append 核验后复用；不重复计费或计数。',
  '扩展 K10/F10/F11 在开发选择后预先设定，是前瞻风险探针，但并非独立随机样本，不并入原 6 例复核分母。',
  'F10 初始 PASS oracle 在任何该扩展模型复核前被独立反例否决并改为 DEVIATION；原 oracle 与修订证据保留。',
  '小样本、每条件一次运行；观察到的回合/token 差异不是因果效率估计，不可估计生产稳定率或普遍准确率。',
  '状态标签、诊断机制支持、范围、引用字节完整性分别记录；有正确标签仍可能因理由不支持而 grounded 错误。',
  'UNVERIFIED 只有完成提交且缺少正确类型证明才计准确；不是业务 PASS。基础设施未提交另列。',
  'token 是现有报告记录的评审模型用量；不包含主会话、独立语义审计或其他工具成本。累计输入含逐回合历史，不是唯一文本量。',
  '四类 reviewer 是配置与共享 review engine 的实验路由，尚未集成生产流程。',
];
const views = {
  baselineDevelopment: aggregate(allRows.filter(row => row.run === 'baseline-dev-01')),
  rubricV1Development: aggregate(allRows.filter(row => row.run === 'rubric-v1-dev-01')),
  rubricV2Development: aggregate(allRows.filter(row => row.run === 'rubric-v2-dev-01')),
  selectedDevelopmentPostHoc: { ...aggregate(selectedDev), compositionOnly: true, newActualCalls: 0, byMetric: group(selectedDev, 'metricId') },
  baselineOriginalHoldout: aggregate(allRows.filter(row => row.run === 'baseline-holdout-01')),
  selectedOriginalHoldout: { ...aggregate(selectedHoldout), newActualCalls: 2, reusedActualCalls: 4, byMetric: group(selectedHoldout, 'metricId') },
  baselineProspectiveExtension: aggregate(allRows.filter(row => row.run === 'baseline-extension-01')),
  selectedProspectiveExtension: aggregate(allRows.filter(row => row.run === 'selected-extension-01')),
};
const summary = { schemaVersion: 'prompt-accuracy-summary.v1', createdAt: new Date().toISOString(), experiment: EXP,
  status: allCompleted ? 'COMPLETE_WITH_INDEPENDENT_SEMANTIC_REVIEW' : 'INCOMPLETE_REVIEW_RECORDED',
  originalReportsUnmodified: true, actualCalls: { total: 46, development: 32, originalHoldout: 8, prospectiveExtension: 6,
    completed: allRows.filter(row => row.evaluation.completed).length, distinctExecutionIds: byKey.size, distinctCompletedArtifactDirectories: reviewDirectories.size,
    selectedDevelopmentAdditionalCalls: 0, selectedOriginalHoldoutNewCalls: 2, selectedOriginalHoldoutReusedCalls: 4 },
  modelControl: { modelId: 'deepseek-v4-flash', contextWindow: 204800, verifiedAgainstEveryActualInput: true },
  reviewAgentConfiguration: { types: ['requirement-decomposition-reviewer', 'acceptance-coverage-reviewer', 'source-implementation-reviewer', 'runtime-evidence-reviewer'],
    sharedReviewEngine: true, productionIntegrated: false },
  scoring: { labelCorrect: '已完成提交且独立审计判定状态标签正确。', diagnosisSupported: '独立审计确认完整理由机制由实际证据支持。',
    groundedCorrect: 'completed AND labelCorrect AND diagnosisSupported AND scopeCorrect AND audit.groundedCorrect AND citationIntegrity AND frozenInputUnchanged',
    tokenDefinition: '含缓存输入=noncachedInput+cacheRead+cacheWrite；不含缓存总token=noncachedInput+output；含缓存总token=含缓存输入+output。' },
  overallActualExecutions: aggregate(allRows), views, byRun: Object.fromEntries(plans.map(plan => [plan.run, { ...aggregate(allRows.filter(row => row.run === plan.run)),
    byMetric: group(allRows.filter(row => row.run === plan.run), 'metricId'), byProofScope: group(allRows.filter(row => row.run === plan.run), 'proofScope'),
    byDomain: group(allRows.filter(row => row.run === plan.run), 'domain') }])),
  rawReportStatusAndProtection: rawReports, selection: { selectedProfileSha256: profileHash.selected, decisions: selection.decisions },
  prospectiveExtension: { caseIds: extensionIds, freezeCreatedAt: extension.createdAt, separateFromOriginalHoldout: true, nonIndependentRandomSample: true,
    preModelOracleCorrection: { caseId: 'F10', initialExpected: 'PASS', finalExpected: 'DEVIATION', initialOracleSha256: revision.initialOracleSha256,
      finalOracleSha256: revision.finalOracleSha256, revisionFile: 'fixtures/flower/F10/oracle-revision.json', reason: revision.reason } },
  limitations, cases: allRows, sourceManifest: [...sources].map(([file, sha256]) => ({ path: path.relative(EXP, file).replaceAll('\\', '/'), sha256 })) };
const reuseLedger = { schemaVersion: 'prompt-accuracy-reuse-ledger.v1', createdAt: summary.createdAt, actualCallsDeduplicated: 46,
  selectedDevelopment: { compositionOnly: true, caseCount: 12, newActualCalls: 0, entries: devLedger },
  selectedOriginalHoldout: { caseCount: 6, newlyExecuted: ['selected-holdout-01/K03', 'selected-holdout-01/F03'], reused: reuse },
  note: '视图成本可用于配对观察；实际总成本只汇总去重的 46 个 executionId。开发组合和复核复用均不另加模型调用。' };

const number = value => value == null ? '未记录' : value.toLocaleString('en-US');
const describe = (label, view) => `- ${label}：标签正确 ${view.labelCorrect}/${view.cases}；诊断支持 ${view.diagnosisSupported}/${view.cases}；grounded 正确 ${view.groundedCorrect}/${view.cases}。回合 ${number(view.usage.turns)}，输入 token 含缓存/不含缓存 ${number(view.usage.inputTokensIncludingCache)}/${number(view.usage.inputTokensExcludingCache)}，输出 ${number(view.usage.outputTokens)}，总 token 含缓存/不含缓存 ${number(view.usage.totalTokensIncludingCache)}/${number(view.usage.totalTokensExcludingCache)}；submitErrors ${number(view.usage.submitErrors)}，最大反馈 ${number(view.maximumFeedbackBytes)} byte。`;
const protectionFailures = Object.entries(rawReports).filter(([, report]) => report.protectedInputs !== true || report.repositoryUnchanged !== true || report.configurationUnchanged !== true || report.profileUnchanged !== true || report.originalProjectOrSessionWritten !== false || report.businessExecution !== false);
const issueRows = allRows.filter(row => !row.evaluation.groundedCorrect);
const results = [
  '# 指标 Review Prompt 对照结果', '',
  `实际去重评审 ${allRows.length} 次：开发 32、原复核 8、扩展 6；已提交 ${summary.actualCalls.completed} 次。未改写原报告的 pending 状态；独立语义结论仅合并到 summary.json。`, '',
  '## 开发与选择', '', describe('baseline 开发', views.baselineDevelopment), describe('rubric-v1 开发', views.rubricV1Development),
  describe('rubric-v2 开发（仅 M05/M12，8 例）', views.rubricV2Development), describe('selected 开发事后组合', views.selectedDevelopmentPostHoc), '',
  'selected 开发 12 例由 M01=v1、M05=baseline、M12=v2 的既有结果组合；新增调用为 0，不能当作新的 12 次验证。选择依据是开发集，未把复核结果用于该轮调优。', '',
  '## 原始复核', '', describe('baseline 原复核', views.baselineOriginalHoldout), describe('selected 原复核视图', views.selectedOriginalHoldout), '',
  'selected 的 K03/F03 使用 selected-holdout 新运行；K06/K09/F06/F09 复用 baseline-holdout。脚本核验相同冻结 task/workspace、实际原六段提示的 1894 byte 与 SHA，以及 selected 对应 append 为空；详细证据在 reuse-ledger.json。', '',
  '## 前瞻扩展', '', describe('baseline 扩展', views.baselineProspectiveExtension), describe('selected 扩展', views.selectedProspectiveExtension), '',
  'K10/F10/F11 另列为 3 个开发选择后冻结的风险探针，不加入原复核 6 例分母。F10 的初始 PASS oracle 在任何该扩展模型复核前被独立反例纠正为 DEVIATION，初始文件及修订保留。该集合不是独立随机样本。', '',
  '## 提交、资源与保护', '', describe('全部 46 次实际执行（只计一次）', summary.overallActualExecutions),
  `- 基础设施失败 ${summary.overallActualExecutions.infrastructureFailures}；overflow 事件 ${summary.overallActualExecutions.overflowEvents}；provider 错误事件 ${summary.overallActualExecutions.providerErrorEvents}；compaction 失败 ${number(summary.overallActualExecutions.usage.compactionFailures)}；unsafe 请求预防 ${number(summary.overallActualExecutions.usage.unsafeRequestsPrevented)}。`,
  `- 内联诊断上限 600 UTF-8 byte；最大完整反馈 ${number(summary.overallActualExecutions.maximumFeedbackBytes)} byte，按本批路径计算的反馈封套上界 ${number(summary.overallActualExecutions.maximumFeedbackEnvelopeByteBound)} byte（含任务、状态、Details 路径及换行）。`,
  `- 各 run 的输入、仓库、宿主配置与 profile 保护检查${protectionFailures.length ? `有 ${protectionFailures.length} 项 run 异常，见 summary.json` : '全部为 true'}；业务执行和原项目/session 写入标志保留原报告值，未由汇总脚本推断替代。`, '',
  '## 标签与理由分开判断', '',
  ...issueRows.map(row => `- ${row.executionId}：${row.actualVerdict}（预期 ${row.expectedVerdict}），label=${row.evaluation.labelCorrect}，diagnosis=${row.evaluation.diagnosisSupported}，scope=${row.evaluation.scopeCorrect}，grounded=${row.evaluation.groundedCorrect}；证据与审计说明见 ${row.semanticAudit.tag}/${row.caseId}。`),
  ...(issueRows.length ? [] : ['- 所有实际结果均得到独立理由与引用支持。']), '',
  '## 解释范围', '', ...limitations.map(item => `- ${item}`), '',
].join('\n');

// Fail before writing if any source moved, disappeared, changed, or any output exists.
for (const [file, digest] of sources) assert.equal(hash(await fs.readFile(file)), digest, `Input changed during aggregation: ${file}`);
const output = [['summary.json', JSON.stringify(summary, null, 2) + '\n'], ['reuse-ledger.json', JSON.stringify(reuseLedger, null, 2) + '\n'], ['results.md', results]];
for (const [name] of output) {
  try { await fs.lstat(path.join(EXP, name)); throw new Error(`Output already exists; refusing overwrite: ${name}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const [name, content] of output) await fs.writeFile(path.join(EXP, name), content, { flag: 'wx' });
console.log(JSON.stringify({ status: summary.status, actualCalls: 46, completed: summary.actualCalls.completed, outputs: output.map(([name]) => path.join(EXP, name)) }));
