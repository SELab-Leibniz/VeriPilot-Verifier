import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { targetVersion } from "../hosts/openclaw.mjs";
import { createOpenClawRuntime } from "./runtime.mjs";
import { registerReviewerProgress } from "./reviewer-progress.mjs";

const execute = promisify(execFile);
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const commands = ["help", "init", "validate", "stages", "stage", "check", "explain", "spec"];

export default {
  id: "runtime-corrector", name: "Runtime Corrector",
  description: "OpenClaw 2026.7.1-2 原生运行时纠偏与完成验收",
  register(api) {
    // The pinned host intentionally supplies no runtime during CLI metadata
    // discovery. Register only metadata here; the command callback checks the
    // installed package version before importing the native Gateway client.
    if (api.registrationMode === "cli-metadata") return;
    if (api.runtime.version !== targetVersion) {
      throw new Error(`Runtime Corrector requires OpenClaw ${targetVersion}; found ${api.runtime.version ?? "unknown"}.`);
    }
    if (typeof api.runtime.agent?.runEmbeddedAgent !== "function"
      || typeof api.registerAgentToolResultMiddleware !== "function") {
      throw new Error("OpenClaw native reviewer/tool-result APIs are unavailable.");
    }
    const pluginRoot = api.rootDir ?? moduleRoot;
    // Embedded review runs can load a fresh plugin registry. Lifecycle hooks
    // and lazily loaded result middleware must retain the same call bindings.
    // Scope state to this installed plugin root; separate profiles stay apart.
    const registryKey = Symbol.for("runtime-corrector.openclaw.2026.7.1-2.native-transparency-state");
    const registry = globalThis[registryKey] ??= new Map();
    const sharedState = registry.get(pluginRoot) ?? {};
    registry.set(pluginRoot, sharedState);
    const runtime = createOpenClawRuntime(api, { pluginRoot, sharedState, nativeHooks: true });
    registerReviewerProgress(api);
    const timeoutMs = api.pluginConfig?.hookTimeoutMs ?? 540000;
    api.on("session_start", runtime.sessionStart, { timeoutMs: 30000 });
    api.on("before_prompt_build", runtime.prompt, { timeoutMs });
    api.on("before_tool_call", runtime.beforeTool, { timeoutMs });
    api.on("reply_payload_sending", runtime.reply, { timeoutMs });
    api.on("before_compaction", runtime.compact, { timeoutMs: 30000 });
    api.on("session_end", runtime.sessionEnd, { timeoutMs: 1000 });
    api.on("before_reset", runtime.reset, { timeoutMs: 1000 });
    api.on("agent_end", runtime.agentEnd, { timeoutMs: 1000 });
    api.on("gateway_stop", runtime.dispose, { timeoutMs: 1000 });
    api.registerAgentToolResultMiddleware(runtime.toolResult, { runtimes: ["openclaw", "codex"] });
    api.registerTool((ctx) => {
      // This CLI owns host workspace files; don't bypass a container's FS policy.
      if (ctx.sandboxed || !ctx.workspaceDir) return null;
      return {
        name: "runtime_corrector", label: "Runtime Corrector",
        description: "查看纠偏状态、初始化项目规则或手动检查文件。自动纠偏由插件生命周期触发。",
        parameters: { type: "object", additionalProperties: false, required: ["command"], properties: {
          command: { type: "string", enum: commands },
          subject: { type: "string", description: "check 的文件路径，或 explain/spec/stage 的阶段名称" },
          enabled: { type: "boolean", description: "stage 命令的开关" },
          format: { type: "string", enum: ["text", "json"], description: "状态输出格式" },
        } },
        async execute(_id, args) {
          if (!commands.includes(args.command)) throw new Error("Unsupported Runtime Corrector command.");
          if (["check", "explain", "spec", "stage"].includes(args.command) && !args.subject) throw new Error("This command requires a subject.");
          if (args.command === "stage" && typeof args.enabled !== "boolean") throw new Error("stage requires an explicit enabled boolean.");
          const argv = [path.join(pluginRoot, "scripts", "cli.mjs"), args.command];
          if (args.subject !== undefined) {
            if (typeof args.subject !== "string" || args.subject.startsWith("-") || args.subject.includes("\0")) throw new Error("Invalid command subject.");
            argv.push(args.subject);
          }
          if (args.command === "stage") argv.push(args.enabled === true ? "on" : "off");
          if (args.format !== undefined) {
            if (!["text", "json"].includes(args.format)) throw new Error("Unsupported output format.");
            argv.push("--format", args.format);
          }
          argv.push("--cwd", ctx.workspaceDir);
          try {
            const result = await execute(process.execPath, argv, { cwd: ctx.workspaceDir, timeout: 30000,
              maxBuffer: 1024 * 1024, windowsHide: true });
            const text = result.stdout || result.stderr || "Completed.";
            const limitation = args.command === "help"
              ? "\n\nOpenClaw 2026.7.1-2：业务执行与输出由宿主原生运行时负责；RC 通过工具结果提供评审意见，并在最终回复中追加验收摘要。旧 runtime-corrector-supervised 绑定需移除或改为 openclaw。是否继续修改由宿主决定。验收记录位于 .runtime-correction。" : "";
            return { content: [{ type: "text", text: text + limitation }] };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: String(error.stderr || error.stdout || error.message).slice(0, 16000) }] };
          }
        },
      };
    }, { names: ["runtime_corrector"] });
  },
};
