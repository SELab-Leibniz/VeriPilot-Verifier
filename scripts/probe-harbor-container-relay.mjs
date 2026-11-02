// External fake upstream remains in this controller; Docker receives only the
// disposable public relay ticket. No real account credential is requested.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHarborProviderRelay } from './helpers/harbor-provider-relay.mjs';
const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const output = path.resolve(value('--output') ?? ''), python = value('--python');
if (!value('--output') || !python) throw new Error('Use --output and the pinned framework --python executable.');
const delayMs = Number(value('--delay-ms') ?? 0);
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 25000) throw new Error('Invalid synthetic response delay');
await fs.mkdir(output); const execute = promisify(execFile);
let syntheticCalls = 0, subprocessError;
const relay = await createHarborProviderRelay({ bind: '0.0.0.0', advertisedHost: 'host.docker.internal',
  limits: { usd: 20, requests: 4, wallMs: 180000, inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 1048576, totalOutput: 131072 },
  upstream: async ({ body }) => {
    syntheticCalls++; if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)); const payload = JSON.parse(body); if (payload.messages[0].content !== 'Fictional relay reachability probe.') throw new Error('Unexpected probe payload');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Controlled local reachability response.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }), { headers: { 'content-type': 'application/json' } });
  } });
try {
  await fs.writeFile(path.join(output, 'public-ticket.json'), JSON.stringify(relay.ticket(), null, 2));
  try {
    const run = await execute(python, [fileURLToPath(new URL('./probe-harbor-container.py', import.meta.url)), '--ticket', path.join(output, 'public-ticket.json'), '--output', path.join(output, 'container'), '--client-timeout', String(delayMs ? 40 : 2), ...(value('--extra-compose') ? ['--extra-compose', path.resolve(value('--extra-compose'))] : [])],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: '/private/tmp' }, timeout: 170000, maxBuffer: 4194304 });
    await fs.writeFile(path.join(output, 'framework-output.log'), run.stdout + run.stderr);
  } catch (error) {
    subprocessError = { code: error.code, killed: error.killed ?? false };
    await fs.writeFile(path.join(output, 'framework-output.log'), (error.stdout ?? '') + (error.stderr ?? ''));
  }
} finally { await relay.close(); }
const container = JSON.parse(await fs.readFile(path.join(output, 'container/result.json'), 'utf8').catch(() => '{}'));
const result = { state: container.state ?? 'INCOMPLETE', container, relay: relay.snapshot(), syntheticCalls, subprocessError,
  syntheticResponseDelayMs: delayMs, realProviderRequests: 0, syntheticUsageIsNotProviderEvidence: true, originalSamplesChanged: false, frameworkOrHostChanged: false,
  limitations: ['Neutral Python image exercises actual Harbor Docker egress policy and one fake relay request. No sampled task, OpenClaw task, verifier or model ran.',
    'Official task limits, active generic RC policy, pinned host install, immutable artifact mount, real session trajectory and collection remain separate requirements.'] };
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, syntheticCalls, realProviderRequests: 0 }));
process.exitCode = container.state === 'PINNED_HARBOR_DOCKER_PHASE_RELAY_QUALIFIED_NO_MODELS' && !subprocessError ? 0 : 1;
