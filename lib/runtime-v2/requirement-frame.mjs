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
import { STOP_METRIC_FAMILIES } from './metric-policy.mjs';
import { archivesUserMessages, recordUserMessages } from './original-requirements.mjs';
import { OUTPUT_TREE_DIRECTORY } from './paths.mjs';
import { isSkillFileName } from './skill-source.mjs';
import { taskChanges, taskStartManifestPath } from './task-changes.mjs';
import { findTask } from './task-store.mjs';
import { appendJsonLine, atomicWriteJson, readJson, sha256 } from './utils.mjs';
import { STOP_CITATIONS_SCHEMA } from './stop-citations.mjs';

const exec = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });
const focuses = [
  'Ownership and extension points. Find independently callable entry points and the established data boundary. When a result needs richer data, compare putting the extra dependency above that boundary with enriching the existing result inside its service owner. Unless the request changes the caller API, prefer the placement that preserves existing callers and their substitutes. A new wrapper is not equivalent merely because it calls the old method internally. Identify concrete source-supported alternatives, not mock updates for a chosen design.',
  'Data and control flow. Trace each public trigger to its first observable effect. For a caller-owned restriction, follow the existing successful dependency substitute all the way to a write or external call. Find the caller guard that prevents the forbidden effect on that path. If no such guard exists, identify that gap explicitly; expecting the dependency to fail is not a caller guard. Produce a distinct scenario under that actual setup rather than only testing the lower helper. Also cover returned failure and thrown failure.',
  'Boundaries and compatibility. Read setup hooks, substituted methods, return data and assertions separately. An added dependency that makes previously valid setup fail is a design compatibility problem to investigate, not evidence that the original test needs more mocks. Separate the exact assertion superseded by the requested behavior from unchanged setup and later effects. Follow each field through merges and state commits, including defaults and loaded details. Inspect interception semantics for intraclass calls.',
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
const PROPOSAL_GUIDANCE_LIMIT = 6;
const PROPOSAL_SCENARIO_LIMIT = 6;
const FRAME_GUIDANCE_LIMIT = 10;
const FRAME_SCENARIO_LIMIT = 6;
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
  guidance: array(guidanceSchema, { maxItems: PROPOSAL_GUIDANCE_LIMIT }),
  scenarios: array(scenarioSchema, { maxItems: PROPOSAL_SCENARIO_LIMIT }),
});
// Native tool validation must let individual bad items reach the filtering step.
const lenient = schema => object(Object.fromEntries(Object.entries(schema.properties)
  .map(([key, field]) => [key, { ...field, items: { anyOf: [field.items, {}] } }])));
const proposalToolSchema = lenient(proposalSchema);

const MAX_CHECK_TEXT = 600;
const PROPOSAL_CHECK_LIMIT = 6;
const FAMILY_CHECK_LIMIT = 5;
const FRAME_CHECK_LIMIT = 10;
const CHECK_DOCUMENT_LIMIT = 200;
const CHECK_DOCUMENT_BYTES = 1_048_576;
const IGNORED_DOCUMENT_DIRECTORIES = new Set(['node_modules', '.git', OUTPUT_TREE_DIRECTORY]);
const checkMetrics = {
  M09: 'development standard: a coding, architecture, naming, dependency or security rule that the changed code must follow',
  M10: 'mandatory experience rule: a rule learned from past problems and stated as mandatory',
  M11: 'fixed workflow step: a required action or order of actions, including a rule that a named Skill, tool or command must be used',
  M13: 'acceptance closure: a project-defined acceptance or definition-of-done check that must pass before the work counts as complete',
  M14: 'milestone closure: a project milestone target that this task must close',
  M15: 'critical journey: a named user or system journey that must keep working and be verified',
};
const checkOwnership = `Metric ownership (use the same rule for every document):
- M09: a required property of code, architecture, encoding, naming or documentation.
- M10: use only when the cited lines explicitly identify a mandatory lesson from a past incident; a generic must/never rule is not experience evidence.
- M11: a required actor action, named command, post-edit readback, or order of actions.
- M13: an acceptance result or definition of done that must be satisfied, rather than the instruction to execute its command.
- M14: an explicit project milestone closure target.
- M15: an explicitly named end-to-end user/system journey and its verification.
Do not change ownership merely because the same duty occurs in another document. Do not move a duty to an enabled metric when its proper metric is disabled.`;
const checkFocuses = {
  projectRules: 'project rules: development standards, mandatory experience rules and fixed workflow steps',
  verification: 'verification requirements: required verification commands, acceptance or definition-of-done checks, milestones and critical journeys',
};
/** Each family proposes only for its currently enabled Stop metrics. */
export const frameCheckFamilies = runtime => runtime?.requirementFrame?.checks !== true ? [] : Object.entries(checkFocuses)
  .map(([family, focus]) => ({ family, focus, metrics: STOP_METRIC_FAMILIES[family].filter(id => runtime.stopCorrection?.metrics?.[id] === true) }))
  .filter(family => family.metrics.length);
