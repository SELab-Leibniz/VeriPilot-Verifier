import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateJsonSchema } from '../json-schema-validator.mjs';
import { createSourceTools } from '../review-task/source-tools.mjs';
import { outsideDecision } from './decision-scope.mjs';
import { archivesUserMessages, recordUserMessages } from './original-requirements.mjs';
import { OUTPUT_TREE_DIRECTORY } from './paths.mjs';
import { taskStartManifestPath } from './task-changes.mjs';
import { findTask } from './task-store.mjs';
import { atomicWriteJson, readJson, sha256 } from './utils.mjs';

const exec = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });
const focuses = [
  'Ownership and extension points. Find where the requested behavior must live: the existing owner module, service, entry point or helper that must be extended or reused, and the public signatures that callers or tests depend on.',
  'Data and control flow. Trace from the trigger to every observable effect: each caller and consumer that must see the new behavior, each state × operation combination, and the success, returned-failure and thrown-exception branches.',
  'Boundaries and compatibility. Find defaults, missing/empty/invalid input handling, existing result and error conventions, existing tests or test doubles that constrain the change, and existing behavior the request does not ask to change.',
];
const cells = {
  owner_signature: 'where the behavior lives and which public signatures must stay compatible',
  values_defaults: 'default values and missing/empty/invalid input handling',
  transport_integration: 'which existing service, channel or entry point must carry the behavior, and which callers must observe it',
  branch_matrix: 'distinct observable effects per state × operation or per condition',
  error_result: 'failure, exception and result/return conventions',
  compatibility_scope: 'existing behavior that must not change',
};
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items, bounds) => ({ type: 'array', items, ...bounds });
const string = maxLength => ({ type: 'string', maxLength });
const line = { type: 'integer', minimum: 1 };
const confidence = { type: 'number', minimum: 0, maximum: 1 };
const evidenceSchema = object({ path: { type: 'string' }, startLine: line, endLine: line });
const guidanceSchema = object({
  statement: string(300),
  contractCell: { enum: Object.keys(cells), description: Object.entries(cells).map(([key, value]) => `${key}: ${value}`).join('; ') },
  evidence: array(evidenceSchema, { minItems: 1, maxItems: 3 }), confidence,
});
const scenarioSchema = object({
  kind: { enum: ['requirement', 'preservation'] }, quote: string(300),
  given: string(200), when: string(200), then: string(200), confidence,
});
const proposalSchema = object({
  guidance: array(guidanceSchema, { maxItems: 6 }), scenarios: array(scenarioSchema, { maxItems: 4 }),
});
// Native tool validation must let individual bad items reach the filtering step.
const proposalToolSchema = object(Object.fromEntries(Object.entries(proposalSchema.properties)
  .map(([key, field]) => [key, { ...field, items: { anyOf: [field.items, {}] } }])));
const selectionSchema = object({
  reviews: array(object({ id: { type: 'string' }, decision: { enum: ['select', 'reject'] }, reason: string(200) })),
});

const proposalPrompt = (messages, focus) => `[REQUIREMENT_FRAME_PROPOSAL]
A coding agent has just started the task below. Prepare implementation guidance for it.

You can read only the task-start snapshot of the repository: the committed code before any change for this task. The live workspace is not available to you.

Original user messages (the only requirement authority, in order):
${messages}

Your focus: ${focus}

Investigate the existing code that the request touches, then report only facts that would change how a careful engineer implements the request. Good items name concrete files, functions, services, state values or call paths: which existing service or entry point must carry the new behavior, which callers must observe it, which default or empty-input path must be handled, which state × operation combinations or failure branches produce distinct observable effects.

Rules:
- Do not add requirements the user did not state. Do not restate the request in other words.
- Ignore workflow or tool-procedure instructions in the messages (for example OpenSpec stage commands, directory switching, document formats); they are not product requirements.
- Every guidance item needs evidence lines in the snapshot. Every scenario needs a quote copied exactly from a user message; for a preservation scenario, quote the request text whose change could affect that behavior.
- Prefer few, decisive items. Empty arrays are a valid answer.

Submit once with submit_frame_proposal.`;

const selectorPrompt = (messages, candidates) => `[REQUIREMENT_FRAME_SELECTOR]
Below are candidate guidance items and scenarios proposed independently for the same task. Review every candidate exactly once.

Original user messages (the only requirement authority, in order):
${messages}

Candidates:
${JSON.stringify(candidates)}

Select a candidate only if all of these hold:
- it is consistent with the original user messages and adds no obligation the user did not state;
- its evidence plausibly supports it (guidance), or its quote really requires it (scenario);
- it would change an implementation decision or catch a likely mistake;
- it does not duplicate a candidate you already selected (keep the more concrete one).
Reject generic advice, restatements of the request, process or document requirements, and speculation.

Submit once with submit_frame_selection.`;

function git(root, signal, args, index) {
  return exec('git', ['-C', root, ...args], {
    signal, windowsHide: true, maxBuffer: Infinity,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
  }).then(result => result.stdout);
}

