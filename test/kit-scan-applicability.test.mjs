import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkKitIntegration, runImplementationReview } from '../lib/runtime-v2/impl-review.mjs';
import { loadPlatformAdapter } from '../lib/runtime-v2/platform-adapter.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-kit-scan-applicability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function capability(id, name, authority, severity) {
  return { claimId: id, category: 'capabilityChecklist', status: 'ACTIVE',
    text: `Use ${name} for the original required behavior.`, authority, severity,
    verificationTarget: 'IMPLEMENTATION', capability: { name, module: null, catalogUnmatched: false } };
}
const groundTruth = () => ({ claims: [
  capability('explicit', 'scan-kit', 'USER_EXPLICIT', 'HARD'),
  capability('adopted', 'map-kit', 'MATERIAL_DERIVED', 'HARD'),
  capability('inferred', 'camera-kit', 'AGENT_INFERRED', 'SOFT'),
] });

test('no scan range cannot establish missing capabilities, regardless of authority or severity', async t => {
  const root = await workspace(t), adapter = await loadPlatformAdapter('harmonyos');
  const truth = groundTruth(), original = structuredClone(truth);
  for (const absent of ['sourceRoots', 'sourceExtensions']) {
    for (const range of [[], [' ', '']]) {
      const unsupported = { ...adapter, kitCheck: { ...adapter.kitCheck, [absent]: range } };
      assert.deepEqual(await checkKitIntegration(root, { adapter: unsupported, groundTruth: truth }), []);
      assert.deepEqual(truth, original, 'unsupported detector must not downgrade or delete an obligation');
    }
  }
});

test('a configured scanner still detects genuine missing and import-only modules', async t => {
  const root = await workspace(t), dir = path.join(root, 'entry/src/main');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'App.ets'), [
    "import { scan } from '@kit.ScanKit';",
    "import { Camera } from '@kit.CameraKit';",
    'export const camera = new Camera();',
  ].join('\n'));
  const truth = groundTruth(), original = structuredClone(truth);
  const findings = await checkKitIntegration(root, { groundTruth: truth });
  assert.equal(findings.length, 2);
  assert.equal(findings.find(f => f.deviationKey === 'impl:kit:scan-kit').severity, 'error');
  assert.match(findings.find(f => f.deviationKey === 'impl:kit:scan-kit').actualEvidence[0], /never references/);
  assert.equal(findings.find(f => f.deviationKey === 'impl:kit:map-kit').severity, 'error');
  assert.match(findings.find(f => f.deviationKey === 'impl:kit:map-kit').actualEvidence[0], /no import/);
  assert.ok(!findings.some(f => f.deviationKey === 'impl:kit:camera-kit'));
  assert.deepEqual(truth, original);
});

test('an unavailable deterministic scanner does not skip original implementation-owned obligations', async t => {
  const root = await workspace(t), truth = groundTruth();
  const population = { metrics: {
    M09: [{ objectId: 'M09:explicit', sourceId: 'explicit', verificationTarget: 'IMPLEMENTATION' }],
    M12: truth.claims.map(claim => ({ objectId: `M12:${claim.claimId}`, sourceId: claim.claimId, verificationTarget: 'IMPLEMENTATION' })),
    M11: [{ objectId: 'M11:history', sourceId: 'history', verificationTarget: 'PROCESS' }],
  } };
  const original = structuredClone({ truth, population });
  let reviewed;
  const result = await runImplementationReview({
    projectRoot: root, taskId: 'fixture', parentSessionId: 'main', population, groundTruth: truth,
    runtimeV2: { implementationCorrection: { platform: null }, reviewers: { implementationReviewer: {} } },
    deviceVerifier: async () => ({ assurance: { level: 'static', reason: 'TEST_STUB' }, findings: [], build: { status: 'skipped' }, smoke: { status: 'skipped' } }),
    reviewerFactory: async ({ request }) => {
      reviewed = Object.values(request.population.metrics).flat().map(object => object.objectId);
      return { result: { summary: 'Controlled scope preservation.', findings: [],
        metricObjectJudgements: reviewed.map(objectId => ({ objectId, judgement: 'UNVERIFIED', reason: 'Controlled fixture; no business verdict.', evidence: [] })) }, close: async () => {} };
    },
  });
  assert.deepEqual(reviewed, ['M09:explicit', 'M12:explicit', 'M12:adopted', 'M12:inferred']);
  assert.equal(result.metricObjectJudgements.length, 4);
  assert.ok(result.metricObjectJudgements.every(j => j.judgement === 'UNVERIFIED'));
  assert.deepEqual({ truth, population }, original);
});
