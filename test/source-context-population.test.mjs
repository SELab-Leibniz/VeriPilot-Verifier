import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as provenance from '../lib/runtime-v2/ground-truth-provenance.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { applyGroundTruthDelta, loadCurrentGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { artifactOnlyTask, implementationPopulation, selectStopPopulation } from '../lib/runtime-v2/review-routing.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { runImplementationReview } from '../lib/runtime-v2/impl-review.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { registerTaskTools } from '../lib/openclaw/task-tools.mjs';
import { GROUND_TRUTH_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { taskDirectory } from '../lib/runtime-v2/task-store.mjs';
import { runStartedHostEvent } from './helpers/started-host.mjs';

const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, i) =>
  [`M${String(i + 1).padStart(2, '0')}`, [12, 16].includes(i + 1)]));
const reviewPolicy = { metrics, fileQualityReviewEnabled: false };
const expectedIds = ['M12:code', 'M12:guide', 'M12:verify', 'M16:code'];
const objectIds = population => Object.values(population.metrics).flat().map(row => row.objectId).sort();

async function fixture(t, observer = true) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-source-context-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, observer ? '.runtime-correction/observer/project' : 'project');
  const original = path.join(projectRoot, 'materials/requirements.md');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, 'Implement an increment in app.mjs. Deliver guide.md. Run the public verifier.\nDocuments only; no application code is implemented.\n');
  const user = { type: 'user', uuid: 'original-user', message: { content: 'Deliver the requested document.' } };
  const transcript = path.join(projectRoot, 'transcript.jsonl');
  await fs.writeFile(transcript, JSON.stringify(user) + '\n');
  const catalog = await provenance.groundTruthSourceCatalog({ projectRoot,
    materials: { entries: [{ root: path.dirname(original), path: path.basename(original) }] }, snapshot: { entries: [user] } });
  const material = (claimId, text, verificationTarget, category = 'requirements') => ({ operation: 'ADD', claimId,
    category, text, severity: 'HARD', authority: 'MATERIAL_DERIVED', applicabilityKind: 'CURRENT_TASK', verificationTarget,
    source: { ref: original + '#L1', kind: 'MATERIAL', subject: 'MAIN_TASK' } });
  const admit = async (operations, sessionId = 'population') => {
    const task = await ensureTask({ projectRoot, sessionId });
    const result = await applyGroundTruthDelta({ projectRoot, taskId: task.taskId, sourceCatalog: catalog, delta: { operations } });
    assert.equal(result.current.claims.length, operations.length, 'the original catalog admits every fixture obligation');
    return { task, groundTruth: await loadCurrentGroundTruth(projectRoot, task.taskId) };
  };
  const mixed = () => [
    { ...material('code', 'Implement an increment in app.mjs.', 'IMPLEMENTATION'), implementationRole: 'PRODUCTION', expectedFiles: ['app.mjs'] },
    { ...material('guide', 'Deliver guide.md.', 'ARTIFACT'), expectedFiles: ['guide.md'] },
    material('verify', 'Run the public verifier.', 'PROCESS'),
  ];
  const docs = () => [material('docs-only', 'Documents only; no application code is implemented.', 'ARTIFACT', 'outOfScope'),
    { operation: 'ADD', claimId: 'legacy-doc', category: 'requirements', text: 'Deliver the requested document.',
      severity: 'HARD', authority: 'USER_EXPLICIT', source: { ref: 'transcript:original-user', kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } }];
  const populate = ({ task, groundTruth }, policy = reviewPolicy) => buildMetricPopulation({ projectRoot, taskId: task.taskId, groundTruth, reviewPolicy: policy });
  return { base, projectRoot, original, transcript, catalog, material, admit, mixed, docs, populate };
}

test('real catalog admission preserves the complete TASK_COMPLETE population below an observer ancestor', async t => {
  for (const observer of [false, true]) {
    const f = await fixture(t, observer), accepted = await f.admit(f.mixed());
    const population = await f.populate(accepted), selected = selectStopPopulation(population, { stopClassification: 'TASK_COMPLETE' });
    assert.deepEqual(objectIds(selected), expectedIds, `observer=${observer}`);
    assert.equal(selected.scopeSelection.selectedObjectCount, selected.scopeSelection.fullObjectCount);
    const code = selected.metrics.M12.find(row => row.sourceId === 'code');
    assert.equal(code.verificationTarget, 'IMPLEMENTATION');
    assert.equal(code.implementationRole, 'PRODUCTION');
    assert.deepEqual(code.expectedFiles, ['app.mjs']);
    assert.deepEqual(accepted.groundTruth.claims.find(row => row.claimId === 'code').source,
      { ref: f.original + '#L1', kind: 'MATERIAL', subject: 'MAIN_TASK' }, 'projection never rewrites original provenance');
  }
});

