import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { matchConfiguredArtifact } from "../artifact-pipeline.mjs";
import { outsideDecision } from "./decision-scope.mjs";
import { OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY, outputTreeDirectory } from "./paths.mjs";
import { taskDirectory } from "./task-store.mjs";

const MANIFEST_VERSION = 1, MAX_ENTRIES = 4096, MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const CAPTURE_BUDGET_MS = 2000, COMPARE_BUDGET_MS = 5000;
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--",
  ".", `:(exclude,glob)**/${OUTPUT_TREE_DIRECTORY}/**`, `:(exclude,glob)**/${POLICY_ROOT_DIRECTORY}*/**`];
const failure = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export const taskStartManifestPath = (projectRoot, taskId) => path.join(taskDirectory(projectRoot, taskId), "task-start.json");

function git(args, cwd, deadlineAt) {
  const timeout = deadlineAt - Date.now();
  if (timeout <= 0) return Promise.reject(failure("TASK_CHANGES_DEADLINE"));
  // Git must not refresh the business index while RC only observes it.
  return new Promise((resolve, reject) => execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", windowsHide: true,
    timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(failure("TASK_CHANGES_GIT_UNAVAILABLE")) : resolve(stdout)));
}

async function fingerprint(file) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return { hash: "missing", bytes: 0 }; throw error; }
  if (stat.isSymbolicLink()) return { hash: `link:${digest(await fs.readlink(file))}`, bytes: 0 };
  if (stat.isDirectory()) return { hash: "directory", bytes: 0 };
  if (stat.size > MAX_FILE_BYTES) return { hash: `stat:${stat.size}:${stat.mtimeMs}`, bytes: 0 };
  return { hash: digest(await fs.readFile(file)), bytes: stat.size };
}

async function workspaceState(projectRoot, deadlineAt) {
  const prefix = (await git(["rev-parse", "--show-prefix"], projectRoot, deadlineAt)).trim();
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], projectRoot, deadlineAt).catch(() => "")).trim() || null;
  const records = (await git(STATUS_ARGS, projectRoot, deadlineAt)).split("\0").filter(record => record.length > 3);
  if (records.length > MAX_ENTRIES) throw failure("TASK_CHANGES_TOO_MANY");
  const entries = {};
  let bytes = 0;
  for (const record of records) {
    if (Date.now() >= deadlineAt) throw failure("TASK_CHANGES_DEADLINE");
    const listed = record.slice(3), file = (listed.startsWith(prefix) ? listed.slice(prefix.length) : listed).replace(/\/$/u, "");
    const value = await fingerprint(path.join(projectRoot, file));
    if ((bytes += value.bytes) > MAX_TOTAL_BYTES) throw failure("TASK_CHANGES_TOO_LARGE");
    entries[file] = { code: record.slice(0, 2), hash: value.hash };
  }
  return { prefix, head, entries };
}

// Only a task created by a pre-mutation event has a trustworthy start state.
export async function captureTaskStart({ projectRoot, taskId, deadlineAt = Infinity }) {
  const file = taskStartManifestPath(projectRoot, taskId);
  return outsideDecision(async () => {
    if (await fs.access(file).then(() => true, () => false)) return false;
    let manifest;
    try {
      manifest = { version: MANIFEST_VERSION, complete: true, capturedAt: new Date().toISOString(),
        ...await workspaceState(path.resolve(projectRoot), Math.min(deadlineAt, Date.now() + CAPTURE_BUDGET_MS)) };
    } catch (error) {
      manifest = { version: MANIFEST_VERSION, complete: false, capturedAt: new Date().toISOString(),
        reasonCode: typeof error.code === "string" ? error.code : "TASK_CHANGES_UNAVAILABLE" };
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(manifest), { flag: "wx" });
      return manifest.complete;
    } catch { return false; }
  });
}

