// Program-owned reuse of a completely acknowledged, accepted original basis.
// Catalogs, model JSON and generic read invocations cannot issue this proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import { groundTruthSourceCatalog, SOURCE_INSTRUCTIONS } from './ground-truth-provenance.mjs';
import { VERIFICATION_ROUTING_INSTRUCTIONS } from './review-routing.mjs';
import { resolveSkillDirectory, scanSkillDirectory, retainedSkillSourceIdentity } from './skill-source.mjs';
import { taskDirectory } from './task-store.mjs';
import { decisionScope } from './decision-scope.mjs';
import { readJson, safeId, sha256, atomicWriteJson } from './utils.mjs';
import { sourceUnits } from '../review-task/baseline-selection.mjs';
import { BASELINE_EXTRACTION_PROTOCOL } from '../review-task/baseline-task.mjs';
import { covers } from '../review-task/evidence-utils.mjs';
import { loadReviewCheckpoint } from '../review-task/history-memory.mjs';
import * as activeHost from '../active-host.mjs';
import { BASELINE_COVERAGE_PROTOCOL, BASELINE_COVERAGE_POLICY, verifyBaselineCoverageProof } from './baseline-coverage-audit.mjs';
import { groundTruthPlanDigest } from './ground-truth-ledger.mjs';

const fail = message => Object.assign(new Error(message), { code: 'BASELINE_SHARED_BASIS_UNVERIFIED' });
const MAX_BYTES = 65536;
const sourceVector = sources => sources.map(({ ref, kind, sha256, bytes }) => ({ ref, kind, sha256, bytes }))
  .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
