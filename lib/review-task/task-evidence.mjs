// Source protocol shared by extraction tasks and acceptance workers. Only a
// genuine host persistence receipt grants coverage; telemetry cannot do so.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSourceTools, toolText, textBlocks } from './source-tools.mjs';
import { captureFiles, covers, disclosedRange, registerCitation } from './evidence-utils.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';
import { createLiveSourceTools } from './live-source-tools.mjs';

export const CONDITIONAL_REVIEW_POLICY_VERSION = 'current-boundary-v1';
export const CONDITION_ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['activation', 'reason', 'evidenceKind'],
  properties: {
    activation: { type: 'string', enum: ['ACTIVE', 'INACTIVE_AT_CURRENT_BOUNDARY', 'PENDING_REQUIRED_TRIGGER', 'UNKNOWN'] },
    reason: { type: 'string', minLength: 1, maxLength: 4000 },
    evidenceKind: { type: 'string', enum: ['TARGET_FACTS', 'PROCESS_EVENT', 'PROCESS_WINDOW'] },
    afterCallId: { type: 'string', minLength: 1, maxLength: 256 },
  },
};
export const CONDITIONAL_REVIEW_INSTRUCTIONS = 'For a CONDITIONAL item supply conditionAssessment with activation and original-condition reason, plus evidenceKind. ACTIVE is judged P/D/U with the original owner. INACTIVE_AT_CURRENT_BOUNDARY requires actual current facts and NOT_APPLICABLE; it is not a permanent exemption. PENDING_REQUIRED_TRIGGER means a required later stage/event remains due: use NOT_YET_APPLICABLE and do not claim completion. UNKNOWN/missing activation proof is UNVERIFIED. For absence of later actions use PROCESS_WINDOW with afterCallId naming an attributable original invocation/result; read the complete window through the current completion cursor. Current hashes, labels, quotations and missing logs cannot alone establish inactivity. Internal conditional branches cannot exclude other unconditional clauses of a compound original.';
const conditionError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// This chooses a conservative evidence requirement, never a verdict or a
// source's meaning. Target-only exemptions remain possible for target facts.
export function requiresConditionWindow(object = {}) {
  return /(?:later|subsequent|since|after.{0,60}(?:edit|chang|correct|action|operation)|re-?run|again after|后续|此后|修改后|纠正后|再次)/iu
    .test([object.condition, object.applicability, object.description, object.text].filter(Boolean).join('\n'));
}

export function validateConditionalAssessment({ assessment, verdict, context = {} }) {
  if (!assessment && verdict === 'UNVERIFIED') return null;
  if (!assessment || Object.keys(assessment).some(key => !['activation', 'reason', 'evidenceKind', 'afterCallId'].includes(key))
    || !CONDITION_ASSESSMENT_SCHEMA.properties.activation.enum.includes(assessment.activation)
    || typeof assessment.reason !== 'string' || !assessment.reason.trim() || assessment.reason.length > 4000
    || !CONDITION_ASSESSMENT_SCHEMA.properties.evidenceKind.enum.includes(assessment.evidenceKind))
    throw conditionError('REVIEW_CONDITION_ASSESSMENT_REQUIRED', 'Supply the original condition activation, reason and evidence kind; unknown proof must remain UNVERIFIED.');
  const allowed = { ACTIVE: ['PASS', 'DEVIATION', 'UNVERIFIED'], INACTIVE_AT_CURRENT_BOUNDARY: ['NOT_APPLICABLE'],
    PENDING_REQUIRED_TRIGGER: ['NOT_YET_APPLICABLE'], UNKNOWN: ['UNVERIFIED'] }[assessment.activation];
  if (!allowed.includes(verdict)) throw conditionError('REVIEW_CONDITION_VERDICT_CONFLICT',
    `${assessment.activation} permits ${allowed.join('/')}. Reassess original evidence; no verdict is automatically converted.`);
  if (verdict !== 'UNVERIFIED') {
    if (context.policy !== CONDITIONAL_REVIEW_POLICY_VERSION || context.basisComplete !== true || !context.currentCursor
      || !context.targetEvidence && !context.processEvidence)
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'Complete original basis and observed current target/process evidence are required.');
    const windowRequired = assessment.evidenceKind === 'PROCESS_WINDOW'
      || assessment.activation === 'INACTIVE_AT_CURRENT_BOUNDARY' && context.requiresProcessWindow;
    if (windowRequired && (assessment.evidenceKind !== 'PROCESS_WINDOW' || !context.processEvidence
      || !context.processWindow?.complete || !assessment.afterCallId
      || context.processWindow.afterCallId !== assessment.afterCallId || context.processWindow.cursor !== context.currentCursor))
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'Read an attributable invocation/result and the complete relevant original window through the current completion cursor; hashes alone cannot prove event absence.');
    if (assessment.evidenceKind === 'TARGET_FACTS' && !context.targetEvidence
      || assessment.evidenceKind === 'PROCESS_EVENT' && !context.processEvidence)
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'The selected evidence kind has no observed original witness.');
  }
  return { ...assessment, policy: CONDITIONAL_REVIEW_POLICY_VERSION, cursor: context.currentCursor ?? null,
    objectId: context.objectId ?? null, ...(context.objectRevision != null ? { objectRevision: context.objectRevision } : {}),
    ...(context.objectDigest ? { objectDigest: context.objectDigest } : {}),
    ...(context.processWindow ? { window: context.processWindow } : {}) };
}

