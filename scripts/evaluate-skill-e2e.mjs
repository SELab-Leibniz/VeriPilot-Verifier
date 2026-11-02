// A small, real OpenClaw business session exercising automatic Skill care.
// No verdicts, graphs, tool results or business repairs are supplied by this driver.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { installNativeGatewayBatch } from './helpers/native-gateway-batch.mjs';
import { prepareIntegratedFixture, createIntegratedFencePlugin } from './helpers/native-integrated-module-case.mjs';
import { runIntegratedOriginalCase } from './helpers/native-integrated-original-case.mjs';
import { installSkillFaultTransport } from './helpers/skill-e2e-fault-transport.mjs';
import { unifiedSkillFeedbackReceipts } from './helpers/skill-e2e-feedback.mjs';

const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function skillE2eOptions(args) {
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const positive = (name, fallback, max = 3600000) => {
    const number = Number(value(name) ?? fallback);
    if (!Number.isSafeInteger(number) || number < 1000 || number > max) throw new Error(`Invalid ${name}`);
    return number;
  };
  const options = { scenario: value('--scenario') ?? 'repair', roleTimeoutMs: positive('--role-timeout-ms', 600000),
    assessmentTimeoutMs: positive('--assessment-timeout-ms', 900000), wallMs: positive('--wall-ms', 1800000),
    businessTimeoutMs: positive('--business-timeout-ms', 1200000),
    hostRoot: value('--host-root') ?? '/opt/homebrew/lib/node_modules/openclaw', output: value('--output'),
    baseUrl: value('--base-url') ?? 'https://open.bigmodel.cn/api/coding/paas/v4', model: value('--model') ?? 'glm-5.3-flash',
    maxWatchTurns: Number(value('--max-watch-turns') ?? 1), intervalTurns: Number(value('--check-interval-turns') ?? 1) };
  if (!['repair', 'success'].includes(options.scenario)) throw new Error('Use --scenario repair or success');
  if (!Number.isSafeInteger(options.maxWatchTurns) || options.maxWatchTurns < 1 || options.maxWatchTurns > 10000)
    throw new Error('Invalid --max-watch-turns');
  if (!Number.isSafeInteger(options.intervalTurns) || options.intervalTurns < 1 || options.intervalTurns > 10000)
    throw new Error('Invalid --check-interval-turns');
  if (options.assessmentTimeoutMs <= 30000) throw new Error('Assessment must leave 30000ms for feedback delivery');
  return options;
}

export function skillE2ePolicy(options) {
  return `version: 2
locale: en
artifacts: []
dynamicGroundTruth:
  enabled: false
skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [delivery-verifier]
  skillRoots: [skills]
  completionCheckIntervalTurns: ${options.intervalTurns}
  maxWatchTurns: ${options.maxWatchTurns}
  maxFeedbacksPerSkill: 3
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 2
  maxCorrectionsPerFlow: 2
  assessmentTimeoutMs: ${options.assessmentTimeoutMs}
  feedbackReserveMs: 30000
  fileQualityReviewEnabled: false
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, '0')}: ${i === 7}`).join('\n')}
reviewers:
  defaults:
    model: openai/${options.model}
    effort: low
    timeoutMs: ${options.roleTimeoutMs}
    maxOutputTokens: 32768
output:
  persist: true
  directory: .runtime-correction
