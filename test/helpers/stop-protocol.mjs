import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureTask, taskDirectory } from '../../lib/runtime-v2/task-store.mjs';
import { createOpenClawReviewerFactory } from '../../lib/openclaw/reviewer.mjs';
import { registerTaskTools } from '../../lib/openclaw/task-tools.mjs';
import { STOP_CLASSIFICATION_SCHEMA, STOP_REVIEW_SCHEMA } from '../../lib/runtime-v2/reviewer.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';

export async function stopProtocolFixture(t, kind = 'classification', options = {}) {
  const parent = path.resolve('.runtime-correction/stop-protocol-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  const run = async (script, settings = {}) => createOpenClawReviewerFactory(api, { ...settings, runEmbeddedAgent: async params => {
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