function changeRoots(artifacts, correlation) {
  const roots = [];
  for (const artifact of artifacts) for (const { template } of artifact.pathMatcher?.kind === "template" ? artifact.pathMatcher.templates : []) {
    const segments = template.split("/"), index = segments.findIndex(segment => segment.includes("{"));
    const key = /^\{([A-Za-z][A-Za-z0-9_-]*)\}$/u.exec(segments[index] ?? "")?.[1];
    if (index < 1 || index >= segments.length - 1 || !key || correlation && !correlation.keys.includes(key)) continue;
    roots.push(new RegExp(`^${segments.slice(0, index).map(value => value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")).join("/")}/[^/]+/`, "iu"));
  }
  return roots;
}

const reviewedArtifacts = plan => (plan.artifacts ?? []).filter(artifact => artifact.reviewEnabled !== false);
function ownedArtifact(file, plan) {
  try { return matchConfiguredArtifact(file, reviewedArtifacts(plan), plan.workflowCorrelation ?? null)?.artifact ?? null; }
  catch { return null; }
}

export function changeOwner(file, plan = {}) {
  const segments = file.split("/"), output = outputTreeDirectory(plan.output);
  if (segments.some(segment => segment === OUTPUT_TREE_DIRECTORY || segment === output || segment.startsWith(POLICY_ROOT_DIRECTORY)))
    return "RUNTIME_CORRECTOR";
  if (ownedArtifact(file, plan)) return "DOCUMENT_CORRECTION";
  return changeRoots(reviewedArtifacts(plan), plan.workflowCorrelation ?? null).some(root => root.test(file)) ? "DOCUMENT_CORRECTION" : "STOP";
}

const statusOf = code => code === "??" ? "UNTRACKED" : code.includes("D") ? "DELETED" : code.includes("A") ? "ADDED" : "MODIFIED";

// null means unknown: no trustworthy start manifest, no git, or a bounded
// capture overflowed. Callers must then treat the task as having changes.
export async function taskChanges({ projectRoot, taskId, plan = {}, deadlineAt = Infinity }) {
  let start;
  try { start = JSON.parse(await fs.readFile(taskStartManifestPath(projectRoot, taskId), "utf8")); }
  catch { return null; }
  if (start?.version !== MANIFEST_VERSION || start.complete !== true) return null;
  const root = path.resolve(projectRoot), limit = Math.min(deadlineAt, Date.now() + COMPARE_BUDGET_MS);
  const changes = new Map();
  try {
    const current = await workspaceState(root, limit);
    if (current.prefix !== start.prefix || start.head && !current.head) return null;
    for (const [file, entry] of Object.entries(current.entries))
      if (start.entries[file]?.hash !== entry.hash || entry.hash === "directory") changes.set(file, statusOf(entry.code));
    if (current.head && current.head !== start.head) {
      const committed = start.head
        ? await git(["diff", "--name-only", "-z", "--no-renames", "--relative", start.head, current.head, "--"], root, limit)
        : await git(["ls-tree", "-r", "-z", "--name-only", current.head], root, limit);
      for (const file of committed.split("\0").filter(Boolean)) if (!changes.has(file)) changes.set(file, "COMMITTED");
    }
    for (const file of Object.keys(start.entries)) if (!Object.hasOwn(current.entries, file) && !changes.has(file)) changes.set(file, "RESTORED");
  } catch { return null; }
  return { startHead: start.head, changes: [...changes].map(([file, status]) => ({ path: file, status, owner: changeOwner(file, plan) }))
    .filter(change => change.owner !== "RUNTIME_CORRECTOR").sort((left, right) => left.path.localeCompare(right.path)) };
}

export async function nonArtifactChanges(options) {
  const result = await taskChanges(options);
  return result ? result.changes.filter(change => change.owner === "STOP").map(({ path: file, status }) => ({ path: file, status })) : null;
}

// An artifact that declares Stop metrics keeps its Stop stage checkpoint.
export async function documentOnlyChanges(options) {
  const result = await taskChanges(options);
  return result?.changes.length && result.changes.every(change => change.owner === "DOCUMENT_CORRECTION"
    && !ownedArtifact(change.path, options.plan ?? {})?.metrics?.length) ? result.changes : null;
}
