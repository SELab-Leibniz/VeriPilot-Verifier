import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProtocolTask, taskError } from '../review-task/protocol-task.mjs';
import { validateProductionTrace, createProductionTraceSchema } from '../review-task/production-trace.mjs';
import { STOP_TASK_LIMITS } from '../review-task/stop-policy.mjs';
import { STOP_REVIEW_SCHEMA } from './reviewer.mjs';
import { selectStopPopulation } from './review-routing.mjs';
import { completionProperties, COMPLETION_INSTRUCTIONS, validateStopClassification } from './stop-classification.mjs';
import { reviewProofScope, reviewProofOwners, requiresExecutionResult, validateReviewJudgement, validateReviewFinding, validateReviewFile } from './review-result-validation.mjs';
import { buildOriginalStopPopulation, METRIC_CATALOG } from './metrics.mjs';
import { markdownTitle } from './original-requirements.mjs';
import { taskDirectory, decisionGuard } from './task-store.mjs';
import { readJson, safeId, sha256 } from './utils.mjs';
import { isSkillFileName, resolveSkillDirectory, scanSkillDirectory } from './skill-source.mjs';
import { fingerprint } from './evidence-state.mjs';
import { covers, excerpt, planIndependentReads } from '../review-task/evidence-utils.mjs';
import * as activeHost from '../active-host.mjs';
import { EXPECTED_FILES_SCHEMA, normalizeExpectedFiles, observeExpectedFile, expectedFilesCurrent } from './expected-files.mjs';
import { CONDITION_ASSESSMENT_SCHEMA, CONDITIONAL_REVIEW_POLICY_VERSION, CONDITIONAL_REVIEW_INSTRUCTIONS,
  bindConditionProcessWindow, captureConditionSnapshot, conditionWindowCurrent } from '../review-task/task-evidence.mjs';

