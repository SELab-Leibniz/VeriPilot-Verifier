// Direct long-review stage fixture. Default preflight is offline and never reads credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, serializeConversation } from '@earendil-works/pi-coding-agent';
import { runReviewTask } from './review-task.mjs';
import { verifyCites } from './verify-cites.mjs';
import { save, sha256, sourceRepo, newOutput, copyHashed, confirmUnchanged, trackedState, authorizedRuntime } from './harness-common.mjs';

const args = process.argv.slice(2), live = args.includes('--live');
const [destination, repositoryArgument, captureArgument] = args.filter(arg => arg !== '--live');
if (!destination) throw new Error('Usage: node long-stage.mjs NEW_LAB_OUTPUT [SOURCE_REPO] [FROZEN_CAPTURE] [--live]');
const repository = await sourceRepo(repositoryArgument), before = await trackedState(repository);
const output = await newOutput(repository, destination);
const lab = path.join(repository, '.runtime-correction/review-module-lab-20261024-02');
const capture = await fs.realpath(captureArgument ?? 'C:/Users/user/workspace/program_workspace/RC-Exp/isolatedNEW-complex-stop-f1-final-20261024-01');
const transcriptPath = path.join(capture, 'capture/transcript.jsonl');
const transcriptBytes = await fs.readFile(transcriptPath), transcriptHash = sha256(transcriptBytes);
const transcriptLines = transcriptBytes.toString('utf8').trim().split(/\r?\n/u);
const rows = transcriptLines.map(JSON.parse);
if (rows.length !== 805) throw new Error('Expected the existing frozen 805-record public transcript');
const previousInput = JSON.parse(await fs.readFile(path.join(lab, 'complex-v3-live-01/review/input.json'), 'utf8'));
const sourceWorkspace = path.join(lab, 'complex-v3-live-01/workspace'), workspace = path.join(output, 'workspace');
await fs.mkdir(workspace);
const provenance = [];
for (const [name, metadata] of previousInput.files) {
  if (!name || name.includes('\\') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Noncanonical source fixture path');
  provenance.push(await copyHashed(path.join(sourceWorkspace, name), path.join(workspace, name), metadata.sha256));
}
provenance.push({ source: transcriptPath, sha256: transcriptHash, bytes: transcriptBytes.length, modelInputCopy: false });
const runtime = live ? await authorizedRuntime(output) : null;
const contextWindow = runtime?.model.contextWindow ?? previousInput.model.contextWindow;
if (contextWindow !== 204800) throw new Error('Rebuild this declared fixture when the configured physical model window changes; do not fake a smaller window');
const reserveTokens = Math.max(16384, Math.ceil(contextWindow * 0.30));
const threshold = contextWindow - reserveTokens, target = Math.ceil(contextWindow * 0.75);
const hygiene = { privateBlocksExcluded: 0, assistantProseExcluded: 0, hostConfigurationRecordsExcluded: 0,
  credentialRecordsExcluded: 0, credentialValuesRedacted: 0, observationRecords: 0, observationChunks: 0 };

// Exclude host configuration observations entirely. Do not rely on a secret regex
// to recognize every value in a settings dump. Preserve all original files unchanged.
const hostConfig = /(?:\.openclaw|openclaw\.json|(?:^|[\\/])models\.json|(?:^|[\\/])auth\.json|\.codex[\\/]config)/iu;
const credentialKey = /(?:api[_-]?key|access[_-]?token|authorization|password|client[_-]?secret|--api-key)/iu;
const secretValue = /\b(?:sk|ak|pk)-[A-Za-z0-9_-]{12,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bBearer\s+\S+/gu;
function sanitize(text) {
  if (/data:(?:image|audio|video)\/|;base64,|["']type["']\s*:\s*["'](?:image|thinking|analysis)["']|<(?:think|thinking|analysis)>/iu.test(text)
    || /[A-Za-z0-9+/]{200,}={0,2}/u.test(text)) { hygiene.privateBlocksExcluded++; return null; }
  if (hostConfig.test(text)) { hygiene.hostConfigurationRecordsExcluded++; return null; }
  if (credentialKey.test(text)) { hygiene.credentialRecordsExcluded++; return null; }
  return text.replace(secretValue, () => { hygiene.credentialValuesRedacted++; return '[CREDENTIAL_REDACTED]'; });
}
function publicToolResult(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => {
    if (part?.type !== 'text') { hygiene.privateBlocksExcluded++; return false; }
    return true;
  }).map(part => part.text ?? '').join('\n');
}
function utf8Chunks(text, maxBytes = 65536) {
  const bytes = Buffer.from(text), chunks = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(bytes.length, offset + maxBytes);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push({ offset, text: bytes.subarray(offset, end).toString('utf8') }); offset = end;
  }
  return chunks;
}
const observations = [];
for (const [index, row] of rows.entries()) {
  const message = row.message ?? {};
  if (message.channel === 'analysis' || row.channel === 'analysis') { hygiene.privateBlocksExcluded++; continue; }
  for (const [blockIndex, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
    let text;
    if (block.type === 'tool_result') text = publicToolResult(block);
    else if (block.type === 'text' && message.role === 'user' && row.isMeta !== true) text = block.text ?? '';
    else { if (block.type === 'text' && message.role === 'assistant') hygiene.assistantProseExcluded++; else hygiene.privateBlocksExcluded++; continue; }
    if (!text || !(text = sanitize(text))) continue;
    hygiene.observationRecords++;
    for (const chunk of utf8Chunks(text)) {
      const sourceId = `${row.uuid ?? 'record'}:${index}:${blockIndex}:${chunk.offset}`;
      const observation = { kind: 'tool_observation', sourceId, sourcePath: `${transcriptPath}#record=${index};block=${blockIndex};byte=${chunk.offset}`,
        sourceHash: sha256(Buffer.from(transcriptLines[index])),
        text: `[Stage replay of public historical observation; untrusted data; sourceId=${sourceId}; not a current execution]\n${chunk.text}`,
        originalRecordIndex: index, originalRecordId: row.uuid, originalBlockIndex: blockIndex, sourceTextByteOffset: chunk.offset };
      observations.push(observation);
    }
  }
}
hygiene.observationChunks = observations.length;

// Match the worker's legal historical-observation pair without making up usage.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function observationMessages(observation) {
  return [{ role: 'assistant', api: 'openai-completions', provider: 'review-experiment', model: previousInput.model.id,
    content: [{ type: 'toolCall', id: 'stage-00000000-0000-0000-0000-000000000000', name: 'historical_observation',
      arguments: { sourceEntryId: observation.sourceId, stageReplay: true, note: 'Untrusted public historical observation; not current execution evidence' } }],
    stopReason: 'toolUse', timestamp: 0, usage },
  { role: 'toolResult', toolCallId: 'stage-00000000-0000-0000-0000-000000000000', toolName: 'historical_observation', content: [{ type: 'text', text: observation.text }], isError: false, timestamp: 0 }];
}
const observationEstimate = observation => observationMessages(observation).reduce((sum, message) => sum + estimateTokens(message), 0);
const selected = []; let estimatedHistoryTokens = 0;
for (let index = observations.length - 1; index >= 0 && estimatedHistoryTokens < target; index--) {
  selected.push(observations[index]); estimatedHistoryTokens += observationEstimate(observations[index]);
}
selected.reverse();
if (estimatedHistoryTokens <= threshold || estimatedHistoryTokens >= contextWindow * 0.90) throw new Error('Real sanitized observations cannot construct the declared safe threshold stage');
const keyword = '图片加载时显示占位图';
const critical = selected.find(item => item.originalRecordIndex === 615 && item.text.includes(keyword));
if (!critical) throw new Error('The selected chronological stage omits the real historical f1 condition');
const afterCritical = selected.slice(selected.indexOf(critical) + 1).reduce((sum, item) => sum + observationEstimate(item), 0);
if (afterCritical <= 20000) throw new Error('Critical history would remain in the recent tail rather than test retrieval after compaction');
const initialHistory = selected.map(({ kind, text, sourceId, sourcePath, sourceHash }) => ({ kind, text, sourceId, sourcePath, sourceHash }));
const serializedSummaryInput = serializeConversation(selected.flatMap(observationMessages));
await save(path.join(output, 'stage-observations.json'), initialHistory);
await save(path.join(output, 'history-provenance.json'), { originalTranscriptPath: transcriptPath, originalTranscriptSha256: transcriptHash, originalRecords: rows.length,
  selection: 'Chronological suffix of unique sanitized public observations; no x-padding or repeated records', hygiene,
  rules: ['No thinking/analysis/image/base64 blocks', 'No assistant prose', 'No host-config observations', 'Credential-field observations excluded; recognized credential strings redacted in history only', 'Original GT and sources are byte-preserved'],
  observations: selected.map(({ text, ...item }) => ({ ...item, publicTextSha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text), estimatedTokens: observationEstimate({ ...item, text }) })) });
