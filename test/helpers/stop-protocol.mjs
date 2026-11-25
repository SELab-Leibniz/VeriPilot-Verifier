import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ensureTask, taskDirectory } from '../../lib/runtime-v2/task-store.mjs';
import { createOpenClawReviewerFactory } from '../../lib/openclaw/reviewer.mjs';
import { registerTaskTools } from '../../lib/openclaw/task-tools.mjs';
import { STOP_CLASSIFICATION_SCHEMA, STOP_REVIEW_SCHEMA } from '../../lib/runtime-v2/reviewer.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';
import { runOpenClawStopTask as legacyStopTask } from '../compat/legacy-stop-task-runtime.mjs';

// Fixture navigation only: the supplied callback still executes the real host
// handler. Restoring display JSON never reads source or creates an assessment.
export async function materializeStopChecklist(firstPage, call) {
  const bounded = value => assert(Buffer.byteLength(JSON.stringify(value)) <= 8192);
  const invoke = async pointer => {
    assert.equal(pointer?.tool, 'review_checklist');
    assert(pointer.arguments && typeof pointer.arguments === 'object');
    const value = await call(pointer.tool, pointer.arguments); bounded(value); return value;
  };
  const restore = async pointer => {
    const visited = new Set(); let text = '', offset = 0, total;
    while (pointer) {
      const key = JSON.stringify(pointer); assert(!visited.has(key), 'Repeated checklist detail cursor'); visited.add(key);
      const detail = await invoke(pointer);
      assert.equal(detail.navigationOnly, true); assert.equal(detail.readProofGranted, false); assert.equal(detail.assessmentGranted, false);
      assert.equal(detail.encoding, 'UTF8_JSON_TEXT'); assert.equal(detail.offset, offset);
      assert.equal(typeof detail.jsonText, 'string');
      if (total === undefined) total = detail.totalBytes;
      assert(Number.isSafeInteger(total) && total >= 0); assert.equal(detail.totalBytes, total);
      text += detail.jsonText; offset += Buffer.byteLength(detail.jsonText);
      assert(offset <= total);
      if (detail.next) {
        assert.equal(detail.next.tool, 'review_checklist'); assert.equal(detail.nextOffset, offset);
        assert.equal(detail.next.arguments.offset, offset); assert(Buffer.byteLength(detail.jsonText) > 0);
      } else { assert.equal(detail.nextOffset, null); assert.equal(offset, total); }
      pointer = detail.next;
    }
    return JSON.parse(text);
  };
  const hydrate = async page => {
    bounded(page);
    const expanded = { ...page, ...(page.checklistDetails ? await restore(page.checklistDetails.readWith) : {}) };
    if (Array.isArray(page.items)) expanded.items = await Promise.all(page.items.map(row => row.fullContentDeferred ? restore(row.readWith) : row));
    if (page.knownObligations) expanded.knownObligations = { ...page.knownObligations,
      items: await Promise.all(page.knownObligations.items.map(row => row.fullContentDeferred ? restore(row.readWith) : row)) };
    return expanded;
  };
  // A review_scope summary has a numeric item count and no checklist stream.
  if (!Array.isArray(firstPage.items)) return hydrate(firstPage);
  const items = [], known = [], pages = [], itemIds = new Set(), knownIds = new Set(), cursors = new Set();
  const total = firstPage.total, knownTotal = firstPage.knownObligations?.total ?? 0;
  assert(Number.isSafeInteger(total) && total >= 0); assert(Number.isSafeInteger(knownTotal) && knownTotal >= 0);
  let page = firstPage;
  while (page) {
    const expanded = await hydrate(page); pages.push(expanded);
    assert.equal(page.total, total); assert.equal(page.knownObligations?.total ?? 0, knownTotal);
    for (const row of expanded.items) {
      const id = row.objectId ?? row.taskId ?? row.id; assert.equal(typeof id, 'string');
      assert(!itemIds.has(id), 'Duplicate original checklist ID'); itemIds.add(id); items.push(row);
    }
    for (const row of expanded.knownObligations?.items ?? []) {
      assert.equal(typeof row.id, 'string'); assert(!knownIds.has(row.id), 'Duplicate retained candidate ID'); knownIds.add(row.id); known.push(row);
    }
    assert(items.length <= total && known.length <= knownTotal);
    assert.equal(page.nextOffset, items.length < total ? items.length : null);
    if (page.knownObligations) assert.equal(page.knownObligations.nextOffset, known.length < knownTotal ? known.length : null);
    let next = page.next && typeof page.next === 'object' ? page.next
      : page.knownObligations?.next && typeof page.knownObligations.next === 'object' ? page.knownObligations.next : null;
    if (!next) {
      // Small legacy replies expose the shared cursor numerically. Use only
      // returned offsets; the host itself clamps an already exhausted side.
      const offsets = [page.nextOffset, page.knownObligations?.nextOffset].filter(Number.isSafeInteger);
      if (offsets.length) {
        assert(offsets.every(value => value === offsets[0]), 'Independent cursors require the actual composite next pointer');
        next = { tool: 'review_checklist', arguments: { offset: offsets[0], limit: 20 } };
      }
    }
    if (!next) break;
    const key = JSON.stringify(next); assert(!cursors.has(key), 'Repeated checklist page cursor'); cursors.add(key);
    page = await invoke(next);
  }
  assert.equal(items.length, total); assert.equal(known.length, knownTotal);
  return { ...pages[0], items, nextOffset: null, next: null,
    ...(firstPage.knownObligations ? { knownObligations: { ...pages[0].knownObligations, items: known, nextOffset: null, next: null } } : {}),
    materializedPages: pages };
}

