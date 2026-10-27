import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskDirectory, decisionGuard } from './task-store.mjs';
import { sha256, readJson } from './utils.mjs';
import { reviewScopeClaims } from './review-scope.mjs';
import { validateReviewFinding } from './review-result-validation.mjs';
import { STOP_REVIEW_SCHEMA } from './reviewer.mjs';
import { runClassificationTask } from '../review-task/classification-task.mjs';
import { runFindingsTask } from '../review-task/findings-task.mjs';
import { taskError } from '../review-task/protocol-task.mjs';
import { STOP_TASK_LIMITS } from '../review-task/stop-policy.mjs';
import { fingerprint } from './evidence-state.mjs';

const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const blocked = /^(?:\.git|\.runtime-correction|node_modules|oh_modules|build|dist|\.aws|\.ssh|\.env(?:\..*)?|auth(?:-profiles)?\.json|.*(?:credentials|secret|api[-_]?key).*)$/iu;
const textFile = /\.(?:md|txt|json5?|ya?ml|toml|[cm]?js|jsx|tsx?|ets|py|java|kt|rs|go|[ch](?:pp)?|css|html|xml|csv|sql|sh|ps1)$/iu;
export const DEFAULT_STOP_STAGES = Object.freeze(['requirements', 'proposal', 'design', 'planning', 'tasks', 'test_design', 'implementation', 'coding', 'verification', '需求', '设计', '规划', '实现', '验证']);

