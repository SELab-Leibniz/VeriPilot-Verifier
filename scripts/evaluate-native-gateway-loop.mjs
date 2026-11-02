// The complete original/repair path is the installed Gateway, not injected
// lifecycle events. Fault injection is explicitly an experiment fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { installNativeGatewayBatch } from './helpers/native-gateway-batch.mjs';
import { runNativeOriginalTurn } from './helpers/native-original-turn-case.mjs';
import { harborGatewayFailureDetails } from './bench/harbor-gateway-runner.mjs';

const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const offline = args.includes('--capture-native');
if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output'))
  throw new Error('Use --capture-native or --live, with --host-root, --manifest, and a fresh --output.');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)), outputRoot = path.resolve(value('--output'));
await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
const projectRoot = path.join(outputRoot, 'project'), manifest = JSON.parse(await fs.readFile(value('--manifest'), 'utf8'));
let batch, gateway, result;
try {
  batch = await installNativeGatewayBatch({ hostRoot: value('--host-root'), sourceRoot, outputRoot, projectRoot, manifest, offline });
  gateway = await createNativeGatewayEvaluation({ hostRoot: value('--host-root'), sourceRoot, outputRoot, projectRoot,
    confineBusinessFiles: true, injectDefect: true, phaseTimeoutMs: 240000,
    provider: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' }, providerGuard: batch });
  gateway.setPhase(offline ? 'offline-original-payload' : 'real-original-and-automatic-repair');
  result = await runNativeOriginalTurn({ gateway, projectRoot, outputRoot, signal: batch.signal, wallMs: manifest.limits.wallMs,
    originalBusinessEntry: manifest.originalBusinessEntry ?? 'chat', deadlineAt: Date.parse(batch.metrics().deadlineAt) });
} catch (error) {
  result = { complete: false, failure: harborGatewayFailureDetails(error), error: { code: error.code ?? 'GATEWAY_LOOP_FAILED',
    message: String(error.message).replaceAll(batch?.credential() ?? 'never-a-credential', '[REDACTED_CREDENTIAL]').slice(0, 1000) } };
} finally {
  await gateway?.close(); await batch?.close();
}
Object.assign(result, { transport: batch?.metrics(), outputRoot, semanticAcceptance: null,
  limitations: ['Only M16 is enabled for this isolated feedback/repair-path experiment; no full-module or benchmark score is claimed.',
    'A controlled fixture corrupts app.mjs once before the real original run finalizes. The original model, terminal, feedback, repair and revalidation are real in live mode.'] });
const credentialFiles = [];
async function checkCredentialFiles(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkCredentialFiles(file);
    else if (entry.isFile() && batch && (await fs.readFile(file)).includes(Buffer.from(batch.credential())))
      credentialFiles.push(path.relative(outputRoot, file));
  }
}
await checkCredentialFiles(outputRoot);
result.credentialPersistedFiles = credentialFiles;
if (credentialFiles.length) result.complete = false;
if (offline) {
  result.complete = false;
  result.state = result.transport?.simulatedDispatches > 0 && result.transport?.realProviderRequests === 0
    && result.transport?.budget.inFlightRequests === 0 && !credentialFiles.length ? 'CAPTURED_NO_PROVIDER' : 'INCOMPLETE';
} else result.state = result.complete ? 'LOOP_COMPLETED_REQUIRES_INDEPENDENT_AUDIT' : 'INCOMPLETE';
await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ state: result.state, requests: result.transport?.realProviderRequests, inFlight: result.transport?.budget.inFlightRequests, outputRoot }));
process.exit(['CAPTURED_NO_PROVIDER', 'LOOP_COMPLETED_REQUIRES_INDEPENDENT_AUDIT'].includes(result.state) ? 0 : 1);
