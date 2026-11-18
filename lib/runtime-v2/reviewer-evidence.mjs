import path from "node:path";
import { promises as fs } from "node:fs";

import { atomicWriteJson, sha256 } from "./utils.mjs";
import { assertReviewScopeActive, finalizeReviewScopeRequest, prepareReviewScope, REVIEW_SCOPE_PAGE_BYTES } from "./review-scope.mjs";

const RECENT_TRANSCRIPT_BYTES = 24 * 1024;
const RECENT_TRANSCRIPT_ENTRIES = 24;

// Navigation over the already frozen transcript, never a summary or a new
// source of authority. Keep complete entries; oversized ones remain reachable
// in the full source instead of silently truncating their contents.
function recentTranscript(entries, source, invocation) {
  let line = 3;
  const refs = entries.map((entry, index) => {
    const lineCount = JSON.stringify(entry, null, 2).split("\n").length;
    const ref = { index, startLine: line, lineCount, sha256: sha256(entry) };
    line += lineCount;
    return ref;
  });
  const content = entry => Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const identity = value => typeof value === 'string' && Buffer.byteLength(value) <= 1024 ? value : null;
  const latestUser = entries.findLastIndex(entry => entry?.type === 'user' && !entry.isMeta
    && !content(entry).some(block => block.type === 'tool_result'));
  const calls = new Map();
  for (let index = 0; index < entries.length; index++) for (const block of content(entries[index]))
    if (block.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, calls.has(block.id) ? null : index);
  const results = [];
  for (let index = entries.length - 1; index >= 0 && results.length < 8; index--)
    for (const block of content(entries[index])) if (block.type === 'tool_result' && results.length < 8)
      results.push({ ...refs[index], toolUseId: identity(block.tool_use_id),
        ...(Number.isInteger(calls.get(block.tool_use_id)) ? { call: refs[calls.get(block.tool_use_id)] } : {}) });
  const view = {
    protocol: 'review-transcript-navigation-v1', source,
    instructions: 'Read these recent whole entries before judging current execution. Indices and line ranges refer to the full frozen transcript; use read offset/startLine and limit/lineCount to retrieve omitted entries. This selection is not complete history or a semantic summary. Missing or unread evidence is UNVERIFIED, never proof that an action did not occur.',
    ...(invocation && (identity(invocation.runId) || identity(invocation.sessionId)) ? {
      invocation: { ...(identity(invocation.runId) ? { runId: invocation.runId } : {}),
        ...(identity(invocation.sessionId) ? { sessionId: invocation.sessionId } : {}) },
    } : {}),
    latestExternalUser: latestUser < 0 ? null : { ...refs[latestUser],
      sourceMessageId: identity(entries[latestUser].sourceMessageId) },
    recentToolResults: results.reverse(), complete: entries.length === 0, omittedEntryCount: entries.length, entries: [],
  };
  const selected = new Map();
  const add = index => {
    const next = [...selected, [index, entries[index]]].sort(([a], [b]) => a - b)
      .map(([sourceIndex, entry]) => ({ sourceIndex, entry }));
    const candidate = { ...view, entries: next, omittedEntryCount: entries.length - next.length,
      complete: next.length === entries.length };
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2) + '\n') <= RECENT_TRANSCRIPT_BYTES) {
      selected.set(index, entries[index]); Object.assign(view, candidate);
    }
  };
  if (latestUser >= 0) add(latestUser);
  for (let index = entries.length - 1; index >= Math.max(0, entries.length - RECENT_TRANSCRIPT_ENTRIES); index--)
    if (!selected.has(index)) add(index);
  return view;
}


/**
 * Materialize already-read evidence in the receiving reviewer's own directory.
 * The caller owns request.json and cleanup. Source paths are never read here.
 */
