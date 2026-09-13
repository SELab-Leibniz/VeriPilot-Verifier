import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withTaskResourceLock } from "../runtime-v2/task-store.mjs";
import { readJson, sha256 } from "../runtime-v2/utils.mjs";

export const controllerDirectory = (root, sessionId) => path.join(root, ".runtime-correction", "openclaw",
  "controllers", sha256(sessionId).slice(0, 24));
export const workerIdentityPath = (root, sessionId) => path.join(root, ".runtime-correction", "openclaw",
  "workers", `${sha256(sessionId)}.json`);

export function isPersistedWorker(root, sessionId) {
  if (!root || !sessionId) return false;
  try {
    const record = JSON.parse(readFileSync(workerIdentityPath(root, sessionId), "utf8"));
    if (record.workerSessionId !== sessionId || !record.generation || !record.parentSessionId) {
      throw new Error("Invalid persisted OpenClaw worker identity.");
    }
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function privateJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

// Hold the existing process-aware resource lock for the entire controller.
// A live owner is never stolen by a clock-based lease expiry.
export async function withController({ projectRoot, sessionId, runId, taskId }, callback) {
  const directory = controllerDirectory(projectRoot, sessionId);
  return withTaskResourceLock({ projectRoot, taskId: `oc-${sha256(sessionId).slice(0, 24)}`,
    resource: "supervised-controller", reclaimDeadOwner: true, timeoutMs: 1000 }, async () => {
    const file = path.join(directory, "control.json");
    const receipt = path.join(directory, "receipts", `${sha256(runId)}.json`);
    const delivered = await readJson(receipt);
    if (delivered) return delivered;
    const previous = await readJson(file);
    // A repeated parent invocation receives its recorded result, never a replay.
    if (previous?.runId === runId && previous.result
      && ["DELIVERED", "CANCELLED", "STOPPED", "UNVERIFIED"].includes(previous.phase)) return previous.result;
    if (previous && !["DELIVERED", "CANCELLED", "STOPPED", "UNVERIFIED"].includes(previous.phase)) {
      const result = { status: "UNVERIFIED", text: "上次执行或验收的完成状态无法确认，已停止自动续跑。请核对现有成果后再提交要求。" };
      await privateJson(file, { ...previous, phase: "UNVERIFIED", result, recoveredAt: Date.now() });
      // The arriving run may differ from the interrupted run. Its duplicate
      // must replay this refusal, rather than dispatch after recovery cleared
      // the ambiguous phase.
      await privateJson(receipt, result);
      return result;
    }
    const record = { schemaVersion: 1, generation: randomUUID(), parentSessionId: sessionId, runId,
      taskId: taskId ?? null, pid: process.pid, round: 0, phase: "CREATED", createdAt: Date.now() };
    await privateJson(file, record);
    const generationFile = path.join(directory, record.generation, "control.json");
    await privateJson(generationFile, record);
    let writes = Promise.resolve();
    const save = (patch) => {
      const next = writes.then(async () => {
      const current = await readJson(file);
      if (current?.generation !== record.generation) throw new Error("Superseded OpenClaw controller generation.");
      Object.assign(record, patch, { updatedAt: Date.now() });
      await privateJson(generationFile, record);
      await privateJson(file, record);
      });
      writes = next.catch(() => {});
      return next;
    };
    const current = async () => (await readJson(file))?.generation === record.generation;
    const execute = () => callback({ record, directory, save, current });
    const result = taskId ? await withTaskResourceLock({ projectRoot, taskId,
      resource: "supervised-task", reclaimDeadOwner: true, timeoutMs: 1000 }, execute) : await execute();
    await privateJson(receipt, result);
    return result;
  });
}
