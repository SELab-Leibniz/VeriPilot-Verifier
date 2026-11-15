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
import { createFrameSelectionLedger, FRAME_SELECTION_LIMITS } from './frame-selection.mjs';
import { prepareOriginalContractContext, ORIGINAL_CONTEXT_VERSION } from './original-contract-context.mjs';

const exec = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });
const focuses = [
  'Public decision surfaces and ownership. Find the existing owner of the requested decision, including independently callable predicates and their direct consumers. When an existing generic public operation already answers that same question, prefer repairing that owner over duplicating the rule in a private route; establish any intentionally fixed or different semantics from source. An old body, default-only tests or no mode parameter do not establish such an exemption. Preserve signatures and unaffected conditions while checking the new rule at the public owner. Do not equate names alone or force unrelated operations to share semantics.',
  'Input domain and first effects. Trace raw input through normalization, validation and the first observable write, external call or return. Separate valid inputs newly governed by the request from missing, empty, malformed or sentinel values that the existing code treats differently. A display fallback does not validate an action target. Propose one new-behavior check and one nearby preservation check when source supports both. Follow successful dependency substitutes, returned failure and thrown failure through the actual public caller.',
  'State, compatibility and counterexamples. Read setup hooks, dependency substitutes, assertions and cleanup separately. Check an initially empty state and an existing matching state when the request changes persistence or configuration. Identify exactly which observable expectation is superseded, and preserve unrelated fields and later operations. A new dependency or rewritten mock is not authorization for a changed contract. Keep a decisive boundary or alternate public-entry check even when a happy-path check already covers the central request.',
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
const line = { type: 'integer', minimum: 1 };
const confidence = { type: 'number', minimum: 0, maximum: 1 };
const evidenceSchema = object({ path: { type: 'string' }, startLine: line, endLine: line });
const guidanceSchema = object({
  statement: { ...textSchema, maxLength: MAX_GUIDANCE_STATEMENT },
  contractCell: { enum: Object.keys(cells), description: Object.entries(cells).map(([key, value]) => `${key}: ${value}`).join('; ') },
  evidence: array(evidenceSchema, { minItems: 1, maxItems: 3 }), confidence,
});
const scenarioProperties = {
  kind: { enum: ['requirement', 'preservation'] }, quote: textSchema,
  given: textSchema, when: textSchema, then: textSchema, confidence,
};
const scenarioSchema = { ...object(scenarioProperties), properties: { ...scenarioProperties,
  entryPoint: object({ path: { type: 'string', minLength: 1 }, symbol: { type: 'string', minLength: 1 } }),
  contractCell: guidanceSchema.properties.contractCell,
  evidence: array(evidenceSchema, { minItems: 1, maxItems: 3 }),
} };
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
  reviews: array({ ...object({ id: textSchema, decision: { enum: ['select', 'reject', 'covered'] }, reason: textSchema }),
    properties: { id: textSchema, decision: { enum: ['select', 'reject', 'covered'] }, reason: textSchema, coveredBy: textSchema } }),
});
const selectionBatchSchema = { ...selectionSchema, properties: {
  reviews: array({ anyOf: [{ type: 'object' }, {}] }), finish: { type: 'boolean' },
} };

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
- Form checks at the existing observable entry, with concrete input, prior state, active configuration or dependency outcome, and expected return/state/effect. Distinguish a shared rule's changed semantics from its unchanged input domain and signature. Inspect direct callers and sibling public entries before recommending a new private path.
- For a preservation scenario, the quote anchors the change that could break an existing contract; the user need not restate that contract. Verify its conditions and expected behavior in the task-start source. Do not broaden preservation to unrelated behavior or an old assertion the request actually supersedes.
- For a source-backed code scenario, also supply entryPoint {path, symbol}, contractCell and evidence. Name the actual function/method being exercised, and cite the task-start lines establishing its input domain, active configuration and observable decision. These fields form one check, not extra obligations. Read the public entry's description as well as its existing callers and tests; a default-configuration example does not settle its meaning under another supported configuration.
- Prefer a few complementary checks: the requested effect at its real entry, a separately callable decision surface expressing the same rule when source establishes that relationship, and a nearby unchanged boundary. Distinguish them by given/input/configuration and expected observation; do not require every function to have the same semantics.
- Use existing tests to identify public contracts, including setup used to exercise a different operation. Explain which assertion the request changes and which observable behavior remains required. Do not recommend replacing a dependency substitute merely because a proposed implementation would bypass it.
- For an input restriction or no-side-effect requirement, investigate the public caller as well as its helpers. A lower-level rejection is not proof that the caller validates input before its own writes, persistence or external calls.
- Include an existing dependency substitute in a scenario's given condition when it changes the route to the requested observable result. Guidance must distinguish a path that works only when a dependency fails from a guarantee the caller enforces itself.
- Give separately callable entries separate scenarios when their dependency setup differs. Name the actual entry in when and the substitute outcome in given. A then describing a caller's side effect cannot be established by a when that invokes only its lower helper.
- Prefer few, decisive items. Empty arrays are a valid answer.