export async function prepareReviewerRequest({ requestDirectory, request, evidence = null, deadlineAt = Infinity, abortSignal = null }) {
  assertReviewScopeActive({ request, deadlineAt, abortSignal });
  // Capture all inputs before the first filesystem await: the caller can keep
  // processing its event without changing the assessment currently being sent.
  let prepared = JSON.parse(JSON.stringify(request));
  let captured = JSON.parse(JSON.stringify(evidence));
  const assertActive = () => assertReviewScopeActive({ request: prepared, deadlineAt, abortSignal });
  const writeEvidence = async (file, value) => {
    assertActive();
    await atomicWriteJson(file, value);
    assertActive();
  };
  if (prepared.reviewScope) {
    const scoped = await prepareReviewScope({ projectRoot: request.projectRoot ?? path.dirname(path.dirname(path.dirname(requestDirectory))),
      requestDirectory, request: prepared, evidence: captured, deadlineAt, abortSignal });
    prepared = scoped.request;
    captured = scoped.evidence;
  }
  if (!captured) return prepared;

  const references = {};
  if (captured.snapshot) {
    const transcriptPath = path.join(requestDirectory, "transcript.json");
    const transcript = { entries: captured.snapshot.entries ?? [] };
    await writeEvidence(transcriptPath, transcript);
    // These identify the source snapshot, not the serialized evidence file.
    references.transcript = {
      path: transcriptPath,
      digest: captured.snapshot.digest ?? null,
      cursor: captured.snapshot.lastEntryKey ?? null,
    };
    const navigationPath = path.join(requestDirectory, 'transcript-recent.json');
    const navigation = recentTranscript(transcript.entries, { ...references.transcript,
      sha256: sha256(Buffer.from(JSON.stringify(transcript, null, 2) + '\n')), entryCount: transcript.entries.length,
    }, captured.snapshot.invocation);
    await writeEvidence(navigationPath, navigation);
    references.transcriptNavigation = { path: navigationPath,
      sha256: sha256(Buffer.from(JSON.stringify(navigation, null, 2) + '\n')),
      complete: navigation.complete, omittedEntryCount: navigation.omittedEntryCount };
  }
  if (captured.groundTruth) {
    references.groundTruthPath = path.join(requestDirectory, "ground-truth.json");
    await writeEvidence(references.groundTruthPath, captured.groundTruth);
  }
  if (captured.skillGroundTruth) {
    references.skillGroundTruthPath = path.join(requestDirectory, "skill-ground-truth.json");
    await writeEvidence(references.skillGroundTruthPath, captured.skillGroundTruth);
  }
  if (captured.skillSource) {
    references.skillSourcePath = path.join(requestDirectory, "skill-source.json");
    await writeEvidence(references.skillSourcePath, captured.skillSource);
    // Full original evidence remains available on demand. Do not repeat every
    // Skill helper body in the first request read by the reviewer.
    if (prepared.skill) prepared.skill.files = captured.skillSource.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    prepared.skillCare = { protocol: "skill-care.v1", sourceComplete: !captured.skillSource.truncated,
      sourceDigest: captured.skillSource.digest, navigation: "Read SKILL.md first; locate helpers and execution evidence on demand." };
  }
  if (captured.population !== null && captured.population !== undefined) {
    references.population = captured.population;
  }
  Object.assign(prepared, references);
  if (references.groundTruthPath && prepared.currentGroundTruth) {
    prepared.currentGroundTruth.path = references.groundTruthPath;
  }

  if (captured.semanticRequest) {
    const semantic = captured.semanticRequest;
    semantic.runtimeV2 = { ...semantic.runtimeV2, ...references };
    if (references.transcript) {
      semantic.runtimeV2.transcriptDigest = references.transcript.digest;
      semantic.runtimeV2.transcriptCursor = references.transcript.cursor;
    }
    if (references.groundTruthPath && semantic.runtimeV2.currentGroundTruth) {
      semantic.runtimeV2.currentGroundTruth.path = references.groundTruthPath;
    }
    prepared.semanticReviewRequestPath = path.join(requestDirectory, "semantic-request.json");
    await writeEvidence(prepared.semanticReviewRequestPath, semantic);
  }
  return prepared.reviewScope?.boundedBasis === true
    ? finalizeReviewScopeRequest({ requestDirectory, request: prepared, phase: "materialized", deadlineAt, abortSignal }) : prepared;
}

/** Bind only this request's program-generated disclosure files before cleanup. */
export async function scopedSourceCitations({ projectRoot, requestDirectory, prepared, report }) {
  if (!prepared.reviewScope) return [];
  const within = (base, file) => { const relative = path.relative(base, file); return !relative.startsWith("..") && !path.isAbsolute(relative); };
  const root = await fs.realpath(projectRoot), requestRoot = await fs.realpath(requestDirectory);
  if (!within(root, requestRoot)) return [];
  const localPath = async file => {
    if (typeof file !== "string") return null;
    try { const real = await fs.realpath(path.resolve(root, file)); return within(requestRoot, real) ? real : null; }
    catch { return null; }
  };
  const truth = await localPath(prepared.groundTruthPath);
  const pages = await localPath(prepared.reviewScope.evidenceDirectory);
  const selections = new Map(), sources = new Map();
  const rows = [...(report?.metricObjectJudgements ?? []), ...(report?.findings ?? []), ...(report?.fileAssessments ?? [])];
  for (const row of rows) {
    const owner = row.objectId ?? row.deviationKey ?? row.path ?? "finding";
    for (const ref of [...(row.evidence ?? []), ...(row.actualEvidence ?? [])]) {
      if (typeof ref !== "string") continue;
      const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref);
      if (!match) continue;
      const file = await localPath(match[1]);
      if (!file || (file !== truth && !(pages && within(pages, file)))) continue;
      let source = sources.get(file);
      if (!source) {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > REVIEW_SCOPE_PAGE_BYTES) continue;
        const bytes = await fs.readFile(file);
        if (bytes.includes(0)) continue;
        source = { lines: bytes.toString("utf8").split("\n"), contentHash: sha256(bytes) }; sources.set(file, source);
      }
      const start = Number(match[2]), end = Number(match[3] ?? start);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > source.lines.length) continue;
      const selection = `${file}#L${start}-L${end}`, previous = selections.get(selection);
      if (previous) { if (!previous.usedBy.includes(owner)) previous.usedBy.push(owner); continue; }
      selections.set(selection, { selection, path: file, snapshotPath: file, frozen: true, start, end,
        contentHash: source.contentHash, exactQuote: source.lines.slice(start - 1, end).join("\n"), usedBy: [owner] });
    }
  }
  return [...selections.values()];
}
