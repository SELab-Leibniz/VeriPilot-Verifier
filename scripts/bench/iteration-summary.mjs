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
    for (const key of ['f2p', 'p2p']) {
      const applicable = cases.filter(row => row[key] > 0);
      const observed = applicable.filter(row => select(row.attempts)?.grade?.executed === true);
      const sum = observed.reduce((value, row) => value + select(row.attempts).grade[key].passed.length / row[key], 0);
      Object.assign(totals[key], {
        fullSuitePassRate: totals[key].expected ? totals[key].passed / totals[key].expected : null,
        observedPassRate: totals[key].observedExpected ? totals[key].passed / totals[key].observedExpected : null,
        fullSuiteMacroPassRate: applicable.length ? sum / applicable.length : null,
        observedMacroPassRate: observed.length ? sum / observed.length : null,
      });
    }
    totals.resolvedCaseRate = totals.cases ? totals.resolved / totals.cases : null;
    totals.acceptedCaseRate = totals.cases ? totals.accepted / totals.cases : null;
    totals.gradingCoverage = totals.cases ? totals.graded / totals.cases : null;
    totals.allCasesResolved = totals.cases > 0 && totals.resolved === totals.cases;
    totals.allCasesAccepted = totals.cases > 0 && totals.accepted === totals.cases;
    totals.targetReached = totals.graded === totals.cases && ['f2p', 'p2p'].every(key =>
      totals[key].fullSuitePassRate >= .95 && totals[key].fullSuiteMacroPassRate >= .95);
    return totals;
  };
  return { firstAttempts: summarize(row => row[0]), latestAttempts: summarize(row => row.at(-1)),
    qualification: 'Sequential development tuning, not unseen holdout evidence. First/latest refer to real business attempts. When a frozen candidate capture is repaired, its latest chronological grading revision is used and every original/repaired grade is retained; revisions do not invent additional model runs. Full-suite rates are lower bounds until every task is graded; ungraded tasks remain in the denominator. Test-weighted and equal-task macro rates are separate, and both must reach 95 percent. Whole-task resolution and RC acceptance are separate. P2P populations overlap between tasks.' };
}