// Freeze original inputs directly for source_* tools. No legacy request/index
// protocol and no interpretation of the model's final natural-language text.
export async function runStopProtocolTask(input, { session, kind }) {
  session.active();
  const projectRoot = await fs.realpath(input.projectRoot);
  const excluded = (input.excludedEvidencePaths ?? []).map(file => path.resolve(file));
  const programOwned = file => excluded.some(directory => directory === file || within(directory, file));
  const directory = path.join(taskDirectory(projectRoot, input.taskId), 'review-task-runs', `${kind}-${randomUUID()}`);
  const root = path.join(directory, 'frozen-source');
  await fs.mkdir(root, { recursive: true });
  const origins = new Map(), dependencies = new Map(), directories = new Map(), basisFiles = [];
  const taskPath = path.join(taskDirectory(projectRoot, input.taskId), 'task.json');
  const guard = async () => { const task = await readJson(taskPath); return task ? decisionGuard(task) : null; };
  const originalGuard = await guard();
  const truthPath = input.request.groundTruthPath && path.resolve(projectRoot, input.request.groundTruthPath);
  const persistedTruth = truthPath ? await fs.readFile(truthPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  const truth = structuredClone(input.evidence?.groundTruth ?? (persistedTruth && JSON.parse(persistedTruth)));
  if (!truth || truth.taskId && truth.taskId !== input.taskId) throw taskError('STOP_TASK_BASIS_UNAVAILABLE', 'Frozen authoritative baseline is unavailable');
  async function assertCurrent() {
    session.active();
    const current = await readJson(taskPath);
    if (current?.control?.cancelled || sha256(await guard()) !== sha256(originalGuard))
      throw taskError('STOP_TASK_INPUT_CHANGED', 'Task ownership or input generation changed');
    if (persistedTruth && sha256(await fs.readFile(truthPath)) !== sha256(persistedTruth))
      throw taskError('STOP_TASK_INPUT_CHANGED', 'Authoritative baseline changed');
    for (const [file, hash] of dependencies) if (await fs.realpath(file) !== file || sha256(await fs.readFile(file)) !== hash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'Original evidence changed');
    for (const [directory, hash] of directories) if (await fingerprint(directory) !== hash)
      throw taskError('STOP_TASK_INPUT_CHANGED', 'Original evidence inventory changed');
    session.active();
  }
  async function write(file, bytes, { mandatory = false, original = null, owner = 'BASIS' } = {}) {
    session.active();
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes, { flag: 'wx' });
    origins.set(file, { path: original ?? path.join(root, file), contentHash: sha256(bytes), frozen: !original, owner });
    if (mandatory) basisFiles.push(file);
  }
  async function parts(name, value, mandatory, owner = 'BASIS') {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    for (let start = 0, index = 0; start < bytes.length; index++) {
      let end = Math.min(start + 16384, bytes.length);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      await write(`${name}-${String(index).padStart(4, '0')}.txt`, bytes.subarray(start, end), { mandatory, owner }); start = end;
    }
  }
  const scope = input.request.reviewScope ?? {};
  const objects = input.request.findingsObjects ?? Object.values(input.request.population?.metrics ?? {}).flat();
  const sourceIds = scope.sourceIds ?? objects.map(object => object.sourceId);
  const claims = reviewScopeClaims(truth, { sourceIds, classification: kind === 'classification' });
  await parts('basis/ground-truth', { taskId: input.taskId, version: truth.version, digest: truth.digest, claims }, true);
  const stages = input.request.workflowStages?.length ? input.request.workflowStages : DEFAULT_STOP_STAGES;
  const request = { workerType: kind, hook: input.request.hook, instructions: input.request.instructions,
    workflowStages: stages, currentStage: input.request.currentStage ?? null, sourceIds,
    ...(kind === 'findings' ? { objects, fixedStopClassification: input.request.fixedStopClassification } : {}) };
  await parts('basis/request', request, true);
  const entries = input.evidence?.snapshot?.entries ?? [];
  if (kind === 'classification') {
    const originalUsers = entries.filter(entry => entry.type === 'user' && (typeof entry.message?.content === 'string'
      || entry.message?.content?.some?.(block => block.type === 'text')));
    await parts('basis/original-user-messages', originalUsers, true);
    const latestAssistant = [...entries].reverse().find(entry => entry.type === 'assistant');
    await parts('basis/latest-assistant', { entry: latestAssistant ?? null, response: input.request.hook?.last_assistant_message ?? null }, true);
  } else {
    for (const [index, entry] of entries.entries()) await parts(`execution/${String(index).padStart(6, '0')}`, entry, false, 'PROCESS');
    const copy = async (absolute, expected = null) => {
      session.active();
      const relative = path.relative(projectRoot, absolute);
      if (!relative || !within(projectRoot, absolute) || programOwned(absolute) || relative.split(path.sep).some(part => blocked.test(part)))
        throw taskError('STOP_TASK_SOURCE_INVALID', 'Source is outside the permitted business scope');
      if (!textFile.test(relative)) return;
      if (await fs.realpath(absolute) !== absolute) throw taskError('STOP_TASK_SOURCE_INVALID', 'Linked source is unavailable');
      const bytes = await fs.readFile(absolute);
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return;
      if (expected && sha256(bytes) !== expected) throw taskError('STOP_TASK_INPUT_CHANGED', 'Source manifest changed');
      const name = `project/${relative.replaceAll('\\', '/')}`;
      if (origins.has(name) && origins.get(name).contentHash !== sha256(bytes)) throw taskError('STOP_TASK_INPUT_CHANGED', 'Source changed during capture');
      dependencies.set(absolute, sha256(bytes));
      if (!origins.has(name)) await write(name, bytes, { original: absolute, owner: 'ARTIFACT' });
    };
    if (Array.isArray(input.request.sourceManifest)) {
      for (const entry of input.request.sourceManifest) await copy(path.resolve(projectRoot, entry.path ?? entry.relativePath), entry.sha256);
    }
    {
      const walk = async directory => {
        directories.set(directory, await fingerprint(directory));
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          session.active(); if (blocked.test(entry.name)) continue;
          if (entry.isSymbolicLink()) throw taskError('STOP_TASK_SOURCE_INVALID', 'Linked source is unavailable');
          const file = path.join(directory, entry.name);
          if (programOwned(file)) continue;
          if (entry.isDirectory()) await walk(file); else if (entry.isFile()) await copy(file);
        }
      }; await walk(projectRoot);
    }
    if (input.request.deviceEvidence) await parts('execution/program-verification', input.request.deviceEvidence, false, 'PROCESS');
  }
  const identity = sha256({ protocol: 'stop-protocol-v1', kind, taskId: input.taskId, guard: originalGuard, request,
    sources: [...origins].map(([file, metadata]) => [file, metadata.contentHash]) });
  const task = { id: identity, scope: kind, requirement: kind === 'classification' ? 'Classify the current Stop from original sources.'
    : 'Find only demonstrated deviations in the assigned frozen scope.', basisFiles, allowedStages: [...stages] };
  await input.onPrepared?.({ requestDirectory: directory, requestPath: path.join(root, basisFiles[0]), request: { ...request, task } });
  await assertCurrent();
  const options = { task, root, outputDir: directory, signal: session.signal, deadlineAt: session.deadlineAt,
    nativeRun: session.run, assertCurrent, limits: input.taskLimits ?? STOP_TASK_LIMITS };
  const findingSchema = structuredClone(STOP_REVIEW_SCHEMA.properties.findings.items);
  delete findingSchema.properties.actualEvidence;
  findingSchema.required = findingSchema.required.filter(name => name !== 'actualEvidence');
  findingSchema.required.push('citeIds', 'violatedGroundTruthIds');
  findingSchema.properties.citeIds = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } };
  findingSchema.properties.violatedGroundTruthIds.minItems = 1;
  const acceptBatch = async (values, ctx) => {
    const findings = [], citations = [], keys = new Set();
    for (const { citeIds, ...finding } of values) {
      if ([...ctx.state.batches.values()].some(batch => batch.findings.some(saved => saved.deviationKey === finding.deviationKey))
        || keys.has(finding.deviationKey)) throw taskError('TASK_SUBMISSION_CONFLICT', 'Duplicate finding identity');
      if (!finding.violatedGroundTruthIds.length || finding.violatedGroundTruthIds.some(id => !sourceIds.includes(id)))
        throw taskError('REVIEW_ITEM_OWNERSHIP_INVALID', 'Finding references an unassigned obligation');
      const refs = ctx.citations(citeIds), mapped = refs.map(ref => {
        const origin = origins.get(ref.path);
        if (!origin || origin.contentHash !== ref.sha256) throw taskError('TASK_CITATION_INVALID', 'Citation differs from frozen source');
        const owner = origin.owner === 'ARTIFACT' && /\.(?:[cm]?js|tsx?|ets|py|java|kt|rs|go|[ch](?:pp)?)$/iu.test(origin.path)
          && objects.some(object => finding.violatedGroundTruthIds.includes(object.sourceId) && object.verificationTarget === 'IMPLEMENTATION') ? 'SOURCE' : origin.owner;
        return { path: origin.path, contentHash: origin.contentHash, frozen: origin.frozen, start: ref.start, end: ref.end,
          selection: `${origin.path}#L${ref.start}-L${ref.end}`, snapshotPath: path.join(root, ref.path), usedBy: [finding.deviationKey],
          readProof: { version: 1, observed: true, basisComplete: true, owner } };
      });
      finding.actualEvidence = mapped.map(ref => ref.selection);
      validateReviewFinding({ finding, objects, citations: mapped, classification: input.request.fixedStopClassification });
      keys.add(finding.deviationKey); findings.push(finding); citations.push(...mapped);
    }
    // These identities are only committed by the protocol after disk persistence.
    return { findings, citations };
  };
  let worker;
  try { worker = kind === 'classification' ? await runClassificationTask(options) : await runFindingsTask({ ...options, findingSchema, acceptBatch,
    commitBatch: async accepted => {
      await assertCurrent();
      await input.onFindingsBatch?.({ result: { ...input.request.fixedStopClassification, summary: 'Saved checked findings batch.',
        findings: accepted.findings, metricObjectJudgements: [], fileAssessments: [] }, sourceCitations: accepted.citations,
        reviewEvidence: { unstable: false, files: [...dependencies.keys(), ...directories.keys()], fingerprints: Object.fromEntries([...dependencies, ...directories]), missing: [] } });
    },
  }); }
  catch (error) {
    if (kind === 'findings' && !['STOP_TASK_INPUT_CHANGED', 'REVIEW_COLLECTION_CANCELLED'].includes(error.code) && error.protocolResult?.result) error.partialReview = { ...input.request.fixedStopClassification,
      ...error.protocolResult.result, metricObjectJudgements: [], fileAssessments: [] };
    throw error;
  }
  const result = kind === 'classification' ? { ...worker.result, findings: [], metricObjectJudgements: [], fileAssessments: [] }
    : { ...input.request.fixedStopClassification, summary: worker.result.summary, findings: worker.result.findings, metricObjectJudgements: [], fileAssessments: [] };
  const sourceCitations = worker.result.citations ?? [];
  return { result, sourceCitations, getSourceCitations: async () => structuredClone(sourceCitations), sessionId: session.sessionId,
    reviewEvidence: { unstable: false, files: [...dependencies.keys(), ...directories.keys()], fingerprints: Object.fromEntries([...dependencies, ...directories]), missing: [] },
    receipts: worker.receipts, artifacts: directory, close: async () => {} };
}
