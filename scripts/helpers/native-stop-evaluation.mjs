// Development-only acceptance transport for the pinned, installed host. The
// host package is inspected/imported only; config, state and build stay local.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildPlugin } from '../../lib/plugin-builder.mjs';
import { createOpenClawReviewerFactory } from '../../lib/openclaw/reviewer.mjs';
import { readOpenClawTranscript } from '../../lib/openclaw/transcript.mjs';
import * as hostAdapter from '../../lib/hosts/openclaw.mjs';
import { installProviderFetchTiming } from './provider-fetch-timing.mjs';

export async function createNativeStopEvaluation({ hostRoot, projectRoot, outputRoot, sourceRoot, legacy = false, traceTransport = false }) {
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.7.1-2') throw new Error('The native live probe requires installed OpenClaw 2026.7.1-2.');
  if (!process.env.ANTHROPIC_AUTH_TOKEN || !process.env.ANTHROPIC_BASE_URL) throw new Error('The native live probe requires the existing Anthropic-compatible provider environment.');
  const model = process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error('Set RC_EVAL_NATIVE_MODEL or ANTHROPIC_MODEL for the native live probe.');
  const root = path.join(outputRoot, 'native-host');
  await fs.mkdir(root, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'config.json');
  // The provider reads this in memory. No key enters the saved config or build.
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');
  const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(root, 'build') });
  const config = { logging: { level: 'warn', consoleLevel: 'silent', file: path.join(root, 'host.log') },
    agents: { defaults: { workspace: projectRoot, model: { primary: `anthropic/${model}` }, sandbox: { mode: 'off' } },
      list: [{ id: 'main', agentDir: path.join(root, 'agent') }] },
    session: { store: path.join(root, 'sessions.json') },
    models: { mode: 'replace', providers: { anthropic: { api: 'anthropic-messages', baseUrl: process.env.ANTHROPIC_BASE_URL,
      models: [{ id: model, name: model, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 32768 }] } } },
    plugins: { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] },
      entries: { 'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } } };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
  const timing = traceTransport ? await installProviderFetchTiming({ file: path.join(root, 'provider-fetch-timing.jsonl'),
    origin: new URL(process.env.ANTHROPIC_BASE_URL).origin }) : null;
  try {
  const load = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
  const { createPluginRuntime } = await load('dist/plugins/runtime/index.js');
  const { s: loadPlugins } = await load('dist/loader-D8d2EvVh.js');
  const registry = loadPlugins({ config, workspaceDir: projectRoot, activate: true, onlyPluginIds: ['runtime-corrector'] });
  const plugin = registry.plugins.find(item => item.id === 'runtime-corrector');
  if (plugin?.status !== 'loaded' || !registry.tools.some(item => item.pluginId === plugin.id))
    throw new Error(`Native plugin/tool registration failed: ${JSON.stringify(registry.diagnostics)}`);
  const runtime = createPluginRuntime(); runtime.config.current = () => config;
  const starts = [], ends = []; let businessInvocations = 0, reviewInvocations = 0;
  const legacyTask = legacy ? (await import('../../test/compat/legacy-stop-task-runtime.mjs')).runOpenClawStopTask : null;
  const factory = createOpenClawReviewerFactory({ runtime, config, logger: { warn() {} } }, {
    ...(legacyTask ? { runStopTask: legacyTask } : {}),
    pluginRoot, onRunStart: id => { starts.push(id); }, onRunEnd: id => { ends.push(id); },
  });
  if (legacyTask) factory.supportsStopGroups = true;
  const run = Object.assign(async input => {
    timing?.setPhase(`review:${++reviewInvocations}`);
    const { reviewerRuntime, ...native } = input;
    const { maxBudgetUsd, ...reviewer } = native.reviewer;
    return factory({ ...native, reviewer: { ...reviewer, model: `anthropic/${model}` }, hostAdapter, pluginRoot,
      excludedEvidencePaths: [...native.excludedEvidencePaths ?? [], root] });
  }, factory);
  return { model, run, async close() { await timing?.close(); }, async repair({ requirement, feedback, file }) {
    timing?.setPhase('business-repair');
    const sessionId = randomUUID(), runId = randomUUID(), transcript = path.join(root, `repair-${sessionId}.jsonl`);
    businessInvocations++;
    const result = await runtime.agent.runEmbeddedAgent({ sessionId, sessionKey: `agent:main:evaluation-business:${sessionId}`, agentId: 'main',
      runId, sessionFile: transcript, workspaceDir: projectRoot, cwd: projectRoot, agentDir: path.join(root, 'agent'), config,
      provider: 'anthropic', model, agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [], trigger: 'manual',
      timeoutMs: 180000, runTimeoutOverrideMs: 180000, abortSignal: AbortSignal.timeout(180000),
      toolsAllow: ['read', 'write', 'edit'], disableMessageTool: true, requireExplicitMessageTarget: true,
      skillsSnapshot: { prompt: '', skills: [] }, bootstrapContextMode: 'lightweight', promptMode: 'minimal', thinkLevel: 'low', suppressLiveStreamOutput: true,
      extraSystemPrompt: 'You are repairing a controlled local acceptance fixture. Modify only the named delivery file. Inspect the original external contract if required. Do not send messages or spawn agents. End with a concise completion statement.',
      prompt: `Original requirement:\n${requirement}\n\nNamed delivery file:\n${file}\n\nThe review found this deviation:\n${feedback}\n\nInspect the evidence and repair the named file to satisfy the original requirement.` });
    if (result.meta?.aborted) throw new Error('The business repair did not complete.');
    const entries = (await readOpenClawTranscript(transcript)).map(entry => entry.type === 'user' ? { ...entry, isMeta: true } : entry);
    if (!entries.some(entry => entry.type === 'assistant' && entry.message.content.some(block => block.type === 'tool_use' && /write|edit/iu.test(block.name))))
      throw new Error('The real business model did not issue a write/edit tool call.');
    return { entries, transcript, runId, sessionId };
  }, metrics: () => ({ kind: 'installed-native', hostVersion: pkg.version, actualModels: [model],
    nativeInvocations: starts.length, settledInvocations: ends.length, businessInvocations, hostRoot, isolatedState: root,
    ...(timing ? { fetchTiming: timing.requestCount ? timing.file : null, fetchRequestsObserved: timing.requestCount } : {}) }) };
  } catch (error) { await timing?.close(); throw error; }
}
