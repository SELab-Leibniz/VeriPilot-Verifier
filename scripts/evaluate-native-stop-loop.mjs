// Explicit development probe; never packaged or run by the normal test suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeStopTimeouts } from './helpers/native-stop-timeouts.mjs';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';

const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--restart-check')) {
  if (!args.includes('--host-root')) throw new Error('--restart-check needs --host-root.');
  const { restartNativeStopLoop } = await import('./helpers/restart-native-stop-loop.mjs');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = await restartNativeStopLoop({ outputRoot: path.resolve(value('--restart-check')), sourceRoot, hostRoot: value('--host-root') });
  console.log(JSON.stringify(result)); if (!result.complete) process.exitCode = 1;
} else if (args.includes('--audit')) {
  const { auditNativeStopLoop } = await import('./helpers/audit-native-stop-loop.mjs');
  const audit = await auditNativeStopLoop(path.resolve(value('--audit')));
  console.log(JSON.stringify(audit));
  if (!audit.complete) process.exitCode = 1;
} else {
const live = args.includes('--live');
const codingPlan = args.includes('--coding-plan');
if (live === args.includes('--transport-check') || !args.includes('--host-root'))
  throw new Error('Use exactly one of --transport-check or --live, plus --host-root <installed OpenClaw>. --live calls real models.');
if (live && !args.includes('--initial-turn'))
  throw new Error('Post-run until_pass requires a real Gateway terminal. Use --live --initial-turn for a normal business run; add --inject-defect for the automatic repair cycle. Seeded terminal events cannot replace agent.wait.');
if (live && codingPlan && (!process.env.RC_EVAL_API_KEY || !process.env.RC_EVAL_NATIVE_MODEL))
  throw new Error('Coding Plan requires RC_EVAL_API_KEY and RC_EVAL_NATIVE_MODEL.');
if (live && !codingPlan && (!process.env.ANTHROPIC_AUTH_TOKEN || !process.env.ANTHROPIC_BASE_URL || !(process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL)))
  throw new Error('The live loop needs the existing provider environment and an explicit native model.');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = args.includes('--output') ? path.resolve(value('--output'))
  : path.join(sourceRoot, '.runtime-correction/live-native-loop', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
if (await fs.stat(outputRoot).catch(() => null)) throw new Error('Acceptance output already exists; preserve prior evidence and choose a fresh output.');
const timeouts = nativeStopTimeouts(args.includes('--timeout-ms') ? Number(value('--timeout-ms')) : undefined);
const startedAt = Date.now(), deadlineAt = startedAt + timeouts.wallMs;
const controller = new AbortController();
const cancel = () => controller.abort(new Error('Evaluation cancelled'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const timer = setTimeout(() => controller.abort(new Error('Evaluation deadline expired')), timeouts.wallMs);
timer.unref();
const projectRoot = path.join(outputRoot, 'project');
let gateway;
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot: value('--host-root'), sourceRoot, outputRoot, projectRoot,
    prebuiltPluginRoot: args.includes('--artifact') ? path.resolve(value('--artifact')) : null,
    injectDefect: args.includes('--inject-defect'), phaseTimeoutMs: timeouts.phaseTimeoutMs,
    confineBusinessFiles: true, disableMemoryFlush: true,
    ...(codingPlan ? { provider: { api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: process.env.RC_EVAL_NATIVE_MODEL } } : {}) });
  gateway.stopTimeouts = timeouts;
  gateway.setPhase(live ? args.includes('--initial-turn') ? 'original-turn' : 'automatic-loop' : 'transport-check');
  if (live && args.includes('--initial-turn')) {
    const { runNativeOriginalTurn } = await import('./helpers/native-original-turn-case.mjs');
    const result = await runNativeOriginalTurn({ gateway, projectRoot, outputRoot, deadlineAt, signal: controller.signal });
    result.timeouts = timeouts; result.elapsedMs = Date.now() - startedAt;
    await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode: result.mode, complete: result.complete, verification: result.verification, used: result.used, outputRoot }));
    if (!result.complete) process.exitCode = 1;
  } else {
  const { runtime, hooks } = gateway, sessionId = randomUUID(), sessionKey = `agent:main:rc-loop-${sessionId}`;
  const sessionFile = path.join(gateway.root, 'transport-session.jsonl');
  const marker = `Transport-only observation ${sessionId}`;
  await fs.writeFile(sessionFile, [
    { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectRoot },
    { type: 'message', id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: marker }], timestamp: Date.now() } },
  ].map(JSON.stringify).join('\n') + '\n');
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await runtime.agent.session.upsertSessionEntry({ ...scope, entry: { sessionId, sessionFile, spawnedCwd: projectRoot, updatedAt: Date.now() } });
  const saved = await runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  if (saved?.sessionId !== sessionId || saved.spawnedCwd !== projectRoot) throw new Error('The installed host did not persist the isolated session/project binding.');
  const lookedUp = await runtime.subagent.getSession({ sessionKey });
  if (!JSON.stringify(lookedUp?.messages).includes(marker)) throw new Error('The actual dispatch API did not read the isolated session transcript.');
  const health = await gateway.request('health', {});
  if (!health.ok) throw new Error('The authenticated loopback Gateway client failed its health check.');
  if (live) {
    const { runNativeStopLoopCase } = await import('./helpers/native-stop-loop-case.mjs');
    const result = await runNativeStopLoopCase({ gateway, projectRoot, outputRoot, sessionId, sessionKey, sessionFile });
    await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode: result.mode, complete: result.complete, verification: result.verification,
      used: result.used, providerRequests: result.providerRequests, outputRoot }));
    if (!result.complete) process.exitCode = 1;
  } else {
  const result = { mode: 'transport-check', timeouts, ...gateway.metrics(), sessionPersisted: true,
    dispatchSessionShape: Object.keys(lookedUp ?? {}), originalTranscriptRead: true, finalizationHook: hooks.hasHooks('before_agent_finalize'),
    startsModel: false, outputRoot };
  await gateway.drain();
  if (result.providerRequests > 0 || gateway.metrics().modelStarts.length || !result.finalizationHook) throw new Error('The transport check unexpectedly called a model or lacks the actual RC finalization hook.');
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  }
  }
} catch (error) {
  let message = String(error.message);
  for (const [key, secret] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|BASE_URL/iu.test(key) && secret?.length > 7) message = message.split(secret).join('<redacted>');
  const result = { mode: live ? args.includes('--initial-turn') ? 'original-turn' : 'automatic-loop' : 'transport-check', complete: false,
    error: { code: error.code ?? 'HARNESS_FAILED', message: message.slice(0, 800) }, ...gateway?.metrics(), outputRoot };
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); process.exitCode = 1;
} finally {
  clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  if (gateway) {
    await gateway.close();
    await fs.writeFile(path.join(outputRoot, 'closure.json'), JSON.stringify({ gatewayClosed: true,
      closedAt: new Date().toISOString(), ownerPid: process.pid, elapsedMs: Date.now() - startedAt }, null, 2));
    console.log(JSON.stringify({ state: 'gateway-closed', ownerPid: process.pid, outputRoot }));
  }
}
}
// Installed host singletons can retain observers after awaited shutdown.
process.exit(process.exitCode ?? 0);