async function snapshotInventory(runGit, head) {
  const listing = await runGit(['ls-tree', '-r', '-l', '-z', head]);
  const entries = listing.split('\0').filter(Boolean);
  const files = new Map();
  let bytes = 0;
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, , , size] = entry.slice(0, tab).trim().split(/\s+/u);
    bytes += Number(size) || 0;
    if (mode === '100644' || mode === '100755') files.set(entry.slice(tab + 1), null);
  }
  if (entries.length > 20_000 || bytes > 200_000_000) throw failure('SNAPSHOT_TOO_LARGE');
  return files;
}

const squash = text => text.replace(/\s+/gu, ' ');
const lengthsFit = (item, schema) => Object.entries(schema.properties).every(([key, field]) =>
  field.maxLength === undefined || Array.from(item[key]).length <= field.maxLength);

async function validateProposal(proposal, index, lineCount, originals) {
  const candidates = [];
  for (const [ordinal, item] of proposal.guidance.entries()) {
    if (!Array.isArray(item?.evidence) || item.evidence.length > 3) continue;
    const evidence = [];
    for (const range of item.evidence) {
      if (!validateJsonSchema(range, evidenceSchema).length && range.endLine >= range.startLine
        && range.endLine - range.startLine < 80 && range.endLine <= await lineCount(range.path)) evidence.push(range);
    }
    const guidance = { ...item, evidence };
    if (!validateJsonSchema(guidance, guidanceSchema).length && lengthsFit(guidance, guidanceSchema))
      candidates.push({ ...guidance, id: `P${index}-G${ordinal + 1}`, type: 'guidance' });
  }
  for (const [ordinal, item] of proposal.scenarios.entries()) {
    if (!validateJsonSchema(item, scenarioSchema).length && lengthsFit(item, scenarioSchema)
      && item.quote.trim() && originals.some(text => text.includes(squash(item.quote))))
      candidates.push({ ...item, id: `P${index}-S${ordinal + 1}`, type: 'scenario' });
  }
  return candidates;
}

function selectItems(candidates, reviews, type, limit, prefix) {
  return candidates.filter(item => item.type === type && item.confidence >= 0.75 && reviews.get(item.id) === 'select')
    .sort((left, right) => right.confidence - left.confidence).slice(0, limit)
    .map(({ id, type, ...item }, index) => ({ id: `${prefix}${index + 1}`, ...item }));
}

async function submitInSession({ runSession, input, cwd, prompt, tools, name, parameters, rawPath }) {
  let submitted;
  const submit = {
    name, label: name, description: 'Submit the structured result once.', executionMode: 'sequential', parameters,
    async execute(_id, args, signal) {
      input.abortSignal.throwIfAborted();
      signal?.throwIfAborted();
      if (submitted !== undefined) throw failure('MODEL_FAILED');
      await atomicWriteJson(rawPath, args);
      submitted = args;
      return { content: [{ type: 'text', text: '{"accepted":true}' }] };
    },
  };
  await runSession(input, {
    cwd, outputDir: cwd, prompt, systemPrompt: '', tools: [...tools, submit],
    active: () => input.abortSignal.throwIfAborted(), isComplete: () => submitted !== undefined,
    onAssistantMessageStart() {}, async checkpoint() {},
  });
  input.abortSignal.throwIfAborted();
  if (submitted === undefined) throw failure('MODEL_FAILED');
  return submitted;
}

