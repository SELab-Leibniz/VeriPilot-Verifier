// Reproducible local protocol/performance experiment. No repository snapshots,
// clones, host installation changes, or model calls in the default mode.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { covers, captureFiles } from '../lib/review-task/review-task.mjs';
import { pendingReadRanges } from '../lib/review-task/baseline-task.mjs';
import { createSourceTools, toolText } from '../lib/review-task/source-tools.mjs';
import { acquireBaselineAgent } from '../lib/openclaw/baseline-agent.mjs';

const directory = path.resolve('.runtime-correction/baseline-experiment');
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-baseline-benchmark-'));
const previousMissing = (requiredFiles, snapshot, reads) => requiredFiles.flatMap(file => {
  const lines = snapshot.get(file)?.lines;
  if (!lines) return [{ file, reason: 'missing snapshot' }];
  const ranges = []; let start = null;
  for (let line = 1; line <= lines; line++) {
    if (!covers(reads, file, line, line)) { start ??= line; }
    else if (start !== null) { ranges.push({ start, end: line - 1 }); start = null; }
  }
  if (start !== null) ranges.push({ start, end: lines });
  return ranges.length ? [{ file, ranges }] : [];
});
const measure = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
try {
  const files = ['a'], snapshot = new Map([['a', { lines: 50000 }]]);
  const reads = Array.from({ length: 125 }, (_, i) => ({ path: 'a', start: i * 400 + 1, end: i * 400 + 300 }));
  const before = measure(() => previousMissing(files, snapshot, reads));
  const after = measure(() => pendingReadRanges(files, snapshot, reads));
  if (JSON.stringify(before.value) !== JSON.stringify(after.value)) throw new Error('Recovery ranges changed');
  for (let i = 0; i < 240; i++) await fs.writeFile(path.join(root, `source-${String(i).padStart(4, '0')}.txt`), `required outcome ${i}\ncondition\n`);
  const tools = createSourceTools(root, await captureFiles(root));
  const find = tools.find(tool => tool.name === 'find'), navigation = [];
  let offset = 0, line = 1, pages = 0, navigationBytes = 0;
  do {
    const page = await find.execute('find', { pattern: 'source-', offset, line });
    navigationBytes += Buffer.byteLength(toolText(page));
    const parsed = JSON.parse(toolText(page)); navigation.push(...parsed.hits);
    offset = parsed.nextOffset; line = parsed.nextLine; pages++;
  } while (offset !== null);
  const grep = tools.find(tool => tool.name === 'grep'), args = { pattern: 'absent' };
  const start = performance.now(); await grep.execute('cold', args); const coldMs = performance.now() - start;
  const warmStart = performance.now(); await grep.execute('warm', args); const warmMs = performance.now() - warmStart;
  const owner = {}, sessions = [];
  for (let i = 0; i < 12; i++) {
    const session = await acquireBaselineAgent({ owner, projectRoot: root, agentId: 'main', selection: { model: 'fixture' }, deadlineAt: Date.now() + 10000 });
    sessions.push(session.sessionId); await session.release();
  }
  // Compare exact old/new launch prompt bytes with the same synthetic catalog.
  const identity = { requestId: 'request', taskId: 'task', baselineVersion: 3, sources: navigation.map(ref => ({ ref, kind: 'MATERIAL', sha256: 'a'.repeat(64), parts: [{ file: ref }] })), sourceCatalog: navigation.map(ref => ({ ref, kind: 'MATERIAL' })) };
  const common = { requiredFiles: navigation, instruction: 'Read complete originals; save then finish.', promptAppend: '' };
  const oldPromptBytes = Buffer.byteLength(JSON.stringify({ identity, ...common }));
  const newPromptBytes = Buffer.byteLength(JSON.stringify({ identity: { requestId: identity.requestId, taskId: identity.taskId, baselineVersion: identity.baselineVersion }, ...common,
    sourceLayout: 'source-NNNN-PPPP.txt is sourceCatalog[NNNN], part PPPP in byte order; request-* is the complete request and baseline-* is current Ground Truth.' }));
  const result = { kind: 'deterministic-protocol-experiment', generatedAt: new Date().toISOString(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    recovery: { lines: 50000, receipts: reads.length, sameGaps: true, beforeMs: before.ms, afterMs: after.ms },
    navigation: { expected: 240, uniqueFound: new Set(navigation).size, pages, bytes: navigationBytes, previousFirstPageLimit: 100 },
    repeatedSearch: { files: 240, coldMs, warmMs },
    sessions: { refreshes: 12, previousIdentityCount: 12, identityCount: new Set(sessions).size },
    launchPrompt: { sources: 240, oldPromptBytes, newPromptBytes, savedBytes: oldPromptBytes - newPromptBytes,
      caveat: 'Redundant launch metadata only. Complete original sources are still read. Bytes are not measured model tokens.' } };
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('rc-baseline-benchmark-')) throw new Error('Unexpected scratch path');
  await fs.rm(root, { recursive: true, force: true });
}