const checkSchema = object({
  metricId: { enum: Object.keys(checkMetrics) },
  text: { ...textSchema, maxLength: MAX_CHECK_TEXT },
  verificationTarget: { enum: ['PROCESS', 'IMPLEMENTATION', 'ARTIFACT'] },
  applicability: { ...textSchema, description: 'Empty when the rule applies to this whole task; otherwise the narrower condition under which it applies.' },
  activation: { ...textSchema, description: 'The part of the user request or the touched code area that makes this rule apply now.' },
  source: evidenceSchema, confidence,
});
const checkProposalSchema = object({ checks: array(checkSchema, { maxItems: PROPOSAL_CHECK_LIMIT }) });
const checkProposalToolSchema = lenient(checkProposalSchema);
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
- Use existing tests to identify public contracts, including setup used to exercise a different operation. Explain which assertion the request changes and which observable behavior remains required. Do not recommend replacing a dependency substitute merely because a proposed implementation would bypass it.
- For an input restriction or no-side-effect requirement, investigate the public caller as well as its helpers. A lower-level rejection is not proof that the caller validates input before its own writes, persistence or external calls.
- Include an existing dependency substitute in a scenario's given condition when it changes the route to the requested observable result. Guidance must distinguish a path that works only when a dependency fails from a guarantee the caller enforces itself.
- Give separately callable entries separate scenarios when their dependency setup differs. Name the actual entry in when and the substitute outcome in given. A then describing a caller's side effect cannot be established by a when that invokes only its lower helper.
- Prefer few, decisive items. Empty arrays are a valid answer.

Submit once with submit_frame_proposal.`;

const checkProposalPrompt = (messages, family, documents) => `[CORRECTION_CHECK_PROPOSAL]
A coding agent has just started the task below. Before it finishes, a reviewer will check its work against the project obligations that apply to this task. Find those obligations in the project's own documents.

You can read only the task-start snapshot of the repository: the committed files before any change for this task. The live workspace is not available to you.

Original user messages (the only requirement authority, in order):
${messages}

Your family: ${family.focus}
Metrics you may use:
${family.metrics.map(id => `- ${id}: ${checkMetrics[id]}`).join('\n')}

Project documents in the snapshot (instruction files first):
${documents.map(file => `- ${file}`).join('\n')}

Read the instruction files and the documents that the request plausibly touches. Report a check only when all of these hold:
- the cited lines themselves state a binding obligation (must, never, always, a required step or a required verification), not a description, example or preference;
- completing this request activates it; name in activation the part of the request or the code area that triggers it;
- a reviewer can decide it at Stop from the source, the documents or the agent's recorded actions;
- it is not a step of an installed Skill (SKILL.md files have their own check), and it does not restate the user's request.
Use a short verbatim excerpt of the cited lines as text (at most ${MAX_CHECK_TEXT} characters). Whitespace may be normalized; add no explanation, inferred detail or obligation from other lines. Keep the original conditions and exceptions. One check must have one verification target: split a required file result (ARTIFACT) from an actor action such as updating or rereading it (PROCESS). Do not combine independent duties in one text. IMPLEMENTATION is for properties of the code.
Put every original precondition in applicability, retaining its original wording; activation only explains why the current task is relevant and cannot broaden that precondition. For example, "before committing or pushing" does not mean "whenever code is edited". Leave applicability empty only for a genuinely unconditional duty. Cite fewer than 80 exact lines.
${checkOwnership}
Prefer few, decisive checks. An empty list is a valid answer.

