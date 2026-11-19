import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStopRegressionCheck, regressionFailureInventory, STANDING_REGRESSION } from '../lib/runtime-v2/regression-evidence.mjs';
import { normalizeRegressionCheck } from '../lib/runtime-v2/stop-correction-config.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { applyCollateralReceipt, isolatedRegressionResult } from '../lib/runtime-v2/regression-triage.mjs';

const population = { metrics: { M16: [{ objectId: 'M16:standing', programStanding: STANDING_REGRESSION }] } };
const inventory = 'RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, executedTests: 2, failures: [] }) + '\n';
const write = (stream, value) => `await new Promise((resolve,reject)=>process.${stream}.write(${JSON.stringify(value)},error=>error?reject(error):resolve()));`;
const writeBytes = (stream, bytes) => `await new Promise((resolve,reject)=>process.${stream}.write(Buffer.from(${JSON.stringify([...bytes])}),error=>error?reject(error):resolve()));`;
const pause = 'await new Promise(resolve=>setTimeout(resolve,25));';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-receipt-streams-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await fs.writeFile(path.join(root, 'subject.mjs'), 'export const value = 1;\n');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Offline control',
    '-c', 'user.email=offline@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet', '--template='); git('add', 'subject.mjs'); git('commit', '--quiet', '-m', 'base');
  const run = (script, { reportProtocol = 'completed-suite-v1', flags = [], cacheDirectory = null, maxOutputBytes = 65536 } = {}) =>
    runStopRegressionCheck({ projectRoot: root, population, classification: { stopClassification: 'TASK_COMPLETE' }, cacheDirectory,
      config: normalizeRegressionCheck({ enabled: true, command: [process.execPath, '--input-type=module', '-e', script, '--', ...flags],
        timeoutMs: 10000, maxOutputBytes, ...(reportProtocol ? { reportProtocol } : {}) }) });
  return { root, run };
}

test('unittest-style stderr progress cannot prefix or split a complete stdout inventory', async t => {
  const f = await fixture(t), middle = Math.floor(inventory.length / 2);
  const run = await f.run(write('stderr', '.') + pause + write('stdout', inventory.slice(0, middle))
    + pause + write('stderr', '.s\n') + pause + write('stdout', inventory.slice(middle)));
  assert.equal(run.status, 'PASSED', run.outputTail);
  assert.equal(run.outputStreams.stdout.outputTail, inventory);
  assert.equal(run.outputStreams.stderr.outputTail, '..s\n');
  assert.equal(run.outputStreams.stdout.complete, true); assert.equal(run.outputStreams.stderr.complete, true);
  assert.equal(run.outputBytes, Buffer.byteLength(inventory + '..s\n'));
  assert.deepEqual(regressionFailureInventory(run), { complete: true, failures: [], excluded: [] });
});

test('a complete stderr inventory remains independent of stdout progress', async t => {
  const f = await fixture(t), run = await f.run(write('stdout', '.') + pause + write('stderr', inventory));
  assert.equal(run.status, 'PASSED', run.outputTail);
  assert.equal(run.outputStreams.stderr.outputTail, inventory);
  assert.equal(run.outputStreams.stdout.outputTail, '.');
});

