import { promises as fs } from "node:fs";
import path from "node:path";

import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import {
  appendJsonLine,
  atomicWriteJson,
  readJson,
  safeId,
  sha256,
  uniqueId,
} from "./utils.mjs";


export const TASK_SCHEMA_VERSION = "runtime-corrector.task.v2";
const LOCK_STALE_MS = 30_000;
const CLAIM_PUBLICATION_GRACE_MS = 100;
const LOCK_POLL_MS = 25;


function stateRoot(projectRoot) {
  return path.join(projectRoot, OUTPUT_TREE_DIRECTORY);
}


export function taskDirectory(projectRoot, taskId) {
  return path.join(stateRoot(projectRoot), "tasks", safeId(taskId, "task"));
}


export function taskStatePath(projectRoot, taskId) {
  return path.join(taskDirectory(projectRoot, taskId), "task.json");
}


function sessionIndexPath(projectRoot, sessionId) {
  return path.join(
    stateRoot(projectRoot),
    "session-index",
    `${sha256(sessionId).slice(0, 24)}.json`,
  );
}


function createTaskState({ taskId, sessionId, now }) {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId,
    rootSessionId: sessionId,
    sessionIds: [sessionId],
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
    correctionEpoch: {
      id: 1,
      reason: "TASK_CREATED",
      startedAt: now,
    },
    groundTruth: {
      version: 0,
      digest: null,
      sourceCursors: {},
    },
    turns: {
      userKeys: [],
      promptKeys: [],
      assistantKeys: [],
      total: 0,
      transcriptBytes: 0,
    },
    watchers: {},
    skillFeedbacks: {},
    stop: {
      epochId: 1,
      correctionAttempts: 0,
      lastAssessmentId: null,
    },
    correctionBarrier: {
      turnActivated: false,
      lastHookEventId: null,
      activatedAt: null,
    },
    deviations: {},
  };
}


function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}


function validClaim(entry, fileName) {
  return entry
    && typeof entry === "object"
    && typeof entry.token === "string"
    && entry.token.length > 0
    && fileName === `${entry.token}.json`
    && Number.isInteger(Number(entry.pid))
    && Number(entry.pid) > 0
    && Number.isFinite(Number(entry.createdAtMs));
}


