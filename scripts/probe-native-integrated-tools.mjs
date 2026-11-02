// Zero-model qualification of installed native tools and the experiment fence.
// These operator tool calls are never business history or automatic RC proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareIntegratedFixture, createIntegratedFencePlugin, integratedHash } from './helpers/native-integrated-module-case.mjs';

export async function probeIntegratedNativeTools({ hostRoot, outputRoot }) {
  const version = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json')));
  if (version.name !== 'openclaw' || version.version !== '2026.7.1-2') throw new Error('Pinned installed host required');
  await fs.mkdir(outputRoot); outputRoot = await fs.realpath(outputRoot);
  const fixture = await prepareIntegratedFixture({ projectRoot: path.join(outputRoot, 'project'), modelRef: 'openai/glm-5.3' });
  const fixtureFile = path.join(outputRoot, 'fixture.json'), bindingFile = path.join(outputRoot, 'binding.json');
  const business = { sessionId: 'offline-native-tool-qualification', sessionKey: 'agent:main:offline-native-tool-qualification' };
  await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2)); await fs.writeFile(bindingFile, JSON.stringify(business));
  const plugin = await createIntegratedFencePlugin({ outputRoot, fixtureFile, bindingFile });
  const state = path.join(outputRoot, 'state'), configPath = path.join(outputRoot, 'config.json');
  const config = { logging: { level: 'warn', consoleLevel: 'silent', file: path.join(outputRoot, 'host.log') },
    agents: { defaults: { workspace: fixture.projectRoot, sandbox: { mode: 'off' } }, list: [{ id: 'main',
      tools: { allow: ['read', 'write', 'edit', 'exec'] } }] }, tools: { fs: { workspaceOnly: true } },
    plugins: { enabled: true, allow: [plugin.id], load: { paths: [plugin.path] }, entries: { [plugin.id]: { enabled: true } } } };
  await fs.mkdir(state); await fs.writeFile(configPath, JSON.stringify(config));
  const changes = { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, RC_EVAL_PARENT_AUTH_SENTINEL: 'offline-parent-only' };
  const previous = new Map(Object.keys(changes).map(key => [key, process.env[key]])), oldArgv = process.argv[1];
  for (const [key, value] of Object.entries(changes)) process.env[key] = value;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  const oldFetch = globalThis.fetch, oldConnect = net.Socket.prototype.connect;
  const deniedNetwork = [];
  globalThis.fetch = async () => { deniedNetwork.push('fetch'); throw new Error('OFFLINE_PROBE_NETWORK_DENIED'); };
  net.Socket.prototype.connect = function () { deniedNetwork.push('socket'); throw new Error('OFFLINE_PROBE_NETWORK_DENIED'); };
  const calls = [], checks = {};
  let result;
  try {
    const load = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
    const { loadOpenClawPlugins } = await load('dist/plugins/loader.js');
    const registry = await loadOpenClawPlugins({ config, workspaceDir: fixture.projectRoot, cache: false });
    checks.realPluginLoaded = registry.plugins.some(item => item.id === plugin.id && item.status === 'loaded');
    if (!checks.realPluginLoaded) throw new Error('Actual host did not load the experiment hook');
    const { t: createOpenClawCodingTools } = await load('dist/agent-tools-BD8WL7ny.js');
    const tools = createOpenClawCodingTools({ config, agentId: 'main', ...business, runId: 'offline-qualification-run',
      cwd: fixture.projectRoot, workspaceDir: fixture.projectRoot, agentDir: path.join(state, 'agent'),
      modelProvider: 'openai', modelId: 'glm-5.3', modelApi: 'openai-completions' });
    checks.nativeToolsVisible = ['read', 'write', 'edit', 'exec'].every(name => tools.some(tool => tool.name === name));
    const { t: createAgentToolResultMiddlewareRunner } = await load('dist/tool-result-middleware-D2HOtSKh.js');
    const middleware = createAgentToolResultMiddlewareRunner({ runtime: 'openclaw' });
    const invoke = async (name, args) => {
      const call = { id: `qualification-${calls.length + 1}`, name, args, actor: 'offline-operator-qualification' }; calls.push(call);
      try {
        call.result = await tools.find(tool => tool.name === name).execute(call.id, args);
        call.middlewareResult = await middleware.applyToolResultMiddleware({ toolName: name, toolCallId: call.id, args,
          isError: call.result.isError === true, result: call.result });
        return call.result;
      }
      catch (error) { call.error = { name: error.name, message: error.message }; return null; }
    };
    const text = result => result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    checks.actualRead = text(await invoke('read', { path: 'skills/delivery-verifier/SKILL.md' })).includes('delivery-verifier');
    // Assert the child cannot see even a harmless parent authentication sentinel.
    const app = "if (process.env.RC_EVAL_PARENT_AUTH_SENTINEL || process.env.OPENAI_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN) throw new Error('inherited authentication');\nexport const accept = value => value + 1;\n";
    const guide = '# Usage\nFinite numbers: accept(2) === 3. Stateless; other input types are outside scope.\n';
    await invoke('write', { path: 'app.mjs', content: app }); await invoke('write', { path: 'docs/guide.md', content: guide });
    await invoke('edit', { path: 'docs/guide.md', edits: [{ oldText: '# Usage', newText: '# Module usage' }] });
    checks.actualWriteAndEdit = (await fs.readFile(path.join(fixture.projectRoot, 'app.mjs'), 'utf8')) === app
      && (await fs.readFile(path.join(fixture.projectRoot, 'docs/guide.md'), 'utf8')).startsWith('# Module usage');
    const verified = await invoke('exec', { command: fixture.command, workdir: fixture.projectRoot, timeout: 10, yieldMs: 10000, background: false });
    checks.actualNativeExecCompleted = verified?.details?.status === 'completed' && verified.details.exitCode === 0;
    checks.publicVerifierResult = text(verified).includes('"codePassed":true') && text(verified).includes('"guidePassed":true');
    const execCall = calls.find(call => call.name === 'exec');
    const observations = (await fs.readFile(path.join(outputRoot, 'native-business-tools.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    checks.actualExecReceiptPersisted = observations.some(item => item.phase === 'result' && item.event.toolCallId === execCall.id
      && item.runId === 'offline-qualification-run' && item.event.result?.details?.status === 'completed' && item.event.result.details.exitCode === 0);
    checks.nativeMiddlewareResultUnchanged = JSON.stringify(execCall.middlewareResult) === JSON.stringify(execCall.result);
    const denyCall = async (name, args) => {
      const count = calls.length; const value = await invoke(name, args);
      return /INTEGRATED_FIXTURE_DENIED/.test(calls[count].error?.message ?? text(value));
    };
    checks.privateReadDenied = await denyCall('read', { path: '.runtime-corrector/config.yaml' });
    checks.inputWriteDenied = await denyCall('write', { path: 'tools/verify.mjs', content: 'altered' });
    checks.outsideWriteDenied = await denyCall('write', { path: '../outside-denied', content: 'altered' });
    checks.otherCommandDenied = await denyCall('exec', { command: 'pwd', workdir: fixture.projectRoot, timeout: 10, yieldMs: 10000, background: false });
    checks.environmentOverrideDenied = await denyCall('exec', { command: fixture.command, workdir: fixture.projectRoot,
      timeout: 10, yieldMs: 10000, background: false, env: { NODE_OPTIONS: '--inspect' } });
    checks.inputsUnchanged = (await fs.readFile(path.join(fixture.projectRoot, 'tools/verify.mjs'))).equals(Buffer.from((await import('./helpers/native-integrated-module-case.mjs')).integratedVerifierSource));
    checks.outsideFileAbsent = !(await fs.lstat(path.join(outputRoot, 'outside-denied')).catch(() => null));
    // Exercise the genuine private factory's ownership lifecycle without a
    // model. Its dispatch callback performs only a real installed host read,
    // then deliberately fails; no semantic result or baseline is fabricated.
    const { createOpenClawReviewerFactory } = await import('../lib/openclaw/reviewer.mjs');
    const { ensureTask } = await import('../lib/runtime-v2/task-store.mjs');
    const { listNativeRuns } = await import('../lib/openclaw/native-runs.mjs');
    const task = await ensureTask({ projectRoot: fixture.projectRoot, sessionId: 'offline-private-parent' });
    // Operator qualification deliberately overlaps two real native reads with
    // the same ID across scopes. Hold the public middleware receipt until the
    // genuine private factory has made its own same-ID read.
    const sharedReadId = 'qualification-cross-scope-read';
    const pendingPublicRead = await tools.find(tool => tool.name === 'read').execute(sharedReadId,
      { path: 'requirements/original-contract.md' });
    calls.push({ id: sharedReadId, actor: 'offline-operator-pending-read-qualification', result: pendingPublicRead });
    let late, privateParams, privateRead, factoryDispatches = 0;
    const factory = createOpenClawReviewerFactory({ config, logger: { warn() {}, error() {} },
      runtime: { version: version.version, state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => fixture.projectRoot } } }, {
      provider: 'openai', model: 'glm-5.3', runEmbeddedAgent: async params => {
        factoryDispatches++; privateParams = params; late = AsyncLocalStorage.snapshot();
        const records = await listNativeRuns(fixture.projectRoot, task.taskId);
        checks.privateFactoryCommittedBeforeRead = records.some(record => record.runId === params.runId
          && record.sessionId === params.sessionId && record.role === 'skill-reviewer' && record.ownerPid === process.pid
          && record.status === 'DISPATCH_COMMITTED');
        const native = createOpenClawCodingTools({ ...params, agentId: params.agentId ?? 'main',
          modelProvider: params.provider, modelId: params.model, modelApi: 'openai-completions' });
        privateRead = native.find(tool => tool.name === 'read');
        const result = await privateRead.execute(sharedReadId, { path: 'skills/delivery-verifier/SKILL.md' });
        calls.push({ id: sharedReadId, actor: 'offline-genuine-private-factory-qualification',
          runId: params.runId, sessionId: params.sessionId, result });
        checks.privateFactoryNativeReadAllowed = text(result).includes('delivery-verifier') && !text(result).includes('INTEGRATED_FIXTURE_DENIED');
        const middlewareResult = await middleware.applyToolResultMiddleware({ toolName: 'read', toolCallId: sharedReadId,
          args: { path: 'skills/delivery-verifier/SKILL.md' }, isError: result.isError === true, result });
        checks.crossScopeNativeReceiptUnchanged = JSON.stringify(middlewareResult) === JSON.stringify(result);
        const events = (await fs.readFile(path.join(outputRoot, 'native-business-tools.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        checks.crossScopeBarePrivateReceiptRefused = events.some(item => item.phase === 'unavailable'
          && item.toolCallId === sharedReadId && item.reason === 'ambiguous-tool-call')
          && !events.some(item => item.phase === 'result' && item.event.toolCallId === sharedReadId);
        throw new Error('OFFLINE_PRIVATE_FACTORY_READ_QUALIFIED');
      } });
    const skillPath = path.join(fixture.projectRoot, 'skills/delivery-verifier/SKILL.md'), skill = await fs.readFile(skillPath, 'utf8');
    try {
      await factory({ projectRoot: fixture.projectRoot, sessionCwd: fixture.projectRoot, taskId: task.taskId,
        parentSessionId: 'offline-private-parent', role: 'skill-reviewer', pluginRoot: fileURLToPath(new URL('../', import.meta.url)),
        reviewer: { session: 'detached', timeoutMs: 10000, maxOutputTokens: 32768 },
        schema: { type: 'object', properties: {}, additionalProperties: false },
        request: { skill: { skillId: 'delivery-verifier' }, instructions: 'Offline native-read qualification only; deliberately stop before any model.' },
        evidence: { snapshot: { entries: [] }, skillSource: { root: path.dirname(skillPath), digest: integratedHash(skill),
          files: [{ path: 'SKILL.md', content: skill, sha256: integratedHash(skill) }] } } });
    } catch (error) { checks.privateFactoryDeliberateStop = error.message.includes('OFFLINE_PRIVATE_FACTORY_READ_QUALIFIED'); }
    checks.privateFactoryExactlyOneCallback = factoryDispatches === 1;
    checks.privateFactorySettled = (await listNativeRuns(fixture.projectRoot, task.taskId)).some(record =>
      record.runId === privateParams?.runId && record.status === 'SETTLED');
    await middleware.applyToolResultMiddleware({ toolName: 'read', toolCallId: sharedReadId,
      args: { path: 'requirements/original-contract.md' }, isError: pendingPublicRead.isError === true, result: pendingPublicRead });
    if (late && privateRead) {
      try {
        const lateResult = await late(() => privateRead.execute('qualification-private-late-read', { path: 'skills/delivery-verifier/SKILL.md' }));
        calls.push({ id: 'qualification-private-late-read', actor: 'offline-late-private-factory-qualification', result: lateResult });
        checks.privateFactorySettledReadDenied = text(lateResult).includes('INTEGRATED_FIXTURE_DENIED');
      } catch (error) {
        calls.push({ id: 'qualification-private-late-read', actor: 'offline-late-private-factory-qualification', error: { name: error.name, message: error.message } });
        checks.privateFactorySettledReadDenied = error.name === 'AbortError';
      }
    }
    await fs.writeFile(path.join(outputRoot, 'native-tool-schemas.json'), JSON.stringify(tools.map(({ name, parameters }) => ({ name, parameters })), null, 2));
    result = { state: Object.values(checks).every(Boolean) ? 'QUALIFIED_INSTALLED_NATIVE_TOOLS_ONLY' : 'INCOMPLETE', checks,
      hostVersion: version.version, hostModuleSha256: integratedHash(await fs.readFile(path.join(hostRoot, 'dist/agent-tools-BD8WL7ny.js'))),
      realProviderRequests: 0, modelDispatches: 0, deniedNetwork, businessOrAutomaticModuleAcceptance: false,
      limitations: ['Operator invoked actual installed tools through their native hook wrappers. The genuine private factory callback performed only a native read and deliberately stopped before any model; its own records established liveness and settlement. No original model session, semantic private assessment, automatic baseline/document/Skill/Stop loop or benchmark outcome is claimed.'] };
  } catch (error) { result = { state: 'INCOMPLETE', checks, error: { name: error.name, message: error.message },
    realProviderRequests: 0, modelDispatches: 0, deniedNetwork, businessOrAutomaticModuleAcceptance: false }; }
  finally {
    globalThis.fetch = oldFetch; net.Socket.prototype.connect = oldConnect; process.argv[1] = oldArgv;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  await fs.writeFile(path.join(outputRoot, 'native-tool-calls.json'), JSON.stringify(calls, null, 2));
  await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--host-root') || !args.includes('--output')) throw new Error('Use --host-root and fresh --output; this probe never invokes a model.');
  const result = await probeIntegratedNativeTools({ hostRoot: path.resolve(value('--host-root')), outputRoot: path.resolve(value('--output')) });
  console.log(JSON.stringify(result)); process.exitCode = result.state === 'QUALIFIED_INSTALLED_NATIVE_TOOLS_ONLY' ? 0 : 1;
}
