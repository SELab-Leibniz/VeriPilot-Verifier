import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedProcess } from '../scripts/bench/bounded-process.mjs';
test('an already cancelled benchmark cannot start a child', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runBoundedProcess('not-a-program', [], { signal: controller.signal });
  assert.equal(result.reason, 'cancelled-before-launch');
});
test('an exited tool cannot be held open by a descendant inherited output pipe', async () => {
  const program = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:['ignore',process.stdout,process.stderr]});process.exit(0);`;
  const result = await runBoundedProcess(process.execPath, ['-e', program], { timeoutMs: 3000, exitDrainMs: 25 });
  assert.equal(result.exitCode, 0);
  assert.ok(['closed', 'inherited-pipe-drain-limit'].includes(result.reason));
  if (result.reason === 'inherited-pipe-drain-limit') assert.equal(result.outputComplete, false);
});
test('the deadline resolves independently of child close notification', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 80 });
  assert.equal(result.reason, 'deadline'); assert.equal(result.interrupted, true); assert.equal(result.outputComplete, false);
});

test('an explicitly unbounded child exits naturally and remains cancellable by its owner', async () => {
  const natural = await runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},80)'], { timeoutMs: null });
  assert.equal(natural.exitCode, 0); assert.equal(natural.interrupted, false);
  const controller = new AbortController();
  const pending = runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: null, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.reason, 'cancelled'); assert.equal(cancelled.interrupted, true);
});