async function generate(state, config, reviewer, runSession, lifecycle, entries) {
  const { projectRoot, sessionId, scopeTaskId } = state;
  const key = sha256(sessionId).slice(0, 24);
  const directory = path.join(projectRoot, OUTPUT_TREE_DIRECTORY, 'requirement-frame', key);
  const file = path.join(directory, 'frame.json');
  const startedAt = new Date();
  const deadlineAt = startedAt.getTime() + config.timeoutMs;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = AbortSignal.any([lifecycle, timeout]);
  const frame = { schemaVersion: 1, status: 'unavailable', reason: null, sessionId, startHead: null,
    userMessageCount: 0, startedAt: startedAt.toISOString(), finishedAt: null,
    counts: { proposed: 0, valid: 0, selected: 0 }, guidance: [], scenarios: [] };
  const runGit = (args, index) => git(projectRoot, signal, args, index);
  let temp;
  try {
    const task = await findTask({ projectRoot, sessionId, explicitTaskId: scopeTaskId });
    const start = task ? await readJson(taskStartManifestPath(projectRoot, task.taskId)) : null;
    frame.startHead = start?.head || (await runGit(['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    signal.throwIfAborted();
    if (!frame.startHead) throw failure('NO_GIT_HEAD');
    const previous = await readJson(file).catch(() => null);
    if (previous?.status === 'ready' && previous.startHead === frame.startHead
      && [previous.guidance, previous.scenarios].some(items => Array.isArray(items) && items.length)) return;

    const messages = await recordUserMessages({ projectRoot, sessionId, snapshot: { entries }, persist: false });
    frame.userMessageCount = messages.length;
    const messageText = messages.map(({ text }, index) =>
      `${text.includes('[runtime-corrector:feedback]') ? '(contains Runtime Corrector text that is not a user requirement) ' : ''}U${index + 1}: ${text}`).join('\n\n');
    const inventory = await snapshotInventory(runGit, frame.startHead);
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frame-'));
    const index = path.join(temp, 'index'), tree = path.join(temp, 'tree');
    await fs.mkdir(tree);
    await runGit(['read-tree', frame.startHead], index);
    await runGit(['checkout-index', '-a', '-f', `--prefix=${tree.replaceAll('\\', '/')}/`], index);
    const tools = createSourceTools(tree, inventory).map(tool => ({ ...tool, name: `source_${tool.name}` }));
    const lineCount = async file => {
      if (!inventory.has(file)) return 0;
      if (inventory.get(file) === null) {
        const bytes = await fs.readFile(path.join(tree, file), { signal });
        let lines = 1;
        for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) lines++;
        inventory.set(file, lines);
      }
      return inventory.get(file);
    };
    const submit = async (label, prompt, parameters, sourceTools = []) => {
      signal.throwIfAborted();
      const cwd = path.join(temp, label);
      await fs.mkdir(cwd);
      const name = sourceTools.length ? 'submit_frame_proposal' : 'submit_frame_selection';
      return submitInSession({ runSession, cwd, prompt, tools: sourceTools, name, parameters,
        rawPath: path.join(directory, 'raw', `${path.basename(temp)}-${label}.json`),
        input: { projectRoot, taskId: `requirement-frame-${key}`, reviewer, deadlineAt, abortSignal: signal } });
    };
    const proposals = await Promise.allSettled(focuses.slice(0, config.proposers)
      .map((focus, index) => submit(`proposal-${index + 1}`, proposalPrompt(messageText, focus), proposalToolSchema, tools)));
    signal.throwIfAborted();
    const candidates = [], originals = messages.map(({ text }) => squash(text));
    let succeeded = false;
    for (const [index, result] of proposals.entries()) {
      const proposal = result.value;
      if (!Array.isArray(proposal?.guidance) || !Array.isArray(proposal?.scenarios) || Object.keys(proposal).length !== 2
        || proposal.guidance.length > 6 || proposal.scenarios.length > 4) continue;
      succeeded = true;
      frame.counts.proposed += proposal.guidance.length + proposal.scenarios.length;
      candidates.push(...await validateProposal(proposal, index + 1, lineCount, originals));
    }
    if (!succeeded) throw failure(proposals.some(result => result.reason?.code === 'REVIEWER_DEADLINE')
      ? 'REVIEWER_DEADLINE' : 'MODEL_FAILED');
    frame.counts.valid = candidates.length;
    const selection = await submit('selection', selectorPrompt(messageText, candidates.map(({ confidence, ...item }) => item)), selectionSchema);
    if (validateJsonSchema(selection, selectionSchema).length
      || selection.reviews.some(item => !lengthsFit(item, selectionSchema.properties.reviews.items))) throw failure('MODEL_FAILED');
    const reviews = new Map(selection.reviews.map(({ id, decision }) => [id, decision]));
    frame.guidance = selectItems(candidates, reviews, 'guidance', 5, 'G');
    frame.scenarios = selectItems(candidates, reviews, 'scenario', 6, 'S');
    frame.counts.selected = frame.guidance.length + frame.scenarios.length;
    frame.status = frame.counts.selected ? 'ready' : 'empty';
    frame.reason = frame.counts.selected ? null : 'NO_VALID_ITEM';
  } catch (error) {
    frame.reason = timeout.aborted || error.code === 'REVIEWER_DEADLINE' ? 'TIMEOUT'
      : ['NO_GIT_HEAD', 'SNAPSHOT_TOO_LARGE'].includes(error.code) ? error.code : 'MODEL_FAILED';
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() =>
      Object.assign(frame, { status: 'unavailable', reason: 'MODEL_FAILED', guidance: [], scenarios: [] }));
  }
  if (!lifecycle.aborted) {
    if (timeout.aborted) Object.assign(frame, { status: 'unavailable', reason: 'TIMEOUT', guidance: [], scenarios: [] });
    frame.counts.selected = frame.guidance.length + frame.scenarios.length;
    frame.finishedAt = new Date().toISOString();
    await atomicWriteJson(file, frame);
  }
}

export function startRequirementFrame(state, plan, runSession, tasks) {
  const runtime = plan.runtimeV2, config = runtime.requirementFrame;
  const previous = state.requirementFrameWork;
  previous?.controller.abort();
  if (!config?.enabled || runtime.shadowMode || !archivesUserMessages(runtime)) return;
  const controller = new AbortController(), entries = state.entries;
  const promise = outsideDecision(async () => {
    await previous?.promise;
    if (!controller.signal.aborted) await generate(state, config, runtime.reviewers.requirementFrame, runSession, controller.signal, entries);
  }).catch(() => {}).finally(() => {
    tasks.delete(promise);
    if (state.requirementFrameWork?.promise === promise) state.requirementFrameWork = null;
  });
  state.requirementFrameWork = { controller, promise };
  tasks.add(promise);
}