test('material-derived docs-only scope suppresses legacy implementation projection and routing after relocation', async t => {
  for (const observer of [false, true]) {
    const f = await fixture(t, observer), accepted = await f.admit(f.docs());
    const population = await f.populate(accepted);
    assert.equal(artifactOnlyTask(accepted.groundTruth, { projectRoot: f.projectRoot }), true, `observer=${observer}`);
    assert.deepEqual(population.metrics.M16, []);
    const routing = implementationPopulation(population, { groundTruth: accepted.groundTruth, projectRoot: f.projectRoot });
    assert.equal(routing.skipReason, 'ARTIFACT_ONLY_TASK');
    assert.deepEqual(objectIds(routing.population), []);
  }
});

test('accepted legacy material obligations survive missing originals and a current catalog without those materials', async t => {
  const f = await fixture(t), accepted = await f.admit(f.mixed());
  assert.equal(accepted.task.groundTruth.sharedBasis, undefined, 'this is a historical ledger without a shared certificate');
  const originalRefs = accepted.groundTruth.claims.map(row => row.source.ref);
  await fs.rm(f.original);
  const currentCatalog = await provenance.groundTruthSourceCatalog({ projectRoot: f.projectRoot });
  assert(!currentCatalog.some(row => row.ref === f.original));
  const population = await f.populate(accepted);
  assert.deepEqual(objectIds(population), expectedIds, 'a missing source is not permission to delete its accepted duty');
  assert.deepEqual((await loadCurrentGroundTruth(f.projectRoot, accepted.task.taskId)).claims.map(row => row.source.ref), originalRefs);
  const disabled = await f.populate(accepted, { ...reviewPolicy, metrics: { ...metrics, M12: false, M16: false } });
  assert.deepEqual(objectIds(disabled), []);
  assert.deepEqual(disabled.disabledSourceIds, ['code', 'guide', 'verify']);
});

test('independent implementation review receives the actual project boundary before requesting a reviewer', async t => {
  const f = await fixture(t), accepted = await f.admit(f.docs());
  const population = await f.populate(accepted);
  let calls = 0;
  const result = await runImplementationReview({ projectRoot: f.projectRoot, taskId: accepted.task.taskId,
    runtimeV2: { implementationCorrection: { platform: null } }, population, groundTruth: accepted.groundTruth,
    reviewerFactory: async () => { calls++; throw new Error('No reviewer is needed for authoritative docs-only scope'); } });
  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.skipReason, 'ARTIFACT_ONLY_TASK');
  assert.equal(calls, 0);
});

test('disabled dynamic refresh keeps original duties and passes the boundary through actual Stop scope preparation', async t => {
  const f = await fixture(t), sessionId = 'disabled-refresh', accepted = await f.admit(f.docs(), sessionId);
  await fs.rm(f.original);
  const captures = [];
  const runtimeV2 = compileRuntimeV2Config({ version: 2,
    dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false },
    stopCorrection: { enabled: true, metrics, fileQualityReviewEnabled: false },
    implementationCorrection: { enabled: true, platform: null },
  }, { policyRoot: path.join(f.projectRoot, '.runtime-corrector') });
  const roles = [];
  await runStartedHostEvent({ projectRoot: f.projectRoot, plan: { runtimeV2, artifacts: [] },
    input: { cwd: f.projectRoot, session_id: sessionId, transcript_path: f.transcript,
      hook_event_name: 'Stop', hook_event_id: 'source-context-stop', last_assistant_message: 'The task is complete.' },
    reviewerFactory: async params => {
      roles.push(params.role);
      if (params.role !== 'stop-reviewer') throw new Error('Disabled refresh must not request extraction');
      const scope = await params.onScope({ stopClassification: 'TASK_COMPLETE', stage: null });
      captures.push({ population: params.request.population, scope });
      // A read-only transport probe; it supplies no semantic verdict or PASS evidence.
      throw Object.assign(new Error('Offline scope captured'), { code: 'OFFLINE_SCOPE_CAPTURED' });
    } });
  assert(captures.length > 0, 'the actual Stop preparer reached its scope callback');
  assert(roles.every(role => role === 'stop-reviewer'));
  for (const captured of captures) {
    assert.deepEqual(objectIds(captured.population), ['M12:legacy-doc']);
    assert.equal(captured.scope.deterministicReview, undefined, 'docs-only scope does not trigger implementation checks');
  }
  assert.equal((await loadCurrentGroundTruth(f.projectRoot, accepted.task.taskId)).digest, accepted.groundTruth.digest);
});