const sameValue = (left, right) => sha256(left ?? null) === sha256(right ?? null);
const originalReadProof = ({ directory, identity, result, checkpoint, finish }) => ({
  requestId: identity.requestId, runId: path.basename(directory), identityDigest: sha256(identity),
  protocol: BASELINE_EXTRACTION_PROTOCOL, deltaDigest: sha256(result), checkpointDigest: sha256(checkpoint),
  finishDigest: sha256(finish), receiptDigest: sha256(checkpoint.receiptEntries), generation: checkpoint.taskState.generation,
});
const auditGroups = (bundle, truth) => bundle.input.identity.sources.filter(source => source.kind === 'USER_MESSAGE').map(source => {
  const row = bundle.report.sources.find(row => row.ref === source.ref && row.kind === source.kind);
  const ids = new Set(row.mappings.flatMap(mapping => mapping.claimIds));
  return { ref: source.ref, kind: source.kind, sha256: source.sha256, scope: 'FULL_ORIGINAL',
    claims: truth.claims.filter(claim => claim.status === 'ACTIVE' && ids.has(claim.claimId)) };
});
async function readOrigin(pointer, expectedPath) {
  if (!pointer || !/^[a-f0-9]{64}$/u.test(pointer.digest) || !/^[a-f0-9]{64}$/u.test(pointer.bytesDigest)
    || pointer.path !== expectedPath || await fs.realpath(expectedPath) !== expectedPath) throw fail('Foreign accepted-source origin path');
  const bytes = await fs.readFile(expectedPath), value = JSON.parse(bytes.toString('utf8'));
  if (sha256(bytes) !== pointer.bytesDigest || sha256(value) !== pointer.digest) throw fail('Accepted-source origin bytes changed');
  return value;
}
function checkOriginReceipt(receipt, bundle, truth) {
  const input = bundle.input;
  if (receipt?.requestId !== input.identity.requestId || receipt.deltaHash !== sha256(input.delta) || !receipt.result
    || !sameValue(receipt.result.accepted ?? [], input.plan.accepted)
    || !sameValue(receipt.result.operationDispositions, input.plan.operationDispositions)
    || groundTruthPlanDigest({ ...input.plan, ...receipt.result, current: truth }) !== bundle.identity.planDigest)
    throw fail('Accepted-source origin has no matching actual baseline commit');
}
async function checkedOrigin(certificate, { projectRoot, task, truth, bundle }) {
  const record = task.groundTruth?.sharedBasis, proof = record?.proof, input = bundle.input;
  if (!proof || typeof proof.runId !== 'string' || !proof.runId || ['.', '..'].includes(proof.runId) || path.basename(proof.runId) !== proof.runId
    || record.taskId !== task.taskId || record.rootSessionId !== task.rootSessionId
    || record.baselineVersion !== truth.version || record.baselineDigest !== truth.digest
    || !sameValue(record.coverageAudit, certificate.coverageAudit)
    || certificate.coverageAudit.protocol !== BASELINE_COVERAGE_PROTOCOL
    || certificate.coverageAudit.deltaDigest !== sha256(input.delta)
    || input.projectRoot !== path.resolve(projectRoot) || input.identity.taskId !== task.taskId
    || input.identity.requestId !== proof.requestId || input.identity.sourceRetentionPolicy !== certificate.policy)
    throw fail('Accepted-source origin lost its actual task or independent audit');
  const directory = path.join(taskDirectory(projectRoot, task.taskId), 'baseline-task-runs', proof.runId);
  if (await fs.realpath(directory) !== directory || input.directory !== directory) throw fail('Foreign accepted-source extraction run');
  const snapshot = await readOrigin(certificate.origin?.snapshot,
    path.join(directory, 'acceptance-snapshots', `${certificate.origin?.snapshot?.digest}.json`));
  if (snapshot.schemaVersion !== 'runtime-corrector.accepted-source-inputs.v1' || snapshot.directory !== directory
    || !sameValue(snapshot.identity, input.identity) || !sameValue(snapshot.result, input.delta)
    || !sameValue(snapshot.requiredFiles, input.requiredFiles) || !sameValue(snapshot.finish, input.finish)
    || !sameValue(snapshot.batches, input.batches)
    || !sameValue(snapshot.checkpoint?.taskState?.retainedSourceUnits, input.retainedSourceUnits)
    || !sameValue(Object.fromEntries(snapshot.checkpoint?.files?.map(([name, metadata]) => [name, metadata.sha256]) ?? []), input.fileHashes)
    || !sameValue(originalReadProof(snapshot), proof)) throw fail('Accepted-source snapshot differs from its acknowledged and audited candidate');
  // Use the sealed acceptance snapshot, never the later rolling task_closed checkpoint.
  await acknowledgedSharedProof({ directory, identity: snapshot.identity, requiredFiles: snapshot.requiredFiles,
    result: snapshot.result, immutableSnapshot: snapshot, retainedSourceUnits: input.retainedSourceUnits });
  const receipt = await readOrigin(certificate.origin?.receipt,
    path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/baseline-applied', `${sha256(input.identity.requestId)}.json`));
  checkOriginReceipt(receipt, bundle, truth);
}
async function checkedCertificate(pointer, { projectRoot, task, truth, policy, bundle = null, proof = null }) {
  const root = path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/accepted-sources');
  if (!pointer?.path || !path.resolve(pointer.path).startsWith(root + path.sep) || await fs.realpath(pointer.path) !== path.resolve(pointer.path)) throw fail('Foreign source certificate');
  const bytes = await fs.readFile(pointer.path), certificate = JSON.parse(bytes.toString('utf8'));
  if (sha256(bytes) !== pointer.bytesDigest || sha256(certificate) !== pointer.digest
    || certificate.schemaVersion !== 'runtime-corrector.accepted-user-sources.v2' || certificate.taskId !== task.taskId
    || certificate.rootSessionId !== task.rootSessionId || certificate.baselineVersion !== truth.version || certificate.baselineDigest !== truth.digest
    || sha256(certificate.protocol) !== sha256(BASELINE_EXTRACTION_PROTOCOL) || certificate.policy !== policy
    || certificate.coverageAudit?.policy !== BASELINE_COVERAGE_POLICY || proof && sha256(certificate.coverageAudit) !== sha256(proof)) throw fail('Changed or weak source certificate');
  bundle ??= await verifyBaselineCoverageProof(certificate.coverageAudit.pointer, { identity: certificate.coverageAudit.identity, truth });
  if (sha256(certificate.groups) !== sha256(auditGroups(bundle, truth))) throw fail('Source certificate targets no longer match the independent report');
  await checkedOrigin(certificate, { projectRoot, task, truth, bundle });
  return { certificate, bundle };
}

export async function sharedOriginalBasis({ projectRoot, pluginRoot, task, snapshot, materials, runtimeV2, skill = null, reviewerIdentity = null, readOriginalMaterial }) {
  const ids = new Set((task.groundTruth.sharedBasis?.adoptedSkills ?? []).map(item => item.skillId));
  const graphIdentities = new Map();
  for (const watcher of Object.values(task.watchers ?? {})) if (watcher.skillId) ids.add(watcher.skillId);
  if (skill) ids.add(skill.skillId);
  // Legacy adoption predates shared certificates, including already-PASS
  // watchers. Recover identifiers from real task records, never sourceRef paths.
  const graphRoot = path.join(taskDirectory(projectRoot, task.taskId), 'skills');
  for (const entry of await fs.readdir(graphRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })) {
    if (!entry.isDirectory()) continue;
    let graph;
    try { graph = await readJson(path.join(graphRoot, entry.name, 'skill-ground-truth.json')); }
    catch (error) {
      // A corrupt derived graph may be rebuilt for an already known adopted
      // identifier. It cannot supply a new identity or an original source path.
      if (error instanceof SyntaxError && [...ids].some(id => safeId(id) === entry.name)) continue;
      throw error;
    }
    if (graph?.taskId === task.taskId && typeof graph.skillId === 'string' && safeId(graph.skillId) === entry.name) {
      ids.add(graph.skillId);
      if (graph.sourceContract?.sourceIdentity && graph.digest === sha256({ skillId: graph.skillId, skillDigest: graph.skillDigest,
        constraints: graph.constraints, taskOverlays: graph.taskOverlays, sourceContract: graph.sourceContract }))
        graphIdentities.set(graph.skillId, graph.sourceContract.sourceIdentity);
    }
  }
  const adoptedSkills = [], catalog = await groundTruthSourceCatalog({ snapshot, materials, projectRoot });
  for (const skillId of [...ids].sort()) {
    const sourceIdentity = skill?.skillId === skillId ? skill.source.identity : retainedSkillSourceIdentity(task, skillId) ?? graphIdentities.get(skillId);
    const directory = await resolveSkillDirectory({ skillId, projectRoot, pluginRoot,
      configuredRoots: runtimeV2.skillCorrection.skillRoots, sourceIdentity });
    if (!directory) throw fail(`Previously adopted Skill cannot be safely resolved: ${skillId}`);
    const source = await scanSkillDirectory(directory, { cache: false, sourceIdentity });
    if (source.truncated) throw fail(`Incomplete original Skill: ${skillId}`);
    if (skill?.skillId === skillId && (await fs.realpath(skill.directory) !== await fs.realpath(directory)
      || skill.source.digest !== source.digest)) throw fail(`Selected Skill source changed: ${skillId}`);
    adoptedSkills.push({ skillId, digest: source.digest, ...(sourceIdentity ? { sourceIdentity } : {}) });
    const selected = await groundTruthSourceCatalog({ snapshot: { entries: [] }, materials: { entries: [] }, projectRoot,
      skill: { skillId, directory, source }, hostAdapter: { instructionFileNames: [] } });
    catalog.push(...selected);
  }
  const unique = new Map();
  for (const source of catalog) {
    const key = `${source.kind}:${source.ref}`;
    if (unique.has(key)) {
      if (source.kind === 'USER_MESSAGE' && unique.get(key).source.contentDigest !== source.contentDigest)
        throw fail(`Conflicting original user identity: ${source.ref}`);
      continue;
    }
    if (source.kind === 'USER_MESSAGE') {
      if (!source.contentDigest) throw fail('Missing complete original user hash');
      unique.set(key, { source, identity: { ref: source.ref, kind: source.kind, sha256: source.contentDigest } });
    } else {
      const file = path.resolve(projectRoot, source.ref);
      if (file !== await fs.realpath(file)) throw fail(`Linked original source: ${source.ref}`);
      const bytes = await readOriginalMaterial?.(file) ?? await fs.readFile(file);
      if (bytes.includes(0)) throw fail(`Non-text original source: ${source.ref}`);
      unique.set(key, { source, identity: { ref: source.ref, kind: source.kind, sha256: sha256(bytes), bytes: bytes.length } });
    }
  }
  const sources = sourceVector([...unique.values()].map(item => item.identity));
  // Removed previously adopted authority cannot become a smaller cache hit.
  for (const previous of task.groundTruth.sharedBasis?.sources ?? []) {
    if (!sources.some(source => source.kind === previous.kind && source.ref === previous.ref))
      throw fail(`Previously aligned original is unavailable: ${previous.ref}`);
  }
  const policy = sha256({ coverage: BASELINE_COVERAGE_POLICY, reviewer: reviewerIdentity ?? runtimeV2.reviewers?.groundTruthExtractor, protocol: BASELINE_EXTRACTION_PROTOCOL, routing: VERIFICATION_ROUTING_INSTRUCTIONS,
    authority: SOURCE_INSTRUCTIONS, materialRoots: runtimeV2.dynamicGroundTruth.materialRoots,
    skillRoots: runtimeV2.skillCorrection.skillRoots, host: activeHost.host,
    instructionFileNames: activeHost.instructionFileNames, pluginRoot: pluginRoot ? path.resolve(pluginRoot) : null });
  const basis = { taskId: task.taskId, rootSessionId: task.rootSessionId,
    projectRoot: await fs.realpath(projectRoot), policy, sources, adoptedSkills };
  return { ...basis, digest: sha256(basis), catalog: [...unique.values()].map(item => item.source) };
}

