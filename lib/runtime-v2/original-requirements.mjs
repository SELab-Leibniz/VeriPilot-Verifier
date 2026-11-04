import { promises as fs } from "node:fs";
import path from "node:path";

import * as activeHost from "../active-host.mjs";
import { matchConfiguredArtifact } from "../artifact-pipeline.mjs";
import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { appendJsonLine, repairJsonLineTail, sha256 } from "./utils.mjs";

export const ORIGINAL_REQUIREMENTS_SCHEMA = "runtime-corrector.original-requirements.v1";
const USER_MESSAGE_LOG_SCHEMA = "runtime-corrector.user-message-log.v1";
const INTERNAL_MARKER = "[runtime-corrector:internal]";
const FEEDBACK_MARKER = "[runtime-corrector:feedback]";
const MAX_REFERENCED_FILES = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SKIPPED_PARTS = new Set([".git", "node_modules", "oh_modules", ".runtime-correction"]);
// Path-like tokens with an extension, e.g. docs/prd.md, ./src/app.ts, 需求.md.
const PATH_TOKEN = /[^\s`'"“”‘’<>()[\]{}，。；：、！？|*]+\.[A-Za-z0-9]{1,8}/gu;

const toSlashes = value => value.replaceAll("\\", "/");
const projectRelative = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? toSlashes(relative) : null;
};

function userText(entry) {
  if (entry.type !== "user" || entry.isMeta === true) return null;
  const content = entry.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  if (blocks.some(block => block?.type === "tool_result")) return null;
  const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
  return text.trim() && !text.includes(INTERNAL_MARKER) ? text : null;
}

function transcriptUserMessages(snapshot) {
  const messages = [];
  for (const entry of snapshot?.entries ?? []) {
    const text = userText(entry);
    if (!text) continue;
    const id = [entry.uuid, entry.message?.id, entry.entryKey].find(Boolean) ?? messages.length + 1;
    messages.push({ ref: `transcript:${id}`, timestamp: entry.timestamp ?? null, text });
  }
  return messages;
}

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
// artifacts are agent output and can never review themselves.
export async function buildOriginalRequirements({ projectRoot, sessionId = null, snapshot, materials = null, plan = {}, hostAdapter = activeHost }) {
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
  for (const entry of materials?.entries ?? []) {
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
  const referencedFiles = [];
  let referencesOmitted = 0;
  for (const message of userMessages) {
    for (const token of message.text.match(PATH_TOKEN) ?? []) {
      const relative = projectRelative(root, path.resolve(root, token.replace(/[.,;:!?]+$/u, "")));
      if (!relative || isArtifact(relative)) continue;
      const existing = referencedFiles.find(file => file.path === relative);
      if (existing) { if (!existing.referencedBy.includes(message.order)) existing.referencedBy.push(message.order); continue; }
      if (listed.has(relative)) continue;
      const identity = await fileIdentity(root, relative);
      if (!identity) continue;
      if (referencedFiles.length >= MAX_REFERENCED_FILES) { referencesOmitted++; continue; }
      listed.add(relative);
      referencedFiles.push({ ...identity, referencedBy: [message.order] });
    }
  }
  const digest = sha256({
    userMessages: userMessages.map(({ ref, sha256: hash }) => [ref, hash]),
    materials: materialFiles.map(file => [file.path, file.sha256]),
    projectFiles: projectFiles.map(file => [file.path, file.sha256]),
    referencedFiles: referencedFiles.map(file => [file.path, file.sha256]),
  });
  return { schemaVersion: ORIGINAL_REQUIREMENTS_SCHEMA, digest, userMessages, materials: materialFiles,
    projectFiles, referencedFiles, ...(referencesOmitted ? { referencesOmitted } : {}) };
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
  return { ...requirements, userMessages };
}