Submit once with submit_frame_proposal.`;

const checkSelectionRules = `
Candidates of type check are project obligations that a Stop reviewer will check against the agent's work. You can read the same task-start snapshot with source_read. Select a check only if all of these hold:
- its cited lines themselves state the obligation, including the conditions and exceptions kept in its text;
- the original user messages activate it for this task, as its activation explains;
- it is not a Skill step, a restatement of the request, a description, an example or a style preference;
- its metricId fits the obligation, and its verificationTarget names what the reviewer must inspect;
- it has one verification target and does not mix a file result with a process action; reject a mixed candidate rather than rewriting it;
- its text is at most ${MAX_CHECK_TEXT} characters, contains only a verbatim obligation from the cited lines and preserves every exception;
- every original precondition is retained in applicability; activation cannot make a conditional duty unconditional;
- it does not duplicate a duty already selected from any document, even with a different metric, citation or wording. Keep one precise, authoritative candidate.
${checkOwnership}
`;

const selectorPrompt = (messages, candidates, checkSource, graphAvailable, hasChecks = false) => `[REQUIREMENT_FRAME_SELECTOR]
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
For guidance claiming that a caller prevents an effect, inspect the caller's guard and any relevant test substitute. Reject an unconditional guarantee justified only by the expectation that a lower dependency returns failure. A scenario omitting an existing substitute may miss the decisive caller path.
Reject advice that treats an added dependency or missing mock as sufficient authorization to change an existing caller contract. Check the original setup and each affected assertion: discard expectations that the request explicitly replaces, while preserving unrelated valid operations and effects. A proposed implementation is not the requirement authority.
Advice saying that setup needs a new mock solely because an implementation adds a dependency fails this check. Compare an implementation that enriches data behind the established boundary. For a caller-owned restriction, require the guidance to account for the existing success-returning substitute; rejecting only in the lower helper leaves that path open.
When candidates disagree about placement, compare their observable behavior and compatibility before choosing a layer. A user-facing operation name does not require a UI-layer implementation. A currently empty result field is not an invariant if the request changes its meaning. A caller unit test intentionally substitutes its callee and does not exercise the callee implementation; test that implementation separately. Do not reject a compatible placement because the caller substitute bypasses callee internals, or make an extra caller-level read mandatory merely because a proposed design uses it. Preserve source-backed caller and fixture constraints even when choosing a different design. For a caller-owned no-effect guarantee, prefer a distinct scenario with its actual successful substitute over a helper-only scenario that assumes the caller result.
` : ''}${hasChecks ? checkSelectionRules : ''}
Reject generic advice, restatements of the request, ${hasChecks ? 'guidance or scenarios that state process or document requirements' : 'process or document requirements'}, and speculation.

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

const checkText = value => squash(value).toLocaleLowerCase('en-US');
const checkKey = value => checkText(value).replace(/^(?:always|must)\s+/u, '').replace(/[.!。！]+$/u, '');
function checkConditions(text) {
  // These explicit clause prefixes can be checked without guessing intent.
  // Other semantic conditions and compound duties remain the selector's job.
  return [...text.matchAll(/(?:^|[.。;；\n])\s*((?:only if|if|when|whenever|unless|before|after|prior to)\b[^,，:：\n]+|(?:如果|若|当|仅当|除非)[^,，:：。\n]+|[^,，:：。\n]{1,60}(?:之前|之后|前|后|时))[,，:：]/giu)]
    .map(match => checkText(match[1]));
}
async function validateChecks(proposal, index, family, documents, lineCount, sourceLines) {
  const candidates = [];
  for (const [ordinal, item] of proposal.checks.entries()) {
    if (validateJsonSchema(item, checkSchema).length || !family.metrics.includes(item.metricId) || !documents.has(item.source.path)
      || !item.text.trim() || !item.activation.trim() || Array.from(item.text).length > MAX_CHECK_TEXT) continue;
    const { path: file, startLine, endLine } = item.source;
    if (endLine < startLine || endLine - startLine >= 80 || endLine > await lineCount(file)) continue;
    const quote = (await sourceLines(file)).slice(startLine - 1, endLine).join('\n');
    if (!checkText(quote).includes(checkText(item.text))) continue;
    if (checkConditions(quote).some(condition => !checkText(item.applicability).includes(condition))) continue;
    // Multiple sentences/actions cannot silently become one ARTIFACT/PROCESS
    // object. A proposer can submit the separate faithful clauses instead.
    if (/[；;\n]|[。.!?]\s+\S/u.test(item.text.trim())) continue;
    candidates.push({ ...item, text: item.text.trim(), applicability: item.applicability.trim(),
      family: family.family, id: `P${index}-K${ordinal + 1}`, type: 'check' });
  }
  return candidates;
}

function selectItems(candidates, reviews, type, limit, prefix) {
  return candidates.filter(item => item.type === type && item.confidence >= 0.75 && reviews.get(item.id) === 'select')
    .sort((left, right) => right.confidence - left.confidence).slice(0, limit)
    .map(({ id, type, ...item }, index) => ({ id: `${prefix}${index + 1}`, ...item }));
}

function selectChecks(candidates, reviews) {
  const perFamily = new Map(), seen = new Set();
  return candidates.filter(item => item.type === 'check' && item.confidence >= 0.75 && reviews.get(item.id) === 'select')
    .sort((left, right) => right.confidence - left.confidence)
    .filter(item => {
      const key = JSON.stringify([checkKey(item.text), checkKey(item.applicability), item.verificationTarget]);
      const count = perFamily.get(item.family) ?? 0;
      if (seen.has(key) || count >= FAMILY_CHECK_LIMIT) return false;
      seen.add(key); perFamily.set(item.family, count + 1);
      return true;
    }).slice(0, FRAME_CHECK_LIMIT)
    .map(({ id, type, family, ...item }, index) => ({ id: `K${index + 1}`, family, ...item }));
}

async function checkDocuments(inventory, tree) {
  const instruction = file => /^(?:agents|claude)\.md$/iu.test(path.posix.basename(file));
  const candidates = [...inventory.keys()].filter(file => /\.(?:md|markdown|mdx)$/iu.test(file)
    && !isSkillFileName(path.posix.basename(file)) && !file.split('/').some(part => IGNORED_DOCUMENT_DIRECTORIES.has(part)))
    .sort((left, right) => Number(instruction(right)) - Number(instruction(left))
      || left.split('/').length - right.split('/').length || (left < right ? -1 : Number(left > right)));
  const documents = [];
  for (const file of candidates) {
    if (documents.length >= CHECK_DOCUMENT_LIMIT) break;
    if ((await fs.stat(path.join(tree, file))).size <= CHECK_DOCUMENT_BYTES) documents.push(file);
  }
  return documents;
}

// Stop binds each check to the exact task-start bytes of its document.
async function storeCheckSources(checks, tree, directory) {
  const sources = path.join(directory, 'sources'), hashes = new Map();
  if (checks.length) await fs.mkdir(sources, { recursive: true });
  for (const check of checks) {
    if (!hashes.has(check.source.path)) {
      const bytes = await fs.readFile(path.join(tree, check.source.path)), hash = sha256(bytes);
      await fs.writeFile(path.join(sources, hash), bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      hashes.set(check.source.path, hash);
    }
    check.source = { ...check.source, sha256: hashes.get(check.source.path) };
  }
  return checks;
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
  && Array.isArray(frame.guidance) && Array.isArray(frame.scenarios) && (frame.checks === undefined || Array.isArray(frame.checks))
  && (frame.guidance.length || frame.scenarios.length || frame.checks?.length);
const frameItemCount = frame => frame.guidance.length + frame.scenarios.length + (frame.checks?.length ?? 0);

async function taskHead(projectRoot, task, signal) {
  const start = task ? await readJson(taskStartManifestPath(projectRoot, task.taskId)) : null;
  return start?.head || (await git(projectRoot, signal, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
}

async function generate(state, config, reviewer, runSession, lifecycle, entries, families) {
  const { projectRoot, sessionId, scopeTaskId } = state;
  const directory = frameDirectory(projectRoot, sessionId), key = path.basename(directory);
  const file = path.join(directory, 'frame.json');
  const startedAt = new Date();
  const deadlineAt = startedAt.getTime() + config.timeoutMs;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = AbortSignal.any([lifecycle, timeout]);
  const frame = { schemaVersion: 1, status: 'unavailable', reason: null, sessionId, startHead: null,
    userMessageCount: 0, startedAt: startedAt.toISOString(), finishedAt: null,
    counts: { proposed: 0, valid: 0, selected: 0 }, guidance: [], scenarios: [], ...(families.length ? { checks: [] } : {}) };
  const discard = values => Object.assign(frame, values, { guidance: [], scenarios: [] }, frame.checks ? { checks: [] } : {});
  const runGit = (args, index) => git(projectRoot, signal, args, index);
  let temp;
  try {
    const task = await findTask({ projectRoot, sessionId, explicitTaskId: scopeTaskId });
    frame.startHead = await taskHead(projectRoot, task, signal);
    signal.throwIfAborted();
    if (!frame.startHead) throw failure('NO_GIT_HEAD');
    const previous = await readFrame(directory);
    if (frameReady(previous) && previous.startHead === frame.startHead && Array.isArray(previous.checks) === Boolean(frame.checks)) return;

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
    const documents = families.length ? await checkDocuments(inventory, tree) : [];
    const checkFamilies = documents.length ? families : [], codeFocuses = focuses.slice(0, config.proposers);
    const proposals = await Promise.allSettled([
      ...codeFocuses.map((focus, index) => submit(`proposal-${index + 1}`, proposalPrompt(messageText, focus, graphInstructions), proposalToolSchema, tools)),
      ...checkFamilies.map(family => submit(`check-${family.family}`, checkProposalPrompt(messageText, family, documents), checkProposalToolSchema, tools)),
    ]);
    signal.throwIfAborted();
    const candidates = [], originals = messages.map(({ text }) => squash(text)), documentSet = new Set(documents);
    let succeeded = false;
    for (const [index, result] of proposals.entries()) {
      const proposal = result.value, family = checkFamilies[index - codeFocuses.length];
      if (family) {
        if (!Array.isArray(proposal?.checks) || Object.keys(proposal).length !== 1 || proposal.checks.length > PROPOSAL_CHECK_LIMIT) continue;
        succeeded = true;
        frame.counts.proposed += proposal.checks.length;
        candidates.push(...await validateChecks(proposal, index + 1, family, documentSet, lineCount,
          async file => (await fs.readFile(path.join(tree, file), { encoding: 'utf8', signal })).split(/\r?\n/u)));
        continue;
      }
      if (!Array.isArray(proposal?.guidance) || !Array.isArray(proposal?.scenarios) || Object.keys(proposal).length !== 2
        || proposal.guidance.length > PROPOSAL_GUIDANCE_LIMIT || proposal.scenarios.length > PROPOSAL_SCENARIO_LIMIT) continue;
      succeeded = true;
      frame.counts.proposed += proposal.guidance.length + proposal.scenarios.length;
      candidates.push(...await validateProposal(proposal, index + 1, lineCount, originals));
    }
    if (!succeeded) throw failure(proposals.some(result => result.reason?.code === 'REVIEWER_DEADLINE')
      ? 'REVIEWER_DEADLINE' : 'MODEL_FAILED');
    frame.counts.valid = candidates.length;
    const checkSource = candidates.some(item => item.type === 'guidance'), hasChecks = candidates.some(item => item.type === 'check');
    const selection = await submit('selection', selectorPrompt(messageText, candidates.map(({ confidence, family, ...item }) => item), checkSource, graphAvailable, hasChecks),
      selectionSchema, checkSource || hasChecks ? tools : []);
    if (validateJsonSchema(selection, selectionSchema).length) throw failure('MODEL_FAILED');
    const reviews = new Map(selection.reviews.map(({ id, decision }) => [id, decision]));
    const checks = frame.checks ? await storeCheckSources(selectChecks(candidates, reviews), tree, directory) : null;
    frame.guidance = selectItems(candidates, reviews, 'guidance', FRAME_GUIDANCE_LIMIT, 'G');
    frame.scenarios = selectItems(candidates, reviews, 'scenario', FRAME_SCENARIO_LIMIT, 'S');
    if (checks) frame.checks = checks;
    frame.counts.selected = frameItemCount(frame);
    frame.status = frame.counts.selected ? 'ready' : 'empty';
    frame.reason = frame.counts.selected ? null : 'NO_VALID_ITEM';
  } catch (error) {
    frame.reason = timeout.aborted || error.code === 'REVIEWER_DEADLINE' ? 'TIMEOUT'
      : ['NO_GIT_HEAD', 'SNAPSHOT_TOO_LARGE'].includes(error.code) ? error.code : 'MODEL_FAILED';
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() =>
      discard({ status: 'unavailable', reason: 'MODEL_FAILED' }));
  }
  if (!lifecycle.aborted) {
    if (timeout.aborted) discard({ status: 'unavailable', reason: 'TIMEOUT' });
    frame.counts.selected = frameItemCount(frame);
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
    const frame = await generate(state, config, runtime.reviewers.requirementFrame, runSession, controller.signal, entries, frameCheckFamilies(runtime));
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
    rules: '完成前要遵守的项目规则（Stop 评审会按文档原文检查）：',
    check: '- {text}{condition}（依据：{path}:{startLine}-{endLine}）',
    condition: '（仅当：{applicability}）',
  },
  en: {
    intro: `[RC implementation hints | advisory]
