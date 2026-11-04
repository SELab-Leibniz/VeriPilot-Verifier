#!/usr/bin/env node
// Semantic document correction across a real host compaction. The requirements
// exist only in the first user message; the host compacts the session before
// the document task is requested, so the business model works from its own
// summary (or nothing) while RC reviews the draft's semantic deviations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { collectAutomaticDocumentEvidence, documentMutations, locateDocumentFaults, openclawDocumentOptions, openclawProfileProvider } from './evaluate-openclaw-document-e2e.mjs';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const COMPACTION_KINDS = ['summary', 'truncate'];
export const REVIEW_MODES = ['original', 'ledger'];
// Rough per-requirement probes used only to describe what a summary or ledger retained.
const REQUIREMENT_PROBES = { 1: /CSV/iu, 2: /cents/iu, 3: /YYYY-MM-DD|ISO 8601/iu, 4: /offline|telemetry|network/iu,
  5: /--force/iu, 6: /ascending/iu, 7: /include-notes/iu, 8: /exit code/iu };

export function documentSections(text) {
  const lines = text.split('\n'), sections = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+(.+?)\s*$/u);
    if (heading) sections.push({ title: heading[1], startLine: index + 1 });
  });
  return sections.map((section, index) => {
    const endLine = index + 1 < sections.length ? sections[index + 1].startLine - 1 : lines.length;
    return { ...section, endLine, text: lines.slice(section.startLine - 1, endLine).join('\n') };
  });
}

const regex = source => new RegExp(source, 'iu');

function checkSection(sections, item) {
  const section = sections.find(entry => entry.title.toLowerCase() === item.section.toLowerCase());
  if (!section) return { satisfied: false, missingSection: true, failed: [] };
  const failed = [...item.mustMatch.filter(source => !regex(source).test(section.text)).map(source => `missing /${source}/`),
    ...item.mustNotMatch.filter(source => regex(source).test(section.text)).map(source => `still has /${source}/`)];
  return { satisfied: failed.length === 0, failed };
}

// Independent final judgement: every controlled deviation is gone from its
// section, and the compliant sections still state their requirement.
export function checkSemanticDocument(specification, text) {
  const sections = documentSections(text);
  const faults = specification.faults.map(fault => ({ id: fault.id, requirement: fault.requirement, ...checkSection(sections, fault) }));
  const keep = specification.keep.map(item => ({ requirement: item.requirement, section: item.section, ...checkSection(sections, item) }));
  return { satisfied: faults.every(item => item.satisfied) && keep.every(item => item.satisfied), faults, keep };
}

// A finding counts for a deviation when it points into that deviation's
// section of the reviewed text; anything else is an extra finding.
export function matchSemanticFindings(specification, reviewedText, diagnostics) {
  const sections = documentSections(reviewedText);
  const ranges = specification.faults.map(fault => ({ id: fault.id,
    section: sections.find(entry => entry.title.toLowerCase() === fault.section.toLowerCase()) }));
  const relevant = diagnostics.filter(item => item.path === 'design.md' && item.severity !== 'info');
  const owner = item => ranges.find(range => range.section && Number.isInteger(item.line)
    && item.line >= range.section.startLine && item.line <= range.section.endLine)?.id ?? null;
  const detected = [...new Set(relevant.map(owner).filter(Boolean))];
  return { detected, missed: specification.faults.map(fault => fault.id).filter(id => !detected.includes(id)),
    extra: relevant.filter(item => !owner(item)).map(item => ({ line: item.line ?? null, code: item.code ?? null,
      message: String(item.message ?? '').slice(0, 300) })) };
}

export async function loadSemanticDocumentCase(directory) {
  const specification = JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8'));
  assert.equal(specification.kind, 'semantic-conversation', 'Not a semantic conversation case');
  const requirementsMessage = await fs.readFile(path.join(directory, specification.requirementsMessage), 'utf8');
  const draft = await fs.readFile(path.join(directory, 'draft.md'), 'utf8');
  for (const fault of specification.faults) {
    assert(draft.split('\n')[fault.line - 1]?.includes(fault.draft), `Fault ${fault.id} is not at draft line ${fault.line}`);
    assert(documentSections(draft).find(section => section.title === fault.section && fault.line >= section.startLine
      && fault.line <= section.endLine), `Fault ${fault.id} is outside section ${fault.section}`);
  }
  const initial = checkSemanticDocument(specification, draft);
  assert(initial.faults.every(item => !item.satisfied) && initial.keep.every(item => item.satisfied),
    'The draft must violate every controlled deviation and keep every compliant section');
  return { specification, requirementsMessage, draft };
}

