import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile), runner = path.resolve('scripts/calibrate-synthetic-provider.mjs');
const canary = 'RECOVERY_OFFLINE_CANARY_0925'; // fictitious; never a real credential
async function fixture(t, inFlight = 0) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-key-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, usd] of [['live-synthetic-001', 0.4096], ['live-synthetic-flash-001', 0.045056]]) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ realRequestsAdmitted: 1, inFlightRequests: inFlight,
      requests: [{ status: 401 }], budget: { halted: 'BUDGET_USAGE_UNKNOWN', estimatedCommittedUsd: usd } }));
  }
  const host = path.join(root, 'offline-host');
  await fs.mkdir(path.join(host, 'dist'), { recursive: true });
  await fs.writeFile(path.join(host, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [name, code] of [['undici', 'module.exports={fetch:async()=>{throw new Error("OFFLINE_UNEXPECTED_FETCH")}};'],
    ['dotenv', 'throw new Error("RECOVERY_MUST_NOT_LOAD_LEGACY_AUTH");']]) {
    const dir = path.join(host, 'node_modules', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.js'), code);
  }
  const sdkDir = path.join(host, 'node_modules/@openclaw/ai/dist'); await fs.mkdir(sdkDir, { recursive: true });
  await fs.writeFile(path.join(sdkDir, 'openai-completions-B9QLIq2U.mjs'), `
    export const r = (model, context, options) => ({ async result() {
      if (process.env.RC_CALIBRATION_API_KEY !== undefined) throw new Error('TEMP_ENV_NOT_REMOVED');
      if (options.apiKey !== ${JSON.stringify(canary)}) throw new Error('RECOVERY_WRONG_CREDENTIAL');
      if (model.provider !== 'review' || model.id !== 'glm-5.3') throw new Error('RECOVERY_WRONG_ROUTE');
      if (model.api !== 'openai-completions' || model.baseUrl !== 'https://open.bigmodel.cn/api/coding/paas/v4') throw new Error('RECOVERY_WRONG_PROTOCOL');
      if (options.maxRetries !== 0) throw new Error('RECOVERY_RETRIES_ENABLED');
      await options.onPayload({model:model.id,max_tokens:options.maxTokens,stream:true,
        stream_options:{include_usage:true},messages:[{role:'system',content:context.systemPrompt},...context.messages],
        tools:context.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}))});
      return {role:'assistant',content:[{type:'text',text:'offline echo '+options.apiKey}],stopReason:'stop'};
    }});`);
  return { root, host, output: path.join(root, 'key-recovery-001') };
}
function command(f, mode = '--approved-coding-key-recovery') {
  return [runner, mode, '--host-root', f.host, '--output', f.output];
}
const childEnv = () => {
  const env = { ...process.env, ANTHROPIC_AUTH_TOKEN: 'OLD_FICTITIOUS_MUST_NOT_FALL_BACK' };
  delete env.RC_CALIBRATION_API_KEY; return env;
};

test('recovery mode is mutually exclusive with either older approval mode', async t => {
  for (const other of ['--approved-synthetic-live', '--approved-flash-followup', '--approved-key-recovery']) {
    const f = await fixture(t);
    await assert.rejects(execute(process.execPath, [...command(f), other], { env: { ...childEnv(), RC_CALIBRATION_API_KEY: canary } }),
      error => /old Anthropic modes are retired/u.test(error.stderr));
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  }
});

test('missing or empty recovery key fails before any legacy auth or dispatch', async t => {
  for (const value of [undefined, '   ']) {
    const f = await fixture(t), env = childEnv();
    if (value !== undefined) env.RC_CALIBRATION_API_KEY = value;
    await assert.rejects(execute(process.execPath, command(f), { env }), error => /RECOVERY_AUTH_NOT_CONFIGURED/u.test(error.stderr));
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  }
});

test('a still-in-flight old ledger prevents recovery from reaching the host double', async t => {
  const f = await fixture(t, 1);
  await assert.rejects(execute(process.execPath, command(f), { env: { ...childEnv(), RC_CALIBRATION_API_KEY: canary } }));
  await assert.rejects(fs.access(path.join(f.output, 'manifest.json')), { code: 'ENOENT' });
});

test('offline host double verifies fresh limits, no old-deadline reuse, env-only auth and redacted output', async t => {
  const f = await fixture(t);
  // This fake serializer never calls fetch; all material and credentials here
  // are fictitious. It deliberately echoes the canary to test redaction.
  const result = await execute(process.execPath, command(f), { env: { ...childEnv(), RC_CALIBRATION_API_KEY: canary } });
  assert(!result.stdout.includes(canary)); assert(!result.stderr.includes(canary));
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.mode, 'approved-coding-key-recovery');
  assert.equal(manifest.protocol, 'openai-completions');
  assert.equal(manifest.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(manifest.credentialSource, 'temporary_env:RC_CALIBRATION_API_KEY');
  assert.deepEqual([manifest.route, manifest.modelId], ['review', 'glm-5.3']);
  assert.equal(manifest.limits.requests, 2); assert.equal(manifest.limits.wallMs, 300000);
  assert.equal(manifest.limits.usd, '0.8192'); assert.equal(manifest.limits.outputPerRequest, 8192);
  assert.equal(manifest.priorBatch.estimatedReservationHeldUsd, 0.454656);
  assert.equal(manifest.priorBatch.reusesOldDeadline, false);
  assert.equal(manifest.fictionalSources.reduce((sum, row) => sum + row.bytes, 0), 412);
  assert.equal(manifest.sourceHashesCapturedBeforeDispatch, true);
  assert(manifest.sourceHashes[path.relative(process.cwd(), runner).replaceAll('\\', '/')]);
  async function inspect(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else assert(!(await fs.readFile(file, 'utf8')).includes(canary), `key persisted in ${entry.name}`);
    }
  }
  await inspect(f.output);
  const record = JSON.parse(await fs.readFile(path.join(f.output, 'result.json'), 'utf8'));
  assert.equal(record.realRequestsAdmitted, 0); assert.equal(record.stopReason, 'MODEL_FINAL_RESPONSE');
  assert(record.modelOutputs[0].content[0].text.includes('[REDACTED]'));
});
