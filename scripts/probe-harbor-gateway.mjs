// No task/model request is issued: actual installed Gateway health and project
// binding are checked independently in fresh processes for each RC arm.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { runHarborGatewayTrial } from './bench/harbor-gateway-runner.mjs';
import { createHarborProviderRelay } from './helpers/harbor-provider-relay.mjs';
const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)), hostRoot = value('--host-root'), output = value('--output');
if (!hostRoot || !output) throw new Error('Use --host-root and a fresh --output. This probe never invokes a model.');
const arm = value('--arm'), digest = bytes => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
if (!arm) {
  const artifact = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(output, 'artifacts') });
  const hostFiles = ['package.json', 'openclaw.mjs', 'dist/selection-JInn13lc.js', 'dist/workspace-DkQ7irPD.js'];
  const before = Object.fromEntries(await Promise.all(hostFiles.map(async file => [file, digest(await fs.readFile(path.join(hostRoot, file)))])));
  const run = promisify(execFile), results = [];
  for (const selected of ['off', 'on']) {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    for (const key of Object.keys(childEnv)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY/u.test(key)) delete childEnv[key];
    await run(process.execPath, [fileURLToPath(import.meta.url), '--host-root', hostRoot, '--output', path.join(output, selected), '--arm', selected, '--artifact', artifact],
      { env: childEnv, timeout: 45000, maxBuffer: 1048576 });
    results.push(JSON.parse(await fs.readFile(path.join(output, selected, 'result.json'), 'utf8')));
  }
  const after = Object.fromEntries(await Promise.all(hostFiles.map(async file => [file, digest(await fs.readFile(path.join(hostRoot, file)))])));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Installed host changed');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ state: 'BOTH_ACTUAL_GATEWAY_ARMS_BOOTSTRAPPED_NO_TASK',
    artifact, hostHashes: before, hostChanged: false, results, realProviderRequests: 0, officialBenchmarkReady: false,
    limitations: ['No original task, model, correction or official evaluator was run. Real terminal settlement is a separate qualification.'] }, null, 2));
  console.log(JSON.stringify({ state: 'BOTH_ACTUAL_GATEWAY_ARMS_BOOTSTRAPPED_NO_TASK', realProviderRequests: 0 }));
} else {
  const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
  const oldFetch = globalThis.fetch, oldConnect = net.Socket.prototype.connect, key = '__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__', oldDeps = globalThis[key];
  const undici = createRequire(path.join(hostRoot, 'package.json'))('undici'), denied = [];
  const guard = original => async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) { denied.push({ kind: 'fetch', origin: url.origin, method: init?.method ?? input?.method ?? 'GET' }); throw new Error('OFFLINE_EXTERNAL_FETCH_DENIED'); }
    return original(input, init);
  };
  globalThis.fetch = guard(oldFetch); globalThis[key] = { ...undici, fetch: guard(undici.fetch) };
  net.Socket.prototype.connect = function (...options) {
    const normalized = Array.isArray(options[0]) ? options[0] : options, option = normalized[0];
    const host = typeof option === 'object' ? option.host ?? 'localhost' : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
    if (!local(host) || typeof option === 'object' && option.path || typeof option === 'string') throw new Error('OFFLINE_EXTERNAL_SOCKET_DENIED');
    return oldConnect.apply(this, options);
  };
  let relay;
  try {
    relay = await createHarborProviderRelay({ upstream: () => { throw new Error('No provider dispatch permitted'); },
      limits: { usd: 10, requests: 2, wallMs: 30000, inputPerRequest: 262144, outputPerRequest: 32768, totalInput: 524288, totalOutput: 65536 } });
    const project = path.join(output, 'project'); await fs.mkdir(project);
    await promisify(execFile)('git', ['init', '--initial-branch=codex/probe'], { cwd: project });
    const result = await runHarborGatewayTrial({ hostRoot, projectRoot: project, pluginRoot: value('--artifact'),
      outputRoot: path.join(output, 'host'), ticket: relay.ticket(), rcEnabled: arm === 'on', probeOnly: true,
      policyPath: path.join(sourceRoot, 'config/harbor-evaluation.yaml'), criteriaPath: path.join(sourceRoot, 'config/harbor-document-review.md') });
    if (relay.snapshot().budget.requests !== 0) throw new Error('Model-free bootstrap reached provider transport');
    const metadata = new Set(['https://openrouter.ai', 'https://raw.githubusercontent.com', 'https://registry.npmjs.org']);
    if (denied.some(row => row.method !== 'GET' || !metadata.has(row.origin))) throw new Error('Unexpected external attempt');
    const gitStatus = await promisify(execFile)('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8' });
    if (gitStatus.stdout.trim()) throw new Error('RC operational files leaked into the business change set');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ...result, operationalFilesExcludedFromGit: true,
      deniedStartupMetadata: denied, relay: relay.snapshot() }, null, 2));
  } finally {
    await relay?.close(); globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect;
    if (oldDeps === undefined) delete globalThis[key]; else globalThis[key] = oldDeps;
  }
  process.exit(0); // Installed host watchers do not belong to the parent probe.
}