export const semanticDocumentPolicy = (model, options, mode, providerId) => `version: 2
locale: en
artifacts:
  - name: design
    stage: solution-design
    format: markdown
    patterns: [design.md]
    rules:
      enabled: false
    review:
      enabled: true
      criteria: document-review.md
dynamicGroundTruth:
  enabled: ${mode === 'ledger'}
  materialRoots: []
  panel:
    size: 0
skillCorrection:
  enabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: ${mode === 'ledger'}
  stageMetricsEnabled: false
${mode === 'original' ? '  originalRequirementsEnabled: true\n' : ''}limits:
  semanticReviewTimeoutMs: ${options.reviewTimeoutMs}
reviewers:
  defaults:
    model: ${providerId}/${model}
    effort: low
    timeoutMs: ${options.reviewTimeoutMs}
    maxOutputTokens: 16384
  groundTruthExtractor:
    effort: high
    timeoutMs: ${options.baselineTimeoutMs}
    maxOutputTokens: 32768
    formatRepairAttempts: ${options.baselineFormatRepairAttempts ?? 12}
output:
  persist: true
  mode: centralized
  directory: .runtime-correction
`;

export const SEMANTIC_REVIEW_CRITERIA = 'Check the CURRENT design.md against every requirement the user stated for this task. Report each concrete contradiction or missing required behaviour as an error with the accurate physical line number of the offending text, and quote the requirement it violates. Do not report wording, style or extra detail that does not contradict a requirement. Do not carry resolved findings into a new round. Return no findings when the document complies. Return edits: []; the main agent owns actual native edits. Do not edit files.\n';

// Only the summary style the user's MatrixAssistant profile configures is
// copied. The preserved window is minimal so the first turn really leaves the
// business context, as it would once later turns pushed it out.
export async function hostCompactionSettings(configPath) {
  const compaction = JSON.parse(await fs.readFile(configPath, 'utf8')).agents?.defaults?.compaction ?? {};
  const copied = Object.fromEntries(['mode', 'identifierPolicy', 'qualityGuard', 'customInstructions', 'maxHistoryShare', 'reserveTokensFloor', 'timeoutSeconds']
    .filter(key => compaction[key] !== undefined).map(key => [key, structuredClone(compaction[key])]));
  return { ...copied, keepRecentTokens: 1, recentTurnsPreserve: 0 };
}

async function findFiles(root, predicate, found = []) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await findFiles(file, predicate, found);
    else if (entry.isFile() && predicate(entry.name, file)) found.push(file);
  }
  return found;
}

function textOf(message) {
  const content = message?.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
}

// What the business model can still see: the first user turn is in context
// only when it lies at or after the latest compaction's first kept entry.
export function inspectNativeTranscript(text, marker) {
  const records = text.split(/\r?\n/u).flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
  const byId = new Map(records.filter(item => item.id).map(item => [item.id, item]));
  const chain = []; const seen = new Set();
  for (let cursor = records.findLast(item => item.id && item.type !== 'session'); cursor && !seen.has(cursor.id); cursor = byId.get(cursor.parentId)) {
    seen.add(cursor.id); chain.push(cursor);
  }
  chain.reverse();
  const userIndex = chain.findIndex(item => item.type === 'message' && item.message?.role === 'user' && textOf(item.message).includes(marker));
  const compaction = chain.findLast(item => item.type === 'compaction');
  const keptIndex = compaction ? chain.findIndex(item => item.id === compaction.firstKeptEntryId) : -1;
  const summary = typeof compaction?.summary === 'string' ? compaction.summary : null;
  return { records: records.length, activeChain: chain.length, requirementMessageInFile: userIndex >= 0,
    requirementMessageInBusinessContext: userIndex >= 0 && (!compaction || keptIndex >= 0 && userIndex >= keptIndex),
    compactionRecord: Boolean(compaction), summaryCharacters: summary?.length ?? null,
    summaryProbes: summary ? Object.fromEntries(Object.entries(REQUIREMENT_PROBES).map(([id, probe]) => [id, probe.test(summary)])) : null };
}

