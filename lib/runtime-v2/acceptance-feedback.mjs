import { isDeepStrictEqual } from 'node:util';

const supportingAttemptLimit = 3;

export function createAcceptanceFeedback() {
  let failed = false, supportingAttempts = 0, acceptanceReminded = false;
  let reportArgs, incompleteReports = 0, reportReminded = false;
  return ({ kind, status, incompleteReason }, args) => {
    if (!['PASS', 'FAIL', 'INCOMPLETE'].includes(status)) return null;
    if (kind === 'acceptance') {
      // A fresh independent attempt establishes its own outcome.
      failed = status === 'FAIL';
      supportingAttempts = 0;
      return null;
    }
    if (kind !== 'supporting') return null;

    const incompleteReport = status === 'INCOMPLETE' && incompleteReason === 'RUNNER_REPORT_INCOMPLETE';
    if (failed) supportingAttempts++;
    if (!reportReminded) {
      if (!incompleteReport || !isDeepStrictEqual(reportArgs, args)) incompleteReports = 0;
      reportArgs = incompleteReport ? args : undefined;
      if (incompleteReport && ++incompleteReports === supportingAttemptLimit) {
        reportReminded = true;
        return { type: 'OPENCLAW_RUNNER_REPORT_INCOMPLETE', text: `RC_VERIFICATION_INCOMPLETE. The same supporting check ended without a usable report ${incompleteReports} times. Inspect where the latest report stopped before rerunning it. Use a trusted equivalent for the same requirement if available. Otherwise, record which verification remains incomplete.` };
      }
    }
    if ((!incompleteReport || !reportReminded) && !acceptanceReminded && supportingAttempts >= supportingAttemptLimit) {
      acceptanceReminded = true;
      return { type: 'OPENCLAW_ACCEPTANCE_RECHECK', text: `RC_ACCEPTANCE_RECHECK. The last independent acceptance check failed. After ${supportingAttempts} supporting check attempts, acceptance on the current implementation still needs verification. At the next suitable checkpoint, rerun that acceptance check and use its result to choose the next repair.` };
    }
    return null;
  };
}
