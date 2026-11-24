import { CHECKS, DETAILS, OTHER_CHECK, OUTCOMES, PHASES, STATUS } from "./ui/status-copy.mjs";
import { isRepairRunId } from "./repair-run-id.mjs";

const wrapUpPhases = new Set(["FINALIZING", "COEXIST_WAIT", "REVIEW_QUEUED", "REVIEWING"]);
const repairRound = s => s.repairRound ?? isRepairRunId(s.runId);
const latestCheck = s => s.stage && s.stage !== s.phase ? s.stage
  : Array.isArray(s.activities) ? s.activities.at(-1)?.role ?? null : null;
const checkText = role => Object.hasOwn(CHECKS, role) ? CHECKS[role] : OTHER_CHECK;

// Order matters: the first match names the state. Snapshots that reach the
// outcome rules are settled rounds or carry no recognizable live phase.
const rules = [
  ["stopping", s => s.status === "STOPPING" || s.phase === "RELEASING"],
  ["terminated", s => s.status === "TERMINATED"],
  ["aborted", s => s.status === "INTERRUPTED" || s.health === "OWNER_EXITED"],
  ["sessionOff", s => s.effectiveEnabled === false && !s.active],
  ["armed", s => !s.registered && s.effectiveEnabled === true],
  ["unregistered", s => !s.registered],
  ["repairing", s => ["WAIT_CORRECTION", "CORRECTING"].includes(s.phase) || repairRound(s) && s.phase === "RUNNING"
    || s.inputMode === "WAIT" && s.outcome === "DEVIATION"],
  ["rereviewing", s => repairRound(s) && wrapUpPhases.has(s.phase)],
  ["reviewing", s => wrapUpPhases.has(s.phase)],
  ["background", s => s.phase === "RUNNING" && latestCheck(s) !== null],
  ["hidden", s => s.phase === "RUNNING" || s.phase === "USER_DISPATCHING"],
  ["passed", s => s.outcome === "PASS"],
  ["noDeviation", s => s.outcome == null || s.outcome === "NO_DEVIATION_FOUND"],
  ["deviationLeft", s => ["DEVIATION", "COMPLETED_WITH_HISTORICAL_DEVIATIONS"].includes(s.outcome)],
];
export const SESSION_STATUS_KEYS = [...rules.map(([key]) => key), "reviewIncomplete"];

export function classifySessionStatus(snapshot) {
  return rules.find(([, matches]) => matches(snapshot))?.[0] ?? "reviewIncomplete";
}

export function sessionRuntimeText(snapshot) {
  const key = classifySessionStatus(snapshot);
  const { text, indicator } = STATUS[key];
  const line = text?.replace("{check}", checkText(latestCheck(snapshot))) ?? null;
  const { phase, stage, status, outcome, registered } = snapshot;
  const unknown = status === "UNKNOWN" || snapshot.hostReconciliation === "UNKNOWN";

  const review = Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : outcome ? DETAILS.review.invalid
    : phase === "REVIEWING" || phase === "REVIEW_QUEUED" ? DETAILS.review.reviewing
      : snapshot.ended ? DETAILS.review.unavailable : DETAILS.review.pending;
  const activities = !unknown && (snapshot.active || status === "STOPPING") && Array.isArray(snapshot.activities)
    ? snapshot.activities.map(({ role }) => checkText(role)) : [];
  if (!unknown && snapshot.running && Object.hasOwn(CHECKS, stage) && !activities.includes(CHECKS[stage]))
    activities.push(CHECKS[stage]);
  const round = unknown ? DETAILS.round.unknown : !registered ? DETAILS.round.unregistered
    : !snapshot.active ? DETAILS.round.inactive
      : status === "STOPPING" ? PHASES.RELEASING
        : phase === "RUNNING" && Object.hasOwn(CHECKS, stage) ? CHECKS[stage]
          : Object.hasOwn(PHASES, phase) ? PHASES[phase] : DETAILS.round.unavailable;
  const working = unknown || !registered || typeof snapshot.running !== "boolean" ? null
    : activities.length > 0 || snapshot.running && phase === "CORRECTING";
  const agents = working === null ? DETAILS.agents.unavailable : working ? DETAILS.agents.running : DETAILS.agents.none;
  return { key, line, indicator, working, review, activities, round, agents };
}
