// Compare the same dense artifact/feedback history through actual projections.
// Synthetic RC journal only; no repository clone or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const source = path.resolve(arg('--source') ?? '.');
const output = path.resolve(arg('--output') ?? '.runtime-correction/console-joins.json');
const { consoleFixture } = await import(pathToFileURL(path.join(source, 'test/support/console-fixture.mjs')));
const { readConsoleObservations } = await import(pathToFileURL(path.join(source, 'lib/openclaw/console-observations.mjs')));
const f = await consoleFixture({ count: 0 });
try {
  const events = [];
  for (let i = 0; i < 3000; i++) {
    const base = { recordedAt: new Date(1700000000000 + i).toISOString(), sessionId: 'demo', toolCallId: `call-${i}`, file: `report-${i}.md` };
    events.push({ ...base, eventId: `artifact-${i}`, type: 'OPENCLAW_ARTIFACT_REVIEW', result: { status: 'failed' } },
      { ...base, eventId: `delivery-${i}`, type: 'OPENCLAW_FEEDBACK_DELIVERED', feedback: `Repair original condition ${i}` });
  }
  await fs.appendFile(path.join(f.dir, 'journal/events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  const times = []; let digest;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    const data = await readConsoleObservations(f.record, f.task, { kind: 'artifact', search: 'report-2999.md', limit: 25 });
    times.push(performance.now() - start);
    assert.equal(data.total, 1); assert.equal(data.records[0].feedback.text, 'Repair original condition 2999');
    assert.equal(data.records[0].feedback.state, 'TOOL_RESULT');
    digest = createHash('sha256').update(JSON.stringify(data.records.map(r => ({ id: r.id, status: r.status, feedback: r.feedback })))).digest('hex');
  }
  times.sort((a, b) => a - b);
  const report = { kind: 'dense-artifact-feedback-join-benchmark', count: 3000, generatedEvents: 6000, source,
    samplesMs: times, medianMs: times[3], resultDigest: digest, resultVerified: true,
    limit: 'Generated artifact history; whole-history file I/O remains included. Neither token measurement nor live-host timing.' };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await f.cleanup(); }
