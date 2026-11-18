import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProtocolTask, taskError } from '../review-task/protocol-task.mjs';
import { createProductionTraceSchema } from '../review-task/production-trace.mjs';
import { STOP_TASK_LIMITS } from '../review-task/stop-policy.mjs';
import { STOP_REVIEW_SCHEMA } from './reviewer.mjs';
import { selectStopPopulation } from './review-routing.mjs';
import { completionProperties, COMPLETION_INSTRUCTIONS, validateStopClassification } from './stop-classification.mjs';
import { reviewProofScope, reviewProofOwners, requiresExecutionResult, validateReviewJudgement, validateReviewFinding, validateReviewFile } from './review-result-validation.mjs';
import { buildOriginalStopPopulation, METRIC_CATALOG } from './metrics.mjs';
import { markdownTitle } from './original-requirements.mjs';
import { createOriginalSourceAnchor } from './original-source-anchor.mjs';
import { taskDirectory, decisionGuard } from './task-store.mjs';
import { readJson, safeId, sha256 } from './utils.mjs';
import { isSkillFileName, resolveSkillDirectory, scanSkillDirectory } from './skill-source.mjs';
import { fingerprint } from './evidence-state.mjs';
import { covers, excerpt, planIndependentReads } from '../review-task/evidence-utils.mjs';
import * as activeHost from '../active-host.mjs';
import { EXPECTED_FILES_SCHEMA, normalizeExpectedFiles, resolveExpectedFilePath, observeExpectedFile, expectedFilesCurrent } from './expected-files.mjs';
import { CONDITION_ASSESSMENT_SCHEMA, CONDITIONAL_REVIEW_POLICY_VERSION } from '../review-task/task-evidence.mjs';
import { STANDING_OBLIGATIONS_TEXT, STANDING_REGRESSION, collectRegressionEvidence, collectRegressionFailureTests,
  isRegressionSourcePath, isTestEvidencePath, regressionFailureInventory, regressionNavigation, renderRegressionEvidence, renderRegressionRun, standingRegressionItem } from './regression-evidence.mjs';
import { taskStartManifestPath } from './task-changes.mjs';
import { loadStopFollowUps } from './deviations.mjs';
import { summarizeStopUnverified } from './stop-unverified.mjs';
import { stopReviewCoverage } from './stop-review-coverage.mjs';
import { resolveStopCitations, stopAttachmentCurrent, STOP_CITATIONS_SCHEMA } from './stop-citations.mjs';
import { reviewedRegressionFailures } from './regression-triage.mjs';
import { historicalOrderProof, successfulHistoricalResult, HISTORICAL_ORDER_SCHEMA,
  classifiedProcessRow, needsProcessClassification, processRepairProof, PROCESS_REPAIRS_SCHEMA } from './historical-order.mjs';
import { proveCommandUnavailable, ENVIRONMENT_COMMANDS_SCHEMA } from './environment-execution.mjs';
import { countFrameDispositions, FRAME_DISPOSITIONS_WIRE, FRAME_REVIEW_INSTRUCTIONS, proposedCheckInstructions } from './requirement-frame.mjs';
import { buildSemanticGraph, semanticGraphInstructions, SEMANTIC_GRAPH_TOOL } from '../semantic-graph.mjs';
import { findSiblingLiteralDispatches, discoverSiblingLiteralDispatches } from '../semantic-graph-syntax.mjs';
import { createProductionOriginCoverage } from './production-origin-coverage.mjs';

const executeFile = promisify(execFile);
const MAX_RESUMED_CHECKLIST_BYTES = 32 * 1024;
export async function compactSemanticNavigation(links, removed, save) {
  const value={...(links.length?{currentSemanticLinks:links}:{}),...(removed.length?{removedLiteralUses:removed}:{})};
  if(Buffer.byteLength(JSON.stringify(value))<=8192)return value;
  return {semanticNavigationFiles:await save(value),navigationOnly:true};
}
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 4000 };
const quote = { type: 'string', minLength: 1 };
const citeIds = { description: 'Legacy citation IDs or path/range strings; prefer citations: [{path,start,end}].' };
const coverageSourceRange = schema({ citeId: text, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } },
  ['citeId', 'start', 'end']);
const coverageBranches = { type: 'array', maxItems: 4, items: schema({
  disposition: { type: 'string', enum: ['VERIFIED', 'OUT_OF_SCOPE'] }, reason: text,
  entry: coverageSourceRange, consumer: coverageSourceRange, handoff: coverageSourceRange,
}, ['disposition', 'reason', 'entry']) };
const productionBaseFlowProperties = {
  entry: { ...coverageSourceRange, description: 'Current production boundary where the user or caller supplies the input or selection for this obligation.' },
  consumer: { ...coverageSourceRange, description: 'Current production source that produces the observable effect.' },
  handoff: { ...coverageSourceRange, description: 'Source that passes the actual value or decision from entry to consumer. Required when they are in different files.' },
  branches: { ...coverageBranches, description: 'Cite the exact dispatch ranges listed as siblingDispatches. VERIFIED also needs the observable consumer and any distinct handoff. OUT_OF_SCOPE needs a source-based explanation of why the branch falls outside this original obligation.' },
};
const productionBaseFlowSchema = schema(productionBaseFlowProperties, ['entry', 'consumer']);
const productionFlowSchema = schema({ ...productionBaseFlowProperties,
  originReceiptId: { ...text, description: 'Host-issued review_production_origin receipt for this exact requirement and entry. Required by strict origin coverage.' },
  upstream: { type: 'array', maxItems: 24, items: schema({
    candidateId: text, disposition: { enum: ['VERIFIED', 'OUT_OF_SCOPE'] }, reason: text,
    citeIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, uniqueItems: true },
    entry: coverageSourceRange, flow: productionBaseFlowSchema,
  }, ['candidateId', 'disposition', 'reason', 'citeIds']),
  description: 'Account for every host-observed upstream candidate. VERIFIED needs a full producer flow, including applicable static sibling dispatches; OUT_OF_SCOPE needs a current read and source-grounded reason.' },
}, ['entry', 'consumer']);
const productionEntryGuidance = 'Trace from the boundary where the user or caller supplies the relevant input or selection. If you start in a downstream helper, follow its callers. Use semantic_graph incoming when available. For indirect dispatch, search source for the exact route, message or event identifier. Compare applicable branches that receive that input or selection and explain what each passes to the consumer.';
const structuredSource = /\.(?:json5?|ya?ml|toml|html|css|xml|sql)$/iu;
const navigationLabel = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : undefined;
const lineAtByte = (bytes, offset) => bytes.subarray(0, offset).reduce((line, byte) => line + Number(byte === 10), 1);
const productionObligationKey = (anchor, text) => JSON.stringify([anchor?.anchorId, text.trim()]);

function boundedEntries(entries, limit, byteBudget) {
  const selected = [];
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (size > byteBudget) continue;
    selected.push(entry);
    byteBudget -= size;
    if (selected.length === limit) break;
  }
  return selected;
}

