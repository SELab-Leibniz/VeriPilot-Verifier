// Reference implementation of the external-consumer contract over the
// corrector's persisted output, vendored so the standalone plugin's tests
// have zero references outside the plugin tree.
//
// An evaluation harness consuming a run reads:
// - .runtime-correction/tasks/<taskId>/feedback/<familyId>.json families,
//   attributing a FIXED family to the critic only when the fix landed AFTER
//   the first delivered observation (shadow runs therefore attribute SELF);
// - .runtime-correction/tasks/<taskId>/journal/events.jsonl reviewer
//   envelopes, summing the critic's own LLM spend.
// These helpers assert that contract stays stable from the plugin side.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";


const CORRECTION_DIRECTORY = ".runtime-correction";


function criticTaskDirectories(projectRoot) {
  const tasksRoot = join(projectRoot, CORRECTION_DIRECTORY, "tasks");
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(tasksRoot, entry.name));
}


/**
 * Closure attribution: OPEN -> null, non-FIXED -> UNKNOWN, FIXED -> CRITIC
 * only when fixedAt is after the first delivered observation, else SELF.
 */
export function attributeClosures(families) {
  const attribution = new Map();
  for (const family of families) {
    const key = family.familyId;
    if (family.status === "OPEN") {
      attribution.set(key, null);
      continue;
    }
    if (family.status !== "FIXED") {
      attribution.set(key, "UNKNOWN");
      continue;
    }
    const deliveredAts = (family.observations ?? [])
      .filter((observation) => observation.delivered === true && observation.deliveredAt)
      .map((observation) => observation.deliveredAt)
      .sort();
    const firstDeliveredAt = deliveredAts[0] ?? null;
    const fixedAfterDelivery = firstDeliveredAt !== null
      && typeof family.fixedAt === "string"
      && family.fixedAt > firstDeliveredAt;
    attribution.set(key, fixedAfterDelivery ? "CRITIC" : "SELF");
  }
  return attribution;
}


/** Sum the critic's own LLM spend from journaled reviewer envelopes. */
export function summarizeCriticOverhead(projectRoot) {
  const totals = { costUsd: 0, turns: 0, wallClockMs: 0, invocations: 0, inputTokens: 0, outputTokens: 0 };
  let sawAny = false;
  for (const directory of criticTaskDirectories(projectRoot)) {
    const journalPath = join(directory, "journal", "events.jsonl");
    if (!existsSync(journalPath)) continue;
    for (const line of readFileSync(journalPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const envelope = event.reviewerEnvelope ?? event.envelope ?? null;
      if (!envelope) continue;
      sawAny = true;
      totals.invocations += 1;
      totals.costUsd += Number(envelope.total_cost_usd ?? 0);
      totals.turns += Number(envelope.num_turns ?? 0);
      totals.wallClockMs += Number(envelope.duration_ms ?? 0);
      totals.inputTokens += Number(envelope.usage?.input_tokens ?? 0);
      totals.outputTokens += Number(envelope.usage?.output_tokens ?? 0);
    }
  }
  return sawAny ? totals : null;
}
