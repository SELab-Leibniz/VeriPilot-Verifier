import fs from 'node:fs/promises';
import path from 'node:path';
const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8);
if (!input) throw new Error('--input=<comparison results.json> required');
const report = JSON.parse(await fs.readFile(input, 'utf8'));
const arms = {};
for (const name of ['baseline', 'candidate']) {
  const rows = report.results.filter(row => row.arm === name);
  const score = { planned: report.cases.length, recorded: rows.length, executed: 0, resolved: 0, infrastructureComplete: 0,
    f2pPassed: 0, f2pExpected: 0, p2pPassed: 0, p2pExpected: 0, macroF2p: 0, macroP2p: 0,
    elapsedMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, missingUsage: 0, missingSessions: 0 };
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
      score.elapsedMs += row.usage.elapsedMs;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'missingUsage']) score[key] += row.usage.totals[key];
      score.missingSessions += row.usage.sessions.filter(row => row.missing).length;
    } else score.missingSessions++;
  }
  score.f2p = score.f2pExpected ? score.f2pPassed / score.f2pExpected : null;
  score.p2p = score.p2pExpected ? score.p2pPassed / score.p2pExpected : null;
  score.macroF2p = score.executed ? score.macroF2p / score.executed : null;
  score.macroP2p = score.executed ? score.macroP2p / score.executed : null;
  arms[name] = score;
}
const completePairs = report.cases.filter(id => ['baseline', 'candidate'].every(arm => report.results.some(row => row.id === id && row.arm === arm && row.grade?.results[0]?.executed)));
const complete = report.state === 'SETTLED' && completePairs.length === report.cases.length;
const strictlyHigherObservedAccuracy = complete && arms.candidate.f2p > arms.baseline.f2p && arms.candidate.p2p > arms.baseline.p2p;
const completeAccounting = complete && Object.values(arms).every(row => !row.missingUsage && !row.missingSessions && row.infrastructureComplete === row.planned);
const summary = { kind: 'observed-native-paired-results', state: report.state, cases: report.cases, completePairs, arms,
  strictlyHigherObservedAccuracy,
  lowerObservedTokens: completeAccounting ? arms.candidate.totalTokens < arms.baseline.totalTokens : null,
  lowerObservedTime: completeAccounting ? arms.candidate.elapsedMs < arms.baseline.elapsedMs : null,
  evidenceLimits: ['Only this fixed set and these runs; no causal/statistical significance inferred.',
    'Missing or unexecuted tasks are not silently counted as passing or omitted from completion gates.',
    'Cached input remains part of total provider-reported tokens. Overlapping P2P tests are not independent samples.',
    'This summary never marks the overall goal complete; frozen heldout and original requirements still apply.'] };
const output = path.join(path.dirname(input), 'summary.json'); await fs.writeFile(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