// This is the entire model review for one Stop, including scope selection.
// Only small original obligations/process records are serialized. Business
// files are never copied, and discovery is independent of the source manifest.
export async function runWorkspaceStopReview(input, { session }) {
  const deviationOnly = input.request.population.reviewPolicy?.deviationOnly === true;
  const requireProductionCoverage = deviationOnly && input.request.population.reviewPolicy?.requireCurrentProductionCoverage === true;
  const projectRoot = await fs.realpath(input.projectRoot);
  const directory = path.join(taskDirectory(projectRoot, input.taskId), 'workspace-reviews', randomUUID());
  const basisRoot = path.join(directory, 'basis'), processRoot = path.join(directory, 'execution');
  await fs.mkdir(basisRoot, { recursive: true }); await fs.mkdir(processRoot);
  const taskPath = path.join(taskDirectory(projectRoot, input.taskId), 'task.json');
  const initialState = await readJson(taskPath);
  const initialGuard = decisionGuard(initialState);
  const originalRequirements = input.evidence?.originalRequirements;
  const approvedInventory = input.request.approvedProposalInventory;
  if (approvedInventory && (!originalRequirements || !deviationOnly || input.request.population.reviewPolicy?.metrics?.M16 === false
    || !Array.isArray(approvedInventory.requiredAtoms) || !approvedInventory.requiredAtoms.length
    || sha256(approvedInventory.requiredAtoms) !== approvedInventory.inventorySha256))
    throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'The approved Proposal inventory requires an original-basis production review.');
  const useProductionCoverage = requireProductionCoverage || Boolean(approvedInventory?.requiredAtoms.length);
  const requireOriginCoverage = useProductionCoverage && input.request.population.reviewPolicy?.requireProductionOriginCoverage === true;
  const planCoverage = input.evidence?.approvedPlanCoverage;
  function approvedProposalNavigation(objects) {
    if (!planCoverage) return null;
    const byAnchor = new Map();
    for (const { objectId, originalSourceAnchor } of objects) {
      if (!originalSourceAnchor) continue;
      const { anchorId } = originalSourceAnchor;
      if (!byAnchor.has(anchorId)) byAnchor.set(anchorId, []);
      byAnchor.get(anchorId).push(objectId);
    }
    const matches = planCoverage.rows.filter(row => byAnchor.has(row.source.anchorId));
    if (!matches.length) return null;
    const rows = matches.map(({ source, requirement, disposition, targets }) =>
      ({ source, requirement, disposition, targets, matchingObjectIds: byAnchor.get(source.anchorId) }));
    return { navigationOnly: true, changeName: planCoverage.changeName, approvedRevision: planCoverage.approvedRevision,
      proposalRunId: planCoverage.proposalRunId, applyRunId: planCoverage.applyRunId,
      total: matches.length, rows: boundedEntries(rows, 8, 6144),
      instruction: 'These Proposal observations locate plan text. Verify each Stop item against current implementation and execution evidence.' };
  }
  const truthPath = originalRequirements ? null : input.request.groundTruthPath;
  const persistedTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) : null;
  const processSnapshotPath = input.request.processSnapshotPath && await fs.realpath(input.request.processSnapshotPath).catch(() => null);
  const processSnapshotHash = processSnapshotPath && sha256(await fs.readFile(processSnapshotPath));
  const protectedInputs = new Map();
  let truth = input.evidence?.groundTruth ?? (persistedTruth && JSON.parse(persistedTruth));
  if (!truth || truth.taskId && truth.taskId !== input.taskId) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'The current authoritative baseline is unavailable');
  const basisFiles = [], processFiles = new Set(), executionFiles = new Set(), originalSources = new Map(), optionalSources = [], referenceMaterials = [];
  const approvedAtomIds = new Set(), approvedItems = new Map(), approvedAtomsByRef = new Map();
  const invalidInventory = () => taskError('STOP_TASK_BASIS_UNAVAILABLE', 'An approved Proposal atom does not match the current original user requirements.');
  for (const atom of approvedInventory?.requiredAtoms ?? []) {
    const { id, source, requirement } = atom ?? {};
    if (typeof id !== 'string' || !id.trim() || approvedAtomIds.has(id) || typeof requirement !== 'string' || !requirement.trim()
      || source?.kind !== 'USER_MESSAGE' || typeof source.ref !== 'string' || !source.ref.trim()
      || !Number.isSafeInteger(source.byteStart) || !Number.isSafeInteger(source.byteEnd)
      || source.byteStart < 0 || source.byteEnd <= source.byteStart) throw invalidInventory();
    approvedAtomIds.add(id);
    if (!approvedAtomsByRef.has(source.ref)) approvedAtomsByRef.set(source.ref, []);
    approvedAtomsByRef.get(source.ref).push(atom);
  }
  async function parts(root, name, value, mandatory = false, execution = false, raw = false) {
    const bytes = Buffer.from(raw ? value : JSON.stringify(value) + '\n');
    const written = [];
    for (let start = 0, index = 0; start < bytes.length; index++) {
      session.active();
      let end = Math.min(start + 16384, bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const file = path.join(root, `${name}-${String(index).padStart(4, '0')}.txt`);
      await fs.writeFile(file, bytes.subarray(start, end), { flag: 'wx' });
      written.push(file);
      if (mandatory) basisFiles.push(file);
      if (root === processRoot) processFiles.add(file);
      if (execution) executionFiles.add(file);
      start = end;
    }
    return written;
  }
  const entries = input.evidence?.snapshot?.entries ?? [];
  const originalUsers = entries.filter(entry => entry.type === 'user' && entry.isMeta !== true && (typeof entry.message?.content === 'string'
    ? !entry.message.content.includes('[runtime-corrector:internal]')
    : entry.message?.content?.some?.(block => block.type === 'text' && !String(block.text ?? '').includes('[runtime-corrector:internal]'))));
  // One lossless basis stream replaces separate small mandatory reads. Large
  // inputs still split on UTF-8 boundaries without summarizing conditions.
  if (originalRequirements) {
    for (const [index, message] of originalRequirements.userMessages.entries()) {
      const files = await parts(basisRoot, `user-original-${index}`, message.text, true, false, true);
      let lineOffset = 0, byteOffset = 0;
      const chunks = [];
      for (const [part, file] of files.entries()) {
        const bytes = await fs.readFile(file);
        const source = { kind: 'USER_MESSAGE', ref: message.ref, sha256: message.sha256,
          readHash: sha256(bytes), part: part + 1, lineOffset, byteOffset };
        originalSources.set(file, source);
        chunks.push({ ...source, byteEnd: byteOffset + bytes.length });
        lineOffset += bytes.reduce((count, byte) => count + Number(byte === 10), 0);
        byteOffset += bytes.length;
      }
      const atoms = approvedAtomsByRef.get(message.ref);
      if (!atoms) continue;
      approvedAtomsByRef.delete(message.ref);
      const bytes = Buffer.from(message.text);
      if (sha256(bytes) !== message.sha256) throw invalidInventory();
      for (const { id, requirement, source } of atoms) {
        if (source.sha256 !== message.sha256 || source.byteEnd > bytes.length) throw invalidInventory();
        const start = lineAtByte(bytes, source.byteStart), end = lineAtByte(bytes, source.byteEnd);
        let anchor;
        try { anchor = createOriginalSourceAnchor({ ref: message.ref, sha256: message.sha256, bytes, start, end }); }
        catch { throw invalidInventory(); }
        if (anchor.anchorId !== source.anchorId || anchor.byteStart !== source.byteStart || anchor.byteEnd !== source.byteEnd
          || id !== sha256([anchor.anchorId, requirement.trim()]))
          throw invalidInventory();
        let chunk = chunks.find(part => part.byteOffset <= anchor.byteStart && part.byteEnd >= anchor.byteEnd);
        if (!chunk) {
          // Preserve the exact approved lines when normal paging splits their source range.
          const excerptBytes = bytes.subarray(anchor.byteStart, anchor.byteEnd), part = chunks.length + 1;
          const file = path.join(basisRoot, `user-approved-${index}-${part}.txt`);
          await fs.writeFile(file, excerptBytes, { flag: 'wx' });
          chunk = { kind: anchor.kind, ref: anchor.ref, sha256: anchor.sha256, readHash: sha256(excerptBytes),
            part, lineOffset: start - 1, byteOffset: anchor.byteStart, byteEnd: anchor.byteEnd, approvedExcerpt: true };
          originalSources.set(file, chunk);
          basisFiles.push(file);
          chunks.push(chunk);
        }
        const key = productionObligationKey(anchor, requirement);
        approvedItems.set(key, { id, item: { metricId: 'M16', text: requirement,
          verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', originalSourceAnchor: anchor,
          source: { kind: anchor.kind, ref: anchor.ref, sha256: anchor.sha256, part: chunk.part, start, end } } });
      }
    }
    let frozenCount = 0;
    const frozenOriginal = async (name, base64) => {
      const bytes = Buffer.from(base64, 'base64'), file = path.join(basisRoot, 'reference-originals', `${++frozenCount}-${sha256(bytes).slice(0, 16)}-${path.basename(name)}`);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
      return { file, sha256: sha256(bytes), bytes };
    };
    const optional = (file, kind, ref, hash) => { if (hash && !originalSources.has(file)) originalSources.set(file, { kind, ref, sha256: hash, readHash: hash, lineOffset: 0, optional: true }); };
    for (const [kind, sources] of [['PROJECT_FILE', originalRequirements.projectFiles], ['MATERIAL', originalRequirements.materials],
      ['MATERIAL', originalRequirements.referencedFiles]]) for (const source of sources) {
      const copy = source.originalBase64 ? await frozenOriginal(source.path, source.originalBase64) : null;
      const file = copy?.file ?? await fs.realpath(path.resolve(projectRoot, source.path));
      if (source.mandatory === false) { optionalSources.push({ file, kind, ref: source.path, bytes: source.bytes, note: source.note });
        optional(file, kind, source.path, copy?.sha256 ?? source.sha256); continue; }
      if (originalSources.has(file)) continue;
      originalSources.set(file, { kind, ref: source.path, sha256: copy?.sha256 ?? source.sha256, readHash: copy?.sha256 ?? source.sha256, lineOffset: 0 });
      basisFiles.push(file);
      if (copy) referenceMaterials.push({ path: source.path, file: path.resolve(projectRoot, source.path), bytes: copy.bytes.length,
        title: markdownTitle(copy.bytes.toString('utf8')), sha256: copy.sha256, status: source.status, frozenOriginal: copy.file,
        note: 'Named by the user, so its task-start copy is a mandatory source.' });
    }
    // Reference tier: optional context, read on demand and never mandatory.
    for (const { originalBase64, ...material } of originalRequirements.referenceMaterials ?? []) {
      const copy = originalBase64 ? await frozenOriginal(material.path, originalBase64) : null;
      const file = path.resolve(projectRoot, material.path);
      if (copy) optional(copy.file, 'MATERIAL', material.path, copy.sha256);
      else if (['UNCHANGED', 'UNTRACKED'].includes(material.status))
        optional(await fs.realpath(file).catch(() => file), 'MATERIAL', material.path, material.status === 'UNCHANGED' ? material.sha256 : material.currentSha256);
      referenceMaterials.push({ ...material, ...(material.status !== 'DELETED' ? { file } : {}), ...(copy ? { frozenOriginal: copy.file } : {}) });
    }
    if (!originalSources.size) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'No original user requirements or materials are available');
  }
  if (approvedAtomsByRef.size) throw invalidInventory();
  const referenceBasisFiles = optionalSources.length || referenceMaterials.length
    ? await parts(basisRoot, 'reference-catalog', { optionalSources, referenceMaterials }) : [];
  const lastAssistant = entries.findLast(entry => entry.type === 'assistant');
  const assistantContent = lastAssistant?.message?.content;
  const assistantText = typeof assistantContent === 'string' ? assistantContent
    : Array.isArray(assistantContent) && assistantContent.length === 1 && assistantContent[0]?.type === 'text'
      ? assistantContent[0].text : undefined;
  const hook = input.request.hook && { ...input.request.hook };
  if (hook && typeof assistantText === 'string') {
    for (const key of ['lastAssistantMessage', 'last_assistant_message']) {
      if (hook[key] === assistantText) delete hook[key];
    }
  }
  await parts(basisRoot, 'original-basis', { ...(originalRequirements ? { sources: [...originalSources].filter(([, source]) => !source.optional).map(([file, { kind, ref, part, lineOffset, approvedExcerpt }]) =>
    ({ file, kind, ref, ...(part ? { part, lineOffset } : {}), ...(approvedExcerpt ? { approvedExcerpt } : {}) })) } : { groundTruth: truth }),
    request: { hook, instructions: input.request.instructions, workflowStages: input.request.workflowStages,
      metricDefinitions: Object.fromEntries(Object.entries(METRIC_CATALOG).filter(([id]) => originalRequirements
        ? input.request.population.reviewPolicy?.metrics[id] !== false : input.request.population.metrics[id]?.length)) },
    ...(!originalRequirements ? { originalUserMessages: originalUsers } : {}),
    latestAssistant: lastAssistant ?? input.request.hook }, true);
  let { basis: requirementFrame, reason: frameAbsent } = input.request.requirementFrame ?? {};
  if (requirementFrame) {
    try { basisFiles.push(...await parts(basisRoot, 'requirement-frame', requirementFrame)); }
    catch { requirementFrame = null; frameAbsent = 'FRAME_BASIS_UNAVAILABLE'; }
  }
  const entryPaths = new Map(), invocationFiles = new Map(), executionCalls = new Map(), historyEvents = new Map(), historicalOrders = new Map();
  const resultsBeforeInvocation = new Set();
  const processRepairs = new Map();
  const environmentExceptions = new Map();
  const originalUserEntries = new Set(originalUsers), originalUserProcessFiles = [];
  const toolCalls = new Set(entries.filter(entry => entry.type === 'assistant').flatMap(entry => Array.isArray(entry.message?.content)
    ? entry.message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []));
  const isExecutionRecord = entry => entry.type === 'user' && Array.isArray(entry.message?.content)
    && entry.message.content.some(block => block.type === 'tool_result' && toolCalls.has(block.tool_use_id));
  const programExecution = value => { const verification = value?.deviceEvidence?.verification ?? value?.verification;
    return ['build', 'smoke'].some(key => ['passed', 'failed'].includes(verification?.[key]?.status)); };
  for (const [index, entry] of entries.entries()) {
    const files = await parts(processRoot, String(index).padStart(6, '0'), entry, false, isExecutionRecord(entry)); entryPaths.set(index, files);
    if (originalUserEntries.has(entry)) originalUserProcessFiles.push(...files);
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === 'assistant') for (const block of blocks.filter(block => block.type === 'tool_use')) {
      invocationFiles.set(block.id, invocationFiles.has(block.id) ? null : files);
      if (historyEvents.has(block.id)) historyEvents.get(block.id).ambiguous = true;
      else historyEvents.set(block.id, { callIndex: index, callDigest: sha256(block), toolName: navigationLabel(block.name),
        operation: navigationLabel(block.input?.action) ?? navigationLabel(block.input?.operation) });
    }
    if(isExecutionRecord(entry))for(const block of blocks.filter(block=>block.type==='tool_result')) {
      const event=historyEvents.get(block.tool_use_id);
      if(event) {
        if (event.resultIndex !== undefined) event.ambiguous = true;
        Object.assign(event,{resultIndex:index,resultDigest:sha256(block),successful:successfulHistoricalResult(block)});
      } else if (toolCalls.has(block.tool_use_id)) resultsBeforeInvocation.add(block.tool_use_id);
    }
    if (isExecutionRecord(entry)) for (const file of files)
      executionCalls.set(file, blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
  }
  if (input.request.deviceEvidence) await parts(processRoot, 'program-verification', input.request.deviceEvidence, false, programExecution(input.request.deviceEvidence));
  let population = input.request.population;
  // Proposed checks join the original checklist only through their frozen
  // task-start document lines; each must build as a valid original item.
  const proposedSeeds = [];
  if (originalRequirements) for (const check of input.request.requirementFrame?.checks ?? []) try {
    if (!Object.hasOwn(METRIC_CATALOG, check.metricId) || population.reviewPolicy?.metrics[check.metricId] === false) continue;
    const bytes = await fs.readFile(check.sourceFile), hash = check.source.sha256;
    if (sha256(bytes) !== hash) continue;
    const item = { metricId: check.metricId, text: check.text, verificationTarget: check.verificationTarget,
      ...(check.applicability ? { applicability: check.applicability } : {}),
      source: { kind: 'PROJECT_FILE', ref: check.source.path, sha256: hash, start: check.source.startLine, end: check.source.endLine } };
    const [{ objectId }] = buildOriginalStopPopulation({ population, checklist: [item], sourceDigest: originalRequirements.digest }).population.metrics[check.metricId];
    if (proposedSeeds.some(seed => seed.objectId === objectId)) continue;
    const file = path.join(basisRoot, 'proposed-check-sources', `${sha256([check.source.path, hash]).slice(0, 16)}-${path.posix.basename(check.source.path)}`);
    if (!originalSources.has(file)) {
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
      originalSources.set(file, { kind: 'PROJECT_FILE', ref: check.source.path, sha256: hash, readHash: hash, lineOffset: 0, optional: true });
    }
    proposedSeeds.push({ check: { ...check, sourceFile: file }, item, objectId });
  } catch { session.active(); }
  if (proposedSeeds.length) await parts(basisRoot, 'proposed-checks', proposedSeeds.map(({ check, objectId }) => ({ ...check, objectId })), true);
  const proposedIds = new Map(proposedSeeds.map(seed => [seed.objectId, seed.check.id]));
  const dispositionChecks = deviationOnly ? proposedSeeds.map(seed => seed.check) : [];
  const dispositionFrame = requirementFrame || dispositionChecks.length
    ? { guidance: requirementFrame?.guidance ?? [], scenarios: requirementFrame?.scenarios ?? [], checks: dispositionChecks } : null;
  const canonicalTraceSchema = !deviationOnly
    && (originalRequirements ? population.reviewPolicy?.metrics.M16 !== false : population.metrics.M16?.length)
    ? createProductionTraceSchema() : null;
  const traceVersion = canonicalTraceSchema?.properties.version;
  if (canonicalTraceSchema && (traceVersion?.const !== 1 || traceVersion.type !== 'number' || Object.hasOwn(traceVersion, 'enum')))
    throw taskError('M16_PRODUCTION_TRACE', 'Workspace submission requires the single known canonical productionTrace version const 1.');
  const wireTraceSchema = canonicalTraceSchema && { ...canonicalTraceSchema,
    properties: { ...canonicalTraceSchema.properties, version: { const: traceVersion.const } },
    required: canonicalTraceSchema.required.filter(field => field !== 'version'),
    description: 'For a supplied trace on any assigned M16 item, the program fills its fixed version=1 when omitted. Every other wire field remains explicit. D/U may omit the entire trace; supplying one does not create PASS proof. Explicit other versions are rejected.' };
  let allObjects = Object.values(population.metrics).flat(), reviewBasis;
  const rows = new Map(), validatedRows = new Map(), files = new Map(), findings = [], citations = [], proofs = {};
  const attachmentPaths = new Set(), citationDrafts = new Map(), citationIssues = new Map();
  const citationDiagnostics = { rejectedSubmissions: 0, correctedItems: 0, downgradedItems: 0, events: [] };
  const productionCoverageFiles = new Set();
  const currentFile = file => !attachmentPaths.has(file) || productionCoverageFiles.has(file) || basisFiles.includes(file) || protectedInputs.has(file)
    || originalSources.has(file) || skillDependencies.has(file);
  const expectedFileChecks = [], unresolvedExpectedPaths = [];
  const expectedSourceContexts = new Map();
  const expectedSourceContext = async claim => {
    if (!originalRequirements || !claim.source) return claim.text;
    const source = claim.source, key = sha256([source.kind, source.ref, source.sha256]);
    if (!expectedSourceContexts.has(key)) {
      const message = source.kind === 'USER_MESSAGE' && originalRequirements.userMessages.find(value =>
        value.ref === source.ref && value.sha256 === source.sha256);
      const originals = [...originalSources].filter(([, value]) => value.kind === source.kind && value.ref === source.ref && value.sha256 === source.sha256);
      expectedSourceContexts.set(key, message ? message.text : originals.length
        ? (await Promise.all(originals.map(([file]) => fs.readFile(file, 'utf8')))).join('') : claim.text);
    }
    return expectedSourceContexts.get(key);
  };
  const skills = new Map(), skillDependencies = new Map(), skillReadPaths = new Map();
  const controlRoot = path.join(projectRoot, '.runtime-correction');
  const excluded = (input.excludedEvidencePaths ?? []).map(file => path.resolve(file));
  const programOwned = file => inside(controlRoot, file) || excluded.some(root => inside(root, file));
  const originalEvidence = file => inside(basisRoot, file) || processFiles.has(file) || skillDependencies.has(file) || originalSources.has(file) || file === truthPath;
  async function skillBasis(object) {
    if (object.metricId !== 'M08') return null;
    if (!skills.has(object.skillId)) {
      const skillRoot = path.join(taskDirectory(projectRoot, input.taskId), 'skills', safeId(object.skillId ?? 'unknown'));
      const documentPath = path.join(skillRoot, 'skill-ground-truth.json'), document = await readJson(documentPath);
      const captured = input.evidence?.skillSource ?? await readJson(path.join(skillRoot, 'skill-source.json'));
      const sourceIdentity = object.skillSourceIdentity ?? document?.sourceContract?.sourceIdentity;
      const resolved = await resolveSkillDirectory({ skillId: object.skillId, projectRoot, pluginRoot: input.pluginRoot,
        configuredRoots: input.skillRoots ?? [], hostAdapter: input.hostAdapter ?? activeHost, sourceIdentity });
      const original = sourceIdentity ? resolved
        : captured?.root && (inside(path.join(skillRoot, 'source'), captured.root) || captured.root === resolved) ? captured.root : resolved;
      const source = original ? await scanSkillDirectory(original, { sourceIdentity }) : null;
      if (!document || document.taskId !== input.taskId || document.skillId !== object.skillId
        || document.digest !== sha256({ skillId: document.skillId, skillDigest: document.skillDigest, constraints: document.constraints, taskOverlays: document.taskOverlays,
          ...(document.sourceContract ? { sourceContract: document.sourceContract } : {}) })
        || !source || source.truncated || source.digest !== document.skillDigest) {
        skills.set(object.skillId, { error: 'The complete original Skill and its formal constraint document are unavailable or changed.' });
      } else {
        skillReadPaths.set(path.resolve(original), source.root);
        const documentFiles = await parts(basisRoot, `skill-${sha256(object.skillId).slice(0, 16)}`, document);
        skillDependencies.set(documentPath, await fingerprint(documentPath));
        for (const file of source.files) skillDependencies.set(path.resolve(source.root, file.path), file.sha256);
        const directories = new Set([source.root]);
        for (const file of source.files) { let directory = path.dirname(path.resolve(source.root, file.path));
          while (inside(source.root, directory) && directory !== source.root) { directories.add(directory); directory = path.dirname(directory); }
        }
        for (const directory of directories) skillDependencies.set(directory, await fingerprint(directory));
        skills.set(object.skillId, { source, document, documentFiles });
      }
    }
    const record = skills.get(object.skillId);
    if (record.error) return record;
    if (object.skillSourceIdentity && sha256(object.skillSourceIdentity) !== sha256(record.document.sourceContract?.sourceIdentity ?? null)
      || object.skillGraphDigest && object.skillGraphDigest !== record.document.digest)
      return { error: 'The assigned Skill source identity or graph differs from its bound original revision.' };
    const constraint = record.document.constraints.find(item => `${object.skillId}:${item.constraintId}` === object.sourceId);
    if (!constraint || !['MUST', 'PROHIBITED'].includes(constraint.modality) || object.sourceRevisionId !== `${object.skillId}@${record.document.version}`
      || object.description !== constraint.statement) return { error: 'The assigned Skill obligation differs from its original revision.' };
    const related = new Set([constraint.constraintId]);
    for (let size = -1; size !== related.size;) { size = related.size;
      for (const item of record.document.constraints) if (related.has(item.constraintId)) for (const id of item.dependsOn ?? []) related.add(id);
    }
    const references = ['SKILL.md', ...record.document.constraints.filter(item => related.has(item.constraintId))
      .flatMap(item => [item.sourceRef, ...(item.sourceContextFiles ?? [])]).filter(Boolean)];
    const matches = (ref, file) => { const name = String(ref).replaceAll('\\', '/').replace(/#.*$/u, '');
      return name === file.path || name.endsWith(`/${file.path}`) || name.endsWith(`:${file.path}`) || name.startsWith(`${file.path}:`) || name.includes(`/${file.path}:`) || name.includes(`:${file.path}:`); };
    const explicitFile = ref => /(?:^|[\s/:])[^\s#/:]+\.[a-z][a-z\d]{0,8}(?=$|[\s#:])/iu.test(String(ref).replaceAll('\\', '/'));
    if (references.some(ref => explicitFile(ref) && !record.source.files.some(file => matches(ref, file)))
      || !record.source.files.some(file => file.path === 'SKILL.md')) return { error: 'An original Skill source reference is unavailable.' };
    return { requiredFiles: [...record.documentFiles, ...record.source.files.filter(file => references.some(ref => matches(ref, file))).map(file => path.resolve(record.source.root, file.path))] };
  }
  const originalSkillDocuments = [];
  if (originalRequirements) {
    for (const object of population.metrics.M08 ?? []) await skillBasis(object);
    for (const [skillId, { source }] of skills) {
      const document = source?.files.find(file => isSkillFileName(file.path));
      if (!document) continue;
      const file = path.resolve(source.root, document.path);
      originalSkillDocuments.push({ skillId, file });
      if (originalSources.has(file)) continue;
      originalSources.set(file, { kind: 'SKILL_FILE', ref: `skill:${skillId}:${document.path}`,
        sha256: document.sha256, readHash: document.sha256, lineOffset: 0 });
      basisFiles.push(file);
    }
  }
  // Regression is a standing program obligation, not an original requirement.
  let regression = null, regressionFiles = [], regressionRun = null, regressionRunFiles = [], standingSource = null;
  let failureInventory = null;
  let regressionDisposition = null;
  let requirementCheck = null, requirementCheckFiles = [];
  let offeredBoundFailureReview = false;
  const requirementCaseEvidence = new Map();
  const requireBoundProbeEvidence = Array.isArray(input.request.requirementBindings);
  const configuredRequirementBindings = input.request.requirementBindings ?? [];
  const requirementQuotes = new Map(configuredRequirementBindings.map(({ testId, quote }) => [testId, quote]));
  const originalProductionItem = object => object?.originalSource && !object.programStanding
    && object.verificationTarget === 'IMPLEMENTATION' && object.implementationRole === 'PRODUCTION';
  const mandatoryOriginal = source => [...originalSources].find(([, original]) => !original.optional && original.kind === source.kind
    && original.ref === source.ref && original.sha256 === source.sha256 && original.part === source.part);
  async function requirementBinding(testId, objects) {
    const quote = requirementQuotes.get(testId);
    if (!quote) return null;
    const matches = [];
    for (const object of objects) {
      if (!originalProductionItem(object) || object.description !== quote) continue;
      const source = object.originalSource;
      const binding = mandatoryOriginal(source);
      if (!binding) continue;
      const [file, original] = binding;
      const bytes = await fs.readFile(file);
      if (sha256(bytes) !== original.readHash) throw taskError('STOP_TASK_INPUT_CHANGED', 'A bound original requirement changed');
      let quotedLines;
      try { quotedLines = excerpt(bytes, source.start - original.lineOffset, source.end - original.lineOffset).text; }
      catch { continue; }
      if (!quotedLines.includes(quote)) continue;
      protectedInputs.set(file, original.readHash);
      matches.push({ objectId: object.objectId, sourceRevisionId: object.sourceRevisionId });
    }
    return matches.length === 1 ? matches[0] : null;
  }
  const isRequirementEvidence = file => requirementCheckFiles.includes(file) || requirementCaseEvidence.has(file);
  const requirementCaseNavigation = (limit, byteBudget) => {
    const failedCaseEvidence = boundedEntries(requirementCaseEvidence.values(), limit, byteBudget);
    return { failedCaseEvidence, failedCaseEvidenceCount: requirementCaseEvidence.size,
      ...(failedCaseEvidence.length < requirementCaseEvidence.size
        ? { failedCaseEvidenceContinuation: { tool: 'source_ls', arguments: { path: basisRoot, offset: 0 } } } : {}) };
  };
  if (originalRequirements && deviationOnly && population.reviewPolicy?.metrics.M16 !== false) {
    const evidence = await collectRegressionEvidence({ projectRoot, excluded: [controlRoot, ...excluded],
      artifacts: input.request.workflowArtifacts ?? [], signal: session.signal, active: () => session.active(),
      taskChanges: input.request.taskChanges ?? null });
    if (evidence.triggered) {
      const [file] = await parts(basisRoot, 'standing-obligations', STANDING_OBLIGATIONS_TEXT, true, false, true);
      standingSource = { file, sha256: sha256(await fs.readFile(file)) };
      regression = evidence;
      regressionFiles = await parts(basisRoot, 'regression-evidence', renderRegressionEvidence(evidence), false, false, true);
    }
  }
  const followUps = new Map(), followUpResults = new Map();
  if (originalRequirements && deviationOnly) {
    for (const entry of await loadStopFollowUps({ projectRoot, taskId: input.taskId, state: initialState, originalDigest: originalRequirements.digest })) {
      const { object } = entry;
      if (population.reviewPolicy?.metrics[object.metricId] === false) continue;
      const source = object.originalSource;
      if (object.programStanding ? !standingSource : source
        ? ![...originalSources.values()].some(value => value.kind === source.kind && value.ref === source.ref
          && value.part === source.part && value.sha256 === source.sha256)
        : !allObjects.some(value => value.objectId === object.objectId && value.sourceRevisionId === object.sourceRevisionId)) continue;
      if (!followUps.has(object.objectId)) followUps.set(object.objectId, entry);
    }
  }
  let basisBudget = null;
  if (originalRequirements) {
    let mandatoryBytes = 0;
    for (const file of basisFiles) mandatoryBytes += (await fs.stat(file)).size;
    const references = [...optionalSources, ...referenceMaterials.filter(material => !basisFiles.includes(material.frozenOriginal))];
    basisBudget = { mandatoryFiles: basisFiles.length, mandatoryBytes, referenceFiles: references.length,
      referenceBytes: references.reduce((total, reference) => total + (reference.bytes ?? reference.currentBytes ?? 0), 0) };
    await fs.writeFile(path.join(directory, 'basis-budget.json'), JSON.stringify(basisBudget) + '\n', { flag: 'wx' });
  }
  let classification, selected = [], qualityTargets = [], plan = [], notes = [], programEvidenceFiles = [];
  const requiredProduction = new Map(), productionCoverage = new Map();
  const discardStaleOrigin = (objectId, reason) => {
    productionCoverage.delete(objectId);
    // A carried PASS must not close its old finding after its origin proof
    // expires. Preserve the original receipt; the final disposition is U.
    for (const store of [rows, followUpResults]) {
      const row = store.get(objectId);
      if (row?.judgement === 'PASS') store.set(objectId, { ...row, judgement: 'UNVERIFIED',
        reason: `Production origin coverage remains unverified: ${reason}.` });
    }
  };
  const dispatchSources = new Map();
  let offeredCoverageReview = false;
  const siblingDispatches = async ({ path: file, sha256: boundSha256, start, end }, ctx) => {
    if (!/\.(?:ets|[cm]?[jt]s|[jt]sx)$/iu.test(file)) return [];
    if (!dispatchSources.has(file)) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 256 * 1024) return [];
      const bytes = await fs.readFile(file, { signal: session.signal });
      ctx.active();
      if (sha256(bytes) !== boundSha256) throw taskError('STOP_TASK_INPUT_CHANGED', 'The production entry source changed during review.');
      dispatchSources.set(file, bytes.toString('utf8'));
    }
    return findSiblingLiteralDispatches(dispatchSources.get(file), { start, end });
  };
  const productionRange = (ctx, range) => {
    const ref = ctx.evidence.registry.get(range?.citeId), { start, end } = range ?? {};
    return ref && inside(projectRoot, ref.path) && !programOwned(ref.path) && !originalEvidence(ref.path)
      && !isTestEvidencePath(path.relative(projectRoot, ref.path)) && !inside(path.join(projectRoot, '.runtime-corrector'), ref.path)
      && (isRegressionSourcePath(ref.path) || structuredSource.test(ref.path))
      && ctx.evidence.snapshot.get(ref.path)?.sha256 === ref.sha256
      && Number.isSafeInteger(start) && Number.isSafeInteger(end) && ref.start <= start && start <= end && end <= ref.end
      ? { path: ref.path, start, end, sha256: ref.sha256 } : null;
  };
  const coverageEvidence = async (ctx, { objectId, reason, citeIds: ids, flow }, { upstreamOnly = false, strictDispatch = false } = {}) => {
    if (typeof reason !== 'string' || !reason.trim() || !Array.isArray(ids) || !ids.length || ids.length > 8 || new Set(ids).size !== ids.length) return null;
    const evidence = new Map();
    for (const id of ids) {
      // Only the registry contains source pages acknowledged by native persistence.
      const ref = ctx.evidence.registry.get(id);
      if (!ref || !inside(projectRoot, ref.path) || programOwned(ref.path) || originalEvidence(ref.path)
        || isTestEvidencePath(path.relative(projectRoot, ref.path)) || inside(path.join(projectRoot, '.runtime-corrector'), ref.path)
        || !isRegressionSourcePath(ref.path) && !structuredSource.test(ref.path)
        || ctx.evidence.snapshot.get(ref.path)?.sha256 !== ref.sha256) return null;
      evidence.set(id, { path: ref.path, start: ref.start, end: ref.end, sha256: ref.sha256 });
    }
    const anchor = range => {
      const ref = evidence.get(range?.citeId);
      const { start, end } = range ?? {};
      return ref && Number.isSafeInteger(start) && Number.isSafeInteger(end)
        && ref.start <= start && start <= end && end <= ref.end ? { ...ref, start, end } : null;
    };
    const resolveFlow = value => {
      const entry = anchor(value?.entry), consumer = anchor(value?.consumer), handoff = anchor(value?.handoff);
      if (!entry || !consumer || (!handoff && (value.handoff !== undefined || entry.path !== consumer.path))) return null;
      return { entry, consumer, ...(handoff ? { handoff } : {}) };
    };
    const primary = resolveFlow(flow);
    if (!primary) return null;
    const coverage = { reason: reason.trim(), evidence: [...evidence.values()], flow: primary };
    const finishCoverage = async checked => {
      if (!requireOriginCoverage || upstreamOnly) return { coverage: checked };
      const origin = await originCoverage.lookup(flow.originReceiptId, { objectId, entry: primary.entry });
      if (origin.status !== 'READY') return { originIssue: origin.reason };
      const { receipt } = origin, submissions = flow.upstream ?? [], byId = new Map();
      for (const submission of submissions) {
        if (byId.has(submission.candidateId)) return { originIssue: 'DUPLICATE_UPSTREAM_CANDIDATE' };
        byId.set(submission.candidateId, submission);
      }
      if (byId.size !== receipt.candidates.length || receipt.candidates.some(candidate => !byId.has(candidate.id)))
        return { originIssue: 'UPSTREAM_CANDIDATES_INCOMPLETE' };
      const upstream = [], additionalEvidence = [];
      for (const candidate of receipt.candidates) {
        const submission = byId.get(candidate.id);
        if (submission.disposition === 'OUT_OF_SCOPE') {
          const entry = productionRange(ctx, submission.entry);
          if (!entry || !submission.reason?.trim() || !submission.citeIds.includes(submission.entry.citeId)
            || entry.path !== candidate.path || entry.sha256 !== candidate.sha256
            || entry.start > candidate.start || entry.end < candidate.end || submission.flow !== undefined)
            return { originIssue: 'UPSTREAM_EXCLUSION_READ_REQUIRED' };
          additionalEvidence.push(entry);
          upstream.push({ candidateId: candidate.id, disposition: 'OUT_OF_SCOPE', reason: submission.reason.trim(), entry });
          continue;
        }
        if (submission.disposition !== 'VERIFIED') return { originIssue: 'UPSTREAM_DISPOSITION_REQUIRED' };
        const resolved = await coverageEvidence(ctx, { reason: submission.reason, citeIds: submission.citeIds, flow: submission.flow },
          { upstreamOnly: true, strictDispatch: candidate.kinds.includes('FILE_SELECTOR_LITERAL_CANDIDATE') });
        const producer = resolved?.coverage?.flow.entry;
        if (!producer || producer.path !== candidate.path || producer.sha256 !== candidate.sha256
          || producer.start > candidate.start || producer.end < candidate.end)
          return { originIssue: resolved?.originIssue ?? 'UPSTREAM_FLOW_REQUIRED' };
        const terminal = resolved.coverage.flow.consumer;
        if (![checked.flow.entry, checked.flow.consumer].some(boundary =>
          boundary.path === terminal.path && boundary.sha256 === terminal.sha256
            && boundary.start === terminal.start && boundary.end === terminal.end))
          return { originIssue: 'UPSTREAM_FLOW_DISCONNECTED' };
        additionalEvidence.push(...resolved.coverage.evidence);
        upstream.push({ candidateId: candidate.id, disposition: 'VERIFIED', reason: resolved.coverage.reason,
          flow: resolved.coverage.flow, ...(resolved.coverage.branches ? { branches: resolved.coverage.branches } : {}) });
      }
      return { coverage: { ...checked, evidence: [...checked.evidence, ...additionalEvidence], upstream,
        originCoverage: { status: 'OBSERVED_CANDIDATES_REVIEWED', receiptId: receipt.id,
          indexFingerprint: receipt.indexFingerprint, queryFingerprint: receipt.queryFingerprint,
          scope: receipt.scope, indexScope: receipt.indexScope, candidateCount: receipt.candidates.length,
          guarantee: receipt.guarantee } } };
    };
    let siblings = await siblingDispatches(primary.entry, ctx);
    if (strictDispatch) {
      const source = dispatchSources.get(primary.entry.path);
      const discovered = source && discoverSiblingLiteralDispatches(source, primary.entry);
      if (!discovered || discovered.status !== 'READY') return { originIssue: `UPSTREAM_DISPATCH_${discovered?.reason ?? 'UNAVAILABLE'}` };
      siblings = discovered.siblings;
    }
    if (!siblings.length) return finishCoverage(coverage);
    const candidates = siblings.map(({ start, end }) => ({ path: path.relative(projectRoot, primary.entry.path), start, end }));
    if (flow.branches?.length !== siblings.length) return { siblingDispatches: candidates };
    const branches = new Map();
    for (const submission of flow.branches) {
      const entry = anchor(submission.entry), reason = submission.reason.trim();
      if (!entry || !reason || entry.path !== primary.entry.path || branches.has(entry.start)
        || !siblings.some(site => site.start === entry.start && site.end === entry.end)) return { siblingDispatches: candidates };
      const trace = submission.disposition === 'VERIFIED' ? resolveFlow(submission)
        : submission.consumer === undefined && submission.handoff === undefined ? { entry } : null;
      if (!trace) return { siblingDispatches: candidates };
      branches.set(entry.start, { disposition: submission.disposition, reason, ...trace });
    }
    return finishCoverage({ ...coverage, branches: siblings.map(site => branches.get(site.start)) });
  };
  let artifactCandidates = input.request.artifactCandidates ?? [];
  const processPointers = () => {
    const listed = []; let bytes = 2;
    for (const file of processFiles) {
      const size = Buffer.byteLength(JSON.stringify(file)) + (listed.length ? 1 : 0);
      if (listed.length === 20 || bytes + size > 8192) break;
      listed.push(file); bytes += size;
    }
    const complete = listed.length === processFiles.size;
    return { processFiles: listed, processFileCount: processFiles.size, processFilesComplete: complete,
      ...(!complete ? { processFilesContinuation: { tool: 'source_ls', arguments: { path: processRoot, offset: 0 },
        instruction: 'List this directory from offset 0 and follow source_ls nextOffset; directory order may differ from these pointers. Navigation grants no evidence.' } } : {}) };
  };
  const task = { id: `workspace-${randomUUID()}`, scope: 'workspace-stop', basisFiles,
    ...(referenceBasisFiles.length ? { referenceBasisFiles } : {}),
    ...(basisBudget ? { basisBudget } : {}),
    ...(originalSkillDocuments.length ? { originalSkillDocuments } : {}),
    conditionalReviewPolicy: CONDITIONAL_REVIEW_POLICY_VERSION,
    requirement: deviationOnly
      ? 'Review this Stop directly in the current workspace. Select its scope and submit only concrete deviations with original counterevidence.'
      : 'Review this Stop directly in the current workspace. Select its scope, plan the review and submit every assigned checklist item with original evidence.',
    workspace: projectRoot, processDirectory: processRoot,
    attributedExecutionFileCount: executionFiles.size,
    artifactCandidates: input.request.artifactCandidates ?? [], allowedStages: input.request.workflowStages ?? [],
    classificationContract: input.request.classificationContract,
    fixedStopClassification: input.request.fixedStopClassification ?? null };
  const withPendingNavigation = receipt => {
    try {
      if (Buffer.byteLength(JSON.stringify(receipt)) > 8192) return receipt;
      const pendingIds = []; let total = 0;
      const pending = id => {
        total++;
        if (pendingIds.length < 8 && typeof id === 'string' && id.length <= 2048
          && Buffer.byteLength(JSON.stringify(id)) <= 2048) pendingIds.push(id);
      };
      for (const object of selected) if (!rows.has(object.objectId)) pending(object.objectId);
      for (const target of qualityTargets) if (!files.has(target.path)) pending(`file:${target.path}`);
      if (total !== receipt.pending) return receipt;
      const navigation = { kind: 'workspace-stop-pending-v1', navigationOnly: true,
        taskId: input.taskId, reviewTaskId: task.id, groundTruthVersion: truth.version ?? null,
        classification: { ...classification }, pendingTotal: total, pendingIds, omittedCount: total - pendingIds.length,
        checklist: { tool: 'review_checklist', arguments: { offset: 0, limit: 20 }, followNextOffset: true } };
      for (;;) {
        navigation.omittedCount = total - pendingIds.length;
        if (Buffer.byteLength(JSON.stringify(navigation)) <= 2048) {
          const extended = { ...receipt, pendingNavigation: navigation };
          if (Buffer.byteLength(JSON.stringify(extended)) <= 8192) return extended;
        }
        if (!pendingIds.length) return receipt;
        pendingIds.pop();
      }
    } catch { return receipt; }
  };
  const sourceOnly = objects => objects.length > 0 && objects.every(object => {
    const owners = reviewProofOwners(object);
    return owners.length === 1 && owners[0] === 'SOURCE';
  });
  const processNavigation = (objects, includeProcessEvidence = false) => {
    const omitted = sourceOnly(objects) && !includeProcessEvidence;
    return { processDirectory: processRoot,
      ...(omitted ? { processFiles: [], processFileCount: processFiles.size, processFilesComplete: false } : processPointers()),
      attributedExecutionFileCount: executionFiles.size,
      programEvidenceFiles: omitted ? [] : programEvidenceFiles,
      ...(omitted ? { evidencePriority: 'CURRENT_SOURCE', processNavigationOmitted: true,
        navigationInstruction: 'Every assigned item currently requires SOURCE evidence. Read the named current production/delivery files next. The mandatory original basis already preserves original user inputs. Process records remain available through processDirectory or includeProcessEvidence:true on review_checklist when relevant; they cannot replace current-source proof.' } : {}) };
  };
  const processReadPlan = async () => {
    const plan = await planIndependentReads(projectRoot, [...processFiles].map(file => path.relative(projectRoot, file)),
      { maxBatchBytes: 32768, maxBatchFiles: 16, active: () => session.active() });
    const value = { navigationOnly: true, maxBatchBytes: plan.maxBatchBytes, maxBatchFiles: plan.maxBatchFiles,
      byteMeaning: 'Raw original file bytes only; each native read retains its own output cap, nextOffset pages and persisted receipt.',
      totalFiles: processFiles.size, batches: [], complete: false,
      recoverWith: { tool: 'source_ls', arguments: { path: path.relative(projectRoot, processRoot), offset: 0 } } };
    for (const batch of plan.batches) {
      value.batches.push(batch);
      if (Buffer.byteLength(JSON.stringify(value)) > 4096) { value.batches.pop(); return value; }
    }
    value.complete = true;
    return value;
  };
  Object.assign(task, processNavigation(allObjects));
  const stageProperties = task.allowedStages.length ? { stage: { type: ['string', 'null'],
    enum: [...task.allowedStages, null], description: 'Only STAGE_COMPLETE uses a stage. Otherwise omit this field.' } } : {};
  async function current() {
    session.active();
    for (const [file, hash] of protectedInputs) if (await fingerprint(file) !== hash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'An original review input changed');
    if (!await expectedFilesCurrent(expectedFileChecks))
      throw taskError('STOP_TASK_INPUT_CHANGED', 'A required output changed after its existence check');
    const state = await readJson(taskPath);
    if (state?.control?.cancelled || sha256(decisionGuard(state)) !== sha256(initialGuard))
      throw taskError('STOP_TASK_INPUT_CHANGED', 'The task or its input generation changed');
    if (persistedTruth && sha256(await fs.readFile(truthPath)) !== sha256(persistedTruth))
      throw taskError('STOP_TASK_INPUT_CHANGED', 'The authoritative baseline changed');
    for (const [file, hash] of skillDependencies) if (await fingerprint(file) !== hash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'The original Skill changed');
    for (const [requested, real] of skillReadPaths) if (await fs.realpath(requested) !== real)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'The original Skill path changed');
  }
  const receiptCitations = async (ctx, ids, owner, object, direct = []) => {
    const refs = await resolveStopCitations(ctx, { citeIds: ids ?? [], citations: direct }, projectRoot,
      { attachment: true, allowedFiles: [...originalSources.keys(), ...skillDependencies.keys()] });
    return refs.map(ref => {
      const sourceOwned = (isRegressionSourcePath(ref.path) || structuredSource.test(ref.path)) && reviewProofOwners(object).includes('SOURCE')
        && (!isTestEvidencePath(path.relative(projectRoot, ref.path)) || object?.programStanding === STANDING_REGRESSION || object?.metricId === 'M12'
          && object.verificationTarget === 'IMPLEMENTATION' && object.implementationRole === 'TEST');
      let proofOwner = processFiles.has(ref.path) ? 'PROCESS' : originalSources.has(ref.path) || inside(directory, ref.path) || inside(path.join(projectRoot, '.runtime-correction'), ref.path) ? 'BASIS'
        : sourceOwned ? 'SOURCE' : 'ARTIFACT';
      // Reviewer-created plans, notes, results and old RC reviews are readable
      // context, but cannot be promoted to original acceptance evidence.
      if (inside(directory, ref.path) && !inside(basisRoot, ref.path) && !processFiles.has(ref.path)) proofOwner = 'REVIEWER';
      const metadata = ctx.evidence.snapshot.get(ref.path);
      const fullFile = Boolean(metadata && covers(ctx.evidence.reads, ref.path, 1, metadata.lines));
      const originalRefs = (truth.claims ?? []).map(claim => String(claim.source?.ref ?? '').replace(/#.*$/u, ''));
      const activationFact = originalUserProcessFiles.includes(ref.path) || ['SOURCE', 'ARTIFACT'].includes(proofOwner)
        && !originalRefs.includes(ref.path) && ![...skillDependencies.keys()].includes(ref.path);
      return { path: ref.path, snapshotPath: ref.path, contentHash: ref.sha256,
        attachment: true, requestedPath: ref.requestedPath, exactQuote: ref.exactQuote,
        frozen: inside(basisRoot, ref.path) || processFiles.has(ref.path), start: ref.start, end: ref.end,
        selection: `${ref.path}#L${ref.start}-L${ref.end}`, usedBy: [owner],
        readProof: { version: 1, protocol: 'stop-citation-v2-mechanical', observed: false, basisComplete: false, owner: proofOwner, fullFile, activationFact,
          executionEvidence: executionFiles.has(ref.path) && (!executionCalls.has(ref.path) || executionCalls.get(ref.path).some(id =>
            invocationFiles.get(id)?.every(file => { const metadata = ctx.evidence.snapshot.get(file);
              return metadata && covers(ctx.evidence.reads, file, 1, metadata.lines); }))) }, citeId: ref.citeId };
    });
  };
  const tool = (name, description, parameters, submit) => ({ name, label: name, description, parameters, submit });
  const latestExecutionGroups = new Map();
  for (const [id, event] of historyEvents) {
    if (typeof id !== 'string' || !id || !event.toolName || event.ambiguous || resultsBeforeInvocation.has(id)
      || !(event.resultIndex > event.callIndex)) continue;
    const key = JSON.stringify([event.toolName, event.operation]);
    const previous = latestExecutionGroups.get(key);
    if (!previous || event.resultIndex > previous.resultIndex) latestExecutionGroups.set(key, event);
  }
  const relativeProcessFiles = index => entryPaths.get(index).map(file => path.relative(projectRoot, file));
  const recentExecutionPairs = boundedEntries([...latestExecutionGroups.values()].sort((a, b) => b.resultIndex - a.resultIndex)
    .map(({ toolName, operation, callIndex, resultIndex }) => ({ toolName, ...(operation ? { operation } : {}),
      invocationFiles: relativeProcessFiles(callIndex), resultFiles: relativeProcessFiles(resultIndex) })), 8, 3072 - 1);
  const processGuide = () => ({ navigationOnly: true,
    originalUserFiles: originalUserProcessFiles.slice(0, 3), originalUserFileCount: originalUserProcessFiles.length,
    executionResultFileCount: executionFiles.size,
    executionSamples: [...executionFiles].slice(0, 3).map(resultFile => {
      const calls = executionCalls.get(resultFile) ?? [], invocations = [...new Set(calls.flatMap(id => invocationFiles.get(id) ?? []))];
      return { resultFile, invocationFiles: invocations.slice(0, 3), invocationFileCount: invocations.length };
    }),
    ...(recentExecutionPairs.length ? { recentExecutionPairs } : {}),
    instruction: 'These are source_read pointers, not proof. Use originalUserFiles for original task inputs/applicability. Execution PASS/DEVIATION needs a matching invocation and result or actual program verification. No attributed result means UNVERIFIED for an applicable execution obligation. Samples are partial; source_ls can discover the remaining process files.'
      + (recentExecutionPairs.length ? ' recentExecutionPairs lists recent matched calls by tool and captured operation label, using project-relative paths. A listing implies no success or relevance.' : ''),
  });
  const evidenceHint = object => {
    const prefix = `Item ${object.objectId} requires ${reviewProofOwners(object).join('/')} evidence.`;
    if (requiresExecutionResult(object)) return `${prefix} Read an original invocation and matching result with source_read; source code and completion messages cannot prove execution. ${executionFiles.size === 0
      ? 'No attributable execution-result file is available in this review; use UNVERIFIED when execution is unproven.'
      : `Use review_checklist.processEvidence to locate results and invocations; ${executionFiles.size} result files are available, but must still match this obligation.`}`;
    if (reviewProofOwners(object).includes('PROCESS')) return `${prefix} For original task inputs/applicability, source_read ${originalUserProcessFiles[0] ?? processRoot}; Skill text and mandatory basis citations cannot replace the original process record.`;
    return `${prefix} Use source_read on the current original delivery or production source for this item; navigation, notes and mandatory basis are not delivery evidence.`;
  };
  await input.onPrepared?.({ requestDirectory: directory, requestPath: basisFiles[0], request: { ...input.request, task } });
  const classifiedRow = row => row ? classifiedProcessRow({ row, object: allObjects.find(object => object.objectId === row.objectId),
    historical: historicalOrders.has(row.objectId), repair: processRepairs.has(row.objectId) }) : null;
  const classifiedRows = () => [...rows.values()].map(classifiedRow);
  const processFindingObjects = finding => allObjects.filter(object => finding.violatedGroundTruthIds.includes(object.sourceId)
    && needsProcessClassification(object, { judgement: 'DEVIATION' }));
  const pendingProcessFinding = finding => processFindingObjects(finding).length && !processRepairs.has(finding.deviationKey);
  const unresolvedReview = () => summarizeStopUnverified({ requirements: selected, judgements: classifiedRows(),
    followUps: [...followUpResults.values()].map(classifiedRow), fileAssessments: [...files.values()], unresolvedPaths: unresolvedExpectedPaths,
    regressionCheck: regressionDisposition && { ...regressionDisposition, failureInventory }, requirementCheck });
  const projectResult = (ctx, summary) => ({ summary, ...classification, findings: structuredClone(findings.filter(finding => !pendingProcessFinding(finding))),
    metricObjectJudgements: classifiedRows().map(({ environmentUnexecutable, ...row }) => row), fileAssessments: [...files.values()],
    unverifiedItems: [...unresolvedReview().items, ...citationIssues.values(), ...findings.filter(pendingProcessFinding).map(finding => ({
      id: `finding:${finding.deviationKey}`, type: 'PROCESS_CLASSIFICATION', reason: 'The proposed process finding has no classified current repairable residue.' }))], citationDiagnostics: structuredClone(citationDiagnostics),
    ...(frameAbsent ? { frameCoverage: { status: 'absent', reason: frameAbsent } } : {}), ...(requirementCheck ? { requirementCheck } : {}),
    citations: structuredClone(citations), proofs: structuredClone(proofs),
    reviewEvidence: { citationAttachments: true, unstable: false, expectedFiles: structuredClone(expectedFileChecks), files: [...new Set([...ctx.evidence.snapshot.keys()].filter(currentFile).concat([...ctx.evidence.inventories.keys(), ...skillDependencies.keys(), ...protectedInputs.keys()]))], missing: [],
      readPaths: { ...Object.fromEntries([...ctx.evidence.resolutions].filter(([, real]) => currentFile(real))), ...Object.fromEntries(skillReadPaths) },
      fingerprints: { ...Object.fromEntries([...ctx.evidence.snapshot].filter(([file]) => currentFile(file)).map(([file, metadata]) => [file, metadata.sha256])),
        ...Object.fromEntries(ctx.evidence.inventories), ...Object.fromEntries(skillDependencies),
        ...Object.fromEntries(protectedInputs) } } });
  const dropAttachments = owner => {
    for (let i = citations.length - 1; i >= 0; i--) if (citations[i].usedBy?.includes(owner)) citations.splice(i, 1);
  };
  const downgradeCitation = async (ctx, key, draft, error) => {
    const reason = `Evidence attachment could not be verified: ${error.message}`;
    dropAttachments(draft.owner);
    const row = draft.object ? { objectId: draft.object.objectId, judgement: 'UNVERIFIED', reason, evidence: [], citationFailure: true }
      : draft.target ? { path: draft.target.path, status: 'UNVERIFIED', reason, evidence: [], citationFailure: true } : null;
    if (row) {
      if (draft.object) {
        if (followUps.has(draft.object.objectId)) followUpResults.set(draft.object.objectId, row);
        else rows.set(draft.object.objectId, row);
        validatedRows.delete(draft.object.objectId); delete proofs[draft.object.objectId];
      } else files.set(draft.target.path, row);
      await ctx.persist(`items/${sha256(key)}.json`, { itemId: key, result: row, citations: [], savedAt: Date.now() });
    } else {
      const index = findings.findIndex(f => f.deviationKey === draft.owner);
      if (index >= 0) findings.splice(index, 1);
      citationIssues.set(key, { id: key, type: 'CITATION', reason });
    }
    citationDrafts.delete(key);
    citationDiagnostics.downgradedItems++;
    citationDiagnostics.events.push({ itemId: key, action: 'DOWNGRADED', code: error.code, reason });
    ctx.state.receipts.push({ itemId: key, verdict: 'UNVERIFIED' });
    return { saved: true, itemId: key, downgraded: true, verdict: 'UNVERIFIED', reason };
  };
  const checkedAttachments = async (ctx, key, draft, value) => {
    try {
      const mapped = await receiptCitations(ctx, value.citeIds, draft.owner, draft.object, value.citations);
      if (!mapped.length) throw taskError('TASK_CITATION_INVALID', 'A deviation requires citations: [{path,start,end}].');
      const probeCitations = mapped.filter(citation => isRequirementEvidence(citation.path) || isRequirementEvidence(citation.requestedPath));
      if (probeCitations.length) {
        const object = draft.object;
        if (requirementCheck?.status !== 'FAIL' || !originalProductionItem(object)
          || !mapped.some(citation => citation.readProof.owner === 'SOURCE'))
          throw taskError('TASK_CITATION_INVALID', 'A failed public probe needs an original production checklist item and current source evidence to support a deviation.');
        for (const citation of probeCitations) {
          const support = requirementCaseEvidence.get(citation.path);
          if (!support || citation.start !== support.start || citation.end !== support.end
            || citation.contentHash !== protectedInputs.get(citation.path))
            throw taskError('TASK_CITATION_INVALID', 'Cite the exact failed-case receipt from failedCaseEvidence for probe support. An independent deviation may use its own current source citations and reason.');
          if (requireBoundProbeEvidence && (support.binding?.objectId !== object.objectId
            || support.binding.sourceRevisionId !== object.sourceRevisionId))
            throw taskError('TASK_CITATION_INVALID', 'This failed public case is not bound to this original checklist item. Use its bound item or cite independent current source evidence.');
          citation.requirementCheckId = support.id;
        }
      }
      if (citationDrafts.has(key)) { citationDiagnostics.correctedItems++; citationDiagnostics.events.push({ itemId: key, action: 'CORRECTED' }); }
      citationDrafts.delete(key);
      return mapped;
    } catch (error) {
      if (error.code !== 'TASK_CITATION_INVALID') throw error;
      if (citationDrafts.has(key)) return downgradeCitation(ctx, key, draft, error);
      citationDrafts.set(key, { ...draft, error });
      citationDiagnostics.rejectedSubmissions++;
      citationDiagnostics.events.push({ itemId: key, action: 'REPAIR_REQUESTED', code: error.code, reason: error.message });
      ctx.state.result = projectResult(ctx, 'A single evidence attachment needs correction.');
      await ctx.persist('citation-diagnostics.json', citationDiagnostics);
      throw taskError('TASK_CITATION_INVALID', `${key}: ${error.message} Correct this attachment once; otherwise only this deviation becomes UNVERIFIED.`);
    }
  };
  const setOriginalChecklist = async ({ items, scope }, ctx) => {
    ctx.requireBasis();
    if (reviewBasis) throw taskError('TASK_SUBMISSION_CONFLICT', 'The original requirements checklist is already set');
    // Reject an invalid scope before persisting an otherwise valid checklist.
    if (scope) requireAllowedScope(scopeFrame(scope));
    for (const [file, source] of originalSources) if (!source.optional && ctx.evidence.snapshot.get(file)?.sha256 !== source.readHash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'An original requirements source changed during preparation');
    const checklist = [], sourceBytes = new Map();
    for (const { citeId, path: sourcePath, lineStart, lineEnd, ...item } of items) {
      const [receipt] = await resolveStopCitations(ctx, sourcePath ? { citations: [{ path: sourcePath, start: lineStart, end: lineEnd }] }
        : { citeIds: [citeId] }, projectRoot, { allowedFiles: [...originalSources.keys()] });
      const original = originalSources.get(receipt.path);
      if (!original || receipt.sha256 !== original.readHash || lineStart < receipt.start || lineEnd > receipt.end || lineStart > lineEnd)
        throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', 'Select an allowed original source path and exact original line range');
      const { kind, ref, part, sha256: hash, lineOffset, byteOffset } = original;
      let originalSourceAnchor, bytes;
      if (kind === 'USER_MESSAGE' || item.expectedFiles?.length) {
        if (!sourceBytes.has(receipt.path)) {
          const current = await fs.readFile(receipt.path);
          if (sha256(current) !== receipt.sha256)
            throw taskError('STOP_TASK_INPUT_CHANGED', 'An original requirements source changed during checklist submission');
          sourceBytes.set(receipt.path, current);
        }
        bytes = sourceBytes.get(receipt.path);
      }
      if (kind === 'USER_MESSAGE') {
        try { originalSourceAnchor = createOriginalSourceAnchor({ ref, sha256: hash, bytes, start: lineStart, end: lineEnd, byteOffset }); }
        catch (error) { throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', error.message); }
      }
      if (item.expectedFiles?.length) {
        const originalText = excerpt(bytes, lineStart, lineEnd).text;
        try {
          item.expectedFiles = normalizeExpectedFiles(normalizeExpectedFiles(item.expectedFiles, originalText), item.text);
        } catch (error) {
          if (error.code !== 'GROUND_TRUTH_EXPECTED_FILES_INVALID') throw error;
          throw taskError(error.code, `Checklist item ${checklist.length + 1} (${item.metricId}): ${error.message} Correct this item's output declaration from its cited lines and preserve the other items.`);
        }
      }
      if (item.metricId === 'M16' && item.verificationTarget === 'IMPLEMENTATION' && !item.applicability && !item.expectedFiles?.length
        && (!item.implementationRole || item.implementationRole === 'PRODUCTION')
        && approvedItems.has(productionObligationKey(originalSourceAnchor, item.text))) continue;
      checklist.push({ ...item, ...(originalSourceAnchor ? { originalSourceAnchor } : {}), source: { kind, ref, ...(part ? { part } : {}), sha256: hash,
        start: lineStart + lineOffset, end: lineEnd + lineOffset } });
    }
    if (standingSource && ctx.evidence.snapshot.get(standingSource.file)?.sha256 !== standingSource.sha256)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'A program standing obligation changed during preparation');
    const build = items => buildOriginalStopPopulation({ population, checklist: items, sourceDigest: originalRequirements.digest,
      ...(standingSource ? { standing: [standingRegressionItem(standingSource)] } : {}) });
    checklist.unshift(...[...approvedItems.values()].map(({ item }) => item));
    let basis = build(checklist);
    const existing = new Set(Object.values(basis.population.metrics).flat().map(object => object.objectId));
    const carry = [...followUps.values()].map(entry => entry.object).filter(object => object.originalSource && !object.programStanding && !existing.has(object.objectId));
    const carried = new Set(carry.map(object => object.objectId));
    const seeds = proposedSeeds.filter(seed => !existing.has(seed.objectId) && !carried.has(seed.objectId)).map(seed => seed.item);
    if (carry.length || seeds.length) basis = build([...carry.map(object => ({
      metricId: object.metricId, text: object.description, source: object.originalSource, originalSourceAnchor: object.originalSourceAnchor,
      verificationTarget: object.verificationTarget, implementationRole: object.implementationRole, expectedFiles: object.expectedFiles,
      applicability: object.applicabilityKind === 'CONDITIONAL' ? object.applicability : undefined,
    })), ...seeds, ...checklist]);
    if (approvedInventory) {
      const bindings = new Map();
      for (const object of basis.population.metrics.M16) {
        if (object.implementationRole !== 'PRODUCTION' || object.applicabilityKind !== 'CURRENT_TASK' || object.expectedFiles?.length) continue;
        const approved = approvedItems.get(productionObligationKey(object.originalSourceAnchor, object.description));
        if (!approved) continue;
        object.approvedProposalAtomIds = [approved.id];
        bindings.set(approved.id, object.objectId);
      }
      if (bindings.size !== approvedAtomIds.size) throw invalidInventory();
      basis.approvedProposalInventory = { inventorySha256: approvedInventory.inventorySha256,
        requiredAtoms: [...approvedAtomIds].map(id => ({ id, objectId: bindings.get(id) })) };
      basis.population.digest = sha256({ population: basis.population.digest, approvedProposalInventory: basis.approvedProposalInventory });
    }
    await ctx.persist('original-checklist.json', basis);
    reviewBasis = basis; population = basis.population; truth = basis.groundTruth;
    allObjects = Object.values(population.metrics).flat();
    const approvedProposalCoverage = approvedProposalNavigation(allObjects);
    if (approvedProposalCoverage) await ctx.persist('approved-plan-navigation.json', approvedProposalCoverage);
    return scope ? readChecklist(scope, ctx) : { saved: true, items: allObjects.length, next: 'review_checklist' };
  };
  const scopeFrame = value => {
    validateStopClassification(value, { contract: task.classificationContract, allowedStages: task.allowedStages });
    return { stopClassification: value.stopClassification, stage: value.stopClassification === 'STAGE_COMPLETE' ? value.stage ?? null : null };
  };
  const requireAllowedScope = frame => {
    if (task.fixedStopClassification && (task.fixedStopClassification.stopClassification !== frame.stopClassification
      || (task.fixedStopClassification.stage ?? null) !== frame.stage)) throw taskError('STOP_STAGE_SCOPE_INVALID', 'The verification caller fixed this scope');
    if (frame.stopClassification === 'STAGE_COMPLETE' && task.allowedStages.length && !task.allowedStages.includes(frame.stage))
      throw taskError('STOP_STAGE_SCOPE_INVALID', 'Unknown workflow stage');
  };
  const selectScope = async (value, ctx, includeChecklistPage = false) => {
    ctx.requireBasis();
    if (originalRequirements && !reviewBasis) throw taskError('STOP_ORIGINAL_CHECKLIST_REQUIRED', 'Use set_original_checklist before selecting the scope');
    const frame = scopeFrame(value);
    if (classification) {
      if (sha256(classification) !== sha256(frame)) throw taskError('TASK_SUBMISSION_CONFLICT', 'The Stop scope is already fixed');
      return { ...classification, reused: true, items: selected.length, files: qualityTargets.length,
        ...processNavigation(selected, value.includeProcessEvidence), next: 'review_checklist' };
    }
    requireAllowedScope(frame);
    const objects = Object.values(selectStopPopulation(population, frame, input.request.workflowArtifacts).metrics).flat();
    if (input.deferScopeVerification && input.onScope) {
      ctx.deferCompletion(async continued => {
        await prepareScope(value, frame, objects, continued);
        let page;
        if (includeChecklistPage) {
          try {
            const encoded = JSON.stringify(await checklistPage(value));
            if (Buffer.byteLength(encoded) <= MAX_RESUMED_CHECKLIST_BYTES) page = encoded;
          } catch { continued.active(); }
        }
        return scopeContinuation(page);
      });
      return { deferred: true, scopeSelected: false, next: 'review_checklist',
        reason: 'Program-owned verification will run after this native call settles, then this same review resumes.' };
    }
    return prepareScope(value, frame, objects, ctx);
  };

  async function readChecklist(value, ctx) {
    if (value.stopClassification) {
      const scope = await selectScope({ ...value, summary: value.summary ?? 'Selected scope from original Stop evidence.' }, ctx, true);
      if (scope.deferred) return scope;
    }
    return checklistPage(value);
  }

  async function checklistPage(value) {
    if (!classification) return { next: originalRequirements && !reviewBasis ? 'set_original_checklist' : 'review_scope', scopeSelected: false };
    const offset = value.offset ?? 0, limit = value.limit ?? 5;
    const ordered = [...selected.filter(object => followUps.has(object.objectId)), ...selected.filter(object => !followUps.has(object.objectId))];
    const checklist = [...ordered.map(object => ({ ...object, taskId: object.objectId, proofOwners: reviewProofOwners(object),
      ...(requiredProduction.has(object.objectId) ? { requiresProductionCoverage: true,
        ...(requireOriginCoverage ? { requiresProductionOriginCoverage: true } : {}) } : {}),
      ...(object.metricId === 'M12' ? { evidenceScope: reviewProofScope(object) } : {}),
      ...(requiresExecutionResult(object) ? { executionProof: { forVerdicts: deviationOnly ? ['DEVIATION'] : ['PASS', 'DEVIATION'], availableResultFileCount: executionFiles.size } } : {}),
      ...(object.programStanding === STANDING_REGRESSION && regression ? { regressionEvidence: {
        ...regressionNavigation({ evidence: regression, files: regressionFiles, run: regressionRun, runFiles: regressionRunFiles, failureInventory }),
        ...semanticNavigation,
      } } : {}),
      ...(followUps.has(object.objectId) ? { previousDeviation: followUps.get(object.objectId).previousDeviation } : {}),
      ...(proposedIds.has(object.objectId) ? { proposedCheck: proposedIds.get(object.objectId) } : {}),
      savedResult: classifiedRow(rows.get(object.objectId) ?? followUpResults.get(object.objectId)) })),
      ...qualityTargets.map(file => ({ taskId: `file:${file.path}`, ...file, kind: 'FILE_QUALITY', savedResult: files.get(file.path) ?? null }))];
    const items = [];
    for (const item of checklist.slice(offset, offset + limit)) items.push({ ...item,
      ...(item.metricId === 'M08' ? { originalSkillBasis: await skillBasis(item) } : {}) });
    const approvedProposalCoverage = approvedProposalNavigation(items);
    const navigation = processNavigation(selected, value.includeProcessEvidence);
    return { classification, items, total: checklist.length, artifactCandidates, ...navigation,
      ...(approvedProposalCoverage ? { approvedProposalCoverage } : {}),
      ...(requirementCheck ? { requirementCheck: { ...requirementCheck, evidenceFiles: requirementCheckFiles,
        ...requirementCaseNavigation(8, 2048),
        instruction: 'This pinned public probe checks requested behavior independently of existing tests. For a probe-backed DEVIATION, cite the exact failed case from failedCaseEvidence and current source that contradicts the applicable original production obligation. The aggregate receipt is for navigation. If more cases are available, list the continuation directory and read the remaining case receipts on line 1. An incomplete probe supplies no counterexample. Use the separate regression rules for existing-test findings.' } } : {}),
      ...(navigation.processNavigationOmitted ? {} : { processEvidence: processGuide(), processReadPlan: await processReadPlan() }), expectedFileChecks,
      ...(!deviationOnly ? { pending: selected.length + qualityTargets.length - rows.size - files.size } : {}),
      nextOffset: offset + limit < checklist.length ? offset + limit : null };
  }

  function scopeContinuation(page) {
    const intro = 'Program-owned scope verification has completed outside the native tool call. The original scope, read receipts and review budget are retained.';
    const checklist = page
      ? ['Current checklist page (JSON data):', page,
        'Use this prepared checklist page directly. Read any necessary original evidence with the normal tools. If nextOffset is a number, call review_checklist with that offset and without classification fields. Do not recreate the checklist.']
      : ['Use review_checklist without classification fields to inspect the complete results and remaining checklist. Do not recreate it.'];
    if (!requirementCheck && !regressionRun) return [intro, ...checklist].join('\n');
    const summary = { navigationOnly: true };
    if (requirementCheck) {
      const checks = requirementCheck.checks.map(({ id, status }) => ({ id, status }));
      const ordered = [...checks.filter(check => check.status === 'FAIL'), ...checks.filter(check => check.status !== 'FAIL')];
      const production = requirementCheck.status === 'FAIL' ? selected.filter(originalProductionItem) : [];
      summary.requirementCheck = { status: requirementCheck.status, sha256: requirementCheck.sha256,
        checkCount: checks.length, checks: boundedEntries(ordered, 6, 576), evidenceFileCount: requirementCheckFiles.length,
        evidenceFiles: boundedEntries(requirementCheckFiles, 2, 576),
        ...requirementCaseNavigation(3, 768),
        ...(production.length ? { productionItemCount: production.length, productionItems: boundedEntries(production.map(object => ({
          objectId: object.objectId, description: object.description.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 160),
          originalSource: { ref: object.originalSource.ref, start: object.originalSource.start, end: object.originalSource.end },
        })), 4, 900) } : {}) };
    }
    if (regressionRun) summary.regressionCheck = { status: regressionRun.status,
      ...(failureInventory ? { failureInventoryComplete: failureInventory.complete, failureCount: failureInventory.failures.length } : {}),
      evidenceFileCount: regressionRunFiles.length, evidenceFiles: boundedEntries(regressionRunFiles, 2, 576) };
    return [intro, 'Program check navigation (JSON data):', JSON.stringify(summary),
      'A failed pinned requirement can guide inspection of the original production obligation and current source. Cite the exact failed-case receipt in failedCaseEvidence and relevant source for any deviation based on the check. The aggregate is for navigation. An incomplete check supplies no counterexample.',
      ...(requireBoundProbeEvidence ? ['A failed case may support only the original checklist item named in its binding. Use current production evidence to confirm the specific contradiction. A null binding supplies navigation only.'] : []),
      'Review existing-test failures separately under the original authorization rules.',
      ...checklist].join('\n');
  }

  async function prepareScope(value, frame, objects, ctx) {
    ctx.active();
    let verification = await input.onScope?.(frame, ...(reviewBasis ? [reviewBasis] : []));
    ctx.active();
    if (verification?.regressionCheck) {
      const { regressionCheck: run, ...rest } = verification;
      verification = rest;
      if (run.baselineFile && run.baselineSha256) protectedInputs.set(await fs.realpath(run.baselineFile), run.baselineSha256);
      if (run.requirementCheck) {
        requirementCheck = run.requirementCheck;
        requirementCheckFiles = await parts(basisRoot, 'public-requirement-check', requirementCheck);
        for (const file of requirementCheckFiles) protectedInputs.set(file, sha256(await fs.readFile(file)));
        for (const [index, check] of requirementCheck.checks.entries()) {
          if (requirementCheck.status !== 'FAIL' || check.status !== 'FAIL') continue;
          ctx.active();
          const file = path.join(basisRoot, `public-requirement-case-${String(index).padStart(4, '0')}.txt`);
          const binding = requireBoundProbeEvidence ? { binding: await requirementBinding(check.id, objects) } : {};
          ctx.active();
          const bytes = JSON.stringify({ sha256: requirementCheck.sha256, workspaceDigest: requirementCheck.workspaceDigest,
            id: check.id, status: check.status, ...binding }) + '\n';
          await fs.writeFile(file, bytes, { flag: 'wx' });
          protectedInputs.set(file, sha256(bytes));
          requirementCaseEvidence.set(file, { id: check.id, path: file, start: 1, end: 1, ...binding });
        }
      }
      if (run.regressionApplicable !== false) {
        regressionRun = run;
        regressionRunFiles = await parts(basisRoot, 'regression-check', renderRegressionRun(run), false, false, true);
      }
      if (regressionRun?.status === 'FAILED') {
        failureInventory = regressionFailureInventory(run);
        if (failureInventory.complete) {
          const start = await readJson(taskStartManifestPath(projectRoot, input.taskId)).catch(() => null);
          const tests = await collectRegressionFailureTests({ projectRoot, start, failures: failureInventory.failures, signal: session.signal });
          for (const [index, failure] of failureInventory.failures.entries()) {
            const test = tests.get(failure.id);
            if (!test) continue;
            const { body, ...location } = test;
            const [file] = await parts(basisRoot, `regression-case-${index}`, body, false, false, true);
            failure.originalTest = { ...location, file, sha256: sha256(body) };
          }
        }
      }
    }
    artifactCandidates = verification?.artifactCandidates ?? artifactCandidates;
    const targets = input.request.fileQualityReviewEnabled && ['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(frame.stopClassification)
      ? artifactCandidates.filter(binding => frame.stopClassification !== 'STAGE_COMPLETE' || binding.stage === frame.stage
        || (input.request.workflowArtifacts ?? []).some(artifact => artifact.stage === frame.stage && (artifact.nodeId ?? artifact.name ?? artifact.type) === binding.artifactId))
        .flatMap(binding => binding.files ?? []) : [];
    await ctx.persist('scope.json', { ...frame, completionClaim: value.completionClaim,
      requiredUserInput: value.requiredUserInput ?? null, externalBlocker: value.externalBlocker ?? null,
      objectIds: objects.map(object => object.objectId), qualityTargets: targets });
    classification = frame; selected = objects;
    if (useProductionCoverage && frame.stopClassification === 'TASK_COMPLETE') for (const object of objects) {
      // An M16 implementation without an explicit role is also production.
      if ((!requireProductionCoverage && !object.approvedProposalAtomIds?.length)
        || object.metricId !== 'M16' || !object.hard || object.applicabilityKind !== 'CURRENT_TASK'
        || object.programStanding || object.verificationTarget !== 'IMPLEMENTATION' || !object.originalSource
        || !mandatoryOriginal(object.originalSource)) continue;
      requiredProduction.set(object.objectId, object);
    }
    if (frame.stopClassification === 'TASK_COMPLETE'
      && reviewBasis?.approvedProposalInventory?.requiredAtoms.some(({ objectId }) => !requiredProduction.has(objectId)))
      throw invalidInventory();
    qualityTargets = [...new Map(targets.map(file => [file.path, file])).values()];
    programEvidenceFiles = verification ? await parts(processRoot, 'program-verification-on-scope', verification, false, programExecution(verification)) : [];
    // A task-completion claim makes unconditional named deliveries due. Do
    // not guess which final outputs are due at an intermediate stage/Stop.
    if (frame.stopClassification === 'TASK_COMPLETE') for (const object of selected) {
      const claim = truth.claims.find(claim => claim.claimId === object.sourceId && claim.revisionId === object.sourceRevisionId);
      if (!['M12', 'M16'].includes(object.metricId) || !object.hard || object.applicabilityKind !== 'CURRENT_TASK'
        || !claim || claim.status !== 'ACTIVE' || claim.severity !== 'HARD' || claim.applicabilityKind !== 'CURRENT_TASK'
        || !['USER_EXPLICIT', 'MATERIAL_DERIVED', 'PROJECT_CONSTRAINT'].includes(claim.authority)) continue;
      const declared = normalizeExpectedFiles(claim.expectedFiles ?? [], claim.text);
      if (sha256(declared) !== sha256(object.expectedFiles ?? []))
        throw taskError('STOP_TASK_INPUT_CHANGED', 'Expected outputs do not match their authoritative obligation');
      const checks = [], unresolved = [];
      const context = declared.length ? await expectedSourceContext(claim) : '';
      for (const requiredPath of declared) {
        const binding = resolveExpectedFilePath(requiredPath, context);
        if (binding.status === 'UNVERIFIED') { unresolved.push({ requiredPath, ...binding }); continue; }
        const observation = await observeExpectedFile(projectRoot, binding.path);
        checks.push({ ...observation, requiredPath, binding, claimId: claim.claimId, revisionId: claim.revisionId });
      }
      const absent = checks.filter(check => ['MISSING', 'NOT_FILE'].includes(check.status));
      // Persist the filesystem observations as program evidence. No source
      // read of a nonexistent file, fabricated quotation, or execution log is
      // needed to establish this narrow counterexample.
      const itemCitations = [];
      for (const check of absent) {
        const name = `expected-files/${sha256([object.objectId, check.requiredPath])}.json`;
        await ctx.persist(name, { kind: 'expected-file-v1', objectId: object.objectId, ...check });
        const receiptPath = path.join(directory, name), bytes = await fs.readFile(receiptPath);
        itemCitations.push({ path: receiptPath, snapshotPath: receiptPath, frozen: true, contentHash: sha256(bytes), start: 1, end: 1,
          selection: `${receiptPath}#L1-L1`, usedBy: [object.objectId],
          readProof: { version: 1, protocol: 'expected-file-v1', observed: true, basisComplete: true, owner: 'EXPECTED_FILE',
            claimId: claim.claimId, revisionId: claim.revisionId, requiredPath: check.requiredPath, status: check.status } });
      }
      expectedFileChecks.push(...checks);
      if (absent.length || unresolved.length) {
        if (unresolved.length) unresolvedExpectedPaths.push({ objectId: object.objectId, paths: unresolved });
        const row = { objectId: object.objectId, judgement: absent.length ? 'DEVIATION' : 'UNVERIFIED',
          reason: absent.length
            ? `任务已声明完成，但明确要求交付的文件尚未生成或不是普通文件：${absent.map(check => check.requiredPath).join('、')}。请按原始要求补齐文件。`
            : `原始义务未唯一确定交付文件的位置，无法判定其缺失：${unresolved.map(check => check.requiredPath).join('、')}。`,
          evidence: itemCitations.map(citation => citation.selection) };
        validateReviewJudgement({ row, object, citations: itemCitations, classification });
        await ctx.persist(`items/${sha256(object.objectId)}.json`, { itemId: object.objectId, result: row, citations: itemCitations, savedAt: Date.now() });
        rows.set(object.objectId, row); citations.push(...itemCitations);
        ctx.state.receipts.push({ itemId: object.objectId, verdict: row.judgement, origin: 'expected-file-check' });
      }
    }
    if (expectedFileChecks.length) await ctx.persist('expected-files.json', { checks: expectedFileChecks });
    if (unresolvedExpectedPaths.length) await ctx.persist('unresolved-expected-paths.json', unresolvedExpectedPaths);
    await ctx.check();
    ctx.state.result = projectResult(ctx, 'Workspace review is in progress.');
    return { ...classification, items: selected.length, files: qualityTargets.length,
      ...processNavigation(selected, value.includeProcessEvidence), artifactCandidates, next: 'review_checklist' };
  }

  const completeReview = async (ctx, summary, frameCoverage, uncovered) => {
    const revalidateOrigins = async () => {
      let changed = false;
      if (requireOriginCoverage) for (const [objectId, coverage] of productionCoverage) {
        const origin = await originCoverage.lookup(coverage.originCoverage?.receiptId, { objectId, entry: coverage.flow.entry });
        if (origin.status === 'READY') continue;
        changed = true; discardStaleOrigin(objectId, origin.reason);
        const pending = uncovered.find(item => item.objectId === objectId);
        if (pending) pending.originIssue = origin.reason;
        else uncovered.push({ objectId, description: requiredProduction.get(objectId)?.description, originIssue: origin.reason });
      }
      return changed;
    };
    await revalidateOrigins();
    for (const { evidence } of productionCoverage.values()) for (const { path: file } of evidence) productionCoverageFiles.add(file);
    const result = projectResult(ctx, summary);
    if (classification.stopClassification === 'TASK_COMPLETE' && reviewBasis?.approvedProposalInventory)
      result.approvedProposalInventory = reviewBasis.approvedProposalInventory;
    if (frameCoverage) result.frameCoverage = frameCoverage;
    if(historicalOrders.size)await ctx.persist('historical-orders.json',[...historicalOrders.values()]);
    if(processRepairs.size)await ctx.persist('process-repairs.json',[...processRepairs.values()]);
    if (environmentExceptions.size) await ctx.persist('environment-unexecutable.json', [...environmentExceptions.values()]);
    result.unverifiedItems.push(...(frameCoverage?.items ?? []).filter(item => item.disposition === 'UNVERIFIED')
      .map(({ id, type, reason }) => ({ id, type, reason })));
    const missingCoverage = new Set(uncovered.map(({ objectId }) => objectId));
    const missingOrigins = new Map(uncovered.filter(item => item.originIssue).map(item => [item.objectId, item.originIssue]));
    for (const objectId of missingCoverage) if (!result.unverifiedItems.some(item => item.type === 'REQUIREMENT' && item.objectId === objectId))
      result.unverifiedItems.push({ id: objectId, objectId, type: 'REQUIREMENT',
        reason: missingOrigins.has(objectId) ? `Production origin coverage remains unverified: ${missingOrigins.get(objectId)}.`
          : 'The current production source was not checked against the full original obligation.' });
    result.regressionCheck = { cases: [...regressionDisposition?.cases ?? [],
      ...regressionRun?.triage?.cases.filter(item => item.type === 'PRE_EXISTING_FAILURE')
        .map(({ id, type, reason }) => ({ id, verdict: type, reason })) ?? []],
      triage: regressionRun?.triage?.cases.map(({ id, type, reason, isolationObserved }) =>
        ({ id, type, reason, ...(isolationObserved ? { isolationObserved } : {}) })) ?? [] };
    result.reviewCoverage = stopReviewCoverage({ requirements: selected, judgements: classifiedRows(),
      followUps: [...followUpResults.values()].map(classifiedRow), fileAssessments: [...files.values()], regressionCases: result.regressionCheck.cases,
      frameItems: frameCoverage?.items, unverifiedItems: result.unverifiedItems });
    for (const item of result.reviewCoverage.items) {
      const coverage = productionCoverage.get(item.id);
      if (coverage && !item.unverified) {
        const relative = ({ path: file, ...ref }) => ({ path: path.relative(projectRoot, file), ...ref });
        const relativeFlow = flow => Object.fromEntries(Object.entries(flow).map(([role, span]) => [role, relative(span)]));
        Object.assign(item, { disposition: 'SOURCE_REVIEWED', reason: coverage.reason, evidence: coverage.evidence.map(relative),
          flow: relativeFlow(coverage.flow), ...(coverage.branches ? { branches: coverage.branches.map(({ disposition, reason, ...flow }) =>
            ({ disposition, reason, ...relativeFlow(flow) })) } : {}),
          ...(coverage.originCoverage ? { originCoverage: coverage.originCoverage,
            upstream: coverage.upstream.map(({ entry, flow, branches, ...proof }) => ({ ...proof,
              ...(entry ? { entry: relative(entry) } : {}), ...(flow ? { flow: relativeFlow(flow) } : {}),
              ...(branches ? { branches: branches.map(({ disposition, reason, ...branchFlow }) =>
                ({ disposition, reason, ...relativeFlow(branchFlow) })) } : {}) })) } : {}) });
      }
      if (missingCoverage.has(item.id)) Object.assign(item, { disposition: 'UNVERIFIED',
        reason: result.unverifiedItems.find(entry => entry.type === 'REQUIREMENT' && entry.objectId === item.id).reason,
        ...(missingOrigins.has(item.id) ? { originCoverage: { status: 'UNVERIFIED', reason: missingOrigins.get(item.id) } } : {}) });
    }
    // Publication may follow asynchronous program bookkeeping. Never publish
    // a retained positive receipt after the observed source index changed.
    if (await revalidateOrigins()) return completeReview(ctx, summary, frameCoverage, uncovered);
    await ctx.persist('review.json', result);
    ctx.state.result = result;
    ctx.state.complete = true;
    return { saved: true, complete: true, items: rows.size, files: files.size, findings: findings.length };
  };
  const saveRegressionDisposition = async (ctx, disposition, mapped) => {
    await ctx.persist('regression-check-review.json', { ...disposition, failureInventory, citations: mapped });
    regressionDisposition = structuredClone(disposition);
  };
  const regressionDispositionRequired = () => selected.some(object => object.programStanding === STANDING_REGRESSION)
    && ['FAILED', 'UNAVAILABLE'].includes(regressionRun?.status) && (!failureInventory?.complete || failureInventory.failures.length > 0);
  const canFinishSourceDeviation = (object, row, attachments) => classification?.stopClassification === 'TASK_COMPLETE'
    && row.judgement === 'DEVIATION' && object?.metricId === 'M16' && object.hard
    && object.applicabilityKind === 'CURRENT_TASK' && originalProductionItem(object) && mandatoryOriginal(object.originalSource)
    && attachments.some(ref => ref.readProof.owner === 'SOURCE' && inside(projectRoot, ref.path) && !programOwned(ref.path) && !originalEvidence(ref.path))
    && !dispositionFrame && !followUps.size && !citationDrafts.size && !citationIssues.size
    && qualityTargets.length === files.size && !regressionDispositionRequired()
    && !selected.some(item => needsProcessClassification(item, rows.get(item.objectId))) && !findings.some(pendingProcessFinding);
  const finishReview = async (value, ctx) => {
    ctx.requireBasis();
    for (const [key, draft] of [...citationDrafts]) await downgradeCitation(ctx, key, draft, draft.error);
    const stale = [];
    for (const owner of new Set(citations.filter(c => c.attachment).flatMap(c => c.usedBy))) {
      if ((await Promise.all(citations.filter(c => c.usedBy.includes(owner)).map(stopAttachmentCurrent))).every(Boolean)) continue;
      const object = selected.find(o => o.objectId === owner), target = qualityTargets.find(f => f.path === owner);
      const key = object?.objectId ?? (target ? `file:${target.path}` : `finding:${owner}`);
      const error = taskError('TASK_CITATION_INVALID', 'The cited file changed before publication.');
      citationDrafts.set(key, { owner, object, target, error });
      dropAttachments(owner); rows.delete(owner); files.delete(owner); followUpResults.delete(owner);
      const index = findings.findIndex(f => f.deviationKey === owner); if (index >= 0) findings.splice(index, 1);
      citationDiagnostics.rejectedSubmissions++; citationDiagnostics.events.push({ itemId: key, action: 'REPAIR_REQUESTED', code: error.code, reason: error.message });
      stale.push(key);
    }
    if (stale.length) throw taskError('TASK_CITATION_INVALID', `Correct these stale attachments once, or finish to record only them as UNVERIFIED: ${stale.join(', ')}`);
    if (!classification || !deviationOnly && (selected.length !== rows.size || qualityTargets.length !== files.size))
      throw taskError('REVIEW_ITEM_INCOMPLETE', 'The original checklist is incomplete; use review_checklist');
    const pending = selected.filter(object => followUps.has(object.objectId) && !rows.has(object.objectId) && !followUpResults.has(object.objectId));
    if (pending.length) throw taskError('REVIEW_ITEM_INCOMPLETE', `Review each previously delivered deviation: ${pending.map(object => object.objectId).join(', ')}`);
    if (deviationOnly && !offeredBoundFailureReview && requirementCaseEvidence.size) {
      const reportedSources = new Set(findings.flatMap(finding => finding.violatedGroundTruthIds));
      const unreviewed = [...requirementCaseEvidence.values()].filter(({ binding }) => {
        if (!binding || rows.has(binding.objectId) || followUpResults.has(binding.objectId)) return false;
        const object = selected.find(item => item.objectId === binding.objectId && item.sourceRevisionId === binding.sourceRevisionId);
        return object && !reportedSources.has(object.sourceId);
      });
      if (unreviewed.length) {
        offeredBoundFailureReview = true;
        return { saved: false, complete: false, navigationOnly: true, next: 'review_checklist',
          pendingBoundFailureCount: unreviewed.length, pendingBoundFailures: boundedEntries(unreviewed, 3, 1200),
          instruction: 'A public check failed for a specific original checklist item without a saved assessment. Inspect the bound item and current production source. Submit a deviation only with both the exact failed-case receipt and current counterevidence. Record UNVERIFIED if evidence remains insufficient, then finish with any applicable dispositions.' };
      }
    }
    for(const proposal of value.historicalOrders??[]) {
      const object=selected.find(x=>x.objectId===proposal.objectId);
      const proof=historicalOrderProof({proposal,object,row:rows.get(proposal.objectId),events:historyEvents});
      const prior=historicalOrders.get(proposal.objectId);
      if(prior&&prior.factDigest!==proof.factDigest)throw taskError('HISTORICAL_ORDER_CONFLICT','One obligation has conflicting historical event bindings.');
      historicalOrders.set(proposal.objectId,proof);
    }
    for (const proposal of value.processRepairs ?? []) {
      const object = selected.find(object => object.objectId === proposal.objectId);
      const finding = findings.find(finding => finding.deviationKey === proposal.objectId);
      const owner = object ?? (finding && processFindingObjects(finding)[0]);
      const row = object ? rows.get(object.objectId) : finding && { judgement: 'DEVIATION' };
      if (historicalOrders.has(proposal.objectId)) throw taskError('PROCESS_CLASSIFICATION_CONFLICT', 'A historical-only deviation cannot also request a current repair.');
      const proof = processRepairProof({ proposal, object: owner, row, owner: proposal.objectId });
      processRepairs.set(proposal.objectId, proof);
    }
    const frameDiagnostic = {};
    const frameDispositions = structuredClone(value.frameDispositions);
    if (dispositionFrame && Array.isArray(frameDispositions)) for (const entry of frameDispositions) {
      delete entry.citeIds; delete entry.citations;
      if (entry.disposition === 'DEVIATION' && (rows.get(entry.objectId)?.judgement === 'DEVIATION'
        && classifiedRow(rows.get(entry.objectId))?.judgement === 'UNVERIFIED'
        || findings.some(finding => finding.deviationKey === entry.objectId && pendingProcessFinding(finding))))
        Object.assign(entry, { disposition: 'UNVERIFIED', reason: 'The associated process deviation has no classified repairable residue or historical proof.' });
      if (entry.disposition === 'DEVIATION' && (rows.get(entry.objectId)?.citationFailure || citationIssues.has(`finding:${entry.objectId}`)))
        Object.assign(entry, { disposition: 'UNVERIFIED', reason: 'The associated deviation has no valid evidence attachment.' });
    }
    const frameCoverage = dispositionFrame && countFrameDispositions(dispositionFrame, frameDispositions, () => [],
      id => classifiedRow(rows.get(id))?.judgement === 'DEVIATION' || findings.some(finding => finding.deviationKey === id && !pendingProcessFinding(finding)), frameDiagnostic);
    if (dispositionFrame && !frameCoverage)
      throw taskError('REVIEW_FRAME_DISPOSITION_REQUIRED',
        `Give every frame item exactly one disposition with a saved deviation or textual reason. ${frameDiagnostic.reason}`);
    if (value.environmentCommands?.length) {
      const policy = await input.effectiveToolPolicy?.();
      for (const { objectId, command } of value.environmentCommands) {
        const object = selected.find(item => item.objectId === objectId), row = rows.get(objectId);
        const source = object?.originalSource;
        const binding = source && [...originalSources].find(([, original]) => original.kind === source.kind
          && original.ref === source.ref && original.sha256 === source.sha256);
        let originalText;
        if (binding && Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end)) {
          const [file, original] = binding, offset = original.lineOffset ?? 0;
          originalText = (await fs.readFile(file, 'utf8')).split(/\r?\n/u).slice(source.start - 1 - offset, source.end - offset).join('\n');
        }
        const proof = proveCommandUnavailable({ object, row, command, originalText, policy });
        if (!proof) continue; // Unknown/capable policies keep the original UNVERIFIED item.
        environmentExceptions.set(objectId, proof);
        rows.set(objectId, { ...row, environmentUnexecutable: proof });
      }
    }
    const proposedCoverage = new Map();
    for (const proposal of value.productionCoverage ?? []) if (requiredProduction.has(proposal.objectId))
      proposedCoverage.set(proposal.objectId, proposedCoverage.has(proposal.objectId) ? null : proposal);
    const uncovered = [], pendingCoverage = [];
    for (const [id, object] of requiredProduction) {
      const row = classifiedRow(rows.get(id) ?? followUpResults.get(id));
      if (row?.judgement === 'DEVIATION' || row?.judgement === 'UNVERIFIED') productionCoverage.delete(id);
      if (row?.judgement === 'DEVIATION') continue;
      let observed;
      const retained = productionCoverage.get(id);
      if (requireOriginCoverage && retained?.originCoverage) {
        const origin = await originCoverage.lookup(retained.originCoverage.receiptId, { objectId: id, entry: retained.flow.entry });
        if (origin.status !== 'READY') {
          discardStaleOrigin(id, origin.reason);
          observed = { originIssue: origin.reason };
        }
      }
      if (!row && proposedCoverage.has(id)) {
        const proposal = proposedCoverage.get(id);
        observed = proposal && await coverageEvidence(ctx, proposal);
        if (observed?.coverage) productionCoverage.set(id, observed.coverage);
        else productionCoverage.delete(id);
      }
      if (productionCoverage.has(id)) continue;
      const item = { objectId: id, ...(observed?.siblingDispatches ? { siblingDispatches: observed.siblingDispatches } : {}),
        ...(observed?.originIssue ? { originIssue: observed.originIssue } : {}), description: object.description };
      uncovered.push(item);
      if (!row) pendingCoverage.push(item);
    }
    if (!offeredCoverageReview && pendingCoverage.length
      && !classifiedRows().some(row => row.judgement === 'DEVIATION' && !historicalOrders.has(row.objectId))
      && !findings.some(finding => !pendingProcessFinding(finding)) && ![...files.values()].some(file => file.status === 'DEVIATION')) {
      offeredCoverageReview = true;
      return { saved: false, complete: false, navigationOnly: true,
        pendingProductionCoverageCount: pendingCoverage.length, pendingProductionCoverage: boundedEntries(pendingCoverage, 5, 1400),
        instruction: `A passing check covers the cases it ran. ${productionEntryGuidance} In productionCoverage anchor flow.entry and flow.consumer to acknowledged source ranges and include flow.handoff when a distinct boundary transfers the value. For listed siblingDispatches, read each exact dispatch range and add flow.branches with its production evidence or source-based OUT_OF_SCOPE reason. Submit an evidenced deviation or leave the item unverified if the applicable flow cannot be established. Accepted coverage is retained.` };
    }
    if (regressionDispositionRequired()) {
      const standing = selected.find(object => object.programStanding === STANDING_REGRESSION);
      const disposition = value.regressionCheck ?? { status: 'UNVERIFIED',
        reason: regressionRun.status === 'UNAVAILABLE' ? `Regression check unavailable: ${regressionRun.reason ?? 'unknown'}`
          : 'The reviewer did not decide the remaining original test failures.' };
      const mapped = [];
      let reviewed = reviewedRegressionFailures({ inventory: failureInventory, disposition,
        hasDeviation: id => rows.get(id ?? standing.objectId)?.judgement === 'DEVIATION'
          || findings.some(finding => finding.deviationKey === id) });
      if(input.onRegressionDisposition)reviewed=await input.onRegressionDisposition({reviewed,inventory:failureInventory,run:regressionRun});
      ctx.active();
      await saveRegressionDisposition(ctx, { ...disposition, ...reviewed }, mapped);
    }
    return completeReview(ctx, value.summary, frameCoverage, uncovered);
  };

  const graphBudgetMs = Math.min(1500, Math.floor(((session.deadlineAt ?? Infinity) - Date.now()) / 10));
  const graph = graphBudgetMs >= 100 ? await buildSemanticGraph(projectRoot, {
    budgetMs: graphBudgetMs, signal: session.signal, excludedPaths: excluded,
    preferredPaths: input.request.taskChanges?.changes?.map(change => change.path),
  }).catch(() => { session.active(); return null; }) : null;
  const graphAvailable = graph?.files > 0;
  const originCoverage = requireOriginCoverage ? createProductionOriginCoverage({ projectRoot, graph,
    contextId: sha256({ taskId: input.taskId, reviewTaskId: task.id, directory, guard: initialGuard }), signal: session.signal,
    active: () => session.active() }) : null;
  const graphInstructions = graphAvailable ? await semanticGraphInstructions(session.signal) : '';
  const affectedSymbols = graphAvailable && regression?.triggered ? graph.affectedSymbols(regression.changes) : [];
  const removedLiteralUses = graphAvailable && regression?.base === 'TASK_START'
    ? await graph.removedLiteralUses(regression.changes, regression.baseCommit) : [];
  const semanticNavigation=await compactSemanticNavigation(affectedSymbols,removedLiteralUses,
    value=>parts(basisRoot,'semantic-navigation',value));
  let worker, collection, readOrdinal = 0;
  try { worker = await runProtocolTask({ task, root: directory, workspaceRoot: projectRoot, outputDir: directory,
    // As in coverage audit, task-local labels index source-bound receipts.
    // Only native-acknowledged exact pages enter this worker's citation map.
    citationId: () => `C${++readOrdinal}`,
    evidencePolicy: {
      trackFile: file => !programOwned(file) || originalEvidence(file),
      // Browsing an external ancestor of runtime output provides navigation.
      // Explicit file reads retain their own path and content guards.
      trackNavigation: root => inside(projectRoot, root) || !excluded.some(directory => inside(root, directory)),
      trackDirectory: file => !programOwned(file),
      currentFile,
    },
    signal: session.signal, deadlineAt: session.deadlineAt, nativeRun: session.run, assertCurrent: current,
    limits: input.taskLimits ?? STOP_TASK_LIMITS,
    definition: {
      beforeSubmit(name, value, ctx) {
        if (name !== 'submit_finding' && !(name === 'submit_review' && value.verdict === 'DEVIATION')) return;
        for (const ref of [...(Array.isArray(value.citations) ? value.citations : []), ...(Array.isArray(value.citeIds) ? value.citeIds : []).map(id => ctx.evidence.lookupCitation?.(id)
          ?? (/^(.*?)(?:#L|:)[1-9]\d*(?:-(?:L)?[1-9]\d*)?$/u.exec(id)?.[1] ? { path: id.replace(/(?:#L|:)[1-9]\d*(?:-(?:L)?[1-9]\d*)?$/u, '') } : null))]) {
          if (typeof ref?.path !== 'string') continue;
          const file = path.resolve(projectRoot, ref.path);
          if (inside(projectRoot, file)) { attachmentPaths.add(file); attachmentPaths.add(ctx.evidence.resolutions.get(file) ?? file); }
        }
      },
      prompt: [
        COMPLETION_INSTRUCTIONS,
        'An unavailable command remains UNVERIFIED unless finish_stop_review.environmentCommands names its exact original command and the program proves from the current host tool catalog that no available tool can execute it. Your capability claim is never that proof. Fixed build/test tools and unknown custom tools do not qualify for the exception.',
        'A proved past process-order inversion with no current repairable residue may be proposed in finish_stop_review.historicalOrders using two successful original tool-call IDs. It remains a historical deviation, is notified once without repair quota, and never becomes PASS. Missing events, simultaneous calls or a remaining repairable part do not qualify.',
        'Every proposed PROCESS deviation needs an explicit disposition before it can request repair, including already saved partial results: finish_stop_review.historicalOrders binds irreversible order facts; processRepairs names an actual current residue and useful remaining action. A statement that the past cannot be repaired is not a current residue. Missing required events leave an ordering claim UNVERIFIED; never invent events. Unclassified process rows/findings remain UNVERIFIED, including on context overflow. Use an assigned PROCESS row for historical order, not submit_finding. Real current process defects still require repair.',
        'Judge each original condition in context and report UNVERIFIED when its activation cannot be determined.',
        'One reviewer owns scope selection, source/artifact/process review, optional file quality, findings and the final checklist. Plan your own order; reuse each read across items. Do not spawn other agents.',
        'Citations are evidence attachments, never a completion gate. Only deviations sent to the host require citations: [{path,start,end}]. The program reads allowed files and binds their hashes and excerpts. Prior session reads and citeIds are not required. Tests, dependency sources and runtime output are eligible. Conforming, explained and unresolved conclusions need no citations. An invalid deviation attachment receives one repair error, then only that deviation becomes UNVERIFIED; valid siblings remain deliverable.',
        ...(originalRequirements ? [
          'This Stop starts from original user messages, project instructions, referenced materials and adopted Skill documents. Read the mandatory sources with source_read numbered:true. Call set_original_checklist with the optional scope block when the original evidence already settles classification. Read the latest user clarification in context and apply only currently binding obligations. A file named as a deliverable is never its own requirement authority. Adopted Skill steps belong to M08; derive an item from a Skill document only when it supplies an independent obligation outside those steps.',
          ...(referenceBasisFiles.length ? ['When an obligation needs optional context, read task.referenceBasisFiles in filename order. The catalog lists user-named optionalSources and other referenceMaterials with their task-start status. For a MODIFIED or DELETED reference, read its frozenOriginal. Cite the source itself. Optional reference drift alone cannot establish a deviation.'] : []),
          'For each distinct mandatory requirement, choose its applicable enabled M01–M16 metric, give the precise obligation and verificationTarget, and bind the original path and exact lineStart/lineEnd (legacy citeId is still accepted). These offsets are local to the named file or part. Preserve all conditions, allowed inputs and exceptions. For a conditional obligation supply its exact activation condition separately. Each item can declare expectedFiles only for explicit outputs named in both its cited lines and its own obligation text. When the original names a directory and filenames separately, submit the filenames as written and preserve the directory in the obligation text. The program resolves uniquely named output locations. Use M16 for production paths, M12 PROCESS for explicitly required test execution, and M12 IMPLEMENTATION with implementationRole TEST for a required authored test. M08 already comes from the adopted Skill graph and uses its original Skill documents when reviewed. Do not create M08 items or replace Skill checks.',
          ...(requirementQuotes.size ? ['The following configured checks refer to exact original production clauses. If a clause is an applicable original obligation, use its verbatim quote as the single checklist item text and cite the original lines containing it. Keep the rest of the original obligations. '
            + JSON.stringify(configuredRequirementBindings)] : []),
          ...(standingSource ? ['This task changed existing source, so the program appends the standing REGRESSION item from the mandatory standing-obligations basis after set_original_checklist; never add it yourself. Its review_checklist entry carries regressionEvidence: changed hunks, pre-existing tests that reference changed identifiers, and any program-run existing-test result. Judge any deviation against pre-existing behavior and the requested changes. Cite relevant file/line evidence; issued read IDs and direct path/range references are both accepted. Behavior the request asked to change is not a regression. Pointers, a passing, timed-out or unlaunched run, or a missing test are never counterevidence.'] : []),
        ] : []),
        'Read the mandatory original basis once. Parts with the same name concatenate in filename order to their original JSON, preserving every condition and exception. Initialize scope once using set_original_checklist.scope or review_checklist with stopClassification and the original reply\'s completionClaim (plus requiredUserInput/externalBlocker when relevant). Choose limit up to 20 to fit the checklist and response budget. Later pages or saved-result lookups omit classification fields; use offset/limit only. Never guess a completion claim. Separate review_scope remains available for complex workflows.',
        'Scope selection may return deferred:true while program-owned checks run between native calls. That is a handoff, not a result or an unresolved requirement. On resumption, use the prepared checklist page and program check navigation when supplied. Call review_checklist without classification fields for a missing or additional page, or to refresh saved results. Keep the original checklist and continue with the prepared evidence.',
        ...(deviationOnly ? [
          ...(followUps.size ? [
            'Previously delivered deviations are carried into this checklist with their original IDs. Do not recreate these same obligations in set_original_checklist: ' + JSON.stringify([...followUps.values()].map(({ object }) => object.description)),
            'Review the carried items first. Read current evidence and check the whole original obligation, including each independently observable effect and the prior counterexample. Use submit_review DEVIATION when it still fails, PASS when current evidence proves the fix, or UNVERIFIED when current evidence cannot settle it. PASS is allowed only for a carried item. Any unresolved item can receive UNVERIFIED and remains independently recorded. A prior reason and its paths are navigation, not current evidence.',
          ] : []),
          'Scan the full scoped checklist. Submit DEVIATION when concrete cited evidence contradicts that item; source_read before citation is optional. Unproved items stay UNVERIFIED. Inapplicable and conforming items require no deviation submission. Missing execution evidence alone is never counterevidence.',
          ...(approvedItems.size ? [
            'Required production obligations from the approved Proposal are added automatically. Include any additional obligations you find in the original basis. A source marked approvedExcerpt repeats exact original lines that cross a source-part boundary.',
          ] : []),
          ...(useProductionCoverage ? [
            `At TASK_COMPLETE, items marked requiresProductionCoverage need current production review through the observable effect. ${productionEntryGuidance}`,
            'For conforming items provide a short reason, acknowledged source_read citeIds, and flow with entry and consumer source subranges in finish_stop_review.productionCoverage. Include handoff for distinct boundaries. It is required when entry and consumer are in different files. Cite the exact lines within the read pages. A direct operation may use the same lines for entry and result. A carried PASS provides the same flow and cited reads in submit_review. Incomplete evidence remains unverified. Only an evidenced deviation can request repair.',
            ...(requireOriginCoverage ? ['Strict origin coverage is enabled. After reading a proposed entry, call review_production_origin for the exact assigned object and entry range before finishing. Its candidates are navigation, never reading proof or asserted routing relationships. Read each candidate with source_read and account for all returned IDs in flow.upstream using VERIFIED with a full producer-to-consumer flow (including applicable static sibling branches), or source-grounded OUT_OF_SCOPE with an acknowledged entry range. Carry its receiptId in flow.originReceiptId. Missing, incomplete, unsupported, stale or foreign receipts leave the item UNVERIFIED. Selection of the original operation, relevance and value propagation remain your semantic duties; do not choose a downstream helper merely to avoid the user operation.'] : []),
          ] : []),
          'Skip duties belonging to disabled metrics. Document deliverables and process rules do not become M16 production behavior. For a failed regression check, inspect each case in regressionEvidence.programRun.failureInventory independently, even if the failures share setup or a helper. Inspect the relevant task-start test assertions and setup. Trace the original inputs and service substitutes into the changed production path. Compare the failing expectation and the remaining assertions with the original user instructions. Pay attention to calls that fail or return missing or empty data.',
          'Program triage has removed only established task-start failures from reviewer explanations. A whole-suite failure that passes alone still needs review: changed setup, cleanup, call timing or a new real dependency can introduce an order-dependent regression. For each remaining failure, finish_stop_review.regressionCheck.cases accepts its exact id, verdict AUTHORIZED_CHANGE, REGRESSION or UNVERIFIED, and a reason. Judge authorization from the original request and actual setup. For a confirmed regression, first save its evidence-backed deviation and provide objectId. A changed mock is context, not authorization. Quotes, a full output read and production-only citations are not submission requirements. Unknown cases stay unresolved without blocking other conclusions.',
          'Check regressionEvidence.programRun.testSource before attributing a failure. TASK_START_PUBLIC_TESTS restores the original test tree and its setup/mocks; current test edits are not executed. Task-start excerpts are not current candidate source. Confirm a claimed current setup in current source, and never request an edit already present or one absent from the executed test tree. If the failure depends on original setup requiring behavior explicitly removed by the user, judge that authorization separately from unchanged production guards; do not infer a production regression solely from that setup. Unknown source or causality remains UNVERIFIED, not an automatic authorized change.',
          'Separate each failing expectation from its setup. A new dependency call, changed argument matching or call timing can make otherwise valid setup fail before an unrelated action is reached, even when public signatures are unchanged. Passing after a mock rewrite does not authorize the original failure. Caller unit tests intentionally bypass substituted callee implementations; their lack of callee execution is not evidence that a new caller-level read is required. Compare a placement behind the established boundary. Authorize a failure only from the request changing its observable expectation or valid input domain, not from the convenience of the chosen implementation. If the unchanged contract is contradicted, report the supported regression; if it cannot be established, record UNVERIFIED instead of treating the mock adjustment as an explanation.',
          'Before TASK_COMPLETE the checklist covers work already delivered. An unfinished, not-yet-started or user-pending obligation is not a deviation. Report only a concrete contradiction in code, documents or other work already present, with its counterevidence; an absent future output is not one.',
          'For conditional duties, tie the counterexample to the original condition, the actual operation and its observed effect. Follow the relevant production caller and callee when the counterexample is in source.',
          'Await the receipts for all submitted deviations, follow-ups and findings, then call finish_stop_review. When ready to finish with a current original production deviation, you may request finish:true on its last submit_review. If it saves the item but does not complete the review, follow the pending instructions or call finish_stop_review. Call finish_stop_review even when there were no deviations. Record unresolved items as UNVERIFIED, omit conforming items, and keep productionTrace optional.',
        ] : [
          `After receiving sufficient original evidence, issue multiple independent submit_review calls together in one assistant response, all with finish:false. Group complete arguments within the ${input.taskLimits?.maxTokens ?? STOP_TASK_LIMITS.maxTokens}-token output budget; keep reasons concise and leave a long M16 trace for its own response. A deviation can attach its path/range directly without a source_read call. Await every group result; keep successful receipts and repair only rejected items. After prior receipts are confirmed, submit the actual final remaining item with finish:true, or call finish_stop_review after all items are saved. Never put finish in a group with outstanding submissions. Every assigned original item still needs its own verdict; productionTrace is optional.`,
          'Optional pendingNavigation in saved receipts lists exact remaining IDs for this review and scope; follow review_checklist pagination for omissions. It grants no proof, PASS or permission to finish; retain the finish rules above.',
        ]),
        'Select the checklist before browsing execution history. When every selected proofOwners entry is SOURCE, inspect the named current source and necessary dependencies first; a mandatory read of original basis already preserves original task inputs. Do not enumerate historical business tool calls just to judge source-decidable code. If a concrete investigation needs those records, review_checklist includeProcessEvidence=true restores its navigation; actual PROCESS and mixed checklists expose it by default. Optional processReadPlan groups independent captured originals within a raw-byte budget: issue independent source_read calls together when output permits, await all real receipts and follow every nextOffset. The plan grants no coverage or mandatory-history expansion.',
        'Read a source path named in the original requirement directly. processFilesComplete=true means all process-file pointers are present; use the named relevant invocation/results directly. If processFilesContinuation is present, it describes existing source_ls pagination for the remaining records. SOURCE-only scopes still omit routine process navigation. Pointers grant no proof. Use ls/find only when discovery is needed.',
        'task.workspace is the actual project root. Start unknown-source searches there (omit path or use .), preferably in a relevant source directory or from review_changes hints. Do not search the parent containing all projects merely to locate a known relative project path. Follow original external references and necessary dependencies when they require reading outside this project; parent access remains available.',
        'The program-run regression evidence already captures the configured command and its real result. If a public baseline file named in that command is needed, read that exact path; do not recursively search its shared experiment/output parent, whose inventory can change during this review. Hidden tests, reference solutions and independent evaluator grades are not review inputs: do not search or read them.',
        'Use review_changes for Git status/diffs and host-edited paths as entry points. Follow dependencies, call sites and external references as needed. Diffs and inventories guide investigation; they do not establish PASS or absence.',
        ...(affectedSymbols.length ? ['The standing regression item may include currentSemanticLinks or semanticNavigationFiles pointing to their lossless contents for changed definitions, current callers, tests and effects. Read relevant navigation files when needed. testBoundaries joins dependency calls to test-helper arguments, setup scopes and later effect sites, without proving interception or control flow. Expand the relevant public entry with semantic_graph context/outgoing, then read its caller condition, dependency setup and first observable effect. Use the original basis for pre-existing behavior.'] : []),
        'For a requested no-effect or input-restriction guarantee, derive its owning public boundary from the original request before checking the frame. Trace the input condition, actual dependency outcome, guarding condition and first forbidden write or external call. Read any existing substitute and its returned value: when the request constrains the caller, a successful substitute exposes the caller path independently of the lower implementation. A lower helper that rejects real input does not prove that caller path is closed. Conversely, do not invent duplicate validation or failure guarantees at boundaries the request does not constrain. Verify the actual path before marking a frame item CHECKED; a selected scenario or passing lower-helper test is not proof.',
        ...(removedLiteralUses.length ? ['The standing regression item lists remaining case branches for removed literal values. Read the type, case and input path before judging a stale consumer or an independent use.'] : []),
        ...(graphInstructions ? [graphInstructions] : []),
        'source_read/grep/find/ls access the real workspace and absolute/parent paths, including linked files. No project copy, source allowlist or directory fence applies. Files remain read-only.',
        'Use review_plan and review_notes for your own planning and durable notes; review_history recovers issued citations and saved receipts after compaction. Notes and self-reports are not evidence of execution.',
        'Preserve original obligations, conditions, exceptions, HARD/SOFT authority and each proof owner. Process claims need original process records; source code alone cannot prove an action occurred. Read relevant processFiles on demand.',
        'M12 follows its original verificationTarget: IMPLEMENTATION uses SOURCE_IMPLEMENTATION to judge the delivered code and required data/control flow from current source, without inventing a test-run obligation. An explicit TEST implementationRole can prove authored test code, never test execution or M16 production coverage. PROCESS uses RUNTIME_ACCEPTANCE and requires the attributable original invocation and result. Keep mixed obligations separate: a source PASS cannot erase a required missing or failed execution, or prove acceptance/journey closure.',
        'For execution obligations, a completion claim without an attributable original execution result is UNVERIFIED, never DEVIATION. Missing records do not prove a failed or omitted action. A concrete contradictory execution event is required for DEVIATION; messages alone cannot certify runtime PASS.',
        'For order-sensitive process obligations, establish the required actor and event order from original invocation/result records. A read before an edit does not prove a read after it. Your own private source_read proves current content, not that the business actor previously reread or verified the file. An edit receipt, build or test result cannot stand in for a separately required business read-back unless the original rule permits that substitution and the actual result proves it. Missing attributable post-action evidence is UNVERIFIED, not an invented omission or PASS.',
        'Distinguish missing execution proof from positively observed nonconforming verification. If original invocation/result records and the completion context identify a post-edit read as the attempted required whole-file verification, an explicit bounded range that omits required parts is concrete wrong-scope execution and supports DEVIATION; do not relabel that observed contradiction as merely missing whole-file evidence. A pre-edit exploratory read, or a partial navigation read not attributable to the required verification attempt, does not by itself prove failed verification. When the post-action verification is only missing or cannot be attributed, retain UNVERIFIED. Current file facts cannot repair the original actor, order or executed scope.',
        'Match applicability evidence to the original scope. An ASCII-only page/diff, a zero-hit punctuation search, or a successful build/test does not establish that an entire file is ASCII or contains no Chinese. source_read returns fileFacts computed over all original UTF-8 bytes of that exact named file, bound to sha256: asciiOnly establishes full-file ASCII, while hanCodePoints counts Han characters, including outside the returned page. For a frozen source part these facts cover only that named part, not unread parts of its larger original document. A zero Han count alone is not proof of ASCII, correct text or business verification. Use these facts or sufficient original content to establish an exemption; retain uncertainty otherwise. Character facts never expand line citations or mandatory reading coverage, and your own review reads or file facts cannot satisfy a business-process action.',
        'For M08, use the originalSkillBasis documents to judge Skill compliance in context; derived constraints are navigation.',
        'A source-bound Skill graph carries a semantic sourceInterpretation proposal and the complete original unit. The original context governs: a MUST/MIXED parent does not make its permission, description or advice clauses mandatory. Assess its independent current duties and each actual external condition separately; an inactive sub-branch cannot exclude the whole current compound. Do not invent before/after prerequisites from navigation order.',
        deviationOnly
          ? 'Omit items whose deviation cannot be proved. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.'
          : 'Submit UNVERIFIED when evidence is missing; do not invent obligations, exclusions, runtime results or PASS. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.',
        'At TASK_COMPLETE, the program checks unconditional explicit expectedFiles for enabled M12/M16 items. Confirmed missing/non-file outputs have already saved DEVIATION receipts. Use review_checklist savedResult and do not resubmit those items. Existence alone never proves content quality, implementation, or execution. Conditions and future/stage outputs are not automatically declared missing.',
        'Give a concrete cause and consequence in one or two sentences per reason; do not recite the entire metric checklist. Submit a separate finding only for a demonstrated problem not already represented by a metric deviation.',
        'An M16 item may contain several required effects and alternative outcomes. When scanning for deviations, account for every original effect under each applicable outcome, including an explicitly required thrown/rejected operation as distinct from a returned failure. Follow the actual caller and callee control flow to the required consumer effect: code after an await is skipped when it rejects, and a finally block proves only the operations it actually performs. Do not let a correct rollback or busy-flag cleanup stand in for a separately required state reload or other effect. If relying on a callee to convert exceptions into returned failures, establish that contract for the relevant boundary from source; one caught inner operation is insufficient. Keep this analysis within the original allowed conditions, without requiring exception handling or effects the task does not request.',
        'When an existing operation guard is extended to reject another operation, compare each pending state with the original guard for that same state. The returned error or status must identify the operation actually in progress, and preserve existing public state-to-output mappings and stable tokens unless the request changes them. Rejecting the second operation alone does not prove the resulting message is accurate. Read the original guard and changed producer/caller before reporting a concrete contradiction.',
        ...(deviationOnly ? [] : [
          'For M16 PASS, inspect the production producer-to-consumer flow, all writers to consumed state and potentially aliasing resources; describe the production flow when useful; productionTrace is optional. Do not require a complete PASS trace for a concrete DEVIATION or UNVERIFIED.',
          'Production writers are initializers and runtime operations in the delivered program. A developer editing a source file is not the application writing its stored state. Cite the actual initializer or runtime write for the produced value; process records and edit receipts cannot replace production source citations. A supplied trace is advisory and does not change citation acceptance.',
          'For a conditional failure guarantee, retain the exact failing operation and condition from the original requirement. Trace the order of effects before and after that boundary, distinguishing in-memory state, durable storage and external system state. A failure return or caught exception does not undo earlier writes. A claimed unchanged state or rollback needs source evidence for the compensating writes and an independent snapshot when aliasing matters. Keep both the verdict reason and productionTrace within the guarantees actually supported by those paths; a dispatch-failure guarantee does not establish persistence-failure atomicity. A concrete contradiction of the required condition supports DEVIATION; missing proof supports UNVERIFIED. Do not add unrequested failure guarantees or obligations.',
        ]),
        ...(requirementFrame ? [FRAME_REVIEW_INSTRUCTIONS] : []),
        ...(proposedSeeds.length ? [proposedCheckInstructions(proposedSeeds.map(seed => seed.check), deviationOnly)] : []),
      ].join('\n'),
      tools: () => [
        ...(graphAvailable ? [{ ...SEMANTIC_GRAPH_TOOL, submit: value => graph.query(value) }] : []),
        ...(requireOriginCoverage ? [tool('review_production_origin',
          'Observe upstream references for an assigned production obligation and an acknowledged current entry. This host receipt is navigation; every candidate still needs its own native source_read and semantic disposition. Qualified file-selector literals are possible references, not proven routes.',
          schema({ objectId: text, entry: coverageSourceRange }, ['objectId', 'entry']), async (value, ctx) => {
            if (!requiredProduction.has(value.objectId)) throw taskError('REVIEW_ORIGIN_SCOPE_INVALID', 'Choose an assigned requirement that needs production coverage.');
            const entry = productionRange(ctx, value.entry);
            if (!entry) throw taskError('REVIEW_ORIGIN_EVIDENCE_REQUIRED', 'Read the exact current production entry before observing its upstream references.');
            const receipt = await originCoverage.discover({ objectId: value.objectId, entry });
            await ctx.persist(`origin-${receipt.receiptId}.json`, receipt);
            return receipt;
          })] : []),
        ...(originalRequirements ? [tool('set_original_checklist', 'Save the obligations and exact source ranges from the acknowledged original requirements. Optionally select the Stop scope and receive the first checklist page in the same call. This tool saves no verdicts.',
          schema({ items: { type: 'array', maxItems: 256, items: schema({
            metricId: { type: 'string', enum: Object.keys(METRIC_CATALOG).filter(id => id !== 'M08' && population.reviewPolicy?.metrics[id] !== false) },
            text, verificationTarget: { type: 'string', enum: ['ARTIFACT', 'PROCESS', 'IMPLEMENTATION'] },
            implementationRole: { type: 'string', enum: ['PRODUCTION', 'TEST', 'SUPPORT'] }, applicability: text,
            expectedFiles: EXPECTED_FILES_SCHEMA, path: { type: 'string' }, citeId: text,
            lineStart: { type: 'integer', minimum: 1 }, lineEnd: { type: 'integer', minimum: 1 },
          }, ['metricId', 'text', 'verificationTarget', 'lineStart', 'lineEnd']) }, scope: schema({
            stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification, ...stageProperties, ...completionProperties,
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          }, ['stopClassification', ...(task.classificationContract === 2 ? ['completionClaim'] : [])]) }, ['items']), setOriginalChecklist)] : []),
        tool('review_scope', 'Select the Stop scope once from the original user/assistant basis. This produces the program-owned checklist, not an acceptance verdict.',
          schema({ stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification,
            ...stageProperties, summary: text,
            includeProcessEvidence: { type: 'boolean', description: 'Restore execution-history navigation when investigating it for a SOURCE-only checklist. PROCESS and mixed checklists include it by default.' },
            ...completionProperties }, ['stopClassification', 'summary', ...(task.classificationContract === 2 ? ['completionClaim'] : [])]),
          selectScope),
        tool('review_checklist', 'Initialize once with stopClassification AND completionClaim from the original reply; choose limit up to 20. For later pages/saved results omit classification fields and use offset/limit. Returns proofOwners: PROCESS needs original invocation/results, SOURCE needs current production code. '
          + (deviationOnly ? 'Inspect the assigned items and report only proven deviations.' : 'Every assigned item remains required.'),
          schema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
            includeProcessEvidence: { type: 'boolean', description: 'Explicitly include process-file pointers for a SOURCE-only checklist when a concrete investigation needs them.' },
            stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification, ...stageProperties, summary: text, ...completionProperties }),
          readChecklist),
        tool('submit_review', deviationOnly
          ? 'Save a deviation or unresolved item; PASS is reserved for carried deviations. taskId is objectId or file:<path>. Only DEVIATION needs citations: [{path,start,end}]. Legacy IDs remain readable.'
          : 'Save one original item. Group independent already-evidenced calls in one response within the output budget, all finish:false; await every result before any finish. taskId is objectId or file:<path>. Only DEVIATION needs citations: [{path,start,end}]. Other verdicts need no citation. The program checks allowed file, range and hash only.',
          schema({ taskId: text,
            finish: { type: 'boolean', description: dispositionFrame
              ? 'For a requirement frame, finish separately with finish_stop_review.frameDispositions.'
              : deviationOnly ? 'If ready to finish, set true on the final current production deviation. The tool saves the item first and can finish only when no separate disposition is due.'
                : 'Set true on the final item to finish the complete original checklist in the same call.' },
            verdict: { type: 'string', enum: deviationOnly ? followUps.size ? ['DEVIATION', 'PASS', 'UNVERIFIED'] : ['DEVIATION', 'UNVERIFIED']
              : STOP_REVIEW_SCHEMA.properties.metricObjectJudgements.items.properties.judgement.enum.filter(value => value !== 'CHECKER_ERROR') },
            reason: text, citeIds, citations: STOP_CITATIONS_SCHEMA, conditionAssessment: { ...CONDITION_ASSESSMENT_SCHEMA,
              description: 'Only supply for an assigned item whose canonical applicabilityKind is CONDITIONAL. Otherwise omit conditionAssessment; never change the assigned kind or verdict to fit this field.' },
            ...(useProductionCoverage ? { flow: productionFlowSchema } : {}),
            ...(wireTraceSchema ? { productionTrace: wireTraceSchema } : {}) }, ['taskId', 'verdict', 'reason']),
          async (value, ctx) => {
            const object = selected.find(object => object.objectId === value.taskId);
            const followUp = deviationOnly && followUps.get(value.taskId);
            if (deviationOnly && value.verdict === 'PASS' && !followUp)
              throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Only previously delivered deviations can receive a PASS follow-up verdict.');
            const suppliedTrace = value.productionTrace;
            let trace = suppliedTrace;
            if (suppliedTrace !== undefined) {
              if (!Object.hasOwn(value, 'productionTrace') || Object.getPrototypeOf(value) !== Object.prototype
                || Object.getPrototypeOf(suppliedTrace) !== Object.prototype)
                throw taskError('TASK_SUBMISSION_INVALID', '/productionTrace: Supply a plain JSON object, not a prototype-derived record.');
              if (!Object.hasOwn(suppliedTrace, 'version')) {
                if (object?.metricId !== 'M16')
                  throw taskError('TASK_SUBMISSION_INVALID', '/productionTrace/version: A supplied trace outside assigned M16 still requires its explicit version.');
                trace = { ...suppliedTrace, version: traceVersion.const };
              }
            }
            ctx.requireBasis();
            const target = qualityTargets.find(file => `file:${file.path}` === value.taskId);
            if (!classification || !object && !target) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Unassigned checklist item');
            if (value.conditionAssessment && object?.applicabilityKind !== 'CONDITIONAL')
              throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', '/conditionAssessment: ' + JSON.stringify({
                objectId: object?.objectId ?? `file:${target.path}`, applicabilityKind: object?.applicabilityKind ?? null,
                instruction: 'Omit conditionAssessment for this assigned item. Only canonical CONDITIONAL items accept it; do not change the kind or verdict.' }));
            if (object ? rows.has(object.objectId) || followUpResults.has(object.objectId) : files.has(target.path)) throw taskError('TASK_SUBMISSION_CONFLICT', 'This item already has a saved result');
            if (object && ['NOT_APPLICABLE', 'NOT_YET_APPLICABLE'].includes(value.verdict) && object.applicabilityKind !== 'CONDITIONAL')
              throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'This obligation is not conditional');
            if (target && !['PASS', 'DEVIATION', 'UNVERIFIED'].includes(value.verdict)) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Invalid file-quality verdict');
            const coverageRecheck = followUp && value.verdict === 'PASS' && requiredProduction.has(object.objectId);
            const reviewedSource = coverageRecheck ? (await coverageEvidence(ctx, { ...value, objectId: object.objectId }))?.coverage : null;
            if (coverageRecheck && !reviewedSource) value = { ...value, verdict: 'UNVERIFIED', citeIds: [], citations: [],
              reason: 'The prior deviation needs acknowledged current production evidence for the original operation and its observable result before it can be closed.' };
            const owner = object?.objectId ?? target.path;
            if (value.verdict === 'UNVERIFIED' && citationDrafts.has(value.taskId)) {
              const saved = await downgradeCitation(ctx, value.taskId, { owner, object, target }, citationDrafts.get(value.taskId).error);
              ctx.state.result = projectResult(ctx, 'The proposed deviation remains unverified.'); return saved;
            }
            if (value.verdict !== 'DEVIATION') citationDrafts.delete(value.taskId);
            const mapped = value.verdict === 'DEVIATION' ? await checkedAttachments(ctx, value.taskId, { owner, object, target }, value)
              : await receiptCitations(ctx, value.citeIds, owner, object, value.citations).catch(error => {
                if (error.code === 'TASK_CITATION_INVALID') return []; throw error;
              });
            if (mapped.downgraded) { ctx.state.result = projectResult(ctx, 'Only an invalid evidence attachment was downgraded.'); return mapped; }
            if (processSnapshotPath && value.conditionAssessment?.evidenceKind === 'PROCESS_WINDOW')
              protectedInputs.set(processSnapshotPath, processSnapshotHash);
            const references = mapped.map(citation => citation.selection);
            const row = object ? { objectId: object.objectId, judgement: value.verdict, reason: value.reason, evidence: references }
              : { path: target.path, status: value.verdict, reason: value.reason, evidence: references };
            if (value.conditionAssessment) row.conditionAssessment = value.conditionAssessment;
            let checkedRow;
            const sourceCiteIds = mapped.map(ref => ref.citeId);
            if (object) checkedRow = validateReviewJudgement({ row, object, citations: mapped, classification, mechanicalEvidence: true });
            else validateReviewFile({ file: row, citations: mapped, mechanicalEvidence: true });
            if (trace !== undefined && value.verdict === 'PASS') row.productionTrace = trace;
            const receipt = { itemId: value.taskId, result: row, citations: mapped, sourceCiteIds,
              savedAt: Date.now() };
            await ctx.persist(`items/${sha256(value.taskId)}.json`, receipt);
            if (followUp && value.verdict !== 'DEVIATION') {
              followUpResults.set(object.objectId, row);
              if (reviewedSource) {
                productionCoverage.set(object.objectId, reviewedSource);
                for (const { path: file } of reviewedSource.evidence) productionCoverageFiles.add(file);
              }
              citations.push(...mapped);
              ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
              ctx.state.result = projectResult(ctx, 'Saved follow-up evidence; review is in progress.');
              return { saved: true, itemId: value.taskId, ...(coverageRecheck && !reviewedSource ? { verdict: 'UNVERIFIED' } : {}) };
            }
            if (object) validatedRows.set(object.objectId, checkedRow);
            if (object) { rows.set(object.objectId, row); proofs[object.objectId] = { productionTrace: row.productionTrace, sourceCiteIds,
              }; }
            else files.set(target.path, row);
            citations.push(...mapped); ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
            ctx.state.result = projectResult(ctx, 'Saved original checklist results; review is in progress.');
            if (deviationOnly) {
              const saved = { saved: true, itemId: value.taskId };
              if (value.finish && canFinishSourceDeviation(object, row, mapped)) {
                return { ...await finishReview({ summary: value.reason }, ctx), ...saved };
              }
              return { ...saved, ...(value.finish ? { complete: false, next: 'finish_stop_review' } : {}),
                ...(needsProcessClassification(object, row) ? { processClassificationRequired: true,
                  next: 'finish_stop_review.historicalOrders for a proved immutable order, or processRepairs for an actual current residue and useful remaining action. Otherwise this item remains UNVERIFIED and cannot dispatch repair.' } : {}) };
            }
            const remaining = selected.length + qualityTargets.length - rows.size - files.size;
            if (value.finish && remaining === 0 && !dispositionFrame) return { ...await finishReview({ summary: value.reason }, ctx), itemId: value.taskId, pending: 0 };
            return withPendingNavigation({ saved: true, itemId: value.taskId, pending: remaining });
          }),
        tool('submit_finding', 'Save an evidence-backed deviation beyond checklist rows; reference original Ground Truth IDs and file/line citations.',
          schema({ ...Object.fromEntries(Object.entries(STOP_REVIEW_SCHEMA.properties.findings.items.properties).filter(([key]) => key !== 'actualEvidence')), citeIds, citations: STOP_CITATIONS_SCHEMA },
            ['deviationKey', 'rootCauseId', 'severity', 'reason', 'expectedConstraint', 'violatedGroundTruthIds']),
          async ({ citeIds: ids, citations: direct, ...finding }, ctx) => {
            ctx.requireBasis(); if (!classification) throw taskError('STOP_SCOPE_REQUIRED', 'Select the Stop scope first');
            if (findings.some(saved => saved.deviationKey === finding.deviationKey) || citationIssues.has(`finding:${finding.deviationKey}`) || !finding.violatedGroundTruthIds.length)
              throw taskError('TASK_SUBMISSION_CONFLICT', 'A distinct finding and its original obligations are required');
            const owned = allObjects.filter(object => finding.violatedGroundTruthIds.includes(object.sourceId));
            if (finding.violatedGroundTruthIds.some(id => !owned.some(object => object.sourceId === id))) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Unknown finding obligation');
            const mapped = await checkedAttachments(ctx, `finding:${finding.deviationKey}`, { owner: finding.deviationKey, object: null }, { citeIds: ids, citations: direct });
            if (mapped.downgraded) { ctx.state.result = projectResult(ctx, 'Only an invalid evidence attachment was downgraded.'); return mapped; }
            finding.actualEvidence = [...new Set(mapped.map(citation => citation.selection))];
            validateReviewFinding({ finding, objects: allObjects, citations: mapped, classification, mechanicalEvidence: true });
            await ctx.persist(`findings/${sha256(finding.deviationKey)}.json`, { finding, citations: mapped });
            findings.push(finding); citations.push(...mapped);
            ctx.state.result = projectResult(ctx, 'Saved checked findings; review is in progress.');
            return { saved: true, deviationKey: finding.deviationKey,
              ...(processFindingObjects(finding).length ? { processClassificationRequired: true,
                next: 'finish_stop_review.processRepairs must name the current residue and useful remaining action. Historical order belongs on an assigned PROCESS row.' } : {}) };
          }),
        tool('review_plan', 'View or replace your review plan. Planning does not change the original checklist or grant evidence.',
          schema({ steps: { type: 'array', maxItems: 100, items: schema({ text, status: { type: 'string', enum: ['pending', 'active', 'done'] } }, ['text', 'status']) } }),
          async (value, ctx) => { if (value.steps) { await ctx.persist('plan.json', value.steps); plan = structuredClone(value.steps); } return { steps: plan }; }),
        tool('review_notes', 'Append a durable review note or retrieve a page after compaction. Notes are navigation, never source evidence.',
          schema({ note: text, offset: { type: 'integer', minimum: 0 } }),
          async (value, ctx) => {
            if (value.note) { const next = [...notes, value.note]; await ctx.persist('notes.json', next); notes = next; }
            const offset = value.offset ?? 0; return { notes: notes.slice(offset, offset + 5), total: notes.length, nextOffset: offset + 5 < notes.length ? offset + 5 : null };
          }),
        tool('review_changes', 'Inspect Git changes and host-edited file paths as review entry points. Supply path for its HEAD-to-working-tree diff; offset pages text. These hints do not grant citations.',
          schema({ path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, editOffset: { type: 'integer', minimum: 0 } }),
          async (value, ctx) => {
            const edited = [];
            for (const [index, entry] of entries.entries()) for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
              if (block.type !== 'tool_use' || !/write|edit|patch/iu.test(block.name ?? '')) continue;
              const changes = Array.isArray(block.input?.edits) ? block.input.edits : [block.input ?? {}];
              const hint = { tool: block.name, toolCallId: block.id, processFiles: entryPaths.get(index) };
              for (const [editIndex, change] of changes.entries()) {
                const file = change.file_path ?? change.path ?? block.input?.file_path ?? block.input?.path;
                const before = String(change.old_string ?? change.oldText ?? ''), after = String(change.new_string ?? change.newText ?? change.content ?? '');
                if (file) edited.push({ path: path.resolve(projectRoot, file), ...hint, editIndex,
                  before: before.slice(0, 1200), after: after.slice(0, 1200), previewTruncated: before.length > 1200 || after.length > 1200 });
              }
              const patch = String(block.input?.patch ?? block.input?.input ?? '');
              for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu))
                edited.push({ path: path.resolve(projectRoot, match[1].replace(/\r$/u, '')), ...hint, patch: patch.slice(0, 2400), previewTruncated: patch.length > 2400 });
            }
            let output, error;
            const statusExclusions = [controlRoot, ...excluded].filter(file => inside(projectRoot, file))
              .map(file => `:(exclude,literal)${path.relative(projectRoot, file).replaceAll('\\', '/')}`);
            try { output = (await executeFile('git', ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...value.path
              ? ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', path.resolve(projectRoot, value.path)]
              : ['status', '--short', '--untracked-files=all', '--', ...statusExclusions]], { cwd: projectRoot, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, signal: session.signal })).stdout; }
            catch (cause) { ctx.active(); error = cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Diff exceeds tool buffer; inspect a narrower file and source_read its original lines.' : 'Git changes are unavailable; use host edits and source navigation.'; }
            const offset = value.offset ?? 0, editOffset = value.editOffset ?? 0, body = output ?? '';
            return { navigationOnly: true, hostEdits: edited.slice(editOffset, editOffset + 10), hostEditCount: edited.length,
              nextEditOffset: editOffset + 10 < edited.length ? editOffset + 10 : null,
              text: body.slice(offset, offset + 12000), nextOffset: offset + 12000 < body.length ? offset + 12000 : null, error,
              processFiles: [...processFiles].slice(0, 5) };
          }),
        tool('finish_stop_review', (deviationOnly
          ? 'Finish after scanning the selected scope and receiving all submitted deviation receipts. A completed scan may report zero deviations. historicalOrders can bind a proved past ordering inversion to two successful original tool-call IDs (requiredFirstEventId actually occurred after requiredSecondEventId). historicalOnly:true requires no present repairable residue; missing calls never prove an inversion. Such historical deviations are notified once, never converted to PASS, and do not request repeated futile repairs.'
          : 'Finish only when every original checklist item and requested file-quality review has a saved result. Final text alone is not a result.')
          + ' Every original PROCESS deviation also needs historicalOrders or processRepairs. processRepairs requires its exact objectId (or finding deviationKey), currentResidue and useful repairAction. Missing classification remains UNVERIFIED, including partial results, and cannot start a repair.',
          schema({ summary: text, ...(dispositionFrame ? { frameDispositions: FRAME_DISPOSITIONS_WIRE } : {}),
            ...(useProductionCoverage ? { productionCoverage: { type: 'array', maxItems: 256, items: schema({
              objectId: text, reason: text, citeIds: { type: 'array', maxItems: 8, items: { type: 'string' } }, flow: productionFlowSchema,
            }, ['objectId', 'reason', 'citeIds']) } } : {}),
            historicalOrders:HISTORICAL_ORDER_SCHEMA,
            processRepairs:PROCESS_REPAIRS_SCHEMA,
            environmentCommands: ENVIRONMENT_COMMANDS_SCHEMA,
            regressionCheck: schema({ status: { type: 'string', enum: ['EXPLAINED', 'UNVERIFIED', 'REVIEWED'],
              description: 'Use REVIEWED for mixed case decisions. EXPLAINED authorizes legacy explanations; UNVERIFIED does not.' },
            reason: text, citeIds, citations: STOP_CITATIONS_SCHEMA,
            cases: { type: 'array', items: schema({ id: { type: 'string' }, verdict: { enum: ['AUTHORIZED_CHANGE', 'REGRESSION', 'UNVERIFIED'] },
              reason: text, objectId: { type: 'string' } }, ['id', 'verdict', 'reason']) },
            explanations: { type: 'array', description: 'Legacy explanations may accompany cases. In REVIEWED mode, an omitted case is authorized only with an explicit authorization. An explicit same-ID case decision always wins.', items: schema({
              failure: { type: 'string', description: 'Exact failure ID from the program-run inventory.' }, reason: text,
              originalTestCiteId: { type: 'string' }, oldExpectation: quote, expectedAfter: quote, originalCiteId: { type: 'string' }, authorization: quote, citeIds,
            }, ['failure', 'reason']) } }, ['status', 'reason']) }, ['summary']), finishReview),
      ],
    },
  }); } catch (error) {
    if (!classification || !error.protocolResult?.result || session.signal.aborted
      || /INPUT_CHANGED|CANCEL|STALE|DEADLINE/u.test(error.code ?? '')) throw error;
    worker = error.protocolResult;
    collection = { complete: false, mode: 'workspace-stop', failures: [{ code: error.code ?? 'REVIEW_ITEM_INCOMPLETE', message: 'The original checklist was only partially saved.' }] };
  }
  const { citations: sourceCitations, proofs: savedProofs, reviewEvidence, ...result } = worker.result;
  const dispositions = [...followUps].flatMap(([id, { familyId, observationId }]) => {
    const row = rows.get(id) ?? followUpResults.get(id);
    return row ? [{ ...classifiedRow(row), familyId, observationId }] : [];
  });
  const unresolved = unresolvedReview();
  const reviewCompleted = !collection;
  if (!collection && unresolved.majorityUnverified)
    collection = { complete: false, mode: 'workspace-stop', reasonCode: 'STOP_MOST_REQUIREMENTS_UNVERIFIED', failures: [] };
  return { result, reviewCompleted, citationPolicy: 'mechanical-v1', sourceCitations, getSourceCitations: async () => structuredClone(sourceCitations),
    getHistoricalOrders:()=>structuredClone([...historicalOrders.values()]),
    getEnvironmentExceptions:()=>structuredClone([...environmentExceptions.values()]),proofs: savedProofs, reviewEvidence,
    ...(dispositions.length ? { followUps: dispositions } : {}),
    ...(reviewBasis ? { reviewBasis } : {}), ...(basisBudget ? { basisBudget } : {}),
    ...(collection ? { collection } : {}), receipts: worker.receipts, sessionId: session.sessionId, artifacts: directory, close: async () => {} };
}
