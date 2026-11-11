import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateJsonSchema } from '../json-schema-validator.mjs';
import { resolveLocale } from '../messages.mjs';
import { createSourceTools, textBlocks } from '../review-task/source-tools.mjs';
import { buildSemanticGraph, semanticGraphInstructions, SEMANTIC_GRAPH_TOOL } from '../semantic-graph.mjs';
import { outsideDecision } from './decision-scope.mjs';
import { archivesUserMessages, recordUserMessages } from './original-requirements.mjs';
import { OUTPUT_TREE_DIRECTORY } from './paths.mjs';
import { taskChanges, taskStartManifestPath } from './task-changes.mjs';
import { findTask } from './task-store.mjs';
import { appendJsonLine, atomicWriteJson, readJson, sha256 } from './utils.mjs';
import { STOP_CITATIONS_SCHEMA } from './stop-citations.mjs';

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
const textSchema = { type: 'string' };
const MAX_GUIDANCE_STATEMENT = 4000;
const line = { type: 'integer', minimum: 1 };
const confidence = { type: 'number', minimum: 0, maximum: 1 };
const evidenceSchema = object({ path: { type: 'string' }, startLine: line, endLine: line });
const guidanceSchema = object({
  statement: { ...textSchema, maxLength: MAX_GUIDANCE_STATEMENT },
  contractCell: { enum: Object.keys(cells), description: Object.entries(cells).map(([key, value]) => `${key}: ${value}`).join('; ') },
  evidence: array(evidenceSchema, { minItems: 1, maxItems: 3 }), confidence,
});
const scenarioSchema = object({
  kind: { enum: ['requirement', 'preservation'] }, quote: textSchema,
  given: textSchema, when: textSchema, then: textSchema, confidence,
});
const proposalSchema = object({
  guidance: array(guidanceSchema, { maxItems: 6 }), scenarios: array(scenarioSchema, { maxItems: 4 }),
});
// Native tool validation must let individual bad items reach the filtering step.
const proposalToolSchema = object(Object.fromEntries(Object.entries(proposalSchema.properties)
  .map(([key, field]) => [key, { ...field, items: { anyOf: [field.items, {}] } }])));
const selectionSchema = object({
  reviews: array(object({ id: textSchema, decision: { enum: ['select', 'reject'] }, reason: textSchema })),
});