test('accepted-source ownership uses only trusted context and retains conservative internal-source rejection', async t => {
  const f = await fixture(t), operation = f.mixed()[0];
  const reject = provenance.rejectedGroundTruthOwnership;
  assert.equal(typeof reject, 'function');
  assert.equal(reject(operation), 'INTERNAL_SOURCE', 'no-context callers remain conservative');
  assert.equal(reject({ ...operation, projectRoot: f.projectRoot,
    source: { ...operation.source, projectRoot: f.projectRoot, projectRelativePath: 'requirements.md' } }), 'INTERNAL_SOURCE');
  assert.equal(reject(operation, { projectRoot: f.projectRoot }), null);
  assert.equal(reject({ ...operation, source: { ...operation.source, ref: operation.source.ref.replaceAll('/', '\\') } }, { projectRoot: f.projectRoot }), null);
  for (const ref of [path.join(f.projectRoot, '.runtime-correction/private.md'),
    path.join(f.base, '.runtime-correction/observer/private.md'),
    path.join(f.projectRoot, 'materials/../../private.md'),
    'system role instructions', '[runtime-corrector:internal]']) {
    assert.equal(reject({ ...operation, source: { ...operation.source, ref } }, { projectRoot: f.projectRoot }), 'INTERNAL_SOURCE', ref);
  }
  for (const role of ['system', 'assistant', 'tool', 'reviewer'])
    assert.equal(reject({ ...operation, source: { ...operation.source, role } }, { projectRoot: f.projectRoot }), 'INTERNAL_ROLE');
  assert.equal(reject({ ...operation, source: { ...operation.source, subject: 'REVIEWER' } }, { projectRoot: f.projectRoot }), 'REVIEWER_SUBJECT');
  assert.equal(reject({ ...operation, source: { ...operation.source, kind: 'INTERNAL_REVIEWER' } }, { projectRoot: f.projectRoot }), 'INTERNAL_ROLE');
});

test('catalog admission retains unknown, ambiguous, kind and user-authority rejection plus public external materials', async t => {
  const f = await fixture(t), operation = f.mixed()[0];
  const reject = provenance.rejectedGroundTruthSource;
  assert.equal(reject(operation, f.catalog), null);
  assert.equal(reject({ ...operation, source: { ...operation.source, ref: 'not-in-catalog.md' } }, f.catalog), 'SOURCE_NOT_IN_CATALOG');
  const alias = { ...operation, source: { ...operation.source, ref: 'requirements.md' } };
  const ambiguous = [...f.catalog, { ref: path.join(f.projectRoot, 'other/requirements.md'), kind: 'MATERIAL', aliases: ['requirements.md'], projectRelativePath: 'other/requirements.md' }];
  assert.equal(reject(alias, ambiguous), 'AMBIGUOUS_SOURCE');
  assert.equal(reject({ ...operation, source: { ...operation.source, kind: 'PROJECT_FILE' } }, f.catalog), 'SOURCE_KIND_MISMATCH');
  assert.equal(reject({ ...operation, authority: 'USER_EXPLICIT' }, f.catalog), 'NON_USER_AUTHORITY');
  assert.equal(reject({ ...operation, source: { ...operation.source, role: 'reviewer', ref: 'missing' } }, f.catalog), 'INTERNAL_ROLE');
  assert.equal(reject({ ...operation, source: { ...operation.source, subject: 'REVIEWER', role: 'reviewer' } }, f.catalog), 'REVIEWER_SUBJECT');
  const external = path.join(f.base, 'external/requirements.md');
  await fs.mkdir(path.dirname(external)); await fs.writeFile(external, 'Public external material.');
  const externalCatalog = await provenance.groundTruthSourceCatalog({ projectRoot: f.projectRoot,
    materials: { entries: [{ root: path.dirname(external), path: path.basename(external) }] } });
  const supplied = { ...operation, source: { ...operation.source, ref: external + ':1-1' } };
  assert.equal(reject(supplied, externalCatalog), null);
  assert.equal(provenance.rejectedGroundTruthOwnership(supplied, { projectRoot: f.projectRoot }), null);
  const task = await ensureTask({ projectRoot: f.projectRoot, sessionId: 'external-material' });
  const accepted = await applyGroundTruthDelta({ projectRoot: f.projectRoot, taskId: task.taskId,
    sourceCatalog: externalCatalog, delta: { operations: [supplied] } });
  assert.equal(accepted.current.claims.length, 1);
  assert.deepEqual(objectIds(await f.populate({ task, groundTruth: accepted.current })), ['M12:code', 'M16:code']);
  const privateRef = path.join(f.projectRoot, '.runtime-correction/private.md');
  const privateCatalog = await provenance.groundTruthSourceCatalog({ projectRoot: f.projectRoot,
    materials: { entries: [{ root: path.dirname(privateRef), path: path.basename(privateRef) }] } });
  assert.equal(reject({ ...operation, source: { ...operation.source, ref: privateRef, projectRelativePath: 'public.md', projectRoot: f.base } }, privateCatalog), 'INTERNAL_SOURCE');
});

