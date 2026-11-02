// RC-owned evaluation entry. A settled control still requires an independent
// audit of its baseline, document, Skill and Stop semantics.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { installNativeGatewayBatch } from './helpers/native-gateway-batch.mjs';
import { validateNativeStopBatchLimits } from './helpers/native-stop-evaluation.mjs';
import { prepareIntegratedFixture, createIntegratedFencePlugin } from './helpers/native-integrated-module-case.mjs';
import { runIntegratedOriginalCase } from './helpers/native-integrated-original-case.mjs';
import { harborGatewayFailureDetails } from './bench/harbor-gateway-runner.mjs';

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const offline = args.includes('--capture-native');
if (offline === args.includes('--live') || !value('--host-root') || !value('--manifest') || !value('--output'))
  throw new Error('Use --capture-native or --live, --host-root, --manifest and a fresh --output.');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(value('--output'));
const manifest = JSON.parse(await fs.readFile(value('--manifest'), 'utf8'));
assert.equal(manifest.kind, 'native-gateway-original-loop-v1');
assert.equal(manifest.component, 'native-integrated-module-control-v1');
assert(['compliant', 'fault'].includes(manifest.control), 'A declared integrated control is required');
assert.equal(manifest.originalBusinessEntry, 'agent');
const limits = validateNativeStopBatchLimits(manifest.limits);
const model = manifest.model ?? 'glm-5.3';
assert(['glm-5.3', 'glm-5.3-flash'].includes(model));
const roleTimeoutMs = manifest.roleTimeoutMs ?? 180000;
const assessmentTimeoutMs = manifest.assessmentTimeoutMs ?? 210000;
const approvedDeadline = Date.parse(manifest.stageDeadline);
assert(Number.isFinite(approvedDeadline) && approvedDeadline > Date.now(), 'Integrated launch window expired');
await fs.mkdir(path.dirname(outputRoot), { recursive: true });
await fs.mkdir(outputRoot);
let batch, gateway, result = {}, failure, gatewayClosed = true;
const cleanupErrors = [];
const redact = error => String(error?.message ?? error).replaceAll(batch?.credential() ?? 'never-a-credential', '[REDACTED_CREDENTIAL]').slice(0, 1500);
try {
  const deadlineAt = Math.min(approvedDeadline, Date.now() + limits.wallMs);
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(outputRoot, 'project'),
    modelRef: `openai/${model}`, deadlineAt, roleTimeoutMs, assessmentTimeoutMs, businessTimeoutMs: manifest.businessTimeoutMs ?? limits.wallMs });
  const fixtureFile = path.join(outputRoot, 'fixture.json'), bindingFile = path.join(outputRoot, 'binding.json');
  await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2), { flag: 'wx' });
  const fence = await createIntegratedFencePlugin({ outputRoot, fixtureFile, bindingFile });
  batch = await installNativeGatewayBatch({ hostRoot: value('--host-root'), sourceRoot, outputRoot,
    projectRoot: fixture.projectRoot, manifest, offline });
  // Public transport policy covers the one existing finite case window;
  // installed host role/run deadlines remain independently binding.
  const phaseTimeoutMs = Math.floor(limits.wallMs / 1000) * 1000;
  gatewayClosed = false;
  gateway = await createNativeGatewayEvaluation({ hostRoot: value('--host-root'), sourceRoot,
    outputRoot, projectRoot: fixture.projectRoot, confineBusinessFiles: true,
    extraPluginPaths: [fence], businessToolNames: ['read', 'write', 'edit', 'exec'],
    injectDefect: manifest.control === 'fault', phaseTimeoutMs,
    baselineLimits: manifest.baselineLimits, baselineWireMode: manifest.baselineWireMode,
    provider: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model }, providerGuard: batch });
  gateway.setPhase(offline ? 'offline-integrated-original-payload' : `real-integrated-${manifest.control}`);
  result = await runIntegratedOriginalCase({ gateway, fixture, outputRoot, bindingFile,
    deadlineAt: Math.min(fixture.deadlineAt, Date.parse(batch.metrics().deadlineAt)), signal: batch.signal });
  if (!offline) {
    const ledger = JSON.parse(await fs.readFile(path.join(outputRoot, 'actual-final-ledger.json'), 'utf8'));
    const used = Object.values(ledger?.admissions ?? {}).filter(item => item.accounting === 'USED');
    const expectedUsed = manifest.control === 'fault' ? 1 : 0;
    const requiredRoles = ['ground-truth-extractor', 'artifact-reviewer', 'skill-reviewer', 'stop-reviewer'];
    result.mechanicalChecks = {
      authenticBusinessSettlement: result.authenticTerminals?.complete === true,
      currentFormalPass: result.formalVerification?.status === 'PASS',
      currentDurableDispatchPass: result.authenticTerminals?.dispatch?.reviewStatus === 'PASS',
      noPendingDispatch: result.authenticTerminals?.dispatch?.pending === 0,
      actualPrivateReceiptsSettled: result.privateRuns.length > 0 && result.privateRuns.every(run => run.status === 'SETTLED'),
      declaredModuleRolesPresent: requiredRoles.every(role => result.actualPrivateRoles[role] > 0),
      declaredAdmissionCount: used.length === expectedUsed && Object.keys(ledger?.admissions ?? {}).length === expectedUsed,
      actualSkillRead: result.actionEvidence.pairedSkillRead === true,
      actualDeliveryWrites: fixture.deliverables.every(file => result.actionEvidence.actualDeliveryWrites[file] > 0),
      currentPostEditVerifier: result.actionEvidence.freshSuccessfulVerificationObserved === true,
      declaredFault: manifest.control === 'fault'
        ? result.injected?.runId === result.business.originalRunId && result.injected.beforeHash !== result.injected.afterHash
          && result.injected.file === path.join(fixture.projectRoot, 'app.mjs')
        : result.injected === null,
    };
    result.mechanicallyComplete = Object.values(result.mechanicalChecks).every(Boolean);
    result.expectedControlAdmissions = expectedUsed;
    result.observedControlAdmissions = used.length;
  }
} catch (error) {
  failure = { ...harborGatewayFailureDetails(error), message: redact(error) };
  batch?.abort(new Error('INTEGRATED_CASE_FAILED'));
} finally {
  // Finish the host before removing its provider boundary. If host shutdown
  // fails, keep the boundary installed until this isolated CLI exits.
  try {
    if (gateway) { await gateway.close(); gatewayClosed = true; }
    else if (!gatewayClosed) {
      batch?.abort(new Error('INTEGRATED_GATEWAY_STARTUP_UNCONFIRMED'));
      cleanupErrors.push({ phase: 'gateway-startup', message: 'Gateway creation did not return a confirmed closed host; keep the provider boundary until this isolated CLI exits.' });
    }
  }
  catch (error) {
    gatewayClosed = false;
    batch?.abort(new Error('INTEGRATED_GATEWAY_CLOSE_FAILED'));
    cleanupErrors.push({ phase: 'gateway', message: redact(error) });
  }
  if (gatewayClosed) {
    try { await batch?.close(); }
    catch (error) { cleanupErrors.push({ phase: 'batch', message: redact(error) }); }
  }
}
const credentialPersistedFiles = [];
async function scan(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (entry.isFile() && batch && (await fs.readFile(file)).includes(Buffer.from(batch.credential())))
      credentialPersistedFiles.push(path.relative(outputRoot, file));
  }
}
await scan(outputRoot);
const transport = batch?.metrics();
const transportSettled = transport?.budget?.inFlightRequests === 0;
const captured = offline && transport?.simulatedDispatches > 0 && transport.realProviderRequests === 0;
const complete = !offline && result.mechanicallyComplete === true;
const closed = gatewayClosed && !cleanupErrors.length && transportSettled && !credentialPersistedFiles.length;
const state = closed && !failure && (captured || complete)
  ? offline ? 'CAPTURED_INTEGRATED_ORIGINAL_NO_PROVIDER' : 'MECHANICALLY_COMPLETE_REQUIRES_INDEPENDENT_MODULE_AUDIT'
  : 'INCOMPLETE';
Object.assign(result, { state, mode: offline ? 'offline-native-capture' : 'real-native-integrated-control',
  control: manifest.control, failure, cleanupErrors, transport, credentialPersistedFiles,
  sourceRoot, outputRoot, automaticModuleAcceptance: null, semanticAcceptance: null,
  limitations: ['Mechanical gates do not establish source-faithful baseline, document or Skill semantics; independent raw audit is required.',
    'The compliant control expects no correction admission; a natural model error is retained and cannot silently be relabeled as a clean control.',
    'The fault control changes app.mjs once before actual original finalization. Corrected delivery requires a new matching successful native verifier after its final edit.',
    'No official benchmark score or stable token/time improvement is claimed.'] });
await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ state, control: manifest.control, providerRequests: transport?.realProviderRequests,
  inFlightRequests: transport?.budget?.inFlightRequests, cleanupErrors: cleanupErrors.length, semanticAcceptance: null }));
process.exit(state === 'INCOMPLETE' ? 1 : 0);
