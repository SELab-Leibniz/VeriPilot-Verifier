import { promises as fs } from "node:fs";
import path from "node:path";


async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known native executable location.
    }
  }
  return null;
}


export async function resolveClaudeExecutable(env = process.env, platform = process.platform) {
  const explicit = env.RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE
    || env.CLAUDE_CODE_EXECUTABLE;
  if (explicit) return explicit;
  if (platform === "win32") {
    const candidates = [
      env.APPDATA
        ? path.join(
          env.APPDATA,
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "bin",
          "claude.exe",
        )
        : null,
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, "Programs", "claude", "claude.exe")
        : null,
    ];
    return await firstExecutable(candidates) ?? "claude.exe";
  }
  return "claude";
}
