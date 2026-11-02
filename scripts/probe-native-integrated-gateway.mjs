// Offline-only actual standard Gateway agent payload qualification. The existing
// guard supplies capture text, never business operations, claims or verdicts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { installNativeGatewayBatch } from './helpers/native-gateway-batch.mjs';
import { prepareIntegratedFixture, createIntegratedFencePlugin, dispatchIntegratedOriginal } from './helpers/native-integrated-module-case.mjs';

const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--capture-native') || args.includes('--live') || !args.includes('--manifest')
  || !args.includes('--host-root') || !args.includes('--output'))
  throw new Error('Offline capture only: --capture-native --manifest --host-root --output (fresh).');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)), outputRoot = path.resolve(value('--output'));
await fs.mkdir(outputRoot);
const manifest = JSON.parse(await fs.readFile(value('--manifest'), 'utf8'));
if (manifest.component !== 'integrated-module-offline-preparation-v1') throw new Error('Explicit offline integrated manifest required');
const deadlineAt = Math.min(Date.parse(manifest.stageDeadline), Date.now() + manifest.limits.wallMs);
const fixture = await prepareIntegratedFixture({ projectRoot: path.join(outputRoot, 'project'), modelRef: 'openai/glm-5.3', deadlineAt });
const fixtureFile = path.join(outputRoot, 'fixture.json'), bindingFile = path.join(outputRoot, 'binding.json');
await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
const fence = await createIntegratedFencePlugin({ outputRoot, fixtureFile, bindingFile });
let guard, gateway, business, failure;
try {
  guard = await installNativeGatewayBatch({ hostRoot: value('--host-root'), sourceRoot, outputRoot,
    projectRoot: fixture.projectRoot, manifest, offline: true });
  const phaseTimeoutMs = Math.max(1000, Math.floor(Math.min(120000, Date.parse(guard.metrics().deadlineAt) - Date.now()) / 1000) * 1000);
  gateway = await createNativeGatewayEvaluation({ hostRoot: value('--host-root'), sourceRoot, outputRoot,
    projectRoot: fixture.projectRoot, confineBusinessFiles: true, extraPluginPaths: [fence],
    businessToolNames: ['read', 'write', 'edit', 'exec'], injectDefect: false, phaseTimeoutMs,
    provider: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' }, providerGuard: guard });
  gateway.setPhase('offline-integrated-original-payload-only');
  business = await dispatchIntegratedOriginal({ gateway, fixture, bindingFile,
    deadlineAt: Math.min(fixture.deadlineAt, Date.parse(guard.metrics().deadlineAt)), signal: guard.signal });
  while (!guard.signal.aborted && Date.now() < Date.parse(guard.metrics().deadlineAt)) {
    if (guard.metrics().simulatedDispatches > 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
} catch (error) { failure = { code: error.code ?? error.name,
  message: String(error.message).replaceAll(guard?.credential() ?? 'never-a-credential', '[REDACTED_CREDENTIAL]').slice(0, 1000) };
  const { getGlobalPluginRegistry } = await import(pathToFileURL(path.join(path.resolve(value('--host-root')), 'dist/plugins/hook-runner-global.js')).href);
  const registry = getGlobalPluginRegistry();
  await fs.writeFile(path.join(outputRoot, 'actual-plugin-diagnostics.json'), JSON.stringify({
    plugins: registry?.plugins?.map(({ id, status, error, source }) => ({ id, status, error, source })),
    diagnostics: registry?.diagnostics }, null, 2));
}
finally { await gateway?.close(); await guard?.close(); }
const metrics = guard?.metrics();
const result = { state: metrics?.simulatedDispatches > 0 && metrics.realProviderRequests === 0
  && metrics.budget.inFlightRequests === 0 ? 'CAPTURED_INTEGRATED_ORIGINAL_NO_PROVIDER' : 'INCOMPLETE',
  automaticModuleAcceptance: false, business, failure, transport: metrics,
  limitations: ['Actual installed Gateway standard agent serialized the original public task with the normal all-module policy.',
    'The capture guard supplied no business solution, tool actions, baseline, reviews or semantic acceptance. This is not an integrated real-model success or a benchmark result.'] };
await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, simulatedDispatches: metrics?.simulatedDispatches,
  realProviderRequests: metrics?.realProviderRequests, failure }));
process.exitCode = result.state === 'CAPTURED_INTEGRATED_ORIGINAL_NO_PROVIDER' ? 0 : 1;