Submit once with submit_frame_proposal.`;

const counterexamplePrompt = (messages, candidates, graphInstructions, originalContext) => `[REQUIREMENT_FRAME_COUNTEREXAMPLE]
Review implementation advice against the committed task-start code. No candidate code is available.
${graphInstructions ? '\n' + graphInstructions + '\n' : ''}
Original user messages (the requirement authority):
${messages}

The program prepared relevant original source, setup/cleanup and complete test assertions below. Locations and hashes are carried automatically; do not copy them into new proof fields. These excerpts are context, not an assertion that a substitute intercepts a particular call. Read further source when needed.
${JSON.stringify(originalContext)}

Independent proposals (hypotheses, including their claimed given conditions):
${JSON.stringify(candidates)}

Judge what the existing public entry actually does under its original inputs and dependency outcomes, and which observations the user permits changing. A rewritten successful/failing substitute is a different premise, even if the real lower helper is repaired. One superseded assertion does not retire later fields or effects in that case. A proposed omission is still worth correcting when the proposals claim it is already covered.
Check a shared decision at its public owner and follow configuration from its original request/event, including supported absent optional values. An old body, default-only test, missing mode parameter or new private route does not establish an exemption; source can establish a deliberately distinct or inapplicable contract. Do not add requirements from names or defensive preferences. Uncertain evidence remains unresolved.

Return only decisive corrections or additional checks, using the existing submit_frame_proposal format: at most two guidance items and three scenarios. Keep the actual original entry and setup in given/when/then. Evidence and a user-message quote retain their existing roles; no extra citations, proof objects or verbatim setup copies are required. Empty arrays are valid when the advice survives this review.`;

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
- for a module-level acceptance signal, identify the requested observable decision or affected reachable consumer that activates that exact signal; merely editing the module is insufficient. Do not turn its whole acceptance section into new obligations for every edit, or add device/UI execution requirements that its source does not state;
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

const selectorPrompt = (messages, candidates, checkSource, graphAvailable, hasChecks = false, originalContext) => `[REQUIREMENT_FRAME_SELECTOR]
Below are candidate guidance items and scenarios proposed independently for the same task. Review every candidate exactly once.
Use select for retained items, reject only for an unsupported, superseded or irrelevant claim, and covered for a duplicate with coveredBy pointing directly to a selected candidate of the same type. Give a substantive reason for every decision. For covered scenarios, explain how the selected scenario checks the same entry, prerequisites, dependency outcome and observable effect; different public entries or requirement/preservation kinds cannot cover each other.
contractCell is a classification label, not an independent behavior: different labels may cover the same observable check. Conversely, prose mentioning a second entry does not bind it as entryPoint; keep independently callable public entries in separate scenarios.
Publication budgets: ${JSON.stringify(FRAME_SELECTION_LIMITS)}. There is no confidence cutoff. Do not reject a supported distinct boundary to fit a quota. Use defer with a reason for supported items beyond the brief budget; they remain explicitly deferred in the internal ledger. Completed accepted siblings can be published even if other items remain pending. Review the most consequential candidate first and submit that decision immediately, then continue in small batches. Do not wait to read every candidate's source before your first submission.

Original user messages (the only requirement authority, in order):
${messages}

Candidates:
${JSON.stringify(candidates)}

Program-prepared task-start context (not new requirements; no additional response fields):
${JSON.stringify(originalContext)}

