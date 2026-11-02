// Actual original TB image/package catalog, no task/model/provider credential.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createHarborSetupProxy } from './helpers/harbor-setup-proxy.mjs';
const index = process.argv.indexOf('--output');
if (index < 0) throw new Error('Use a fresh --output');
const output = path.resolve(process.argv[index + 1]); await fs.mkdir(output);
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const fullHost = process.argv.includes('--full-host');
const proxy = await createHarborSetupProxy(); let error, stdout, stderr;
try {
  if (fullHost) {
    for (const name of ['--python', '--task', '--artifact', '--install-cache', '--cache-compose']) if (!arg(name)) throw new Error('Missing full-host probe parameter');
    const descriptor = path.join(output, 'host-only-descriptor.json');
    await fs.writeFile(descriptor, JSON.stringify({ kind: 'rc-harbor-controller-v1', startUrl: 'http://127.0.0.1:1/start',
      controlToken: 'rc-control-' + 'd'.repeat(64), setupProxyUrl: proxy.url }), { mode: 0o600 });
    const result = await promisify(execFile)(arg('--python'), ['scripts/probe-harbor-terminal-host.py',
      '--task', arg('--task'), '--artifact', arg('--artifact'), '--install-cache', arg('--install-cache'),
      '--cache-compose', arg('--cache-compose'), '--controller-descriptor', descriptor, '--output', path.join(output, 'full-host')],
      { timeout: 1500000, maxBuffer: 4194304, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: '/private/tmp' } });
    stdout = result.stdout; stderr = result.stderr;
    const observed = JSON.parse(await fs.readFile(path.join(output, 'full-host/result.json'), 'utf8'));
    if (observed.state !== 'OFFICIAL_TB_CONTAINER_PINNED_HOST_BOTH_ARMS_ACTIVE_POLICY_NO_MODELS'
      || observed.realModelRequests !== 0 || !observed.setupProxyEnvironment.allAbsentAfterSetup)
      throw new Error('Full original setup or scoped cleanup did not qualify');
  } else {
    const result = await promisify(execFile)('docker', ['run', '--rm', '--network', 'bridge', '--entrypoint', 'bash',
    '-e', `http_proxy=${proxy.url}`, '-e', `https_proxy=${proxy.url}`, 'alexgshaw/overfull-hbox:20260403', '-c',
    'set -o pipefail; apt-get update -o Acquire::Retries=0 -o Acquire::http::Timeout=20 && apt-cache show curl ca-certificates >/dev/null && echo APT_CANDIDATES_VERIFIED'],
    { timeout: 240000, maxBuffer: 4194304 });
  stdout = result.stdout; stderr = result.stderr;
  if (!stdout.includes('APT_CANDIDATES_VERIFIED')) throw new Error('APT did not resolve both required packages');
  }
} catch (failure) { error = { code: failure.code ?? 'SETUP_PROBE_FAILED' }; stdout = failure.stdout ?? ''; stderr = failure.stderr ?? ''; }
finally { await proxy.close(); }
await fs.writeFile(path.join(output, 'output.log'), (stdout ?? '') + (stderr ?? ''));
const result = { state: error ? 'INCOMPLETE' : fullHost ? 'ORIGINAL_FULL_HOST_SETUP_PROXY_SCOPE_AND_NO_MODEL_BOOTSTRAP_VERIFIED'
  : 'ORIGINAL_IMAGE_APT_CATALOG_AND_REQUIRED_PACKAGE_CANDIDATES_VIA_SETUP_ONLY_HOST_NETWORK_VERIFIED',
  realModelRequests: 0, originalTaskSubmitted: false, error: error ?? null, proxy: proxy.snapshot(),
  setupProxySourceSha256: createHash('sha256').update(await fs.readFile(new URL('./helpers/harbor-setup-proxy.mjs', import.meta.url))).digest('hex'),
  hostOrFrameworkSourceEdited: false, image: 'alexgshaw/overfull-hbox:20260403',
  limits: fullHost ? 'Original full installer and no-task Gateway bootstrap only; actual model ticket closure is separately checked. No benchmark score.'
    : 'APT catalog and curl/ca-certificates availability only. Full inherited setup scoped proxy and absence in actual agent phase still need qualification.' };
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, realModelRequests: 0, error: result.error }));
if (error) process.exitCode = 1;
