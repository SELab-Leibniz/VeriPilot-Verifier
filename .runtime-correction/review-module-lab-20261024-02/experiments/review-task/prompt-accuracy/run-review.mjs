// Review-stage experiment only. Oracles never enter the worker source root.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewTask, captureFiles } from '../long/review-task.mjs';
import { verifyCites } from '../long/verify-cites.mjs';
import { sourceRepo, newOutput, trackedState, authorizedRuntime, sha256, within } from '../long/harness-common.mjs';
import { resolveFixtureList } from './fixture-paths.mjs';
import { reviewRunExitCode } from './run-outcome.mjs';

const args = process.argv.slice(2), live = args.includes('--live');
const option = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const destination = args.find(value => !value.startsWith('--'));
if (!destination) throw new Error('Usage: node run-review.mjs NEW_OUTPUT --variant=baseline --split=dev [--cases=K01,F01] [--live]');
const repository = await sourceRepo(), before = await trackedState(repository);
const experiment = path.resolve(repository, process.env.REVIEW_EXPERIMENT_ROOT ?? '.runtime-correction/review-module-lab-20261024-02/prompt-accuracy-20261024-01');
const variant = option('variant', 'baseline'), split = option('split', 'dev'), concurrency = Number(option('concurrency', '2'));
if (!/^[a-z0-9-]+$/u.test(variant) || !['dev', 'holdout', 'all'].includes(split) || ![1, 2].includes(concurrency)) throw new Error('Invalid fixed experiment options');
const outputPath = path.resolve(experiment, destination);
if (!within(experiment, outputPath)) throw new Error('Output must be inside this experiment');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const profilePath = path.join(experiment, 'profiles', `${variant}.json`), profileBytes = await fs.readFile(profilePath), profile = JSON.parse(profileBytes);
if (profile.id !== variant || !['M01', 'M05', 'M12'].every(id => typeof profile.metricPrompts[id] === 'string')) throw new Error('Invalid prompt profile');
const frozen = await read(path.join(experiment, 'freeze.json'));
let cases = (await Promise.all(['kitchen', 'flower'].map(domain => read(path.join(experiment, 'fixtures', domain, 'cases.json'))))).flatMap(value => Array.isArray(value) ? value : value.cases);
let extensionFreezeSha256 = null;
if (args.includes('--extensions')) {
  const extensionBytes = await fs.readFile(path.join(experiment, 'freeze-extension.json'));
  const extension = JSON.parse(extensionBytes);
  extensionFreezeSha256 = sha256(extensionBytes);
  Object.assign(frozen.cases, extension.cases);
  cases.push(...extension.descriptors);
}
const selected = option('cases', null)?.split(',');
if (selected && (new Set(selected).size !== selected.length || selected.some(id => !cases.some(item => item.caseId === id)))) throw new Error('Unknown or duplicate cases');
cases = cases.filter(item => (split === 'all' || item.split === split) && (!selected || selected.includes(item.caseId)));
if (!cases.length) throw new Error('No cases selected');
cases = await resolveFixtureList(experiment, cases);
const output = await newOutput(repository, outputPath);
const save = async (file, data) => {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temporary, file);
};
const fingerprint = async item => {
  const files = [...await captureFiles(item.workspace)].sort(([a], [b]) => a.localeCompare(b));
  return { inputFingerprint: sha256(JSON.stringify(files)), taskSha256: sha256(await fs.readFile(item.task)), oracleSha256: sha256(await fs.readFile(item.oracle)) };
};
for (const item of cases) {
  if (!within(path.join(experiment, 'fixtures'), await fs.realpath(item.workspace))
    || within(item.workspace, item.task) || within(item.workspace, item.oracle)) throw new Error('Invalid fixture or visible oracle');
  if (JSON.stringify(await fingerprint(item)) !== JSON.stringify(frozen.cases[item.caseId])) throw new Error(`Frozen input changed: ${item.caseId}`);
}
await save(path.join(output, 'run.json'), { variant, split, live, caseIds: cases.map(item => item.caseId), concurrency,
  profileSha256: sha256(profileBytes), workerSha256: sha256(await fs.readFile(fileURLToPath(new URL('../long/review-task.mjs', import.meta.url)))),
  baselineCommit: '73390e0', frozenCasesSha256: sha256(await fs.readFile(path.join(experiment, 'freeze.json'))),
  extensionFreezeSha256,
  controls: { maxAttempts: 2, maxTurns: 100, perReplyMaxTokens: 8192, runTokenBudget: null, deadline: null, E2E: false }, before });