export async function stopProtocolFixture(t, kind = 'classification', options = {}) {
  const parent = path.resolve('.runtime-correction/stop-protocol-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-')); t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const task = await ensureTask({ projectRoot: root, sessionId: 'protocol-host' });
  const claim = { claimId: 'R1', revisionId: 'R1@1', text: 'Deliver the required value.', category: 'requirements',
    status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT', verificationTarget: 'ARTIFACT' };
  const truth = { version: 1, digest: sha256([claim]), claims: [claim] };
  const groundTruthPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true }); await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  const file = path.join(root, 'spec.md'), bytes = Buffer.from(options.text ?? 'The delivered value is incorrect.\n'); await fs.writeFile(file, bytes);
  const object = { objectId: 'M01:R1', metricId: 'M01', sourceId: 'R1', sourceRevisionId: 'R1@1', authority: 'USER_EXPLICIT',
    hard: true, applicabilityKind: 'CURRENT_TASK', description: claim.text, verificationTarget: 'ARTIFACT' };
  const input = { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', reviewer: { timeoutMs: 20000 },
    schema: kind === 'classification' ? STOP_CLASSIFICATION_SCHEMA : STOP_REVIEW_SCHEMA,
    request: { groundTruthPath, hook: { last_assistant_message: 'The current design stage is complete.' }, workflowStages: ['design', 'implementation'],
      population: { metrics: kind === 'classification' ? {} : { M01: [object] } },
      sourceManifest: [{ path: 'spec.md', sha256: sha256(bytes) }],
      ...(kind === 'findings' ? { fixedStopClassification: { stopClassification: 'INTERMEDIATE', stage: null } } : {}),
      reviewScope: { boundedBasis: true, objectIds: kind === 'classification' ? [] : [object.objectId], sourceIds: ['R1'],
        ...(kind === 'classification' ? { kind: 'classification' } : { findingsOnly: true }) } },
    evidence: { groundTruth: truth, snapshot: { entries: [{ type: 'user', uuid: 'U1', message: { content: claim.text } }] } } };
  let toolsFactory; const hooks = new Map();
  const api = { config: { agents: { defaults: { model: { primary: 'offline/model' } } } }, logger: { warn() {} },
    runtime: { version: '2026.7.1-2', agent: {} }, registerTool: fn => { toolsFactory = fn; }, on: (name, fn) => hooks.set(name, fn) };
  registerTaskTools(api);
  const calls = [];
  const run = async (script, settings = {}) => createOpenClawReviewerFactory(api, {
    ...(input.request.reviewScope?.kind !== 'workspace-stop' ? { runStopTask: legacyStopTask } : {}), ...settings, runEmbeddedAgent: async params => {
    calls.push(params);
    const brief = JSON.parse(params.prompt), tools = new Map(toolsFactory(params).map(tool => [tool.name, tool]));
    let turns = 0;
    const advance = () => { turns++; params.onAssistantMessageStart(); };
    const read = async (file, { offset = 1, receipt = true, alter = false } = {}) => {
      advance(); const toolCallId = crypto.randomUUID(), result = await tools.get('source_read').execute(toolCallId, { path: file, offset });
      params.onAgentToolResult({ toolName: 'source_read', result, isError: false });
      if (receipt) hooks.get('tool_result_persist')({ toolName: 'source_read', toolCallId, isSynthetic: false,
        message: { role: 'toolResult', toolName: 'source_read', toolCallId, isError: false,
          content: alter ? [{ type: 'text', text: 'truncated' }] : result.content } }, params);
      return result;
    };
    const readAll = async () => { for (const file of brief.task.basisFiles) { let offset = 1;
      do { const page = await read(file, { offset }); offset = page.details.page.nextOffset; } while (offset !== null);
    } };
    const submit = async (name, value) => { advance(); const result = await tools.get(name).execute(crypto.randomUUID(), value);
      params.onAgentToolResult({ toolName: name, result, isError: false }); return JSON.parse(result.content[0].text); };
    await script({ params, brief, tools, read, readAll, submit, hooks, advance, turns: () => turns, calls });
    return { payloads: [{ text: 'Display text is not a submission.' }], meta: { aborted: params.abortSignal.aborted } };
  } })(input);
  return { root, task, file, input, api, calls, run, hooks };
}
