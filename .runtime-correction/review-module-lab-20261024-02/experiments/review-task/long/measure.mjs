// Read-only measurement of saved review runs. No worker imports or model calls.
// node measure.mjs --out REPORT.json RUN_DIR...
// node measure.mjs --out REPORT.json --compare OLD_DIR NEW_DIR [--compare ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getSystemMessageText } from '@earendil-works/pi-ai';

const hash = value => createHash('sha256').update(value).digest('hex');
const size = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const exists = async file => fs.access(file).then(() => true, () => false);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const optionalJson = async file => await exists(file) ? json(file) : null;
const normalizeTool = name => typeof name === 'string' ? name.replace(/^source_/u, '') : '';
const sourceNames = new Set(['read', 'grep', 'find', 'ls']);
const text = content => typeof content === 'string' ? content : (content ?? []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
const timestamp = value => {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
};
const deltaTime = (start, end) => start !== null && end !== null ? end - start : null;
async function lines(file) {
  return (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid saved JSONL: ${file}:${i + 1}`); }
  });
}
async function artifact(file) {
  if (!(await exists(file))) return null;
  const bytes = await fs.readFile(file);
  return { file, bytes: bytes.length, sha256: hash(bytes) };
}
function fullyRead(reads, name, count) {
  if (!Number.isInteger(count) || count < 1) return null;
  let next = 1;
  for (const r of reads.filter(r => r.path === name).sort((a, b) => a.start - b.start)) {
    if (r.start > next) break;
    next = Math.max(next, r.end + 1);
  }
  return next > count;
}
function toolTotals(records) {
  const totals = {};
  for (const record of records) {
    const name = normalizeTool(record.name), item = totals[name] ??= { calls: 0, successfulCalls: 0, errorCalls: 0, textBytes: 0, successfulTextBytes: 0 };
    item.calls++;
    item[record.isError ? 'errorCalls' : 'successfulCalls']++;
    item.textBytes += record.bytes;
    if (!record.isError) item.successfulTextBytes += record.bytes;
  }
  return totals;
}

export async function measureCase(directory) {
  directory = await fs.realpath(directory);
  const input = await json(path.join(directory, 'input.json'));
  const result = await json(path.join(directory, 'result.json'));
  const task = input.task ?? {}, events = await lines(path.join(directory, 'events.jsonl'));
  const reads = await optionalJson(path.join(directory, 'reads.json')) ?? [];
  const sessionDirectory = path.join(directory, 'sessions');
  const sessionFiles = await exists(sessionDirectory) ? (await fs.readdir(sessionDirectory)).filter(name => name.endsWith('.jsonl')).sort() : [];
  const sessionEntries = (await Promise.all(sessionFiles.map(name => lines(path.join(sessionDirectory, name))))).flat();
  const messages = sessionEntries.filter(entry => entry.type === 'message' && entry.message).map(entry => entry.message);
  const sessionToolResults = messages.filter(message => message.role === 'toolResult');
  const saved = events.filter(event => event.type === 'decision_saved').at(-1);
  const saveAt = timestamp(saved?.at);
  const eventTools = events.filter(event => event.type === 'tool' && sourceNames.has(normalizeTool(event.name)));
  const nativeResults = sessionToolResults.filter(message => sourceNames.has(normalizeTool(message.toolName)));
  // Session toolResult.content is the actual model-visible return, including cite
  // wrappers and errors. Worker bytes may count only the unwrapped source body.
  const actualTools = nativeResults.map(message => ({ name: message.toolName, isError: Boolean(message.isError), bytes: size(text(message.content)) }));
  const loggedTools = eventTools.map(event => ({ name: event.name, isError: Boolean(event.isError), bytes: event.bytes ?? 0 }));
  const modelVisibleTools = toolTotals(actualTools.length ? actualTools : loggedTools);
  const sumTools = (values, field) => Object.values(values).reduce((sum, value) => sum + value[field], 0);
  const assistantEvents = events.filter(event => event.type === 'assistant');
  const usageEvents = assistantEvents.filter(event => event.usage);
  const sumUsage = key => usageEvents.reduce((sum, event) => sum + (event.usage[key] ?? 0), 0);
  const metadata = new Map(Array.isArray(input.files) ? input.files : []);
  const basisFiles = await Promise.all((task.basisFiles ?? []).map(async name => {
    const file = path.join(directory, 'frozen-source', name), fileArtifact = await artifact(file);
    const lineCount = metadata.get(name)?.lines ?? (fileArtifact ? (await fs.readFile(file, 'utf8')).split('\n').length : null);
    return { path: name, bytes: fileArtifact?.bytes ?? null, sha256: fileArtifact?.sha256 ?? metadata.get(name)?.sha256 ?? null, lines: lineCount, fullyDisclosed: fullyRead(reads, name, lineCount) };
  }));
  const targetFiles = await Promise.all((task.targetFiles ?? []).map(async name => {
    const value = await artifact(path.join(directory, 'frozen-source', name));
    return { path: name, bytes: value?.bytes ?? null, sha256: value?.sha256 ?? metadata.get(name)?.sha256 ?? null };
  }));
  const taskHash = hash(JSON.stringify(task));
  const basisHash = hash(JSON.stringify(basisFiles.map(({ path, sha256 }) => [path, sha256])));
  const targetHash = hash(JSON.stringify(targetFiles.map(({ path, sha256 }) => [path, sha256])));
  const leadingSystem = [];
  for (const message of messages) {
    if (message.role === 'user') break;
    if (message.role === 'system') leadingSystem.push(message);
  }
  const toolDeclarations = leadingSystem.flatMap(message => message.toolsAdded ?? []);
  const submitErrors = sessionToolResults.filter(message => message.toolName === 'submit_review' && message.isError);
  const decision = await optionalJson(path.join(directory, 'decision.json'));
  const evidenceArtifacts = await Promise.all(['evidence.json', 'citations.json', 'evidence-index.json', 'decision.json'].map(name => artifact(path.join(directory, name))));
  const lastRead = eventTools.filter(event => normalizeTool(event.name) === 'read' && !event.isError && (saveAt === null || timestamp(event.at) <= saveAt)).at(-1);
  const lastTool = eventTools.filter(event => !event.isError && (saveAt === null || timestamp(event.at) <= saveAt)).at(-1);
  const stat = async name => (await artifact(path.join(directory, name)))?.bytes ?? null;
  const verdict = result.verdict ?? 'UNVERIFIED';
  const conclusive = result.completed === true && result.conclusive === true && ['PASS', 'DEVIATION'].includes(verdict);
  return {
    directory,
    scope: {
      taskId: task.id ?? null, proofKind: task.scope ?? task.proofKind ?? task.proofType ?? task.evidenceKind ?? 'UNSPECIFIED',
      requirement: task.requirement ?? null, taskContractSha256: taskHash, basisSha256: basisHash, targetSha256: targetHash,
      inputFilesSha256: hash(JSON.stringify(input.files ?? null)), basisFiles, targetFiles,
      criteria: task.criteria ?? null, navigation: task.navigation ?? null,
      diffAvailable: typeof task.navigation?.diff === 'string' && task.navigation.diff.length > 0,
      trustedGitBaseClaimed: typeof task.navigation?.baseline === 'string' && task.navigation.baseline.length > 0,
    },
    outcome: {
      completed: result.completed ?? false, conclusive, verdict,
      category: conclusive ? `CONCLUSIVE_${verdict}` : result.completed ? 'SUBMITTED_UNVERIFIED' : 'INCOMPLETE_UNVERIFIED',
      correctnessEstablishedByMeasurement: false,
      warning: 'Saved and conclusive are transport/contract facts. Runtime UNVERIFIED is not a successful substantive review; a conclusive verdict is not automatically correct.',
    },
    counts: {
      reportedAssistantTurns: assistantEvents.length, providerTurns: assistantEvents.length,
      providerTurnDefinition: 'Observable worker assistant replies, not exact HTTP requests. Internal retries/summary calls without events are unknown.',
      usageBearingReplies: usageEvents.length, internalProviderAttempts: null, outerAttempts: result.attempts ?? null,
      sourceToolResults: actualTools.length || loggedTools.length, sourceToolErrors: actualTools.filter(tool => tool.isError).length,
      submitValidationErrors: sessionFiles.length ? submitErrors.length : null,
      submitValidationErrorSource: sessionFiles.length ? 'persisted native toolResult.isError' : 'not recorded',
    },
    tools: {
      byteDefinition: 'UTF-8 text content returned to the model, excluding JSON envelope/tool arguments/images. Includes cite wrapper if persisted in toolResult. All source tools, not read only.',
      modelVisibleSource: sessionFiles.length ? 'sessions/* toolResult.content' : 'worker events fallback; errors/extra wrappers may be missing',
      byName: modelVisibleTools,
      allEvidenceToolTextBytes: sumTools(modelVisibleTools, 'textBytes'),
      successfulEvidenceTextBytes: sumTools(modelVisibleTools, 'successfulTextBytes'),
      workerLoggedByName: toolTotals(loggedTools),
      workerLoggedTextBytes: loggedTools.reduce((n, tool) => n + tool.bytes, 0),
      nonSourceToolTextBytes: sessionToolResults.filter(message => !sourceNames.has(normalizeTool(message.toolName))).reduce((n, message) => n + size(text(message.content)), 0),
      repeatedReadLines: result.metrics?.repeatedLines ?? null,
      repetitionWarning: 'Repeated read lines exclude grep/read overlap and semantic repetition; zero does not imply no duplicate evidence.',
    },
    usage: {
      uncachedInputTokens: sumUsage('input'), cacheReadTokens: sumUsage('cacheRead'), cacheWriteTokens: sumUsage('cacheWrite'),
      cumulativeInputTokens: sumUsage('input') + sumUsage('cacheRead') + sumUsage('cacheWrite'), outputTokens: sumUsage('output'),
      peakReportedInputTokens: usageEvents.length ? Math.max(...usageEvents.map(event => (event.usage.input ?? 0) + (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0))) : null,
      scope: 'Main review assistant events only; not raw request bytes, not dollars, not simultaneous context. Unlogged compaction/provider retries are not included.',
      compactions: result.metrics?.compactions ?? null, compactionFailures: result.metrics?.compactionFailures ?? null,
    },
    timing: {
      workerElapsedMs: result.elapsedMs ?? null,
      workerElapsedDefinition: 'Worker-reported; initial fixture/snapshot preparation can be outside this interval.',
      lastReadToSavedMs: deltaTime(timestamp(lastRead?.at), saveAt),
      lastEvidenceToolToSavedMs: deltaTime(timestamp(lastTool?.at), saveAt),
      lastReadDefinition: 'Last observed successful read before save; not proof that this was the last semantically necessary evidence.',
    },
    prompts: {
      staticPromptFileBytes: await stat('prompt.txt'),
      initialSystemTextBytes: leadingSystem.reduce((n, message) => n + size(getSystemMessageText(message)), 0),
      initialSystemRecordSerializedBytes: size(leadingSystem),
      initialToolDeclarationSerializedBytes: size(toolDeclarations), initialToolDeclarationCount: toolDeclarations.length,
      initialUserTextBytes: messages.find(message => message.role === 'user') ? size(text(messages.find(message => message.role === 'user').content)) : null,
      requestWireBytes: null,
      warning: 'prompt.txt is system+task authored text. Session system records include SDK metadata/tool declarations. Serialized sizes are artifact sizes, not exact provider wire payload.',
    },
    artifacts: {
      feedbackBytes: await stat('feedback.txt'), decisionBytes: await stat('decision.json'),
      input: await artifact(path.join(directory, 'input.json')), events: await artifact(path.join(directory, 'events.jsonl')),
      evidence: evidenceArtifacts.filter(Boolean),
      savedCitationCount: decision ? (decision.citeIds ?? decision.refs ?? decision.cites ?? []).length : null,
    },
    limits: result.limits ?? { maxAttempts: input.maxAttempts, maxTurns: input.maxTurns, tokenBudget: input.tokenBudget, deadline: input.deadline },
  };
}

export function compareCases(before, after) {
  const fields = ['taskId', 'proofKind', 'requirement', 'taskContractSha256', 'basisSha256', 'targetSha256', 'inputFilesSha256', 'diffAvailable', 'trustedGitBaseClaimed'];
  const differences = fields.filter(key => JSON.stringify(before.scope[key]) !== JSON.stringify(after.scope[key])).map(field => ({ field, before: before.scope[field], after: after.scope[field] }));
  const sameOutcomeCategory = before.outcome.category === after.outcome.category;
  const difference = (group, key) => Number.isFinite(before[group][key]) && Number.isFinite(after[group][key]) ? after[group][key] - before[group][key] : null;
  return {
    before: before.directory, after: after.directory, literalScopeMatches: differences.length === 0, scopeDifferences: differences,
    sameOutcomeCategory, beforeOutcome: before.outcome.category, afterOutcome: after.outcome.category,
    directlyComparableAsEfficiencyImprovement: differences.length === 0 && sameOutcomeCategory && before.outcome.conclusive && after.outcome.conclusive,
    warning: 'Raw deltas are not completion-rate/quality improvements. Scope or verdict changes require separate semantic validation; UNVERIFIED is not counted as conclusive.',
    rawDeltasAfterMinusBefore: {
      assistantTurns: difference('counts', 'reportedAssistantTurns'), allEvidenceToolTextBytes: difference('tools', 'allEvidenceToolTextBytes'),
      cumulativeInputTokens: difference('usage', 'cumulativeInputTokens'), uncachedInputTokens: difference('usage', 'uncachedInputTokens'), outputTokens: difference('usage', 'outputTokens'),
      workerElapsedMs: difference('timing', 'workerElapsedMs'), lastReadToSavedMs: difference('timing', 'lastReadToSavedMs'),
      submitValidationErrors: difference('counts', 'submitValidationErrors'),
    },
  };
}

export async function verifyV1Code(lab) {
  const manifest = await json(path.join(lab, 'source-snapshot-01/manifest.json'));
  const files = await Promise.all(manifest.map(async item => {
    const name = path.basename(item.Path), current = path.join(lab, 'experiments/review-task', name);
    const actual = hash(await fs.readFile(current));
    return { name, sha256: actual, matchesFrozenManifest: actual === item.Hash.toLowerCase() };
  }));
  if (files.some(file => !file.matchesFrozenManifest)) throw new Error('The original v1 experiment source differs from its frozen manifest');
  return { frozenSource: 'source-snapshot-01/manifest.json', verifiedFiles: files.length, allUnchanged: true, files };
}

async function main() {
  const args = process.argv.slice(2), dirs = [], comparisons = [];
  let output = null;
  while (args.length) {
    const value = args.shift();
    if (value === '--out') output = args.shift();
    else if (value === '--compare') { const left = args.shift(), right = args.shift(); if (!left || !right) throw new Error('--compare needs two review directories'); comparisons.push([left, right]); dirs.push(left, right); }
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    else dirs.push(value);
  }
  if (!dirs.length) throw new Error('Usage: node measure.mjs [--out NEW_REPORT.json] RUN_DIR... [--compare OLD_DIR NEW_DIR]');
  const unique = [...new Set(await Promise.all(dirs.map(dir => fs.realpath(dir))))];
  const cases = await Promise.all(unique.map(measureCase));
  const byDirectory = new Map(cases.map(value => [value.directory, value]));
  const resolvedComparisons = await Promise.all(comparisons.map(async ([left, right]) => compareCases(byDirectory.get(await fs.realpath(left)), byDirectory.get(await fs.realpath(right)))));
  const lab = fileURLToPath(new URL('../../../', import.meta.url));
  const report = { schemaVersion: 'isolated-review-measurement.v1', generatedAt: new Date().toISOString(), sourceProtection: await verifyV1Code(lab), cases, comparisons: resolvedComparisons };
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (output) { await fs.writeFile(path.resolve(output), bytes, { flag: 'wx' }); process.stdout.write(JSON.stringify({ output: path.resolve(output), cases: cases.length, originalSourceUnchanged: true }) + '\n'); }
  else process.stdout.write(bytes);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