Select a candidate only if all of these hold:
- it is consistent with the original user messages and adds no obligation the user did not state;
- its evidence supports it (guidance), or its quote anchors the requested behavior/change (scenario); for preservation, the task-start source must establish the unchanged behavior under that scenario's exact conditions, even if the user did not repeat it;
- it would change an implementation decision or catch a likely mistake;
- it does not duplicate a candidate you already selected (keep the more concrete one).
${checkSource ? `
You can inspect the same task-start snapshot as the proposers. For guidance that changes an existing caller, assertion, default, or side-effect boundary, verify the decisive source lines before selecting it.${graphAvailable ? ' Use semantic_graph to find the public callers and relevant existing tests, then source_read for their actual conditions and assertions.' : ''}
When an existing caller and a shared callee can produce separately observable behavior, assess each at its own entry point. A test that substitutes the callee can show which guarantees belong to the caller. Keep distinct failure and preservation cases when they would change the implementation.
For a scenario with entryPoint/evidence, read those task-start locations and verify that the named entry actually owns the claimed decision under the stated given condition. Preserve complementary checks of a requested effect, an affected public predicate and an unchanged input boundary when justified; do not collapse them merely because they mention the same feature. A default-configuration example cannot prove that a public entry is exempt from the rule under another supported configuration. If its ownership is ambiguous, reject the claim rather than prescribing a private replacement as a requirement.
When a generic public operation already owns the same decision, compare fixing that owner with introducing a parallel rule in a new helper. Favor compatible reuse supported by source; require evidence of deliberately different semantics before advice exempts the old entry. Preserve the original signatures and default behavior, without treating the current omission of a requested rule as an immutable contract.
For a change to a shared decision rule, inspect its direct public consumers under the active configuration. Do not call old semantics a compatibility requirement merely because the signature stays unchanged, or accept a new private route as proof that existing public decisions changed. Conversely, do not extend a new rule outside the input domain established by the request and existing source. Keep source-backed missing/invalid-input and existing-state counterexamples when they exercise different branches from the positive case.
Follow configuration from the public request/event to its writer, then to the shared rule that consumes it. Check supported optional parameters both present and absent: a call appearing in a file is not proof its branch executes. Separate display placeholders from validated identities before the first effect. Source facts, original test dependency setup, changed assertions and preservation authority are separate evidence; an old branch order is not itself preservation authority.
For guidance claiming that a caller prevents an effect, inspect the caller's guard and any relevant test substitute. Reject an unconditional guarantee justified only by the expectation that a lower dependency returns failure. A scenario omitting an existing substitute may miss the decisive caller path.
Reject advice that treats an added dependency or missing mock as sufficient authorization to change an existing caller contract. Check the original setup and each affected assertion: discard expectations that the request explicitly replaces, while preserving unrelated valid operations and effects. A proposed implementation is not the requirement authority.
Verify fixture claims against the original setup expression before selecting them. A future rewritten fixture must not be described as the task-start fixture, even when its new expected assertion is authorized. Historical setup facts and requested outcomes must remain separate.
Advice saying that setup needs a new mock solely because an implementation adds a dependency fails this check. Compare an implementation that enriches data behind the established boundary. For a caller-owned restriction, require the guidance to account for the existing success-returning substitute; rejecting only in the lower helper leaves that path open.
Calling the original substituted function somewhere is insufficient. Trace any additional dependency reachable outside that substitution with the exact original setup; do not select advice that silently requires the caller fixture to provide it. Check unchanged assertions through the whole path, including after a partial repair restores the original call.
When candidates disagree about placement, compare their observable behavior and compatibility before choosing a layer. A user-facing operation name does not require a UI-layer implementation. A currently empty result field is not an invariant if the request changes its meaning. A caller unit test intentionally substitutes its callee and does not exercise the callee implementation; test that implementation separately. Do not reject a compatible placement because the caller substitute bypasses callee internals, or make an extra caller-level read mandatory merely because a proposed design uses it. Preserve source-backed caller and fixture constraints even when choosing a different design. For a caller-owned no-effect guarantee, prefer a distinct scenario with its actual successful substitute over a helper-only scenario that assumes the caller result.
` : ''}${hasChecks ? checkSelectionRules : ''}
Reject generic advice, restatements of the request, ${hasChecks ? 'guidance or scenarios that state process or document requirements' : 'process or document requirements'}, and speculation.

