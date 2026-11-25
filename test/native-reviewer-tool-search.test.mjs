import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildMAPackage } from '../lib/ma-package-builder.mjs';
import { readMessages, toolText, validateNativeBaselineAndAudit, validateNativeSkillAndDocument,
  validateNativeRequirementFrame } from './helpers/native-reviewer-tool-cases.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const toolSearchControls = ['tool_search', 'tool_describe', 'tool_call', 'tool_search_code'];
const model = 'fixture/receipt-contract';
const scenarios = {
  'tool-search': 'MA Tool Search preserves native Stop, baseline, audit, Skill and document tools',
  'local-lean': 'MA local-model lean Tool Search leaves native Stop receipts and business Tool Search working',
  'code-mode': 'MA Code Mode leaves requirement-frame proposals and selections directly callable',
};

async function exerciseNativeReviewer(root, hostRoot, scenario) {
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const requirement = 'Deliver a document containing the word Ready.';
  await fs.writeFile(path.join(projectRoot, 'deliverable.md'), 'Ready\n');

  // Load the MA package through the actual plugin loader in a fresh host profile.
  const { directory } = await buildMAPackage({ sourceRoot, outputRoot: path.join(root, 'build') });
  const pluginRoot = path.join(directory, 'payload', 'runtime-corrector');
  await fs.writeFile(path.join(directory, 'install-complete.json'), JSON.stringify({ enabled: true }));
  const host = relative => import(pathToFileURL(path.join(hostRoot, relative)).href);
  const plugin = relative => import(pathToFileURL(path.join(pluginRoot, relative)).href);
  process.argv[1] = path.join(hostRoot, 'openclaw.mjs');

  let chooseCall, providerError;
  const catalogs = { reviewer: [], business: [] };
  let phase = 'reviewer';
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const names = (payload.tools ?? []).map(tool => tool.function.name);
      catalogs[phase].push(names);
      const action = await chooseCall(payload, names), call = Array.isArray(action) ? action : null;
      const [name, args] = call ?? [];
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: action ?? 'Fixture complete.' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) {
        response.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerError ??= error;
      response.writeHead(400).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const codeMode = scenario === 'code-mode', localLean = scenario === 'local-lean';
    const config = {
      agents: { defaults: { workspace: projectRoot, model: { primary: model }, sandbox: { mode: 'off' },
        ...(localLean ? { experimental: { localModelLean: true } } : {}) },
        list: [{ id: 'main', agentDir: path.join(root, 'agent'), tools: { alsoAllow: ['runtime_corrector'],
          ...(codeMode ? { codeMode: { enabled: true } } : {}) } }] },
      tools: { profile: 'coding', ...(localLean ? {} : { toolSearch: { enabled: true, mode: 'tools' } }),
        ...(codeMode ? { codeMode: { enabled: true } } : {}) },
      models: { mode: 'replace', providers: { fixture: { api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-receipt-fixture',
        models: [{ id: 'receipt-contract', name: 'Receipt fixture', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 32768 }] } } },
      session: { store: path.join(root, 'sessions.json') },
      plugins: { allow: ['runtime-corrector'], slots: { memory: 'none' }, load: { paths: [pluginRoot] },
        entries: { 'runtime-corrector': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true } } } },
    };
    const before = structuredClone(config), configText = JSON.stringify(config, null, 2);
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, configText);
    const { createPluginRuntime } = await host('dist/plugins/runtime/index.js');
    const { s: loadPlugins } = await host('dist/loader-D8d2EvVh.js');
    const registry = loadPlugins({ config, workspaceDir: projectRoot, activate: true, onlyPluginIds: ['runtime-corrector'] });
    assert.equal(registry.plugins.find(item => item.id === 'runtime-corrector')?.status, 'loaded', JSON.stringify(registry.diagnostics));
    assert(registry.tools.some(item => item.pluginId === 'runtime-corrector'));
    const runtime = createPluginRuntime();
    assert.equal(runtime.version, '2026.7.1-2');
    const { createOpenClawReviewerFactory } = await plugin('lib/openclaw/reviewer.mjs');
    const { STOP_REVIEW_SCHEMA } = await plugin('lib/runtime-v2/reviewer.mjs');
    const { ensureTask } = await plugin('lib/runtime-v2/task-store.mjs');
    const { sha256 } = await plugin('lib/runtime-v2/utils.mjs');
    const { taskId } = await ensureTask({ projectRoot, sessionId: 'tool-search-parent' });
    const factoryFor = (turns, runs = [], options = {}) => createOpenClawReviewerFactory({ runtime, config },
      { pluginRoot, ...options, async runEmbeddedAgent(params) {
        const run = {};
        runs.push(run);
        chooseCall = turns(params);
        try { return await runtime.agent.runEmbeddedAgent(params); }
        finally { run.messages = await readMessages(params.sessionFile); }
      } });
    const input = { plugin, pluginRoot, factoryFor, projectRoot, taskId, model };
    const evidence = { hostVersion: runtime.version, scenario };
    if (codeMode) evidence.frame = await validateNativeRequirementFrame(input).catch(error => { throw providerError ?? error; });
    else {
      evidence.stop = await validateStop({ factoryFor, projectRoot, taskId, requirement, sha256, schema: STOP_REVIEW_SCHEMA });
      if (!localLean) {
        evidence.baseline = await validateNativeBaselineAndAudit(input).catch(error => { throw providerError ?? error; });
        evidence.scoped = await validateNativeSkillAndDocument(input).catch(error => { throw providerError ?? error; });
      }
      if (providerError) throw providerError;
      assert(catalogs.reviewer.every(names => !names.some(name => toolSearchControls.includes(name))));
    }

    // Compare against a business run on the same host and the same profile.
    phase = 'business';
    const businessSteps = [['read', { path: 'deliverable.md' }], ['runtime_corrector', { command: 'project', format: 'json' }]];
    chooseCall = (_payload, names) => {
      if (codeMode) {
        assert(names.includes('exec') && names.includes('wait'));
        return null;
      }
      assert(names.includes('tool_call'));
      if (localLean) return null;
      const [id, args] = businessSteps.shift() ?? [];
      return id ? ['tool_call', { id, args }] : null;
    };
    const businessId = randomUUID(), businessFile = path.join(root, 'business.jsonl');
    await runtime.agent.runEmbeddedAgent({ config, sessionId: businessId, sessionKey: `agent:main:business:${businessId}`, agentId: 'main',
      runId: businessId, sessionFile: businessFile, workspaceDir: projectRoot, cwd: projectRoot,
      provider: 'fixture', model: 'receipt-contract', agentHarnessRuntimeOverride: 'openclaw', modelFallbacksOverride: [],
      toolsAllow: ['read', 'runtime_corrector'], prompt: 'Read the fixture document.', timeoutMs: 15000, suppressLiveStreamOutput: true });
    if (providerError) throw providerError;
    assert(catalogs.business.length);
    if (!codeMode && !localLean) {
      const business = (await readMessages(businessFile)).filter(message => message.role === 'toolResult');
      assert.equal(business.length, 2);
      assert(business.every(message => message.toolName === 'tool_call' && message.isError === false));
      assert.match(toolText(business[0]), /Ready/u);
      assert.equal(JSON.parse(toolText(business[1])).tool.name, 'runtime_corrector');
      evidence.businessCustomTool = 'runtime_corrector';
    }
    assert.deepEqual(config, before);
    assert.equal(await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'), configText);
    return { ...evidence, businessControls: codeMode ? 'Code Mode' : 'Tool Search' };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function validateStop({ factoryFor, projectRoot, taskId, requirement, sha256, schema }) {
  let sessionFile, basisFiles;
  const output = path.join(projectRoot, '.runtime-correction', 'fixture-output');
  const activeOutput = path.join(output, 'active.log');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(activeOutput, 'Fixture runtime output.\n');
  const factory = factoryFor(params => {
    sessionFile = params.sessionFile;
    ({ basisFiles } = JSON.parse(params.prompt).task);
    const originalUserFile = basisFiles.find(file => path.basename(file).startsWith('user-original-'));
    assert(originalUserFile);
    const steps = [
      ...basisFiles.map(file => ['source_read', { path: file }]),
      ['set_original_checklist', { items: [{ metricId: 'M01', verificationTarget: 'ARTIFACT', text: requirement,
        path: originalUserFile, lineStart: 1, lineEnd: 1 }] }],
      ['source_ls', {}], ['source_find', { pattern: 'deliverable.md' }], ['source_grep', { pattern: 'Ready' }],
      ['source_ls', { path: output }], ['source_read', { path: activeOutput }],
      ['review_notes', async payload => {
        const last = payload.messages.findLast(message => message.role === 'tool');
        assert.match(last.content, /Fixture runtime output/u);
        assert.doesNotMatch(last.content, /^\[citeId=/u);
        await fs.appendFile(activeOutput, 'Runtime output continues changing.\n');
        await fs.writeFile(path.join(output, 'later.log'), 'New runtime output.\n');
        return { note: 'Workspace and output navigation complete.' };
      }],
      ['review_history', { mode: 'state' }],
      ['review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true }],
      ['submit_review', payload => {
        const last = payload.messages.findLast(message => message.role === 'tool');
        const { items } = JSON.parse(last.content);
        return { taskId: items[0].taskId, verdict: 'PASS', reason: 'The fixture document contains Ready.', finish: true };
      }],
    ];
    let turn = 0;
    return async (payload, names) => {
      if (turn === basisFiles.length + 1 && names.includes('tool_call')) return null;
      const [name, input] = steps[turn++] ?? [];
      if (!name) return null;
      const args = typeof input === 'function' ? await input(payload) : input;
      if (names.includes(name)) return [name, args];
      // Exercise the actual failing transport if the host offers only the wrapper.
      assert(names.includes('tool_call'), `Reviewer is missing ${name}`);
      return ['tool_call', { id: name, args }];
    };
  });
  const original = { ref: 'U1', text: requirement, sha256: sha256(Buffer.from(requirement)) };
  const response = await factory({ projectRoot, taskId, role: 'stop-reviewer', schema,
    reviewer: { model, timeoutMs: 30000, maxAttempts: 1 },
    request: { reviewScope: { kind: 'workspace-stop' }, classificationContract: 2,
      population: { metrics: {}, reviewPolicy: { metrics: { M01: true, M16: false } } } },
    evidence: { groundTruth: { taskId, version: 0, claims: [], digest: sha256([]) },
      originalRequirements: { userMessages: [original], projectFiles: [], materials: [], referencedFiles: [], digest: sha256(original) },
      snapshot: { entries: [] } } }).catch(error => {
    if (!sessionFile) throw error;
    return { failure: error.code ?? error.message };
  });
  const persisted = (await readMessages(sessionFile)).filter(message => message.role === 'toolResult');
  const journal = await readMessages(path.join(path.dirname(sessionFile), 'observations.jsonl'));
  const receipts = journal.filter(message => message.details?.receiptBoundary === 'openclaw.tool_result_persist.v1');
  const directReads = persisted.filter(message => message.toolName === 'source_read' && message.isError === false);
  const basisReads = directReads.filter(message => toolText(message).startsWith('[citeId='));
  const evidence = { completed: response.reviewCompleted ?? false, failure: response.failure,
    checklist: persisted.some(message => message.toolName === 'set_original_checklist' && message.isError === false),
    wrapperResults: persisted.filter(message => message.toolName === 'tool_call').length,
    basisUnread: persisted.some(message => toolText(message).includes('Required original basis not fully read')),
    basisFiles: basisFiles.length, directBasisReads: basisReads.length, receipts: receipts.length };
  assert(evidence.completed, JSON.stringify(evidence));
  await response.close();
  assert.equal(response.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(evidence.checklist, true);
  assert.equal(evidence.wrapperResults, 0);
  assert.deepEqual(receipts.map(receipt => receipt.details.citation.path).sort(), [...basisFiles].sort());
  const readTextById = records => new Map(records.map(record => [record.toolCallId, toolText(record)]));
  assert.deepEqual(readTextById(receipts), readTextById(basisReads));
  assert.equal(directReads.length - basisReads.length, 1);
  const navigation = ['source_ls', 'source_find', 'source_grep', 'review_notes', 'review_history'];
  for (const toolName of navigation) assert(persisted.some(message => message.toolName === toolName && message.isError === false));
  return { ...evidence, navigation, runtimeOutputChanged: true };
}

if (process.argv[2] === '--native-tool-search-fixture') {
  const result = await exerciseNativeReviewer(...process.argv.slice(3));
  await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
  process.exit(0); // The child owns the host's native handles.
} else for (const [scenario, name] of Object.entries(scenarios)) test(name,
  { skip: !process.env.RC_OPENCLAW_HOST_ROOT && 'Set RC_OPENCLAW_HOST_ROOT to run the pinned MA host contract.' }, async t => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.realpath(await fs.mkdtemp(path.join(temp, 'rc-native-tool-search-')));
    t.after(async () => {
      assert(root.startsWith(path.join(temp, 'rc-native-tool-search-')));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    });
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(import.meta.url), '--native-tool-search-fixture', root, path.resolve(process.env.RC_OPENCLAW_HOST_ROOT), scenario],
      { timeout: 85000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: path.join(root, 'state'),
          OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_SKIP_CHANNELS: '1' } });
    t.diagnostic(stdout.trim().split(/\r?\n/u).at(-1));
  });
