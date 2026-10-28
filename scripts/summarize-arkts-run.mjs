// Offline accounting from native persisted sessions. No prompts, model calls,
// or extrapolated token estimates. Missing usage remains explicitly unknown.
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? '');
if (!process.argv.some(arg => arg.startsWith('--run='))) throw new Error('--run=<settled run directory> required');
const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
if (result.state !== 'SETTLED') throw new Error('Refuse to account for an active/incomplete run');
const nativeRoot = path.join(directory, 'native-host'), files = new Set([path.join(nativeRoot, `${result.sessionId}.jsonl`)]);
const taskRoot = path.join(result.projectRoot, '.runtime-correction', 'tasks');
async function visit(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.name === 'host-session.jsonl' || entry.name === 'session.jsonl') files.add(file);
    else if (/native.*run.*\.json$/u.test(entry.name)) {
      const value = await fs.readFile(file, 'utf8').then(JSON.parse, () => null);
      const rows = Array.isArray(value) ? value : Array.isArray(value?.runs) ? value.runs : value ? [value] : [];
      for (const row of rows) if (typeof row.sessionFile === 'string') files.add(path.resolve(row.sessionFile));
    }
  }
}
await visit(taskRoot);
await visit(path.join(result.projectRoot, '.runtime-correction', 'baseline-agent'));
// Native-run records are the authoritative index; include their session files
// even when the individual worker output directory is outside taskRoot.
const { listNativeRuns } = await import('../lib/openclaw/native-runs.mjs');
const runs = result.taskId ? await listNativeRuns(result.projectRoot, result.taskId) : [];
for (const run of runs) if (run.sessionFile) files.add(path.resolve(run.sessionFile));
const sessions = [];
let businessTerminal = null;
for (const file of files) {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) { sessions.push({ file, missing: true }); continue; }
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const stats = { file, owner: file === path.join(nativeRoot, `${result.sessionId}.jsonl`) ? 'business' : 'rc-private',
    assistantTurns: 0, usageRecords: 0, missingUsage: 0, tools: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  if (stats.owner === 'business') {
    const last = records.filter(row => row.message?.role === 'assistant').at(-1)?.message;
    businessTerminal = { stopReason: last?.stopReason ?? null,
      completionObserved: last?.stopReason === 'stop' && Array.isArray(last.content) && last.content.some(block => block.type === 'text' && block.text?.trim()) };
  }
  for (const record of records) {
    const message = record.message; if (message?.role !== 'assistant') continue;
    stats.assistantTurns++;
    for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'toolCall') stats.tools[block.name] = (stats.tools[block.name] ?? 0) + 1;
    if (!message.usage) { stats.missingUsage++; continue; }
    stats.usageRecords++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      if (typeof message.usage[key] === 'number') stats[key] += message.usage[key];
      else stats[`${key}Missing`] = (stats[`${key}Missing`] ?? 0) + 1;
    }
  }
  sessions.push(stats);
}
const totals = Object.fromEntries(['assistantTurns', 'usageRecords', 'missingUsage', 'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
  .map(key => [key, sessions.reduce((sum, row) => sum + (row[key] ?? 0), 0)]));
const report = { instanceId: result.instanceId, rcSource: result.rcSource, elapsedMs: result.elapsedMs,
  endReason: result.endReason, infrastructureComplete: result.infrastructureComplete, sessions, totals,
  reviewStatus: result.verification ?? null, businessTerminal,
  nativeRuns: runs.map(({ runId, sessionId, role, status, sessionFile }) => ({ runId, sessionId, role, status, sessionFile })),
  nativeModelStarts: result.metrics.modelStarts.length, providerRequests: result.metrics.providerRequests,
  note: 'Provider-reported usage; cached and uncached input remain separate. Missing usage is not zero. No dollar cost inferred from host pricing=0.' };
await fs.writeFile(path.join(directory, 'usage-summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ instanceId: report.instanceId, elapsedMs: report.elapsedMs, sessions: sessions.length, totals, missingSessions: sessions.filter(row => row.missing).length }));