const executeFile = promisify(execFile);
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 4000 };
const citeIds = { type: 'array', maxItems: 24, uniqueItems: true, items: { type: 'string' } };
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
  const initialGuard = decisionGuard(await readJson(taskPath));
  const originalRequirements = input.evidence?.originalRequirements;
  const truthPath = originalRequirements ? null : input.request.groundTruthPath;
  const persistedTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) : null;
  let truth = input.evidence?.groundTruth ?? (persistedTruth && JSON.parse(persistedTruth));
  if (!truth || truth.taskId && truth.taskId !== input.taskId) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'The current authoritative baseline is unavailable');
  const basisFiles = [], processFiles = new Set(), executionFiles = new Set(), originalSources = new Map(), optionalSources = [], referenceMaterials = [];
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
      let lineOffset = 0;
      for (const [part, file] of files.entries()) {
        const bytes = await fs.readFile(file);
        originalSources.set(file, { kind: 'USER_MESSAGE', ref: message.ref, sha256: message.sha256,
          readHash: sha256(bytes), part: part + 1, lineOffset });
        lineOffset += bytes.reduce((count, byte) => count + Number(byte === 10), 0);
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
  await parts(basisRoot, 'original-basis', { ...(originalRequirements ? { sources: [...originalSources].filter(([, source]) => !source.optional).map(([file, { kind, ref, part, lineOffset }]) =>
    ({ file, kind, ref, ...(part ? { part, lineOffset } : {}) })),
    ...(optionalSources.length ? { optionalSources } : {}),
    ...(Array.isArray(originalRequirements.referenceMaterials) ? { referenceMaterials } : {}) } : { groundTruth: truth }),
    request: { hook: input.request.hook, instructions: input.request.instructions, workflowStages: input.request.workflowStages,
      metricDefinitions: Object.fromEntries(Object.entries(METRIC_CATALOG).filter(([id]) => originalRequirements
        ? input.request.population.reviewPolicy?.metrics[id] !== false : input.request.population.metrics[id]?.length)) },
    ...(!originalRequirements ? { originalUserMessages: originalUsers } : {}),
    latestAssistant: [...entries].reverse().find(entry => entry.type === 'assistant') ?? input.request.hook }, true);
  const entryPaths = new Map(), invocationFiles = new Map(), executionCalls = new Map();
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
    if (entry.type === 'assistant') for (const block of blocks.filter(block => block.type === 'tool_use'))
      invocationFiles.set(block.id, invocationFiles.has(block.id) ? null : files);
    if (isExecutionRecord(entry)) for (const file of files)
      executionCalls.set(file, blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
  }
  if (input.request.deviceEvidence) await parts(processRoot, 'program-verification', input.request.deviceEvidence, false, programExecution(input.request.deviceEvidence));
  let population = input.request.population;
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
  const expectedFileChecks = [];
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
  async function requireSkillBasis(object, ctx) {
    if (object.metricId !== 'M08') return;
    const original = await skillBasis(object);
    if (original.error) throw taskError('REVIEW_ITEM_EVIDENCE_UNAVAILABLE', original.error);
    for (const file of original.requiredFiles) {
      const metadata = ctx.evidence.snapshot.get(file);
      if (!metadata || !covers(ctx.evidence.reads, file, 1, metadata.lines))
        throw taskError('REVIEW_ITEM_EVIDENCE_UNAVAILABLE', `Original Skill basis not fully read: ${file}`);
    }
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
  const receiptCitations = (ctx, ids, owner, object) => {
    const refs = ids.length ? ctx.citations(ids) : [];
    return refs.map(ref => {
      const sourceOwned = sourceCode.test(ref.path) && reviewProofOwners(object).includes('SOURCE')
        && (!testSource(path.relative(projectRoot, ref.path)) || object?.metricId === 'M12'
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
        frozen: inside(basisRoot, ref.path) || processFiles.has(ref.path), start: ref.start, end: ref.end,
        selection: `${ref.path}#L${ref.start}-L${ref.end}`, usedBy: [owner],
        readProof: { version: 1, protocol: 'workspace-stop-v1', observed: true, basisComplete: true, owner: proofOwner, fullFile, activationFact,
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
  const projectResult = (ctx, summary) => ({ summary, ...classification, findings: structuredClone(findings), metricObjectJudgements: [...rows.values()], fileAssessments: [...files.values()],
    citations: structuredClone(citations), proofs: structuredClone(proofs),
    reviewEvidence: { unstable: false, expectedFiles: structuredClone(expectedFileChecks), files: [...new Set([...ctx.evidence.snapshot.keys(), ...ctx.evidence.inventories.keys(), ...skillDependencies.keys()])], missing: [],
      readPaths: { ...Object.fromEntries(ctx.evidence.resolutions), ...Object.fromEntries(skillReadPaths) },
      fingerprints: { ...Object.fromEntries([...ctx.evidence.snapshot].map(([file, metadata]) => [file, metadata.sha256])),
        ...Object.fromEntries(ctx.evidence.inventories), ...Object.fromEntries(skillDependencies) } } });
  const setOriginalChecklist = async ({ items }, ctx) => {
    ctx.requireBasis();
    if (reviewBasis) throw taskError('TASK_SUBMISSION_CONFLICT', 'The original requirements checklist is already set');
    for (const [file, source] of originalSources) if (!source.optional && ctx.evidence.snapshot.get(file)?.sha256 !== source.readHash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'An original requirements source changed during preparation');
    const checklist = [];
    for (const { citeId, lineStart, lineEnd, ...item } of items) {
      const [receipt] = ctx.citations([citeId]);
      const original = originalSources.get(receipt.path);
      if (!original || receipt.sha256 !== original.readHash || lineStart < receipt.start || lineEnd > receipt.end || lineStart > lineEnd)
        throw taskError('STOP_ORIGINAL_CHECKLIST_INVALID', 'Select exact original-source lines inside one acknowledged source_read receipt');
      const { kind, ref, part, sha256: hash, lineOffset } = original;
      if (item.expectedFiles?.length) {
        const originalText = excerpt(await fs.readFile(receipt.path), lineStart, lineEnd).text;
        item.expectedFiles = normalizeExpectedFiles(normalizeExpectedFiles(item.expectedFiles, originalText), item.text);
      }
      checklist.push({ ...item, source: { kind, ref, ...(part ? { part } : {}), sha256: hash,
        start: lineStart + lineOffset, end: lineEnd + lineOffset } });
    }
    const basis = buildOriginalStopPopulation({ population, checklist, sourceDigest: originalRequirements.digest });
    await ctx.persist('original-checklist.json', basis);
    reviewBasis = basis; population = basis.population; truth = basis.groundTruth;
    allObjects = Object.values(population.metrics).flat();
    return { saved: true, items: allObjects.length, next: 'review_checklist' };
  };
  const selectScope = async (value, ctx) => {
    ctx.requireBasis();
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
    const verification = await input.onScope?.(frame, ...(reviewBasis ? [reviewBasis] : []));
    artifactCandidates = verification?.artifactCandidates ?? artifactCandidates;
    const targets = input.request.fileQualityReviewEnabled && ['TASK_COMPLETE', 'STAGE_COMPLETE'].includes(frame.stopClassification)
      ? artifactCandidates.filter(binding => frame.stopClassification !== 'STAGE_COMPLETE' || binding.stage === frame.stage
        || (input.request.workflowArtifacts ?? []).some(artifact => artifact.stage === frame.stage && (artifact.nodeId ?? artifact.name ?? artifact.type) === binding.artifactId))
        .flatMap(binding => binding.files ?? []) : [];
    await ctx.persist('scope.json', { ...frame, completionClaim: value.completionClaim,
      requiredUserInput: value.requiredUserInput ?? null, externalBlocker: value.externalBlocker ?? null,
      objectIds: objects.map(object => object.objectId), qualityTargets: targets });
    classification = frame; selected = objects;
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
      const checks = [];
      for (const requiredPath of declared) {
        const observation = await observeExpectedFile(projectRoot, requiredPath);
        checks.push({ ...observation, requiredPath, claimId: claim.claimId, revisionId: claim.revisionId });
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
      if (absent.length) {
        const row = { objectId: object.objectId, judgement: 'DEVIATION',
          reason: `任务已声明完成，但明确要求交付的文件尚未生成或不是普通文件：${absent.map(check => check.requiredPath).join('、')}。请按原始要求补齐文件。`,
          evidence: itemCitations.map(citation => citation.selection) };
        validateReviewJudgement({ row, object, citations: itemCitations, classification });
        await ctx.persist(`items/${sha256(object.objectId)}.json`, { itemId: object.objectId, result: row, citations: itemCitations, savedAt: Date.now() });
        rows.set(object.objectId, row); citations.push(...itemCitations);
        ctx.state.receipts.push({ itemId: object.objectId, verdict: row.judgement, origin: 'expected-file-check' });
      }
    }
    if (expectedFileChecks.length) await ctx.persist('expected-files.json', { checks: expectedFileChecks });
    await ctx.check();
    ctx.state.result = projectResult(ctx, 'Workspace review is in progress.');
    return { ...classification, items: selected.length, files: qualityTargets.length,
      ...processNavigation(selected, value.includeProcessEvidence), artifactCandidates, next: 'review_checklist' };
  };

  const finishReview = async (value, ctx) => {
    ctx.requireBasis();
    if (!classification || !deviationOnly && (selected.length !== rows.size || qualityTargets.length !== files.size))
      throw taskError('REVIEW_ITEM_INCOMPLETE', 'The original checklist is incomplete; use review_checklist');
    const result = projectResult(ctx, value.summary);
    await ctx.persist('review.json', result); ctx.state.result = result; ctx.state.complete = true;
    return { saved: true, complete: true, items: rows.size, files: files.size, findings: findings.length };
  };

  let worker, collection;
  try { worker = await runProtocolTask({ task, root: directory, workspaceRoot: projectRoot, outputDir: directory,
    evidencePolicy: { trackFile: file => !programOwned(file) || originalEvidence(file), trackDirectory: file => !programOwned(file) },
    signal: session.signal, deadlineAt: session.deadlineAt, nativeRun: session.run, assertCurrent: current,
    limits: input.taskLimits ?? STOP_TASK_LIMITS,
    definition: {
      prompt: [
        COMPLETION_INSTRUCTIONS,
        CONDITIONAL_REVIEW_INSTRUCTIONS,
        'One reviewer owns scope selection, source/artifact/process review, optional file quality, findings and the final checklist. Plan your own order; reuse each read across items. Do not spawn other agents.',
        'For a small review, inspect the evidence directly; plan/notes tools are optional, not mandatory ceremony. Reuse issued citeIds instead of rereading unchanged basis just to obtain another citeId.',
        ...(originalRequirements ? [
          Array.isArray(originalRequirements.referenceMaterials)
            ? 'This Stop starts from original user messages, project instructions, files the user named and adopted Skill documents; these are the mandatory sources. Read them with source_read numbered:true. Then call set_original_checklist before selecting scope. The original basis also lists referenceMaterials: optional project context with its task-start status (UNCHANGED, MODIFIED, DELETED or ADDED). Read a reference only when an obligation needs its detail; for MODIFIED or DELETED read its frozenOriginal, the task-start copy. A reference never overrides the user messages, and its drift alone is not a deviation. Read the latest user clarification in context and apply only currently binding obligations. A file named as a deliverable is never its own requirement authority. Adopted Skill steps belong to M08; derive an item from a Skill document only when it supplies an independent obligation outside those steps.'
            : 'This Stop starts from original user messages, project instructions, referenced materials and adopted Skill documents. Read the mandatory sources with source_read numbered:true. Then call set_original_checklist before selecting scope. Read the latest user clarification in context and apply only currently binding obligations. A file named as a deliverable is never its own requirement authority. Adopted Skill steps belong to M08; derive an item from a Skill document only when it supplies an independent obligation outside those steps.',
          ...(optionalSources.length ? ['optionalSources are user-named files outside the mandatory reading budget. Read the sections an obligation needs and cite them like any original source.'] : []),
          'For each distinct mandatory requirement, choose its applicable enabled M01–M16 metric, give the precise obligation and verificationTarget, and bind the exact original lineStart/lineEnd inside its source_read citeId. These offsets are local to the named file or part. Preserve all conditions, allowed inputs and exceptions. For a conditional obligation supply its exact activation condition separately. Add expectedFiles only when the original explicitly requires those exact files as outputs of this task. Use M16 for production paths, M12 PROCESS for explicitly required test execution, and M12 IMPLEMENTATION with implementationRole TEST for a required authored test. M08 already comes from the adopted Skill graph and uses its original Skill documents when reviewed. Do not create M08 items or replace Skill checks.',
          'Report a proven deviation when the current work breaks existing behavior that the request did not ask to change. For each such deviation, cite the existing behavior it breaks using an acknowledged source_read of pre-existing code or tests, and cite the changed code path that contradicts it. Connect the regression to the applicable scoped item; do not invent an original requirement or infer a regression from missing evidence.',
        ] : []),
        'Read the mandatory original basis once. Parts with the same name concatenate in filename order to their original JSON, preserving every condition and exception. Initialize once with review_checklist: supply stopClassification and the original reply\'s completionClaim (plus requiredUserInput/externalBlocker when relevant). Choose limit up to 20 to fit the checklist and response budget. Later pages or saved-result lookups omit classification fields; use offset/limit only. Never guess a completion claim. Separate review_scope remains available for complex workflows.',
        ...(deviationOnly ? [
          'Scan the full scoped checklist. Submit DEVIATION only when an issued source_read receipt contains concrete counterevidence for that item. Omit conforming, inapplicable or unproved items. Missing execution evidence alone is never counterevidence.',
          'Before TASK_COMPLETE the checklist covers work already delivered. An unfinished, not-yet-started or user-pending obligation is not a deviation. Report only a concrete contradiction in code, documents or other work already present, with its counterevidence; an absent future output is not one.',
          'For conditional duties, tie the counterexample to the original condition, the actual operation and its observed effect. Follow the relevant production caller and callee when the counterexample is in source.',
          'Await the receipts for all submitted deviations and findings, then call finish_stop_review. Call it even when there were no deviations. Do not submit PASS, UNVERIFIED, applicability verdicts or a productionTrace.',
        ] : [
          `After receiving sufficient original evidence, issue multiple independent submit_review calls together in one assistant response, all with finish:false. Group complete arguments within the ${input.taskLimits?.maxTokens ?? STOP_TASK_LIMITS.maxTokens}-token output budget; keep reasons concise and leave a long M16 trace for its own response. Never batch submissions with evidence reads whose results are not yet acknowledged. Await every group result; keep successful receipts and repair only rejected items. After prior receipts are confirmed, submit the actual final remaining item with finish:true, or call finish_stop_review after all items are saved. Never put finish in a group with outstanding submissions. Every original item, proof owner and required M16 trace still applies.`,
          'Optional pendingNavigation in saved receipts lists exact remaining IDs for this review and scope; follow review_checklist pagination for omissions. It grants no proof, PASS or permission to finish; retain the finish rules above.',
        ]),
        'Select the checklist before browsing execution history. When every selected proofOwners entry is SOURCE, inspect the named current source and necessary dependencies first; a mandatory read of original basis already preserves original task inputs. Do not enumerate historical business tool calls just to judge source-decidable code. If a concrete investigation needs those records, review_checklist includeProcessEvidence=true restores its navigation; actual PROCESS and mixed checklists expose it by default. Optional processReadPlan groups independent captured originals within a raw-byte budget: issue independent source_read calls together when output permits, await all real receipts and follow every nextOffset. The plan grants no coverage or mandatory-history expansion.',
        'Read a source path named in the original requirement directly. processFilesComplete=true means all process-file pointers are present; use the named relevant invocation/results directly. If processFilesContinuation is present, it describes existing source_ls pagination for the remaining records. SOURCE-only scopes still omit routine process navigation. Pointers grant no proof. Use ls/find only when discovery is needed.',
        'task.workspace is the actual project root. Start unknown-source searches there (omit path or use .), preferably in a relevant source directory or from review_changes hints. Do not search the parent containing all projects merely to locate a known relative project path. Follow original external references and necessary dependencies when they require reading outside this project; parent access remains available.',
        'Use review_changes for Git status/diffs and host-edited paths as entry points. Follow dependencies, call sites and external references as needed. Diffs and inventories guide investigation; they do not establish PASS or absence.',
        'source_read/grep/find/ls access the real workspace and absolute/parent paths, including linked files. No project copy, source allowlist or directory fence applies. Files remain read-only.',
        'Use review_plan and review_notes for your own planning and durable notes; review_history recovers issued citations and saved receipts after compaction. Notes and self-reports are not evidence of execution.',
        'Preserve original obligations, conditions, exceptions, HARD/SOFT authority and each proof owner. Process claims need original process records; source code alone cannot prove an action occurred. Read relevant processFiles on demand.',
        'M12 follows its original verificationTarget: IMPLEMENTATION uses SOURCE_IMPLEMENTATION to judge the delivered code and required data/control flow from current source, without inventing a test-run obligation. An explicit TEST implementationRole can prove authored test code, never test execution or M16 production coverage. PROCESS uses RUNTIME_ACCEPTANCE and requires the attributable original invocation and result. Keep mixed obligations separate: a source PASS cannot erase a required missing or failed execution, or prove acceptance/journey closure.',
        'For execution obligations, a completion claim without an attributable original execution result is UNVERIFIED, never DEVIATION. Missing records do not prove a failed or omitted action. A concrete contradictory execution event is required for DEVIATION; messages alone cannot certify runtime PASS.',
        'For order-sensitive process obligations, establish the required actor and event order from original invocation/result records. A read before an edit does not prove a read after it. Your own private source_read proves current content, not that the business actor previously reread or verified the file. An edit receipt, build or test result cannot stand in for a separately required business read-back unless the original rule permits that substitution and the actual result proves it. Missing attributable post-action evidence is UNVERIFIED, not an invented omission or PASS.',
        'Distinguish missing execution proof from positively observed nonconforming verification. If original invocation/result records and the completion context identify a post-edit read as the attempted required whole-file verification, an explicit bounded range that omits required parts is concrete wrong-scope execution and supports DEVIATION; do not relabel that observed contradiction as merely missing whole-file evidence. A pre-edit exploratory read, or a partial navigation read not attributable to the required verification attempt, does not by itself prove failed verification. When the post-action verification is only missing or cannot be attributed, retain UNVERIFIED. Current file facts cannot repair the original actor, order or executed scope.',
        'Match applicability evidence to the original scope. An ASCII-only page/diff, a zero-hit punctuation search, or a successful build/test does not establish that an entire file is ASCII or contains no Chinese. source_read returns fileFacts computed over all original UTF-8 bytes of that exact named file, bound to sha256: asciiOnly establishes full-file ASCII, while hanCodePoints counts Han characters, including outside the returned page. For a frozen source part these facts cover only that named part, not unread parts of its larger original document. A zero Han count alone is not proof of ASCII, correct text or business verification. Use these facts or sufficient original content to establish an exemption; retain uncertainty otherwise. Character facts never expand line citations or mandatory reading coverage, and your own review reads or file facts cannot satisfy a business-process action.',
        'M08 also requires reading every originalSkillBasis.requiredFiles entry from review_checklist in full, including the original SKILL.md and referenced conditions. The derived constraint alone does not prove Skill compliance.',
        'A source-bound Skill graph carries a semantic sourceInterpretation proposal and the complete original unit. The original context governs: a MUST/MIXED parent does not make its permission, description or advice clauses mandatory. Assess its independent current duties and each actual external condition separately; an inactive sub-branch cannot exclude the whole current compound. Do not invent before/after prerequisites from navigation order.',
        deviationOnly
          ? 'Omit items whose deviation cannot be proved. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.'
          : 'Submit UNVERIFIED when evidence is missing; do not invent obligations, exclusions, runtime results or PASS. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.',
        'At TASK_COMPLETE, the program checks unconditional explicit expectedFiles for enabled M12/M16 items. Confirmed missing/non-file outputs have already saved DEVIATION receipts. Use review_checklist savedResult and do not resubmit those items. Existence alone never proves content quality, implementation, or execution. Conditions and future/stage outputs are not automatically declared missing.',
        'Give a concrete cause and consequence in one or two sentences per reason; do not recite the entire metric checklist. Submit a separate finding only for a demonstrated problem not already represented by a metric deviation.',
        ...(deviationOnly ? [] : [
          'For M16 PASS, inspect the production producer-to-consumer flow, all writers to consumed state and potentially aliasing resources; provide productionTrace using actual source_read citeIds. Do not require a complete PASS trace for a concrete DEVIATION or UNVERIFIED.',
          'Production writers are initializers and runtime operations in the delivered program. A developer editing a source file is not the application writing its stored state. Cite the actual initializer or runtime write for the produced value; process records and edit receipts cannot replace production source citations. Each stateTargets citeId must also be included in this submission\'s top-level citeIds and qualify as a current production-source citation.',
          'For a conditional failure guarantee, retain the exact failing operation and condition from the original requirement. Trace the order of effects before and after that boundary, distinguishing in-memory state, durable storage and external system state. A failure return or caught exception does not undo earlier writes. A claimed unchanged state or rollback needs source evidence for the compensating writes and an independent snapshot when aliasing matters. Keep both the verdict reason and productionTrace within the guarantees actually supported by those paths; a dispatch-failure guarantee does not establish persistence-failure atomicity. A concrete contradiction of the required condition supports DEVIATION; missing proof supports UNVERIFIED. Do not add unrequested failure guarantees or obligations.',
          'An M16 item may contain several required effects and alternative outcomes. Before PASS, account for every original effect under each applicable outcome, including an explicitly required thrown/rejected operation as distinct from a returned failure. Follow the actual caller and callee control flow to the required consumer effect: code after an await is skipped when it rejects, and a finally block proves only the operations it actually performs. Do not let a correct rollback or busy-flag cleanup stand in for a separately required state reload or other effect. If relying on a callee to convert exceptions into returned failures, establish that contract for the relevant boundary from source; one caught inner operation is insufficient. Keep this analysis within the original allowed conditions, without requiring exception handling or effects the task does not request.',
        ]),
      ].join('\n'),
      tools: () => [
        ...(originalRequirements ? [tool('set_original_checklist', 'Generate this Stop checklist from the acknowledged original requirements. Submit once before choosing review scope. This tool saves obligations and their original positions, never their verdicts.',
          schema({ items: { type: 'array', maxItems: 256, items: schema({
            metricId: { type: 'string', enum: Object.keys(METRIC_CATALOG).filter(id => id !== 'M08' && population.reviewPolicy?.metrics[id] !== false) },
            text, verificationTarget: { type: 'string', enum: ['ARTIFACT', 'PROCESS', 'IMPLEMENTATION'] },
            implementationRole: { type: 'string', enum: ['PRODUCTION', 'TEST', 'SUPPORT'] }, applicability: text,
            expectedFiles: EXPECTED_FILES_SCHEMA, citeId: text,
            lineStart: { type: 'integer', minimum: 1 }, lineEnd: { type: 'integer', minimum: 1 },
          }, ['metricId', 'text', 'verificationTarget', 'citeId', 'lineStart', 'lineEnd']) } }, ['items']), setOriginalChecklist)] : []),
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
            if (value.stopClassification) await selectScope({ ...value, summary: value.summary ?? 'Selected scope from original Stop evidence.' }, ctx);
            if (!classification) return { next: originalRequirements && !reviewBasis ? 'set_original_checklist' : 'review_scope', scopeSelected: false };
            const offset = value.offset ?? 0, limit = value.limit ?? 5;
            const checklist = [...selected.map(object => ({ ...object, taskId: object.objectId, proofOwners: reviewProofOwners(object),
              ...(object.metricId === 'M12' ? { evidenceScope: reviewProofScope(object) } : {}),
              ...(requiresExecutionResult(object) ? { executionProof: { forVerdicts: deviationOnly ? ['DEVIATION'] : ['PASS', 'DEVIATION'], availableResultFileCount: executionFiles.size } } : {}),
              savedResult: rows.get(object.objectId) ?? null })),
              ...qualityTargets.map(file => ({ taskId: `file:${file.path}`, ...file, kind: 'FILE_QUALITY', savedResult: files.get(file.path) ?? null }))];
            const items = [];
            for (const item of checklist.slice(offset, offset + limit)) items.push({ ...item,
              ...(item.metricId === 'M08' ? { originalSkillBasis: await skillBasis(item) } : {}) });
            const navigation = processNavigation(selected, value.includeProcessEvidence);
            return { classification, items, total: checklist.length, artifactCandidates, ...navigation,
              ...(navigation.processNavigationOmitted ? {} : { processEvidence: processGuide(), processReadPlan: await processReadPlan() }), expectedFileChecks,
              ...(!deviationOnly ? { pending: selected.length + qualityTargets.length - rows.size - files.size } : {}),
              nextOffset: offset + limit < checklist.length ? offset + limit : null };
          }),
        tool('submit_review', deviationOnly
          ? 'Save one deviation. taskId is objectId or file:<path>. Cite the original counterevidence using issued source_read citeIds.'
          : 'Save one original item. Group independent already-evidenced calls in one response within the output budget, all finish:false; await every result before any finish. taskId is objectId or file:<path>. Reuse checked citeIds; retain every proof owner and M16 trace. UNVERIFIED may have no evidence.',
          schema({ taskId: text,
            ...(!deviationOnly ? { finish: { type: 'boolean', description: 'Set true on the final item to finish the complete original checklist in the same call.' } } : {}),
            verdict: { type: 'string', enum: deviationOnly ? ['DEVIATION']
              : STOP_REVIEW_SCHEMA.properties.metricObjectJudgements.items.properties.judgement.enum.filter(value => value !== 'CHECKER_ERROR') },
            reason: text, citeIds: deviationOnly ? { ...citeIds, minItems: 1 } : citeIds, conditionAssessment: { ...CONDITION_ASSESSMENT_SCHEMA,
              description: 'Only supply for an assigned item whose canonical applicabilityKind is CONDITIONAL. Otherwise omit conditionAssessment; never change the assigned kind or verdict to fit this field.' },
            ...(wireTraceSchema ? { productionTrace: wireTraceSchema } : {}) }, ['taskId', 'verdict', 'reason', 'citeIds']),
          async (value, ctx) => {
            const object = selected.find(object => object.objectId === value.taskId);
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
            if (object ? rows.has(object.objectId) : files.has(target.path)) throw taskError('TASK_SUBMISSION_CONFLICT', 'This item already has a saved result');
            if (object && ['NOT_APPLICABLE', 'NOT_YET_APPLICABLE'].includes(value.verdict) && object.applicabilityKind !== 'CONDITIONAL')
              throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'This obligation is not conditional');
            if (target && !['PASS', 'DEVIATION', 'UNVERIFIED'].includes(value.verdict)) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Invalid file-quality verdict');
            const owner = object?.objectId ?? target.path, mapped = receiptCitations(ctx, value.citeIds, owner, object);
            if (object && !['UNVERIFIED', 'EXTERNAL_BLOCKED'].includes(value.verdict)) await requireSkillBasis(object, ctx);
            const references = mapped.map(citation => citation.selection);
            const row = object ? { objectId: object.objectId, judgement: value.verdict, reason: value.reason, evidence: references }
              : { path: target.path, status: value.verdict, reason: value.reason, evidence: references };
            if (value.conditionAssessment) row.conditionAssessment = value.conditionAssessment;
            let conditionBinding, checkedRow;
            const sourceCiteIds = mapped.filter(ref => ref.readProof.owner === 'SOURCE').map(ref => ref.citeId);
            if (object) {
              try {
                const cursor = sha256(entries);
                const source = value.conditionAssessment?.evidenceKind === 'PROCESS_WINDOW'
                  ? await captureConditionSnapshot(input.evidence?.snapshot, input.request.processSnapshotPath) : null;
                const processWindow = value.conditionAssessment?.evidenceKind === 'PROCESS_WINDOW'
                  ? bindConditionProcessWindow({ entries, afterCallId: value.conditionAssessment.afterCallId, cursor,
                    complete: source.complete, source,
                    readComplete: index => entryPaths.get(index)?.every(file => {
                      const metadata = ctx.evidence.snapshot.get(file);
                      return metadata && covers(ctx.evidence.reads, file, 1, metadata.lines);
                    }) }) : undefined;
                checkedRow = validateReviewJudgement({ row, object, citations: mapped, classification,
                  conditionContext: { currentCursor: cursor, processWindow } });
                conditionBinding = checkedRow.conditionBinding;
              }
              catch (cause) {
                if (cause.code === 'REVIEW_CONDITION_EVIDENCE_UNAVAILABLE') {
                  const paths = value.conditionAssessment?.evidenceKind === 'TARGET_FACTS'
                    ? mapped.filter(ref => ['SOURCE', 'ARTIFACT'].includes(ref.readProof.owner)).map(ref => ref.path)
                    : originalUserProcessFiles.length ? originalUserProcessFiles.slice(0, 1) : [...processFiles].slice(0, 1);
                  throw taskError(cause.code, `${cause.message}\nItem ${object.objectId}: ${paths.length ? `source_read ${[...new Set(paths)].join(', ')} in full` : 'locate and read the actual original condition witness'}; reviewer labels and hashes alone do not establish activation.`);
                }
                if (cause.code !== 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE') throw cause;
                throw taskError(cause.code, `${cause.message}\n${evidenceHint(object)}`);
              }
            }
            else {
              validateReviewFile({ file: row, citations: mapped });
              if (value.verdict !== 'UNVERIFIED' && !mapped.some(ref => path.resolve(projectRoot, target.path) === ref.path && ref.contentHash === target.sha256))
                throw taskError('REVIEW_ITEM_EVIDENCE_UNAVAILABLE', 'File quality requires reading the actual current delivery file');
            }
            if (object?.metricId === 'M16' && value.verdict === 'PASS') {
              // Only PASS requires and persists a checked flow witness. An
              // optional D/U wire trace never creates an extra proof here.
              row.productionTrace = validateProductionTrace(trace, sourceCiteIds);
            }
            if (conditionBinding?.window && !await conditionWindowCurrent(conditionBinding.window))
              throw taskError('STOP_TASK_INPUT_CHANGED', 'Original process window changed before saving.');
            const receipt = { itemId: value.taskId, result: row, citations: mapped, sourceCiteIds,
              ...(conditionBinding ? { conditionBinding } : {}), savedAt: Date.now() };
            await ctx.persist(`items/${sha256(value.taskId)}.json`, receipt);
            if (object) validatedRows.set(object.objectId, checkedRow);
            if (object) { rows.set(object.objectId, row); proofs[object.objectId] = { productionTrace: row.productionTrace, sourceCiteIds,
              ...(conditionBinding ? { conditionBinding } : {}) }; }
            else files.set(target.path, row);
            citations.push(...mapped); ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
            ctx.state.result = projectResult(ctx, 'Saved original checklist results; review is in progress.');
            if (deviationOnly) return { saved: true, itemId: value.taskId };
            const remaining = selected.length + qualityTargets.length - rows.size - files.size;
            if (value.finish && remaining === 0) return { ...await finishReview({ summary: value.reason }, ctx), itemId: value.taskId, pending: 0 };
            return withPendingNavigation({ saved: true, itemId: value.taskId, pending: remaining });
          }),
        tool('submit_finding', 'Save an evidence-backed deviation beyond checklist rows; reference original Ground Truth IDs and issued citeIds.',
          schema({ ...Object.fromEntries(Object.entries(STOP_REVIEW_SCHEMA.properties.findings.items.properties).filter(([key]) => key !== 'actualEvidence')), citeIds },
            ['deviationKey', 'rootCauseId', 'severity', 'reason', 'expectedConstraint', 'violatedGroundTruthIds', 'citeIds']),
          async ({ citeIds: ids, ...finding }, ctx) => {
            ctx.requireBasis(); if (!classification) throw taskError('STOP_SCOPE_REQUIRED', 'Select the Stop scope first');
            if (findings.some(saved => saved.deviationKey === finding.deviationKey) || !finding.violatedGroundTruthIds.length)
              throw taskError('TASK_SUBMISSION_CONFLICT', 'A distinct finding and its original obligations are required');
            const owned = allObjects.filter(object => finding.violatedGroundTruthIds.includes(object.sourceId));
            if (finding.violatedGroundTruthIds.some(id => !owned.some(object => object.sourceId === id))) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Unknown finding obligation');
            for (const object of owned) await requireSkillBasis(object, ctx);
            const mapped = owned.flatMap(object => receiptCitations(ctx, ids, finding.deviationKey, object));
            const conditionContexts = {};
            for (const object of owned) {
              const binding = proofs[object.objectId]?.conditionBinding;
              if (binding?.window && !await conditionWindowCurrent(binding.window)) throw taskError('REVIEW_COLLECTION_STALE', 'The original conditional window changed before finding persistence.');
              if (binding) conditionContexts[object.objectId] = { currentCursor: binding.cursor, processWindow: binding.window };
            }
            finding.actualEvidence = [...new Set(mapped.map(citation => citation.selection))];
            for (const id of finding.violatedGroundTruthIds) {
              const projections = owned.filter(object => object.sourceId === id);
              const execution = projections.find(object => ['M12', 'M13', 'M15'].includes(object.metricId));
              if (execution && projections.every(object => reviewProofOwners(object).length === 1 && reviewProofOwners(object)[0] === 'PROCESS'))
                validateReviewJudgement({ row: validatedRows.get(execution.objectId) ?? { judgement: 'DEVIATION',
                  conditionAssessment: finding.conditionAssessments?.find(item => item.objectId === execution.objectId)?.conditionAssessment },
                  object: execution, citations: mapped, classification, conditionContext: conditionContexts[execution.objectId] });
            }
            validateReviewFinding({ finding, objects: allObjects, citations: mapped, classification, judgements: [...validatedRows.values()], conditionContexts });
            await ctx.persist(`findings/${sha256(finding.deviationKey)}.json`, { finding, citations: mapped });
            findings.push(finding); citations.push(...mapped);
            ctx.state.result = projectResult(ctx, 'Saved checked findings; review is in progress.');
            return { saved: true, deviationKey: finding.deviationKey };
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
        tool('finish_stop_review', deviationOnly
          ? 'Finish after scanning the selected scope and receiving all submitted deviation receipts. A completed scan may report zero deviations.'
          : 'Finish only when every original checklist item and requested file-quality review has a saved result. Final text alone is not a result.',
          schema({ summary: text }, ['summary']), finishReview),
      ],
    },
  }); } catch (error) {
    if (!classification || !error.protocolResult?.result || session.signal.aborted
      || /INPUT_CHANGED|CANCEL|STALE|DEADLINE/u.test(error.code ?? '')) throw error;
    worker = error.protocolResult;
    collection = { complete: false, mode: 'workspace-stop', failures: [{ code: error.code ?? 'REVIEW_ITEM_INCOMPLETE', message: 'The original checklist was only partially saved.' }] };
  }
  const { citations: sourceCitations, proofs: savedProofs, reviewEvidence, ...result } = worker.result;
  return { result, sourceCitations, getSourceCitations: async () => structuredClone(sourceCitations), proofs: savedProofs, reviewEvidence,
    ...(reviewBasis ? { reviewBasis } : {}), ...(basisBudget ? { basisBudget } : {}),
    ...(collection ? { collection } : {}), receipts: worker.receipts, sessionId: session.sessionId, artifacts: directory, close: async () => {} };
}
