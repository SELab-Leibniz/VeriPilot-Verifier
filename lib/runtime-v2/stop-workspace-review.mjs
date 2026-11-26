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
import { markdownTitle, MANDATORY_REFERENCE_BYTES } from './original-requirements.mjs';
import { ORIGINAL_PART_BYTES, inlineAcceptanceOriginal, originalSourceCoverage, retainLongSourceGaps, unverifiedSources } from './stop-source-coverage.mjs';
import { matchesCurrentIdentity, outputIdentity } from './stop-execution-binding.mjs';
import { createOriginalBatches, mergeExtractionRanges } from './stop-original-batches.mjs';
import { taskDirectory, decisionGuard } from './task-store.mjs';
import { readJson, safeId, sha256 } from './utils.mjs';
import { isSkillFileName, resolveSkillDirectory, scanSkillDirectory } from './skill-source.mjs';
import { fingerprint } from './evidence-state.mjs';
import { covers, excerpt, planIndependentReads } from '../review-task/evidence-utils.mjs';
import * as activeHost from '../active-host.mjs';
import { EXPECTED_FILES_SCHEMA, normalizeExpectedFiles, resolveExpectedFilePath, observeExpectedFile, expectedFilesCurrent } from './expected-files.mjs';
import { CONDITION_ASSESSMENT_SCHEMA, CONDITIONAL_REVIEW_POLICY_VERSION, durableTaskJson } from '../review-task/task-evidence.mjs';
import { STANDING_OBLIGATIONS_TEXT, STANDING_REGRESSION, collectRegressionEvidence, collectRegressionFailureTests,
  regressionFailureInventory, regressionNavigation, renderRegressionEvidence, renderRegressionRun, standingRegressionItem } from './regression-evidence.mjs';
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

const executeFile = promisify(execFile);
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
const sourceCode = /\.(?:[cm]?js|jsx|tsx?|ets|py|java|kt|rs|go|[ch](?:pp)?|cs|swift|rb|php|lua|sh|ps1|json5?|ya?ml|toml|html|css|xml|sql)$/iu;
const testSource = file => file.split(/[\\/]/u).some(part => /^(?:tests?|__tests__|mocks?)$/iu.test(part)) || /(?:^test_|\.(?:test|spec)\.|_test\.)/iu.test(path.basename(file));

