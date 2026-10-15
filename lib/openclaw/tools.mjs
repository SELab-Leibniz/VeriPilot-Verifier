import path from "node:path";
import { promises as fs } from "node:fs";
import { localSkillRoots } from "../hosts/openclaw.mjs";
import { isPathInside } from "../path-utils.mjs";

export function toolName(name) {
  const short = String(name ?? "").split(".").at(-1).toLowerCase();
  return ({ write: "Write", write_file: "Write", edit: "Edit", edit_file: "Edit",
    read: "Read", read_file: "Read", exec: "Bash", exec_command: "Bash", bash: "Bash",
    powershell: "PowerShell", apply_patch: "Bash", skill: "Skill", process: "Monitor" })[short] ?? name;
}

export function changedFiles(name, args, cwd, toolCwd = cwd) {
  let files = [];
  if (["Write", "Edit"].includes(toolName(name))) files = [args.path ?? args.file_path ?? args.filePath];
  if (String(name).split(".").at(-1) === "apply_patch") {
    const patch = args.patch ?? args.input ?? args.patchText;
    if (typeof patch === "string" && /^\*\*\* Begin Patch\r?\n/u.test(patch)
      && /\r?\n\*\*\* End Patch\s*$/u.test(patch)) {
      files = [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)\r?$/gmu)].map((match) => match[1].trim());
    }
  }
  return [...new Set(files.filter((file) => typeof file === "string" && file && !file.includes("\0"))
    .map((file) => path.resolve(toolCwd ?? cwd, file)))].filter((file) => isPathInside(cwd, file)
      && !isPathInside(path.join(cwd, ".runtime-correction"), file));
}

export function sessionSkillPlan(plan, executionDirectory) {
  const skill = plan.runtimeV2?.skillCorrection;
  if (!skill?.enabled || !path.isAbsolute(executionDirectory ?? "")) return plan;
  // An RC-only project binding does not move OpenClaw's native workspace.
  // Use the exact trusted execution context, never the process cwd or an
  // Agent default, for both invocation recognition and later source refresh.
  const root = path.join(executionDirectory, "skills");
  if (skill.skillRoots.includes(root)) return plan;
  return { ...plan, runtimeV2: { ...plan.runtimeV2, skillCorrection: {
    ...skill, skillRoots: Object.freeze([...skill.skillRoots, root]),
  } } };
}

export async function selectedSkillRead(name, args, state, pluginRoot, configuredRoots = []) {
  if (toolName(name) !== "Read") return null;
  const file = args.path ?? args.file_path;
  if (typeof file !== "string" || path.basename(file) !== "SKILL.md") return null;
  let real;
  if (!path.isAbsolute(file) && !state.executionDirectory && state.projectScope) return null;
  try { real = await fs.realpath(path.resolve(state.executionDirectory ?? state.projectRoot, file)); } catch { return null; }
  for (const root of [...configuredRoots, ...localSkillRoots({ projectRoot: state.projectRoot, pluginRoot })]) {
    let canonical;
    try { canonical = await fs.realpath(root); } catch { continue; }
    if (!isPathInside(canonical, real)) continue;
    const relative = path.relative(canonical, path.dirname(real));
    if (!relative || relative.includes(path.sep)) continue;
    return relative;
  }
  return null;
}
