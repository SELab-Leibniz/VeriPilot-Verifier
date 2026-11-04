import { promises as fs } from "node:fs";
import path from "node:path";

import * as activeHost from "../active-host.mjs";
import { matchConfiguredArtifact } from "../artifact-pipeline.mjs";
import { hasLinkedPath } from "../path-utils.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { appendJsonLine, repairJsonLineTail, sha256 } from "./utils.mjs";

export const ORIGINAL_REQUIREMENTS_SCHEMA = "runtime-corrector.original-requirements.v1";
const USER_MESSAGE_LOG_SCHEMA = "runtime-corrector.user-message-log.v1";
const INTERNAL_MARKER = "[runtime-corrector:internal]";
const FEEDBACK_MARKER = "[runtime-corrector:feedback]";
const MAX_REFERENCED_FILES = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MANDATORY_REFERENCE_BYTES = 256 * 1024;
const SKIPPED_PARTS = new Set([".git", "node_modules", "oh_modules", ".runtime-correction"]);
const MISSING = ["ENOENT", "ENOTDIR", "EINVAL", "ENAMETOOLONG"];
// Path-like tokens with an extension, e.g. docs/prd.md, ./src/app.ts, 需求.md.
const PATH_TOKEN = /[^\s`'"“”‘’<>()[\]{}，。；：、！？|*]+\.[A-Za-z0-9]{1,8}/gu;
// Naming a code target in the request does not make its current implementation
// a requirement source; only text-like documents named by the user are.
const TEXT_REFERENCE = /\.(?:adoc|csv|json5?|markdown|mdx?|rst|toml|tsv|txt|xml|ya?ml)$/iu;

const toSlashes = value => value.replaceAll("\\", "/");
const projectRelative = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? toSlashes(relative) : null;
};
const identityKey = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
export const sensitiveOriginalName = file => /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|(?:credentials|secrets)(?:\.|$)|id_(?:rsa|ed25519)$)/iu.test(path.basename(file));
const skippedPath = (root, file) => toSlashes(path.relative(root, file)).split("/").some(part => SKIPPED_PARTS.has(part));
const utf8Text = bytes => !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes);
export const markdownTitle = text => String(text ?? "").match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/mu)?.[1]?.slice(0, 200) ?? null;

async function leadingText(file, limit = 64 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(limit), { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return ""; } finally { await handle?.close(); }
}

// One detector for document review and Stop: in-project or absolute text-like
// paths explicitly named by the user. Files beyond the mandatory budget stay
// listed as on-demand references instead of failing the basis.
export async function referencedOriginalFiles({ projectRoot, userMessages, plan = {}, exclude = [] }) {
  const root = path.resolve(projectRoot), artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  const skip = new Set(exclude.map(identityKey)), found = new Map(), referencedFiles = [];
  let referencesOmitted = 0, mandatoryBytes = 0;
  for (const message of userMessages) for (const token of message.text.match(PATH_TOKEN) ?? []) {
    const named = token.replace(/[.,;:!?]+$/u, "");
    if (!TEXT_REFERENCE.test(named)) continue;
    const absolute = path.resolve(root, named), relative = projectRelative(root, absolute);
    if (!relative && !path.isAbsolute(named) || skip.has(identityKey(absolute))) continue;
    const prior = found.get(identityKey(absolute));
    if (prior) { if (!prior.referencedBy.includes(message.order)) prior.referencedBy.push(message.order); continue; }
    if (sensitiveOriginalName(absolute) || skippedPath(root, absolute)
      || relative && matchConfiguredArtifact(relative, artifacts, plan.workflowCorrelation ?? null)) continue;
    let stat;
    try { stat = await fs.stat(absolute); } catch (error) { if (MISSING.includes(error.code)) continue; throw error; }
    if (!stat.isFile() || await hasLinkedPath(absolute)) continue;
    if (referencedFiles.length >= MAX_REFERENCED_FILES) { referencesOmitted++; continue; }
    const name = relative ?? toSlashes(absolute);
    let entry;
    if (stat.size > MAX_FILE_BYTES) entry = { path: name, bytes: stat.size, sha256: null, referencedBy: [message.order],
      mandatory: false, note: "Larger than 4 MiB; not hashed. Read the needed sections on demand." };
    else {
      const bytes = await fs.readFile(absolute);
      if (!utf8Text(bytes)) continue;
      const mandatory = mandatoryBytes + bytes.length <= MANDATORY_REFERENCE_BYTES;
      if (mandatory) mandatoryBytes += bytes.length;
      entry = { path: name, bytes: bytes.length, sha256: sha256(bytes), referencedBy: [message.order],
        ...(mandatory ? {} : { mandatory: false, note: "Outside the 256 KiB mandatory reference budget. Read the needed sections on demand." }) };
    }
    found.set(identityKey(absolute), entry);
    referencedFiles.push(entry);
  }
  return { referencedFiles, ...(referencesOmitted ? { referencesOmitted } : {}) };
}

// Reference tier: material roots are optional context. Entries come from the
// task-start capture (status, start identity, frozen original) or, without one,
// from the live manifest as UNTRACKED.
export async function referenceMaterialFiles({ projectRoot, plan = {}, entries = [], exclude = [] }) {
  const root = path.resolve(projectRoot), artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  const skip = new Set(exclude.map(identityKey)), files = [];
  for (const entry of entries) {
    const file = path.resolve(entry.root ?? root, entry.path), relative = projectRelative(root, file);
    if (skip.has(identityKey(file)) || sensitiveOriginalName(file) || skippedPath(root, file)
      || relative && matchConfiguredArtifact(relative, artifacts, plan.workflowCorrelation ?? null)) continue;
    skip.add(identityKey(file));
    const status = entry.status ?? "UNTRACKED", tracked = status !== "UNTRACKED";
    const original = entry.original ? Buffer.from(entry.original) : null;
    const currentBytes = tracked ? entry.currentBytes : entry.bytes, currentSha256 = tracked ? entry.currentSha256 : entry.sha256;
    files.push({ path: relative ?? toSlashes(file), bytes: tracked && status !== "ADDED" ? entry.bytes : currentBytes ?? null,
      title: markdownTitle(original ? original.toString("utf8") : await leadingText(file)),
      sha256: tracked && status !== "ADDED" ? entry.sha256 : null, status,
      ...(status === "UNCHANGED" || status === "DELETED" ? {} : { currentBytes: currentBytes ?? null, currentSha256: currentSha256 ?? null }),
      ...(original ? { originalBase64: original.toString("base64") } : {}) });
  }
  return files;
}

// A user-named file that the business later edited keeps its task-start bytes.
export function attachReferencedOriginals(referencedFiles, entries, projectRoot) {
  const root = path.resolve(projectRoot), captured = new Map(entries.filter(entry => entry.original)
    .map(entry => [identityKey(path.resolve(entry.root ?? root, entry.path)), entry]));
  return referencedFiles.map(file => {
    const entry = captured.get(identityKey(path.resolve(root, file.path)));
    return entry ? { ...file, status: entry.status, originalSha256: entry.sha256, originalBytes: entry.bytes,
      originalBase64: Buffer.from(entry.original).toString("base64") } : file;
  });
}

function userText(entry) {
  if (entry.type !== "user" || entry.isMeta === true) return null;
  const content = entry.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  if (blocks.some(block => block?.type === "tool_result")) return null;
  const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
  return text.trim() && !text.includes(INTERNAL_MARKER) ? text : null;
}

export function transcriptUserMessages(snapshot) {
  const messages = [];
  for (const entry of snapshot?.entries ?? []) {
    const text = userText(entry);
    if (!text) continue;
    const id = [entry.uuid, entry.message?.id, entry.entryKey].find(Boolean) ?? messages.length + 1;
    messages.push({ ref: `transcript:${id}`, timestamp: entry.timestamp ?? null, text });
  }
  return messages;
}

// The document review and the Stop original basis both read this session log.
export const archivesUserMessages = runtimeV2 => runtimeV2?.artifactCorrection?.originalRequirementsEnabled === true
  || runtimeV2?.stopCorrection?.originalRequirementsBasis === true;

export function userMessageLogPath(projectRoot, sessionId) {
  return path.join(path.resolve(projectRoot), OUTPUT_TREE_DIRECTORY, "original-requirements",
    `${sha256(String(sessionId)).slice(0, 24)}.jsonl`);
}

// A host compaction may rewrite the transcript to a shorter file. Every real
// user message seen once stays a requirement source for the session.
export async function recordUserMessages({ projectRoot, sessionId, snapshot }) {
  const live = transcriptUserMessages(snapshot);
  if (!sessionId) return live;
  const file = userMessageLogPath(projectRoot, sessionId);
  let lines = [];
  try { lines = (await fs.readFile(file, "utf8")).split(/\r?\n/u); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const logged = [];
  for (const line of lines) {
    let record;
    try { record = line.trim() ? JSON.parse(line) : null; } catch { record = null; }
    if (record?.schemaVersion === USER_MESSAGE_LOG_SCHEMA && typeof record.text === "string"
      && !logged.some(message => message.ref === record.ref)) logged.push({ ref: record.ref, timestamp: record.timestamp ?? null, text: record.text });
  }
  const added = live.filter(message => !logged.some(prior => prior.ref === message.ref));
  if (added.length) await repairJsonLineTail(file);
  for (const message of added) await appendJsonLine(file, { schemaVersion: USER_MESSAGE_LOG_SCHEMA, ...message });
  const liveRefs = new Set(live.map(message => message.ref));
  return [...logged.map(message => liveRefs.has(message.ref) ? message : { ...message, retainedAfterCompaction: true }), ...added];
}

async function fileIdentity(root, relative) {
  if (relative.split("/").some(part => SKIPPED_PARTS.has(part))) return null;
  const absolute = path.resolve(root, relative);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return { path: relative, bytes: stat.size, sha256: sha256(await fs.readFile(absolute)) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EINVAL", "ENAMETOOLONG"].includes(error.code)) return null;
    throw error;
  }
}

// Requirements come from the user and the declared task materials. Configured
// artifacts are agent output and can never review themselves. In the reference
// tier the materials are optional context listed with their task-start status.
export async function buildOriginalRequirements({ projectRoot, sessionId = null, snapshot, materials = null, plan = {}, hostAdapter = activeHost,
  referenceTier = false, readReferenceMaterials = null }) {
  const root = path.resolve(projectRoot);
  const artifacts = plan.configuredArtifacts ?? plan.artifacts ?? [];
  const isArtifact = relative => Boolean(matchConfiguredArtifact(relative, artifacts, plan.workflowCorrelation ?? null));
  const userMessages = (await recordUserMessages({ projectRoot: root, sessionId, snapshot }))
    .map(({ ref, timestamp, text, retainedAfterCompaction }, index) => ({ order: index + 1, ref, timestamp,
      characters: text.length, sha256: sha256(text), text,
      ...(retainedAfterCompaction ? { retainedAfterCompaction } : {}),
      ...(text.includes(FEEDBACK_MARKER) ? { containsCorrectorFeedback: true } : {}) }));
  const listed = new Set();
  const materialFiles = [];
  if (!referenceTier) for (const entry of materials?.entries ?? []) {
    const absolute = path.resolve(entry.root, entry.path);
    const relative = projectRelative(root, absolute);
    const name = relative ?? toSlashes(absolute);
    if (listed.has(name) || (relative && isArtifact(relative))) continue;
    listed.add(name);
    materialFiles.push({ path: name, bytes: entry.bytes ?? null, sha256: entry.sha256 ?? null });
  }
  const projectFiles = [];
  for (const name of hostAdapter.instructionFileNames ?? []) {
    const identity = await fileIdentity(root, name);
    if (identity && !listed.has(identity.path)) { listed.add(identity.path); projectFiles.push(identity); }
  }
  const { referencedFiles: named, referencesOmitted } = await referencedOriginalFiles({ projectRoot: root, userMessages, plan,
    exclude: [...listed].map(name => path.resolve(root, name)) });
  let referencedFiles = named;
  if (referenceTier) {
    const entries = readReferenceMaterials ? await readReferenceMaterials() : materials?.entries ?? [];
    referencedFiles = attachReferencedOriginals(named, entries, root);
    materialFiles.push(...await referenceMaterialFiles({ projectRoot: root, plan, entries,
      exclude: [...projectFiles, ...named].map(file => path.resolve(root, file.path)) }));
  }
  const digest = sha256({
    userMessages: userMessages.map(({ ref, sha256: hash }) => [ref, hash]),
    materials: materialFiles.map(file => referenceTier ? [file.path, file.sha256, file.status] : [file.path, file.sha256]),
    projectFiles: projectFiles.map(file => [file.path, file.sha256]),
    referencedFiles: referencedFiles.map(file => [file.path, file.sha256]),
  });
  return { schemaVersion: ORIGINAL_REQUIREMENTS_SCHEMA, digest, userMessages, materials: materialFiles,
    projectFiles, referencedFiles, ...(referenceTier ? { materialTier: "reference" } : {}), ...(referencesOmitted ? { referencesOmitted } : {}) };
}

// Full message bodies stay in files; the request carries an inline copy only
// while the shared budget lasts, so long sessions remain one bounded read.
export async function writeOriginalRequirementSources(directory, requirements, { inlineBudget = 24 * 1024, previewCharacters = 300 } = {}) {
  const sourceDirectory = path.join(directory, "user-sources");
  if (requirements.userMessages.length) await fs.mkdir(sourceDirectory, { recursive: true });
  let budget = inlineBudget;
  const userMessages = [];
  for (const { text, ...message } of requirements.userMessages) {
    const file = path.join(sourceDirectory, `${message.order}-${message.sha256.slice(0, 16)}.txt`);
    await fs.writeFile(file, text, { mode: 0o600 });
    const bytes = Buffer.byteLength(text);
    const inline = bytes <= budget;
    if (inline) budget -= bytes;
    userMessages.push({ ...message, path: toSlashes(file), ...(inline ? { text } : { preview: text.slice(0, previewCharacters) }) });
  }
  const written = await writeFrozenOriginals(directory, { materials: requirements.materials, referencedFiles: requirements.referencedFiles });
  return { ...requirements, userMessages, ...written };
}

// Task-start bytes of a reference that changed or disappeared, readable from
// the request directory; the base64 transport copy never reaches a prompt.
export async function writeFrozenOriginals(directory, lists) {
  const originalDirectory = path.join(directory, "reference-originals"), written = {};
  let count = 0;
  for (const [name, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) continue;
    written[name] = [];
    for (const { originalBase64, ...file } of list) {
      if (typeof originalBase64 !== "string") { written[name].push(file); continue; }
      const bytes = Buffer.from(originalBase64, "base64");
      const target = path.join(originalDirectory, `${++count}-${sha256(bytes).slice(0, 16)}-${path.basename(file.path)}`);
      await fs.mkdir(originalDirectory, { recursive: true });
      await fs.writeFile(target, bytes, { mode: 0o600 });
      written[name].push({ ...file, frozenOriginal: toSlashes(target) });
    }
  }
  return written;
}
