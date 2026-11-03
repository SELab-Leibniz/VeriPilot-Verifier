import path from "node:path";
import { promises as fs } from "node:fs";
import { localSkillRoots } from "../hosts/openclaw.mjs";
import { hasLinkedPath, isPathInside } from "../path-utils.mjs";
import { isSkillFileName, skillDirectories } from "../runtime-v2/skill-source.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { matchesAny } from "../artifact-pipeline.mjs";
import { matchPathTemplates } from "../path-template.mjs";

export function toolName(name) {
  const short = String(name ?? "").split(".").at(-1).toLowerCase();
  return ({ write: "Write", write_file: "Write", edit: "Edit", edit_file: "Edit",
    read: "Read", read_file: "Read", exec: "Bash", exec_command: "Bash", bash: "Bash",
    powershell: "PowerShell", apply_patch: "Bash", notebookedit: "NotebookEdit", notebook_edit: "NotebookEdit",
    skill: "Skill", process: "Monitor", monitor: "Monitor" })[short] ?? name;
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

export function isDocumentCommand(name) {
  return ["Bash", "PowerShell"].includes(toolName(name)) && String(name).split(".").at(-1) !== "apply_patch";
}

export async function snapshotDocumentFiles(plan, projectRoot, { observedPaths = [], active = () => {}, deadlineAt = performance.now() + 1000 } = {}) {
  const artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  if (!artifacts.length) return null;
  let root;
  try { root = await fs.realpath(projectRoot); }
  catch (error) { return { projectRoot: path.resolve(projectRoot), declarationsDigest: null, entries: [],
    unverified: [error.code ?? "DOCUMENT_SNAPSHOT_FAILED"], capturedAt: Date.now(), bytes: 0 }; }
  const declarations = [], paths = new Map(), unverified = [], entries = [];
  const key = file => process.platform === "win32" ? file.toLowerCase() : file;
  const add = value => {
    if (typeof value !== "string" || !value || value.includes("\0")) { unverified.push("DOCUMENT_PATH_INVALID"); return; }
    const file = path.resolve(root, value), relative = path.relative(root, file);
    if (!isPathInside(root, file) || !relative || relative.split(path.sep).some(part => [".git", "node_modules", ".runtime-correction", ".runtime-corrector"].includes(part.toLowerCase()))) {
      unverified.push("DOCUMENT_PATH_OUTSIDE_SCOPE"); return;
    }
    if (paths.size >= 128 && !paths.has(key(file))) { unverified.push("DOCUMENT_FILE_LIMIT"); return; }
    paths.set(key(file), file);
  };
  for (const artifact of artifacts.slice(0, 128)) {
    const declared = artifact.pathTemplates ?? artifact.patterns ?? [];
    declarations.push({ id: artifact.nodeId ?? artifact.name, paths: declared });
    for (const value of declared.slice(0, 128)) {
      if (typeof value === "string" && !/[*?{}[\]!]/u.test(value)) add(value);
      else unverified.push("DOCUMENT_DECLARATION_UNRESOLVED");
    }
    if (declared.length > 128) unverified.push("DOCUMENT_DECLARATION_LIMIT");
  }
  if (artifacts.length > 128) unverified.push("DOCUMENT_DECLARATION_LIMIT");
  for (const file of [...observedPaths].slice(0, 128)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (artifacts.slice(0, 128).some(artifact => matchesAny(relative, artifact.patterns ?? [])
      || matchPathTemplates(relative, artifact.pathMatcher?.templates))) add(file);
  }
  let bytes = 0;
  const current = () => {
    active();
    if (performance.now() >= deadlineAt) throw Object.assign(new Error("Document pre-execution snapshot expired"), { code: "DOCUMENT_SNAPSHOT_TIMEOUT" });
  };
  for (const file of paths.values()) {
    if (performance.now() >= deadlineAt) { unverified.push("DOCUMENT_SNAPSHOT_TIMEOUT"); break; }
    let handle;
    try {
      current();
      if (await hasLinkedPath(file)) throw Object.assign(new Error("Linked document"), { code: "DOCUMENT_LINKED_SOURCE" });
      handle = await fs.open(file, "r");
      const before = await handle.stat({ bigint: true }), size = Number(before.size);
      if (!before.isFile() || size > 4 * 1024 * 1024 || bytes + size > 16 * 1024 * 1024)
        throw Object.assign(new Error("Document snapshot limit"), { code: "DOCUMENT_SNAPSHOT_LIMIT" });
      const buffer = Buffer.alloc(size + 1); let count = 0;
      while (count < buffer.length) {
        current(); const read = await handle.read(buffer, count, buffer.length - count, count);
        if (!read.bytesRead) break; count += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), present = await fs.lstat(file, { bigint: true }); current();
      if (!present.isFile() || present.dev !== before.dev || present.ino !== before.ino || count !== size
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || await hasLinkedPath(file))
        throw Object.assign(new Error("Document changed during snapshot"), { code: "DOCUMENT_SNAPSHOT_UNSTABLE" });
      bytes += count; entries.push({ file, sha256: sha256(buffer.subarray(0, count)) });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) entries.push({ file, sha256: "missing" });
      else { entries.push({ file, sha256: null }); unverified.push(error.code ?? "DOCUMENT_SNAPSHOT_FAILED"); }
    } finally { await handle?.close(); }
  }
  if (performance.now() >= deadlineAt) unverified.push("DOCUMENT_SNAPSHOT_TIMEOUT");
  return { projectRoot: root, declarationsDigest: sha256(declarations), entries, unverified: [...new Set(unverified)],
    capturedAt: Date.now(), bytes };
}

