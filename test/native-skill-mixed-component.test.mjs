import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordMixedSkillEvidence, runNativeMixedSkillComponent } from '../scripts/evaluate-native-skill-mixed.mjs';

async function fixture(t, exit = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-mixed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'conversation.jsonl');
  await fs.writeFile(transcript, '');
  await fs.writeFile(path.join(root, 'verify.mjs'), `console.log(JSON.stringify({check:'alpha',passed:${exit === 0}})); process.exit(${exit});\n`);
  await fs.writeFile(path.join(root, 'inspect.mjs'), "import fs from 'node:fs'; fs.writeFileSync('secondary-was-executed', 'unexpected');\n");
  return { projectRoot: root, transcript };
}

test('mixed process evidence is refused before local execution or transcript writes when watcher admission fails', async t => {
  const f = await fixture(t);
  await assert.rejects(recordMixedSkillEvidence({ ...f, assertWatcherActive: () => { throw new Error('not active'); } }), /not active/u);
  assert.equal(await fs.readFile(f.transcript, 'utf8'), '');
});

test('one real failed verifier retains matching IDs while the ordinary exit-zero result has no invocation', async t => {
  const f = await fixture(t); let checks = 0;
  const value = await recordMixedSkillEvidence({ ...f, assertWatcherActive: () => { checks++; } });
  assert(checks >= 2); assert.equal(value.primary.exitCode, 3); assert.equal(value.primary.actualLocalExecution, true);
  assert.match(value.primary.stdout, /"check":"alpha"/u);
  assert.equal(value.secondary.actualLocalExecution, false); assert.equal(value.secondary.matchedInvocation, false);
  const rows = (await fs.readFile(f.transcript, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert(rows.every(row => row.actor === 'controlled-component-driver'));
  assert.equal(rows[0].message.content[0].id, rows[1].message.content[0].tool_use_id);
  assert.equal(rows[1].message.content[0].is_error, true);
  const second = rows[2].message.content[0];
  assert.notEqual(second.tool_use_id, rows[0].message.content[0].id);
  assert.equal(second.content, 'Exit code 0\n{"check":"beta","passed":true}');
  assert(!/orphan|unpaired|UNVERIFIED|DEVIATION|expected|fixture/iu.test(second.content));
  await assert.rejects(fs.access(path.join(f.projectRoot, 'secondary-was-executed')), { code: 'ENOENT' });
  assert.equal(value.modelBusinessRun, false); assert.equal(value.nativeHostToolInvocationClaimed, false);
});

test('unexpected successful primary control cannot be relabeled a failure or receive an extra fixture result', async t => {
  const f = await fixture(t, 0);
  await assert.rejects(recordMixedSkillEvidence({ ...f, assertWatcherActive() {} }), /must actually exit 3/u);
  const rows = (await fs.readFile(f.transcript, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.match(rows[1].message.content[0].content, /Exit code 0/u);
  assert.equal(rows[1].message.content[0].is_error, false);
});

test('mixed driver rejects a triplet or fallback transport before opening a credential-bearing batch', async () => {
  await assert.rejects(runNativeMixedSkillComponent({ manifest: { kind: 'native-skill-triplet-v1', cases: [1, 2, 3] } }), /independent single case/u);
  await assert.rejects(runNativeMixedSkillComponent({ manifest: { kind: 'native-stop-pair-batch-v1', cases: [1] } }), /existing guarded Skill transport/u);
});
