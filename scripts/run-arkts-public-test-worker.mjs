import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { arktsInstrumentRoute, captureArktsInstrumentIdentity, loadArktsInstrumentConfig } from './bench/arkts-instrument-runtime.mjs';
import { runArktsLocalTest } from './bench/arkts-local-test.mjs';
import { copyArktsPublicTestSnapshot } from './bench/arkts-public-test-snapshot.mjs';
import { captureArktsToolchainIdentity } from './bench/arkts-toolchain-identity.mjs';
import { serveArktsWorkerJobs } from './bench/arkts-worker-exchange.mjs';
import { shortArktsWorkspace } from './bench/short-workspace.mjs';
import { assertFrozenCampaignHarness } from './run-arkts-paired-campaign.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const required = ['exchange', 'tool-root', 'java-home', 'workspace-root'];
const usage = `node scripts/run-arkts-public-test-worker.mjs --exchange=<public share> --tool-root=<Huawei CLT> --java-home=<JBR> --workspace-root=<short private worker directory>
  [--instrument-config=<worker-local macOS Instrument Test routes> --json5-package=<resolving package.json>]`;

export async function runArktsWorkerPublicTest(input, job, { workspaceRoot, toolRoot, javaHome, instrument, measure = runArktsLocalTest }) {
  const projectRoot = await fs.mkdtemp(path.join(workspaceRoot, 'pub-'));
  try {
    const local = path.join(projectRoot, 's');
    const snapshotSha256 = await copyArktsPublicTestSnapshot(path.join(job.directory, 'source'), local, { signal: job.signal });
    assert.equal(snapshotSha256, input.snapshotSha256, 'The public test snapshot changed after queuing');
    const timeoutMs = job.deadline - Date.now();
    assert(timeoutMs > 0, 'Public test job expired before the native toolchain started');
    const measured = await measure({ projectRoot:local, toolRoot, javaHome, timeoutMs, signal:job.signal, install:true, instrument });
    if (instrument && (measured.freshReport || measured.execution.snapshotSha256 !== undefined))
      assert.equal(measured.execution.snapshotSha256, snapshotSha256, 'Instrument Test measured a different public snapshot');
    return { input, ...measured };
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { ...Object.fromEntries([...required, 'instrument-config', 'json5-package']
    .map(name => [name, { type: 'string' }])), help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  assert(required.every(name => values[name]), usage);
  const [exchange, toolRoot, javaHome, workspaceRoot] = await Promise.all(required.map(name => fs.realpath(values[name])));
  const outside = relative => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  assert(outside(path.relative(exchange, workspaceRoot)) && outside(path.relative(workspaceRoot, exchange)), 'Keep worker workspaces outside the exchange');
  assert(!values['instrument-config'] || values['json5-package'], 'Instrument Test requires --json5-package');
  const [instrumentFile, json5Package] = await Promise.all(['instrument-config', 'json5-package']
    .map(name => values[name] && fs.realpath(values[name])));
  if (instrumentFile) assert([instrumentFile, json5Package].every(file => outside(path.relative(exchange, file))),
    'Keep Instrument Test configuration outside the exchange');
  const config = instrumentFile && await loadArktsInstrumentConfig(instrumentFile);
  shortArktsWorkspace(exchange, 'pub', sourceRoot, workspaceRoot);
  const abort = new AbortController(), stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await serveArktsWorkerJobs(exchange, async (action, input, job) => {
    assert(action === 'identity' || action === 'test', 'Unsupported public test operation');
    assert.match(input?.releaseCommit ?? '', /^[a-f0-9]{40}$/u, 'An exact release is required');
    await assertFrozenCampaignHarness(sourceRoot, input.releaseCommit);
    const route = config && action === 'test' ? arktsInstrumentRoute(config, input.caseId) : undefined;
    const toolchain = config ? await captureArktsInstrumentIdentity({ config, toolRoot, javaHome, signal:job.signal })
      : await captureArktsToolchainIdentity({ toolRoot, javaHome });
    if (action === 'identity') return { toolchainSha256:toolchain.sha256, ...(config ? { runtime:toolchain.runtime } : {}) };
    assert.equal(input.toolchainSha256, toolchain.sha256, 'Worker public toolchain changed');
    assert.equal(input.runtime, toolchain.runtime, 'Worker public test backend changed');
    const scope = input.scope;
    if (scope !== undefined) assert(route && scope && Object.keys(scope).length === 3
      && ['module', 'suite', 'itName'].every(key => typeof scope[key] === 'string' && /^[^\r\n\0,]{1,200}$/u.test(scope[key])),
    'Invalid Instrument Test case scope');
    const instrument = route && { route, json5Package, scope, expectedDevice:toolchain.devices.find(device => device.target === route.target) };
    return runArktsWorkerPublicTest(input, job, { workspaceRoot, toolRoot, javaHome, instrument });
  }, { signal: abort.signal });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
