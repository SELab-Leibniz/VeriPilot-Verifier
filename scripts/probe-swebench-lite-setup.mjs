// No-model qualification owner for one already-loaded official Lite image.
// It creates only disposable setup auth; never accepts provider credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createHarborSetupProxy } from './helpers/harbor-setup-proxy.mjs';

const args = process.argv.slice(2), arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
for (const key of ['--python', '--samples', '--instance-id', '--image-ref', '--expected-image-id', '--artifact', '--cpus', '--memory-mb', '--output'])
  if (!arg(key)) throw new Error('Missing no-model setup qualification argument');
const output = path.resolve(arg('--output')); await fs.mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = JSON.parse(await fs.readFile('.runtime-correction/rc-supervision/harbor-prototype-20261031/qualification.json', 'utf8'));
const files = [...new Set([...Object.keys(previous.sourcePins), ...[
  'scripts/bench/swebench-lite-workspace.mjs', 'scripts/bench/swebench_lite_gateway.py',
  'scripts/bench/harbor-container-bootstrap.mjs', 'scripts/probe-swebench-lite-gateway.py',
  'scripts/probe-swebench-lite-setup.mjs'].map(file => path.resolve(file))])];
const before = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])));
await fs.writeFile(path.join(output, 'source-epoch.json'), JSON.stringify({ before, createdAt: Date.now(), noModelScope: true }, null, 2));
const proxy = await createHarborSetupProxy();
const descriptor = path.join(output, 'host-only-descriptor.json');
let failure, stdout = '', stderr = '';
try {
  await fs.writeFile(descriptor, JSON.stringify({ kind: 'rc-harbor-controller-v1',
    startUrl: 'http://127.0.0.1:1/start', controlToken: 'rc-control-' + 'd'.repeat(64), setupProxyUrl: proxy.url }), { mode: 0o600 });
  const childArgs = ['scripts/probe-swebench-lite-gateway.py'];
  for (const key of ['--samples', '--instance-id', '--image-ref', '--expected-image-id', '--artifact', '--cpus', '--memory-mb'])
    childArgs.push(key, arg(key));
  for (const key of ['--install-cache', '--cache-compose']) if (arg(key)) childArgs.push(key, arg(key));
  childArgs.push('--controller-descriptor', descriptor, '--output', path.join(output, 'actual'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(key)));
  Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', TMPDIR: '/private/tmp', PYTHONPATH: process.cwd() });
  const operation = promisify(execFile)(arg('--python'), childArgs, { timeout: 1500000, maxBuffer: 4 * 1024 * 1024, env });
  const cancel = () => operation.child?.kill('SIGINT');
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { ({ stdout, stderr } = await operation); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const observed = JSON.parse(await fs.readFile(path.join(output, 'actual/result.json'), 'utf8'));
  if (observed.state !== 'ACTUAL_LITE_IMAGE_TESTBED_PYTHON_BASE_ONLY_GIT_AND_BOTH_GATEWAYS_NO_MODELS'
    || observed.realModelRequests !== 0 || !observed.ownContainersRemoved) throw new Error('Actual Lite qualification incomplete');
} catch (error) { failure = { code: typeof error.code === 'string' ? error.code : 'LITE_SETUP_QUALIFICATION_FAILED' }; stdout = error.stdout ?? stdout; stderr = error.stderr ?? stderr; }
finally { await proxy.close(); }
await fs.writeFile(path.join(output, 'output.log'), stdout + stderr, { mode: 0o600 });
const changed = [];
for (const [file, expected] of Object.entries(before)) if (sha(await fs.readFile(file)) !== expected) changed.push(file);
if (changed.length) failure = { code: 'LITE_QUALIFICATION_SOURCE_CHANGED' };
const result = { state: failure ? 'INCOMPLETE' : 'ACTUAL_LITE_SETUP_AND_NATIVE_GATEWAY_NO_MODEL_QUALIFIED',
  instanceId: arg('--instance-id'), actualEvidence: path.join(output, 'actual/result.json'),
  failure: failure ?? null, proxy: proxy.snapshot(), sourceChanged: changed, sourcePins: before,
  originalTaskSubmitted: false, officialGraderExecuted: false, realModelRequests: 0,
  limits: 'Selected official image plus actual host/Conda/base-only Git/readonly/bootstrap only. No model or hidden evaluator input.' };
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ state: result.state, instanceId: result.instanceId, realModelRequests: 0, failure: result.failure }));
if (failure) process.exitCode = 1;