// Caller-owned captured originals and actual acknowledged read coverage. A
// selected anchor is not proof until both matching events and every later
// record have been disclosed in the same frozen assessment.
export function bindConditionProcessWindow({ entries = [], afterCallId, readComplete, complete = false, cursor = sha256(entries), source = null }) {
  const blocks = entry => Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const calls = entries.flatMap((entry, index) => blocks(entry).filter(block => block.type === 'tool_use' && block.id === afterCallId).map(() => index));
  const results = entries.flatMap((entry, index) => blocks(entry).filter(block => block.type === 'tool_result' && block.tool_use_id === afterCallId).map(() => index));
  const call = calls[0] ?? -1, result = results[0] ?? -1;
  const valid = complete === true && typeof afterCallId === 'string' && calls.length === 1 && results.length === 1
    && result > call && entries[call]?.type === 'assistant' && entries[result]?.type === 'user'
    && typeof readComplete === 'function' && entries.slice(call).every((_, index) => readComplete(call + index));
  return { afterCallId: afterCallId ?? null, cursor, complete: Boolean(valid), from: call, result, through: entries.length - 1,
    ...(source?.path ? { sourcePath: source.path, sourceHash: source.hash } : {}) };
}

// readTranscriptSnapshot intentionally tolerates a partial append. That is
// useful for hooks, but insufficient for proving that an event did not occur.
export async function captureConditionSnapshot(snapshot, transcriptPath) {
  const entries = snapshot?.entries ?? [], cursor = sha256(entries);
  if (snapshot?.missing || snapshot?.truncated) return { complete: false, cursor };
  if (!transcriptPath) return { complete: snapshot?.conditionWindowComplete === true, cursor };
  try {
    const text = await fs.readFile(transcriptPath, 'utf8');
    const original = text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    return { complete: Boolean(snapshot.digest) && sha256(text) === snapshot.digest && sha256(original) === cursor,
      cursor, path: path.resolve(transcriptPath), hash: sha256(text) };
  } catch { return { complete: false, cursor }; }
}
export async function conditionWindowCurrent(binding) {
  if (!binding?.sourcePath) return binding?.complete === true;
  try { return sha256(await fs.readFile(binding.sourcePath, 'utf8')) === binding.sourceHash; }
  catch { return false; }
}

