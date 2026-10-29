import fs from 'node:fs/promises';
import path from 'node:path';
const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8);
if (!input) throw new Error('--input=<comparison results.json> required');
const report = JSON.parse(await fs.readFile(input, 'utf8'));
const arms = {};
for (const name of ['baseline', 'candidate']) {
  const rows = report.results.filter(row => row.arm === name);
  const score = { planned: report.cases.length, recorded: rows.length, executed: 0, resolved: 0, infrastructureComplete: 0,
    businessCompletions: 0, rcReviewAttempts: 0, rcReviewCompletedCases: 0, reviewStatuses: {},
    f2pPassed: 0, f2pExpected: 0, p2pPassed: 0, p2pExpected: 0, macroF2p: 0, macroP2p: 0,
    elapsedMs: 0, missingTimingCases: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, missingUsage: 0, missingUsageFields: 0, missingSessions: 0, incompleteProviderCoverageCases: 0 };
  for (const row of rows) {
    const grade = row.grade?.results[0];
    if (row.nativeComplete) score.infrastructureComplete++;
    if (grade?.executed) {
      score.executed++; if (grade.resolved) score.resolved++;
      for (const group of ['f2p', 'p2p']) {
        score[`${group}Passed`] += grade[group].passed.length; score[`${group}Expected`] += grade[group].expected;
        score[`macro${group === 'f2p' ? 'F2p' : 'P2p'}`] += grade[group].passRate;
      }
    }
    if (row.usage) {
      if (row.usage.providerUsageCoverage?.complete !== true) score.incompleteProviderCoverageCases++;
      if (row.usage.authoritativeBusinessCompletion === true) score.businessCompletions++;
      if (row.usage.nativeRuns?.some(run => run.role === 'stop-reviewer')) score.rcReviewAttempts++;
      if (row.usage.nativeRuns?.some(run => run.role === 'stop-reviewer' && run.protocolCompleted)) score.rcReviewCompletedCases++;
      const status = row.usage.reviewStatus ?? 'NO_REVIEW'; score.reviewStatuses[status] = (score.reviewStatuses[status] ?? 0) + 1;
      if (Number.isFinite(row.usage.elapsedMs) && row.usage.elapsedMs >= 0) score.elapsedMs += row.usage.elapsedMs;
      else score.missingTimingCases++;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'missingUsage']) score[key] += row.usage.totals[key];
      score.missingSessions += row.usage.sessions.filter(row => row.missing).length;
      score.missingUsageFields += row.usage.sessions.reduce((sum, session) => sum + Object.entries(session)
        .filter(([key]) => /^(?:input|output|cacheRead|cacheWrite|totalTokens)Missing$/u.test(key)).reduce((n, [, count]) => n + count, 0), 0);
    } else score.missingSessions++;
  }
  const allExecuted = score.executed === score.planned;
  score.f2p = allExecuted && score.f2pExpected ? score.f2pPassed / score.f2pExpected : null;
  score.p2p = allExecuted && score.p2pExpected ? score.p2pPassed / score.p2pExpected : null;
  score.macroF2p = allExecuted && score.executed ? score.macroF2p / score.executed : null;
  score.macroP2p = allExecuted && score.executed ? score.macroP2p / score.executed : null;
  arms[name] = score;
}
const completePairs = report.cases.filter(id => ['baseline', 'candidate'].every(arm => report.results.some(row => row.id === id && row.arm === arm && row.grade?.results[0]?.executed)));
const complete = report.state === 'SETTLED' && completePairs.length === report.cases.length
  && Object.values(arms).every(row => row.businessCompletions === row.planned);
const strictlyHigherObservedAccuracy = complete && arms.candidate.f2p > arms.baseline.f2p && arms.candidate.p2p > arms.baseline.p2p;
const completeAccounting = complete && Object.values(arms).every(row => !row.missingUsage && !row.missingUsageFields && !row.missingSessions && !row.incompleteProviderCoverageCases && row.infrastructureComplete === row.planned);
const completeTiming = complete && Object.values(arms).every(row => !row.missingTimingCases && row.recorded === row.planned && row.infrastructureComplete === row.planned && !row.missingSessions);
const summary = { kind: 'observed-native-paired-results', state: report.state, cases: report.cases, completePairs, arms,
  strictlyHigherObservedAccuracy,
  efficiencyComparisonQualified: completeAccounting && completeTiming && Object.values(arms).every(row => row.rcReviewCompletedCases === row.planned),
  lowerObservedTokens: completeAccounting ? arms.candidate.totalTokens < arms.baseline.totalTokens : null,
  lowerObservedTime: completeTiming ? arms.candidate.elapsedMs < arms.baseline.elapsedMs : null,
  evidenceLimits: ['Only this fixed set and these runs; no causal/statistical significance inferred.',
    'Missing or unexecuted tasks are not silently counted as passing or omitted from completion gates.',
    'Cached input remains part of total provider-reported tokens. Overlapping P2P tests are not independent samples.',
    'Unmatched provider requests remain unknown even when the host appends a zero-usage aborted message.',
    'This summary never marks the overall goal complete; frozen heldout and original requirements still apply.'] };
const output = path.join(path.dirname(input), 'summary.json'); await fs.writeFile(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