Submit small batches repeatedly with submit_frame_selection {reviews:[{id,decision,reason,coveredBy?}],finish:false}. Decisions are select, reject, covered or defer. Each call returns the program ledger and local errors. Correct only the affected items; accepted siblings are retained. After every candidate is accounted for, or you cannot resolve more within budget, set finish:true. Never invent completion; do not include unfinished-item details in host-facing advice.`;

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
    if (validateJsonSchema(item, scenarioSchema).length
      || !item.quote.trim() || !originals.some(text => text.includes(squash(item.quote)))) continue;
    const contract = ['entryPoint', 'contractCell', 'evidence'];
    if (contract.some(key => Object.hasOwn(item, key))) {
      if (!contract.every(key => Object.hasOwn(item, key)) || !item.entryPoint.symbol.trim()
        || !item.evidence.some(range => range.path === item.entryPoint.path)) continue;
      let valid = true;
      for (const range of item.evidence) if (range.endLine < range.startLine || range.endLine - range.startLine >= 80
        || range.endLine > await lineCount(range.path)) valid = false;
      if (!valid) continue;
    }
    candidates.push({ ...item, id: `P${index}-S${ordinal + 1}`, type: 'scenario' });
  }
  return candidates;
}

const checkText = value => squash(value).toLocaleLowerCase('en-US');
function checkConditions(text) {
  // Only a leading clause can be checked syntactically as the whole duty's
  // precondition. A later "if unavailable, explain why" may be one branch of
  // the same reporting duty, not another gate on its applicability.
  const lead = text.trim().replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/u, '');
  const match = /^((?:only if|if|when|whenever|unless|before|after|prior to)\b[^,，:：\n]+|(?:如果|若|当|仅当|除非)[^,，:：。\n]+|[^,，:：。\n]{1,60}(?:之前|之后|前|后|时))[,，:：]/iu.exec(lead);
  return match ? [checkText(match[1])] : [];
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
    // Sentence/list punctuation does not determine target identity. The
    // selector checks whether these source-bound clauses share one target.
    candidates.push({ ...item, text: item.text.trim(), applicability: item.applicability.trim(),
      family: family.family, id: `P${index}-K${ordinal + 1}`, type: 'check' });
  }
  return candidates;
}

function selectItems(candidates, reviews, type, prefix) {
  const ranked = candidates.filter(item => item.type === type && reviews.get(item.id) === 'select')
    .sort((left, right) => right.confidence - left.confidence);
  return ranked.map(({ id, type, ...item }, index) => ({ id: `${prefix}${index + 1}`, candidateId: id, ...item }));
}

function selectChecks(candidates, reviews) {
  return candidates.filter(item => item.type === 'check' && reviews.get(item.id) === 'select')
    .sort((left, right) => right.confidence - left.confidence)
    .map(({ id, type, family, ...item }, index) => ({ id: `K${index + 1}`, candidateId: id, family, ...item }));
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

async function waitForSession(runSession, input, context) {
  input.abortSignal.throwIfAborted();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(input.abortSignal.reason);
    input.abortSignal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([runSession(input, context), interrupted]); }
  finally { input.abortSignal.removeEventListener('abort', abort); }
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
      input.abortSignal.throwIfAborted();
      submitted = args;
      return { content: [{ type: 'text', text: '{"accepted":true}' }] };
    },
  };
  try { await waitForSession(runSession, input, {
    cwd, outputDir: cwd, prompt, systemPrompt: '', tools: [...tools, submit],
    active: () => input.abortSignal.throwIfAborted(), isComplete: () => submitted !== undefined,
    onAssistantMessageStart() {}, async checkpoint() {},
  }); } catch (error) {
    // A tool-acknowledged result is a completed contribution even if its
    // session later fails or reaches its phase deadline. The caller still
    // checks cancellation and validates its source before selection.
    if (submitted === undefined) throw error;
  }
  if (submitted === undefined) throw failure('MODEL_FAILED');
  return submitted;
}

async function selectInSession({ runSession, input, cwd, prompt, tools, rawPath, ledger, directory }) {
  let finished = false;
  await waitForSession(runSession, input, { cwd, outputDir: cwd, prompt, systemPrompt: '', tools: [...tools, {
    name: 'submit_frame_selection', label: 'submit_frame_selection', description: 'Save completed candidate decisions; repeat in small batches.',
    executionMode: 'sequential', parameters: selectionBatchSchema,
    async execute(_id, args, signal) {
      input.abortSignal.throwIfAborted(); signal?.throwIfAborted();
      if (finished || validateJsonSchema(args, selectionBatchSchema).length) throw failure('TASK_SUBMISSION_INVALID');
      const coverage = ledger.submit(args.reviews);
      await atomicWriteJson(rawPath, { reviews: coverage.dispositions.filter(row => !['pending','deferred'].includes(row.decision)) });
      await appendJsonLine(path.join(directory, 'selection-receipts.jsonl'), { at: new Date().toISOString(), batch: args, coverage });
      await atomicWriteJson(path.join(directory, 'selection-coverage.json'), coverage);
      finished = args.finish === true || coverage.complete;
      return { content: textBlocks(JSON.stringify(coverage)) };
    },
  }], active: () => input.abortSignal.throwIfAborted(), isComplete: () => finished,
    onAssistantMessageStart() {}, async checkpoint() {} });
  input.abortSignal.throwIfAborted();
  return ledger.snapshot();
}

const frameDirectory = (root, id) => path.join(root, OUTPUT_TREE_DIRECTORY, 'requirement-frame', sha256(id).slice(0, 24));
const readFrame = directory => readJson(path.join(directory, 'frame.json')).catch(() => null);
export const requirementFrameEnabled = runtime => runtime?.requirementFrame?.enabled === true && archivesUserMessages(runtime);
const frameReady = frame => ['ready', 'partial'].includes(frame?.status) && frame.startHead
  && (frame.schemaVersion !== 2 || frame.selectionCoverage?.complete === true)
  && (frame.schemaVersion !== 3 || frame.selectionCoverage?.publishable === true)
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
  const frame = { schemaVersion: 3, counterexampleAuditVersion: 1, originalContextVersion: ORIGINAL_CONTEXT_VERSION, status: 'unavailable', reason: null, sessionId, startHead: null,
    userMessageCount: 0, startedAt: startedAt.toISOString(), finishedAt: null,
    counts: { proposed: 0, valid: 0, selected: 0 }, guidance: [], scenarios: [], ...(families.length ? { checks: [] } : {}) };
  const discard = values => Object.assign(frame, values, { guidance: [], scenarios: [] }, frame.checks ? { checks: [] } : {});
  const runGit = (args, index) => git(projectRoot, signal, args, index);
  let temp, tree, candidates = [], ledger, independentScenarios = [];
  const materialize = async () => {
    if (!ledger) return;
    frame.selectionCoverage = ledger.snapshot();
    const reviews = new Map(frame.selectionCoverage.dispositions.map(row => [row.id, row.decision]));
    frame.guidance = selectItems(candidates, reviews, 'guidance', 'G');
    frame.scenarios = selectItems(candidates, reviews, 'scenario', 'S');
    // Selection controls the host brief, not whether an independently found
    // source-backed counterexample reaches final review. A rejected placement
    // preference or a full brief must not retire its original input premise.
    const retained = independentScenarios.filter(item => reviews.get(item.id) !== 'select');
    if (retained.length) {
      frame.reviewOnlyScenarios = selectItems(retained, new Map(retained.map(item => [item.id, 'select'])), 'scenario', 'C')
        .map(item => ({ ...item, reviewOrigin: 'INDEPENDENT_COUNTEREXAMPLE' }));
      frame.reason ||= 'COUNTEREXAMPLES_RETAINED_FOR_STOP';
    } else delete frame.reviewOnlyScenarios;
    if (frame.checks) frame.checks = await storeCheckSources(selectChecks(candidates, reviews), tree, directory);
    for (const item of [...frame.guidance, ...frame.scenarios, ...frame.checks ?? []])
      frame.selectionCoverage.dispositions.find(row => row.id === item.candidateId).frameId = item.id;
    await atomicWriteJson(path.join(directory, 'selection-coverage.json'), frame.selectionCoverage);
    frame.counts.selected = frameItemCount(frame);
    if (frame.counts.selected) frame.status = frame.selectionCoverage.complete && frame.counterexampleReview?.status !== 'unavailable'
      && !frame.reason ? 'ready' : 'partial';
  };
  try {
    const task = await findTask({ projectRoot, sessionId, explicitTaskId: scopeTaskId });
    frame.startHead = await taskHead(projectRoot, task, signal);
    signal.throwIfAborted();
    if (!frame.startHead) throw failure('NO_GIT_HEAD');
    const previous = await readFrame(directory);
    if (previous?.schemaVersion === 3 && previous.counterexampleAuditVersion === 1 && previous.originalContextVersion === ORIGINAL_CONTEXT_VERSION && frameReady(previous)
      && previous.startHead === frame.startHead && Array.isArray(previous.checks) === Boolean(frame.checks)) return;

    const messages = await recordUserMessages({ projectRoot, sessionId, snapshot: { entries }, persist: false });
    frame.userMessageCount = messages.length;
    const messageText = messages.map(({ text }, index) =>
      `${text.includes('[runtime-corrector:feedback]') ? '(contains Runtime Corrector text that is not a user requirement) ' : ''}U${index + 1}: ${text}`).join('\n\n');
    const inventory = await snapshotInventory(runGit, frame.startHead);
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-frame-'));
    const index = path.join(temp, 'index'); tree = path.join(temp, 'tree');
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
    // Reserve time for source review and selection; a slow sibling must not
    // spend the entire preparation budget before completed work can converge.
    const proposalDeadline = startedAt.getTime() + Math.floor(config.timeoutMs * 0.5);
    const counterexampleDeadline = startedAt.getTime() + Math.floor(config.timeoutMs * 0.7);
    const submit = async (label, prompt, parameters, sourceTools = [], phaseDeadline = deadlineAt) => {
      signal.throwIfAborted();
      if (Date.now() >= phaseDeadline) throw failure('REVIEWER_DEADLINE');
      const phaseTimeout = AbortSignal.timeout(Math.max(1, phaseDeadline - Date.now()));
      const phaseSignal = AbortSignal.any([signal, phaseTimeout]);
      const cwd = path.join(temp, label);
      await fs.mkdir(cwd);
      const name = label.startsWith('selection') ? 'submit_frame_selection' : 'submit_frame_proposal';
      try { return await submitInSession({ runSession, cwd, prompt, tools: sourceTools, name, parameters,
        rawPath: path.join(directory, 'raw', `${path.basename(temp)}-${label}.json`),
        input: { projectRoot, taskId: `requirement-frame-${key}`, reviewer, deadlineAt: phaseDeadline, abortSignal: phaseSignal } }); }
      catch (error) { signal.throwIfAborted(); if (phaseTimeout.aborted) throw failure('REVIEWER_DEADLINE'); throw error; }
    };
    const documents = families.length ? await checkDocuments(inventory, tree) : [];
    const checkFamilies = documents.length ? families : [], codeFocuses = focuses.slice(0, config.proposers);
    const proposals = await Promise.allSettled([
      ...codeFocuses.map((focus, index) => submit(`proposal-${index + 1}`, proposalPrompt(messageText, focus, graphInstructions), proposalToolSchema, tools, proposalDeadline)),
      ...checkFamilies.map(family => submit(`check-${family.family}`, checkProposalPrompt(messageText, family, documents), checkProposalToolSchema, tools, proposalDeadline)),
    ]);
    signal.throwIfAborted();
    frame.proposalReview = { status: proposals.every(result => result.status === 'fulfilled') ? 'complete' : 'partial',
      completed: proposals.filter(result => result.status === 'fulfilled').length, total: proposals.length,
      deadlineAt: new Date(proposalDeadline).toISOString() };
    if (frame.proposalReview.status === 'partial') frame.reason = 'PROPOSAL_INCOMPLETE';
    const originals = messages.map(({ text }) => squash(text)), documentSet = new Set(documents);
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
    // Source preparation does not add another reviewer or change its wire contract.
    frame.originalContext = await prepareOriginalContractContext({ tree, inventory, graph, candidates, signal,
      sourceDirectory: path.join(directory, 'sources') })
      .catch(error => { signal.throwIfAborted(); return { version: ORIGINAL_CONTEXT_VERSION, source: 'TASK_START',
        unavailable: true, reason: 'Original context preparation was unavailable; use the task-start source tools.', excerpts: [] }; });
    if (candidates.some(item => item.type === 'guidance' || item.type === 'scenario')) {
      try {
        const extra = await submit('counterexamples', counterexamplePrompt(messageText,
          candidates.map(({ confidence, ...item }) => item), graphInstructions, frame.originalContext), proposalToolSchema, tools, counterexampleDeadline);
        if (Array.isArray(extra?.guidance) && Array.isArray(extra?.scenarios) && Object.keys(extra).length === 2
          && extra.guidance.length <= PROPOSAL_GUIDANCE_LIMIT && extra.scenarios.length <= PROPOSAL_SCENARIO_LIMIT) {
          frame.counts.proposed += extra.guidance.length + extra.scenarios.length;
          const validated = await validateProposal(extra, proposals.length + 1, lineCount, originals);
          candidates.push(...validated);
          independentScenarios = validated.filter(item => item.type === 'scenario' && item.entryPoint && item.evidence?.length);
          frame.counterexampleReview = { status: 'complete' };
        } else throw failure('COUNTEREXAMPLE_INCOMPLETE');
      } catch { signal.throwIfAborted(); frame.counterexampleReview = { status: 'unavailable' }; }
    }
    frame.counts.valid = candidates.length;
    await atomicWriteJson(path.join(directory, 'candidates.json'), candidates);
    if (frame.counterexampleReview?.status === 'unavailable') frame.reason ||= 'COUNTEREXAMPLE_INCOMPLETE';
    const checkSource = candidates.some(item => item.type === 'guidance' || item.type === 'scenario' && item.entryPoint),
      hasChecks = candidates.some(item => item.type === 'check');
    const prompt = selectorPrompt(messageText, candidates.map(({ confidence, family, ...item }) => item), checkSource, graphAvailable, hasChecks, frame.originalContext);
    ledger = createFrameSelectionLedger(candidates);
    for (let attempt = 0; attempt < 2; attempt++) {
      const label = attempt ? 'selection-repair' : 'selection', cwd = path.join(temp, label);
      await fs.mkdir(cwd);
      frame.selectionCoverage = await selectInSession({ runSession, cwd, directory, ledger,
        prompt: prompt + (attempt ? `\n\nContinue the accepted ledger. Submit only pending corrections or deliberate revisions.\n${JSON.stringify(ledger.snapshot())}` : ''),
        tools: checkSource || hasChecks ? tools : [], rawPath: path.join(directory, 'raw', `${path.basename(temp)}-${label}.json`),
        input: { projectRoot, taskId: `requirement-frame-${key}`, reviewer, deadlineAt, abortSignal: signal } });
      if (frame.selectionCoverage.complete) break;
    }
    if (!frame.selectionCoverage.complete) frame.reason = 'SELECTION_INCOMPLETE';
    await materialize();
    if (!frame.counts.selected) { frame.status = 'empty'; frame.reason ||= 'NO_VALID_ITEM'; }
  } catch (error) {
    frame.reason = timeout.aborted || error.code === 'REVIEWER_DEADLINE' ? 'TIMEOUT'
      : ['NO_GIT_HEAD', 'SNAPSHOT_TOO_LARGE', 'SELECTION_INCOMPLETE', 'COUNTEREXAMPLE_INCOMPLETE'].includes(error.code) ? error.code : 'MODEL_FAILED';
    discard({ status: 'unavailable' });
    if (!lifecycle.aborted) await materialize().catch(() => discard({ status: 'unavailable', reason: 'MODEL_FAILED' }));
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() =>
      discard({ status: 'unavailable', reason: 'MODEL_FAILED' }));
  }
  if (!lifecycle.aborted) {
    frame.counts.selected = frameItemCount(frame);
    if (timeout.aborted) { frame.reason = 'TIMEOUT'; frame.status = frame.counts.selected ? 'partial' : 'unavailable'; }
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
    if (frame?.schemaVersion === 3 && frame.counterexampleAuditVersion === 1 && frame.originalContextVersion === ORIGINAL_CONTEXT_VERSION && frameReady(frame)) return turn.frame = frame;
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
    contract: '\n  检查入口：{symbol}；契约类型：{contractCell}；开始版本依据：{path}:{startLine}-{endLine}。',
    rules: '完成前要遵守的项目规则（Stop 评审会按文档原文检查）：',
    check: '- {text}{condition}（依据：{path}:{startLine}-{endLine}）',
    condition: '（仅当：{applicability}）',
    partial: '本次梳理可能仍有遗漏，请结合用户原文与实际代码，自主补全检查并作出决策。',
  },
  en: {
    intro: `[RC implementation hints | advisory]