async function orderedLockClaims(claimDirectory, { staleMs, reclaimDeadOwner }) {
  let entries;
  try {
    entries = await fs.readdir(claimDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const claims = [];
  for (const directoryEntry of entries) {
    if (!directoryEntry.isFile()) continue;
    const claimPath = path.join(claimDirectory, directoryEntry.name);
    let stat;
    try {
      stat = await fs.stat(claimPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let claim = null;
    try {
      claim = JSON.parse(await fs.readFile(claimPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    if (!validClaim(claim, directoryEntry.name)) {
      if (ageMs >= CLAIM_PUBLICATION_GRACE_MS) {
        await fs.rm(claimPath, { force: true });
      } else {
        // Atomic publishers should never expose an incomplete .json claim,
        // but a crashed temp file must briefly block the queue before its
        // short publication grace expires.
        claims.push({ token: `malformed:${directoryEntry.name}`, createdAtMs: Number.NEGATIVE_INFINITY });
      }
      continue;
    }
    const ownerAlive = processIsAlive(Number(claim.pid));
    if (!ownerAlive && (reclaimDeadOwner || ageMs > staleMs)) {
      await fs.rm(claimPath, { force: true });
      continue;
    }
    claims.push({ token: claim.token, createdAtMs: Number(claim.createdAtMs) });
  }
  return claims.sort((left, right) => (
    left.createdAtMs - right.createdAtMs || left.token.localeCompare(right.token)
  ));
}


async function acquireLegacyBridge(lockPath, claim, { staleMs, reclaimDeadOwner }) {
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify({
        token: claim.token,
        pid: claim.pid,
        createdAt: new Date(claim.createdAtMs).toISOString(),
      }));
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let owner = null;
  try {
    owner = await readJson(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
  }
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const ownerAlive = Boolean(owner?.pid && processIsAlive(Number(owner.pid)));
  const ownerDead = Boolean(owner?.pid) && !ownerAlive;
  const ageMs = Date.now() - stat.mtimeMs;
  const malformedExpired = !owner?.pid && ageMs >= CLAIM_PUBLICATION_GRACE_MS;
  if (!ownerAlive && ((ownerDead && reclaimDeadOwner) || ageMs > staleMs || malformedExpired)) {
    // Only the unique claim-queue winner reaches this bridge-reclamation
    // point. It removes the specific confirmed-dead/expired legacy owner;
    // followers never unlink a shared path they do not own.
    await fs.rm(lockPath, { force: true });
  }
  return null;
}


async function acquireLock(lockPath, {
  timeoutMs = 5000,
  staleMs = LOCK_STALE_MS,
  reclaimDeadOwner = true,
} = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  const claimDirectory = `${lockPath}.claims`;
  const token = uniqueId("claim");
  const claimPath = path.join(claimDirectory, `${token}.json`);
  const claim = { token, pid: process.pid, createdAtMs: Date.now() };
  await atomicWriteJson(claimPath, claim);
  try {
    while (true) {
      const claims = await orderedLockClaims(claimDirectory, { staleMs, reclaimDeadOwner });
      if (claims[0]?.token === token) {
        const handle = await acquireLegacyBridge(lockPath, claim, { staleMs, reclaimDeadOwner });
        if (handle) {
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            try {
              await handle.close();
              let owner = null;
              try { owner = await readJson(lockPath); } catch { /* fail soft into claim cleanup */ }
              if (owner?.token === token) await fs.rm(lockPath, { force: true });
            } finally {
              await fs.rm(claimPath, { force: true });
            }
          };
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Runtime Corrector state lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  } catch (error) {
    await fs.rm(claimPath, { force: true });
    throw error;
  }
}


export async function withTaskResourceLock({
  projectRoot,
  taskId,
  resource,
  timeoutMs = 5000,
  staleMs = LOCK_STALE_MS,
  reclaimDeadOwner = false,
}, callback) {
  const lockPath = path.join(
    stateRoot(projectRoot),
    "locks",
    `${safeId(taskId)}-${safeId(resource)}.lock`,
  );
  const release = await acquireLock(lockPath, { timeoutMs, staleMs, reclaimDeadOwner });
  try {
    return await callback();
  } finally {
    await release();
  }
}


async function attachSession(projectRoot, taskId, sessionId) {
  const indexPath = sessionIndexPath(projectRoot, sessionId);
  await atomicWriteJson(indexPath, {
    schemaVersion: "runtime-corrector.session-index.v2",
    sessionId,
    taskId,
    updatedAt: new Date().toISOString(),
  });
}


async function ensureTaskById({ projectRoot, sessionId, taskId, now }) {
  const lockPath = path.join(stateRoot(projectRoot), "locks", `${safeId(taskId)}.lock`);
  const release = await acquireLock(lockPath);
  try {
    const filePath = taskStatePath(projectRoot, taskId);
    const existing = await readJson(filePath);
    const state = existing ?? createTaskState({ taskId, sessionId, now });
    if (!state.sessionIds.includes(sessionId)) state.sessionIds.push(sessionId);
    state.updatedAt = now;
    await atomicWriteJson(filePath, state);
    await attachSession(projectRoot, taskId, sessionId);
    return state;
  } finally {
    await release();
  }
}


export async function findTask({ projectRoot, sessionId, explicitTaskId = null }) {
  if (!sessionId && !explicitTaskId) return null;
  const indexed = explicitTaskId ? null : await readJson(sessionIndexPath(projectRoot, sessionId));
  const taskId = explicitTaskId ?? indexed?.taskId ?? null;
  if (!taskId) return null;
  return readJson(taskStatePath(projectRoot, taskId));
}


export async function ensureTask({ projectRoot, sessionId, explicitTaskId = null, now = new Date().toISOString() }) {
  if (!sessionId) throw new Error("Runtime Corrector v2 requires a session_id.");
  if (explicitTaskId) {
    return ensureTaskById({ projectRoot, sessionId, taskId: explicitTaskId, now });
  }
  // The session index is the serialization point for lazy task creation. Two
  // parallel first-tool hooks must re-read it under the same lock; choosing a
  // task id before locking creates two independent tasks and two onboardings.
  const lockPath = path.join(
    stateRoot(projectRoot),
    "locks",
    `session-${sha256(sessionId).slice(0, 24)}.lock`,
  );
  const release = await acquireLock(lockPath);
  try {
    const indexed = await readJson(sessionIndexPath(projectRoot, sessionId));
    const taskId = indexed?.taskId ?? uniqueId("task");
    return await ensureTaskById({ projectRoot, sessionId, taskId, now });
  } finally {
    await release();
  }
}


export async function withTaskState({ projectRoot, taskId }, updater) {
  const lockPath = path.join(stateRoot(projectRoot), "locks", `${safeId(taskId)}.lock`);
  const release = await acquireLock(lockPath);
  try {
    const filePath = taskStatePath(projectRoot, taskId);
    const state = await readJson(filePath);
    if (!state) throw new Error(`Runtime Corrector task does not exist: ${taskId}`);
    const value = await updater(state);
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(filePath, state);
    return value;
  } finally {
    await release();
  }
}


export async function appendTaskJournal(projectRoot, taskId, event) {
  await appendJsonLine(
    path.join(taskDirectory(projectRoot, taskId), "journal", "events.jsonl"),
    {
      recordedAt: new Date().toISOString(),
      ...event,
    },
  );
}


export async function startCorrectionEpoch({ projectRoot, taskId, reason, source = "USER_EXPLICIT" }) {
  return withTaskState({ projectRoot, taskId }, (state) => {
    state.correctionEpoch = {
      id: state.correctionEpoch.id + 1,
      reason,
      source,
      startedAt: new Date().toISOString(),
    };
    state.stop = {
      epochId: state.correctionEpoch.id,
      correctionAttempts: 0,
      lastAssessmentId: null,
    };
    return state.correctionEpoch;
  });
}


export async function startNewTask({ projectRoot, sessionId, previousTaskId = null, reason = "NEW_TASK" }) {
  if (previousTaskId) {
    await withTaskState({ projectRoot, taskId: previousTaskId }, (state) => {
      state.status = "ABORTED_TASK_SWITCH";
      for (const watcher of Object.values(state.watchers)) {
        if (watcher.status === "ACTIVE") watcher.status = "ABORTED_TASK_SWITCH";
      }
    });
  }
  const taskId = uniqueId("task");
  return ensureTask({ projectRoot, sessionId, explicitTaskId: taskId });
}