export async function sharedBasisMatches(record, basis, truth, task) {
  const proof = record?.proof;
  const matches = Boolean(record?.schemaVersion === 'runtime-corrector.shared-basis.v1' && record.basisDigest === basis.digest
    && basis.taskId === task.taskId && truth.taskId === task.taskId
    && record.taskId === task.taskId && record.rootSessionId === task.rootSessionId
    && record.baselineVersion === truth.version && record.baselineDigest === truth.digest
    && sha256(record.sources ?? []) === sha256(basis.sources) && sha256(record.adoptedSkills ?? []) === sha256(basis.adoptedSkills)
    && !task.groundTruth.pendingUserCursor && !task.control?.pendingRequirement
    && proof?.requestId && proof.runId && proof.identityDigest && proof.checkpointDigest && proof.finishDigest && proof.receiptDigest
    && Number.isSafeInteger(proof.generation) && proof.generation >= 0
    && sha256(proof.protocol ?? null) === sha256(BASELINE_EXTRACTION_PROTOCOL)
    && record.coverageAudit?.protocol === BASELINE_COVERAGE_PROTOCOL && record.coverageAudit.policy === BASELINE_COVERAGE_POLICY);
  if (!matches) return false;
  try {
    const bundle = await verifyBaselineCoverageProof(record.coverageAudit.pointer, { identity: record.coverageAudit.identity, truth });
    await checkedCertificate(record.acceptedSourceCertificate, { projectRoot: basis.projectRoot, task, truth, policy: basis.policy, bundle, proof: record.coverageAudit });
    return bundle.input.projectRoot === basis.projectRoot && bundle.identity.taskId === task.taskId
      && sha256(sourceVector(bundle.input.identity.sources.map(source => ({ ...source, ...(source.kind === 'USER_MESSAGE' ? { bytes: undefined } : {}) })))) === sha256(basis.sources);
  } catch { return false; }
}

