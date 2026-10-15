// Isolated proposal experiment. Not imported by the correction runtime.
// This checks provenance and temporal consistency, NOT natural-language entailment.
const normalized = value => String(value ?? "").trim().replace(/\s+/gu, " ");

export function checkProcessEvidence(fixture, row) {
  const reject = (code, detail) => ({ status: "CHECKER_ERROR", code, detail,
    businessRepairAuthorized: false, semanticEntailmentProven: false });
  const rule = row.rule ?? {};
  const strictOrder = rule.ordering === "REQUIRED" || row.reasonType === "ORDER";
  if (strictOrder && rule.strength === "HARD"
    && (!normalized(rule.text) || !normalized(fixture.source).includes(normalized(rule.text)))) {
    return reject("UNSUPPORTED_REPHRASING", "The proposed hard rule is not a literal selection of the supplied source.");
  }
  if (row.judgement !== "DEVIATION" || row.reasonType !== "ORDER") {
    return { status: "NO_ORDER_BLOCK", semanticEntailmentProven: false, businessRepairAuthorized: false };
  }
  if (rule.strength !== "HARD" || rule.ordering !== "REQUIRED") {
    return reject("NON_BINDING_ORDER", "A suggested or unspecified ordering cannot authorize a blocking order finding.");
  }
  const witness = row.orderEvidence;
  if (!witness?.requiredFirstEvent || !witness?.requiredSecondEvent) {
    return reject("ORDER_WITNESS_MISSING", "A prose assertion or a file hash is not a pair of attributable events.");
  }
  const events = new Map(fixture.events.map(event => [event.id, event]));
  const first = events.get(witness.requiredFirstEvent), second = events.get(witness.requiredSecondEvent);
  if (!first || !second) return reject("UNKNOWN_EVENT", "A cited event does not exist in the supplied trace.");
  if (first.actor !== "MAIN_TASK" || second.actor !== "MAIN_TASK"
    || first.sessionId !== fixture.sessionId || second.sessionId !== fixture.sessionId
    || first.taskId !== fixture.taskId || second.taskId !== fixture.taskId) {
    return reject("WRONG_ACTOR_OR_SCOPE", "Observation/reviewer/foreign-session events cannot prove a business-agent violation.");
  }
  if (!first.completed || !second.completed || !Number.isFinite(first.end) || !Number.isFinite(second.start)) {
    return reject("INCOMPLETE_EVENT", "Incomplete evidence cannot prove a historical order violation.");
  }
  if (first.end <= second.start) {
    return reject("ORDER_CONTRADICTED_BY_TRACE", "The required first event completed before the second event began.");
  }
  if (second.end > first.start) return reject("OVERLAPPING_EVENTS", "Overlapping actions do not prove the claimed reverse order.");
  return { status: "TEMPORALLY_CONSISTENT", semanticEntailmentProven: false,
    businessRepairAuthorized: false, detail: "The cited order is reversed. Source modality and action-to-clause binding still need verification." };
}

export const CANDIDATE_INSTRUCTIONS = [
  "Keep the source wording and normative force. A request to read material does not itself require reading before every modification. Never introduce all/every/first/before/after/permanent-failure when absent from the source obligation.",
  "Separate a required action from a strict ordering. Numbered steps, prose order and usual working habits are not sufficient evidence of strict order. Suggestions remain advisory; a model-generated HARD/MUST label is not authority.",
  "For a HARD process rule, rule.text must be a literal selection from the original source. Judge the source wording, not an expanded paraphrase. A valid quotation proves identity, not entailment or mandatory force.",
  "Do not require a particular tool name unless explicitly required. Complete attributable delivery of the required content can be read via equivalent mechanisms.",
  "For an ORDER DEVIATION, cite requiredFirstEvent and requiredSecondEvent from actual completed MAIN_TASK events in this task/session, and check their timestamps. Filesystem observations, missing event identity and assistant acknowledgements are not proof of who edited a file or in which order.",
  "Keep genuine explicit ordering requirements: if the source requires A before B and the attributable trace proves B completed before A began, report DEVIATION. If actor, order or rule strength is unproved, report UNVERIFIED or CHECKER_ERROR, not an invented confirmed violation. Do not request business-code edits to fix a checker uncertainty.",
];