test('actual bounded intake still rejects project-private, traversal, linked and external observer-private sources before native dispatch', async t => {
  const f = await fixture(t), accepted = await f.admit(f.mixed());
  const privateFile = path.join(f.projectRoot, '.runtime-correction/private.md');
  const externalFile = path.join(f.base, 'external.md');
  const externalPrivate = path.join(f.base, '.runtime-correction/observer/private.md');
  await fs.writeFile(privateFile, 'Internal task source.');
  await fs.writeFile(externalFile, 'Uncatalogued external original.');
  await fs.writeFile(externalPrivate, 'External observer source.');
  const linkedPrivate = path.join(f.projectRoot, 'materials/linked-private.md');
  const linkedExternal = path.join(f.projectRoot, 'materials/linked-external.md');
  await fs.symlink(privateFile, linkedPrivate); await fs.symlink(externalFile, linkedExternal);
  let dispatches = 0;
  const api = { rootDir: path.resolve('.'),
    config: { agents: { defaults: { model: { primary: 'fixture/model' } } },
      models: { providers: { fixture: { models: [{ id: 'model', contextWindow: 200000, maxTokens: 65536 }] } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, logger: { warn() {}, info() {} },
    registerTool() {}, on() {} };
  registerTaskTools(api);
  const reviewer = createOpenClawReviewerFactory(api, { runEmbeddedAgent: async () => {
    dispatches++; throw new Error('Unsafe input must be rejected before native dispatch');
  } });
  for (const ref of [privateFile, `${f.projectRoot}/materials/../.runtime-correction/private.md`, linkedPrivate, linkedExternal, externalPrivate]) {
    const catalog = await provenance.groundTruthSourceCatalog({ projectRoot: f.projectRoot,
      snapshot: { entries: [{ type: 'user', uuid: 'original-user', message: { content: 'Deliver the requested document.' } }] },
      materials: { entries: [{ root: f.projectRoot, path: ref }] } });
    await assert.rejects(reviewer({ projectRoot: f.projectRoot, taskId: accepted.task.taskId, role: 'ground-truth-extractor',
      parentSessionId: 'population', reviewer: { model: 'fixture/model', timeoutMs: 20000 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
      request: { taskId: accepted.task.taskId, sourceCatalog: catalog, reviewScope: { kind: 'baseline', boundedBasis: true },
        currentGroundTruth: { path: path.join(taskDirectory(f.projectRoot, accepted.task.taskId), 'ground-truth/current.json'),
          version: accepted.groundTruth.version, digest: accepted.groundTruth.digest } },
      evidence: { groundTruth: accepted.groundTruth,
        snapshot: { entries: [{ type: 'user', uuid: 'original-user', message: { content: 'Deliver the requested document.' } }] } } }),
    { code: 'BASELINE_SOURCE_INVALID' }, ref);
  }
  assert.equal(dispatches, 0);
});
