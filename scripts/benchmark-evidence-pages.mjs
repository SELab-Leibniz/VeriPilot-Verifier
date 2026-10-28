// Fixed cross-domain text fixtures; byte-identical program output is required.
// Old and new functions execute in this process so disk and model noise cannot
// masquerade as an algorithm gain. No test outcomes or gold solutions involved.
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sourcePage, textBlocks } from '../lib/review-task/source-tools.mjs';
const oldSource = execFileSync('git', ['show', 'c33bae6:lib/review-task/source-tools.mjs'], { encoding: 'utf8' });
const source = oldSource.slice(oldSource.indexOf('export function sourcePage'), oldSource.indexOf('export function createSourceTools'))
  .replace('export function sourcePage', 'function legacyPage');
// Execute only our fixed versioned function, with the same dependencies. This
// is not eval of external dataset or model text.
const legacyPage = new Function('PAGE_LINES', 'PAGE_BYTES', 'result', `${source}; return legacyPage;`)(400, 51200, (text, details) => ({ content: textBlocks(text), details }));
const cases = [
  ['arkts', Buffer.from(Array.from({ length: 2000 }, (_, i) => `export const field${i}: string = "配置与异常条件😀${i}";`).join('\n'))],
  ['python', Buffer.from(Array.from({ length: 2000 }, (_, i) => `def transform_${i}(value): return value if value is not None else "例外"`).join('\n'))],
  ['document', Buffer.from(Array.from({ length: 2000 }, (_, i) => `Requirement ${i}: 保留条件、例外与禁止项。`).join('\r\n') + '\n')],
];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const records = [];
for (const [name, bytes] of cases) {
  const args = { offset: 2, limit: 400 }, expected = legacyPage(bytes, args), actual = sourcePage(bytes, args);
  assert.deepEqual(actual, expected);
  const timings = { before: [], after: [] };
  for (let sample = 0; sample < 9; sample++) for (const arm of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
    const fn = arm === 'before' ? legacyPage : sourcePage, start = performance.now();
    for (let i = 0; i < 80; i++) fn(bytes, args);
    timings[arm].push(performance.now() - start);
  }
  records.push({ name, inputBytes: bytes.length, iterationsPerSample: 80, samplesPerArm: 9, sameOutput: true,
    beforeMedianMs: median(timings.before), afterMedianMs: median(timings.after), timings });
}
await fs.mkdir('.runtime-correction/system-optimization', { recursive: true });
await fs.writeFile('.runtime-correction/system-optimization/page-benchmark.json', JSON.stringify({ baseline: 'c33bae6', records,
  caveat: 'Pure text paging CPU comparison; identical source-page text and metadata; no token, I/O or F2P/P2P claim.' }, null, 2));
console.log(JSON.stringify(records.map(({ timings, ...row }) => row)));