Runtime Corrector prepared these hints from the code at task start and the user messages, without seeing your changes. The user's original messages are the only authority: if a hint disagrees with them or with code you have verified, follow the messages and the code, and do not add features the user did not ask for. If a later user message asks for something different, follow the later message.`,
    where: 'Where to implement:',
    guidance: '{statement} (evidence: {path}:{startLine}-{endLine})',
    behavior: 'Behavior to satisfy:',
    requirement: '- [new] Given {given}; when {when}; then {then}. (quote: "{quote}")',
    preservation: '- [keep] Given {given}; when {when}; then {then}. (quote: "{quote}")',
    contract: '\n  Check entry: {symbol}; contract: {contractCell}; task-start source: {path}:{startLine}-{endLine}.',
    rules: 'Project rules to follow before finishing (the Stop review checks them against the document text):',
    check: '- {text}{condition} (source: {path}:{startLine}-{endLine})',
    condition: ' (only when: {applicability})',
    partial: 'This review may still contain omissions. Use the original request and actual code to complete your own checks and decisions.',
  },
};

function renderBrief(frame, locale) {
  const template = briefTemplates[resolveLocale(locale)];
  const fill = (pattern, values) => pattern.replace(/\{(\w+)\}/gu, (_, field) => values[field]);
  const guidance = frame.guidance.map(({ statement, evidence: [location] }, index) =>
    `${index + 1}. ${fill(template.guidance, { statement, ...location })}`);
  const scenarios = frame.scenarios.map(item => fill(template[item.kind], item)
    + (item.entryPoint && item.evidence?.length ? fill(template.contract,
      { ...(item.evidence.find(range => range.path === item.entryPoint.path) ?? item.evidence[0]),
        symbol: item.entryPoint.symbol, contractCell: item.contractCell }) : ''));
  const checks = (frame.checks ?? []).map(({ text, applicability, source }) => fill(template.check, { text, ...source,
    condition: applicability ? fill(template.condition, { applicability }) : '' }));
  return [`[runtime-corrector:feedback]\n${template.intro}`,
    ...(guidance.length ? [[template.where, ...guidance].join('\n')] : []),
    ...(scenarios.length ? [[template.behavior, ...scenarios].join('\n')] : []),
    ...(checks.length ? [[template.rules, ...checks].join('\n')] : []),
    template.partial].join('\n\n');
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
  const retained = frame?.schemaVersion === 3 && Array.isArray(frame.guidance) && Array.isArray(frame.scenarios)
    && Array.isArray(frame.reviewOnlyScenarios) ? frame.reviewOnlyScenarios : [];
  if (frame?.startHead === startHead && frame.status === 'unavailable' && !retained.length)
    return { reason: frame.reason ?? 'FRAME_NOT_READY', preparationIncomplete: true };
  if (!frameReady(frame) && !retained.length) return { reason: 'FRAME_NOT_READY' };
  if (frame.startHead !== startHead) return { reason: 'START_HEAD_MISMATCH' };
  const checks = (frame.checks ?? []).filter(check => /^[a-f0-9]{64}$/u.test(check?.source?.sha256 ?? ''))
    .map(check => ({ ...check, sourceFile: path.join(directory, 'sources', check.source.sha256) }));
  const originalContext = frame.originalContext && { ...frame.originalContext,
    sources: await Promise.all((frame.originalContext.sources ?? []).map(async source => {
      if (!/^[a-f0-9]{64}$/u.test(source.sha256 ?? '')) return { ...source, unavailable: true };
      const file = path.join(directory, 'sources', source.sha256);
      const bytes = await fs.readFile(file).catch(() => null);
      return bytes && sha256(bytes) === source.sha256 ? { ...source, sourceFile: file } : { ...source, unavailable: true };
    })) };
  return { ...(frame.guidance.length || frame.scenarios.length || retained.length
    ? { basis: { guidance: frame.guidance, scenarios: [...frame.scenarios, ...retained],
      ...(originalContext ? { originalContext } : {}) } } : { reason: 'NO_FRAME_ITEMS' }),
  preparation: { status: frame.status, reason: frame.reason, counterexampleAuditVersion: frame.counterexampleAuditVersion ?? 0,
    ...(retained.length ? { retainedCounterexamples: retained.length } : {}) },
  ...(checks.length ? { checks } : {}) };
}