export async function documentCommandChanges(before, plan, projectRoot, options = {}) {
  const after = await snapshotDocumentFiles(plan, projectRoot, options);
  if (!after) return null;
  const unverified = [...after.unverified, ...(before?.unverified ?? [])];
  if (!before) unverified.push("DOCUMENT_PRE_SNAPSHOT_MISSING");
  if (before && (before.projectRoot !== after.projectRoot || before.declarationsDigest !== after.declarationsDigest))
    unverified.push("DOCUMENT_DECLARATION_CHANGED");
  if (options.pending) unverified.push("DOCUMENT_EXECUTION_PENDING");
  const originals = new Map((before?.entries ?? []).map(entry => [entry.file, entry.sha256]));
  const files = after.entries.filter(entry => typeof entry.sha256 === "string" && typeof originals.get(entry.file) === "string"
    && entry.sha256 !== originals.get(entry.file)).map(entry => entry.file);
  return { status: unverified.length ? "UNVERIFIED" : "VERIFIED", files, unverified: [...new Set(unverified)],
    declarationsDigest: after.declarationsDigest, checkedFiles: after.entries.length, currentFiles: after.entries,
    capturedAt: after.capturedAt };
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

export async function selectedSkillRead(name, args, state, pluginRoot, configuredRoots = [], hostOptions = {}) {
  if (toolName(name) !== "Read") return null;
  const file = args.path ?? args.file_path ?? args.filePath;
  if (typeof file !== "string" || !isSkillFileName(path.basename(file))) return null;
  let real;
  if (!path.isAbsolute(file) && !state.executionDirectory && state.projectScope) return null;
  try { real = await fs.realpath(path.resolve(state.executionDirectory ?? state.projectRoot, file)); } catch { return null; }
  const roots = [...localSkillRoots({ projectRoot: state.executionDirectory ?? state.projectRoot, pluginRoot, ...hostOptions }), ...configuredRoots];
  for (const root of [...new Set(roots)]) {
    for await (const source of skillDirectories(root)) {
      if (path.relative(source.sourceIdentity.path, real) === '') return { skillId: source.skillId, sourceIdentity: source.sourceIdentity };
    }
  }
  return null;
}