// This is the entire model review for one Stop, including scope selection.
// Only small original obligations/process records are serialized. Business
// files are never copied, and discovery is independent of the source manifest.
export async function runWorkspaceStopReview(input, { session }) {
  const deviationOnly = input.request.population.reviewPolicy?.deviationOnly === true;
  const projectRoot = await fs.realpath(input.projectRoot);
  const directory = path.join(taskDirectory(projectRoot, input.taskId), 'workspace-reviews', randomUUID());
  const basisRoot = path.join(directory, 'basis'), processRoot = path.join(directory, 'execution');
  await fs.mkdir(basisRoot, { recursive: true }); await fs.mkdir(processRoot);
  const taskPath = path.join(taskDirectory(projectRoot, input.taskId), 'task.json');
  const initialState = await readJson(taskPath);
  const initialGuard = decisionGuard(initialState);
  const originalRequirements = input.evidence?.originalRequirements;
  const truthPath = originalRequirements ? null : input.request.groundTruthPath;
  const persistedTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) : null;
  const processSnapshotPath = input.request.processSnapshotPath && await fs.realpath(input.request.processSnapshotPath).catch(() => null);
  const processSnapshotHash = processSnapshotPath && sha256(await fs.readFile(processSnapshotPath));
  const protectedInputs = new Map();
  let truth = input.evidence?.groundTruth ?? (persistedTruth && JSON.parse(persistedTruth));
  if (!truth || truth.taskId && truth.taskId !== input.taskId) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'The current authoritative baseline is unavailable');
  const basisFiles = [], processFiles = new Set(), executionFiles = new Set(), originalSources = new Map(), optionalSources = [], referenceMaterials = [];
  const acceptanceSources = [];
  async function parts(root, name, value, mandatory = false, execution = false, raw = false) {
    const bytes = Buffer.from(raw ? value : JSON.stringify(value) + '\n');
    const written = [];
    for (let start = 0, index = 0; start < bytes.length; index++) {
      session.active();
      let end = Math.min(start + ORIGINAL_PART_BYTES, bytes.length);
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
  // One immutable file per user message keeps original lines and byte offsets
  // independent of the size of any page exposed to the native reviewer.
  if (originalRequirements) {
    for (const [index, message] of originalRequirements.userMessages.entries()) {
      session.active();
      const file = path.join(basisRoot, `user-original-${index}-0000.txt`);
      const bytes = Buffer.from(message.text);
      const hash = sha256(bytes);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      basisFiles.push(file);
      originalSources.set(file, { kind: 'USER_MESSAGE', ref: message.ref, sha256: message.sha256, readHash: hash, part: 1, lineOffset: 0 });
      if (inlineAcceptanceOriginal(message.text)) {
        const length = bytes.reduce((count, byte) => count + Number(byte === 10), 1);
        acceptanceSources.push({ ref: message.ref, sha256: message.sha256, lines: length, bytes: bytes.length, parts: [{ file, offset: 0, length, hash }] });
      }
    }
    let frozenCount = 0;
    const frozenOriginal = async (name, base64) => {
      const bytes = Buffer.from(base64, 'base64'), file = path.join(basisRoot, 'reference-originals', `${++frozenCount}-${sha256(bytes).slice(0, 16)}-${path.basename(name)}`);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' });
      return { file, sha256: sha256(bytes), bytes };
    };
    const optional = (file, kind, ref, hash) => { if (hash && !originalSources.has(file)) originalSources.set(file, { kind, ref, sha256: hash, readHash: hash, lineOffset: 0, optional: true }); };
    const governed = new Map((originalRequirements.acceptanceSources ?? []).map(source => [source.path, source]));
    const bound = new Map();
    const unavailable = new Set();
    const originalPath = async ref => {
      try { return await fs.realpath(path.resolve(projectRoot, ref)); }
      catch (error) {
        if (!governed.has(ref) || !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        unavailable.add(ref);
        return null;
      }
    };
    for (const [kind, sources] of [['PROJECT_FILE', originalRequirements.projectFiles], ['MATERIAL', originalRequirements.materials],
      ['MATERIAL', originalRequirements.referencedFiles]]) for (const source of sources) {
      if (governed.get(source.path)?.issue) continue;
      const stored = governed.get(source.path)?.originalBase64 ?? source.originalBase64;
      const copy = typeof stored === 'string' ? await frozenOriginal(source.path, stored) : null;
      const file = copy?.file ?? await originalPath(source.path);
      if (!file) continue;
      bound.set(source.path, file);
      if (source.mandatory === false) { optionalSources.push({ file, kind, ref: source.path, bytes: source.bytes, note: source.note });
        optional(file, kind, source.path, copy?.sha256 ?? governed.get(source.path)?.sha256 ?? source.sha256); continue; }
      if (originalSources.has(file)) continue;
      originalSources.set(file, { kind, ref: source.path, sha256: copy?.sha256 ?? source.sha256, readHash: copy?.sha256 ?? source.sha256, lineOffset: 0 });
      basisFiles.push(file);
      if (copy) referenceMaterials.push({ path: source.path, file: path.resolve(projectRoot, source.path), bytes: copy.bytes.length,
        title: markdownTitle(copy.bytes.toString('utf8')), sha256: copy.sha256, status: source.status, frozenOriginal: copy.file,
        note: 'Named by the user, so its task-start copy is a mandatory source.' });
    }
    let upfrontBytes = originalRequirements.referencedFiles.reduce((sum, source) => sum + (source.mandatory === false ? 0 : source.bytes), 0);
    for (const { path: ref, declaredBy, issue, sha256: hash, lines, bytes, originalBase64 } of governed.values()) {
      const problem = unavailable.has(ref) ? 'SOURCE_UNAVAILABLE' : issue;
      const source = { ref, declaredBy, sha256: hash, lines, bytes, parts: [], ...(problem ? { issue: problem } : {}) };
      acceptanceSources.push(source);
      if (problem) continue;
      let file = bound.get(ref);
      if (!file) {
        file = typeof originalBase64 === 'string' ? (await frozenOriginal(ref, originalBase64)).file : await originalPath(ref);
        if (!file) { source.issue = 'SOURCE_UNAVAILABLE'; continue; }
        const upfront = upfrontBytes + bytes <= MANDATORY_REFERENCE_BYTES;
        originalSources.set(file, { kind: 'MATERIAL', ref, sha256: hash, readHash: hash, lineOffset: 0, optional: !upfront });
        if (upfront) { basisFiles.push(file); upfrontBytes += bytes; }
      }
      source.parts.push({ file, offset: 0, length: lines, hash });
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
  const declaredSources = acceptanceSources.map(({ ref, parts, issue, declaredBy }) => declaredBy
    ? { ref, file: parts[0]?.file, issue, declaredBy } : { ref, parts: parts.length });
  const governedRefs = new Set(declaredSources.map(source => source.ref));
  const optionalContext = optionalSources.filter(source => !governedRefs.has(source.ref));
  await parts(basisRoot, 'original-basis', { ...(originalRequirements ? { sources: [...originalSources].filter(([, source]) => !source.optional).map(([file, { kind, ref, part, lineOffset }]) =>
    ({ file, kind, ref, ...(part ? { part, lineOffset } : {}) })),
    ...(optionalContext.length ? { optionalSources: optionalContext } : {}),
    ...(declaredSources.length ? { acceptanceSources: declaredSources } : {}),
    ...(Array.isArray(originalRequirements.referenceMaterials) ? { referenceMaterials } : {}) } : { groundTruth: truth }),
    request: { hook: input.request.hook, instructions: input.request.instructions, workflowStages: input.request.workflowStages,
      metricDefinitions: Object.fromEntries(Object.entries(METRIC_CATALOG).filter(([id]) => originalRequirements
        ? input.request.population.reviewPolicy?.metrics[id] !== false : input.request.population.metrics[id]?.length)) },
    ...(!originalRequirements ? { originalUserMessages: originalUsers } : {}),
    latestAssistant: [...entries].reverse().find(entry => entry.type === 'assistant') ?? input.request.hook }, true);
  let { basis: requirementFrame, reason: frameAbsent } = input.request.requirementFrame ?? {};
  if (requirementFrame) {
    try { basisFiles.push(...await parts(basisRoot, 'requirement-frame', requirementFrame)); }
    catch { requirementFrame = null; frameAbsent = 'FRAME_BASIS_UNAVAILABLE'; }
  }
  const entryPaths = new Map(), invocationFiles = new Map(), executionCalls = new Map(), historyEvents = new Map(), historicalOrders = new Map();
  const processRepairs = new Map();
  const environmentExceptions = new Map();
  const originalUserEntries = new Set(originalUsers), originalUserProcessFiles = [];
  const toolCalls = new Set(entries.filter(entry => entry.type === 'assistant').flatMap(entry => Array.isArray(entry.message?.content)
    ? entry.message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []));
  const isExecutionRecord = entry => entry.type === 'user' && Array.isArray(entry.message?.content)
    && entry.message.content.some(block => block.type === 'tool_result' && toolCalls.has(block.tool_use_id));
  const programExecution = value => { const verification = value?.deviceEvidence?.verification ?? value?.verification;
    return ['build', 'smoke'].some(key => ['passed', 'failed'].includes(verification?.[key]?.status)); };
  const executionResults = new Map();
  for (const [index, entry] of entries.entries()) {
    const files = await parts(processRoot, String(index).padStart(6, '0'), entry, false, isExecutionRecord(entry)); entryPaths.set(index, files);
    if (originalUserEntries.has(entry)) originalUserProcessFiles.push(...files);
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === 'assistant') for (const block of blocks.filter(block => block.type === 'tool_use')) {
      invocationFiles.set(block.id, invocationFiles.has(block.id) ? null : files);
      if (historyEvents.has(block.id)) historyEvents.get(block.id).ambiguous = true;
      else historyEvents.set(block.id,{callIndex:index,callDigest:sha256(block)});
    }
    if(isExecutionRecord(entry))for(const block of blocks.filter(block=>block.type==='tool_result')) {
      const event=historyEvents.get(block.tool_use_id);
      if(event) {
        if (event.resultIndex !== undefined) event.ambiguous = true;
        Object.assign(event,{resultIndex:index,resultDigest:sha256(block),successful:successfulHistoricalResult(block)});
      }
    }
    if (isExecutionRecord(entry)) for (const file of files) {
      executionCalls.set(file, blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
      executionResults.set(file, blocks);
    }
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
  const currentFile = file => !attachmentPaths.has(file) || basisFiles.includes(file) || protectedInputs.has(file)
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
  async function bindRegressionRun(run) {
    if (regressionRun) {
      if (run === regressionRun || run.key && run.key === regressionRun.key && run.status === regressionRun.status) return;
      throw taskError('STOP_REVIEW_INPUT_CHANGED', 'The original-test execution basis changed during this review; restart against the current candidate.');
    }
    regressionRun = run;
    if (run.baselineFile && run.baselineSha256) protectedInputs.set(await fs.realpath(run.baselineFile), run.baselineSha256);
    regressionRunFiles = await parts(basisRoot, 'regression-check', renderRegressionRun(run), false, false, true);
    if (run.status === 'FAILED') {
      failureInventory = regressionFailureInventory(run);
      if (failureInventory.complete) {
        const start = await readJson(taskStartManifestPath(projectRoot, input.taskId)).catch(() => null);
        const tests = await collectRegressionFailureTests({ projectRoot, start, failures: failureInventory.failures, signal: session.signal });
        const originalFiles = new Map();
        for (const [index, failure] of failureInventory.failures.entries()) {
          const test = tests.get(failure.id);
          if (!test) continue;
          const { body, context = body, source, ...location } = test;
          if (!originalFiles.has(location.path)) originalFiles.set(location.path,
            await parts(basisRoot, `original-test-source-${index}`, source, false, false, true));
          const files = await parts(basisRoot, `regression-case-${index}`, context, false, false, true);
          // Supply the decisive original setting with the existing case. The
          // reviewer need not reconstruct it from a changed test or fill in a
          // new proof schema. Later assertions remain visible after an early fail.
          failure.originalTest = { ...location, file: files[0], files, sha256: sha256(context), context,
            sourceFiles: originalFiles.get(location.path), sourceSha256: sha256(source) };
        }
      }
    }
  }
  if (originalRequirements && population.reviewPolicy?.metrics.M16 !== false) {
    const evidence = await collectRegressionEvidence({ projectRoot, excluded: [controlRoot, ...excluded],
      artifacts: input.request.workflowArtifacts ?? [], signal: session.signal, active: () => session.active(),
      taskChanges: input.request.taskChanges ?? null });
    if (evidence.triggered) {
      const [file] = await parts(basisRoot, 'standing-obligations', STANDING_OBLIGATIONS_TEXT, true, false, true);
      standingSource = { file, sha256: sha256(await fs.readFile(file)) };
      regression = evidence;
      regressionFiles = await parts(basisRoot, 'regression-evidence', renderRegressionEvidence(evidence), false, false, true);
      // A configured original-test run precedes the model's checklist and cannot be
      // silently omitted by changing review mode or selecting a smaller scope.
      const prepared = await input.onPrepareRegression?.({ metrics: { M16: [standingRegressionItem(standingSource)] },
        reviewPolicy: population.reviewPolicy });
      if (prepared) await bindRegressionRun(prepared);
    }
  }
  const followUps = new Map(), followUpResults = new Map();
  if (originalRequirements) {
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
  const executionVersions = new Map();
  function versionsFor(file) {
    if (!executionResults.has(file)) return [];
    if (!executionVersions.has(file)) executionVersions.set(file, executionResults.get(file).map(outputIdentity).filter(Boolean));
    return executionVersions.get(file);
  }
  const currentExecution = ref => ref.readProof.executionEvidence &&
    (versionsFor(ref.path).length > 0 || !executionCalls.has(ref.path));
  const receiptCitations = async (ctx, ids, owner, object, direct = []) => {
    const refs = await resolveStopCitations(ctx, { citeIds: ids ?? [], citations: direct }, projectRoot,
      { attachment: true, allowedFiles: [...originalSources.keys(), ...skillDependencies.keys()] });
    for (const ref of refs) for (const version of versionsFor(ref.path)) {
      if (!refs.some(c => inside(projectRoot,c.path) && !programOwned(c.path) && !originalSources.has(c.path)
        && matchesCurrentIdentity(version,c.exactQuote)))
        throw taskError('TASK_CITATION_INVALID','Versioned execution lacks a matching current delivery identity. Attach the current manifest field and matching result, or mark it UNVERIFIED.');
    }
    return refs.map(ref => {
      const sourceOwned = sourceCode.test(ref.path) && reviewProofOwners(object).includes('SOURCE')
        && (!testSource(path.relative(projectRoot, ref.path)) || object?.programStanding === STANDING_REGRESSION || object?.metricId === 'M12'
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
        ...(ref.rangeKind === 'bytes' ? { rangeKind: 'bytes', byteStart: ref.byteStart, byteEnd: ref.byteEnd, excerptSha256: ref.excerptSha256 } : {}),
        frozen: inside(basisRoot, ref.path) || processFiles.has(ref.path), start: ref.start, end: ref.end,
        selection: `${ref.path}#L${ref.start}-L${ref.end}`, usedBy: [owner],
        readProof: { version: 1, protocol: 'stop-citation-v2-mechanical', observed: false, basisComplete: false, owner: proofOwner, fullFile, activationFact,
          executionEvidence: executionFiles.has(ref.path) && (!executionCalls.has(ref.path) || executionCalls.get(ref.path).some(id =>
            invocationFiles.get(id)?.every(file => { const metadata = ctx.evidence.snapshot.get(file);
              return metadata && covers(ctx.evidence.reads, file, 1, metadata.lines); }))) }, citeId: ref.citeId };
    });
  };
  const tool = (name, description, parameters, submit) => ({ name, label: name, description, parameters, submit });
  const processGuide = () => ({ navigationOnly: true,
    originalUserFiles: originalUserProcessFiles.slice(0, 3), originalUserFileCount: originalUserProcessFiles.length,
    executionResultFileCount: executionFiles.size,
    executionSamples: [...executionFiles].slice(0, 3).map(resultFile => {
      const calls = executionCalls.get(resultFile) ?? [], invocations = [...new Set(calls.flatMap(id => invocationFiles.get(id) ?? []))];
      return { resultFile, invocationFiles: invocations.slice(0, 3), invocationFileCount: invocations.length };
    }),
    instruction: 'These are source_read pointers, not proof. Use originalUserFiles for original task inputs/applicability. Execution PASS/DEVIATION needs a matching invocation and result or actual program verification. No attributed result means UNVERIFIED for an applicable execution obligation. Samples are partial; source_ls can discover the remaining process files.',
  });
  const evidenceHint = object => {
    const prefix = `Item ${object.objectId} requires ${reviewProofOwners(object).join('/')} evidence.`;
    if (requiresExecutionResult(object)) return `${prefix} Read an original invocation and matching result with source_read; source code and completion messages cannot prove execution. ${executionFiles.size === 0
      ? 'No attributable execution-result file is available in this review; use UNVERIFIED when execution is unproven.'
      : `Use review_checklist.processEvidence.executionSamples to locate results and invocations; ${executionFiles.size} result files are available, but must still match this obligation.`}`;
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
    regressionCheck: regressionDisposition && { ...regressionDisposition, failureInventory } });
  const projectResult = (ctx, summary) => ({ summary, ...classification, findings: structuredClone(findings.filter(finding => !pendingProcessFinding(finding))),
    metricObjectJudgements: classifiedRows().map(({ environmentUnexecutable, ...row }) => row), fileAssessments: [...files.values()],
    unverifiedItems: [...unresolvedReview().items, ...citationIssues.values(),
      ...findings.filter(pendingProcessFinding).map(finding => ({
      id: `finding:${finding.deviationKey}`, type: 'PROCESS_CLASSIFICATION', reason: 'The proposed process finding has no classified current repairable residue.' }))], citationDiagnostics: structuredClone(citationDiagnostics),
    ...(frameAbsent ? { frameCoverage: { status: 'absent', reason: frameAbsent } } : {}),
    citations: structuredClone(citations), proofs: structuredClone(proofs),
    reviewEvidence: { citationAttachments: true, unstable: false, expectedFiles: structuredClone(expectedFileChecks), files: [...new Set([...ctx.evidence.snapshot.keys()].filter(currentFile).concat([...skillDependencies.keys(), ...protectedInputs.keys()]))], missing: [],
      readPaths: { ...Object.fromEntries([...ctx.evidence.resolutions].filter(([, real]) => currentFile(real))), ...Object.fromEntries(skillReadPaths) },
      fingerprints: { ...Object.fromEntries([...ctx.evidence.snapshot].filter(([file]) => currentFile(file)).map(([file, metadata]) => [file, metadata.sha256])),
        ...Object.fromEntries(skillDependencies),
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
  let submittedChecklist;
  const originalItemSchema = schema({
    metricId: { type: 'string', enum: Object.keys(METRIC_CATALOG).filter(id => id !== 'M08' && population.reviewPolicy?.metrics?.[id] !== false) },
    text, verificationTarget: { type: 'string', enum: ['ARTIFACT', 'PROCESS', 'IMPLEMENTATION'] },
    implementationRole: { type: 'string', enum: ['PRODUCTION', 'TEST', 'SUPPORT'] }, applicability: text,
    expectedFiles: EXPECTED_FILES_SCHEMA, path: { type: 'string' }, citeId: text,
    lineStart: { type: 'integer', minimum: 1 }, lineEnd: { type: 'integer', minimum: 1 },
  }, ['metricId', 'text', 'verificationTarget', 'lineStart', 'lineEnd']);
  const sealFields = acceptanceSources.length ? {
    noApplicableSources: { type: 'array', items: schema({ ref: text, reason: text }, ['ref', 'reason']) },
    unextractedRanges: { type: 'array', items: schema({ ref: text, start: { type: 'integer', minimum: 1 },
      end: { type: 'integer', minimum: 1 } }, ['ref', 'start', 'end']) },
  } : {};
  const inspectedItems = new Set();
  let incrementalSeal = false, partialBatch = false;
  // Only extraction work crosses Stop boundaries. Current candidate findings must be rechecked.
  const handoffKey = originalRequirements && sha256([originalRequirements.digest, population.reviewPolicy,
    [...originalSources.values()].map(s => [s.kind, s.ref, s.part, s.readHash])]);
  const handoffDir = handoffKey && path.join(path.dirname(path.dirname(directory)), 'extraction', handoffKey);
  let resumed = null;
  if (handoffDir) {
    const names = await fs.readdir(handoffDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const record = await readJson(path.join(handoffDir, name));
      if (record?.key === handoffKey && (!resumed || record.work > resumed.work || record.work === resumed.work && record.items.length > resumed.items.length)) resumed = record;
    }
  }
  const resumedReads = [], resumedDelivered = [];
  const resumedSources = new Map();
  for (const range of [...resumed?.ranges ?? [], ...resumed?.delivered ?? []]) {
    const file = [...originalSources].find(([,source]) => source.ref === range.ref &&
      source.readHash === range.hash && source.part === range.part)?.[0];
    if (!file) throw taskError('STOP_TASK_INPUT_CHANGED', 'Cannot bind the extracted original.');
    if (!resumedSources.has(file)) {
      const bytes = await fs.readFile(file);
      if (sha256(bytes) !== range.hash) throw taskError('STOP_TASK_INPUT_CHANGED', 'Extraction source changed.');
      resumedSources.set(file, { sha256: range.hash, lines: bytes.reduce((n,b) => n + Number(b === 10),1) });
      protectedInputs.set(file, range.hash);
    }
    if (range.start > range.end || range.start < 1 || range.end > resumedSources.get(file).lines)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'Persisted original coordinates are invalid.');
    const collection = resumed.delivered?.includes(range) ? resumedDelivered : resumedReads;
    collection.push({ path: file, start: range.start, end: range.end });
  }
  const resumeOffsets = new Map();
  for (const [file, source] of originalSources) {
    const delivered = resumedDelivered.filter(range => range.path === file);
    const hasExtractedItem = resumed?.extracted?.some(range => range.ref === source.ref && range.hash === source.readHash && range.part === source.part);
    if (!hasExtractedItem || !delivered.length) continue;
    let next = 1;
    for (const range of delivered.sort((a,b) => a.start - b.start)) {
      if (range.start > next) break;
      next = Math.max(next, range.end + 1);
    }
    if (next > 1 && next <= resumedSources.get(file).lines) resumeOffsets.set(file, next);
  }
  const resumePage = (offset = 0, limit = 12) => ({
    ranges: resumedReads.slice(offset, offset + limit), totalRanges: resumedReads.length,
    nextRangeOffset: offset + limit < resumedReads.length ? offset + limit : null,
  });
  if (resumed) task.extractionResume = { ...resumePage(), items: resumed.items.length,
    nextReads: [...resumeOffsets].slice(0, 12).map(([file, offset]) => ({ path: file, offset })),
    next: 'For each nextReads path omit offset on its first source_read. New pages start after the previously delivered prefix. Earlier delivered ranges can still contain unextracted requirements; use original_checklist_progress and explicit offsets to close them. Recheck all candidate evidence.' };
  const extractionEvidence = evidence => resumed ? {
    reads: [...resumedReads, ...evidence.reads], snapshot: new Map([...resumedSources, ...evidence.snapshot]),
  } : evidence;
  const acceptanceFiles = new Set(acceptanceSources.flatMap(source => source.parts.map(part => part.file)));
  function requireReviewBasis(ctx, partial = partialBatch) {
    if (!partial && !resumed) return ctx.requireBasis();
    const reads = extractionEvidence(ctx.evidence).reads;
    for (const file of basisFiles) {
      if (partial && acceptanceFiles.has(file)) continue;
      const meta = ctx.evidence.snapshot.get(file) ?? resumedSources.get(file);
      if (!meta || !covers(reads,file,1,meta.lines))
        throw taskError('TASK_BASIS_UNREAD', 'Mandatory source range pending: ' + file);
    }
  }
  const batches = createOriginalBatches({ projectRoot, originals: originalSources,
    sourceDigest: originalRequirements?.digest, restored: resumed?.items, sealed: () => Boolean(reviewBasis), validate: {
      directReview: deviationOnly && acceptanceSources.length > 0,
      population: items => buildOriginalStopPopulation({ population, checklist: items, sourceDigest: originalRequirements.digest }),
      async expectedFiles(item, value, ctx) {
        const file = value.path ? ctx.evidence.resolutions.get(path.resolve(projectRoot, value.path)) : ctx.evidence.registry.get(value.citeId)?.path;
        const originalText = excerpt(await fs.readFile(file), value.lineStart, value.lineEnd).text;
        item.expectedFiles = normalizeExpectedFiles(normalizeExpectedFiles(item.expectedFiles, originalText), item.text);
      },
    } });
  const progressFile = handoffDir && path.join(handoffDir, path.basename(directory) + '.json');
  function saveExtractionProgress(evidence, ranges = []) {
    const reference = (file, start, end) => {
      const original = originalSources.get(file);
      return { ref: original.ref, hash: original.readHash, part: original.part, start, end };
    };
    const delivered = mergeExtractionRanges([...resumed?.delivered ?? [], ...evidence.reads
      .filter(read => originalSources.get(read.path)?.readHash === evidence.snapshot.get(read.path)?.sha256 && originalSources.has(read.path))
      .map(read => reference(read.path, read.start, read.end))]);
    const extracted = mergeExtractionRanges(batches.items.flatMap(item => {
      const binding = [...originalSources].find(([, source]) => source.ref === item.source.ref && source.part === item.source.part
        && source.sha256 === item.source.sha256);
      if (!binding) return [];
      const [file, source] = binding;
      return [reference(file, item.source.start - source.lineOffset, item.source.end - source.lineOffset)];
    }));
    const processed = mergeExtractionRanges([...resumed?.ranges ?? [], ...ranges]);
    const work = delivered.reduce((count, range) => count + range.end - range.start + 1, 0)
      + processed.reduce((count, range) => count + range.end - range.start + 1, 0);
    return { key: handoffKey, ranges: processed, delivered, extracted, items: batches.items, work };
  }
  if (resumed && task.extractionResume) {
    task.extractionResume.assigned = batches.status(0, 12).assigned.map(({ taskId }) => taskId);
    task.extractionResume.extractedRanges = resumed.extracted?.slice(0, 12) ?? [];
    task.extractionResume.deliveredRanges = resumedDelivered.slice(0, 12);
  }
  const noApplicableSources = new Map();
  const pendingExtraction = new Map();
  function markUnextracted(ref, start, end) {
    if (!pendingExtraction.has(ref)) pendingExtraction.set(ref, []);
    pendingExtraction.get(ref).push([start, end]);
  }
  const sourceCoverage = evidence => {
    const coverage = originalSourceCoverage(acceptanceSources, extractionEvidence(evidence), submittedChecklist, noApplicableSources, pendingExtraction);
    if (deviationOnly) retainLongSourceGaps(coverage, acceptanceSources, submittedChecklist);
    if (coverage && partialBatch) { coverage.complete = false; coverage.checklistSubmitted = false; }
    if (coverage && submittedChecklist && !classification) coverage.awaitingScopeSelection = submittedChecklist.length;
    return coverage;
  };
  const bindChecklist = async (items, ctx) => {
    const checklist = [];
    for (const { citeId, path: sourcePath, lineStart, lineEnd, ...item } of items) {
      const [receipt] = await resolveStopCitations(ctx, sourcePath ? { citations: [{ path: sourcePath, start: lineStart, end: lineEnd }] }
        : { citeIds: [citeId] }, projectRoot, { allowedFiles: [...originalSources.keys()] });
      const original = originalSources.get(receipt.path);
      if (!original || receipt.sha256 !== original.readHash || lineStart < receipt.start || lineEnd > receipt.end || lineStart > lineEnd)
        throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', 'Select an allowed original source path and exact original line range');
      const { kind, ref, part, sha256: hash, lineOffset } = original;
      if (item.expectedFiles?.length) {
        const originalText = excerpt(await fs.readFile(receipt.path), lineStart, lineEnd).text;
        item.expectedFiles = normalizeExpectedFiles(normalizeExpectedFiles(item.expectedFiles, originalText), item.text);
      }
      checklist.push({ ...item, source: { kind, ref, ...(part ? { part } : {}), sha256: hash,
        start: lineStart + lineOffset, end: lineEnd + lineOffset } });
    }
    return checklist;
  };
  const setOriginalChecklist = async ({ items, noApplicableSources: explanations = [], unextractedRanges = [], partial = false, extractedRanges = [] }, ctx, staged = false) => {
    if (partial && (!staged || !deviationOnly || !batches.size || !acceptanceSources.length))
      throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID','Partial review requires a saved batch of original obligations.');
    try { requireReviewBasis(ctx, partial); }
    catch (error) {
      if (error.code === 'TASK_BASIS_UNREAD' && !partial && staged && deviationOnly && batches.size && acceptanceSources.length)
        error.message += '. If an extracted item has counterevidence, call submit_review directly with its receipt taskId, stopClassification and completionClaim now. Use original_checklist_progress to recover IDs.';
      throw error;
    }
    if (batches.size && !staged && !reviewBasis) throw taskError('TASK_SUBMISSION_CONFLICT', 'Seal the saved original batches first.');
    if (reviewBasis) {
      // A rejected append may identify a real obligation outside the sealed checklist.
      // Preserve that gap without changing the existing population or its verdicts.
      if (acceptanceSources.length) {
        const attempted = await bindChecklist(items, ctx).catch(() => []);
        for (const item of attempted) if (!submittedChecklist.some(saved => saved.metricId === item.metricId && saved.text === item.text
          && saved.source.ref === item.source.ref && saved.source.start === item.source.start && saved.source.end === item.source.end))
          markUnextracted(item.source.ref, item.source.start, item.source.end);
      }
      throw taskError('TASK_SUBMISSION_CONFLICT', 'The original requirements checklist is already set');
    }
    for (const [file, source] of originalSources) {
      const observed = ctx.evidence.snapshot.get(file) ?? resumedSources.get(file);
      if (source.optional || partial && acceptanceFiles.has(file) && !observed) continue;
      if (observed?.sha256 !== source.readHash)
        throw taskError('STOP_TASK_INPUT_CHANGED', 'An original requirements source changed during preparation');
    }
    const checklist = staged ? batches.items : await bindChecklist(items, ctx);
    if (standingSource && ctx.evidence.snapshot.get(standingSource.file)?.sha256 !== standingSource.sha256)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'A program standing obligation changed during preparation');
    const build = items => buildOriginalStopPopulation({ population, checklist: items, sourceDigest: originalRequirements.digest,
      ...(standingSource ? { standing: [standingRegressionItem(standingSource)] } : {}) });
    let basis = build(checklist);
    const existing = new Set(Object.values(basis.population.metrics).flat().map(object => object.objectId));
    const carry = [...followUps.values()].map(entry => entry.object).filter(object => object.originalSource && !object.programStanding && !existing.has(object.objectId));
    const carried = new Set(carry.map(object => object.objectId));
    const seeds = proposedSeeds.filter(seed => !existing.has(seed.objectId) && !carried.has(seed.objectId)).map(seed => seed.item);
    if (carry.length || seeds.length) basis = build([...carry.map(object => ({
      metricId: object.metricId, text: object.description, source: object.originalSource,
      verificationTarget: object.verificationTarget, implementationRole: object.implementationRole, expectedFiles: object.expectedFiles,
      applicability: object.applicabilityKind === 'CONDITIONAL' ? object.applicability : undefined,
    })), ...seeds, ...checklist]);
    const explained = new Set();
    for (const { ref } of explanations) {
      const source = acceptanceSources.find(entry => entry.ref === ref);
      if (!source || source.issue || explained.has(ref) || !source.parts.every(({ file, length, hash }) =>
        ctx.evidence.snapshot.get(file)?.sha256 === hash && covers(ctx.evidence.reads, file, 1, length))
        || checklist.some(item => item.source.ref === ref))
        throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', 'A no-applicable-requirement explanation requires a fully read, unrepresented original.');
      explained.add(ref);
    }
    for (const { ref, start, end } of unextractedRanges) {
      const source = acceptanceSources.find(entry => entry.ref === ref);
      if (!source || source.issue || explained.has(ref) || !Number.isInteger(start) || !Number.isInteger(end)
        || start < 1 || end < start || end > source.lines)
        throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', 'Identify a known original and valid original lines still to be extracted.');
    }
    if (explanations.length) basis.noApplicableSources = explanations;
    if (unextractedRanges.length) basis.unextractedRanges = unextractedRanges;
    if (staged) basis.extraction = { mode: 'incremental', sourceDigest: originalRequirements.digest, items: checklist.length };
    if (partial) {
      const ranges = [];
      for (const range of extractedRanges) {
        const file = path.resolve(projectRoot, range.path);
        const src = originalSources.get(file);
        const meta = ctx.evidence.snapshot.get(file);
        if (!src || !meta || meta.sha256 !== src.readHash || range.start > range.end || range.end > meta.lines ||
            !covers(ctx.evidence.reads, file, range.start, range.end))
          throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID','Only acknowledged original lines may be marked extracted.');
        ranges.push({ ref: src.ref, hash: src.readHash, part: src.part, start:range.start, end:range.end });
      }
      await ctx.persist(path.relative(directory, progressFile), saveExtractionProgress(ctx.evidence, ranges));
      await ctx.persist('partial-checklist.json', basis);
      partialBatch = true;
    } else await ctx.persist('original-checklist.json', basis);
    for (const { ref, reason } of explanations) noApplicableSources.set(ref, reason);
    for (const { ref, start, end } of unextractedRanges) markUnextracted(ref, start, end);
    submittedChecklist = checklist;
    incrementalSeal = staged;
    reviewBasis = basis; population = basis.population; truth = basis.groundTruth;
    allObjects = Object.values(population.metrics).flat();
    return { saved: true, items: allObjects.length, next: 'review_checklist' };
  };
  const selectScope = async (value, ctx, afterScope) => {
    requireReviewBasis(ctx);
    if (originalRequirements && !reviewBasis) throw taskError('STOP_ORIGINAL_CHECKLIST_REQUIRED', 'Use set_original_checklist before selecting the scope');
    validateStopClassification(value, { contract: task.classificationContract, allowedStages: task.allowedStages });
    const frame = { stopClassification: value.stopClassification, stage: value.stopClassification === 'STAGE_COMPLETE' ? value.stage ?? null : null };
    if (classification) {
      if (sha256(classification) !== sha256(frame)) throw taskError('TASK_SUBMISSION_CONFLICT', 'The Stop scope is already fixed');
      return { ...classification, reused: true, items: selected.length, files: qualityTargets.length,
        ...processNavigation(selected, value.includeProcessEvidence), next: 'review_checklist' };
    }
    if (task.fixedStopClassification && (task.fixedStopClassification.stopClassification !== value.stopClassification
      || (task.fixedStopClassification.stage ?? null) !== frame.stage)) throw taskError('STOP_STAGE_SCOPE_INVALID', 'The verification caller fixed this scope');
    if (value.stopClassification === 'STAGE_COMPLETE' && task.allowedStages.length && !task.allowedStages.includes(value.stage))
      throw taskError('STOP_STAGE_SCOPE_INVALID', 'Unknown workflow stage');
    const objects = Object.values(selectStopPopulation(population, frame, input.request.workflowArtifacts).metrics).flat();
    if (input.deferScopeVerification && input.onScope) {
      ctx.deferCompletion(async continued => {
        await prepareScope(value, frame, objects, continued);
        if (afterScope) {
          try { await afterScope(continued); }
          catch (error) {
            if (!['TASK_CITATION_INVALID','REVIEW_ITEM_OWNERSHIP_INVALID','TASK_SUBMISSION_CONFLICT'].includes(error.code)) throw error;
            return 'Scope verification finished. Correct the early submission: ' + error.message;
          }
          return 'The early item was processed. Inspect its saved result before continuing.';
        }
        return 'Program-owned scope verification has completed outside the native tool call. The original scope, read receipts and review budget are retained. Use review_checklist without classification fields to inspect its results and continue the same review; do not recreate the original checklist.';
      });
      return { deferred: true, scopeSelected: false, next: 'review_checklist',
        reason: 'Program-owned verification will run after this native call settles, then this same review resumes.' };
    }
    const receipt = await prepareScope(value, frame, objects, ctx);
    return afterScope ? afterScope(ctx) : receipt;
  };
  async function prepareScope(value, frame, objects, ctx) {
    ctx.active();
    let verification = await input.onScope?.(frame, ...(reviewBasis ? [reviewBasis] : []));
    ctx.active();
    if (verification?.regressionCheck) {
      const { regressionCheck: run, ...rest } = verification;
      verification = rest;
      await bindRegressionRun(run);
    }
    const projectCheckFiles = [];
    if (verification?.projectChecks) {
      const { projectChecks, ...rest } = verification;
      verification = rest;
      for (const check of projectChecks.checks ?? []) projectCheckFiles.push(...await parts(processRoot,
        `project-check-${check.id}`, { ...check, notice: projectChecks.notice }, false,
        check.executionConfirmed === true && ['PASSED', 'FAILED'].includes(check.status)));
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
    indexGroupChecks(objects);
    qualityTargets = [...new Map(targets.map(file => [file.path, file])).values()];
    programEvidenceFiles = [...projectCheckFiles, ...(verification
      ? await parts(processRoot, 'program-verification-on-scope', verification, false, programExecution(verification)) : [])];
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

  const groupedObjects = new Set();
  function indexGroupChecks(objects) {
    if (!deviationOnly || !acceptanceSources.length) return;
    const originals = new Map();
    for (const object of objects) {
      const source = object.originalSource;
      if (!source) continue;
      if (requiresExecutionResult(object)) groupedObjects.add(object.objectId);
      const key = sha256([source.ref, source.sha256, source.part]);
      if (!originals.has(key)) originals.set(key, []);
      originals.get(key).push({ id:object.objectId, start:source.start, end:source.end });
    }
    // Both an umbrella clause and the independent obligations it encloses
    // need a disposition. One actual comparison can cover a group.
    for (const ranges of originals.values()) {
      ranges.sort((a,b) => a.start - b.start || b.end - a.end);
      let outer;
      for (const range of ranges) {
        if (!outer || range.end > outer.end) outer = range;
        else if (range.start !== outer.start || range.end !== outer.end) {
          groupedObjects.add(outer.id);
          groupedObjects.add(range.id);
        }
      }
    }
  }
  const needsGroupCheck = object => groupedObjects.has(object.objectId);
  const completeReview = async (ctx, summary, frameCoverage, checkedGroups) => {
    const checked = new Set();
    for (const group of checkedGroups) {
      for (const id of group.taskIds) {
        const object = selected.find(o => o.objectId === id);
        if (!object || !needsGroupCheck(object)) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID','Unknown grouped check.');
        const refs = await receiptCitations(ctx,[],id,object,group.citations);
        if (!refs.some(c => requiresExecutionResult(object) ? currentExecution(c) : ['SOURCE','ARTIFACT'].includes(c.readProof.owner)))
          throw taskError('TASK_CITATION_INVALID','Group check needs current execution or delivery evidence for its subject.');
        for (const ref of refs) protectedInputs.set(ref.path,ref.contentHash);
        checked.add(id);
      }
    }
    if (checkedGroups.length) await ctx.persist('checked-groups.json',checkedGroups);
    const result = projectResult(ctx, summary);
    const coverage = sourceCoverage(ctx.evidence);
    if (coverage) {
      result.sourceCoverage = coverage;
      result.unverifiedItems.push(...unverifiedSources(coverage));
    }
    for (const object of selected) if ((partialBatch || needsGroupCheck(object)) && !checked.has(object.objectId)
      && !rows.has(object.objectId) && !followUpResults.has(object.objectId)) {
      result.unverifiedItems.push({id:object.objectId,objectId:object.objectId,type:'REQUIREMENT',
        reviewState:'UNREVIEWED',reason:'尚待核对：' + object.description});
    }
    if (frameCoverage) result.frameCoverage = frameCoverage;
    if(historicalOrders.size)await ctx.persist('historical-orders.json',[...historicalOrders.values()]);
    if(processRepairs.size)await ctx.persist('process-repairs.json',[...processRepairs.values()]);
    if (environmentExceptions.size) await ctx.persist('environment-unexecutable.json', [...environmentExceptions.values()]);
    result.unverifiedItems.push(...(frameCoverage?.items ?? []).filter(item => item.disposition === 'UNVERIFIED')
      .map(({ id, type, reason }) => ({ id, type, reason })));
    result.regressionCheck = { cases: [...regressionDisposition?.cases ?? [],
      ...regressionRun?.triage?.cases.filter(item => item.type === 'PRE_EXISTING_FAILURE')
        .map(({ id, type, reason }) => ({ id, verdict: type, reason })) ?? []],
      triage: regressionRun?.triage?.cases.map(({ id, type, reason, isolationObserved }) =>
        ({ id, type, reason, ...(isolationObserved ? { isolationObserved } : {}) })) ?? [] };
    result.reviewCoverage = stopReviewCoverage({ requirements: selected, judgements: classifiedRows(),
      followUps: [...followUpResults.values()].map(classifiedRow), fileAssessments: [...files.values()], regressionCases: result.regressionCheck.cases,
      frameItems: frameCoverage?.items, unverifiedItems: result.unverifiedItems });
    await ctx.persist('review.json', result);
    ctx.state.result = result;
    ctx.state.complete = true;
    return { saved: true, complete: true, items: rows.size, files: files.size, findings: findings.length };
  };
  const saveRegressionDisposition = async (ctx, disposition, mapped) => {
    await ctx.persist('regression-check-review.json', { ...disposition, failureInventory, citations: mapped });
    regressionDisposition = structuredClone(disposition);
  };
  const finishReview = async (value, ctx) => {
    requireReviewBasis(ctx);
    if (incrementalSeal) {
      const unseen = selected.filter(item => !inspectedItems.has(item.objectId) && !rows.has(item.objectId));
      if (unseen.length) throw taskError('REVIEW_ITEM_INCOMPLETE',
        `Page review_checklist before finishing. ${unseen.length} original items have not been presented. Next offset: ${selected.indexOf(unseen[0])}.`);
    }
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
    const standing = selected.find(object => object.programStanding === STANDING_REGRESSION);
    if (standing && regressionRun && ['FAILED', 'UNAVAILABLE'].includes(regressionRun.status)
      && (!failureInventory?.complete || failureInventory.failures.length)) {
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
    return completeReview(ctx, value.summary, frameCoverage, value.checkedGroups ?? []);
  };

  const graphBudgetMs = Math.min(1500, Math.floor(((session.deadlineAt ?? Infinity) - Date.now()) / 10));
  const graph = graphBudgetMs >= 100 ? await buildSemanticGraph(projectRoot, {
    budgetMs: graphBudgetMs, signal: session.signal, excludedPaths: excluded,
    preferredPaths: input.request.taskChanges?.changes?.map(change => change.path),
  }).catch(() => { session.active(); return null; }) : null;
  const graphAvailable = graph?.files > 0;
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
      byteReading: Boolean(originalRequirements),
      trackFile: file => !programOwned(file) || originalEvidence(file),
      currentFile,
      resumeOffset: (file, hash) => originalSources.get(file)?.readHash === hash && resumeOffsets.get(file),
    },
    signal: session.signal, deadlineAt: session.deadlineAt, nativeRun: session.run, assertCurrent: current,
    limits: input.taskLimits ?? STOP_TASK_LIMITS,
    definition: {
      retainInterruptedResult: true,
      initialInstruction: originalRequirements && deviationOnly
        ? 'Read the Stop instructions and current request first. Extract each mandatory source in batches. Use submit_review directly with the saved taskId and counterevidence before any further extraction or sealing. On continuation reuse version-bound extraction ranges and reassess the current candidate.' : undefined,
      async onSettled(ctx) {
        if (!progressFile || !acceptanceSources.length || !batches.size || ctx.state.complete) return;
        // Authoritative examined ranges written by the partial checklist must survive this final snapshot.
        const previous = await readJson(progressFile);
        await durableTaskJson(progressFile, saveExtractionProgress(ctx.evidence, previous?.ranges));
      },
      incompleteDetails: ctx => {
        const coverage = sourceCoverage(ctx.evidence);
        return coverage ? { sourceCoverage: coverage } : {};
      },
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
        'When a concrete defect is supported before all original pages are processed, use its append_original_checklist receipt taskId and call submit_review immediately with stopClassification, completionClaim, reason and current evidence. No seal or review_checklist call is needed. Optional extractedRanges identify fully processed source ranges. Its receipt ends the partial review for repair when it requires no process classification. On the next Stop use extractionResume and recheck the current candidate. Separate missing evidence from unexamined scope.',
        'An unavailable command remains UNVERIFIED unless finish_stop_review.environmentCommands names its exact original command and the program proves from the current host tool catalog that no available tool can execute it. Your capability claim is never that proof. Fixed build/test tools and unknown custom tools do not qualify for the exception.',
        'A proved past process-order inversion with no current repairable residue may be proposed in finish_stop_review.historicalOrders using two successful original tool-call IDs. It remains a historical deviation, is notified once without repair quota, and never becomes PASS. Missing events, simultaneous calls or a remaining repairable part do not qualify.',
        'Every proposed PROCESS deviation needs an explicit disposition before it can request repair, including already saved partial results: finish_stop_review.historicalOrders binds irreversible order facts; processRepairs names an actual current residue and useful remaining action. A statement that the past cannot be repaired is not a current residue. Missing required events leave an ordering claim UNVERIFIED; never invent events. Unclassified process rows/findings remain UNVERIFIED, including on context overflow. Use an assigned PROCESS row for historical order, not submit_finding. Real current process defects still require repair.',
        'Judge each original condition in context and report UNVERIFIED when its activation cannot be determined.',
        'One reviewer owns scope selection, source/artifact/process review, optional file quality, findings and the final checklist. Plan your own order; reuse each read across items. Do not spawn other agents.',
        'Citations are evidence attachments, never a completion gate. Only deviations sent to the host require citations: [{path,start,end}]. The program reads allowed files and binds their hashes and excerpts. Prior session reads and citeIds are not required. Tests, dependency sources and runtime output are eligible. Conforming, explained and unresolved conclusions need no citations. An invalid deviation attachment receives one repair error, then only that deviation becomes UNVERIFIED; valid siblings remain deliverable.',
        ...(originalRequirements ? [
          Array.isArray(originalRequirements.referenceMaterials)
            ? 'This Stop starts from original user messages, project instructions, files the user named and adopted Skill documents; these are the mandatory sources. Read them with source_read numbered:true. Save independent obligations with append_original_checklist as their pages arrive, submit any evidenced deviation directly; seal the full checklist only for final review. A single small source may still use set_original_checklist. The original basis also lists referenceMaterials: optional project context with its task-start status (UNCHANGED, MODIFIED, DELETED or ADDED). Read a reference only when an obligation needs its detail; for MODIFIED or DELETED read its frozenOriginal, the task-start copy. A reference never overrides the user messages, and its drift alone is not a deviation. Read the latest user clarification in context and apply only currently binding obligations. A file named as a deliverable is never its own requirement authority. Adopted Skill steps belong to M08; derive an item from a Skill document only when it supplies an independent obligation outside those steps.'
            : 'This Stop starts from original user messages, project instructions, referenced materials and adopted Skill documents. Read the mandatory sources with source_read numbered:true. Save independent obligations with append_original_checklist as their pages arrive, submit any evidenced deviation directly; seal the full checklist only for final review. A single small source may still use set_original_checklist. Read the latest user clarification in context and apply only currently binding obligations. A file named as a deliverable is never its own requirement authority. Adopted Skill steps belong to M08; derive an item from a Skill document only when it supplies an independent obligation outside those steps.',
          ...(optionalContext.length ? ['optionalSources are user-named files outside the mandatory reading budget. Read the sections an obligation needs and cite them like any original source.'] : []),
          ...(acceptanceSources.length ? ['The full originals listed in acceptanceSources, including required annexes, govern acceptance regardless of the upfront reading budget. Append each independently decidable requirement and later exception at its own original position while reading. A charter adopting an annex does not stand in for the annex items. Distinguish multiple records on one physical line using byteStart/byteEnd; source_read byteOffset/byteLimit returns exact original bytes. On native compaction, original_checklist_progress returns already saved entries; reread their original spans when needed. Identify known lines still to be extracted in unextractedRanges. For a fully read source with no independent applicable requirement, supply noApplicableSources with its ref and reason. Missing, partially read or unrepresented sources remain unverified.'] : []),
          'For each distinct mandatory requirement, choose its applicable enabled M01–M16 metric, give the precise obligation and verificationTarget, and bind the original path and exact lineStart/lineEnd (legacy citeId is still accepted). These offsets are local to the named file or part. Preserve all conditions, allowed inputs and exceptions. For a conditional obligation supply its exact activation condition separately. Add expectedFiles only when the original explicitly requires those exact files as outputs of this task. Use M16 for production paths, M12 PROCESS for explicitly required test execution, and M12 IMPLEMENTATION with implementationRole TEST for a required authored test. M08 already comes from the adopted Skill graph and uses its original Skill documents when reviewed. Do not create M08 items or replace Skill checks.',
          ...(standingSource ? ['This task changed existing source, so the program appends the standing REGRESSION item from the mandatory standing-obligations basis after set_original_checklist; never add it yourself. Its review_checklist entry carries regressionEvidence: changed hunks, pre-existing tests that reference changed identifiers, and any program-run existing-test result. Judge any deviation against pre-existing behavior and the requested changes. Cite relevant file/line evidence; issued read IDs and direct path/range references are both accepted. Behavior the request asked to change is not a regression. Pointers, a passing, timed-out or unlaunched run, or a missing test are never counterevidence.'] : []),
        ] : []),
        'For final review, read the remaining mandatory original basis. Early submission can precede this. Parts with the same name concatenate in filename order to their original JSON, preserving every condition and exception. Initialize once with review_checklist: supply stopClassification and the original reply\'s completionClaim (plus requiredUserInput/externalBlocker when relevant). Choose limit up to 20 to fit the checklist and response budget. Later pages or saved-result lookups omit classification fields; use offset/limit only. Never guess a completion claim. Separate review_scope remains available for complex workflows.',
        'Scope selection may return deferred:true while program-owned checks run between native calls. That is a handoff, not a result or an unresolved requirement. On resumption, use review_checklist without classification fields; keep the original checklist and continue with the prepared evidence.',
        'Explicit configured project acceptance checks may appear in programEvidenceFiles after scope selection. Read their actual source binding, candidate identity, exit, timeout and output before using them. Configuration does not create an obligation, a completed command does not prove every acceptance dimension, and unavailable or changed inputs remain UNVERIFIED. These program-owned observations can supply execution evidence without requiring a general host shell.',
        'Skip duties belonging to disabled metrics. Document deliverables and process rules do not become M16 production behavior. For a failed regression check, inspect each case in regressionEvidence.programRun.failureInventory independently, even if the failures share setup or a helper. Inspect the relevant task-start test assertions and setup. Trace the original inputs and service substitutes into the changed production path. Compare the failing expectation and the remaining assertions with the original user instructions. Pay attention to calls that fail or return missing or empty data.',
        'Program triage has removed only established task-start failures from reviewer explanations. A whole-suite failure that passes alone still needs review: changed setup, cleanup, call timing or a new real dependency can introduce an order-dependent regression. For each remaining failure, finish_stop_review.regressionCheck.cases accepts its exact id, verdict AUTHORIZED_CHANGE, REGRESSION or UNVERIFIED, and a reason. Judge authorization from the original request and actual setup. For a confirmed regression, first save its evidence-backed deviation and provide objectId. A changed mock is context, not authorization. Quotes, a full output read and production-only citations are not submission requirements. Unknown cases stay unresolved without blocking other conclusions.',
        'Check regressionEvidence.programRun.testSource before attributing a failure. TASK_START_PUBLIC_TESTS restores the original test tree and its setup/mocks; current test edits are not executed. Task-start excerpts are not current candidate source. Confirm a claimed current setup in current source, and never request an edit already present or one absent from the executed test tree. If the failure depends on original setup requiring behavior explicitly removed by the user, judge that authorization separately from unchanged production guards; do not infer a production regression solely from that setup. Unknown source or causality remains UNVERIFIED, not an automatic authorized change.',
        ...(deviationOnly ? [
          ...(followUps.size ? [
            'Previously delivered deviations are carried into this checklist with their original IDs. Do not recreate these same obligations in set_original_checklist: ' + JSON.stringify([...followUps.values()].map(({ object }) => object.description)),
            'Review the carried items first. Read current evidence and check the whole original obligation, including each independently observable effect and the prior counterexample. Use submit_review DEVIATION when it still fails, PASS when current evidence proves the fix, or UNVERIFIED when current evidence cannot settle it. PASS is allowed only for a carried item. Any unresolved item can receive UNVERIFIED and remains independently recorded. A prior reason and its paths are navigation, not current evidence.',
          ] : []),
          'Scan the full scoped checklist. Submit DEVIATION when concrete cited evidence contradicts that item; source_read before citation is optional. Omit conforming or inapplicable items; explicitly record unproved items as UNVERIFIED. Missing execution evidence alone is never counterevidence.',
          'Separate each failing expectation from its setup. A new dependency call, changed argument matching or call timing can make otherwise valid setup fail before an unrelated action is reached, even when public signatures are unchanged. Passing after a mock rewrite does not authorize the original failure. Caller unit tests intentionally bypass substituted callee implementations; their lack of callee execution is not evidence that a new caller-level read is required. Compare a placement behind the established boundary. Authorize a failure only from the request changing its observable expectation or valid input domain, not from the convenience of the chosen implementation. If the unchanged contract is contradicted, report the supported regression; if it cannot be established, record UNVERIFIED instead of treating the mock adjustment as an explanation.',
          'Before TASK_COMPLETE the checklist covers work already delivered. An unfinished, not-yet-started or user-pending obligation is not a deviation. Report only a concrete contradiction in code, documents or other work already present, with its counterevidence; an absent future output is not one.',
          'For conditional duties, tie the counterexample to the original condition, the actual operation and its observed effect. Follow the relevant production caller and callee when the counterexample is in source.',
          'Await the receipts for all submitted deviations, follow-ups and findings, then call finish_stop_review. Call it even when there were no deviations. Record unresolved items as UNVERIFIED, omit conforming items, and keep productionTrace optional.',
        ] : [
          `After receiving sufficient original evidence, issue multiple independent submit_review calls together in one assistant response, all with finish:false. Group complete arguments within the ${input.taskLimits?.maxTokens ?? STOP_TASK_LIMITS.maxTokens}-token output budget; keep reasons concise and leave a long M16 trace for its own response. A deviation can attach its path/range directly without a source_read call. Await every group result; keep successful receipts and repair only rejected items. After prior receipts are confirmed, submit the actual final remaining item with finish:true, or call finish_stop_review after all items are saved. Never put finish in a group with outstanding submissions. Every assigned original item still needs its own verdict; productionTrace is optional.`,
          'Optional pendingNavigation in saved receipts lists exact remaining IDs for this review and scope; follow review_checklist pagination for omissions. It grants no proof, PASS or permission to finish; retain the finish rules above.',
        ]),
        'Keep different required effects or records individually identifiable. When proving an implementation defect, attach both the contradicting artifact and the active consumer or current execution that makes it decisive. Page every selected item before finishing. Select the checklist before browsing execution history. When every selected proofOwners entry is SOURCE, inspect the named current source and necessary dependencies first; a mandatory read of original basis already preserves original task inputs. Do not enumerate historical business tool calls just to judge source-decidable code. If a concrete investigation needs those records, review_checklist includeProcessEvidence=true restores its navigation; actual PROCESS and mixed checklists expose it by default. Optional processReadPlan groups independent captured originals within a raw-byte budget: issue independent source_read calls together when output permits, await all real receipts and follow every nextOffset. The plan grants no coverage or mandatory-history expansion.',
        'Read a source path named in the original requirement directly. processFilesComplete=true means all process-file pointers are present; use the named relevant invocation/results directly. If processFilesContinuation is present, it describes existing source_ls pagination for the remaining records. SOURCE-only scopes still omit routine process navigation. Pointers grant no proof. Use ls/find only when discovery is needed.',
        'task.workspace is the actual project root. Start unknown-source searches there (omit path or use .), preferably in a relevant source directory or from review_changes hints. Do not search the parent containing all projects merely to locate a known relative project path. Follow original external references and necessary dependencies when they require reading outside this project; parent access remains available.',
        'The program-run regression evidence already captures the configured command and its real result. If a public baseline file named in that command is needed, read its exact path. Hidden tests, reference solutions and independent evaluator grades are not review inputs: do not search or read them.',
        'Use review_changes for Git status/diffs and host-edited paths as entry points. Follow dependencies, call sites and external references as needed. Diffs and inventories guide investigation; they do not establish PASS or absence.',
        ...(affectedSymbols.length ? ['The standing regression item may include currentSemanticLinks or semanticNavigationFiles pointing to their lossless contents for changed definitions, current callers, tests and effects. Read relevant navigation files when needed. testBoundaries joins dependency calls to test-helper arguments, setup scopes and later effect sites, without proving interception or control flow. Expand the relevant public entry with semantic_graph context/outgoing, then read its caller condition, dependency setup and first observable effect. Use the original basis for pre-existing behavior.'] : []),
        'For a requested no-effect or input-restriction guarantee, derive its owning public boundary from the original request before checking the frame. Trace the input condition, actual dependency outcome, guarding condition and first forbidden write or external call. Read any existing substitute and its returned value: when the request constrains the caller, a successful substitute exposes the caller path independently of the lower implementation. A lower helper that rejects real input does not prove that caller path is closed. Conversely, do not invent duplicate validation or failure guarantees at boundaries the request does not constrain. Verify the actual path before marking a frame item CHECKED; a selected scenario or passing lower-helper test is not proof.',
        ...(removedLiteralUses.length ? ['The standing regression item lists remaining case branches for removed literal values. Read the type, case and input path before judging a stale consumer or an independent use.'] : []),
        ...(graphInstructions ? [graphInstructions] : []),
        'source_read/grep/find/ls access the real workspace and absolute/parent paths, including linked files. No project copy, source allowlist or directory fence applies. Files remain read-only.',
        'Use source_ls, source_find and source_grep to locate files. Use a regular source_read of material needed for a verdict or original basis. Use source_read with contextOnly:true for exploratory text or mutable diagnostics. Those reads do not grant citations or required-basis coverage.',
        'Use review_plan and review_notes for your own planning and durable notes; review_history recovers issued citations and saved receipts after compaction. Notes and self-reports are not evidence of execution.',
        'Preserve original obligations, conditions, exceptions, HARD/SOFT authority and each proof owner. Process claims need original process records; source code alone cannot prove an action occurred. Read relevant processFiles on demand.',
        'M12 follows its original verificationTarget: IMPLEMENTATION uses SOURCE_IMPLEMENTATION to judge the delivered code and required data/control flow from current source, without inventing a test-run obligation. An explicit TEST implementationRole can prove authored test code, never test execution or M16 production coverage. PROCESS uses RUNTIME_ACCEPTANCE and requires the attributable original invocation and result. Keep mixed obligations separate: a source PASS cannot erase a required missing or failed execution, or prove acceptance/journey closure.',
        'For execution obligations, a completion claim without an attributable original execution result is UNVERIFIED, never DEVIATION. Missing records do not prove a failed or omitted action. A concrete contradictory execution event is required for DEVIATION; messages alone cannot certify runtime PASS.',
        'For order-sensitive process obligations, establish the required actor and event order from original invocation/result records. A read before an edit does not prove a read after it. Your own private source_read proves current content, not that the business actor previously reread or verified the file. An edit receipt, build or test result cannot stand in for a separately required business read-back unless the original rule permits that substitution and the actual result proves it. Missing attributable post-action evidence is UNVERIFIED, not an invented omission or PASS.',
        'Distinguish missing execution proof from positively observed nonconforming verification. If original invocation/result records and the completion context identify a post-edit read as the attempted required whole-file verification, an explicit bounded range that omits required parts is concrete wrong-scope execution and supports DEVIATION; do not relabel that observed contradiction as merely missing whole-file evidence. A pre-edit exploratory read, or a partial navigation read not attributable to the required verification attempt, does not by itself prove failed verification. When the post-action verification is only missing or cannot be attributed, retain UNVERIFIED. Current file facts cannot repair the original actor, order or executed scope.',
        'Match applicability evidence to the original scope. An ASCII-only page/diff, a zero-hit punctuation search, or a successful build/test does not establish that an entire file is ASCII or contains no Chinese. source_read returns fileFacts computed over all original UTF-8 bytes of that exact named file, bound to sha256: asciiOnly establishes full-file ASCII, while hanCodePoints counts Han characters, including outside the returned page. For a frozen source part these facts cover only that named part, not unread parts of its larger original document. A zero Han count alone is not proof of ASCII, correct text or business verification. Use these facts or sufficient original content to establish an exemption; retain uncertainty otherwise. Character facts never expand line citations or mandatory reading coverage, and your own review reads or file facts cannot satisfy a business-process action.',
        'For project acceptance criteria, establish which current request, changed decision or reachable consumer activates the exact criterion. A module-wide signal is not automatically a new device/UI execution requirement for every edit. Use the verification level actually required by its source and attributable original results; do not infer a real-device mandate from a name such as visible or consistent. Source-proved nonactivation must retain its original conditions and rationale; insufficient evidence remains UNVERIFIED. Never waive a genuinely activated acceptance result merely because execution is difficult.',
        'For M08, use the originalSkillBasis documents to judge Skill compliance in context; derived constraints are navigation.',
        'A source-bound Skill graph carries a semantic sourceInterpretation proposal and the complete original unit. The original context governs: a MUST/MIXED parent does not make its permission, description or advice clauses mandatory. Assess its independent current duties and each actual external condition separately; an inactive sub-branch cannot exclude the whole current compound. Do not invent before/after prerequisites from navigation order.',
        deviationOnly
          ? 'Submit UNVERIFIED on the exact item when current proof is missing. Use a concrete observed contradiction for a deviation. A prior result cannot prove either execution or nonexecution on the current revision. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.'
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
        ...(originalRequirements ? [
          tool('append_original_checklist', 'Save independently decidable obligations from a newly read original page. Repeat across pages and files. All ranges are local to the named part. Same-line records may specify exact half-open byteStart/byteEnd. Identical submissions are idempotent.',
            schema({ items: { type: 'array', minItems: 1, maxItems: 24, items: { ...originalItemSchema, properties: {
              ...originalItemSchema.properties, byteStart: { type: 'integer', minimum: 0 }, byteEnd: { type: 'integer', minimum: 1 },
            } } } }, ['items']), batches.append),
          tool('original_checklist_progress', 'Read saved extraction entries after native compaction. Reopen their exact original positions as necessary.',
            schema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24 } }),
            ({ offset, limit }) => ({ ...batches.status(offset, limit), ...(resumed ? resumePage(offset,limit) : {}) })),
          tool('seal_original_checklist', 'Prefer submit_review directly for a saved obligation with decisive counterevidence. Use partial:true to select a partial scope explicitly. Include extractedRanges for fully processed lines; select scope and deliver the deviation immediately. Partial batches never authorize clean completion. Otherwise freeze all accumulated original obligations before review. Disclose known unextracted ranges and fully read sources with no applicable obligation. Unresolved original scope stays visible at publication.',
            schema({ ...sealFields, partial: { type: 'boolean' }, extractedRanges: { type: 'array', items:
              schema({path:text,start:{type:'integer',minimum:1},end:{type:'integer',minimum:1}},['path','start','end']) } }), (value, ctx) => setOriginalChecklist({ ...value, items: [] }, ctx, true)),
          tool('set_original_checklist', 'One-shot compatibility for a small original checklist. Use append_original_checklist and seal_original_checklist for multi-page or multi-source extraction.',
            schema({ items: { type: 'array', maxItems: 256, items: originalItemSchema }, ...sealFields }, ['items']), setOriginalChecklist),
        ] : []),
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
          async (value, ctx) => {
            if (value.stopClassification) {
              const scope = await selectScope({ ...value, summary: value.summary ?? 'Selected scope from original Stop evidence.' }, ctx);
              if (scope.deferred) return scope;
            }
            if (!classification) return { next: originalRequirements && !reviewBasis ? 'set_original_checklist' : 'review_scope', scopeSelected: false };
            const offset = value.offset ?? 0, limit = value.limit ?? 5;
            const ordered = [...selected.filter(object => followUps.has(object.objectId)), ...selected.filter(object => !followUps.has(object.objectId))];
            const checklist = [...ordered.map(object => ({ ...object, taskId: object.objectId, proofOwners: reviewProofOwners(object), ...(needsGroupCheck(object) ? { groupCheckRequired: true } : {}),
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
            for (const item of items) inspectedItems.add(item.taskId);
            const navigation = processNavigation(selected, value.includeProcessEvidence);
            return { classification, items, total: checklist.length, artifactCandidates, ...navigation,
              ...(navigation.processNavigationOmitted ? {} : { processEvidence: processGuide(), processReadPlan: await processReadPlan() }), expectedFileChecks,
              ...(!deviationOnly ? { pending: selected.length + qualityTargets.length - rows.size - files.size } : {}),
              nextOffset: offset + limit < checklist.length ? offset + limit : null };
          }),
        tool('submit_review', deviationOnly
          ? 'Submit directly from an append_original_checklist receipt before sealing: include stopClassification and completionClaim with the item. Save a deviation or unresolved item; PASS is reserved for carried deviations. taskId is objectId or file:<path>. Only DEVIATION needs citations: [{path,start,end}]. Legacy IDs remain readable.'
          : 'Save one original item. Group independent already-evidenced calls in one response within the output budget, all finish:false; await every result before any finish. taskId is objectId or file:<path>. Only DEVIATION needs citations: [{path,start,end}]. Other verdicts need no citation. The program checks allowed file, range and hash only.',
          schema({ taskId: text,
            ...(deviationOnly && acceptanceSources.length ? {
              stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification, ...stageProperties, ...completionProperties,
              extractedRanges: {type:'array',description:'Optional fully extracted line ranges for the next Stop.',items:
                schema({path:text,start:{type:'integer',minimum:1},end:{type:'integer',minimum:1}},['path','start','end'])},
            } : {}),
            ...(!deviationOnly ? { finish: { type: 'boolean', description: dispositionFrame
              ? 'For a requirement frame, finish separately with finish_stop_review.frameDispositions.'
              : 'Set true on the final item to finish the complete original checklist in the same call.' } } : {}),
            verdict: { type: 'string', enum: deviationOnly ? followUps.size ? ['DEVIATION', 'PASS', 'UNVERIFIED'] : ['DEVIATION', 'UNVERIFIED']
              : STOP_REVIEW_SCHEMA.properties.metricObjectJudgements.items.properties.judgement.enum.filter(value => value !== 'CHECKER_ERROR') },
            reason: text, citeIds, citations: STOP_CITATIONS_SCHEMA, conditionAssessment: { ...CONDITION_ASSESSMENT_SCHEMA,
              description: 'Only supply for an assigned item whose canonical applicabilityKind is CONDITIONAL. Otherwise omit conditionAssessment; never change the assigned kind or verdict to fit this field.' },
            ...(wireTraceSchema ? { productionTrace: wireTraceSchema } : {}) }, ['taskId', 'verdict', 'reason']),
          async function submitReview(value, ctx) {
            if (!classification && deviationOnly && acceptanceSources.length && batches.size && value.verdict !== 'PASS') {
              if (!value.stopClassification) throw taskError('STOP_SCOPE_REQUIRED',
                'Submit the item directly with stopClassification and completionClaim from the original reply.');
              validateStopClassification(value, {contract: task.classificationContract, allowedStages:task.allowedStages});
              if (!reviewBasis) {
                const provisional = buildOriginalStopPopulation({ population, checklist:batches.items, sourceDigest:originalRequirements.digest });
                const owned = Object.values(selectStopPopulation(provisional.population,value,input.request.workflowArtifacts).metrics).flat();
                if (!owned.some(item => item.objectId === value.taskId && item.originalSource))
                  throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID','Use a saved batch taskId in the applicable scope.');
                await setOriginalChecklist({items:[], partial:true, extractedRanges:value.extractedRanges},ctx,true);
              }
              return selectScope(value, ctx, continued => submitReview(value, continued));
            }
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
            requireReviewBasis(ctx);
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
            const owner = object?.objectId ?? target.path;
            if (value.verdict === 'UNVERIFIED' && citationDrafts.has(value.taskId)) {
              const saved = await downgradeCitation(ctx, value.taskId, { owner, object, target }, citationDrafts.get(value.taskId).error);
              ctx.state.result = projectResult(ctx, 'The proposed deviation remains unverified.'); return saved;
            }
            if (value.verdict !== 'DEVIATION') citationDrafts.delete(value.taskId);
            const mapped = value.verdict === 'DEVIATION' ? await checkedAttachments(ctx, value.taskId, { owner, object, target }, value)
              : await receiptCitations(ctx, value.citeIds, owner, object, value.citations).catch(error => {
                if (error.code !== 'TASK_CITATION_INVALID') throw error;
                if (value.verdict === 'PASS') return downgradeCitation(ctx, value.taskId, { owner, object, target }, error);
                return [];
              });
            if (!mapped.downgraded && value.verdict === 'PASS' && requiresExecutionResult(object) && !mapped.some(currentExecution)) {
              return downgradeCitation(ctx, value.taskId, { owner, object, target },
                taskError('TASK_CITATION_INVALID', 'A follow-up execution PASS needs current execution evidence.'));
            }
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
              citations.push(...mapped);
              ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
              ctx.state.result = projectResult(ctx, 'Saved follow-up evidence; review is in progress.');
              return { saved: true, itemId: value.taskId };
            }
            if (object) validatedRows.set(object.objectId, checkedRow);
            if (object) { rows.set(object.objectId, row); proofs[object.objectId] = { productionTrace: row.productionTrace, sourceCiteIds,
              }; }
            else files.set(target.path, row);
            citations.push(...mapped); ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
            ctx.state.result = projectResult(ctx, 'Saved original checklist results; review is in progress.');
            if (partialBatch && row.judgement === 'DEVIATION' && !needsProcessClassification(object,row)) {
              // Signal native isComplete at the tool receipt, before another model turn.
              const result = await completeReview(ctx, value.reason, null, []);
              return { ...result, itemId:value.taskId, partial:true };
            }
            if (deviationOnly) return { saved: true, itemId: value.taskId,
              ...(needsProcessClassification(object, row) ? { processClassificationRequired: true,
                next: 'finish_stop_review.historicalOrders for a proved immutable order, or processRepairs for an actual current residue and useful remaining action. Otherwise this item remains UNVERIFIED and cannot dispatch repair.' } : {}) };
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
          schema({ summary: text, checkedGroups: {type:'array', description:'For groupCheckRequired items with no submitted verdict, identify the shared comparison performed and attach current delivery evidence. Current execution checks need a matching invocation/result and current version binding. Omitted groups remain unreviewed.', items:schema({
              taskIds:{type:'array',minItems:1,uniqueItems:true,items:text},method:text,citations:STOP_CITATIONS_SCHEMA
            },['taskIds','method','citations'])}, ...(dispositionFrame ? { frameDispositions: FRAME_DISPOSITIONS_WIRE } : {}),
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
    if (error.protocolResult?.sourceCoverage) error.sourceCoverage = error.protocolResult.sourceCoverage;
    const reviewCutoff = error.code === 'REVIEWER_DEADLINE' || session.signal.reason?.code === 'REVIEWER_DEADLINE';
    const canUseReserve = reviewCutoff && Date.now() < (input.publicationDeadlineAt ?? 0) && !input.abortSignal?.aborted;
    if (!classification || !error.protocolResult?.result || input.abortSignal?.aborted
      || session.signal.aborted && !canUseReserve || /INPUT_CHANGED|CANCEL|STALE/u.test(error.code ?? '')
      || /DEADLINE/u.test(error.code ?? '') && !canUseReserve) throw error;
    worker = error.protocolResult;
    if (error.sourceCoverage && !worker.result.sourceCoverage) {
      worker.result.sourceCoverage = error.sourceCoverage;
      worker.result.unverifiedItems.push(...unverifiedSources(error.sourceCoverage));
    }
    for (const item of selected) if (!rows.has(item.objectId) && !item.programStanding &&
      !worker.result.unverifiedItems.some(entry => entry.objectId === item.objectId)) {
      const source = item.originalSource;
      const position = source ? source.ref + ' 第 ' + source.start + (source.end === source.start ? '' : '–' + source.end) + ' 行，' : '';
      worker.result.unverifiedItems.push({ reviewState: 'UNREVIEWED', id: item.objectId, objectId: item.objectId, type: 'REQUIREMENT',
        reason: position + '审查中断，尚待核实：' + item.description,
        ...(source ? { source: { ref: source.ref, sha256: source.sha256, start: source.start, end: source.end } } : {}) });
    }
    if (worker.result.sourceCoverage) worker.result.reviewCoverage = stopReviewCoverage({ requirements: selected,
      judgements: classifiedRows(), fileAssessments: [...files.values()], unverifiedItems: worker.result.unverifiedItems });
    collection = { complete: false, mode: 'workspace-stop', failures: [{ code: error.code ?? 'REVIEW_ITEM_INCOMPLETE', message: 'The original checklist was only partially saved.' }] };
  }
  const { citations: sourceCitations, proofs: savedProofs, reviewEvidence, ...result } = worker.result;
  const dispositions = [...followUps].flatMap(([id, { familyId, observationId }]) => {
    const row = rows.get(id) ?? followUpResults.get(id);
    return row ? [{ ...classifiedRow(row), familyId, observationId }] : [];
  });
  const unresolved = unresolvedReview();
  if (!collection && (result.sourceCoverage?.complete === false || result.unverifiedItems.some(item => item.reviewState === 'UNREVIEWED')))
    collection = { complete: false, mode: 'workspace-stop', reasonCode: 'STOP_ORIGINAL_SCOPE_INCOMPLETE', failures: [] };
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