const runtime = live ? await authorizedRuntime(output) : null;
const rows = [], startedAt = Date.now();
let cursor = 0, progressWrites = Promise.resolve();
async function executeCase(item) {
  const directory = path.join(output, item.caseId); await fs.mkdir(directory);
  const task = await read(item.task), oracle = await read(item.oracle);
  const expectedVerdict = oracle.expectedVerdict ?? oracle.expected;
  if (!['PASS', 'DEVIATION', 'UNVERIFIED'].includes(expectedVerdict) || oracle.scope !== task.scope) throw new Error('Invalid frozen oracle');
  const promptAppend = profile.scopeOverrides?.[item.metricId]?.[task.scope] ?? profile.metricPrompts[item.metricId];
  const reviewType = profile.reviewTypes?.[item.metricId]?.[task.scope] ?? profile.reviewTypes?.[item.metricId]?.default ?? item.metricId;
  let row;
  try {
    if (task.metricId !== item.metricId) throw new Error('Metric identity mismatch');
    if (!live) row = { caseId: item.caseId, metricId: item.metricId, domain: item.domain, split: item.split, preflight: true };
    else {
      console.log(JSON.stringify({ phase: 'review-start', variant, caseId: item.caseId, metricId: item.metricId }));
      const result = await runReviewTask({ task, root: item.workspace, outputDir: path.join(directory, 'review'),
        modelRuntime: runtime.runtime, model: runtime.model, maxAttempts: 2, maxTurns: 100, maxTokens: 8192,
        promptAppend });
      const citations = await verifyCites(path.join(directory, 'review'));
      await save(path.join(directory, 'citation-verification.json'), citations);
      const names = (await fs.readdir(path.join(directory, 'review/sessions'))).filter(name => name.endsWith('.jsonl'));
      const entries = (await Promise.all(names.map(async name => (await fs.readFile(path.join(directory, 'review/sessions', name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat();
      const responses = entries.filter(entry => entry.message?.role === 'assistant' && !['error', 'aborted'].includes(entry.message.stopReason)).map(entry => entry.message);
      const submitted = responses.flatMap(message => message.content.filter(block => block.type === 'toolCall' && block.name === 'submit_review'));
      const sum = key => responses.reduce((total, message) => total + (message.usage?.[key] ?? 0), 0);
      row = { caseId: item.caseId, metricId: item.metricId, domain: item.domain, split: item.split,
        expectedVerdict, result, citationIntegrity: citations.passed,
        labelMatches: result.completed && result.scope === oracle.scope && result.verdict === expectedVerdict,
        semanticValidation: 'PENDING_INDEPENDENT_REVIEW',
        measured: { reviewType, promptAppendSha256: sha256(Buffer.from(promptAppend)), noncachedInputTokens: sum('input'), cacheReadTokens: sum('cacheRead'), cacheWriteTokens: sum('cacheWrite'), outputTokens: sum('output'),
          submitCalls: submitted.length, submitErrors: entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'submit_review' && entry.message.isError).length,
          maxSubmitBytes: submitted.length ? Math.max(...submitted.map(call => Buffer.byteLength(JSON.stringify(call.arguments)))) : 0,
          feedbackBytes: (await fs.readFile(path.join(directory, 'review/feedback.txt'))).length,
          promptSha256: sha256(await fs.readFile(path.join(directory, 'review/prompt.txt'))) } };
      console.log(JSON.stringify({ phase: 'review-finished', variant, caseId: item.caseId, verdict: result.verdict, submitted: result.completed,
        preliminaryLabelMatch: row.labelMatches, citeIntegrity: citations.passed, turns: result.metrics.turns, elapsedMs: result.elapsedMs }));
    }
  } catch (error) {
    row = { caseId: item.caseId, metricId: item.metricId, domain: item.domain, split: item.split, error: error.message,
      labelMatches: false, semanticValidation: 'INFRASTRUCTURE_ERROR' };
    console.log(JSON.stringify({ phase: 'review-error', variant, caseId: item.caseId, error: error.message }));
  }
  row.frozenInputUnchanged = JSON.stringify(await fingerprint(item)) === JSON.stringify(frozen.cases[item.caseId]);
  await save(path.join(directory, 'report.json'), row);
  rows.push(row);
  progressWrites = progressWrites.then(() => save(path.join(output, 'progress.json'), { variant, completed: rows.length, rows }));
  await progressWrites;
}
await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
  while (cursor < cases.length) { const item = cases[cursor++]; await executeCase(item); }
}));
await progressWrites;
const after = await trackedState(repository), repositoryUnchanged = JSON.stringify(before) === JSON.stringify(after);
const configurationUnchanged = runtime ? await runtime.unchanged() : null;
const profileUnchanged = sha256(await fs.readFile(profilePath)) === sha256(profileBytes);
const protectedInputs = repositoryUnchanged && configurationUnchanged !== false && profileUnchanged && rows.every(row => row.frozenInputUnchanged);
const report = { status: !protectedInputs ? 'INPUT_PROTECTION_FAILED' : !live ? 'PREFLIGHT_PASS'
  : rows.some(row => row.error || !row.result?.completed) ? 'REVIEW_INCOMPLETE' : 'COMPLETE_PENDING_SEMANTIC_REVIEW',
  variant, split, mode: live ? 'LIVE_REVIEW_STAGE' : 'OFFLINE_PREFLIGHT', completedCases: rows.length,
  preliminaryLabelMatches: live ? rows.filter(row => row.labelMatches && row.citationIntegrity).length : null,
  rows: rows.sort((a, b) => a.caseId.localeCompare(b.caseId)), elapsedMs: Date.now() - startedAt,
  protectedInputs, repositoryUnchanged, configurationUnchanged, profileUnchanged, before, after,
  originalProjectOrSessionWritten: false, businessExecution: false, productionStopIntegrated: false,
  limitation: 'Label agreement and byte integrity are preliminary. Independent diagnosis support is required. Selected object results are not whole-metric or project acceptance.' };
await save(path.join(output, 'report.json'), report);
console.log(JSON.stringify({ status: report.status, output, cases: rows.length, preliminaryLabelMatches: report.preliminaryLabelMatches }));
process.exitCode = reviewRunExitCode({ protectedInputs, live, rows });