async function nativeTranscript(gateway, sessionId, marker) {
  const current = (await findFiles(gateway.root, name => name === `${sessionId}.jsonl`))[0];
  if (!current) return { file: null };
  return { file: path.relative(gateway.root, current), ...inspectNativeTranscript(await fs.readFile(current, 'utf8'), marker) };
}

// The original requirements mode's own record of user messages, kept outside
// the host transcript so a compaction cannot remove it.
async function userMessageLog(projectRoot, marker) {
  const directory = path.join(projectRoot, '.runtime-correction/original-requirements');
  return Promise.all((await fs.readdir(directory).catch(() => [])).map(async name => {
    const lines = (await fs.readFile(path.join(directory, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { file: name, messages: lines.length, requirementMessage: lines.some(line => String(line.text ?? '').includes(marker)) };
  }));
}

async function rcHookFailures(outputRoot) {
  const text = await fs.readFile(path.join(outputRoot, 'native-host/host.log'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(item => /^\[hooks\] .* from runtime-corrector failed/u.test(item.message ?? ''))
    .map(item => ({ time: item.time, level: item._meta?.logLevelName, message: String(item.message).slice(0, 300) }));
}

async function waitForTerminal(gateway, sessionKey, runId, deadlineAt, onTick = async () => {}) {
  let lastCheck = 0;
  while (Date.now() < deadlineAt) {
    await onTick();
    if (Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now();
      const terminal = await gateway.request('agent.wait', { runId, timeoutMs: 1 }, { timeoutMs: 5000 });
      if (['ok', 'error'].includes(terminal?.status)) return terminal;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  await gateway.request('chat.abort', { sessionKey, runId }).catch(() => {});
  throw Object.assign(new Error('Business run exceeded the configured total deadline'), { code: 'SEMANTIC_DOCUMENT_TIMEOUT' });
}

export async function runOpenClawSemanticDocumentE2E({ hostRoot, outputRoot, options = {}, openclawProfile, openclawModel, mode, compaction, caseDirectory }) {
  assert(REVIEW_MODES.includes(mode), `Mode must be one of ${REVIEW_MODES.join(', ')}`);
  assert(COMPACTION_KINDS.includes(compaction), `Compaction must be one of ${COMPACTION_KINDS.join(', ')}`);
  assert(openclawProfile, 'The semantic evaluation uses the installed OpenClaw profile model');
  const config = openclawDocumentOptions(options), started = Date.now(), deadlineAt = started + config.totalTimeoutMs;
  const benchmark = await loadSemanticDocumentCase(path.resolve(caseDirectory));
  const marker = 'Never convert amounts to floating point';
  assert(benchmark.requirementsMessage.includes(marker), 'The requirement message lost its identity marker');
  const profile = await openclawProfileProvider(path.resolve(openclawProfile), openclawModel);
  outputRoot = path.resolve(outputRoot);
  await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
  const projectRoot = path.join(outputRoot, 'project'); await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, '.runtime-corrector'));
  await fs.writeFile(path.join(projectRoot, 'draft.md'), benchmark.draft);
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Only design.md is editable.\n');
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/config.yaml'), semanticDocumentPolicy(profile.provider.model, config, mode, 'openai'));
  await fs.writeFile(path.join(projectRoot, '.runtime-corrector/document-review.md'), SEMANTIC_REVIEW_CRITERIA);
  const compactionSettings = compaction === 'summary' ? await hostCompactionSettings(path.resolve(openclawProfile)) : null;
  await fs.writeFile(path.join(outputRoot, 'options.json'), JSON.stringify({ ...config, mode, compaction, compactionSettings: compactionSettings
    && { ...compactionSettings, customInstructions: compactionSettings.customInstructions ? `${compactionSettings.customInstructions.length} characters copied from the profile` : undefined } }, null, 2));
  let gateway, sessionKey, sessionId, turn1, turn2, task, events = [], snapshot, privateRuns = [], failure, state = 'FAILED';
  let evidence = { reviews: [], receipts: [] }, compactionResponse = null, afterCompaction = null, beforeCompaction = null;
  let baseline = null, firstWrittenText = null, firstRound = null, finalCheck = null, reviewRequestSources = null, turn1Reply = null, turn1ToolCalls = 0;
  try {
    gateway = await createNativeGatewayEvaluation({ hostRoot, sourceRoot: SOURCE_ROOT, projectRoot, outputRoot,
      businessToolNames: ['read', 'write', 'edit'], businessToolDeny: ['runtime_corrector'], confineBusinessFiles: true,
      reviewerTimeoutMs: Math.max(config.reviewTimeoutMs, config.baselineTimeoutMs), hookTimeoutMs: config.hookTimeoutMs,
      businessTimeoutMs: config.businessTimeoutMs, disableMemoryFlush: true, compaction: compactionSettings,
      provider: profile.provider, providerGuard: { kind: 'host_profile_native_document', credential: profile.credential } });
    const load = name => import(pathToFileURL(path.join(gateway.pluginRoot, name)).href);
    const [store, runs, ledger] = await Promise.all([load('lib/runtime-v2/task-store.mjs'), load('lib/openclaw/native-runs.mjs'), load('lib/runtime-v2/ground-truth-ledger.mjs')]);
    const created = await gateway.request('sessions.create', { key: `agent:main:semantic-document-${randomUUID()}`, agentId: 'main', label: 'Semantic document correction across compaction' });
    assert(created.ok && created.key, 'The native Gateway did not create the session');
    sessionKey = created.key;
    const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
    await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
    sessionId = (await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' })).sessionId;
    const send = async (message, phase) => {
      gateway.setPhase(phase);
      const runId = randomUUID();
      const accepted = await gateway.request('chat.send', { sessionKey, sessionId, message, idempotencyKey: runId,
        deliver: false, thinking: 'low', timeoutMs: Math.min(config.businessTimeoutMs, deadlineAt - Date.now()) });
      assert(accepted.runId, `The Gateway did not accept the ${phase} request`);
      console.log(JSON.stringify({ state: `${phase}-started`, sessionId, runId: accepted.runId }));
      return accepted.runId;
    };

    const turn1RunId = await send(benchmark.requirementsMessage, 'business-requirements-turn');
    turn1 = await waitForTerminal(gateway, sessionKey, turn1RunId, deadlineAt);
    assert.equal(turn1.status, 'ok', 'The requirements turn did not finish normally');
    snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
    const turn1Messages = (snapshot.messages ?? []).map(item => item.message ?? item);
    turn1Reply = textOf(turn1Messages.findLast(item => item.role === 'assistant')).slice(0, 200);
    turn1ToolCalls = turn1Messages.flatMap(item => item.role === 'assistant' && Array.isArray(item.content) ? item.content : [])
      .filter(item => ['toolCall', 'tool_use'].includes(item.type)).length;
    beforeCompaction = await nativeTranscript(gateway, sessionId, marker);
    assert(beforeCompaction.requirementMessageInBusinessContext, 'The requirement message never reached the business session');

    gateway.setPhase(`host-compaction-${compaction}`);
    const compactionStarted = Date.now();
    compactionResponse = await gateway.request('sessions.compact', { key: sessionKey, ...(compaction === 'truncate' ? { maxLines: 2 } : {}) }, { timeoutMs: 600000 });
    compactionResponse = { ...compactionResponse, durationMs: Date.now() - compactionStarted };
    assert(compactionResponse.ok === true && compactionResponse.compacted === true, `The host did not compact the session: ${JSON.stringify(compactionResponse).slice(0, 400)}`);
    const latest = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
    assert.equal(latest.sessionId, sessionId, 'Compaction replaced the session identity; this evaluation does not cover rotation');
    afterCompaction = { ...await nativeTranscript(gateway, sessionId, marker), userMessageLog: await userMessageLog(projectRoot, marker) };
    assert(!afterCompaction.requirementMessageInBusinessContext, 'The requirement message is still in the business context after compaction');
    console.log(JSON.stringify({ state: 'compacted', compaction, afterCompaction }));

    const turn2RunId = await send(`Now prepare the design note in ${projectRoot}. A colleague's draft is in draft.md. Initialize design.md by reading ONLY draft.md and writing ALL of it unchanged into design.md with the write tool, including any mistakes. Then consume the automatic feedback and use native edits to repair design.md so that it satisfies every requirement I gave you earlier in this session. Keep the draft's structure and headings and change only what is needed. Continue until the latest automatic review passes with zero diagnostics, then stop tool calls and give a brief reply.`, 'automatic-document-hook');
    let previous = '';
    turn2 = await waitForTerminal(gateway, sessionKey, turn2RunId, deadlineAt, async () => {
      await gateway.drain();
      task = await store.findTask({ projectRoot, sessionId });
      snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
      evidence = await collectAutomaticDocumentEvidence(projectRoot, snapshot, sessionId);
      const progress = JSON.stringify({ baselineVersion: task?.groundTruth?.version ?? 0, reviews: evidence.reviews.map(item => `${item.result.status}:${item.result.diagnostics.length}`), modelStarts: gateway.metrics().modelStarts.length });
      if (progress !== previous) { console.log(progress); previous = progress; }
    });
    await gateway.drain();
    snapshot = await gateway.runtime.subagent.getSession({ sessionKey });
    evidence = await collectAutomaticDocumentEvidence(projectRoot, snapshot, sessionId);
    task = await store.findTask({ projectRoot, sessionId });
    const taskIds = [...new Set(evidence.reviews.map(item => item.scopeTaskId))];
    privateRuns = (await Promise.all(taskIds.map(id => runs.listNativeRuns(projectRoot, id)))).flat();
    await fs.writeFile(path.join(outputRoot, 'business-session.json'), JSON.stringify(snapshot, null, 2));
    const writes = documentMutations(snapshot, projectRoot);
    const firstWrite = writes.find(call => call.name.toLowerCase() === 'write');
    firstWrittenText = (firstWrite?.arguments ?? firstWrite?.input)?.content ?? null;
    assert.equal(typeof firstWrittenText, 'string', 'The business model never wrote design.md');
    locateDocumentFaults(benchmark.specification.faults, firstWrittenText);
    const reviews = evidence.reviews;
    assert(reviews.length >= 1, 'No automatic document review was recorded');
    assert.equal(reviews[0].result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(firstWrittenText), 'The first review did not inspect the initial write');
    firstRound = matchSemanticFindings(benchmark.specification, firstWrittenText, reviews[0].result.diagnostics);
    const requestFile = path.join(projectRoot, '.runtime-correction/.semantic-review', reviews[0].result.metadata.roundId, 'request.json');
    const request = JSON.parse(await fs.readFile(requestFile, 'utf8').catch(() => 'null'));
    reviewRequestSources = request?.originalRequirements ? request.originalRequirements.userMessages.map(item => ({ order: item.order,
      characters: item.characters, retainedAfterCompaction: item.retainedAfterCompaction === true,
      requirementMessage: String(item.text ?? item.preview ?? '').includes(marker) })) : null;
    if (mode === 'ledger') {
      const id = task?.taskId ?? reviews[0].scopeTaskId;
      const current = await ledger.loadCurrentGroundTruth(projectRoot, id);
      const claims = (current?.claims ?? []).filter(claim => claim.status === 'ACTIVE');
      const claimText = claims.map(claim => claim.text).join('\n');
      baseline = { version: current?.version ?? 0, claims: claims.length,
        probes: Object.fromEntries(Object.entries(REQUIREMENT_PROBES).map(([key, probe]) => [key, probe.test(claimText)])) };
      await fs.writeFile(path.join(outputRoot, 'dynamic-baseline.json'), JSON.stringify(current, null, 2));
    }
    const finalDesign = await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8');
    finalCheck = checkSemanticDocument(benchmark.specification, finalDesign);
    assert.equal(turn2.status, 'ok', 'The document turn did not finish normally');
    assert.equal(reviews.at(-1).result.status, 'passed', 'The final automatic document review did not pass');
    assert.equal(reviews.at(-1).result.diagnostics.length, 0, 'The final automatic review retained findings');
    assert.equal(reviews.at(-1).result.metadata.inputs.find(item => item.path === 'design.md')?.sha256, hash(finalDesign), 'The final review did not inspect the current document');
    if (mode === 'original') assert(!privateRuns.some(item => item.role === 'ground-truth-extractor'), 'Original requirements review must not run baseline extraction');
    assert(finalCheck.satisfied, `The final document still violates: ${[...finalCheck.faults, ...finalCheck.keep].filter(item => !item.satisfied).map(item => item.id ?? `R${item.requirement}`).join(', ')}`);
    state = 'PASSED';
  } catch (error) {
    let message = String(error.message);
    for (const [key, secret] of [...Object.entries(process.env), ['PROFILE_KEY', profile.credential()]])
      if (/KEY|TOKEN|SECRET|PASSWORD/iu.test(key) && secret?.length > 7) message = message.split(secret).join('[REDACTED]');
    failure = { code: error.code ?? 'OPENCLAW_SEMANTIC_DOCUMENT_E2E_FAILED', message };
  } finally {
    await gateway?.close();
  }
  if (task) {
    const file = path.join(projectRoot, '.runtime-correction/tasks', task.taskId, 'journal/events.jsonl');
    events = (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await fs.writeFile(path.join(outputRoot, 'automatic-hook-events.json'), JSON.stringify(events, null, 2));
  }
  const at = type => Date.parse(events.find(item => item.type === type)?.recordedAt ?? '');
  const firstFeedbackWaitMs = Number.isFinite(at('OPENCLAW_FEEDBACK_DELIVERED') - at('OPENCLAW_ARTIFACT_SNAPSHOT'))
    ? at('OPENCLAW_FEEDBACK_DELIVERED') - at('OPENCLAW_ARTIFACT_SNAPSHOT') : null;
  const report = { kind: 'openclaw-semantic-document-compaction-live-e2e', state, mode, compaction, projectRoot, firstFeedbackWaitMs,
    userMessageLog: await userMessageLog(projectRoot, marker), rcHookFailures: await rcHookFailures(outputRoot),
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, options: config,
    sessionKey, sessionId, taskId: task?.taskId ?? evidence.reviews[0]?.scopeTaskId ?? null, failure,
    providerProfile: { modelRef: profile.modelRef, api: profile.provider.api },
    gateway: gateway?.metrics(), turn1: turn1 ?? null, turn1Reply, turn1ToolCalls, turn2: turn2 ?? null,
    beforeCompaction, compactionResponse, afterCompaction, reviewRequestSources, baseline,
    reviews: evidence.reviews.map(item => ({ roundId: item.result.metadata.roundId, status: item.result.status,
      diagnostics: item.result.diagnostics.map(diagnostic => ({ line: diagnostic.line ?? null, severity: diagnostic.severity, code: diagnostic.code ?? null,
        message: String(diagnostic.message ?? '').slice(0, 400) })) })),
    firstRound, finalCheck, privateRuns, feedbackReceipts: evidence.receipts.length,
    finalDesign: await fs.readFile(path.join(projectRoot, 'design.md'), 'utf8').catch(() => null),
    limitations: ['Fictional single case; one run per mode and compaction kind.',
      'The preserved compaction window is minimal so the first turn leaves the business context; MatrixAssistant otherwise keeps about 20000 recent tokens and 3 turns.'] };
  report.sourceHashes = Object.fromEntries(await Promise.all(['scripts/evaluate-openclaw-semantic-document-e2e.mjs', 'scripts/helpers/native-gateway-evaluation.mjs',
    'lib/openclaw/runtime.mjs', 'lib/openclaw/reviewer.mjs', 'lib/openclaw/transcript.mjs', 'lib/semantic-review.mjs', 'lib/runtime-v2/orchestrator.mjs',
    'lib/runtime-v2/original-requirements.mjs', 'skills/semantic-review/SKILL.md'].map(async name => [name, hash(await fs.readFile(path.join(SOURCE_ROOT, name)))])));
  await fs.writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (!args.includes('--live') || !value('--host-root') || !value('--output-root') || !value('--openclaw-profile') || !value('--mode') || !value('--compaction') || !value('--case'))
    throw new Error('Use --live --host-root <installed-openclaw> --openclaw-profile <openclaw.json> [--openclaw-model <provider/model>] --mode original|ledger --compaction summary|truncate --case <directory> --output-root <fresh-directory> [--config <json>]');
  const options = value('--config') ? JSON.parse(await fs.readFile(value('--config'), 'utf8')) : {};
  const result = await runOpenClawSemanticDocumentE2E({ hostRoot: value('--host-root'), outputRoot: value('--output-root'), options,
    openclawProfile: value('--openclaw-profile'), openclawModel: value('--openclaw-model'), mode: value('--mode'), compaction: value('--compaction'), caseDirectory: value('--case') });
  console.log(JSON.stringify({ state: result.state, elapsedMs: result.elapsedMs, firstRound: result.firstRound, finalCheck: result.finalCheck?.satisfied ?? null,
    failure: result.failure, outputRoot: path.resolve(value('--output-root')) }));
  // The pinned host retains internal observers after awaited Gateway shutdown.
  process.exit(result.state === 'PASSED' ? 0 : 1);
}
