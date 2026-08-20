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
    deviations: {},
  };
}


async function acquireLock(lockPath, { timeoutMs = 5000 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return async () => {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Runtime Corrector state lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}


export async function withTaskResourceLock({ projectRoot, taskId, resource }, callback) {
  const lockPath = path.join(
    stateRoot(projectRoot),
    "locks",
    `${safeId(taskId)}-${safeId(resource)}.lock`,
  );
  const release = await acquireLock(lockPath);
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


export async function ensureTask({ projectRoot, sessionId, explicitTaskId = null, now = new Date().toISOString() }) {
  if (!sessionId) throw new Error("Runtime Corrector v2 requires a session_id.");
  const indexPath = sessionIndexPath(projectRoot, sessionId);
  const indexed = explicitTaskId ? null : await readJson(indexPath);
  const taskId = explicitTaskId ?? indexed?.taskId ?? uniqueId("task");
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
