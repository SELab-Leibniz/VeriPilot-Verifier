#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSimplifyGateway, loadPackaged, readProviderTiming, redactEvaluationText, resolveSimplifyProvider, supportsSimplifyModel,
  summarizeProviderUsage, waitSimplifyRunTerminal } from './helpers/simplify-native-evaluation.mjs';

const requirementsSha256 = '5b59fab560565602276a94485899c073dc3b8a2f973bd743be2de91ece7988fd';
const wallMs = 30 * 60_000;
const scopeMessage = '本次只完成第 6.1 节纵向版本中“新建菜谱 → 添加食材和步骤”这一段。只在本隔离项目内实现和验证这个范围。';
const continueMessage = '请继续实现或验证刚才限定的工作，并简短说明当前进度。';
const checkpoint = '列出本任务关于菜谱编号、食材单位与数量、数据删除和导入导出必须遵守的规则。请一并说明数据库已损坏时应怎样处理。';
const firstTurnInstruction = '本轮仅阅读收到的完整项目需求并简短确认，不要开始实现。下一条用户消息会明确本次的实施范围。';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const readJsonLines = file => fs.readFile(file, 'utf8').then(text => text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)));
const comparableText = text => text.replace(/\r\n/gu, '\n').trim();

export function validateCompactionSettings(value) {
  const { contextWindowTokens, contextTokens, compaction } = value ?? {};
  const positive = number => Number.isSafeInteger(number) && number > 0;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 65536 || contextWindowTokens > 128000
    || !positive(contextTokens) || contextTokens > contextWindowTokens || !compaction
    || !Object.keys(value).every(key => ['contextWindowTokens', 'contextTokens', 'compaction'].includes(key))
    || !Object.keys(compaction).every(key => ['mode', 'reserveTokens', 'reserveTokensFloor', 'keepRecentTokens', 'truncateAfterCompaction'].includes(key))
    || ![undefined, 'default', 'safeguard'].includes(compaction.mode) || compaction.truncateAfterCompaction !== false
    || !positive(compaction.reserveTokens) || !positive(compaction.reserveTokensFloor) || !positive(compaction.keepRecentTokens)
    || Math.max(compaction.reserveTokens, compaction.reserveTokensFloor) + compaction.keepRecentTokens >= contextTokens)
    throw new Error('Invalid isolated compaction settings. Specify a model window, effective context, reserve/floor and recent retention; preserve the same transcript.');
  return { contextWindowTokens, contextTokens, compaction };
}

