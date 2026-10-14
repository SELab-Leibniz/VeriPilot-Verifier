import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateJson } from "./controller-store.mjs";
import { projectCapability, sessionIdentity, currentSession, nativeProjectDirectory, projectPermission } from "./project-compat.mjs";
import { loadProjectConfigDocument } from "../policy/config-loader.mjs";
import { loadConfig } from "../runtime-corrector.mjs";
import { isPathInside } from "../path-utils.mjs";
import { observeNativeTranscript } from "./native-transcript.mjs";
import { isInternalExecution } from "./internal-context.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = async file => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const authorized = (ctx, write) => ctx.isAuthorizedSender === true && (ctx.gatewayClientScopes
  ? ctx.gatewayClientScopes.includes("operator.admin") || ctx.gatewayClientScopes.includes(write ? "operator.write" : "operator.read")
  : ctx.senderIsOwner === true);

export function createSessionProjects(api, { pluginRoot, compatibility } = {}) {
  const capability = projectCapability(api);
  const queues = new Map();
  let onChanged = async () => {};
  function file(identity, name) {
    const root = api.runtime?.state?.resolveStateDir?.();
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("HOST_PLUGIN_STATE_DIRECTORY_UNAVAILABLE");
    return path.join(root, "plugins/runtime-corrector/session-projects", digest(identity), `${name}.json`);
  }
  // Atomic rename plus an exclusive file lock also protects independent plugin
  // registries/processes. A busy lock fails closed instead of stealing a writer.
  async function mutate(identity, callback) {
    const lock = file(identity, "binding") + ".lock";
    const previous = queues.get(lock) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
      const handle = await fs.open(lock, "wx", 0o600);
      try { return await callback(); }
      finally { await handle.close(); await fs.rm(lock, { force: true }); }
    });
    queues.set(lock, next);
    try { return await next; } finally { if (queues.get(lock) === next) queues.delete(lock); }
  }
  async function resolve(event = {}, ctx = {}) {
    const base = { ...capability, source: capability.mode === "native" ? "host" : capability.mode === "legacy" ? "rc" : null,
      enabled: false, projectRoot: null };
    try {
      if (capability.mode === "unavailable") return base;
      const identity = sessionIdentity(event, ctx);
      const { entry } = await currentSession(api, identity);
      const permission = await projectPermission(api, identity);
      if (!permission || permission.sandboxed || ctx.sandboxed) throw new Error("HOST_SANDBOX_PROJECT_ACCESS_UNAVAILABLE");
      let directory, binding;
      if (capability.mode === "native") directory = nativeProjectDirectory(entry);
      else {
        binding = await read(file(identity, "binding"));
        if (!binding) return { ...base, identity, reason: "RC_SESSION_PROJECT_UNBOUND" };
        if (digest(binding.identity) !== digest(identity) || !binding.generation) throw new Error("RC_PROJECT_BINDING_INVALID");
        directory = binding.projectRoot;
      }
      if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("RC_PROJECT_PATH_INVALID");
      const projectRoot = await fs.realpath(directory);
      if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error("RC_PROJECT_NOT_DIRECTORY");
      // The host context remains the tool path authority even in legacy mode.
      // Never reinterpret a relative tool argument against an RC-only binding.
      const executionDirectory = ctx.workspaceDir ? await fs.realpath(ctx.workspaceDir) : capability.mode === "native" ? projectRoot : null;
      if (capability.mode === "native" && executionDirectory && executionDirectory !== projectRoot) throw new Error("HOST_PROJECT_CONTEXT_CONFLICT");
      const config = api.runtime.config?.current?.() ?? api.config ?? {};
      const confined = ctx.fsPolicy?.workspaceOnly || config.tools?.fs?.workspaceOnly
        || config.agents?.list?.find(a => a.id === identity.agentId)?.tools?.fs?.workspaceOnly;
      const policyWorkspace = executionDirectory ?? (confined ? await fs.realpath(api.runtime.agent.resolveAgentWorkspaceDir(config, identity.agentId)) : null);
      if (confined && (!policyWorkspace || !isPathInside(policyWorkspace, projectRoot))) {
        throw new Error("HOST_PROJECT_FILESYSTEM_POLICY_DENIED");
      }
      const scope = { ...base, identity, projectRoot, executionDirectory, binding,
        fingerprint: digest([capability.mode, projectRoot, binding?.generation ?? null]) };
      try {
        const source = await loadProjectConfigDocument(projectRoot);
        if (!source) return { ...scope, reason: "RC_PROJECT_NOT_ENABLED" };
        const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
        return { ...scope, enabled: api.pluginConfig?.enabled !== false, plan, reason: api.pluginConfig?.enabled === false ? "RC_PLUGIN_DISABLED" : null };
      } catch (error) { return { ...scope, reason: error.message }; }
    } catch (error) { return { ...base, reason: error.message }; }
  }
  async function activate(scope) {
    return mutate(scope.identity, async () => {
      const live = await resolve({}, { ...scope.identity, workspaceDir: scope.executionDirectory });
      if (!live.enabled || live.fingerprint !== scope.fingerprint) throw new Error("RC_PROJECT_SCOPE_CHANGED_BEFORE_ACTIVATION");
      const target = file(scope.identity, "scope"), previous = await read(target);
      if (previous?.fingerprint === scope.fingerprint) return previous;
      const record = { fingerprint: scope.fingerprint, projectRoot: scope.projectRoot, source: scope.source,
        taskId: `oc-scope-${randomUUID()}`, startAfter: scope.binding?.startAfter ?? null, startAt: null };
      if (previous && !scope.binding?.startAfter) {
        const observed = await observeNativeTranscript(api, { ...scope.identity, hostCompatibility: compatibility });
        if (observed.status !== "OBSERVED") throw new Error("HOST_PROJECT_SWITCH_TRANSCRIPT_UNAVAILABLE");
        record.startAt = observed.messages.findLast(x => (x.message ?? x).role === "user" && !x.isMeta)?.id ?? null;
        if (!record.startAt) throw new Error("HOST_PROJECT_SWITCH_USER_BOUNDARY_UNAVAILABLE");
      }
      await privateJson(target, record);
      return record;
    });
  }
  async function command(ctx) {
    const match = /^(status|bind|unbind)(?:\s+([\s\S]+))?$/u.exec(ctx.args?.trim() || "status");
    const action = match?.[1], subject = match?.[2];
    if (!action || action !== "bind" && subject) throw new Error("用法：/rc-project status | bind /绝对项目目录 | unbind");
    if (isInternalExecution() || !authorized(ctx, action !== "status")) throw new Error("需要可信用户身份及宿主读取/写入权限。");
    const identity = sessionIdentity({}, ctx);
    await currentSession(api, identity);
    if (action === "status") return resolve({}, ctx);
    if (capability.mode !== "legacy") throw new Error(capability.mode === "native"
      ? "宿主原生项目模式：RC 绑定、修改及解绑已禁用，请使用 OpenClaw 项目选择。" : "宿主项目能力无法核验，RC 项目变更已禁用。");
    // Command contexts expose no filesystem/sandbox authority. Resolve the
    // host policy and deny sandboxed or confined external paths conservatively.
    const config = api.runtime.config?.current?.() ?? api.config ?? {};
    const status = await projectPermission(api, identity);
    if (!status || status.sandboxed || ctx.sandboxed) throw new Error("HOST_PROJECT_BINDING_PERMISSION_UNAVAILABLE");
    let projectRoot;
    if (action === "bind") {
      if (!subject || !path.isAbsolute(subject) || subject.includes("\0")) throw new Error("绑定需要存在的绝对项目目录。");
      projectRoot = await fs.realpath(subject);
      if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error("RC_PROJECT_NOT_DIRECTORY");
      if (config.tools?.fs?.workspaceOnly === true || config.agents?.list?.find(a => a.id === identity.agentId)?.tools?.fs?.workspaceOnly === true) {
        const workspace = await fs.realpath(api.runtime.agent.resolveAgentWorkspaceDir(config, identity.agentId));
        if (!isPathInside(workspace, projectRoot)) throw new Error("HOST_PROJECT_FILESYSTEM_POLICY_DENIED");
      }
    }
    await mutate(identity, async () => {
      await currentSession(api, identity);
      const target = file(identity, "binding"), previous = await read(target);
      const observed = await observeNativeTranscript(api, { ...identity, hostCompatibility: compatibility });
      if (previous && observed.status !== "OBSERVED") throw new Error("HOST_PROJECT_SWITCH_TRANSCRIPT_UNAVAILABLE");
      // Abort review before publishing a changed binding.
      await onChanged(identity);
      await currentSession(api, identity);
      if ((await projectPermission(api, identity))?.sandboxed) throw new Error("HOST_PROJECT_BINDING_PERMISSION_CHANGED");
      if (action === "unbind") await fs.rm(target, { force: true });
      else await privateJson(target, { identity, projectRoot, generation: randomUUID(),
        startAfter: observed.status === "OBSERVED" ? observed.messages.at(-1)?.id ?? null : null });
    });
    return { ...await resolve({}, ctx), hostWorkingDirectoryChanged: false };
  }
  return { capability, resolve, activate, command, setOnChanged(callback) { onChanged = callback; } };
}

export function registerProjectCommand(api, projects) {
  api.registerCommand({ name: "rc-project", description: "查询 Session 的 RC 项目；旧版宿主可绑定或解绑", acceptsArgs: true,
    requireAuth: true, requiredScopes: ["operator.read"], async handler(ctx) {
      try {
        const { plan, binding, ...status } = await projects.command(ctx);
        return { text: JSON.stringify(status, null, 2) + (status.hostWorkingDirectoryChanged === false
          ? "\n仅更新 RC 纠偏作用域；宿主工作目录与工具路径由 OpenClaw 决定。" : "") };
      } catch (error) { return { text: error.message }; }
    } });
}
