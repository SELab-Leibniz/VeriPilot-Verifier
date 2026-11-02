import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchIntegratedOriginal, prepareIntegratedFixture } from '../scripts/helpers/native-integrated-module-case.mjs';
import { integratedFixtureFence } from '../scripts/helpers/native-integrated-fixture-fence.mjs';
import { nativeGatewayCodingProvider } from '../scripts/helpers/native-gateway-evaluation.mjs';
import { skillE2eOptions } from '../scripts/evaluate-skill-e2e.mjs';

test('configured original business timeout can exceed ten minutes but remains bounded by the case deadline', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [index, wallMs] of [1800000, 900000].entries()) {
    let submitted;
    const gateway = { config: { session: { store: 'fixture-store' } },
      runtime: { agent: { session: { async patchSessionEntry() {},
        async getSessionEntry() { return { sessionId: 'actual-fixture-session', spawnedCwd: root }; } } } },
      async request(method, args) {
        if (method === 'sessions.create') return { ok: true, key: args.key };
        assert.equal(method, 'agent'); submitted = args;
        return { runId: args.idempotencyKey, sessionKey: args.sessionKey };
      } };
    const deadlineAt = Date.now() + wallMs;
    await dispatchIntegratedOriginal({ gateway, fixture: { projectRoot: root, deadlineAt,
      businessTimeoutMs: 1200000, requirement: 'Run the Skill.' },
    bindingFile: path.join(root, `binding-${index}.json`), deadlineAt, signal: new AbortController().signal });
    assert(submitted.timeout > 600, JSON.stringify(submitted));
    assert(submitted.timeout <= Math.min(1200, wallMs / 1000));
  }
});

test('GLM Flash uses the explicit configured model and does not admit embedded credentials or unknown providers', () => {
  const provider = { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash' };
  assert.equal(nativeGatewayCodingProvider(provider, 128000, 1200000).definition.models[0].id, 'glm-5.3-flash');
  for (const candidate of [{ ...provider, apiKey: 'forbidden' }, { ...provider, baseUrl: 'https://example.invalid/v1' },
    { ...provider, model: 'unexpected-model' }]) assert.throws(() => nativeGatewayCodingProvider(candidate));
  assert.equal(skillE2eOptions([]).model, 'glm-5.3-flash');
  assert.equal(skillE2eOptions([]).maxWatchTurns, 1);
  assert.throws(() => skillE2eOptions(['--max-watch-turns', '0']));
  assert.throws(() => skillE2eOptions(['--check-interval-turns', '0']));
});

test('Skill fixture accepts native optional execution defaults while preserving the exact command and original strict mode', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-exec-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(root, 'project'), modelRef: 'openai/glm-5.3-flash' });
  const business = { sessionId: 'fixture-session', sessionKey: 'fixture-key' }, ctx = { ...business, runId: 'fixture-run' };
  const call = params => integratedFixtureFence({ fixture, business }, { toolName: 'exec', params }, ctx);
  assert.equal((await call({ command: fixture.command })).block, true, 'legacy exact-option contract remains unchanged');
  fixture.strictExecOptions = false;
  assert.equal(await call({ command: fixture.command }), undefined);
  assert.equal(await call({ command: fixture.command, workdir: fixture.projectRoot, timeout: 60 }), undefined);
  for (const args of [{ command: fixture.command + '; echo changed' }, { command: fixture.command, background: true },
    { command: fixture.command, workdir: root }, { command: fixture.command, timeout: 0 },
    { command: fixture.command, timeout: Infinity }, { command: fixture.command, yieldMs: 40000 }])
    assert.equal((await call(args)).block, true);
});