export function guardSharedBasis(assertCurrent) {
  const scope = decisionScope.getStore();
  if (!scope) throw fail('Shared alignment needs a guarded task publication');
  const previous = scope.context.evidenceMatches;
  scope.context.evidenceMatches = async () => {
    if (previous && !await previous()) return false;
    try { await assertCurrent(); return true; }
    catch (error) { scope.context.evidenceFailure = { code: error.code ?? 'BASELINE_INPUT_CHANGED', reason: error.message }; return false; }
  };
}

export async function acknowledgedSharedProof({ directory, identity, requiredFiles, result, immutableSnapshot = null,
  retainedSourceUnits = [] }) {
  // Validate the existing worker journal and original pages, including its
  // numbered-read rendering. Claimed checkpoint ranges alone grant no proof.
  const checkpointPath = path.join(directory, 'review-checkpoint.json');
  const checkpoint = immutableSnapshot?.checkpoint ?? await loadReviewCheckpoint(checkpointPath), state = checkpoint?.taskState;
  const finishPath = path.join(directory, `candidates-${state?.generation}`, 'finish.json');
  const finish = immutableSnapshot?.finish ?? await readJson(finishPath);
  const same = (left, right) => sha256(left ?? null) === sha256(right ?? null);
  if (checkpoint?.schemaVersion !== 'review.memory-checkpoint.v3'
    || !identity.taskId || !same(identity.protocol, BASELINE_EXTRACTION_PROTOCOL)
    || checkpoint.task?.id !== identity.requestId || !same(checkpoint.task.basisFiles, requiredFiles)
    || !same(checkpoint.task.targetFiles, requiredFiles) || checkpoint.sourceMode !== 'snapshot'
    || await fs.realpath(checkpoint.root) !== await fs.realpath(path.join(directory, 'frozen-source'))
    || !same(state?.identity, identity) || state.taskId !== identity.taskId
    || state.baselineVersion !== identity.baselineVersion || state.baselineDigest !== identity.baselineDigest
    || state.requestId !== identity.requestId || state.phase !== 'CANDIDATE_COMPLETE' || state.pending?.length !== 0
    || !Number.isSafeInteger(state.generation) || state.generation < 0
    || finish?.requestId !== identity.requestId || finish.receipt?.complete !== true
    || finish.receipt.requestId !== identity.requestId || finish.receipt.generation !== state.generation
    || finish.receipt.status !== (result.operations.length ? 'DELTA_READY' : 'NO_CHANGE')
    || finish.receipt?.deltaDigest !== sha256(result) || finish.digest !== sha256(result)
    || sha256(finish.delta) !== sha256(result)) throw fail('No genuine complete bounded finish/checkpoint');
  if (!Array.isArray(state.batches) || state.batches.some((batch, i) => batch.batchId !== i + 1
    || batch.requestId !== identity.requestId || batch.generation !== state.generation)
    || finish.hash !== sha256({ batchIds: state.batches.map(batch => batch.batchId),
      taskClassification: result.taskClassification, summary: result.summary })) throw fail('Foreign candidate completion');
  const files = new Map(checkpoint.files ?? []);
  if (files.size !== requiredFiles.length || requiredFiles.some(file => path.basename(file) !== file))
    throw fail('Foreign required file set');
  if (await fs.realpath(checkpoint.sessionFile) !== path.join(await fs.realpath(directory), 'observations.jsonl'))
    throw fail('Foreign original acknowledgement journal');
  const entries = immutableSnapshot?.entries ?? (await fs.readFile(checkpoint.sessionFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (entries[0]?.type !== 'review_session' || entries[0].id !== checkpoint.sessionId) throw fail('Foreign acknowledgement session');
  const receipts = checkpoint.receiptEntries ?? [], citations = checkpoint.citations ?? [];
  if (!citations.length || receipts.length !== citations.length || new Set(citations.map(citation => citation.citeId)).size !== citations.length)
    throw fail('Missing acknowledged original receipts');
  for (const citation of citations) {
    const receipt = receipts.find(item => item.citeId === citation.citeId);
    const entry = receipt && entries.find(item => item.id === receipt.entryId);
    if (!receipt?.toolCallId || entry?.message?.toolCallId !== receipt.toolCallId
      || entry.type !== 'review_observation' || entry.message.role !== 'toolResult'
      || entry.message.toolName !== 'source_read' || entry.message.isError !== false
      || !entry.message.content?.length || entry.message.content.some(block => block.type !== 'text')
      || !['openclaw.tool_result_persist.v1', 'cli.stream_tool_result.v1'].includes(entry.message.details?.receiptBoundary)
      || !same(entry.message.details?.citation, citation)) throw fail('Unbound original read receipt');
  }
  const acknowledged = citations.map(({ path, start, end }) => ({ path, start, end }));
  if (!Array.isArray(checkpoint.reads) || checkpoint.reads.some(read => !acknowledged.some(citation => same(citation, read))))
    throw fail('Claimed read without acknowledgement');
  for (const file of requiredFiles) {
    const metadata = files.get(file);
    if (!metadata || !covers(acknowledged, file, 1, metadata.lines)
      || !covers(checkpoint.reads, file, 1, metadata.lines)) throw fail(`Unacknowledged original range: ${file}`);
  }
  for (const source of identity.sources) {
    let position = 0; const parts = [];
    for (const part of source.parts) {
      if (files.get(part.file)?.sha256 !== part.sha256 || part.startByte !== position)
        throw fail('Original snapshot/part mismatch');
      const bytes = await fs.readFile(path.join(checkpoint.root, part.file));
      if (part.endByte !== position + bytes.length) throw fail('Original snapshot/part mismatch');
      parts.push(bytes); position = part.endByte;
    }
    if (position !== source.bytes || sha256(Buffer.concat(parts)) !== source.sha256) throw fail('Original source hash mismatch');
  }
  const proof = originalReadProof({ directory, identity, result, checkpoint, finish });
  const originals = sourceVector(identity.sources.map(source => ({ ...source,
    ...(source.kind === 'USER_MESSAGE' ? { bytes: undefined } : {}) })));
  const batches = immutableSnapshot?.batches ?? await Promise.all(state.batches.map(batch => readJson(path.join(directory, `candidates-${state.generation}`, `batch-${batch.batchId}.json`))));
  if (batches.some((batch, i) => !batch || !same(batch.receipt, state.batches[i])
    || batch.digest !== sha256(batch.operations) || batch.scopeDigest !== sha256(batch.decisions)
    || batch.requestId !== identity.requestId || batch.generation !== state.generation)
    || !same(batches.flatMap(batch => batch.operations), result.operations)) throw fail('Changed candidate operation/source mapping');
  const snapshot = immutableSnapshot ?? { schemaVersion: 'runtime-corrector.accepted-source-inputs.v1',
    directory, identity, requiredFiles, result, checkpoint, finish, entries, batches };
  let snapshotPointer = null;
  if (Buffer.byteLength(JSON.stringify(snapshot)) <= 16 * 1024 * 1024) {
    const digest = sha256(snapshot), file = path.join(directory, 'acceptance-snapshots', `${digest}.json`);
    if (!immutableSnapshot) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.writeFile(file, JSON.stringify(snapshot), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST' || sha256(await readJson(file)) !== digest) throw error; }
    }
    snapshotPointer = { path: file, digest, bytesDigest: sha256(Buffer.from(JSON.stringify(snapshot))) };
  }
  // Only the independently verified capability can upgrade this source receipt.
  let audit = null;
  return { requiresSemanticAudit: true, auditSnapshot: () => structuredClone(snapshot),
    attachAudit(capability) {
      if (typeof capability?.assertApplied !== 'function' || capability.proof?.identity?.requestId !== identity.requestId
        || capability.proof.identity.generation !== proof.generation || capability.proof.deltaDigest !== proof.deltaDigest) throw fail('Foreign independent audit capability');
      audit = capability;
    }, bind(basis, delta, current) {
    if (!audit || audit.proof.policy !== BASELINE_COVERAGE_POLICY || basis.taskId !== identity.taskId || current.taskId !== identity.taskId
      || sha256(delta) !== proof.deltaDigest || sha256(basis.sources) !== sha256(originals)) return null;
    const record = { schemaVersion: 'runtime-corrector.shared-basis.v1', taskId: basis.taskId,
      rootSessionId: basis.rootSessionId, basisDigest: basis.digest, sources: basis.sources,
      adoptedSkills: basis.adoptedSkills, baselineVersion: current.version, baselineDigest: current.digest, proof, coverageAudit: audit.proof };
    return record.sources.length <= 1024 && Buffer.byteLength(JSON.stringify(record)) <= MAX_BYTES ? record : null;
  }, async certifyAccepted({ projectRoot, task, basis, delta, applied, assertCurrent }) {
    const scope = decisionScope.getStore();
    if (!scope || path.resolve(scope.directory) !== path.resolve(taskDirectory(projectRoot, task.taskId)))
      throw fail('Accepted-source certificates require their owning guarded task publication');
    scope.context.abortSignal?.throwIfAborted();
    if (scope.context.deadlineAt != null && Date.now() >= scope.context.deadlineAt) throw fail('Accepted-source publication deadline expired');
    await assertCurrent();
    if (!audit || !snapshotPointer || !same(delta, result) || task.taskId !== identity.taskId || basis.policy !== identity.sourceRetentionPolicy)
      throw fail('No current independently audited source closure');
    await audit.assertApplied(applied);
    const live = await readJson(path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/current.json'));
    if (!same(live, applied.current)) throw fail('Accepted-source certificate lost current ledger identity');
    const receiptPath = path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/baseline-applied', `${sha256(identity.requestId)}.json`);
    const receipt = await readJson(receiptPath);
    if (receipt?.requestId !== identity.requestId || receipt.deltaHash !== sha256(delta)
      || !same(receipt.result.accepted ?? [], applied.accepted ?? [])) throw fail('No actual accepted baseline commit for source certificate');
    const bundle = await verifyBaselineCoverageProof(audit.proof.pointer, { identity: audit.proof.identity, truth: applied.current });
    checkOriginReceipt(receipt, bundle, applied.current);
    const groups = auditGroups(bundle, applied.current);
    const certificate = { schemaVersion: 'runtime-corrector.accepted-user-sources.v2', taskId: task.taskId,
      rootSessionId: task.rootSessionId, protocol: BASELINE_EXTRACTION_PROTOCOL, policy: basis.policy,
      baselineVersion: applied.current.version, baselineDigest: applied.current.digest, coverageAudit: audit.proof,
      origin: { snapshot: snapshotPointer, receipt: { path: receiptPath, digest: sha256(receipt), bytesDigest: sha256(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)) } }, groups };
    if (Buffer.byteLength(JSON.stringify(certificate)) > MAX_BYTES) throw fail('Complete source certificate exceeds existing size limit');
    const digest = sha256(certificate), file = path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/accepted-sources', `${digest}.json`);
    const old = await readJson(file);
    if (old && !same(old, certificate)) throw fail('Immutable source certificate conflict');
    if (!old) await atomicWriteJson(file, certificate);
    await assertCurrent();
    if (sha256(await readJson(file)) !== digest || !same(await readJson(path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/current.json')), applied.current))
      throw fail('Source certificate changed before publication');
    return { path: file, digest, bytesDigest: sha256(Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`)) };
  } };
}

const baseSource = source => String(source?.ref ?? '').replace(/#L[1-9]\d*(?:-L?[1-9]\d*)?$/u, '');
const currentSourceClaims = (truth, ref) => (truth.claims ?? []).filter(claim => claim.status === 'ACTIVE'
  && claim.source?.kind === 'USER_MESSAGE' && baseSource(claim.source) === ref);

// Navigation reuse requires the same independent full-original closure; legacy certificates miss.
export async function loadAcceptedSourceRetention({ projectRoot, task, truth, identity, active }) {
  const pointer = task.groundTruth?.sharedBasis?.acceptedSourceCertificate;
  if (!pointer) return [];
  try {
    active();
    const { certificate } = await checkedCertificate(pointer, { projectRoot, task, truth, policy: identity.sourceRetentionPolicy });
    const units = sourceUnits(identity), result = [];
    for (const group of certificate.groups) {
      active();
      const sourceIndex = identity.sourceCatalog.findIndex(source => source.kind === 'USER_MESSAGE' && source.ref === group.ref);
      const source = identity.sources.find(source => source.kind === 'USER_MESSAGE' && source.ref === group.ref);
      if (!source || group.scope !== 'FULL_ORIGINAL' || source.sha256 !== group.sha256
        || !group.claims.every(claim => truth.claims.some(actual => sha256(claim) === sha256(actual)))) continue;
      const own = units.filter(unit => unit.sourceIndex === sourceIndex);
      if (!own.length) continue;
      result.push({ action: 'KEEP_EXISTING', units: own.map(unit => unit.id), sourceGroup: group,
        claims: group.claims.map(claim => ({ claimId: claim.claimId, revisionId: claim.revisionId, digest: sha256(claim) })) });
    }
    active(); return result;
  } catch { active(); return []; }
}
const sameProtocol = protocol => sha256(protocol) === sha256(BASELINE_EXTRACTION_PROTOCOL);
