import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeStopFixture, deferred, within } from './support/openclaw-native-stop-fixture.mjs';

const { lifecycle } = createNativeStopFixture();

test('the native agent_end success receipt admits a drained tool-warning terminal without message stopReason', async t => {
  const terminal = deferred(t);
  let reviews = 0;
  const f = await lifecycle(t, { waitMode: 'until_pass', review: async () => { reviews++; return false; },
    postRunTerminal: async (_identity, runId) => { await terminal.promise;
      return { runId, status: 'error', error: '⚠️ 🛠️ Exec failed: earlier harmless probe (exit 1)' }; } });
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey, payload: { text: 'Delivered.' } }, f.ctx);
  await f.runtime.agentEnd({ runId: f.ctx.runId, sessionId: f.ctx.sessionId, success: true,
    messages: [{ role: 'assistant', content: 'Delivered.' }] }, f.ctx);
  terminal.resolve();
  await within(f.runtime.postRuns.drain(), 'warning Stop review');
  await within(f.runtime.waitForNativeReviews(), 'native review settlement');
  assert.equal(reviews, 1);
  assert.equal(f.post().reviewStatus, 'NO_DEVIATION_FOUND');
});