export async function durableTaskJson(file, value, active = () => {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      active();
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function createTaskEvidence({ root, workspaceRoot, evidencePolicy = {}, numberedReadFiles = [], signal, active, journal, onTool = () => {} }) {
  const live = Boolean(workspaceRoot);
  if (!live) {
    signal?.throwIfAborted();
    root = await fs.realpath(root);
    signal?.throwIfAborted();
  }
  const snapshot = live ? new Map() : await captureFiles(root, { signal }), reads = [], registry = new Map(), pending = new Map();
  const numberedFiles = new Set(numberedReadFiles);
  if (numberedFiles.size && (live || [...numberedFiles].some(file => !snapshot.has(file))))
    throw new Error('Numbered read defaults require exact files in the frozen inventory');
  const resolutions = new Map();
  const inventories = new Map();
  const versions = new Map();
  const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  const metrics = { toolCalls: 0, readBytes: 0, totalToolBytes: 0, repeatedLines: 0 };
  const tools = (live ? createLiveSourceTools(workspaceRoot, {
    onPath(requested, real) {
      if (evidencePolicy.trackFile?.(real) === false) return;
      if (resolutions.has(requested) && resolutions.get(requested) !== real) throw Object.assign(new Error('Searched path changed'), { code: 'BASELINE_INPUT_CHANGED' });
      resolutions.set(requested, real);
    },
    onDirectory(directory, names) {
      if (evidencePolicy.trackDirectory?.(directory) === false) return;
      const hash = sha256(names);
      if (inventories.has(directory) && inventories.get(directory) !== hash) throw Object.assign(new Error('Searched inventory changed'), { code: 'BASELINE_INPUT_CHANGED' });
      inventories.set(directory, hash);
    },
    async onSearchFile(file, bytes) {
      if (evidencePolicy.trackFile?.(file) === false) return;
      const hash = sha256(bytes);
      if (snapshot.has(file) && snapshot.get(file).sha256 !== hash) throw Object.assign(new Error('Searched evidence changed'), { code: 'BASELINE_INPUT_CHANGED' });
      snapshot.set(file, { sha256: hash, lines: bytes.toString('utf8').split('\n').length });
      versions.set(file, version(await fs.stat(file, { bigint: true })));
    },
  }) : createSourceTools(root, snapshot)).map(tool => ({ ...tool, name: `source_${tool.name}`,
    async execute(id, args, abort) {
      active(); abort?.throwIfAborted();
      if (typeof id !== 'string' || !id.trim() || pending.has(id)) throw new Error('A unique real tool call id is required');
      if (!live && tool.name === 'read' && args.numbered === undefined && typeof args.path === 'string'
        && numberedFiles.has(path.relative(root, path.resolve(root, args.path)).replaceAll('\\', '/')))
        args = { ...args, numbered: true };
      const result = await tool.execute(id, args, abort && signal ? AbortSignal.any([abort, signal]) : abort ?? signal);
      active();
      let returned = result, text = toolText(result);
      if (tool.name === 'read' && !result.isError) {
        const requested = path.resolve(workspaceRoot ?? root, args.path), absolute = await fs.realpath(requested);
        if (evidencePolicy.trackFile?.(absolute) === false) {
          metrics.toolCalls++; metrics.readBytes += Buffer.byteLength(text); metrics.totalToolBytes += Buffer.byteLength(text);
          journal.appendMessage({ role: 'historical_observation', content: JSON.stringify({ tool: tool.name, args, contextOnly: true }) });
          return { ...result, details: { ...result.details, contextOnly: true } };
        }
        const file = live ? absolute : path.relative(root, absolute).replaceAll('\\', '/'), bytes = await fs.readFile(absolute);
        if (live) {
          const metadata = { sha256: sha256(bytes), lines: bytes.toString('utf8').split('\n').length };
          if (snapshot.has(file) && snapshot.get(file).sha256 !== metadata.sha256) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
          if (resolutions.has(requested) && resolutions.get(requested) !== absolute) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
          snapshot.set(file, metadata); resolutions.set(requested, absolute);
          versions.set(file, version(await fs.stat(absolute, { bigint: true })));
        }
        if (sha256(bytes) !== snapshot.get(file)?.sha256) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
        const range = disclosedRange(bytes, args, result);
        if (range) {
          const citation = registerCitation({ registry: new Map(), bytes, file, sha256: snapshot.get(file).sha256, range });
          text = `[citeId="${citation.citeId}" | range ${file}:${range.start}-${range.end}]\n${text}`;
          returned = { ...result, content: textBlocks(text), details: { ...result.details, citation } };
          pending.set(id, { citation, text });
        }
      }
      metrics.toolCalls++; metrics.totalToolBytes += Buffer.byteLength(text);
      if (tool.name === 'read') metrics.readBytes += Buffer.byteLength(text);
      journal.appendMessage({ role: 'historical_observation', content: JSON.stringify({ tool: tool.name, args, bytes: Buffer.byteLength(text) }) });
      onTool({ name: tool.name, args });
      return returned;
    },
  }));
  function observeReceipt(event) {
    if (signal?.aborted || event.isSynthetic !== false || event.toolName !== 'source_read') return;
    const expected = pending.get(event.toolCallId), message = event.message;
    if (!expected) return;
    pending.delete(event.toolCallId);
    if (message?.role !== 'toolResult' || message.toolName !== 'source_read' || message.toolCallId !== event.toolCallId
      || message.isError !== false || !message.content?.length || message.content.some(block => block.type !== 'text')
      || toolText(message) !== expected.text) return;
    active();
    const { citation, text } = expected;
    journal.appendMessage({ role: 'toolResult', toolName: 'source_read', toolCallId: event.toolCallId,
      content: [{ type: 'text', text }], isError: false,
      details: { citation, receiptBoundary: event.receiptBoundary ?? 'openclaw.tool_result_persist.v1',
        ...(event.hostToolCallId ? { hostToolCallId: event.hostToolCallId } : {}) } });
    for (let line = citation.start; line <= citation.end; line++) if (covers(reads, citation.path, line, line)) metrics.repeatedLines++;
    reads.push({ path: citation.path, start: citation.start, end: citation.end }); registry.set(citation.citeId, citation);
  }
  async function assertFrozen({ force = false } = {}) {
    active();
    if (live) {
      for (const [directory, hash] of inventories) if (sha256((await fs.readdir(directory)).sort()) !== hash)
        throw Object.assign(new Error('Searched inventory changed'), { code: 'BASELINE_INPUT_CHANGED' });
      for (const [requested, real] of resolutions) if (await fs.realpath(requested) !== real)
        throw Object.assign(new Error('Read path changed'), { code: 'BASELINE_INPUT_CHANGED' });
      for (const [file, metadata] of snapshot) {
        const current = version(await fs.stat(file, { bigint: true }));
        if ((force || current !== versions.get(file)) && sha256(await fs.readFile(file, { signal })) !== metadata.sha256)
          throw Object.assign(new Error('Read evidence changed'), { code: 'BASELINE_INPUT_CHANGED' });
        versions.set(file, current);
      }
      active(); return;
    }
    const current = await captureFiles(root, { signal });
    if (sha256([...current]) !== sha256([...snapshot])) throw Object.assign(new Error('Frozen baseline inputs changed'), { code: 'BASELINE_INPUT_CHANGED' });
    active();
  }
  return { tools, snapshot, reads, registry, metrics, resolutions, inventories, observeReceipt, assertFrozen };
}