test('UTF-8 bytes split across chunks stay owned by their original channel', async t => {
  const f = await fixture(t), failure = { id: 'café', title: 'preserves café' };
  const line = Buffer.from('RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, executedTests: 1, failures: [failure] }) + '\n');
  const middle = line.indexOf(Buffer.from('é')) + 1;
  const run = await f.run(writeBytes('stdout', line.subarray(0, middle)) + pause + write('stderr', '.')
    + pause + writeBytes('stdout', line.subarray(middle)) + 'process.exitCode=1;');
  assert.equal(run.status, 'FAILED', run.outputTail);
  assert.equal(run.outputStreams.stdout.utf8Valid, true);
  assert.equal(run.outputStreams.stdout.outputTail, line.toString('utf8'));
  assert.deepEqual(regressionFailureInventory(run).failures, [failure]);
});

test('UTF-8 bytes from separate channels cannot reconstruct a machine receipt', async t => {
  const f = await fixture(t), line = Buffer.from('RC_REGRESSION_INVENTORY ' + JSON.stringify({
    complete: true, executedTests: 1, failures: [{ id: 'café', title: 'preserves café' }] }) + '\n');
  const middle = line.indexOf(Buffer.from('é')) + 1;
  const run = await f.run(writeBytes('stdout', line.subarray(0, middle)) + pause + writeBytes('stderr', line.subarray(middle, middle + 1))
    + pause + writeBytes('stdout', line.subarray(middle + 1)) + 'process.exitCode=1;');
  assert.equal(run.status, 'UNAVAILABLE'); assert.equal(run.reason, 'REGRESSION_REPORT_UNVERIFIED');
  assert.equal(run.outputStreams.stdout.utf8Valid, false);
  assert.equal(run.outputStreams.stderr.utf8Valid, false);
});

test('a valid JSON line followed by an unfinished UTF-8 codepoint is unavailable', async t => {
  const f = await fixture(t), run = await f.run(write('stdout', inventory) + writeBytes('stdout', Buffer.from([0xc3])));
  assert.equal(run.status, 'UNAVAILABLE'); assert.equal(run.outputStreams.stdout.utf8Valid, false);
});

test('an untruncated stream cannot repair a leading continuation byte into a receipt', async t => {
  const f = await fixture(t), run = await f.run(writeBytes('stdout', Buffer.concat([Buffer.from([0x80]), Buffer.from(inventory)])));
  assert.equal(run.truncated, false); assert.equal(run.outputStreams.stdout.utf8Valid, false);
  assert.equal(run.status, 'UNAVAILABLE');
});

test('stream ownership never repairs ambiguous, prefixed or cross-channel partial inventories', async t => {
  const f = await fixture(t), middle = Math.floor(inventory.length / 2);
  for (const [name, script] of [
    ['independent duplicates', write('stdout', inventory) + pause + write('stderr', inventory)],
    ['same-stream duplicates', write('stdout', inventory + inventory)],
    ['same-stream prefix', write('stdout', '.' + inventory)],
    ['cross-channel JSON halves', write('stdout', inventory.slice(0, middle)) + pause + write('stderr', inventory.slice(middle))],
    ['cross-channel marker halves', write('stdout', 'RC_REGRESSION_') + pause + write('stderr', inventory.slice('RC_REGRESSION_'.length))],
    ['partial competing record', write('stdout', 'RC_REGRESSION_INVENTORY {') + pause + write('stderr', inventory)],
    ['unfinished JSON at EOF', write('stdout', inventory.slice(0, -3))],
  ]) await t.test(name, async () => {
    const run = await f.run(script);
    assert.equal(run.status, 'UNAVAILABLE', run.outputTail);
    assert.equal(run.reason, 'REGRESSION_REPORT_UNVERIFIED');
    assert.equal(regressionFailureInventory(run).complete, false);
  });
});

test('stdout receipts cannot override the original global byte limit', async t => {
  const f = await fixture(t), maxOutputBytes = 1024;
  const run = await f.run(write('stdout', inventory + 'x'.repeat(600)) + pause + write('stderr', '.'.repeat(700)), { maxOutputBytes });
  assert.equal(run.status, 'UNAVAILABLE'); assert.equal(run.truncated, true);
  assert(run.outputStreams.stdout.outputBytes < maxOutputBytes && run.outputStreams.stderr.outputBytes < maxOutputBytes);
  assert(run.outputBytes > maxOutputBytes);
  assert(Buffer.byteLength(run.outputTail) <= maxOutputBytes);
  assert(Object.values(run.outputStreams).reduce((sum, stream) => sum + Buffer.byteLength(stream.outputTail), 0) <= maxOutputBytes);
});

test('the legacy flat-TAP adapter retains its bounded-tail behavior within one original channel', async t => {
  const f = await fixture(t), failed = { id: 'preserves the public behavior', title: 'preserves the public behavior' };
  const run = await f.run(write('stdout', 'progress\n'.repeat(300) + 'not ok 1 - ' + failed.title + '\n# fail 1\n')
    + write('stderr', '.' ) + 'process.exitCode=1;', { reportProtocol: null, maxOutputBytes: 1024 });
  assert.equal(run.status, 'FAILED'); assert.equal(run.truncated, true);
  assert.deepEqual(regressionFailureInventory(run), { complete: true, failures: [failed], excluded: [] });
  assert(Object.values(run.outputStreams).reduce((sum, stream) => sum + Buffer.byteLength(stream.outputTail), 0) <= 1024);
});

test('bounded TAP tails allow only leading clipped UTF-8 fragments, never malformed failure IDs', async t => {
  const f = await fixture(t), suffix = Buffer.from('\nnot ok 1 - retained-case\n# fail 1\n');
  const clipped = Buffer.concat([Buffer.from('p'.repeat(1500)), Buffer.from([0xc3, 0xa9]),
    Buffer.from('x'.repeat(1024 - 1 - suffix.length)), suffix]);
  const healthy = await f.run(writeBytes('stdout', clipped) + 'process.exitCode=1;', { reportProtocol: null, maxOutputBytes: 1024 });
  assert.equal(healthy.truncated, true); assert.equal(healthy.outputStreams.stdout.utf8Valid, true);
  assert.deepEqual(regressionFailureInventory(healthy).failures, [{ id: 'retained-case', title: 'retained-case' }]);
  assert.equal(regressionFailureInventory(healthy).complete, true);
  const malformed = Buffer.concat([Buffer.from('p'.repeat(1500) + '\nnot ok 1 - case-'), Buffer.from([0xc3]), Buffer.from('\n# fail 1\n')]);
  const invalid = await f.run(writeBytes('stdout', malformed) + 'process.exitCode=1;', { reportProtocol: null, maxOutputBytes: 1024 });
  assert.equal(invalid.truncated, true); assert.equal(invalid.outputStreams.stdout.utf8Valid, false);
  assert.equal(regressionFailureInventory(invalid).complete, false);
});

test('legacy failure counts and names cannot be borrowed or competed across channels', async t => {
  const f = await fixture(t), report = 'not ok 1 - preserves the public behavior\n# fail 1\n';
  for (const [name, script] of [
    ['split names and count', write('stdout', 'not ok 1 - preserves the public behavior\n') + write('stderr', '# fail 1\n')],
    ['duplicate complete reports', write('stdout', report) + write('stderr', report)],
    ['partial competing report', write('stdout', report) + write('stderr', 'not ok 1 - competing behavior\n')],
  ]) await t.test(name, async () => {
    const run = await f.run(script + 'process.exitCode=1;', { reportProtocol: null });
    assert.equal(regressionFailureInventory(run).complete, false);
  });
});

test('pinned requirement probes use their own stream and reject independent duplicates or split receipts', async t => {
  const f = await fixture(t), hash = 'a'.repeat(64), id = 'PublicSuite.test_requirement';
  const probe = 'RC_REQUIREMENT_PROBE ' + JSON.stringify({ sha256: hash, status: 'PASS', checks: [{ id, status: 'PASS' }] }) + '\n';
  const flags = [`--requirement-probe-sha256=${hash}`, `--requirement-test=${id}`];
  const healthy = await f.run(write('stderr', '.') + pause + write('stdout', probe + inventory), { flags });
  assert.equal(healthy.status, 'PASSED'); assert.equal(healthy.requirementCheck.status, 'PASS');
  assert.equal(healthy.requirementCheck.sha256, hash);
  for (const [name, script] of [
    ['duplicates', write('stdout', probe + inventory) + pause + write('stderr', probe)],
    ['same-stream prefix', write('stdout', '.' + probe + inventory)],
    ['cross-channel halves', write('stdout', probe.slice(0, 40)) + pause + write('stderr', probe.slice(40)) + write('stdout', '\n' + inventory)],
  ]) await t.test(name, async () => {
    const run = await f.run(script, { flags });
    assert.equal(run.requirementCheck.status, 'INCOMPLETE');
    assert.match(run.requirementCheck.reason, /^REQUIREMENT_PROBE_RECEIPT_/u);
  });
});

test('native INCOMPLETE remains unavailable despite other-stream progress and rejects competing or partial records', async t => {
  const f = await fixture(t), incomplete = 'RC_REGRESSION_CHECK INCOMPLETE\n';
  const run = await f.run(write('stderr', '.') + pause + write('stdout', incomplete) + 'process.exitCode=2;', { reportProtocol: null });
  assert.equal(run.status, 'UNAVAILABLE'); assert.equal(run.reason, 'NATIVE_TEST_INCOMPLETE');
  for (const [name, script] of [
    ['duplicates', write('stdout', incomplete) + pause + write('stderr', incomplete)],
    ['cross-channel state halves', write('stdout', 'RC_REGRESSION_CHECK INCOM') + pause + write('stderr', 'PLETE\n')],
  ]) await t.test(name, async () => {
    const invalid = await f.run(script + 'process.exitCode=2;', { reportProtocol: null });
    assert.equal(invalid.status, 'UNAVAILABLE'); assert.equal(invalid.reason, 'REGRESSION_REPORT_UNVERIFIED');
  });
});

test('legacy diagnostic records retain their exact old interpretation without inventing stream authority', () => {
  const failure = { id: 'public-failure', title: 'preserves the public behavior' };
  const line = 'RC_REGRESSION_INVENTORY ' + JSON.stringify({ complete: true, executedTests: 1, failures: [failure] }) + '\n';
  const legacy = { status: 'FAILED', outputTail: line }, before = structuredClone(legacy);
  assert.deepEqual(regressionFailureInventory(legacy), { complete: true, failures: [failure] });
  assert.equal(regressionFailureInventory({ ...legacy, outputTail: '.' + line }).complete, false);
  assert.equal(regressionFailureInventory({ ...legacy, outputStreamPolicy: 'independent-stdout-stderr-v1' }).complete, false);
  assert.deepEqual(legacy, before);
});

test('partial or truncated channel metadata never falls back to a plausible combined receipt', async t => {
  const f = await fixture(t), run = await f.run(write('stdout', inventory));
  for (const change of [
    copy => { copy.outputStreams.stderr.complete = false; },
    copy => { copy.outputStreams.stderr.truncated = true; },
    copy => { copy.outputStreams.stderr.utf8Valid = false; },
    copy => { copy.outputStreams.stdout.outputBytes++; },
    copy => { delete copy.outputStreams; },
    copy => { delete copy.outputStreamPolicy; },
    copy => { copy.outputComplete = false; },
  ]) {
    const copy = structuredClone(run); change(copy);
    assert.equal(regressionFailureInventory(copy).complete, false);
  }
});

for (const stripPolicy of [false, true]) test(`a current cache record missing captures${stripPolicy ? ' and policy' : ''} requires a fresh run`, async t => {
  const f = await fixture(t), cacheDirectory = path.join(f.root, '.runtime-correction', 'cache');
  const counter = path.join(f.root, '.runtime-correction', 'calls.txt');
  await fs.mkdir(path.dirname(counter), { recursive: true });
  const script = `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(counter)},${JSON.stringify('called\n')});` + write('stdout', inventory);
  const first = await f.run(script, { cacheDirectory }), file = path.join(cacheDirectory, first.key + '.json');
  const damaged = JSON.parse(await fs.readFile(file, 'utf8')); delete damaged.outputStreams;
  if (stripPolicy) delete damaged.outputStreamPolicy;
  await fs.writeFile(file, JSON.stringify(damaged));
  const fresh = await f.run(script, { cacheDirectory });
  assert.equal(fresh.status, 'PASSED'); assert.equal(fresh.cached, undefined);
  assert.equal(await fs.readFile(counter, 'utf8'), 'called\ncalled\n');
  assert.equal(fresh.outputStreams.stdout.outputTail, inventory);
});

for (const protocol of ['CASE', 'COLLATERAL']) test(`${protocol} proof is owned by one original stream, not a combined diagnostic`, async t => {
  const f = await fixture(t), reviewed = { status: 'UNVERIFIED', cases: [
    { id: 'old', verdict: 'AUTHORIZED_CHANGE' }, { id: 'remaining', verdict: 'UNVERIFIED' }] };
  const request = { requestId: 'stream-request', baselineSha256: 'a'.repeat(64), exclusions: [{ id: 'old' }], probes: ['remaining'] };
  const proof = protocol === 'CASE' ? { id: 'isolated-case', complete: true, status: 'PASS', observed: ['isolated-case'] }
    : { requestId: request.requestId, baselineSha256: request.baselineSha256, taskStartSuite: true, complete: true,
      excludedIds: ['old'], expectedSurvivingCount: 1, observedSurvivingCount: 1, failures: [], probes: { remaining: 'PASS' } };
  const line = `RC_REGRESSION_${protocol} ${JSON.stringify(proof)}\n`, middle = Math.floor(line.length / 2);
  const accepted = run => protocol === 'CASE' ? isolatedRegressionResult(run, 'isolated-case') !== null
    : applyCollateralReceipt(reviewed, request, run) !== reviewed;
  const healthy = await f.run(write('stderr', '.') + pause + write('stdout', line), { reportProtocol: null });
  assert.equal(accepted(healthy), true);
  for (const [name, script, maxOutputBytes] of [
    ['cross-channel halves', write('stdout', line.slice(0, middle)) + pause + write('stderr', line.slice(middle))],
    ['independent duplicates', write('stdout', line) + pause + write('stderr', line)],
    ['same-stream prefix', write('stdout', '.' + line)],
    ['untruncated continuation prefix', writeBytes('stdout', Buffer.concat([Buffer.from([0x80]), Buffer.from(line)]))],
    ['competing partial receipt', write('stdout', line) + pause + write('stderr', `RC_REGRESSION_${protocol} {`)],
    ['aggregate truncation', write('stdout', line) + write('stderr', '.'.repeat(1100)), 1024],
  ]) await t.test(name, async () => {
    const run = await f.run(script, { reportProtocol: null, ...(maxOutputBytes ? { maxOutputBytes } : {}) });
    assert.equal(accepted(run), false);
  });
  for (const change of [copy => { copy.outputComplete = false; }, copy => { copy.outputStreams.stdout.complete = false; },
    copy => { copy.outputStreams.stderr.utf8Valid = false; }]) {
    const copy = structuredClone(healthy); change(copy); assert.equal(accepted(copy), false);
  }
});

for (const status of ['PASSED', 'UNAVAILABLE']) test(`the stream capture policy bypasses an old ${status} cache record without rewriting it`, async t => {
  const f = await fixture(t), cacheDirectory = path.join(f.root, '.runtime-correction', 'cache');
  const counter = path.join(f.root, '.runtime-correction', 'calls.txt');
  await fs.mkdir(path.dirname(counter), { recursive: true });
  const script = `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(counter)},${JSON.stringify('called\n')});` + write('stdout', inventory);
  const current = await f.run(script, { cacheDirectory });
  assert.equal(current.status, 'PASSED'); assert.equal(current.cached, undefined);
  const identity = Object.fromEntries(['triageVersion', 'outcomePolicy', 'command', 'cwd', 'timeoutMs', 'maxOutputBytes',
    'reportProtocol', 'verifierInputsSha256'].filter(key => Object.hasOwn(current, key)).map(key => [key, current[key]]));
  assert.equal(sha256({ ...identity, outputStreamPolicy: current.outputStreamPolicy, digest: current.workspaceDigest }), current.key);
  const key = sha256({ ...identity, digest: current.workspaceDigest });
  assert.notEqual(key, current.key);
  const legacy = { ...current, key, status }; delete legacy.outputStreamPolicy; delete legacy.outputStreams;
  if (status === 'UNAVAILABLE') legacy.reason = 'REGRESSION_REPORT_UNVERIFIED';
  const oldFile = path.join(cacheDirectory, key + '.json'), oldBytes = JSON.stringify(legacy) + '\n';
  await fs.writeFile(oldFile, oldBytes); await fs.unlink(path.join(cacheDirectory, current.key + '.json'));
  const fresh = await f.run(script, { cacheDirectory });
  assert.equal(fresh.status, 'PASSED'); assert.equal(fresh.cached, undefined); assert.equal(fresh.key, current.key);
  assert.equal(await fs.readFile(oldFile, 'utf8'), oldBytes);
  assert.equal(await fs.readFile(counter, 'utf8'), 'called\ncalled\n');
  assert.equal((await f.run(script, { cacheDirectory })).cached, true);
  assert.equal(await fs.readFile(counter, 'utf8'), 'called\ncalled\n');
});
