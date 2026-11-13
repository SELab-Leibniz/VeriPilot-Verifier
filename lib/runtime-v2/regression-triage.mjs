export const REGRESSION_TRIAGE_VERSION = 2;

/** A complete controlled whole suite, not an isolated pass, proves collateral UVs. */
export function applyCollateralReceipt(reviewed, request, run) {
  const lines=[...(run.outputTail??'').matchAll(/^RC_REGRESSION_COLLATERAL (.+)$/gmu)];
  if(run.reason||![0,1].includes(run.exitCode)||lines.length!==1)return reviewed;
  let proof;try{proof=JSON.parse(lines[0][1]);}catch{return reviewed;}
  const expected=request.exclusions.map(x=>x.id).sort();
  if(proof.requestId!==request.requestId||proof.baselineSha256!==request.baselineSha256||proof.taskStartSuite!==true
    ||proof.complete!==true||JSON.stringify([...(proof.excludedIds??[])].sort())!==JSON.stringify(expected)
    ||!proof.expectedSurvivingCount||proof.observedSurvivingCount!==proof.expectedSurvivingCount)return reviewed;
  if (!Array.isArray(proof.failures) || proof.failures.some(id =>
    !reviewed.cases.some(item => item.id === id && ['REGRESSION', 'UNVERIFIED'].includes(item.verdict)))) return reviewed;
  const cases=reviewed.cases.map(item=>item.verdict==='UNVERIFIED'&&request.probes.includes(item.id)&&proof.probes?.[item.id]==='PASS'
    ?{...item,verdict:'COLLATERAL_FAILURE',reason:'The complete task-start public suite passes this case after excluding only reviewed authorized obsolete cases.',collateralRequestId:request.requestId}:item);
  return {...reviewed,cases,status:cases.some(x=>x.verdict==='UNVERIFIED')?'UNVERIFIED':cases.some(x=>x.verdict==='REGRESSION')?'REGRESSION':'EXPLAINED',collateralProof:proof};
}

/** Only a completed, exact single-test run establishes that a case passes alone. */
export function isolatedRegressionResult(run, id) {
  if (run.reason || run.exitCode !== 0) return null;
  const reports = [...(run.outputTail ?? '').matchAll(/^RC_REGRESSION_CASE (.+)$/gmu)];
  if (reports.length !== 1) return null;
  try {
    const result = JSON.parse(reports[0][1]);
    return result.id === id && result.complete === true && result.status === 'PASS'
      && result.observed?.length === 1 && result.observed[0] === id ? result : null;
  } catch { return null; }
}

export async function triageRegressionFailures({ failures, baseline, isolate, signal }) {
  const cases = [];
  for (const failure of failures) {
    signal?.throwIfAborted();
    const original = baseline?.completeRuntime === true ? baseline.statuses?.[failure.id] : null;
    if (['FAIL', 'ERROR'].includes(original)) {
      cases.push({ id: failure.id, type: 'PRE_EXISTING_FAILURE', reason: `The task-start baseline already reported ${original}.` });
      continue;
    }
    const isolated = isolate ? await isolate(failure.id) : null;
    if (isolatedRegressionResult(isolated ?? {}, failure.id))
      cases.push({ id: failure.id, type: 'REVIEW_REQUIRED', isolationObserved: true,
        reason: `${original === 'PASS' ? 'The task-start suite passed this case. ' : 'No task-start failure is established. '}The current suite fails it but it passes alone. This establishes order or shared-state dependence, not that the change is authorized or unrelated; inspect setup, cleanup and the changed dependency path.`,
        isolatedRun: isolated });
    else cases.push({ id: failure.id, type: 'REVIEW_REQUIRED',
      reason: isolated?.reason ?? (isolate ? 'The isolated run did not establish a clean pass.' : 'No exact single-test runner is configured.'),
      ...(isolated ? { isolatedRun: isolated } : {}) });
  }
  return { version: REGRESSION_TRIAGE_VERSION, cases };
}

/** Reviewer decisions carry meaning. The program binds case and deviation identities. */
export function reviewedRegressionFailures({ inventory, disposition, hasDeviation }) {
  const failures = inventory?.failures?.length ? inventory.failures : [{ id: 'regression-check' }];
  const assigned = new Set(failures.map(item => item.id)), byId = new Map();
  const legacy = (disposition.explanations ?? []).map(item => {
    const authorized = disposition.status === 'EXPLAINED'
      || disposition.status === 'REVIEWED' && typeof item.authorization === 'string' && item.authorization.trim().length > 0;
    return { id: item.failure, verdict: authorized ? 'AUTHORIZED_CHANGE' : 'UNVERIFIED',
      reason: authorized ? item.reason : disposition.reason };
  });
  // Validate each wire format independently, then let an explicit case decision win.
  // In particular, a legacy explanation must never erase UNVERIFIED or REGRESSION.
  for (const entries of [legacy, disposition.cases ?? []]) {
    const seen = new Set();
    for (const entry of entries) {
      if (!assigned.has(entry.id) || seen.has(entry.id))
        throw Object.assign(new Error('Regression case IDs must be assigned and unique within each format.'), { code: 'REVIEW_ITEM_OWNERSHIP_INVALID' });
      seen.add(entry.id);
      byId.set(entry.id, entry);
    }
  }
  const cases = failures.map(({ id }) => {
    const entry = byId.get(id);
    const confirmed = entry?.verdict === 'AUTHORIZED_CHANGE' || entry?.verdict === 'REGRESSION' && hasDeviation(entry.objectId);
    return { id, verdict: confirmed ? entry.verdict : 'UNVERIFIED', reason: entry?.verdict === 'REGRESSION' && !confirmed
      ? 'The reported regression has no saved evidence-backed deviation.' : entry?.reason ?? disposition.reason,
      ...(confirmed && entry.objectId ? { objectId: entry.objectId } : {}) };
  });
  if (inventory?.complete === false && inventory.failures?.length)
    cases.push({ id: 'regression-inventory', verdict: 'UNVERIFIED',
      reason: 'The original failure inventory is incomplete; unlisted failures have not been decided.' });
  return { cases, status: cases.some(item => item.verdict === 'UNVERIFIED') ? 'UNVERIFIED'
    : cases.some(item => item.verdict === 'REGRESSION') ? 'REVIEWED' : 'EXPLAINED' };
}
