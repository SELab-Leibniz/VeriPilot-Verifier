import assert from "node:assert/strict";
import test from "node:test";
import { checkProcessEvidence } from "../scripts/diagnostics/process-contract-lab/contract.mjs";
import { fixtures } from "../scripts/diagnostics/process-contract-lab/fixtures.mjs";
const assessment = (fixture, first, second) => ({ rule: { text: fixture.source, strength: "HARD", ordering: "REQUIRED" },
  judgement: "DEVIATION", reasonType: "ORDER", orderEvidence: { requiredFirstEvent: first, requiredSecondEvent: second } });

test("lab rejects added ordering in a literal ordinary reading instruction", () => {
  const f = fixtures[0], row = assessment(f, "read-contract", "edit-module");
  row.rule.text = "Read the spec before making any changes.";
  assert.equal(checkProcessEvidence(f, row).code, "UNSUPPORTED_REPHRASING");
});
test("lab rejects a reversed-order assertion contradicted by the completed events", () => {
  const f = fixtures[0];
  assert.equal(checkProcessEvidence(f, assessment(f, "read-contract", "edit-module")).code, "ORDER_CONTRADICTED_BY_TRACE");
});
test("lab cannot attribute external file observations to the business agent", () => {
  const f = fixtures[0];
  assert.equal(checkProcessEvidence(f, assessment(f, "edit-module", "fs-change")).code, "WRONG_ACTOR_OR_SCOPE");
});
test("lab preserves a real explicitly reversed order without silently passing it", () => {
  const f = fixtures[1], result = checkProcessEvidence(f, assessment(f, "read-contract", "write-orders"));
  assert.equal(result.status, "TEMPORALLY_CONSISTENT");
  assert.equal(result.semanticEntailmentProven, false);
});
test("lab rejects absent, incomplete, overlapping and foreign-scope evidence", () => {
  const f = fixtures[1];
  assert.equal(checkProcessEvidence(f, assessment(f, "invented", "write-orders")).code, "UNKNOWN_EVENT");
  for (const [extra, code] of [[{ completed: false }, "INCOMPLETE_EVENT"], [{ sessionId: "other" }, "WRONG_ACTOR_OR_SCOPE"], [{ start: 10.5 }, "OVERLAPPING_EVENTS"]]) {
    const copy = structuredClone(f); Object.assign(copy.events[1], extra);
    assert.equal(checkProcessEvidence(copy, assessment(copy, "read-contract", "write-orders")).code, code);
  }
});
test("lab exposes the limit: literal quotation and correct timestamps do not prove mandatory force", () => {
  const f = fixtures[3], result = checkProcessEvidence(f, assessment(f, "read-guide", "edit-implementation"));
  assert.equal(result.status, "TEMPORALLY_CONSISTENT");
  assert.equal(result.semanticEntailmentProven, false);
  assert.equal(result.businessRepairAuthorized, false, "this guard must not authorize a HARD gate by itself");
});
test("lab exposes the opposite limit: literal matching rejects a harmless paraphrase too", () => {
  const f = fixtures[1], row = assessment(f, "read-contract", "write-orders");
  row.rule.text = "Reading contract.md must precede modifying orders.py.";
  assert.equal(checkProcessEvidence(f, row).code, "UNSUPPORTED_REPHRASING");
  // This is a known benign paraphrase. Literal equality therefore cannot be
  // adopted as a general semantic validator or a new production HARD gate.
});
test("lab exposes that swapping witness roles is not caught by timestamp consistency alone", () => {
  const f = fixtures[2];
  const result = checkProcessEvidence(f, assessment(f, "edit-worker", "exec-cat-result"));
  assert.equal(result.status, "TEMPORALLY_CONSISTENT");
  assert.equal(result.semanticEntailmentProven, false);
  assert.equal(result.businessRepairAuthorized, false, "clause-to-event binding must be checked independently");
});