`;
}

export async function evaluateSkillE2e(options) {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const outputRoot = path.resolve(options.output ?? path.join(sourceRoot, '.runtime-correction/skill-e2e-hour', `${options.scenario}-${randomUUID()}`));
  await fs.mkdir(outputRoot, { recursive: true });
  const deadlineAt = Date.now() + options.wallMs;
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(outputRoot, 'project'), modelRef: `openai/${options.model}`, deadlineAt,
    roleTimeoutMs: options.roleTimeoutMs, assessmentTimeoutMs: options.assessmentTimeoutMs });
  fixture.businessTimeoutMs = options.businessTimeoutMs;
  fixture.strictExecOptions = false;
  fixture.controlledFault = options.scenario === 'repair';
  const skill = `---\nname: delivery-verifier\ndescription: Verify the supplied numeric module before completing delivery.\n---\n\nRun the exact public command below with the native exec tool. Its required result is actual exit code 0; a nonzero exit code is a failed Skill execution. Correct app.mjs and rerun verification to resolve a failure. After a correction, use the newest verification result for the current files to determine completion.\n\n${fixture.command}\n`;
  const guide = '# Usage guide\n\naccept takes a finite number and returns that number plus one: accept(2) === 3. The operation is stateless. Other input types are outside scope.\n';
  const originals = { '.runtime-corrector/config.yaml': skillE2ePolicy(options), 'skills/delivery-verifier/SKILL.md': skill };
  for (const [relative, bytes] of Object.entries({ ...originals, 'docs/guide.md': guide,
    ...(options.scenario === 'success' ? { 'app.mjs': 'export const accept = value => value + 1;\n' } : {}) }))
    await fs.writeFile(path.join(fixture.projectRoot, relative), bytes);
  for (const [relative, bytes] of Object.entries(originals)) fixture.immutableHashes[relative] = hash(bytes);
  fixture.requirement = `Read and follow skills/delivery-verifier/SKILL.md. The supplied contract describes accept(value), which must return the finite number plus one. The guide is already correct. First run the exact Skill command against the starting files before editing anything. Follow any Runtime Corrector feedback, repair app.mjs as needed, run the public command again after the final edit and complete the task. Do not change the Skill, contract, verifier or configuration. Do not claim that a failed verification passed.`;
  const fixtureFile = path.join(outputRoot, 'fixture.json'), bindingFile = path.join(outputRoot, 'binding.json');
  await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  const fence = await createIntegratedFencePlugin({ outputRoot, fixtureFile, bindingFile });
  const { stdout } = await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: sourceRoot, maxBuffer: 4 * 1024 * 1024 });
  const sourceHashes = {};
  for (const file of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    if (file.startsWith('.runtime-correction/')) continue;
    const stat = await fs.lstat(path.join(sourceRoot, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const bytes = await fs.readFile(path.join(sourceRoot, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (bytes) sourceHashes[file] = hash(bytes);
  }
  const priorSettlement = path.relative(sourceRoot, path.join(outputRoot, 'prior-settlement.json'));
  await fs.writeFile(path.join(sourceRoot, priorSettlement), JSON.stringify({ totalProviderRequests: 0,
    inFlightRequests: 0, cumulativeReferenceEstimateIncludingOldHeldUsd: 0, scope: 'This isolated run only; historical account usage is not reset.' }));
  const manifest = { kind: 'native-gateway-original-loop-v1', credentialEnv: 'RC_NATIVE_GATEWAY_API_KEY', sourceHashes,
    provider: { baseUrl: options.baseUrl, model: options.model },
    hostHashes: { 'package.json': hash(await fs.readFile(path.join(options.hostRoot, 'package.json'))) },
    priorSettlement, priorProviderRequests: 0, priorConservativeCommittedUsd: 0,
    launchClaim: path.relative(sourceRoot, path.join(outputRoot, 'launch.json')), stageDeadline: new Date(deadlineAt).toISOString(),
    limits: { requests: 96, perCase: 96, wallMs: options.wallMs, inputTokens: 532480, payloadBytes: 262144, outputTokens: 32768, usd: 160 } };
  await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  let batch, gateway, result, failure, boundaryMonitor, faultTransport;
  const cleanupErrors = [];
  const cancel = () => batch?.abort(new Error('SKILL_E2E_OWNER_CANCELLED'));
  const redact = error => String(error?.message ?? error).replaceAll(batch?.credential() ?? 'never-a-credential', '[REDACTED_CREDENTIAL]').slice(0, 1500);
  try {
    batch = await installNativeGatewayBatch({ sourceRoot, hostRoot: options.hostRoot, outputRoot,
      projectRoot: fixture.projectRoot, manifest });
    if (fixture.controlledFault) faultTransport = installSkillFaultTransport({ outputRoot });
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    boundaryMonitor = setInterval(() => {
      const status = batch.metrics();
      if (status.dispatchStopped && status.budget.inFlightRequests === 0)
        batch.abort(new Error(status.dispatchStopped));
    }, 1000);
    gateway = await createNativeGatewayEvaluation({ sourceRoot, hostRoot: options.hostRoot, outputRoot,
      projectRoot: fixture.projectRoot, confineBusinessFiles: true, extraPluginPaths: [fence],
      businessToolNames: ['read', 'write', 'edit', 'exec'], phaseTimeoutMs: Math.ceil(options.wallMs / 1000) * 1000,
      provider: { api: 'openai-completions', baseUrl: options.baseUrl, model: options.model }, providerGuard: batch });
    result = await runIntegratedOriginalCase({ gateway, fixture, outputRoot, bindingFile, deadlineAt, signal: batch.signal });
    const session = JSON.parse(await fs.readFile(path.join(outputRoot, 'actual-business-session.json'), 'utf8'));
    const skillFeedbackReceipts = (session.messages ?? []).map(record => record.message ?? record)
      .filter(message => message.role === 'toolResult' && (message.content ?? []).some(block =>
        block.type === 'text' && block.text.includes('Skill execution correction: delivery-verifier')))
      .map(message => ({ toolCallId: message.toolCallId, toolName: message.toolName }));
    for (const receipt of batch.metrics().requests) {
      if (receipt.status !== 200) continue;
      const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${receipt.request}.json`), 'utf8'));
      if (payload.tools?.some(tool => tool.function.name === 'exec')
        && JSON.stringify(payload.messages).includes('Skill execution correction: delivery-verifier'))
        skillFeedbackReceipts.push({ delivery: 'actual-business-model-request', request: receipt.request, payloadSha256: receipt.payloadSha256 });
    }
    result.skillFeedbackReceipts = skillFeedbackReceipts;
    const task = JSON.parse(await fs.readFile(path.join(outputRoot, 'actual-final-task.json'), 'utf8'));
    const watchers = Object.values(task?.watchers ?? {});
    const assessments = [], observedFindings = [];
    const evaluationRoot = result.taskEvidenceRoot && path.join(result.taskEvidenceRoot, 'skills/delivery-verifier/evaluations');
    for (const file of evaluationRoot ? await fs.readdir(evaluationRoot).catch(() => []) : []) {
      const value = JSON.parse(await fs.readFile(path.join(evaluationRoot, file), 'utf8'));
      observedFindings.push(...(value.review?.findings ?? []));
      assessments.push({ file, status: value.status ?? (value.review?.findings?.length ? 'DEVIATION' : value.review?.checkerError ? 'UNVERIFIED' : value.review?.completionStatus),
        findings: value.review?.findings?.length ?? 0, summary: value.review?.summary });
    }
    result.skillAssessments = assessments;
    const graph = result.taskEvidenceRoot && await fs.readFile(path.join(result.taskEvidenceRoot,
      'skills/delivery-verifier/skill-ground-truth.json'), 'utf8').then(JSON.parse, () => null);
    const ledger = JSON.parse(await fs.readFile(path.join(outputRoot, 'actual-final-ledger.json'), 'utf8'));
    const admissionIds = Object.keys(ledger?.admissions ?? {}).filter(id => ledger.admissions[id].accounting === 'USED');
    for (const receipt of batch.metrics().requests) {
      if (receipt.status !== 200) continue;
      const payload = JSON.parse(await fs.readFile(path.join(outputRoot, `request-${receipt.request}.json`), 'utf8'));
      skillFeedbackReceipts.push(...unifiedSkillFeedbackReceipts({ payload, graph, findings: observedFindings,
        admissionIds, request: receipt.request }));
    }
    const checks = { automaticSkillRead: result.actionEvidence.pairedSkillRead === true,
      realGraphExtraction: result.actualPrivateRoles['ground-truth-extractor'] > 0,
      realSkillReviewer: result.actualPrivateRoles['skill-reviewer'] > 0,
      currentWatcherPass: watchers.some(w => w.status === 'PASS' && w.sourceInterpretationChecked === true),
      freshVerifierSuccess: result.actionEvidence.freshSuccessfulVerificationObserved === true,
      authenticTerminal: result.authenticTerminals?.complete === true && result.authenticTerminals?.dispatch?.reviewStatus === 'PASS',
      privateRunsSettled: result.privateRuns.length > 0 && result.privateRuns.every(run => run.status === 'SETTLED'),
      ...(options.scenario === 'repair' ? {
        controlledFaultApplied: await fs.stat(path.join(outputRoot, 'fault-injection.json')).then(stat => stat.size > 0, () => false),
        skillDeviationObserved: assessments.some(item => item.findings > 0),
        feedbackObserved: skillFeedbackReceipts.length > 0,
        businessRepairObserved: result.actionEvidence.actualDeliveryWrites['app.mjs'] > 0,
      } : { noUnexpectedSkillFeedback: skillFeedbackReceipts.length === 0 }) };
    result.checks = checks;
    result.accepted = Object.values(checks).every(Boolean);
  } catch (error) { failure = { code: error.code ?? error.name, message: redact(error) }; }
  finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    clearInterval(boundaryMonitor);
    try { await gateway?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
    faultTransport?.close();
    try { await batch?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
  }
  const report = { scenario: options.scenario, state: result?.accepted && !failure && !cleanupErrors.length ? 'PASS' : 'INCOMPLETE',
    options, outputRoot, result, failure, cleanupErrors, transport: batch?.metrics(),
    scope: 'One real automatic OpenClaw Skill process-verification scenario. Repair substitutes exactly one original business decision after an actual verifier failure, preserving the real original model response and full provider usage. Reviewers and later repair are unmodified. Global baseline, document review and other Stop metrics are disabled explicitly.' };
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await evaluateSkillE2e(skillE2eOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ state: report.state, outputRoot: report.outputRoot, checks: report.result?.checks, failure: report.failure }));
  process.exit(report.state === 'PASS' ? 0 : 1);
}
