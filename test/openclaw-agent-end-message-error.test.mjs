import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createNativeStopFixture, deferred, within } from './support/openclaw-native-stop-fixture.mjs';

const { lifecycle, findTask } = createNativeStopFixture();

// The pinned embedded harness derives event.success from aborted/promptError.
// An assistant error may instead be present only in its messages snapshot.
for (const stopReason of ['error', 'aborted']) test(`a latest assistant ${stopReason} fences a coarse-success attempt before slow capture`, async t => {
  const capture = deferred(t), entered = deferred(t), terminal = deferred(t);
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => {
    await terminal.promise;
    return { runId, status: 'ok' };
  } });
  await fs.appendFile(path.join(f.root, '.runtime-corrector/config.yaml'), '\nartifactCorrection:\n  originalRequirementsEnabled: true\n');
  const session = f.api.runtime.agent.session, getEntry = session.getSessionEntry;
  let blocked = true;
  session.getSessionEntry = async (...args) => {
    if (blocked) { blocked = false; entered.resolve(); await capture.promise; }
    return getEntry(...args);
  };
  f.api.pluginConfig.hookTimeoutMs = 1200;
  const ended = f.runtime.agentEnd({ success: true, messages: [
    { role: 'assistant', stopReason, content: [], errorMessage: 'Context overflow' },
    { role: 'toolResult', content: 'A trailing tool result is not a successful assistant completion.' },
  ] }, f.ctx);
  await within(entered.promise, 'attempt transcript capture');
  await within(ended, 'bounded failed-attempt hook');
  assert.equal(f.state.nativeInvalidated, false);
  assert.equal(f.state.nativeCompletion, null, 'coarse host success must not certify an assistant error');
  assert.equal(f.state.reviewController.signal.reason?.code, 'RC_NATIVE_ATTEMPT_ENDED');
  const oldController = f.state.reviewController;
  f.api.pluginConfig.hookTimeoutMs = 5000;
  await f.runtime.prompt({ prompt: 'Retry after automatic compaction.' }, f.ctx);
  assert.notEqual(f.state.reviewController, oldController);
  assert.equal(f.state.reviewController.signal.aborted, false);
  capture.resolve();
  await f.runtime.beforeTool({ toolName: 'write', toolCallId: 'retry-write', params: { path: 'draft.md' } }, f.ctx);
  await fs.writeFile(path.join(f.root, 'draft.md'), 'A draft delivered by the admitted retry.\n');
  await f.runtime.reply({ kind: 'final', runId: f.ctx.runId, sessionKey: f.ctx.sessionKey,
    payload: { text: 'Delivered after retry.' } }, f.ctx);
  terminal.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), 'retried Stop review');
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND');
  assert.equal(f.hostAbort.signal.aborted, false);
});

test('a historical assistant error does not fence a later successful completion', async t => {
  const terminal = deferred(t);
  const f = await lifecycle(t, { waitMode: 'until_pass', postRunTerminal: async (_identity, runId) => {
    await terminal.promise;
    return { runId, status: 'ok' };
  } });
  await f.runtime.agentEnd({ success: true, messages: [
    { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'An earlier attempt failed.' },
    { role: 'assistant', stopReason: 'stop', content: 'Delivered after retry.' },
  ] }, f.ctx);
  assert.equal(f.state.nativeInvalidated, false);
  assert.notEqual(f.state.reviewController.signal.reason?.code, 'RC_NATIVE_ATTEMPT_ENDED');
  assert.equal(f.state.nativeCompletion?.success, true);
  terminal.resolve();
  await within(f.runtime.waitForNativeReviews({ drain: true }), 'successful terminal review');
  const task = await findTask({ projectRoot: f.root, sessionId: 'host' });
  assert.equal(task.verification.status, 'NO_DEVIATION_FOUND');
});
