import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('comparison never calls unchanged perfect P2P an improvement or hides unexecuted tasks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-comparison-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'results.json'), script = fileURLToPath(new URL('../scripts/report-arkts-comparison.mjs', import.meta.url));
  const rows = ['one', 'two'].flatMap(id => ['baseline', 'candidate'].map(arm => ({ id, arm, nativeComplete: true,
    grade: { results: [{ executed: true, resolved: arm === 'candidate', f2p: { expected: 2, passed: arm === 'candidate' ? ['a', 'b'] : ['a'], passRate: arm === 'candidate' ? 1 : .5 },
      p2p: { expected: 3, passed: ['x', 'y', 'z'], passRate: 1 } }] },
    usage: { authoritativeBusinessCompletion: true, elapsedMs: arm === 'candidate' ? 80 : 100, providerUsageCoverage: { complete: true }, totals: { input: 20, output: 5, cacheRead: arm === 'candidate' ? 55 : 75, cacheWrite: 0, totalTokens: arm === 'candidate' ? 80 : 100, missingUsage: 0 }, sessions: [{}] } })));
  const report = { state: 'SETTLED', cases: ['one', 'two'], results: rows };
  async function run() {
    await fs.writeFile(file, JSON.stringify(report)); execFileSync(process.execPath, [script, `--input=${file}`], { windowsHide: true });
    return JSON.parse(await fs.readFile(path.join(root, 'summary.json'), 'utf8'));
  }
  const complete = await run();
  assert.equal(complete.arms.candidate.f2p, 1); assert.equal(complete.arms.baseline.f2p, .5);
  assert.equal(complete.strictlyHigherObservedAccuracy, false);
  assert.equal(complete.lowerObservedTokens, true); assert.equal(complete.lowerObservedTime, true);
  assert.equal(complete.efficiencyComparisonQualified, false, 'hidden tests alone do not prove completed RC review');
  for (const row of rows) row.usage.nativeRuns = [{ role: 'stop-reviewer', protocolCompleted: true }];
  assert.equal((await run()).efficiencyComparisonQualified, true);
  rows[0].usage.businessTerminal = { completionObserved: true };
  for (const completion of [false, null]) {
    rows[0].usage.authoritativeBusinessCompletion = completion;
    const failedHost = await run();
    assert.equal(failedHost.efficiencyComparisonQualified, false, 'inner success cannot qualify an errored or unknown outer host');
    assert.equal(failedHost.lowerObservedTokens, null);
    assert.equal(failedHost.arms.baseline.businessCompletions, 1);
  }
  rows[0].usage.authoritativeBusinessCompletion = true;
  rows[0].usage.nativeRuns[0].protocolCompleted = false;
  assert.equal((await run()).efficiencyComparisonQualified, false, 'doing less review is not qualified as faster review');
  rows[0].usage.nativeRuns[0].protocolCompleted = true;
  rows[0].usage.providerUsageCoverage.complete = false;
  const incompleteProvider = await run();
  assert.equal(incompleteProvider.lowerObservedTokens, null, 'an interrupted provider request cannot be counted as zero usage');
  assert.equal(incompleteProvider.lowerObservedTime, true, 'recorded elapsed time is independent of token accounting');
  rows[0].usage.providerUsageCoverage.complete = true;
  rows.at(-1).grade.results[0].executed = false;
  const incomplete = await run(); assert.equal(incomplete.arms.candidate.f2p, null);
  assert.equal(incomplete.strictlyHigherObservedAccuracy, false); assert.equal(incomplete.lowerObservedTokens, null);
  rows.at(-1).grade.results[0].executed = true; rows.at(-1).usage.sessions[0].inputMissing = 1;
  const unknownUsage = await run(); assert.equal(unknownUsage.lowerObservedTokens, null);
});
