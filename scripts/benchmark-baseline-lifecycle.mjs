import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireBaselineAgent } from '../lib/openclaw/baseline-agent.mjs';
import assert from 'node:assert/strict';

const source = execFileSync('git', ['show', 'c33bae6:lib/openclaw/baseline-agent.mjs'], { encoding: 'utf8' })
  .replace("'../runtime-v2/utils.mjs'", JSON.stringify(new URL('../lib/runtime-v2/utils.mjs', import.meta.url).href));
const before = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).acquireBaselineAgent;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-baseline-lifecycle-'));
const records = [];
try {
  for (const reason of ['cancelled', 'expired']) for (const [mode, acquire] of [['before', before], ['after', acquireBaselineAgent]]) {
    const owner = {}, disposed = [], controller = new AbortController(); controller.abort(new Error('cancelled'));
    const args = { owner, projectRoot: root, agentId: 'main', selection: { model: 'fixture' }, idleMs: 25,
      deadlineAt: Date.now() + 2000, dispose: async (...identity) => { disposed.push(identity); } };
    const first = await acquire(args); await first.release();
    await assert.rejects(acquire({ ...args, ...(reason === 'cancelled' ? { signal: controller.signal } : { deadlineAt: Date.now() - 1 }) }));
    await new Promise(resolve => setTimeout(resolve, 120));
    const idleReleased = disposed.some(identity => identity[1] === first.sessionId);
    assert.equal(idleReleased, mode === 'after');
    records.push({ mode, reason, idleMs: 25, observationMs: 120, idleReleased });
    // Clean up the intentionally reproduced baseline leak without any native model.
    if (!idleReleased) { const cleanup = await acquire(args); await cleanup.release(); await new Promise(resolve => setTimeout(resolve, 80)); }
  }
  const output = path.resolve('.runtime-correction/system-optimization/baseline-lifecycle-benchmark.json');
  await fs.writeFile(output, JSON.stringify({ baselineRef: 'c33bae6', records, scope: 'Actual pool disposal callback, no model or F2P claim.' }, null, 2));
  console.log(JSON.stringify(records));
} finally { await fs.rm(root, { recursive: true, force: true }); }
