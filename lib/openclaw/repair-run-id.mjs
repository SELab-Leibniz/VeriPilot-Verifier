export const REPAIR_RUN_PREFIX = "rc-stop-";

export const isRepairRunId = runId => typeof runId === "string" && runId.startsWith(REPAIR_RUN_PREFIX);

// Ownership and budget checks accept only identities minted from an admission digest.
export const isExactRepairRunId = runId => isRepairRunId(runId)
  && /^[a-f0-9]{64}$/u.test(runId.slice(REPAIR_RUN_PREFIX.length));
