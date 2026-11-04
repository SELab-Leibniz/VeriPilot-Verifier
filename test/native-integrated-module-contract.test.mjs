import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareIntegratedFixture, integratedFixtureFence, integratedHash, dispatchIntegratedOriginal } from '../scripts/helpers/native-integrated-module-case.mjs';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { bindTaskTools } from '../lib/openclaw/task-tools.mjs';
import { bindDocumentTools } from '../lib/document-tools.mjs';
import { runInternalExecution } from '../lib/openclaw/internal-context.mjs';
import { recordNativeRun } from '../lib/openclaw/native-runs.mjs';
import { fileSymlinkSkipReason } from './helpers/file-symlink-capability.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'integrated-contract-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(root, 'project'), modelRef: 'openai/glm-5.3' });
  const business = { sessionId: 'original-session', sessionKey: 'original-key' };
  const fence = (toolName, params, ctx = business) => integratedFixtureFence({ fixture, business }, { toolName, params }, ctx);
  return { root, fixture, business, fence };
}

test('integrated fixture enables automatic baseline, document, Skill and normal Stop policy without fixed populations', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareIntegratedFixture({ projectRoot: f.fixture.projectRoot, modelRef: 'openai/glm-5.3' }), { code: 'EEXIST' });
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: fileURLToPath(new URL('../', import.meta.url)), outputRoot: path.join(f.root, 'build') });
  const pipeline = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-corrector.mjs')).href);
  const plan = await pipeline.loadConfig({ cwd: f.fixture.projectRoot, pluginRoot });
  assert.equal(plan.runtimeV2.dynamicGroundTruth.enabled, true);
  assert.equal(plan.runtimeV2.artifactCorrection.groundTruthReviewEnabled, true);
  assert.equal(plan.runtimeV2.skillCorrection.enabled, true);
  assert.deepEqual(plan.runtimeV2.skillCorrection.selection.include, ['delivery-verifier']);
  assert.deepEqual(plan.runtimeV2.skillCorrection.skillRoots, [path.join(f.fixture.projectRoot, 'skills')]);
  assert.equal(plan.runtimeV2.stopCorrection.enabled, true);
  assert.equal(plan.runtimeV2.stopCorrection.metrics.M08, true);
  assert.equal(plan.runtimeV2.stopCorrection.metrics.M16, true);
  const prepared = await pipeline.checkArtifact({ filePath: path.join(f.fixture.projectRoot, 'docs/guide.md'), cwd: f.fixture.projectRoot,
    pluginRoot, config: plan, deferPersistence: true, includePublicCommandContext: false });
  assert.equal(prepared.matched, true); assert.equal(prepared.reviewContext.nodeReviewEnabled, true);
  assert.deepEqual(prepared.reviewContext.workflow.groundTruthInputs[0].files, ['requirements/original-contract.md']);
  assert.match(f.fixture.requirement, /actually run/);
  assert.match(await fs.readFile(path.join(f.fixture.projectRoot, 'skills/delivery-verifier/SKILL.md'), 'utf8'), /run it again after that change/);
});

test('business fence confines all file operations and rejects altered command options or identity', async t => {
  const f = await fixture(t);
  for (const file of [...f.fixture.inputs, ...f.fixture.deliverables]) assert.equal(await f.fence('read', { path: file }), undefined);
  for (const file of f.fixture.deliverables) assert.equal(await f.fence('write', { path: file, content: 'new delivery' }), undefined);
  const exec = { command: f.fixture.command, workdir: f.fixture.projectRoot, timeout: 10, yieldMs: 10000, background: false };
  assert.equal(await f.fence('exec', exec), undefined);
  for (const [name, args] of [['read', { path: '.runtime-corrector/config.yaml' }], ['read', { path: '..' }],
    ['write', { path: 'tools/verify.mjs', content: 'changed' }], ['edit', { path: '../outside' }],
    ['apply_patch', { patch: 'irrelevant' }], ['runtime_corrector', { command: 'init' }],
    ['exec', { ...exec, env: {} }], ['exec', { ...exec, background: true }], ['exec', { ...exec, timeout: 0 }],
    ['exec', { ...exec, host: 'node' }], ['exec', { ...exec, command: exec.command + ' ; pwd' }]])
    assert.equal((await f.fence(name, args)).block, true, `${name}: ${JSON.stringify(args)}`);
  assert.equal((await f.fence('read', { path: 'app.mjs' }, { ...f.business, sessionKey: 'foreign-key' })).block, true);
  await fs.writeFile(path.join(f.fixture.projectRoot, 'tools/verify.mjs'), 'tampered');
  assert.equal((await f.fence('exec', exec)).block, true);
});

test('native business fence rejects symlink deliverables and never grants unbound private reads', { skip: await fileSymlinkSkipReason() }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.mjs'); await fs.writeFile(outside, 'private');
  const target = path.join(f.fixture.projectRoot, 'app.mjs'); await fs.unlink(target); await fs.symlink(outside, target);
  assert.equal((await f.fence('read', { path: target })).block, true);
  assert.equal((await f.fence('write', { path: target, content: 'overwrite' })).block, true);
  assert.equal(await fs.readFile(outside, 'utf8'), 'private');
  const privateCtx = { sessionId: 'private', sessionKey: 'private-key', runId: 'private-run' };
  assert.equal((await f.fence('read', { path: 'app.mjs' }, privateCtx)).block, true);
  const close = bindTaskTools({ ...privateCtx, tools: [], active() {} });
  try {
    // No replaced tool or widened source scope: the real binding retains its
    // own execution checks. This assertion concerns only fence noninterference.
    assert.equal(await f.fence('source_read', { path: 'app.mjs' }, privateCtx), undefined);
    assert.equal(await f.fence('read', { path: 'app.mjs' }, privateCtx), undefined);
    assert.equal((await f.fence('read', { path: 'app.mjs' }, { ...privateCtx, runId: 'old-run' })).block, true);
    assert.equal((await f.fence('exec', {}, privateCtx)).block, true);
  } finally { close(); }
  assert.equal((await f.fence('read', { path: 'app.mjs' }, privateCtx)).block, true);
});

