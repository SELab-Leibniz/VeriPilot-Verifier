import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimplifyGateway, redactEvaluationText, readProviderTiming, summarizeProviderUsage, waitSimplifyRunTerminal } from './helpers/simplify-native-evaluation.mjs';

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, artifact: { type: 'string' },
    'host-root': { type: 'string' }, 'openclaw-profile': { type: 'string' }, model: { type: 'string' } } });
  const { output } = values;
  if (!output || !values.artifact || !values['host-root'] || !values['openclaw-profile']) throw new Error('Explicit isolated smoke inputs required.');
  await fs.mkdir(output);
  const projectRoot = path.join(output, 'project');
  const started = Date.now();
  const result = { state: 'failed' };
  let gateway, sessionKey, runId, assistant, dispatchedAt;
  try {
    gateway = await createSimplifyGateway({ hostRoot: values['host-root'], projectRoot, outputRoot: output,
      sourceRoot: fileURLToPath(new URL('../', import.meta.url)), prebuiltPluginRoot: values.artifact,
      model: values.model, providerKind: 'host-profile', openclawProfile: values['openclaw-profile'],
      phaseTimeoutMs: 60000, maxRequests: 2, disableMemoryFlush: true, businessToolNames: [] });
    result.providerIdentity = gateway.providerIdentity;
    const session = await gateway.request('sessions.create', { key: `agent:main:simplify-smoke-${randomUUID()}`, agentId: 'main' });
    if (!session.ok || !session.key) throw new Error('Smoke session creation failed.');
    sessionKey = session.key;
    const sessions = gateway.runtime.agent.session;
    const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store, readConsistency: 'latest' };
    await sessions.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
    const { sessionId } = await sessions.getSessionEntry(scope);
    gateway.setPhase('model-smoke');
    dispatchedAt = Date.now();
    const accepted = await gateway.request('chat.send', { sessionKey, sessionId, message: 'Reply exactly: OK', idempotencyKey: randomUUID(),
      deliver: false, thinking: 'low', timeoutMs: 60000 });
    runId = accepted.runId;
    if (!runId) throw new Error('The Gateway did not accept the smoke request.');
    const terminal = await waitSimplifyRunTerminal(gateway, runId, dispatchedAt + 60000);
    if (!terminal) { result.state = 'timed-out'; throw new Error('The smoke run exceeded its total deadline.'); }
    result.responseMs = Date.now() - dispatchedAt;
    if (terminal?.status !== 'ok') throw new Error('The smoke model turn did not finish normally.');
    runId = null;
    await gateway.drain();
    const entry = await sessions.getSessionEntry(scope);
    const transcript = sessions.resolveSessionFilePath(sessionId, entry, { agentId: 'main', sessionsDir: path.dirname(scope.storePath) });
    const relative = path.relative(gateway.root, transcript);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Smoke transcript escaped the isolated Gateway.');
    assistant = (await fs.readFile(transcript, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line).message)
      .findLast(message => message?.role === 'assistant');
    const text = typeof assistant?.content === 'string' ? assistant.content
      : assistant?.content?.filter(block => block.type === 'text').map(block => block.text).join('');
    if (!text?.trim()) throw new Error('The smoke response has no assistant text.');
    result.state = 'completed';
  } catch (error) { result.reason = redactEvaluationText(error.message); }
  finally {
    if (runId && gateway) await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
    if (gateway) await gateway.close();
  }
  const timing = gateway ? await readProviderTiming(gateway.root) : [];
  const firstRequest = timing.find(row => row.event === 'request' && row.phase === 'model-smoke');
  result.firstProviderRequestMs = firstRequest && dispatchedAt !== undefined ? Date.parse(firstRequest.startedAt) - dispatchedAt : null;
  result.upstreamStatuses = timing.filter(row => row.event === 'response').map(row => row.status);
  const providerStatus = gateway?.providerStatus?.();
  result.usage = summarizeProviderUsage(providerStatus?.requests ?? 0, [assistant?.usage]);
  result.elapsedMs = Date.now() - started;
  if (providerStatus?.failure) {
    result.state = providerStatus.failure === 'PROFILE_RATE_LIMIT' ? 'rate-limited' : 'failed';
    result.reason = providerStatus.failure;
  } else if (result.state === 'completed' && (!result.usage.completeCalls || result.usage.completeCalls !== result.usage.observedCalls
    || !Number.isFinite(result.firstProviderRequestMs) || result.firstProviderRequestMs < 0 || !result.upstreamStatuses.includes(200))) {
    result.state = 'failed'; result.reason = 'Smoke response or complete provider usage could not be verified.';
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  process.exit(result.state === 'completed' ? 0 : 1);
}

await main().catch(error => { console.error(redactEvaluationText(error.message)); process.exit(1); });
