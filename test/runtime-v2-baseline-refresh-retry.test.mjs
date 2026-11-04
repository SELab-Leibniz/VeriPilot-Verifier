import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sharedBasisFixture, user } from './helpers/runtime-v2-shared-basis-fixture.mjs';

test('failed baseline refresh is shared by actual pre/post hooks and later writes until source or model changes', async t => {
  const f = await sharedBasisFixture(t);
  await f.select();
  const original = await f.truth(), before = f.globals().length;
  const appendUser = async id => {
    await fs.appendFile(f.transcript, JSON.stringify(user(id)) + '\n');
    await f.invoke('UserPromptSubmit');
  };
  await appendUser('U2');
  f.state.overrideBaseline = () => { throw Object.assign(new Error('Controlled context overflow'), { code: 'REVIEWER_RUN_FAILED' }); };
  const write = (hook, id) => f.invoke(hook, { tool_name: 'Write', tool_use_id: id,
    tool_input: { file_path: `${f.root}/document-${id}.md`, content: 'Controlled business change.' } });
  await assert.rejects(write('PreToolUse', 'same-write'), { code: 'REVIEWER_RUN_FAILED' });
  await assert.rejects(write('PostToolUse', 'same-write'), { code: 'BASELINE_REFRESH_BACKOFF' });
  await assert.rejects(write('PreToolUse', 'another-write'), { code: 'BASELINE_REFRESH_BACKOFF' });
  assert.equal(f.globals().length, before + 1);
  assert.equal((await f.truth()).digest, original.digest, 'A cached failure cannot publish or consume the pending original');
  await appendUser('U3');
  await assert.rejects(write('PreToolUse', 'new-original'), { code: 'REVIEWER_RUN_FAILED' });
  assert.equal(f.globals().length, before + 2);
  const identity = f.factory.reviewCacheIdentity;
  f.factory.reviewCacheIdentity = reviewer => ({ previous: identity(reviewer), policyRevision: 'changed-model' });
  await assert.rejects(write('PreToolUse', 'new-model'), { code: 'REVIEWER_RUN_FAILED' });
  assert.equal(f.globals().length, before + 3);
  await assert.rejects(f.refresh(), { code: 'REVIEWER_RUN_FAILED' });
  assert.equal(f.globals().length, before + 4, 'Explicit refresh remains available during automatic backoff');
});
