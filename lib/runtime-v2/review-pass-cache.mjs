import { promises as fs } from "node:fs";
import path from "node:path";

import { evidencePath, matchesEvidence } from "./evidence-state.mjs";
import { atomicWriteJson, sha256 } from "./utils.mjs";

const VERSION = "runtime-corrector.stop-pass-cache.v1";
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_BYTES = 4 * 1024 * 1024;
const blocked = /^(?:\.git|\.aws|\.ssh|\.env(?:\..*)?|auth-profiles\.json|openclaw\.json|.*(?:credentials|secret|api[-_]?key).*)$/iu;
const within = (base, file) => {
  const relative = path.relative(base, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

/** A factory object alone cannot prove that its hidden default model is stable. */
export function reviewPassInputKey({ reviewerFactory, reviewer, ...input }) {
  try {
    let runtime = typeof reviewerFactory.reviewCacheIdentity === "function"
      ? reviewerFactory.reviewCacheIdentity(reviewer) : null;
    if (typeof runtime !== "string" || !runtime) return null;
    return sha256({ version: VERSION, runtime, reviewer, ...input });
  } catch { return null; }
}

export function reviewPassItemKey(inputKey, owned) {
  return sha256({ inputKey, owned });
}

export function emptyReviewPassIndex(inputKey) {
  return { schemaVersion: VERSION, inputKey, items: {} };
}

/** A single bounded index holds only the current frozen input, never a history scan. */
export async function loadReviewPassIndex(file, inputKey, allowedKeys) {
  const empty = emptyReviewPassIndex(inputKey);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return empty;
    const index = JSON.parse(await fs.readFile(file, "utf8"));
    if (index.schemaVersion !== VERSION || index.inputKey !== inputKey || !index.items || Array.isArray(index.items)) return empty;
    const allowed = new Set(allowedKeys);
    return { ...empty, items: Object.fromEntries(Object.entries(index.items).filter(([key, record]) => allowed.has(key)
      && typeof record?.itemPath === "string" && /^[a-f\d]{64}$/u.test(record.itemHash))) };
  } catch { return empty; }
}

export async function readReviewPassItem({ taskRoot, record, inputKey, itemKey }) {
  if (!record) return null;
  const collectionRoot = await fs.realpath(path.join(taskRoot, "review-collections"));
  const itemPath = await fs.realpath(record.itemPath);
  if (!within(collectionRoot, itemPath)) return null;
  const stat = await fs.stat(itemPath);
  if (!stat.isFile() || stat.size > MAX_ITEM_BYTES) return null;
  const bytes = await fs.readFile(itemPath);
  if (sha256(bytes) !== record.itemHash) return null;
  const item = JSON.parse(bytes.toString("utf8"));
  if (item.path !== itemPath || item.status !== "COMPLETED" || item.failure
    || item.passReuseInputKey !== inputKey || item.passReuseItemKey !== itemKey) return null;
  if (!Array.isArray(item.sourceCitations) || item.sourceCitations.length > 256) return null;
  const priorRoot = path.dirname(path.dirname(itemPath));
  for (const citation of item.sourceCitations ?? []) {
    const snapshot = await fs.realpath(citation.snapshotPath);
    if (!within(path.join(priorRoot, "sources"), snapshot) || !/^[a-f\d]{64}$/u.test(citation.contentHash)) return null;
  }
  return item;
}

export function isCompletePassItem(report, owned) {
  return owned.length > 0 && (report.findings ?? []).length === 0
    && report.metricObjectJudgements?.length === owned.length
    && report.metricObjectJudgements.every(row => row.judgement === "PASS")
    && (report.fileAssessments ?? []).every(file => file.status === "PASS");
}

/** Recheck the program-observed read set, including uncited files and directory names. */
export async function reviewReadEvidenceMatches(root, evidence) {
  if (!evidence || evidence.unstable !== false || !Array.isArray(evidence.files) || !evidence.files.length
    || evidence.files.length > 128 || evidence.missing?.length || !evidence.fingerprints
    || Object.keys(evidence.fingerprints).length !== evidence.files.length) return false;
  for (const file of evidence.files) {
    if (typeof file !== "string" || !/^[a-f\d]{64}$/u.test(evidence.fingerprints[file])) return false;
    const allowed = evidencePath(root, file);
    if (!allowed || path.relative(root, allowed).split(/[\\/]/u).some(part => blocked.test(part))) return false;
    const real = await fs.realpath(allowed);
    if (real !== root && !within(root, real)) return false;
    if (path.relative(root, real).split(/[\\/]/u).some(part => blocked.test(part))) return false;
  }
  return matchesEvidence(evidence);
}

export async function saveReviewPassIndex(file, index) {
  if (Buffer.byteLength(JSON.stringify(index, null, 2), "utf8") + 1 > MAX_INDEX_BYTES) return;
  await atomicWriteJson(file, index);
}
