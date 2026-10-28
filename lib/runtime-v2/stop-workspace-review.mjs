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
import { reviewProofOwners, requiresExecutionResult, validateReviewJudgement, validateReviewFinding, validateReviewFile } from './review-result-validation.mjs';
import { METRIC_CATALOG } from './metrics.mjs';
import { taskDirectory, decisionGuard } from './task-store.mjs';
import { readJson, safeId, sha256 } from './utils.mjs';
import { resolveSkillDirectory, scanSkillDirectory } from './skill-source.mjs';
import { fingerprint } from './evidence-state.mjs';
import { covers } from '../review-task/evidence-utils.mjs';
import * as activeHost from '../active-host.mjs';

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
  const projectRoot = await fs.realpath(input.projectRoot);
  const directory = path.join(taskDirectory(projectRoot, input.taskId), 'workspace-reviews', randomUUID());
  const basisRoot = path.join(directory, 'basis'), processRoot = path.join(directory, 'execution');
  await fs.mkdir(basisRoot, { recursive: true }); await fs.mkdir(processRoot);
  const taskPath = path.join(taskDirectory(projectRoot, input.taskId), 'task.json');
  const initialGuard = decisionGuard(await readJson(taskPath));
  const truthPath = input.request.groundTruthPath;
  const persistedTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) : null;
  const truth = input.evidence?.groundTruth ?? (persistedTruth && JSON.parse(persistedTruth));
  if (!truth || truth.taskId && truth.taskId !== input.taskId) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'The current authoritative baseline is unavailable');
  const basisFiles = [], processFiles = new Set(), executionFiles = new Set();
  async function parts(root, name, value, mandatory = false, execution = false) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
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
  await parts(basisRoot, 'original-basis', { groundTruth: truth,
    request: { hook: input.request.hook, instructions: input.request.instructions, workflowStages: input.request.workflowStages,
      metricDefinitions: Object.fromEntries(Object.entries(METRIC_CATALOG).filter(([id]) => input.request.population.metrics[id]?.length)) },
    originalUserMessages: originalUsers, latestAssistant: [...entries].reverse().find(entry => entry.type === 'assistant') ?? input.request.hook }, true);
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
  const population = input.request.population;
  const allObjects = Object.values(population.metrics).flat();
  const rows = new Map(), files = new Map(), findings = [], citations = [], proofs = {};
  const skills = new Map(), skillDependencies = new Map(), skillReadPaths = new Map();
  const controlRoot = path.join(projectRoot, '.runtime-correction');
  const excluded = (input.excludedEvidencePaths ?? []).map(file => path.resolve(file));
  const programOwned = file => inside(controlRoot, file) || excluded.some(root => inside(root, file));
  const originalEvidence = file => inside(basisRoot, file) || processFiles.has(file) || skillDependencies.has(file) || file === truthPath;
  async function skillBasis(object) {
    if (object.metricId !== 'M08') return null;
    if (!skills.has(object.skillId)) {
      const skillRoot = path.join(taskDirectory(projectRoot, input.taskId), 'skills', safeId(object.skillId ?? 'unknown'));
      const documentPath = path.join(skillRoot, 'skill-ground-truth.json'), document = await readJson(documentPath);
      const captured = input.evidence?.skillSource ?? await readJson(path.join(skillRoot, 'skill-source.json'));
      const resolved = await resolveSkillDirectory({ skillId: object.skillId, projectRoot, pluginRoot: input.pluginRoot,
        configuredRoots: input.skillRoots ?? [], hostAdapter: input.hostAdapter ?? activeHost });
      const original = captured?.root && (inside(path.join(skillRoot, 'source'), captured.root) || captured.root === resolved) ? captured.root : resolved;
      const source = original ? await scanSkillDirectory(original) : null;
      if (!document || document.taskId !== input.taskId || document.skillId !== object.skillId
        || document.digest !== sha256({ skillId: document.skillId, skillDigest: document.skillDigest, constraints: document.constraints, taskOverlays: document.taskOverlays })
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
    const constraint = record.document.constraints.find(item => `${object.skillId}:${item.constraintId}` === object.sourceId);
    if (!constraint || !['MUST', 'PROHIBITED'].includes(constraint.modality) || object.sourceRevisionId !== `${object.skillId}@${record.document.version}`
      || object.description !== constraint.statement) return { error: 'The assigned Skill obligation differs from its original revision.' };
    const related = new Set([constraint.constraintId]);
    for (let size = -1; size !== related.size;) { size = related.size;
      for (const item of record.document.constraints) if (related.has(item.constraintId)) for (const id of item.dependsOn ?? []) related.add(id);
    }
    const references = ['SKILL.md', ...record.document.constraints.filter(item => related.has(item.constraintId)).map(item => item.sourceRef).filter(Boolean)];
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
  let classification, selected = [], qualityTargets = [], plan = [], notes = [], programEvidenceFiles = [];
  let artifactCandidates = input.request.artifactCandidates ?? [];
  const task = { id: `workspace-${randomUUID()}`, scope: 'workspace-stop', basisFiles,
    requirement: 'Review this Stop directly in the current workspace. Select its scope, plan the review and submit every assigned checklist item with original evidence.',
    workspace: projectRoot, processDirectory: processRoot, processFiles: [...processFiles].slice(0, 10), processFileCount: processFiles.size,
    attributedExecutionFileCount: executionFiles.size,
    artifactCandidates: input.request.artifactCandidates ?? [], allowedStages: input.request.workflowStages ?? [],
    classificationContract: input.request.classificationContract,
    fixedStopClassification: input.request.fixedStopClassification ?? null };
  const stageProperties = task.allowedStages.length ? { stage: { type: ['string', 'null'],
    enum: [...task.allowedStages, null], description: 'Only STAGE_COMPLETE uses a stage. Otherwise omit this field.' } } : {};
  async function current() {
    session.active();
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
      let proofOwner = processFiles.has(ref.path) ? 'PROCESS' : inside(directory, ref.path) || inside(path.join(projectRoot, '.runtime-correction'), ref.path) ? 'BASIS'
        : sourceCode.test(ref.path) && !testSource(path.relative(projectRoot, ref.path)) && reviewProofOwners(object).includes('SOURCE') ? 'SOURCE' : 'ARTIFACT';
      // Reviewer-created plans, notes, results and old RC reviews are readable
      // context, but cannot be promoted to original acceptance evidence.
      if (inside(directory, ref.path) && !inside(basisRoot, ref.path) && !processFiles.has(ref.path)) proofOwner = 'REVIEWER';
      return { path: ref.path, snapshotPath: ref.path, contentHash: ref.sha256,
        frozen: inside(basisRoot, ref.path) || processFiles.has(ref.path), start: ref.start, end: ref.end,
        selection: `${ref.path}#L${ref.start}-L${ref.end}`, usedBy: [owner],
        readProof: { version: 1, protocol: 'workspace-stop-v1', observed: true, basisComplete: true, owner: proofOwner,
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
    reviewEvidence: { unstable: false, files: [...new Set([...ctx.evidence.snapshot.keys(), ...ctx.evidence.inventories.keys(), ...skillDependencies.keys()])], missing: [],
      readPaths: { ...Object.fromEntries(ctx.evidence.resolutions), ...Object.fromEntries(skillReadPaths) },
      fingerprints: { ...Object.fromEntries([...ctx.evidence.snapshot].map(([file, metadata]) => [file, metadata.sha256])),
        ...Object.fromEntries(ctx.evidence.inventories), ...Object.fromEntries(skillDependencies) } } });
  const selectScope = async (value, ctx) => {
    ctx.requireBasis();
    validateStopClassification(value, { contract: task.classificationContract, allowedStages: task.allowedStages });
    const frame = { stopClassification: value.stopClassification, stage: value.stopClassification === 'STAGE_COMPLETE' ? value.stage ?? null : null };
    if (classification) {
      if (sha256(classification) !== sha256(frame)) throw taskError('TASK_SUBMISSION_CONFLICT', 'The Stop scope is already fixed');
      return { ...classification, reused: true, items: selected.length, files: qualityTargets.length, processDirectory: processRoot, programEvidenceFiles, next: 'review_checklist' };
    }
    if (task.fixedStopClassification && (task.fixedStopClassification.stopClassification !== value.stopClassification
      || (task.fixedStopClassification.stage ?? null) !== frame.stage)) throw taskError('STOP_STAGE_SCOPE_INVALID', 'The verification caller fixed this scope');
    if (value.stopClassification === 'STAGE_COMPLETE' && task.allowedStages.length && !task.allowedStages.includes(value.stage))
      throw taskError('STOP_STAGE_SCOPE_INVALID', 'Unknown workflow stage');
    const objects = Object.values(selectStopPopulation(population, frame, input.request.workflowArtifacts).metrics).flat();
    const verification = await input.onScope?.(frame);
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
    await ctx.check();
    ctx.state.result = projectResult(ctx, 'Workspace review is in progress.');
    return { ...classification, items: selected.length, files: qualityTargets.length, processDirectory: processRoot,
      processFiles: [...processFiles].slice(0, 10), processFileCount: processFiles.size, attributedExecutionFileCount: executionFiles.size, programEvidenceFiles, artifactCandidates, next: 'review_checklist' };
  };

  const finishReview = async (value, ctx) => {
    ctx.requireBasis();
    if (!classification || selected.length !== rows.size || qualityTargets.length !== files.size)
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
        'One reviewer owns scope selection, source/artifact/process review, optional file quality, findings and the final checklist. Plan your own order; reuse each read across items. Do not spawn other agents.',
        'For a small review, inspect the evidence directly; plan/notes tools are optional, not mandatory ceremony. Reuse issued citeIds instead of rereading unchanged basis just to obtain another citeId.',
        'Read the mandatory original basis once. Parts with the same name concatenate in filename order to their original JSON, preserving every condition and exception. Then call review_checklist with stopClassification to select scope and get the original checklist in one call. Submit the final item with finish=true to settle it in the same call. Separate review_scope and finish_stop_review remain available for complex workflows.',
        'Read a source path named in the original requirement directly. Use ls/find only when discovery is needed.',
        'Use review_changes for Git status/diffs and host-edited paths as entry points. Follow dependencies, call sites and external references as needed. Diffs and inventories guide investigation; they do not establish PASS or absence.',
        'source_read/grep/find/ls access the real workspace and absolute/parent paths, including linked files. No project copy, source allowlist or directory fence applies. Files remain read-only.',
        'Use review_plan and review_notes for your own planning and durable notes; review_history recovers issued citations and saved receipts after compaction. Notes and self-reports are not evidence of execution.',
        'Preserve original obligations, conditions, exceptions, HARD/SOFT authority and each proof owner. Process claims need original process records; source code alone cannot prove an action occurred. Read relevant processFiles on demand.',
        'For execution obligations, a completion claim without an attributable original execution result is UNVERIFIED, never DEVIATION. Missing records do not prove a failed or omitted action. A concrete contradictory execution event is required for DEVIATION; messages alone cannot certify runtime PASS.',
        'M08 also requires reading every originalSkillBasis.requiredFiles entry from review_checklist in full, including the original SKILL.md and referenced conditions. The derived constraint alone does not prove Skill compliance.',
        'Submit UNVERIFIED when evidence is missing; do not invent obligations, exclusions, runtime results or PASS. A completion claim selects scope and never proves acceptance. Missing navigation entries do not prove missing files.',
        'Give a concrete cause and consequence in one or two sentences per reason; do not recite the entire metric checklist. Submit a separate finding only for a demonstrated problem not already represented by a metric deviation.',
        'For M16 PASS, inspect the production producer-to-consumer flow, all writers to consumed state and potentially aliasing resources; provide productionTrace using actual source_read citeIds. Do not require a complete PASS trace for a concrete DEVIATION or UNVERIFIED.',
      ].join('\n'),
      tools: () => [
        tool('review_scope', 'Select the Stop scope once from the original user/assistant basis. This produces the program-owned checklist, not an acceptance verdict.',
          schema({ stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification,
            ...stageProperties, summary: text,
            ...completionProperties }, ['stopClassification', 'summary', ...(task.classificationContract === 2 ? ['completionClaim'] : [])]),
          selectScope),
        tool('review_checklist', 'Select scope and read original acceptance items in one call by supplying stopClassification. Returns proofOwners per item: PROCESS requires the original processFiles, SOURCE requires production code. Mandatory basis and original Skill text do not substitute for PROCESS. Later calls recover saved results; every assigned item must be submitted.',
          schema({ offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
            stopClassification: STOP_REVIEW_SCHEMA.properties.stopClassification, ...stageProperties, summary: text, ...completionProperties }),
          async (value, ctx) => {
            if (value.stopClassification) await selectScope({ ...value, summary: value.summary ?? 'Selected scope from original Stop evidence.' }, ctx);
            if (!classification) return { next: 'review_scope', scopeSelected: false };
            const offset = value.offset ?? 0, limit = value.limit ?? 5;
            const checklist = [...selected.map(object => ({ ...object, taskId: object.objectId, proofOwners: reviewProofOwners(object),
              ...(requiresExecutionResult(object) ? { executionProof: { forVerdicts: ['PASS', 'DEVIATION'], availableResultFileCount: executionFiles.size } } : {}),
              savedResult: rows.get(object.objectId) ?? null })),
              ...qualityTargets.map(file => ({ taskId: `file:${file.path}`, ...file, kind: 'FILE_QUALITY', savedResult: files.get(file.path) ?? null }))];
            const items = [];
            for (const item of checklist.slice(offset, offset + limit)) items.push({ ...item,
              ...(item.metricId === 'M08' ? { originalSkillBasis: await skillBasis(item) } : {}) });
            return { classification, items, total: checklist.length, artifactCandidates, processDirectory: processRoot,
              processEvidence: processGuide(),
              processFiles: [...processFiles].slice(0, 10), processFileCount: processFiles.size,
              attributedExecutionFileCount: executionFiles.size, programEvidenceFiles,
              pending: selected.length + qualityTargets.length - rows.size - files.size, nextOffset: offset + limit < checklist.length ? offset + limit : null };
          }),
        tool('submit_review', 'Save one original checklist item. taskId is its objectId, or file:<path> for file quality. Reuse checked citeIds; UNVERIFIED may have no evidence.',
          schema({ taskId: text, finish: { type: 'boolean', description: 'Set true on the final item to finish the complete original checklist in the same call.' },
            verdict: { type: 'string', enum: STOP_REVIEW_SCHEMA.properties.metricObjectJudgements.items.properties.judgement.enum.filter(value => value !== 'CHECKER_ERROR') },
            reason: text, citeIds, ...(population.metrics.M16?.length ? { productionTrace: createProductionTraceSchema() } : {}) }, ['taskId', 'verdict', 'reason', 'citeIds']),
          async (value, ctx) => {
            ctx.requireBasis();
            const object = selected.find(object => object.objectId === value.taskId);
            const target = qualityTargets.find(file => `file:${file.path}` === value.taskId);
            if (!classification || !object && !target) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Unassigned checklist item');
            if (object ? rows.has(object.objectId) : files.has(target.path)) throw taskError('TASK_SUBMISSION_CONFLICT', 'This item already has a saved result');
            if (object && ['NOT_APPLICABLE', 'NOT_YET_APPLICABLE'].includes(value.verdict) && object.applicabilityKind !== 'CONDITIONAL')
              throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'This obligation is not conditional');
            if (target && !['PASS', 'DEVIATION', 'UNVERIFIED'].includes(value.verdict)) throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Invalid file-quality verdict');
            const owner = object?.objectId ?? target.path, mapped = receiptCitations(ctx, value.citeIds, owner, object);
            if (object && !['UNVERIFIED', 'EXTERNAL_BLOCKED'].includes(value.verdict)) await requireSkillBasis(object, ctx);
            const references = mapped.map(citation => citation.selection);
            const row = object ? { objectId: object.objectId, judgement: value.verdict, reason: value.reason, evidence: references }
              : { path: target.path, status: value.verdict, reason: value.reason, evidence: references };
            const sourceCiteIds = mapped.filter(ref => ref.readProof.owner === 'SOURCE').map(ref => ref.citeId);
            if (object) {
              try { validateReviewJudgement({ row, object, citations: mapped, classification }); }
              catch (cause) {
                if (cause.code !== 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE') throw cause;
                throw taskError(cause.code, `${cause.message}\n${evidenceHint(object)}`);
              }
            }
            else {
              validateReviewFile({ file: row, citations: mapped });
              if (value.verdict !== 'UNVERIFIED' && !mapped.some(ref => path.resolve(projectRoot, target.path) === ref.path && ref.contentHash === target.sha256))
                throw taskError('REVIEW_ITEM_EVIDENCE_UNAVAILABLE', 'File quality requires reading the actual current delivery file');
            }
            if (object?.metricId === 'M16' && value.verdict === 'PASS') row.productionTrace = validateProductionTrace(value.productionTrace, sourceCiteIds);
            const receipt = { itemId: value.taskId, result: row, citations: mapped, sourceCiteIds, savedAt: Date.now() };
            await ctx.persist(`items/${sha256(value.taskId)}.json`, receipt);
            if (object) { rows.set(object.objectId, row); proofs[object.objectId] = { productionTrace: row.productionTrace, sourceCiteIds }; }
            else files.set(target.path, row);
            citations.push(...mapped); ctx.state.receipts.push({ itemId: value.taskId, verdict: value.verdict });
            ctx.state.result = projectResult(ctx, 'Saved original checklist results; review is in progress.');
            const remaining = selected.length + qualityTargets.length - rows.size - files.size;
            if (value.finish && remaining === 0) return { ...await finishReview({ summary: value.reason }, ctx), itemId: value.taskId, pending: 0 };
            return { saved: true, itemId: value.taskId, pending: remaining };
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
            finding.actualEvidence = [...new Set(mapped.map(citation => citation.selection))];
            for (const id of finding.violatedGroundTruthIds) {
              const projections = owned.filter(object => object.sourceId === id);
              const execution = projections.find(object => ['M12', 'M13', 'M15'].includes(object.metricId));
              if (execution && projections.every(object => reviewProofOwners(object).length === 1 && reviewProofOwners(object)[0] === 'PROCESS'))
                validateReviewJudgement({ row: { judgement: 'DEVIATION' }, object: execution, citations: mapped, classification });
            }
            validateReviewFinding({ finding, objects: allObjects, citations: mapped, classification });
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
        tool('finish_stop_review', 'Finish only when every original checklist item and requested file-quality review has a saved result. Final text alone is not a result.',
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
    ...(collection ? { collection } : {}), receipts: worker.receipts, sessionId: session.sessionId, artifacts: directory, close: async () => {} };
}