Runtime Corrector prepared these hints from the code at task start and the user messages, without seeing your changes. The user's original messages are the only authority: if a hint disagrees with them or with code you have verified, follow the messages and the code, and do not add features the user did not ask for. If a later user message asks for something different, follow the later message.`,
    where: 'Where to implement:',
    guidance: '{statement} (evidence: {path}:{startLine}-{endLine})',
    behavior: 'Behavior to satisfy:',
    requirement: '- [new] Given {given}; when {when}; then {then}. (quote: "{quote}")',
    preservation: '- [keep] Given {given}; when {when}; then {then}. (quote: "{quote}")',
    rules: 'Project rules to follow before finishing (the Stop review checks them against the document text):',
    check: '- {text}{condition} (source: {path}:{startLine}-{endLine})',
    condition: ' (only when: {applicability})',
  },
};

function renderBrief(frame, locale) {
  const template = briefTemplates[resolveLocale(locale)];
  const fill = (pattern, values) => pattern.replace(/\{(\w+)\}/gu, (_, field) => values[field]);
  const guidance = frame.guidance.map(({ statement, evidence: [location] }, index) =>
    `${index + 1}. ${fill(template.guidance, { statement, ...location })}`);
  const scenarios = frame.scenarios.map(item => fill(template[item.kind], item));
  const checks = (frame.checks ?? []).map(({ text, applicability, source }) => fill(template.check, { text, ...source,
    condition: applicability ? fill(template.condition, { applicability }) : '' }));
  return [`[runtime-corrector:feedback]\n${template.intro}`,
    ...(guidance.length ? [[template.where, ...guidance].join('\n')] : []),
    ...(scenarios.length ? [[template.behavior, ...scenarios].join('\n')] : []),
    ...(checks.length ? [[template.rules, ...checks].join('\n')] : [])].join('\n\n');
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
  const directory = frameDirectory(projectRoot, sessionId), frame = await readFrame(directory);
  if (!frameReady(frame)) return { reason: 'FRAME_NOT_READY' };
  if (frame.startHead !== startHead) return { reason: 'START_HEAD_MISMATCH' };
  const checks = (frame.checks ?? []).filter(check => /^[a-f0-9]{64}$/u.test(check?.source?.sha256 ?? ''))
    .map(check => ({ ...check, sourceFile: path.join(directory, 'sources', check.source.sha256) }));
  return { ...(frame.guidance.length || frame.scenarios.length
    ? { basis: { guidance: frame.guidance, scenarios: frame.scenarios } } : { reason: 'NO_FRAME_ITEMS' }),
  ...(checks.length ? { checks } : {}) };
}

