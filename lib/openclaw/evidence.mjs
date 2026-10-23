// Preserve the native adapter API while the collector shares this host-neutral
// fingerprint implementation. CLI plugin builds intentionally omit openclaw/.
export { evidencePath, fingerprint, createEvidenceLedger, matchesEvidence } from "../runtime-v2/evidence-state.mjs";