export function parseRestoreObservations(log) {
  const marker = '[runtime-corrector] compaction_restore ';
  const output = [];
  for (const line of log.split(/\r?\n/u)) {
    if (!line.includes(marker)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const message = Object.values(row).find(value => typeof value === 'string' && value.includes(marker));
    if (!message) continue;
    try {
      const data = JSON.parse(message.slice(message.indexOf(marker) + marker.length));
      const at = Date.parse(row.time ?? row._meta?.date);
      const compactedAt = Date.parse(data.compactedAt);
      if (Number.isFinite(at) && Number.isFinite(compactedAt) && Number.isSafeInteger(data.bytes) && data.bytes > 0)
        output.push({ at, compactedAt, length: data.bytes, characters: data.characters, truncated: data.truncated });
    } catch { continue; }
  }
  return output;
}

async function main() {
  const { values } = parseArgs({ options: {
    arm: { type: 'string' }, requirements: { type: 'string' }, settings: { type: 'string' }, output: { type: 'string' },
    artifact: { type: 'string' }, 'artifact-sha256': { type: 'string' }, 'host-root': { type: 'string' }, model: { type: 'string' },
    provider: { type: 'string', default: 'coding-plan' }, 'openclaw-profile': { type: 'string' }, live: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/evaluate-simplify-compaction.mjs --live --arm <calibration|C-off|C-on> --requirements <kitchen/requirements.md> --settings <json> --output <new directory> --artifact <unpacked package> --artifact-sha256 <integration package SHA256> --host-root <OpenClaw> --model <model> [--provider <coding-plan|anthropic-environment>]');
    return;
  }
  if (!values.live || !['calibration', 'C-off', 'C-on'].includes(values.arm)
    || !supportsSimplifyModel(values.provider, values.model, values['openclaw-profile']) || !/^[a-f0-9]{64}$/u.test(values['artifact-sha256'] ?? '')
    || ['requirements', 'settings', 'output', 'artifact', 'host-root'].some(key => !values[key])) throw new Error('Explicit isolated live compaction inputs required.');
  const startedAt = Date.now(), deadlineAt = startedAt + wallMs, signal = AbortSignal.timeout(wallMs);
  const { identity: providerIdentity } = await resolveSimplifyProvider(values.provider, values.model, values['openclaw-profile']);
  const bytes = await fs.readFile(values.requirements);
  if (sha(bytes) !== requirementsSha256) throw new Error('Kitchen requirements SHA256 differs from the approved plan.');
  const instruction = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const settings = validateCompactionSettings(JSON.parse(await fs.readFile(values.settings, 'utf8')));
  const output = path.resolve(values.output), projectRoot = path.join(output, 'project');
  await fs.mkdir(output);
  const settingsDir = path.join(projectRoot, '.runtime-corrector');
  await fs.mkdir(settingsDir, { recursive: true });
  const config = { version: 2, enabled: true, sessionDefaults: { enabled: true }, artifacts: [], dynamicGroundTruth: { enabled: false },
    stopCorrection: { enabled: false }, skillCorrection: { enabled: false }, implementationCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false, stageMetricsEnabled: false, originalRequirementsEnabled: true },
    compactionRestore: { enabled: values.arm === 'C-on' } };
  const policy = Object.entries(config).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
    ? [`${key}:`, ...Object.entries(value).map(([name, setting]) => `  ${name}: ${JSON.stringify(setting)}`)]
    : [`${key}: ${JSON.stringify(value)}`]);
  await fs.writeFile(path.join(settingsDir, 'config.yaml'), policy.join('\n') + '\n');
  const packageRoot = await fs.realpath(values.artifact);
  const { loadConfig } = await loadPackaged(packageRoot, 'lib/runtime-corrector.mjs');
  const { compileRuntimeV2Config } = await loadPackaged(packageRoot, 'lib/runtime-v2/config.mjs');
  const { userMessageLogPath } = await loadPackaged(packageRoot, 'lib/runtime-v2/original-requirements.mjs');
  if (compileRuntimeV2Config({ version: 2, compactionRestore: { enabled: true } }).compactionRestore?.enabled !== true)
    throw new Error('Prebuilt package does not expose the compaction restore switch.');
  const plan = await loadConfig({ cwd: projectRoot, pluginRoot: packageRoot });
  const runtime = plan.runtimeV2;
  if ((runtime.compactionRestore?.enabled === true) !== config.compactionRestore.enabled || !runtime.artifactCorrection.originalRequirementsEnabled
    || runtime.stopCorrection.enabled || runtime.skillCorrection.enabled || runtime.dynamicGroundTruth.enabled
    || runtime.artifactCorrection.groundTruthReviewEnabled || runtime.artifactCorrection.stageMetricsEnabled || runtime.implementationCorrection.enabled)
    throw new Error('The packed runtime did not apply the approved C-only settings.');
  const result = { arm: values.arm, artifactSha256: values['artifact-sha256'], model: values.model, providerIdentity, requirementsSha256, settings,
    configurationSummary: JSON.stringify({ ...config, ...settings, model: values.model, provider: providerIdentity }), turns: [] };
  let gateway, sessionKey, runId, transcriptPath, records = [], firstCompactedAt, answer;
  try {
    gateway = await createSimplifyGateway({ hostRoot: values['host-root'], projectRoot, outputRoot: output,
      sourceRoot: fileURLToPath(new URL('../', import.meta.url)), prebuiltPluginRoot: packageRoot, model: values.model, providerKind: values.provider,
      openclawProfile: values['openclaw-profile'],
      ...settings, preserveSessionHistory: true, disableMemoryFlush: true, phaseTimeoutMs: wallMs, logLevel: 'info',
      businessToolNames: ['read', 'write', 'edit'] });
    const created = await gateway.request('sessions.create', { key: `agent:main:rc-compaction-${randomUUID()}`, agentId: 'main' });
    if (!created.ok || !created.key) throw new Error('The actual Gateway did not create the isolated C session.');
    sessionKey = created.key;
    const sessions = gateway.runtime.agent.session;
    const storePath = sessions.resolveStorePath(gateway.config.session.store, { agentId: 'main' });
    const scope = { agentId: 'main', sessionKey, storePath, readConsistency: 'latest' };
    await sessions.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
    const initialEntry = await sessions.getSessionEntry(scope);
    const sessionId = initialEntry?.sessionId;
    if (!sessionId) throw new Error('Missing isolated native session ID.');
    result.sessionId = sessionId;

    async function turn(kind, message, extraSystemPrompt) {
      signal.throwIfAborted();
      runId = randomUUID();
      const started = Date.now(), remaining = deadlineAt - started;
      gateway.setPhase(kind);
      const response = await gateway.request('agent', { message, agentId: 'main', sessionId, sessionKey,
        idempotencyKey: runId, deliver: false, thinking: 'low', timeout: Math.max(1, Math.floor(remaining / 1000)),
        ...(extraSystemPrompt ? { extraSystemPrompt } : {}) }, { timeoutMs: remaining });
      if (response.runId !== runId || response.sessionKey !== sessionKey) throw new Error('Compaction turn identity mismatch.');
      const terminal = await waitSimplifyRunTerminal(gateway, runId, deadlineAt, signal);
      if (terminal?.status !== 'ok') throw new Error('Compaction turn did not complete.');
      await gateway.drain();
      const entry = await sessions.getSessionEntry(scope);
      if (entry?.sessionId !== sessionId) throw new Error('Compaction run left the original host session.');
      transcriptPath = sessions.resolveSessionFilePath(sessionId, entry, { agentId: 'main', sessionsDir: path.dirname(storePath) });
      const relative = path.relative(gateway.root, transcriptPath);
      if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new Error('Native session escaped the isolated profile.');
      records = await readJsonLines(transcriptPath);
      if (records[0]?.type !== 'session' || records[0].id !== sessionId) throw new Error('Compaction transcript session mismatch.');
      const compacted = records.find(record => record.type === 'compaction');
      firstCompactedAt ??= compacted ? Date.parse(compacted.timestamp) : null;
      result.turns.push({ kind, runId, startedAt: started, endedAt: Date.now(), promptSha256: sha(message), firstCompactedAt });
      runId = null;
    }

    await turn('requirements', instruction, firstTurnInstruction);
    const original = records.find(record => record.message?.role === 'user')?.message;
    if (comparableText(textOf(original)) !== comparableText(instruction)) throw new Error('Host did not retain the first requirements message.');
    result.hostOriginalSha256 = sha(textOf(original));
    await turn('scope', scopeMessage);
    for (let index = 0; index < 4 && firstCompactedAt == null; index++) await turn('await-compaction', continueMessage);
    if (!Number.isFinite(firstCompactedAt)) throw new Error('No real native compaction was recorded within the bounded turns.');
    const archive = await readJsonLines(userMessageLogPath(projectRoot, sessionId));
    if (!archive.some(record => comparableText(record.text) === comparableText(instruction))) throw new Error('The originals archive omitted the first requirements message.');
    if (values.arm !== 'calibration') {
      await turn('post-compaction', continueMessage);
      await turn('checkpoint', checkpoint);
      const checkpointIndex = records.findLastIndex(record => record.message?.role === 'user' && textOf(record.message).includes(checkpoint));
      const response = records.slice(checkpointIndex + 1).findLast(record => record.message?.role === 'assistant' && textOf(record.message).trim());
      answer = redactEvaluationText(textOf(response?.message));
      if (checkpointIndex < 0 || !answer.trim()) throw new Error('The fixed checkpoint answer is missing.');
    }
    result.state = 'completed';
  } catch (error) {
    result.state = signal.aborted || Date.now() >= deadlineAt ? 'timed-out' : 'failed';
    result.reason = redactEvaluationText(error.message);
  } finally {
    if (runId && gateway) await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
    if (gateway) await gateway.close();
  }
  const timing = gateway ? await readProviderTiming(gateway.root) : [];
  const profileStatus = gateway?.providerStatus?.();
  if ((result.state === 'failed' || values.provider === 'host-profile') && timing.some(row => row.event === 'response' && row.status === 429)
    || profileStatus?.failure === 'PROFILE_RATE_LIMIT') result.state = 'rate-limited';
  else if (profileStatus?.failure) { result.state = 'failed'; result.reason = profileStatus.failure; }
  const log = gateway ? await fs.readFile(path.join(gateway.root, 'host.log'), 'utf8').catch(() => '') : '';
  const injections = parseRestoreObservations(log);
  const compactionEvents = records.filter(record => record.type === 'compaction').map(record => Date.parse(record.timestamp));
  const usage = summarizeProviderUsage(timing.filter(row => row.event === 'request').length,
    records.filter(row => row.message?.role === 'assistant').map(row => row.message.usage));
  Object.assign(result, { elapsedMs: Date.now() - startedAt, completedInBudget: result.state === 'completed', usage,
    compaction: { firstCompactedAt: firstCompactedAt ?? null, compactionEvents, injections, answer: answer ?? null }, transcriptPath });
  if (result.elapsedMs > wallMs && result.state === 'completed') Object.assign(result, { state: 'timed-out', completedInBudget: false });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: result.state, arm: result.arm, firstCompactedAt: firstCompactedAt ?? null }));
  process.exit(result.state === 'completed' ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(redactEvaluationText(error.message)); process.exit(1); });