export const FRAME_REVIEW_INSTRUCTIONS = `Requirement frame (basis part requirement-frame): guidance items G* and behavior scenarios S* that the program prepared from the task-start code before this candidate existed, after checking that their evidence exists and their quotes come from the user messages. They are advisory: the original user messages remain the only authority, and the frame never adds obligations.
Derive the requested entry points and observable effects from the original messages and current source before judging the frame. A proposed placement, a lower-helper test or an isolated pass does not authorize changing a caller's setup or prove its side-effect guarantee. Resolve each item against its own input, actual dependency outcome and observable effect; explain uncertainty locally rather than assuming the frame is correct.
Before finishing, give every frame item exactly one entry in finish_stop_review.frameDispositions:
- CHECKED: you traced it and it holds. A textual reason is enough; no citation is required.
- DEVIATION: it does not hold, and you saved a proved deviation for the corresponding original requirement (checklist object or submit_finding). Give that objectId.
- UNVERIFIED: you could not establish it within budget, or it does not follow from the original messages. Give a short reason.
A frame item alone is never a deviation; a DEVIATION disposition needs a proved deviation saved through the normal tools. Check scenarios of kind requirement first, then guidance whose contractCell is transport_integration, branch_matrix, error_result or values_defaults.`;

export const proposedCheckInstructions = (checks, deviationOnly) => `Proposed checks (basis part proposed-checks): before this candidate existed, program-run proposers read the task-start project documents, and a selector kept these checks K*. Each binds exact lines of a task-start document copy, readable at its sourceFile. The program adds them to the checklist after set_original_checklist unless you created the identical item; do not recreate them in other words. review_checklist marks each one with proposedCheck. The cited lines govern, not the proposed text: when they do not state a binding obligation, or the user messages do not activate it, the check is not a deviation.
${deviationOnly
    ? 'Before finishing, give every K item exactly one entry in finish_stop_review.frameDispositions: CHECKED with a reason when it holds or does not apply; DEVIATION with the objectId of its saved checklist deviation; UNVERIFIED with a reason when you cannot establish it.'
    : 'Give every K item a verdict like any other checklist item. When its cited lines do not state a binding obligation for this task, submit UNVERIFIED with that reason; a K item alone is never a deviation.'}
${JSON.stringify(checks.map(({ id, metricId, text, verificationTarget, applicability, activation, source, sourceFile }) => ({ id, metricId, text, verificationTarget,
    ...(applicability ? { applicability } : {}), activation, path: source.path, startLine: source.startLine, endLine: source.endLine, sourceFile })))}`;

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
  const checks = frame.checks ?? [];
  const remaining = new Set([...frame.guidance, ...frame.scenarios, ...checks].map(item => item.id));
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
    coverage.items.push({ id, type: frame.guidance.some(item => item.id === id) ? 'FRAME_GUIDANCE'
      : checks.some(item => item.id === id) ? 'FRAME_CHECK' : 'FRAME_SCENARIO', disposition,
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
