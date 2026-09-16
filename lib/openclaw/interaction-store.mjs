import path from "node:path";
import { readJson, sha256 } from "../runtime-v2/utils.mjs";
import { privateJson, controllerDirectory } from "./controller-store.mjs";
import { findTask, withTaskState, decisionGuard, taskDirectory, withTaskResourceLock } from "../runtime-v2/task-store.mjs";

export const bindingPath = (root, sessionKey) => path.join(root, ".runtime-correction", "openclaw", "bindings", `${sha256(sessionKey)}.json`);
export async function bindInteraction(params) {
  if (!params.sessionKey || !params.sessionFile) throw new Error("Native session binding unavailable.");
  const binding = Object.fromEntries(["sessionId", "sessionKey", "sessionFile", "agentId", "workspaceDir", "provider", "modelId", "timeoutMs"]
    .map((key) => [key, params[key] ?? null]));
  await privateJson(bindingPath(params.workspaceDir, params.sessionKey), binding);
  return binding;
}
export async function interactionSnapshot(binding) {
  const task = await findTask({ projectRoot: binding.workspaceDir, sessionId: binding.sessionId });
  const controller = await readJson(path.join(controllerDirectory(binding.workspaceDir, binding.sessionId), "control.json"));
  return { task, controller, capturedAt: Date.now() };
}
export function authenticatedActor(client, write = false) {
  const scopes = client?.connect?.scopes ?? [];
  if (!client?.connect || client.connect.role !== "operator" || client.internal?.agentRuntimeIdentity
    || !scopes.includes("operator.admin") && !scopes.includes(write ? "operator.write" : "operator.read")) {
    throw Object.assign(new Error("Authenticated operator scope required."), { code: "FORBIDDEN" });
  }
  // Shared-token operators have the same authority. Never use display names,
  // caller-supplied actors or the reconnecting socket ID as command identity.
  return client.connect.device?.id ? `device:${client.connect.device.id}` : "gateway:operator";
}
export function commandKey(actor, commandId, actionId) {
  for (const id of [commandId, actionId]) if (typeof id !== "string" || !/^[\w:.-]{1,160}$/u.test(id)) throw new Error("Stable commandId and actionId required.");
  return sha256([actor, commandId, actionId]);
}
const commandIndexPath = (binding, key) => path.join(binding.workspaceDir, ".runtime-correction", "openclaw", "commands",
  sha256(binding.sessionKey), `${key}.json`);
export async function receiveCommand(binding, actor, params) {
  const key = commandKey(actor, params.commandId, params.actionId);
  const digest = sha256({ sessionKey: binding.sessionKey, action: params.action, text: params.text ?? null,
    expected: params.expected ?? null });
  return withTaskResourceLock({ projectRoot: binding.workspaceDir, taskId: `command-${sha256(binding.sessionKey)}`,
    resource: key, timeoutMs: 1000, reclaimDeadOwner: true }, async () => {
  const indexPath = commandIndexPath(binding, key);
  let index = await readJson(indexPath);
  if (index && index.digest !== digest) throw Object.assign(new Error("Command ID already used for different content."), { code: "CONFLICT" });
  const task = index ? await readJson(path.join(taskDirectory(binding.workspaceDir, index.taskId), "task.json"))
    : (await interactionSnapshot(binding)).task;
  if (!task) throw new Error("No correction task is bound to this session.");
  // Reserve the original target before committing any side effect. A crash or
  // a later task in this session cannot retarget a duplicate command.
  if (!index) { index = { key, digest, taskId: task.taskId, sessionId: binding.sessionId }; await privateJson(indexPath, index); }
  return withTaskState({ projectRoot: binding.workspaceDir, taskId: task.taskId }, (state) => {
    const control = state.control ??= { cancelEpoch: 0, pendingRevision: 0 };
    control.commands ??= {};
    if (control.commands[key]) {
      if (control.commands[key].digest !== digest) throw Object.assign(new Error("Command ID already used for different content."), { code: "CONFLICT" });
      return { receipt: structuredClone(control.commands[key]), duplicate: true };
    }
    if (params.expected) for (const [field, value] of Object.entries(params.expected)) {
      if (!["generation", "requirementVersion", "cancelEpoch"].includes(field) || decisionGuard(state)[field] !== value) throw Object.assign(new Error("Task changed; refresh status before retrying."), { code: "CONFLICT" });
    }
    const receipt = control.commands[key] = { key, commandId: params.commandId, actionId: params.actionId,
      actor, digest, action: params.action, text: params.text ?? null, taskId: task.taskId,
      source: "authenticated_control", nativeMessageId: null, status: "RECEIVED", receivedAt: Date.now() };
    if (params.action === "stop") {
      control.cancelEpoch += 1; control.cancelled = true;
      state.status = "STOPPING";
      state.verification = { ...state.verification, status: "STALE", reason: "USER_CANCELLED" };
      receipt.priorDelivery = state.delivery?.status ?? "NOT_SENT";
    } else if (params.action === "update-requirements") {
      control.pendingRevision += 1; control.pendingRequirement = key;
      state.verification = { ...state.verification, status: "STALE", reason: "REQUIREMENT_RECEIVED" };
    }
    receipt.guard = decisionGuard(state);
    return { receipt: structuredClone(receipt), duplicate: false };
  });
  });
}
export async function updateReceipt(binding, receipt, patch) {
  return withTaskState({ projectRoot: binding.workspaceDir, taskId: receipt.taskId }, (state) => {
    const current = state.control?.commands?.[receipt.key];
    if (!current) throw new Error("Command receipt missing.");
    Object.assign(current, patch, { updatedAt: Date.now() });
    return structuredClone(current);
  });
}
export async function readReceipt(binding, actor, params) {
  const key = commandKey(actor, params.commandId, params.actionId);
  const index = await readJson(commandIndexPath(binding, key));
  const task = index ? await readJson(path.join(taskDirectory(binding.workspaceDir, index.taskId), "task.json"))
    : (await interactionSnapshot(binding)).task;
  const receipt = task?.control?.commands?.[key];
  return receipt ?? { status: "NOT_FOUND" };
}