export const FRAME_REVIEW_INSTRUCTIONS = `Requirement frame (basis part requirement-frame): guidance items G*, behavior scenarios S*, and optional review-only independent counterexamples C* that the program prepared from the task-start code before this candidate existed, after checking that their evidence exists and their quotes come from the user messages. They are advisory: the original user messages remain the only authority, and the frame never adds obligations.
The program retained C* independently of the brief selector's decisions and quotas. Review each C* against the actual current code under its original entry and given; a prior placement preference, rejection or other scenario with a different dependency outcome is not authority to retire it. A caller-owned no-effect requirement must be traced under its original successful substitute even when the repaired real callee now rejects. Do not infer an explicit caller obligation from a counterexample alone: establish ownership from the original request/source, or explain source-backed inapplicability. Missing authority or evidence remains UNVERIFIED. C* were not delivered as host implementation advice.
Derive the requested entry points and observable effects from the original messages and current source before judging the frame. A proposed placement, a lower-helper test or an isolated pass does not authorize changing a caller's setup or prove its side-effect guarantee. Resolve each item against its own input, actual dependency outcome and observable effect; explain uncertainty locally rather than assuming the frame is correct.
The frame's originalContext carries program-prepared task-start source and frozen sourceFile navigation, including test setup and assertions. A scenario's given is still a hypothesis. Judge the actual code under the original setting; rejecting a rewritten fixture does not retire the original caller contract. One obsolete assertion does not retire later assertions, and the user's silence about an existing observable field does not authorize changing it. Source can establish inapplicability; insufficient evidence remains UNVERIFIED. No additional proof fields are required.
For a source-backed scenario with entryPoint and evidence, check that exact public entry under its stated input, prior state and active configuration. The task-start citation explains the original domain/ownership, not proof that the current implementation satisfies the requested rule. Trace the current decision and observable effect; do not substitute the success of a different private route or a test run under default configuration.
Trace configuration from the actual public request/event to its writer and the shared rule consuming it. Exercise supported optional parameters both present and absent; a call existing in a source file does not prove its guarded branch is reached. Verify rejection before the first effect. Read the actual generated proposal and current code; the task-start frame did not review that later proposal. Reconsider unsupported preservation assumptions against the original request instead of treating old code order as authority.
Keep the original dependency substitutes, success/failure outcomes and input boundary fixed while checking the current code. Passing after replacing a mock is not evidence for the original contract. Read the original setup and each assertion, distinguish superseded expectations from still-valid effects, then trace the current entry to its first observable effect and final consumer. If whole-suite and isolated results disagree, establish the setup/cleanup cause; a suspected leaked mock alone cannot close the item.
For a caller-owned no-effect guarantee, trace the original success-returning substitute to the first effect even if the repaired real callee cannot return success for that input. A changed assertion does not authorize changing the dependency outcome. A frame scenario that assumes an unmocked callee cannot by itself close the original substituted caller path. Check that path separately through the original requirement, or retain UNVERIFIED; do not use a real-callee-only trace as proof of the caller guarantee.
Before finishing, give every frame item exactly one entry in finish_stop_review.frameDispositions:
- CHECKED: give a substantive reason explaining the current-code trace. For each source-backed scenario also give contractAssessment {applicability, trace}. The program binds its original entryPoint and given by item ID; do not rewrite them. Use applicability APPLICABLE or NOT_APPLICABLE, with decisive current source locations, dependency outcomes and observable effects in trace. NOT_APPLICABLE requires an explanation from the original request/source of why this scenario does not apply, including an unsupported preservation assertion. It is not an escape for an untested or uncertain claim. A different entry, changed mock or missing evidence must remain UNVERIFIED.
- DEVIATION: it does not hold, and you saved a proved deviation for the corresponding original requirement (checklist object or submit_finding). Give that objectId.
- UNVERIFIED: evidence is insufficient to establish applicability or the current result within budget. Give a short reason. Source-proved inapplicability is CHECKED/NOT_APPLICABLE, not uncertainty. An incomplete advisory preparation does not by itself make an actual delivery contract unverified.
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
    contractAssessment: { ...object({ applicability: { enum: ['APPLICABLE', 'NOT_APPLICABLE'] }, trace: textSchema }),
      properties: { entryPoint: scenarioSchema.properties.entryPoint, given: textSchema,
        applicability: { enum: ['APPLICABLE', 'NOT_APPLICABLE'] }, trace: textSchema } },
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
  for (const { id, disposition, citeIds, objectId, reason, contractAssessment } of dispositions) {
    const scenario = frame.scenarios.find(item => item.id === id);
    if (!remaining.delete(id)) return reject(`Unknown or repeated frame ID ${id}.`);
    if (disposition === 'DEVIATION' && !hasDeviation(objectId)) return reject(`${id} has no saved deviation for objectId ${objectId}.`);
    if (disposition === 'UNVERIFIED' && !reason?.trim()) return reject(`${id} needs a nonempty UNVERIFIED reason.`);
    if (disposition === 'CHECKED') {
      if (!reason?.trim()) return reject(`${id} needs a substantive CHECKED reason.`);
      if (scenario?.entryPoint && (!contractAssessment || contractAssessment.entryPoint && (contractAssessment.entryPoint.path !== scenario.entryPoint.path
        || contractAssessment.entryPoint.symbol !== scenario.entryPoint.symbol) || contractAssessment?.given !== undefined && contractAssessment.given !== scenario.given
        || !contractAssessment.trace.trim()))
        return reject(`${id} needs contractAssessment for the exact original entryPoint and given, with a current-source trace or a source-backed NOT_APPLICABLE explanation. Use UNVERIFIED when evidence is insufficient.`);
    }
    const evidence = null;
    coverage[disposition.toLowerCase()]++;
    coverage.items.push({ id, type: frame.guidance.some(item => item.id === id) ? 'FRAME_GUIDANCE'
      : checks.some(item => item.id === id) ? 'FRAME_CHECK' : 'FRAME_SCENARIO', disposition,
      ...(reason ? { reason } : {}), ...(objectId ? { objectId } : {}),
      ...(contractAssessment ? { contractAssessment: { ...contractAssessment, ...(scenario?.entryPoint
        ? { entryPoint: structuredClone(scenario.entryPoint), given: scenario.given } : {}) } } : {}),
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
