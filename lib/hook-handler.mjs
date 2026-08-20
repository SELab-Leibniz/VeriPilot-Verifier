import path from "node:path";

import { isPathInside } from "./path-utils.mjs";


export function createHookHandler({
  defaultPluginRoot,
  checkArtifact,
  resolveInputFile,
  findPolicyRootForFile,
  transcriptHasPublicCommandContext,
}) {
  return async function handleHook(input, options = {}) {
    const supportedTools = new Set(["Write", "Edit"]);
    if (!supportedTools.has(input.tool_name)) {
      return { matched: false, reason: "unsupported-tool" };
    }

    const hookCwd = path.resolve(input.cwd ?? options.cwd ?? process.cwd());
    const triggerFile = resolveInputFile(input, hookCwd);
    if (!triggerFile) {
      return { matched: false, reason: "missing-file-path" };
    }
    const discoveredRoot = await findPolicyRootForFile(triggerFile);
    if (!discoveredRoot && !isPathInside(hookCwd, triggerFile)) {
      return { matched: false, reason: "outside-project" };
    }
    const cwd = discoveredRoot ?? hookCwd;
    const hasPublicCommandContext = await transcriptHasPublicCommandContext(
      input.transcript_path,
    );
    const outcome = await checkArtifact({
      filePath: triggerFile,
      cwd,
      pluginRoot: options.pluginRoot ?? defaultPluginRoot,
      config: options.config,
      projectRootSource: discoveredRoot ? "artifact-policy-discovery" : "hook-cwd",
      deferPersistence: options.deferPersistence ?? false,
      includePublicCommandContext: !hasPublicCommandContext,
    });
    return { ...outcome, projectRoot: cwd };
  };
}
