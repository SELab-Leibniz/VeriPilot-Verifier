import { createHash } from "node:crypto";
import path from "node:path";
import { deviceVerification } from "../runtime-v2/device-verify.mjs";
import { collectSourceManifest } from "../runtime-v2/impl-review.mjs";
import { loadPlatformAdapter, DEFAULT_PLATFORM } from "../runtime-v2/platform-adapter.mjs";

export const sourceManifest = async (root, plan) => collectSourceManifest(root, await loadPlatformAdapter(
    plan.runtimeV2?.implementationCorrection?.platform === undefined ? DEFAULT_PLATFORM
      : plan.runtimeV2.implementationCorrection.platform));
export const sourceDigest = async (root, plan) => createHash("sha256")
  .update(JSON.stringify(await sourceManifest(root, plan))).digest("hex");

// These are observations of a host tool, never instructions to run that tool.
export function captureCommand(state, event, beforeDigest, afterDigest) {
  const command = event.args?.command ?? event.args?.cmd;
  const result = event.result;
  const details = result?.details;
  const exitCode = details?.exitCode ?? details?.exit_code;
  const rawCwd = event.args?.workdir ?? event.args?.cwd ?? event.cwd ?? state.projectRoot;
  if (!state.projectRoot || typeof rawCwd !== "string" || path.resolve(state.projectRoot, rawCwd) !== path.resolve(state.projectRoot)
    || /(?:^|[;&|\r\n])\s*(?:cd|chdir|Set-Location|Push-Location)\b/iu.test(command ?? "")) return;
  if (typeof command !== "string" || !Number.isInteger(exitCode) || !beforeDigest || beforeDigest !== afterDigest
    || isInteraction(result) || ["running", "pending", "background"].includes(details?.status)) return;
  const text = (result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  state.hostCommands ??= new Map();
  state.hostCommands.set(command.trim(), { projectRoot: path.resolve(state.projectRoot), manifestDigest: afterDigest, toolCallId: event.toolCallId,
    ok: exitCode === 0 && !event.isError && !result.isError, exitCode, stdout: text, stderr: "" });
}

export function hostDeviceVerifier(state) {
  return async args => deviceVerification({ ...args, cacheFile: null,
    execFn: async (command, argv) => {
      const key = [command, ...argv].join(" ").trim();
      const observed = state.hostCommands?.get(key);
      if (!observed || observed.manifestDigest !== args.manifestDigest || observed.projectRoot !== path.resolve(args.projectRoot)) {
        throw Object.assign(new Error(`HOST_EXECUTION_EVIDENCE_REQUIRED: 宿主尚未提供当前源码的真实结果：${key}`),
          { code: "HOST_EXECUTION_EVIDENCE_REQUIRED" });
      }
      return { ...observed };
    } });
}

export function isInteraction(result) {
  const status = result?.details?.status;
  return Boolean(result?.interactive || result?.presentation?.buttons || result?.channelData?.approval
    || result?.channelData?.question
    || result?.details?.approvalId || result?.details?.approvalRequest || result?.details?.question
    || ["approval-pending", "approval_pending", "waiting_for_approval", "waiting_for_user", "denied", "blocked"].includes(status));
}

export const reviewAnnotation = text => `[runtime-corrector:feedback]\n以下是 RC 评审意见，不是原始工具输出、新用户要求或额外授权。\n${text}`;