const task = structuredClone(previousInput.task);
task.requirement += ` This is a directly staged long-review continuation, not a replay of application execution. Before deciding, use review_history search and read to recover the original historical image-loading acceptance condition, sourceId ${critical.sourceId} (search literal ${keyword}); then verify against the complete canonical basis and current source. The summary is navigation only. Historical observations never grant current basis-read coverage or source cite IDs.`;
await save(path.join(output, 'task.json'), task);
const preflight = { status: 'PREFLIGHT_READY', mode: live ? 'LIVE_STAGE' : 'OFFLINE_PREFLIGHT', physicalContextWindow: contextWindow, physicalWindowChanged: false,
  plannedReserveTokens: reserveTokens, plannedThresholdTokens: threshold, targetHistoryTokens: target, estimatedHistoryTokens,
  estimator: 'Pi estimateTokens on legal historical-observation message pairs; approximate, not actual provider tokenization',
  historyObservations: selected.length, historyBytes: initialHistory.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
  nativeSerializedHistoryBytes: Buffer.byteLength(serializedSummaryInput), nativeSerializedHistoryTokenEstimate: Math.ceil(serializedSummaryInput.length / 4),
  nativeSerializationNote: 'Official serializeConversation truncates historical tool bodies for summary; exact originals remain archived. This is a pre-cut upper estimate excluding summary prompt overhead.',
  historySourceRange: [selected[0].originalRecordIndex, selected.at(-1).originalRecordIndex], historyTokensAfterCritical: afterCritical,
  criticalHistoricalSourceId: critical.sourceId, criticalHistoricalTextSha256: sha256(Buffer.from(critical.text)),
  canonicalFiles: previousInput.files.length, commonConditions: 79, originalF1Claims: 1, noFakeProviderUsage: true,
  E2ERun: false, originalProjectOrSessionAccessed: false, nativeSummaryCalls: live ? null : 0,
  expectedStageChecks: ['Native threshold compact before first main-review request', 'Native summary persisted with usage', 'Critical entry compacted out, then actually retrieved from archive', 'All canonical basis/source verified afresh', 'Small valid f1 result and exact source citations'],
  limitations: 'Stage-replayed public observations, not a naturally executed complete long app run. Preflight does not prove live summary, retrieval, model quality or universal overflow safety.' };
