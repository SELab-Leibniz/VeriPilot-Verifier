import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { ensureTask, taskDirectory, withTaskState } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

test('production Stop moves from a real stage scope to task completion using only task receipts', async t => {
  const parent = path.resolve('.runtime-correction/stop-production-protocol-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'spec.md'), 'The requested document describes the supplied value.\n');
  const transcript = path.join(root, 'host.jsonl');
  const entries = [{ type: 'user', uuid: 'U1', message: { content: 'Deliver a document describing the supplied value.' } }];
  const task = await ensureTask({ projectRoot: root, sessionId: 'production-protocol' });
  const claim = { claimId: 'R1', revisionId: 'R1@1', category: 'requirements', text: entries[0].message.content,
    status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'ARTIFACT' };
  const truth = { taskId: task.taskId, version: 1, digest: sha256([claim]), claims: [claim] };
  const gtPath = path.join(taskDirectory(root, task.taskId), 'ground-truth/current.json');
  await fs.mkdir(path.dirname(gtPath), { recursive: true }); await fs.writeFile(gtPath, JSON.stringify(truth));
  await withTaskState({ projectRoot: root, taskId: task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = truth.digest; });
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`M${String(index + 1).padStart(2, '0')}`, index === 0]));
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false, platform: null },
    stopCorrection: { enabled: true, metrics, fileQualityReviewEnabled: true } });
  const artifacts = [{ nodeId: 'spec', stage: 'design', patterns: ['spec.md'], metrics: ['M01'] }];
  let toolsFor, selected = 'STAGE_COMPLETE'; const hooks = new Map(), types = [];
  const api = { config: { agents: { defaults: { model: { primary: 'offline/model' } } } }, runtime: { version: '2026.7.1-2', agent: {} },
    registerTool: fn => { toolsFor = fn; }, on: (name, fn) => hooks.set(name, fn) };
  registerTaskTools(api);
  const reviewerFactory = createOpenClawReviewerFactory(api, { runEmbeddedAgent: async params => {
    assert.equal(params.config.agents.defaults.models['offline/model'].params.maxTokens, 32768);
    const brief = JSON.parse(params.prompt), tools = new Map(toolsFor(params).map(tool => [tool.name, tool])), reads = new Map();
    const read = async file => {
      if (reads.has(file)) return reads.get(file);
      let offset = 1, citeId;
      do {
        params.onAssistantMessageStart(); const id = crypto.randomUUID();
        const result = await tools.get('source_read').execute(id, { path: file, offset });
        hooks.get('tool_result_persist')({ toolName: 'source_read', toolCallId: id, isSynthetic: false,
          message: { role: 'toolResult', toolName: 'source_read', toolCallId: id, content: result.content, isError: false } }, params);
        params.onAgentToolResult({ toolName: 'source_read', result, isError: false });
        offset = result.details.page.nextOffset; citeId = result.details.citation.citeId;
      } while (offset !== null);
      reads.set(file, citeId); return citeId;
    };
    const submit = async (name, value) => {
      params.onAssistantMessageStart(); const result = await tools.get(name).execute(crypto.randomUUID(), value);
      params.onAgentToolResult({ toolName: name, result, isError: false });
    };
    const tasks = brief.members ?? [brief.task];
    if (brief.task?.scope === 'classification') {
      types.push('classification'); for (const file of brief.task.basisFiles) await read(file);
      await submit('submit_classification', { stopClassification: selected, ...(selected === 'STAGE_COMPLETE' ? { stage: 'design' } : {}), summary: 'The frozen response selects this scope.' });
    } else if (brief.task?.scope === 'findings') {
      types.push('findings'); for (const file of brief.task.basisFiles) await read(file);
      const listing = await tools.get('source_find').execute(crypto.randomUUID(), { path: 'project', pattern: 'host-state' });
      assert.deepEqual(JSON.parse(listing.content.map(block => block.text).join('')).hits, []);
      await submit('finish_findings', { batchIds: [], summary: 'No demonstrated deviation in this limited scope.' });
    } else {
      types.push(tasks[0].scope === 'FILE_QUALITY' ? 'file-quality' : 'review');
      for (const task of tasks) {
        for (const file of task.basisFiles) await read(file);
        const citeId = await read(task.targetFiles[0]);
        await submit('submit_review', { taskId: task.id, verdict: 'PASS', reason: 'The current delivered document supports the assigned obligation.', citeIds: [citeId] });
      }
    }
    return { payloads: [{ text: 'This text is deliberately not JSON.' }], meta: { aborted: params.abortSignal.aborted } };
  } });
  await fs.writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await handleRuntimeV2Event({ projectRoot: root, plan: { runtimeV2, artifacts, configuredArtifacts: artifacts }, reviewerFactory,
    stopHost: { directory: path.join(root, 'host-state') },
    input: { session_id: 'production-protocol', cwd: root, transcript_path: transcript, hook_event_name: 'SessionStart', source: 'startup' } });
  for (const [index, classification] of ['STAGE_COMPLETE', 'TASK_COMPLETE', 'INTERMEDIATE'].entries()) {
    selected = classification;
    if (index) {
      entries.push({ type: 'user', uuid: `U${index + 1}`, message: { content: 'Continue the requested work and review its current progress.' } });
      await fs.appendFile(path.join(root, 'spec.md'), 'The final document includes the completed value description.\n');
    }
    entries.push({ type: 'assistant', uuid: `A${index}`, message: { content: index === 2 ? 'The design stage is complete; further work is in progress.' : index ? 'The task is complete.' : 'The design stage is complete.' } });
    await fs.writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const outcome = await handleRuntimeV2Event({ projectRoot: root, plan: { runtimeV2, artifacts, configuredArtifacts: artifacts }, reviewerFactory,
      stopHost: { directory: path.join(root, 'host-state'), stopId: `stop-${index}` },
      input: { session_id: 'production-protocol', cwd: root, transcript_path: transcript, hook_event_name: 'Stop',
        hook_event_id: `stop-${index}`, last_assistant_message: entries.at(-1).message.content } });
    assert(outcome.stop?.review, JSON.stringify(outcome));
    assert.equal(outcome.stop.review.stopClassification, classification, JSON.stringify({ stop: outcome.stop, types }));
    assert.equal(outcome.stop.status, index === 2 ? 'UNVERIFIED' : 'PASS', JSON.stringify(outcome.stop.review));
    assert.equal(outcome.stop.review.metricObjectJudgements.length, index === 2 ? 0 : 1);
    if (index !== 2) assert.equal(outcome.stop.review.fileAssessments[0].status, 'PASS');
    else assert.equal(outcome.stop.review.collection.mode, 'findings-only');
    assert.equal(outcome.stop.correctionAttempt, 0);
  }
  assert.deepEqual(types, ['classification', 'file-quality', 'review', 'classification', 'file-quality', 'review', 'classification', 'findings']);
});
