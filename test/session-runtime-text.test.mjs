import test from "node:test";
import assert from "node:assert/strict";
import { classifySessionStatus, sessionRuntimeText, SESSION_STATUS_KEYS } from "../lib/openclaw/session-runtime-text.mjs";
import { CHECKS, DETAILS, OTHER_CHECK, OUTCOMES, PHASES, STATUS } from "../lib/openclaw/ui/status-copy.mjs";

const live = { registered: true, effectiveEnabled: true, status: "WAITING", active: true, running: false, ended: false, activities: [] };
const original = { ...live, runId: "business-run", repairRound: false };
const repair = { ...live, runId: "rc-stop-" + "a".repeat(64), repairRound: true };
const running = { status: "RUNNING", running: true };
const settled = { ...original, phase: "ENDED", stage: "ENDED", status: "ENDED", active: false, ended: true };

const cases = [
  ["stopping", { ...original, phase: "RELEASING", stage: "RELEASING", status: "STOPPING" }],
  ["terminated", { ...settled, status: "TERMINATED", outcome: "UNVERIFIED" }],
  ["aborted", { ...settled, status: "INTERRUPTED", outcome: "UNVERIFIED" }],
  ["aborted", { ...original, phase: "REVIEWING", stage: "stop-reviewer", status: "UNKNOWN", health: "OWNER_EXITED" }],
  ["sessionOff", { ...settled, effectiveEnabled: false }],
  ["armed", { registered: false, effectiveEnabled: true, status: "NOT_REGISTERED", active: false, inputMode: "HOST_DEFAULT" }],
  ["unregistered", { registered: false, effectiveEnabled: null, status: "NOT_REGISTERED", active: false }],
  ["repairing", { ...original, phase: "WAIT_CORRECTION", stage: "WAIT_CORRECTION", outcome: "DEVIATION", inputMode: "WAIT" }],
  ["repairing", { ...repair, ...running, phase: "CORRECTING", stage: "CORRECTING", inputMode: "WAIT" }],
  ["repairing", { ...repair, ...running, phase: "RUNNING", stage: "background-review", activities: [{ role: "background-review" }] }],
  ["repairing", { ...settled, inputMode: "WAIT", outcome: "DEVIATION" }],
  ["rereviewing", { ...repair, ...running, phase: "REVIEWING", stage: "stop-reviewer", activities: [{ role: "stop-reviewer" }] }],
  ["rereviewing", { ...repair, repairRound: undefined, phase: "FINALIZING", stage: "FINALIZING" }],
  ["reviewing", { ...original, ...running, phase: "REVIEWING", stage: "stop-reviewer", activities: [{ role: "stop-reviewer" }], inputMode: "WAIT" }],
  ["reviewing", { ...original, phase: "REVIEW_QUEUED", stage: "REVIEW_QUEUED" }],
  ["reviewing", { ...original, phase: "COEXIST_WAIT", stage: "COEXIST_WAIT" }],
  ["reviewing", { ...original, phase: "REVIEWING", stage: "stop-reviewer", status: "UNKNOWN", hostReconciliation: "UNKNOWN" }],
  ["background", { ...original, ...running, phase: "RUNNING", stage: "requirement-frame" }],
  ["background", { ...original, ...running, phase: "RUNNING", stage: "onboarding-adjudicator" }],
  ["hidden", { ...original, phase: "RUNNING", stage: "RUNNING" }],
  ["hidden", { ...original, phase: "USER_DISPATCHING", stage: "USER_DISPATCHING" }],
  ["passed", { ...settled, outcome: "PASS" }],
  ["noDeviation", { ...settled, outcome: "NO_DEVIATION_FOUND" }],
  ["noDeviation", { ...original, phase: "IDLE", stage: "IDLE", status: "IDLE", active: false, outcome: null }],
  ["deviationLeft", { ...settled, outcome: "DEVIATION" }],
  ["deviationLeft", { ...settled, outcome: "COMPLETED_WITH_HISTORICAL_DEVIATIONS" }],
  ["reviewIncomplete", { ...settled, outcome: "UNVERIFIED" }],
  ["reviewIncomplete", { ...settled, outcome: "DISABLED" }],
];

test("every snapshot is named by the first matching status rule", () => {
  for (const [key, snapshot] of cases) assert.equal(classifySessionStatus(snapshot), key, JSON.stringify(snapshot));
  assert.deepEqual(new Set(cases.map(([key]) => key)), new Set(SESSION_STATUS_KEYS));
  assert.deepEqual(new Set(Object.keys(STATUS)), new Set(SESSION_STATUS_KEYS));
});

test("the status line and indicator come only from the copy table", () => {
  for (const [key, snapshot] of cases) {
    const display = sessionRuntimeText(snapshot);
    assert.equal(display.key, key);
    assert.equal(display.indicator, STATUS[key].indicator);
    if (key !== "background") assert.equal(display.line, STATUS[key].text);
    assert.doesNotMatch(display.line ?? "", /RC|MA|新消息/u);
  }
  assert.equal(sessionRuntimeText(cases.find(([, s]) => s.stage === "requirement-frame")[1]).line,
    STATUS.background.text.replace("{check}", CHECKS["requirement-frame"]));
  assert.equal(sessionRuntimeText(cases.find(([, s]) => s.stage === "onboarding-adjudicator")[1]).line,
    STATUS.background.text.replace("{check}", OTHER_CHECK));
});

test("console details keep the round, agent and review diagnostics", () => {
  const reviewing = sessionRuntimeText(cases.find(([key, s]) => key === "reviewing" && s.running)[1]);
  assert.equal(reviewing.review, DETAILS.review.reviewing);
  assert.equal(reviewing.round, PHASES.REVIEWING);
  assert.deepEqual(reviewing.activities, [CHECKS["stop-reviewer"]]);
  assert.equal(reviewing.working, true);
  assert.equal(reviewing.agents, DETAILS.agents.running);

  const hidden = sessionRuntimeText({ ...original, phase: "RUNNING", stage: "RUNNING" });
  assert.equal(hidden.round, PHASES.RUNNING);
  assert.equal(hidden.working, false);
  assert.equal(hidden.agents, DETAILS.agents.none);

  const correcting = sessionRuntimeText({ ...repair, ...running, phase: "CORRECTING", stage: "CORRECTING" });
  assert.equal(correcting.working, true);

  const unknown = sessionRuntimeText({ ...original, ...running, phase: "RUNNING", stage: "artifact-reviewer",
    status: "UNKNOWN", activities: [{ role: "artifact-reviewer" }] });
  assert.deepEqual(unknown.activities, []);
  assert.equal(unknown.working, null);
  assert.equal(unknown.agents, DETAILS.agents.unavailable);
  assert.equal(unknown.round, DETAILS.round.unknown);

  assert.equal(sessionRuntimeText({ ...settled, outcome: "NO_DEVIATION_FOUND" }).review, OUTCOMES.NO_DEVIATION_FOUND);
  assert.equal(sessionRuntimeText({ ...settled, outcome: "UNVERIFIED", status: "INTERRUPTED" }).review, OUTCOMES.UNVERIFIED);
});
