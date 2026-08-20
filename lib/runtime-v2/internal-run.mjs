import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { atomicWriteJson, readJson, safeId, sha256, uniqueId } from "./utils.mjs";


export const INTERNAL_ROLES = new Set([
  "ground-truth-extractor",
  "onboarding-extractor",
  "onboarding-adjudicator",
  "skill-reviewer",
  "artifact-reviewer",
  "stop-reviewer",
  "implementation-reviewer",
]);


function leasePath(projectRoot, runId) {
  return path.join(
    projectRoot,
    OUTPUT_TREE_DIRECTORY,
    "internal-runs",
    `${safeId(runId)}.json`,
  );
}


export async function createInternalRunLease({
  projectRoot,
  taskId,
  role,
  ttlMs = 15 * 60 * 1000,
}) {
  if (!INTERNAL_ROLES.has(role)) throw new Error(`Unknown internal reviewer role: ${role}`);
  const runId = uniqueId("internal");
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  const lease = {
    schemaVersion: "runtime-corrector.internal-run.v2",
    runId,
    taskId,
    role,
    depth: 1,
    tokenDigest: sha256(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const filePath = leasePath(projectRoot, runId);
  await atomicWriteJson(filePath, lease);
  return { ...lease, token, filePath };
}


export async function releaseInternalRunLease(lease) {
  if (!lease?.filePath) return;
  await fs.rm(lease.filePath, { force: true });
}


export async function cleanupExpiredInternalRuns(projectRoot, now = Date.now()) {
  const directory = path.join(projectRoot, OUTPUT_TREE_DIRECTORY, "internal-runs");
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    const lease = await readJson(filePath);
    if (lease && Date.parse(lease.expiresAt) > now) continue;
    await fs.rm(filePath, { force: true });
    if (lease?.runId) {
      await fs.rm(
        path.join(projectRoot, OUTPUT_TREE_DIRECTORY, ".internal-requests", safeId(lease.runId)),
        { recursive: true, force: true },
      );
    }
    removed.push(lease?.runId ?? entry.name);
  }
  return removed;
}


export function internalRunEnvironment(lease, source = process.env) {
  const env = { ...source };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ID;
  env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID = lease.runId;
  env.RUNTIME_CORRECTOR_INTERNAL_ROLE = lease.role;
  env.RUNTIME_CORRECTOR_INTERNAL_DEPTH = String(lease.depth);
  env.RUNTIME_CORRECTOR_INTERNAL_TOKEN = lease.token;
  env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT = path.resolve(
    path.dirname(path.dirname(path.dirname(lease.filePath))),
  );
  return env;
}


export async function inspectInternalRun(env = process.env) {
  // The v1 semantic-review fork is an internal reviewer too: without this
  // marker its hook traffic was processed as DEVELOPER events, minting phantom
  // tasks that later analysis then swept in.
  if (env.RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE === "1") {
    return { internal: true, depth: 1, role: "semantic-review" };
  }
  const runId = env.RUNTIME_CORRECTOR_INTERNAL_RUN_ID;
  const role = env.RUNTIME_CORRECTOR_INTERNAL_ROLE;
  const token = env.RUNTIME_CORRECTOR_INTERNAL_TOKEN;
  const projectRoot = env.RUNTIME_CORRECTOR_INTERNAL_PROJECT_ROOT;
  const depth = Number(env.RUNTIME_CORRECTOR_INTERNAL_DEPTH ?? 0);
  if (!runId && depth < 1) return { internal: false, depth: 0 };
  if (!runId || !role || !token || !projectRoot || depth < 1) {
    return { internal: false, depth, invalid: true, reason: "incomplete-internal-marker" };
  }
  const lease = await readJson(leasePath(projectRoot, runId));
  if (!lease) return { internal: false, depth, invalid: true, reason: "missing-internal-lease" };
  if (lease.role !== role || lease.depth !== depth || lease.tokenDigest !== sha256(token)) {
    return { internal: false, depth, invalid: true, reason: "invalid-internal-lease" };
  }
  if (Date.parse(lease.expiresAt) <= Date.now()) {
    // FAIL CLOSED for hook suppression: the lease is authentic (role + token
    // match) but outlived its TTL — a long reviewer, not an intruder. Treating
    // it as a developer session would process reviewer hooks as developer
    // events and mint phantom tasks mid-run.
    return { internal: true, depth, role, runId, taskId: lease.taskId, projectRoot, expired: true };
  }
  return { internal: true, depth, role, runId, taskId: lease.taskId, projectRoot };
}


export function assertCanCreateInternalRun(env = process.env) {
  const depth = Number(env.RUNTIME_CORRECTOR_INTERNAL_DEPTH ?? 0);
  if (depth >= 1) {
    const error = new Error("Runtime Corrector internal runs cannot create nested reviewers.");
    error.code = "SKIPPED_INTERNAL";
    throw error;
  }
}