const proposalPrompt = (messages, focus, graphInstructions) => `[REQUIREMENT_FRAME_PROPOSAL]
A coding agent has just started the task below. Prepare implementation guidance for it.

You can read only the task-start snapshot of the repository: the committed code before any change for this task. The live workspace is not available to you.
${graphInstructions ? '\n' + graphInstructions + '\n' : ''}

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

const selectorPrompt = (messages, candidates, checkSource, graphAvailable) => `[REQUIREMENT_FRAME_SELECTOR]
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
${checkSource ? `
You can inspect the same task-start snapshot as the proposers. For guidance that changes an existing caller, assertion, default, or side-effect boundary, verify the decisive source lines before selecting it.${graphAvailable ? ' Use semantic_graph to find the public callers and relevant existing tests, then source_read for their actual conditions and assertions.' : ''}
When an existing caller and a shared callee can produce separately observable behavior, assess each at its own entry point. A test that substitutes the callee can show which guarantees belong to the caller. Keep distinct failure and preservation cases when they would change the implementation.
` : ''}
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
    if (!validateJsonSchema(guidance, guidanceSchema).length && Array.from(guidance.statement).length <= MAX_GUIDANCE_STATEMENT)
      candidates.push({ ...guidance, id: `P${index}-G${ordinal + 1}`, type: 'guidance' });
  }
  for (const [ordinal, item] of proposal.scenarios.entries()) {
    if (!validateJsonSchema(item, scenarioSchema).length
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

const frameDirectory = (root, id) => path.join(root, OUTPUT_TREE_DIRECTORY, 'requirement-frame', sha256(id).slice(0, 24));
const readFrame = directory => readJson(path.join(directory, 'frame.json')).catch(() => null);
export const requirementFrameEnabled = runtime => runtime?.requirementFrame?.enabled === true && archivesUserMessages(runtime);
const frameReady = frame => frame?.status === 'ready' && frame.startHead
  && Array.isArray(frame.guidance) && Array.isArray(frame.scenarios) && (frame.guidance.length || frame.scenarios.length);

async function taskHead(projectRoot, task, signal) {
  const start = task ? await readJson(taskStartManifestPath(projectRoot, task.taskId)) : null;
  return start?.head || (await git(projectRoot, signal, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
}

async function generate(state, config, reviewer, runSession, lifecycle, entries) {
  const { projectRoot, sessionId, scopeTaskId } = state;
  const directory = frameDirectory(projectRoot, sessionId), key = path.basename(directory);
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
    frame.startHead = await taskHead(projectRoot, task, signal);
    signal.throwIfAborted();
    if (!frame.startHead) throw failure('NO_GIT_HEAD');
    const previous = await readFrame(directory);
    if (frameReady(previous) && previous.startHead === frame.startHead) return;

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
    const graphBudgetMs = Math.min(1500, Math.floor((deadlineAt - Date.now()) / 10));
    const graph = graphBudgetMs >= 100 ? await buildSemanticGraph(tree, {
      snapshotPaths: inventory.keys(), budgetMs: graphBudgetMs, signal,
    }).catch(() => { signal.throwIfAborted(); return null; }) : null;
    const graphAvailable = graph?.files > 0;
    const graphInstructions = graphAvailable ? await semanticGraphInstructions(signal) : '';
    if (graphAvailable) tools.push({ ...SEMANTIC_GRAPH_TOOL, executionMode: 'sequential',
      async execute(_id, args, invocationSignal) {
        signal.throwIfAborted();
        invocationSignal?.throwIfAborted();
        if (validateJsonSchema(args, SEMANTIC_GRAPH_TOOL.parameters).length) throw failure('TASK_SUBMISSION_INVALID');
        return { content: textBlocks(JSON.stringify(graph.query(args))) };
      },
    });
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
      const name = label === 'selection' ? 'submit_frame_selection' : 'submit_frame_proposal';
      return submitInSession({ runSession, cwd, prompt, tools: sourceTools, name, parameters,
        rawPath: path.join(directory, 'raw', `${path.basename(temp)}-${label}.json`),
        input: { projectRoot, taskId: `requirement-frame-${key}`, reviewer, deadlineAt, abortSignal: signal } });
    };
    const proposals = await Promise.allSettled(focuses.slice(0, config.proposers)
      .map((focus, index) => submit(`proposal-${index + 1}`, proposalPrompt(messageText, focus, graphInstructions), proposalToolSchema, tools)));
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
    const checkSource = candidates.some(item => item.type === 'guidance');
    const selection = await submit('selection', selectorPrompt(messageText, candidates.map(({ confidence, ...item }) => item), checkSource, graphAvailable),
      selectionSchema, checkSource ? tools : []);
    if (validateJsonSchema(selection, selectionSchema).length) throw failure('MODEL_FAILED');
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
    return frame;
  }
}

export function startRequirementFrame(state, plan, runSession, tasks, runId, sourceDigest) {
  const runtime = plan.runtimeV2, config = runtime.requirementFrame;
  const previous = state.requirementFrameWork;
  if (!requirementFrameEnabled(runtime) || runtime.shadowMode) {
    previous?.controller.abort();
    state.frameBrief = null;
    return;
  }
  if (runId && state.requirementFrameRunId === runId) return;
  state.requirementFrameRunId = runId;
  const turn = config.inject ? { runId: runId ?? null } : null;
  state.frameBrief = turn;
  if (turn) turn.cached = readFrame(frameDirectory(state.projectRoot, state.sessionId)).then(frame => {
    if (frameReady(frame)) return turn.frame = frame;
  });
  // A new native run can still see the preceding user record at prompt build.
  if (sourceDigest && previous?.sourceDigest === sourceDigest && !previous.controller.signal.aborted) {
    if (turn) void previous.promise.then(frame => {
      if (frameReady(frame)) turn.frame = frame;
    });
    return turn;
  }
  previous?.controller.abort();
  const controller = new AbortController(), entries = state.entries;
  const promise = outsideDecision(async () => {
    await previous?.promise;
    await turn?.cached;
    if (controller.signal.aborted) return;
    const frame = await generate(state, config, runtime.reviewers.requirementFrame, runSession, controller.signal, entries);
    if (turn && frameReady(frame)) turn.frame = frame;
    return frame;
  }).catch(() => {}).finally(() => {
    tasks.delete(promise);
    if (state.requirementFrameWork?.promise === promise) state.requirementFrameWork = null;
  });
  state.requirementFrameWork = { controller, promise, sourceDigest };
  tasks.add(promise);
  return turn;
}

const briefTemplates = {
  zh: {
    intro: `【RC 实现提示｜仅供参考】
以下内容由 RC 根据本任务开始时的代码和用户消息整理，生成时没有看过你的修改。用户原文是唯一依据：某条提示若与原文或你核实到的代码不符，以原文和代码为准；不要因为这些提示增加用户没要求的功能。若之后的用户消息提出了不同要求，以新消息为准。`,
    where: '实现落点：',
    guidance: '{statement}（依据：{path}:{startLine}-{endLine}）',
    behavior: '需要满足的行为：',
    requirement: '- [新需求] 前提：{given}；操作：{when}；预期：{then}。（原文：“{quote}”）',
    preservation: '- [保持不变] 前提：{given}；操作：{when}；预期：{then}。（原文：“{quote}”）',
  },
  en: {
    intro: `[RC implementation hints | advisory]
Runtime Corrector prepared these hints from the code at task start and the user messages, without seeing your changes. The user's original messages are the only authority: if a hint disagrees with them or with code you have verified, follow the messages and the code, and do not add features the user did not ask for. If a later user message asks for something different, follow the later message.`,
    where: 'Where to implement:',
    guidance: '{statement} (evidence: {path}:{startLine}-{endLine})',
    behavior: 'Behavior to satisfy:',
    requirement: '- [new] Given {given}; when {when}; then {then}. (quote: "{quote}")',
    preservation: '- [keep] Given {given}; when {when}; then {then}. (quote: "{quote}")',
  },
};

function renderBrief(frame, locale) {
  const template = briefTemplates[resolveLocale(locale)];
  const fill = (pattern, values) => pattern.replace(/\{(\w+)\}/gu, (_, field) => values[field]);
  const guidance = frame.guidance.map(({ statement, evidence: [location] }, index) =>
    `${index + 1}. ${fill(template.guidance, { statement, ...location })}`);
  const scenarios = frame.scenarios.map(item => fill(template[item.kind], item));
  return [`[runtime-corrector:feedback]\n${template.intro}`,
    ...(guidance.length ? [[template.where, ...guidance].join('\n')] : []),
    ...(scenarios.length ? [[template.behavior, ...scenarios].join('\n')] : [])].join('\n\n');
}

export async function takeFrameBrief(state, plan, runId, channel, { abortSignal, runtimeCorrectorHookDeadlineAt: deadlineAt = Infinity }) {
  const { frameBrief: turn, projectRoot, sessionId, scopeTaskId } = state, runtime = plan.runtimeV2;
  if (!turn || turn.delivered || turn.runId !== (runId ?? null) || !requirementFrameEnabled(runtime)
    || !runtime.requirementFrame.inject || runtime.shadowMode) return;
  try {
    const frame = channel === 'run_start' ? await turn.cached : turn.frame;
    if (!frameReady(frame)) return;
    const text = renderBrief(frame, runtime.locale);
    const task = await findTask({ projectRoot, sessionId, explicitTaskId: scopeTaskId });
    const changes = task ? await taskChanges({ projectRoot, taskId: task.taskId, plan, deadlineAt }) : null;
    if (frame.startHead !== (changes?.startHead || await taskHead(projectRoot, task, abortSignal))
      || state.scopeClosed || state.frameBrief !== turn || turn.delivered || abortSignal?.aborted
      || state.nativeRunId && state.nativeRunId !== turn.runId || Date.now() >= deadlineAt) return;
    turn.delivered = true;
    await appendJsonLine(path.join(frameDirectory(projectRoot, sessionId), 'deliveries.jsonl'), {
      at: new Date().toISOString(), channel, runId: turn.runId, startHead: frame.startHead,
      productionChangesBefore: changes?.changes.filter(change => change.owner === 'STOP').length ?? null,
    }).catch(() => {});
    return text;
  } catch { return; }
}

export async function readStopFrame({ projectRoot, sessionId, startHead, review }) {
  if (!review) return { reason: 'REVIEW_DISABLED' };
  if (!startHead) return { reason: 'START_HEAD_UNAVAILABLE' };
  const frame = await readFrame(frameDirectory(projectRoot, sessionId));
  if (!frameReady(frame)) return { reason: 'FRAME_NOT_READY' };
  if (frame.startHead !== startHead) return { reason: 'START_HEAD_MISMATCH' };
  return { basis: { guidance: frame.guidance, scenarios: frame.scenarios } };
}

export const FRAME_REVIEW_INSTRUCTIONS = `Requirement frame (basis part requirement-frame): guidance items G* and behavior scenarios S* that the program prepared from the task-start code before this candidate existed, after checking that their evidence exists and their quotes come from the user messages. They are advisory: the original user messages remain the only authority, and the frame never adds obligations.
Before finishing, give every frame item exactly one entry in finish_stop_review.frameDispositions:
- CHECKED: you traced it and it holds. A textual reason is enough; no citation is required.
- DEVIATION: it does not hold, and you saved a proved deviation for the corresponding original requirement (checklist object or submit_finding). Give that objectId.
- UNVERIFIED: you could not establish it within budget, or it does not follow from the original messages. Give a short reason.
A frame item alone is never a deviation; a DEVIATION disposition needs a proved deviation saved through the normal tools. Check scenarios of kind requirement first, then guidance whose contractCell is transport_integration, branch_matrix, error_result or values_defaults.`;

const dispositionSchema = array({
  type: 'object', additionalProperties: false, required: ['id', 'disposition'],
  properties: {
    id: { type: 'string' }, disposition: { enum: ['CHECKED', 'DEVIATION', 'UNVERIFIED'] },
    citeIds: array({ type: 'string' }), citations: STOP_CITATIONS_SCHEMA, objectId: { type: 'string' }, reason: { type: 'string' },
  },
});
// Let the finish tool return its specific repair error even for ill-typed dispositions.
export const FRAME_DISPOSITIONS_WIRE = { anyOf: [dispositionSchema, {}] };

export function countFrameDispositions(frame, dispositions, citations, hasDeviation, diagnostic = {}) {
  const remaining = new Set([...frame.guidance, ...frame.scenarios].map(item => item.id));
  const reject = reason => { diagnostic.reason = reason; return null; };
  const issues = validateJsonSchema(dispositions, dispositionSchema);
  if (issues.length) return reject(`${issues[0].pointer} ${issues[0].message}`);
  if (dispositions.length !== remaining.size)
    return reject(`Expected exactly these frame IDs: ${[...remaining].join(', ')}. Received ${dispositions.length} entries.`);
  const coverage = { status: 'used', reason: null, total: remaining.size, checked: 0, deviation: 0, unverified: 0, items: [] };
  for (const { id, disposition, citeIds, objectId, reason } of dispositions) {
    if (!remaining.delete(id)) return reject(`Unknown or repeated frame ID ${id}.`);
    if (disposition === 'DEVIATION' && !hasDeviation(objectId)) return reject(`${id} has no saved deviation for objectId ${objectId}.`);
    if (disposition === 'UNVERIFIED' && !reason?.trim()) return reject(`${id} needs a nonempty UNVERIFIED reason.`);
    const evidence = null;
    coverage[disposition.toLowerCase()]++;
    coverage.items.push({ id, type: frame.guidance.some(item => item.id === id) ? 'FRAME_GUIDANCE' : 'FRAME_SCENARIO', disposition,
      ...(reason ? { reason } : {}), ...(objectId ? { objectId } : {}),
      ...(citeIds ? { citeIds, evidence: (evidence ?? []).map(({ path, start, end, sha256 }) => ({ path, start, end, sha256 })) } : {}) });
  }
  return coverage;
}

const reproduction = {
  zh: `处理上面每个偏差时：
1. 先用一个最小的公开检查复现它（现有测试、命令，或放在系统临时目录、用完即删的临时脚本），确认它确实失败。
2. 修改后再运行同一个检查，确认通过；再运行一个相邻的已有行为检查，确认原有行为没有被破坏。
3. 如果无法复现，说明原因，不要为了通过评审而改动无关代码。`,
  en: `For each deviation above:
1. First reproduce it with a minimal public check (an existing test, a command, or a throwaway script in the system temp directory that you delete afterwards) and confirm that it fails.
2. After the fix, rerun the same check and confirm that it passes; also run one nearby existing-behavior check to confirm that nothing else broke.
3. If you cannot reproduce it, explain why and do not change unrelated code just to pass the review.`,
};

export const frameReproduction = runtime => requirementFrameEnabled(runtime) && runtime.requirementFrame.review
  ? reproduction[resolveLocale(runtime.locale)] : undefined;
export const appendFrameReproduction = (feedback, appendix) => feedback && appendix ? `${feedback}\n\n${appendix}` : feedback;
