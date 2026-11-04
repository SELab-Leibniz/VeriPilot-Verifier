import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('actual integrated CLI retains its provider boundary when startup loses an unclosed host handle', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'integrated-startup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trace = path.join(root, 'trace.jsonl'), loader = path.join(root, 'loader.mjs');
  const manifest = path.join(root, 'manifest.json'), output = path.join(root, 'output');
  const shared = "import { appendFileSync } from 'node:fs';\nconst trace = event => appendFileSync(process.env.RC_UNIT_TRACE, JSON.stringify({event})+'\\n');\n";
  const guard = shared + "export async function installNativeGatewayBatch(){trace('boundary-installed');return {signal:new AbortController().signal,credential:()=> 'synthetic-test-only',abort(){trace('boundary-aborted')},async close(){trace('boundary-uninstalled')},metrics(){return {budget:{inFlightRequests:0},realProviderRequests:0,simulatedDispatches:0}}}}\n";
  const gateway = shared + "export async function createNativeGatewayEvaluation(){trace('native-started');trace('internal-native-close-failed');throw new Error('fixture startup native close failed')}\n";
  // Run the real CLI control flow. Only its two external lifecycle boundaries
  // are mocked; this test starts no host, provider or business model.
  await fs.writeFile(loader,
    'const guard=' + JSON.stringify(guard) + ';\nconst gateway=' + JSON.stringify(gateway) + ';\n' +
    "export async function load(url,context,next){if(url.endsWith('/scripts/helpers/native-gateway-batch.mjs'))return {format:'module',source:guard,shortCircuit:true};if(url.endsWith('/scripts/helpers/native-gateway-evaluation.mjs'))return {format:'module',source:gateway,shortCircuit:true};return next(url,context)}\n");
  await fs.writeFile(manifest, JSON.stringify({ kind: 'native-gateway-original-loop-v1',
    component: 'native-integrated-module-control-v1', control: 'compliant', originalBusinessEntry: 'agent',
    stageDeadline: new Date(Date.now() + 60000).toISOString(),
    limits: { requests: 2, perCase: 2, wallMs: 10000, inputTokens: 16384, payloadBytes: 4096, outputTokens: 32768, usd: 4 } }));
  const entry = fileURLToPath(new URL('../scripts/evaluate-native-integrated.mjs', import.meta.url));
  let code;
  try {
    await execute(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, entry, '--live', '--host-root', path.join(root, 'unused-host'),
      '--manifest', manifest, '--output', output], { timeout: 15000,
      env: { ...process.env, RC_UNIT_TRACE: trace, RC_NATIVE_GATEWAY_API_KEY: 'synthetic-test-only' } });
    code = 0;
  } catch (error) { code = error.code; }
  assert.equal(code, 1);
  const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
  assert(events.includes('native-started'));
  assert(events.includes('internal-native-close-failed'));
  assert(events.includes('boundary-aborted'));
  assert(!events.includes('boundary-uninstalled'), 'An unknown live host must not outlive its provider boundary');
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(result.semanticAcceptance, null);
  assert.match(result.failure.message, /fixture startup native close failed/);
  assert(result.cleanupErrors.some(error => error.phase === 'gateway-startup'));
});
