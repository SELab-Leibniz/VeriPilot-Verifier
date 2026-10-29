// Iterative tuning is development evidence. Preserve the first attempt and
// the latest attempt separately; never select the highest-scoring attempt.
export function summarizeArktsIterations(cases) {
  const summarize = select => {
    const totals = { cases: cases.length, attempted: 0, graded: 0, resolved: 0, accepted: 0,
      f2p: { expected: 0, passed: 0, observedExpected: 0 }, p2p: { expected: 0, passed: 0, observedExpected: 0 } };
    for (const row of cases) {
      const attempt = select(row.attempts), grade = attempt?.grade;
      if (attempt) totals.attempted++;
      for (const key of ['f2p', 'p2p']) totals[key].expected += row[key];
      // Compiler failures and partial logs are not scored runtime outcomes.
      if (grade?.executed !== true) continue;
      if (grade.f2p.expected !== row.f2p || grade.p2p.expected !== row.p2p)
        throw new Error(`Test population changed for ${row.id}`);
      totals.graded++;
      if (grade.resolved === true) totals.resolved++;
      if (grade.resolved === true && attempt.native?.businessCompleted === true
        && attempt.native?.infrastructureComplete === true && attempt.native?.verification === 'PASS') totals.accepted++;
      for (const key of ['f2p', 'p2p']) {
        totals[key].passed += grade[key].passed.length;
        totals[key].observedExpected += row[key];
      }
    }
    for (const key of ['f2p', 'p2p']) Object.assign(totals[key], {
      fullSuitePassRate: totals[key].expected ? totals[key].passed / totals[key].expected : null,
      observedPassRate: totals[key].observedExpected ? totals[key].passed / totals[key].observedExpected : null,
    });
    totals.targetReached = totals.graded === totals.cases && totals.f2p.fullSuitePassRate >= .95 && totals.p2p.fullSuitePassRate >= .95;
    return totals;
  };
  return { firstAttempts: summarize(row => row[0]), latestAttempts: summarize(row => row.at(-1)),
    qualification: 'Sequential development tuning, not unseen holdout evidence. Ungraded tasks remain in the full-suite denominator. P2P populations overlap between tasks.' };
}