test('published command grants only the three exact public files and clears inherited environment', async t => {
  const f = await fixture(t);
  assert.match(f.fixture.command, /^\/usr\/bin\/env -i PATH=/);
  assert.equal(f.fixture.command.match(/--allow-fs-read=/g).length, 3);
  assert(!/--allow-(?:net|child-process|worker|fs-write)/.test(f.fixture.command));
  assert(!f.fixture.command.includes(`--allow-fs-read=${f.fixture.projectRoot}'`));
  for (const [relative, sha] of Object.entries(f.fixture.immutableHashes))
    assert.equal(integratedHash(await fs.readFile(path.join(f.fixture.projectRoot, relative))), sha);
});

test('task and document bindings reject wrong runs and revocation inside a genuine reviewer ALS scope', async t => {
  const f = await fixture(t);
  const ctx = { sessionId: 'owned-private', sessionKey: 'agent:main:owned-private', runId: 'current-run' };
  const progress = { sessionId: ctx.sessionId, role: 'skill-reviewer' };
  let revoked = false;
  const active = () => { if (revoked) throw new Error('REVOKED'); };
  for (const kind of ['task', 'document']) {
    const close = kind === 'task' ? bindTaskTools({ ...ctx, tools: [], active })
      : bindDocumentTools({ ...ctx, tools: {}, active });
    try {
      await runInternalExecution(ctx.sessionId, async () => {
        assert.equal(await f.fence('read', { path: 'app.mjs' }, ctx), undefined);
        assert.equal((await f.fence('read', { path: 'app.mjs' }, { ...ctx, runId: 'old-run' })).block, true);
        revoked = true;
        assert.equal((await f.fence('read', { path: 'app.mjs' }, ctx)).block, true);
      }, undefined, progress);
    } finally { close(); revoked = false; }
  }
  // Test-only records exercise the existing production record API. No private
  // role, semantic verdict or real business acceptance is published here.
  const nativeRecord = { taskId: 'unit-task', runId: ctx.runId, sessionId: ctx.sessionId, role: progress.role,
    ownerPid: process.pid, status: 'DISPATCH_COMMITTED' };
  await recordNativeRun(f.fixture.projectRoot, nativeRecord);
  await runInternalExecution(ctx.sessionId, async () => {
    assert.equal(await f.fence('read', { path: 'app.mjs' }, ctx), undefined);
    assert.equal((await f.fence('read', { path: 'app.mjs' }, { ...ctx, sessionId: 'foreign' })).block, true);
    assert.equal((await f.fence('read', { path: 'app.mjs' }, { ...ctx, runId: 'old-run' })).block, true);
    await recordNativeRun(f.fixture.projectRoot, { ...nativeRecord, status: 'SETTLED' });
    assert.equal((await f.fence('read', { path: 'app.mjs' }, ctx)).block, true);
  }, undefined, progress);
});

test('standard agent dispatch retains the original task and bounds its 600s maximum by the shared stage', async t => {
  const f = await fixture(t);
  const requests = []; let saved;
  const gateway = { faultInjection: false, config: { session: { store: 'contract-store' } },
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return method === 'sessions.create' ? { ok: true, key: params.key }
        : { runId: params.idempotencyKey, sessionKey: params.sessionKey };
    }, runtime: { agent: { session: {
      patchSessionEntry: async ({ update }) => { saved = update({ sessionId: 'contract-session' }); },
      getSessionEntry: async () => saved,
    } } } };
  for (const [seconds, businessTimeoutMs] of [[45, 600000], [900, 600000], [1800, 1800000]]) {
    const deadlineAt = Date.now() + seconds * 1000;
    const original = businessTimeoutMs === 1800000
      ? await prepareIntegratedFixture({ projectRoot: path.join(f.root, 'long-business'), modelRef: 'fixture/model', deadlineAt, businessTimeoutMs })
      : { ...f.fixture, deadlineAt };
    await dispatchIntegratedOriginal({ gateway, fixture: original, bindingFile: path.join(f.root, `binding-${seconds}.json`), deadlineAt });
    const request = requests.at(-1);
    assert.equal(request.method, 'agent'); assert.equal(request.params.message, original.requirement);
    assert(request.params.timeout > 0 && request.params.timeout <= Math.min(seconds, businessTimeoutMs / 1000));
    assert(request.options.timeoutMs <= Math.min(seconds, businessTimeoutMs / 1000) * 1000);
  }
  await assert.rejects(dispatchIntegratedOriginal({ gateway, fixture: f.fixture,
    bindingFile: path.join(f.root, 'unbounded.json'), deadlineAt: Date.now() + 900000 }), /missing, expired or extended/);
  const expiring = { ...f.fixture, deadlineAt: Date.now() + 999 };
  assert.equal((await integratedFixtureFence({ fixture: expiring, business: f.business }, { toolName: 'exec',
    params: { command: expiring.command, workdir: expiring.projectRoot, timeout: 10, yieldMs: 10000, background: false } }, f.business)).block, true);
});
