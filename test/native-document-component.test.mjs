import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareNativeEvaluationTools, installNativeDocumentBatch } from '../scripts/helpers/native-stop-evaluation.mjs';
import { createDocumentTools, bindDocumentTools } from '../lib/document-tools.mjs';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { nativeDocumentPolicy } from '../scripts/evaluate-native-document.mjs';

test('document component preserves its actual scoped private tool and rejects missing or foreign bindings before dispatch', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-document-tools-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, 'design.md'), 'Local design.\n');
  const params = { sessionId: 'document-session', sessionKey: 'document-session-key', runId: 'document-run',
    config: { tools: { fs: { workspaceOnly: false } } }, toolsAllow: ['read', 'exec'] };
  const options = { fixtureFence: { projectRoot }, document: true, role: 'artifact-reviewer' };
  await assert.rejects(prepareNativeEvaluationTools(params, options), /actual owning document-tool binding/u);
  const tools = await createDocumentTools({ projectRoot, semantic: { artifactFiles: ['design.md'] } });
  const close = bindDocumentTools({ sessionId: params.sessionId, runId: params.runId, tools, active() {} });
  try {
    const admitted = await prepareNativeEvaluationTools(params, options);
    assert.deepEqual(admitted.toolsAllow, ['read', 'rc_document']);
    assert.equal(admitted.config.tools.fs.workspaceOnly, true);
    assert.equal(params.config.tools.fs.workspaceOnly, false);
    await assert.rejects(prepareNativeEvaluationTools({ ...params, runId: 'foreign-run' }, options), /actual owning document-tool binding/u);
    const extractor = await prepareNativeEvaluationTools({ ...params, sessionId: 'extractor' }, { ...options, role: 'ground-truth-extractor' });
    assert.deepEqual(extractor.toolsAllow, ['read']);
  } finally { close(); }
  await assert.rejects(prepareNativeEvaluationTools(params, options), /actual owning document-tool binding/u);
});

test('document transport cannot masquerade as baseline or Stop batches', async () => {
  for (const kind of ['native-baseline-component-v1', 'native-stop-pair-batch-v1'])
    await assert.rejects(installNativeDocumentBatch({ manifest: { kind } }));
});

test('live document policy resolves original sources and the production artifact path before any model dispatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-document-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), policyRoot = path.join(projectRoot, '.runtime-corrector');
  await fs.mkdir(policyRoot, { recursive: true });
  await fs.writeFile(path.join(policyRoot, 'config.yaml'), nativeDocumentPolicy({ modelRef: 'evaluation/glm-5.3' }));
  await fs.writeFile(path.join(policyRoot, 'review.md'), 'Assess current design against the adopted original requirements.\n');
  await fs.writeFile(path.join(projectRoot, 'requirements.md'), 'Keep input and metadata local. No telemetry.\n');
  await fs.writeFile(path.join(projectRoot, 'design.md'), 'Current design.\n');
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: fileURLToPath(new URL('../', import.meta.url)), outputRoot: path.join(root, 'build') });
  const pipeline = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')).href);
  const plan = await pipeline.loadConfig({ cwd: projectRoot, pluginRoot });
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, true);
  assert.equal(plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, true);
  assert.deepEqual(plan.runtimeV2.dynamicGroundTruth.materialRoots, [path.join(projectRoot, 'requirements.md')]);
  const prepared = await pipeline.checkArtifact({ filePath: path.join(projectRoot, 'design.md'), cwd: projectRoot,
    pluginRoot, config: plan, deferPersistence: true, includePublicCommandContext: false });
  assert.equal(prepared.matched, true); assert.equal(prepared.reviewContext.nodeReviewEnabled, true);
  assert.deepEqual(prepared.reviewContext.workflow.groundTruthInputs[0].files, ['requirements.md']);
  assert.equal(prepared.reviewContext.workflow.groundTruthInputs[0].status, 'ready');
});