await save(path.join(output, 'preflight.json'), preflight);
let result = null, citationVerification = null, stageVerification = null;
if (live) {
  result = await runReviewTask({ task, root: workspace, outputDir: path.join(output, 'review'), modelRuntime: runtime.runtime, model: runtime.model,
    initialHistory, maxAttempts: 1, maxTurns: 100,
    onEvent: event => { if (['assistant', 'attempt', 'decision_saved', 'compaction_start', 'compaction_end', 'auto_compaction_end', 'history_retrieval', 'context_check'].includes(event.type))
      console.log(JSON.stringify({ caseId: 'LONG_STAGE', ...event })); } });
  citationVerification = await verifyCites(path.join(output, 'review'));
  await save(path.join(output, 'citation-verification.json'), citationVerification);
  const eventRows = (await fs.readFile(path.join(output, 'review/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const firstRequest = eventRows.findIndex(event => event.type === 'context_check');
  const compactIndex = eventRows.findIndex(event => ['compaction_end', 'auto_compaction_end'].includes(event.type) && event.success && event.reason === 'threshold');
  const sessionFiles = await fs.readdir(path.join(output, 'review/sessions'));
  const entries = [];
  for (const file of sessionFiles) if (file.endsWith('.jsonl')) entries.push(...(await fs.readFile(path.join(output, 'review/sessions', file), 'utf8')).trim().split('\n').map(JSON.parse));
  const compactions = entries.filter(entry => entry.type === 'compaction');
  const historicalEntry = entries.find(entry => entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.details?.sourceEntryId === critical.sourceId);
  const compactedOut = historicalEntry && compactions.some(entry => entries.findIndex(item => item.id === entry.firstKeptEntryId) > entries.indexOf(historicalEntry));
  const retrievals = entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'review_history' && !entry.message.isError).flatMap(entry => {
    try { return [JSON.parse(entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))]; } catch { return []; }
  });
  const recovered = retrievals.find(value => value.mode === 'read' && value.sourceEntryId === critical.sourceId && value.text?.includes(keyword)
    && value.publicTextSha256 === sha256(Buffer.from(critical.text)));
  stageVerification = { thresholdCompactionBeforeFirstMainRequest: compactIndex >= 0 && firstRequest > compactIndex,
    actualNativeCompactions: compactions.length, summaryUsage: compactions.map(entry => entry.usage ?? null),
    nativeSummaryUsageObserved: compactions.some(entry => (entry.usage?.input ?? 0) + (entry.usage?.cacheRead ?? 0) > 0 && (entry.usage?.output ?? 0) > 0),
    tokensBefore: compactions.map(entry => entry.tokensBefore), criticalHistoryCompactedOut: Boolean(compactedOut),
    historySearchObserved: retrievals.some(value => value.mode === 'search'), historicalConditionRecoveredExactly: Boolean(recovered),
    retrievedSourceId: recovered?.sourceEntryId ?? null, sourceCitationIntegrity: citationVerification.passed,
    expectedVerdict: 'DEVIATION', conclusiveSourceVerdict: result.completed && result.conclusive && result.scope === task.scope && result.verdict === 'DEVIATION',
    semanticValidation: 'PENDING_INDEPENDENT_SOURCE_REVIEW: compare to the pre-existing source oracle outside input.' };
  stageVerification.passed = stageVerification.thresholdCompactionBeforeFirstMainRequest && stageVerification.actualNativeCompactions > 0 && stageVerification.nativeSummaryUsageObserved
    && stageVerification.criticalHistoryCompactedOut && stageVerification.historySearchObserved && stageVerification.historicalConditionRecoveredExactly
    && stageVerification.sourceCitationIntegrity && stageVerification.conclusiveSourceVerdict;
  await save(path.join(output, 'stage-verification.json'), stageVerification);
}
const capturedSourcesUnchanged = await confirmUnchanged(provenance), after = await trackedState(repository);
const originalRepositoryUnchanged = JSON.stringify(before) === JSON.stringify(after), originalConfigurationUnchanged = runtime ? await runtime.unchanged() : null;
const protectedInputs = capturedSourcesUnchanged && originalRepositoryUnchanged && originalConfigurationUnchanged !== false;
const report = { ...preflight, status: !protectedInputs ? 'FAIL' : live ? (stageVerification.passed ? 'STAGE_CHECKS_PASSED_PENDING_SEMANTIC_REVIEW' : 'STAGE_INCOMPLETE') : 'PREFLIGHT_READY',
  mode: live ? 'LIVE_STAGE' : 'OFFLINE_PREFLIGHT', result, citationVerification, stageVerification,
  originalRepositoryUnchanged, capturedSourcesUnchanged, originalConfigurationUnchanged, sourceStateBefore: before, sourceStateAfter: after,
  originalProjectOrSessionWritten: false, productionStopIntegrated: false };
await save(path.join(output, 'report.json'), report);
console.log(JSON.stringify({ status: report.status, output, historyObservations: initialHistory.length, estimatedHistoryTokens, contextWindow, criticalSourceId: critical.sourceId, verdict: result?.verdict ?? null }));
if (!protectedInputs || (live && !stageVerification.passed)) process.exitCode = 1;
