// Actual launcher CLI with fake executables and local controller /start only.
// No Docker, installed Gateway, provider request or official grading is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), digest = value => createHash('sha256').update(value).digest('hex');
const launcher = fileURLToPath(new URL('../scripts/bench/run-harbor-gateway-pilot.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' ? 'Launcher process groups and executable fixtures require POSIX.' : false };
const imageId = `sha256:${'a'.repeat(64)}`;
const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-arm-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), taskPath = path.join(root, 'public-task'), callsPath = path.join(root, 'calls.jsonl');
  await fs.mkdir(bin); await fs.mkdir(taskPath); await fs.symlink(process.execPath, path.join(bin, 'node'));
  const pinned = path.join(taskPath, 'instruction.md'); await fs.writeFile(pinned, 'Fictional launcher fixture.\n');
  await fs.writeFile(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['image', 'inspect', 'fixture-image', '--format', '{{.Id}}']);
fs.appendFileSync(process.env.PILOT_TEST_CALLS, JSON.stringify({ kind: 'image' }) + '\\n');
console.log(process.env.PILOT_TEST_IMAGE_ID);
`, { mode: 0o700 });
  const harborExecutable = path.join(bin, 'harbor');
  await fs.writeFile(harborExecutable, `#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
(async () => {
  assert.equal(process.argv[2], 'run'); assert.equal(process.argv[3], '--config');
  const job = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  fs.appendFileSync(process.env.PILOT_TEST_CALLS, JSON.stringify({ kind: 'harbor', job }) + '\\n');
  if (process.env.PILOT_TEST_NO_START === '1') process.exit(7);
  const kwargs = job.agents[0].kwargs;
  const descriptor = JSON.parse(fs.readFileSync(kwargs.rc_controller_descriptor, 'utf8'));
  assert.equal(new URL(descriptor.startUrl).hostname, '127.0.0.1');
  const response = await fetch(descriptor.startUrl, { method: 'POST',
    headers: { authorization: 'Bearer ' + descriptor.controlToken },
    body: JSON.stringify({ phaseStartedAt: Date.now(), officialWallMs: kwargs.rc_official_wall_ms, rcEnabled: kwargs.rc_enabled }) });
  assert.equal(response.status, 200); await response.json();
  // Do not call the relay; this fixture proves selection/settlement only.
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
`, { mode: 0o700 });
  const guard = path.join(root, 'no-upstream.mjs');
  await fs.writeFile(guard, "globalThis.fetch = async () => { throw new Error('FIXTURE_UPSTREAM_FETCH_FORBIDDEN'); };\n");
  const manifest = { kind: 'rc-harbor-development-pilot-v1', qualificationAccepted: true,
    model: 'openai/glm-5.3', frameworkCommit: '58789aad577f432a4590209a8fd901f8c894f382', arms: ['off', 'on'],
    officialWallMs: 10000, armOuterWallMs: 20000, sourceRoot: root, taskPath, harborExecutable,
    sourceHashes: { [pinned]: digest(await fs.readFile(pinned)) }, priorRequests: 7, priorConservativeReferenceUsd: 0.25,
    image: { ref: 'fixture-image', id: imageId }, setupProxy: false,
    limits: { usd: 20, requests: 4, wallMs: 10000, inputPerRequest: 262144, outputPerRequest: 32768,
      totalInput: 1048576, totalOutput: 131072, payloadBytes: 131072, maxConcurrent: 1 },
    environment: { mounts: [{ type: 'bind', source: pinned, target: '/fixture-input', read_only: true }] },
    agentKwargs: { version: '2026.7.1-2' },
    armInstallCacheMounts: Object.fromEntries(['off', 'on'].map(arm => [arm,
      ['nvm', 'npm'].map(name => ({ type: 'volume', source: `fixture-${arm}-${name}`, target: `/root/.${name}` }))])) };
  let sequence = 0;
  const run = async ({ change = () => {}, output, observedImage = imageId, noStart = false } = {}) => {
    const value = structuredClone(manifest); change(value);
    const n = ++sequence, manifestPath = path.join(root, `manifest-${n}.json`);
    output ??= path.join(root, `output-${n}`);
    await fs.writeFile(manifestPath, JSON.stringify(value));
    const args = ['--import', guard, launcher, '--live', '--manifest', manifestPath, '--output', output];
    const env = { PATH: bin, RC_HARBOR_UPSTREAM_CREDENTIAL: 'fictional-launcher-credential',
      PILOT_TEST_CALLS: callsPath, PILOT_TEST_IMAGE_ID: observedImage, PILOT_TEST_NO_START: noStart ? '1' : '0' };
    try {
      const result = await execute(process.execPath, args, { env, timeout: 30000, maxBuffer: 1024 * 1024 });
      return { ...result, code: 0, output, manifestPath, manifest: value };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code, output, manifestPath, manifest: value };
    }
  };
  const calls = async () => await exists(callsPath)
    ? (await fs.readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, manifest, run, calls };
}

const offOnly = manifest => { manifest.arms = ['off']; manifest.diagnosticExecution = { kind: 'selected-arm-v1' }; };

async function assertClosedWithoutProvider(output, arm) {
  const control = path.join(output, arm, 'external-controller');
  assert.deepEqual((await fs.readdir(control)).sort(), ['descriptor.json', 'receipt.json']);
  const receipt = JSON.parse(await fs.readFile(path.join(control, 'receipt.json'), 'utf8'));
  assert.equal(receipt.controllerState, 'CLOSED'); assert.equal(receipt.rcEnabled, arm === 'on');
  assert.equal(receipt.wireDispatchAttempts, 0); assert.equal(receipt.upstreamInvocations, 0);
  assert.equal(receipt.budget.requests, 0); assert.equal(receipt.budget.inFlightRequests, 0);
  assert.equal(receipt.budget.halted, null);
}

test('unmarked paired launcher retains ordered arms, original jobs and zero retries', posix, async t => {
  const f = await fixture(t), run = await f.run(); assert.equal(run.code, 0, run.stderr);
  const calls = await f.calls(), jobs = calls.filter(call => call.kind === 'harbor').map(call => call.job);
  assert.deepEqual(jobs.map(job => job.job_name), ['rc-development-off', 'rc-development-on']);
  assert.equal(calls.filter(call => call.kind === 'image').length, 5);
  for (const [index, arm] of ['off', 'on'].entries()) {
    const job = jobs[index], agent = job.agents[0];
    assert.equal(job.n_attempts, 1); assert.equal(job.n_concurrent_trials, 1); assert.deepEqual(job.retry, { max_retries: 0 });
    assert.equal(agent.model_name, f.manifest.model); assert.equal(agent.kwargs.rc_enabled, arm === 'on');
    assert.equal(agent.kwargs.rc_official_wall_ms, f.manifest.officialWallMs);
    assert.deepEqual(job.environment.mounts, [...f.manifest.environment.mounts, ...f.manifest.armInstallCacheMounts[arm]]);
    await assertClosedWithoutProvider(run.output, arm);
  }
  const result = JSON.parse(await fs.readFile(path.join(run.output, 'result.json'), 'utf8'));
  assert.deepEqual(result.arms.map(value => value.arm), ['off', 'on']); assert.equal(result.totalWireAttempts, 0);
  assert.equal(result.benchmarkWinClaimed, false); assert.equal(result.overallGoalComplete, false);
});

test('marked diagnostic OFF-only launcher runs exactly OFF without implicit ON or retry', posix, async t => {
  const f = await fixture(t);
  const run = await f.run({ change: manifest => {
    offOnly(manifest); manifest.agentImportPath = 'scripts.bench.swebench_lite_gateway:SweBenchLiteGatewayOpenClaw';
    Object.assign(manifest.agentKwargs, { rc_instance_id: 'fixture__repo-1', rc_base_commit: 'b'.repeat(40),
      rc_problem_statement_sha256: 'c'.repeat(64), rc_conda_environment: 'testbed', rc_enabled: true });
  } });
  assert.equal(run.code, 0, run.stderr);
  const calls = await f.calls(), jobs = calls.filter(call => call.kind === 'harbor').map(call => call.job);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].job_name, 'rc-development-off');
  assert.equal(jobs[0].agents[0].kwargs.rc_enabled, false); assert.deepEqual(jobs[0].retry, { max_retries: 0 });
  assert.equal(jobs[0].n_attempts, 1); assert.deepEqual(jobs[0].verifier, { disable: true });
  assert.equal(calls.filter(call => call.kind === 'image').length, 3);
  assert.equal(await exists(path.join(run.output, 'on')), false); await assertClosedWithoutProvider(run.output, 'off');
  const result = JSON.parse(await fs.readFile(path.join(run.output, 'result.json'), 'utf8'));
  assert.deepEqual(result.arms.map(value => value.arm), ['off']); assert.equal(result.totalWireAttempts, 0);
  assert.equal(result.benchmarkWinClaimed, false); assert.equal(result.overallGoalComplete, false);
  assert.match(result.arms[0].officialScore, /separate unchanged official SWE-bench harness/);
  const launch = JSON.parse(await fs.readFile(path.join(run.output, 'launch.json'), 'utf8'));
  assert.equal(launch.manifestSha256, digest(await fs.readFile(run.manifestPath)));
  assert.deepEqual(JSON.parse(await fs.readFile(run.manifestPath, 'utf8')), run.manifest);
});

test('invalid diagnostic and unmarked arm shapes reject before any external effect', posix, async t => {
  const f = await fixture(t);
  const invalid = [
    { arms: ['off'] }, { arms: ['on'] }, { arms: ['on', 'off'] },
    ...[undefined, [], ['on'], ['off', 'on'], ['off', 'off'], ['other']].map(arms => ({ arms, diagnosticExecution: { kind: 'selected-arm-v1' } })),
    ...[null, {}, { kind: 'other' }, false].map(diagnosticExecution => ({ arms: ['off'], diagnosticExecution })),
    { arms: ['off', 'on'], diagnosticExecution: { kind: 'other' } },
  ];
  for (const value of invalid) {
    const run = await f.run({ change: manifest => Object.assign(manifest, value) });
    assert.equal(run.code, 1, JSON.stringify(value)); assert.match(run.stderr, /PILOT_FROZEN_MANIFEST_INVALID/);
    assert.equal(await exists(run.output), false);
  }
  assert.deepEqual(await f.calls(), []);
});

test('OFF-only preserves qualification, frozen input, image, both-cache and output guards', posix, async t => {
  const f = await fixture(t);
  const invalid = [
    [manifest => { manifest.qualificationAccepted = false; }, 'PILOT_FROZEN_MANIFEST_INVALID'],
    [manifest => { manifest.sourceHashes[Object.keys(manifest.sourceHashes)[0]] = '0'.repeat(64); }, 'PILOT_FROZEN_INPUT_CHANGED'],
    [manifest => { delete manifest.armInstallCacheMounts.on; }, 'PILOT_INDEPENDENT_INSTALL_CACHES_REQUIRED'],
    [manifest => { manifest.armInstallCacheMounts.on[0].source = manifest.armInstallCacheMounts.off[0].source; }, 'PILOT_INDEPENDENT_INSTALL_CACHES_REQUIRED'],
  ];
  for (const [change, code] of invalid) {
    const run = await f.run({ change: manifest => { offOnly(manifest); change(manifest); } });
    assert.equal(run.code, 1); assert.match(run.stderr, new RegExp(code)); assert.equal(await exists(run.output), false);
  }
  assert.deepEqual(await f.calls(), []);
  const wrongImage = await f.run({ change: offOnly, observedImage: `sha256:${'d'.repeat(64)}` });
  assert.equal(wrongImage.code, 1); assert.match(wrongImage.stderr, /PILOT_OFFICIAL_IMAGE_CHANGED/);
  assert.equal(await exists(wrongImage.output), false); assert.equal((await f.calls()).filter(call => call.kind === 'harbor').length, 0);
  const first = await f.run({ change: offOnly }); assert.equal(first.code, 0, first.stderr);
  const resultPath = path.join(first.output, 'result.json'), before = await fs.readFile(resultPath);
  const second = await f.run({ change: offOnly, output: first.output });
  assert.equal(second.code, 1); assert.match(second.stderr, /EEXIST/);
  assert.equal((await f.calls()).filter(call => call.kind === 'harbor').length, 1);
  assert.deepEqual(await fs.readFile(resultPath), before); assert.equal(await exists(path.join(first.output, 'on')), false);
});

test('paired launcher stops after an unstarted failed OFF without retry or implicit ON', posix, async t => {
  const f = await fixture(t), run = await f.run({ noStart: true }); assert.equal(run.code, 0, run.stderr);
  const jobs = (await f.calls()).filter(call => call.kind === 'harbor'); assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.job_name, 'rc-development-off'); assert.equal(await exists(path.join(run.output, 'on')), false);
  const result = JSON.parse(await fs.readFile(path.join(run.output, 'result.json'), 'utf8'));
  assert.deepEqual(result.arms.map(value => value.arm), ['off']); assert.equal(result.arms[0].execution.code, 7);
  assert.equal(result.arms[0].receipt.providerStarted, false); assert.equal(result.totalWireAttempts, 0);
  assert.equal(result.benchmarkWinClaimed, false); assert.equal(result.overallGoalComplete, false);
});

async function selectedOn(f, { offChange = () => {}, bankChange = () => {}, bindingChange = () => {} } = {}) {
  const instanceId = 'fixture__repo-1', conditionSha256 = 'd'.repeat(64);
  const sequence = f.selectedOnSequence = (f.selectedOnSequence ?? 0) + 1;
  const paths = Object.fromEntries(['rootBinding', 'bankFreeze', 'offAcceptance']
    .map(name => [name, path.join(f.root, `selected-${sequence}-${name}.json`)]));
  const pins = {};
  const save = async (file, value) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    await fs.writeFile(file, bytes, { flag: 'wx' }); pins[file] = digest(bytes); return pins[file];
  };
  const off = { instanceId, rootOfficialEligibility: 'VALID_OFF_UNRESOLVED' }; offChange(off);
  const offSha256 = await save(paths.offAcceptance, off);
  const bank = { kind: 'rc-stage-comparison-bank-v1', comparisonBindingsFrozen: true,
    members: [{ instanceId, effectiveBusinessConditionsSha256: conditionSha256,
      offOfficialAcceptanceSha256: offSha256 }] };
  bankChange(bank); const bankSha256 = await save(paths.bankFreeze, bank);
  const binding = { kind: 'rc-selected-on-binding-v1', onAuthorized: true, instanceId,
    bankFreezeSha256: bankSha256, effectiveBusinessConditionsSha256: conditionSha256,
    offOfficialAcceptancePath: paths.offAcceptance, offOfficialAcceptanceSha256: offSha256 };
  bindingChange(binding); await save(paths.rootBinding, binding);
  return { paths, apply(manifest) {
    manifest.arms = ['on']; manifest.instanceId = instanceId;
    manifest.diagnosticExecution = { kind: 'selected-on-v1', rootBindingPath: paths.rootBinding, bankFreezePath: paths.bankFreeze };
    manifest.agentImportPath = 'scripts.bench.swebench_lite_gateway:SweBenchLiteGatewayOpenClaw';
    Object.assign(manifest.agentKwargs, { rc_instance_id: instanceId, rc_base_commit: 'b'.repeat(40),
      rc_problem_statement_sha256: 'c'.repeat(64), rc_conda_environment: 'testbed', rc_enabled: false });
    Object.assign(manifest.sourceHashes, pins);
  } };
}

test('explicit selected ON runs one original job for either valid OFF eligibility', posix, async t => {
  for (const eligibility of ['VALID_OFF_UNRESOLVED', 'VALID_OFF_RESOLVED']) await t.test(eligibility, async t => {
    const f = await fixture(t), selected = await selectedOn(f, { offChange: off => { off.rootOfficialEligibility = eligibility; } });
    const run = await f.run({ change: selected.apply }); assert.equal(run.code, 0, run.stderr);
    const calls = await f.calls(), jobs = calls.filter(call => call.kind === 'harbor').map(call => call.job);
    assert.equal(jobs.length, 1); const job = jobs[0], agent = job.agents[0];
    assert.equal(job.job_name, 'rc-development-on'); assert.equal(job.n_attempts, 1); assert.equal(job.n_concurrent_trials, 1);
    assert.deepEqual(job.retry, { max_retries: 0 }); assert.equal(agent.model_name, f.manifest.model);
    assert.equal(agent.kwargs.rc_enabled, true); assert.equal(agent.kwargs.rc_instance_id, run.manifest.instanceId);
    assert.equal(agent.kwargs.rc_official_wall_ms, f.manifest.officialWallMs); assert.deepEqual(job.verifier, { disable: true });
    assert.deepEqual(job.environment.mounts, [...f.manifest.environment.mounts, ...f.manifest.armInstallCacheMounts.on]);
    assert.equal(calls.filter(call => call.kind === 'image').length, 3);
    assert.equal(await exists(path.join(run.output, 'off')), false); await assertClosedWithoutProvider(run.output, 'on');
    const result = JSON.parse(await fs.readFile(path.join(run.output, 'result.json'), 'utf8'));
    assert.deepEqual(result.arms.map(value => value.arm), ['on']); assert.equal(result.totalWireAttempts, 0);
    assert.equal(result.priorRequests, f.manifest.priorRequests);
    assert.equal(result.benchmarkWinClaimed, false); assert.equal(result.overallGoalComplete, false);
    assert.match(result.arms[0].officialScore, /separate unchanged official SWE-bench harness/);
    const launch = JSON.parse(await fs.readFile(path.join(run.output, 'launch.json'), 'utf8'));
    assert.equal(launch.manifestSha256, digest(await fs.readFile(run.manifestPath)));
    assert.deepEqual(JSON.parse(await fs.readFile(run.manifestPath, 'utf8')), run.manifest);
  });
});

test('selected ON marker accepts only the single ON arm shape', posix, async t => {
  const f = await fixture(t);
  for (const arms of [undefined, [], ['off'], ['off', 'on'], ['on', 'on'], ['other']]) {
    const run = await f.run({ change: manifest => { manifest.arms = arms; manifest.diagnosticExecution = { kind: 'selected-on-v1' }; } });
    assert.equal(run.code, 1, JSON.stringify(arms)); assert.match(run.stderr, /PILOT_FROZEN_MANIFEST_INVALID/);
    assert.equal(await exists(run.output), false);
  }
  assert.deepEqual(await f.calls(), []);
});

test('selected ON requires absolute guarded documents and rejects changed bytes before external effects', posix, async t => {
  const f = await fixture(t);
  const cases = [
    { name: 'missing binding path', change: manifest => { delete manifest.diagnosticExecution.rootBindingPath; } },
    { name: 'relative bank path', change: manifest => { manifest.diagnosticExecution.bankFreezePath = 'bank.json'; } },
    ...['rootBinding', 'bankFreeze', 'offAcceptance'].map(key => ({ name: `unpinned ${key}`,
      change: (manifest, selected) => { delete manifest.sourceHashes[selected.paths[key]]; } })),
    ...['rootBinding', 'bankFreeze', 'offAcceptance'].map(key => ({ name: `changed ${key}`, tamper: key })),
    { name: 'missing guarded OFF file', remove: 'offAcceptance' },
  ];
  for (const item of cases) {
    const selected = await selectedOn(f);
    if (item.tamper) await fs.appendFile(selected.paths[item.tamper], ' ');
    if (item.remove) await fs.rm(selected.paths[item.remove]);
    const run = await f.run({ change: manifest => { selected.apply(manifest); item.change?.(manifest, selected); } });
    assert.equal(run.code, 1, item.name);
    assert.match(run.stderr, item.remove ? /ENOENT/ : item.tamper ? /PILOT_FROZEN_INPUT_CHANGED/ : /PILOT_SELECTED_ON_BINDING_INVALID/);
    assert.equal(await exists(run.output), false, item.name);
  }
  assert.deepEqual(await f.calls(), []);
});

test('selected ON rejects a correctly pinned cross-instance OFF and same-instance preparation record', posix, async t => {
  const f = await fixture(t);
  const cases = [
    { name: 'all hashes correct but OFF belongs to another instance', offChange: off => { off.instanceId = 'fixture__repo-2'; } },
    { name: 'same instance preparation is not scored OFF', offChange: off => { delete off.rootOfficialEligibility; off.state = 'PREPARED_ONLY'; } },
  ];
  for (const item of cases) {
    const selected = await selectedOn(f, item), run = await f.run({ change: selected.apply });
    for (const file of Object.values(selected.paths))
      assert.equal(digest(await fs.readFile(file)), run.manifest.sourceHashes[file], item.name);
    assert.equal(run.code, 1, item.name); assert.match(run.stderr, /PILOT_SELECTED_ON_BINDING_INVALID/);
    assert.equal(await exists(run.output), false, item.name);
  }
  assert.deepEqual(await f.calls(), []);
});

test('selected ON rejects inconsistent bank declarations and identity or digest mismatches', posix, async t => {
  const f = await fixture(t);
  const cases = [
    { name: 'wrong binding kind', bindingChange: value => { value.kind = 'preparation'; } },
    { name: 'authorization is not true', bindingChange: value => { value.onAuthorized = false; } },
    { name: 'wrong bank kind', bankChange: value => { value.kind = 'stage-ids-only'; } },
    { name: 'freeze flag is a string', bankChange: value => { value.comparisonBindingsFrozen = 'true'; } },
    { name: 'empty bank', bankChange: value => { value.members = []; } },
    { name: 'empty member ID', bankChange: value => { value.members[0].instanceId = ' '; } },
    { name: 'duplicate current member', bankChange: value => { value.members.push({ ...value.members[0] }); } },
    { name: 'duplicate other member IDs', bankChange: value => { value.members.push(
      { ...value.members[0], instanceId: 'other' }, { ...value.members[0], instanceId: 'other' }); } },
    { name: 'current member absent', bankChange: value => { value.members[0].instanceId = 'fixture__repo-2'; } },
    { name: 'missing member condition hash', bankChange: value => { delete value.members[0].effectiveBusinessConditionsSha256; } },
    { name: 'missing member OFF hash', bankChange: value => { delete value.members[0].offOfficialAcceptanceSha256; } },
    { name: 'wrong manifest instance', change: value => { value.instanceId = 'fixture__repo-2'; } },
    { name: 'wrong adapter instance', change: value => { value.agentKwargs.rc_instance_id = 'fixture__repo-2'; } },
    { name: 'wrong binding instance', bindingChange: value => { value.instanceId = 'fixture__repo-2'; } },
    { name: 'wrong bank digest', bindingChange: value => { value.bankFreezeSha256 = '0'.repeat(64); } },
    { name: 'condition digest mismatch', bindingChange: value => { value.effectiveBusinessConditionsSha256 = '0'.repeat(64); } },
    { name: 'uppercase digests remain invalid even when equal',
      bankChange: value => { value.members[0].effectiveBusinessConditionsSha256 = 'A'.repeat(64); },
      bindingChange: value => { value.effectiveBusinessConditionsSha256 = 'A'.repeat(64); } },
    { name: 'both declared OFF digests mismatch the real pinned OFF bytes',
      bankChange: value => { value.members[0].offOfficialAcceptanceSha256 = '0'.repeat(64); },
      bindingChange: value => { value.offOfficialAcceptanceSha256 = '0'.repeat(64); } },
  ];
  for (const item of cases) {
    const selected = await selectedOn(f, item);
    const run = await f.run({ change: value => { selected.apply(value); item.change?.(value); } });
    assert.equal(run.code, 1, item.name); assert.match(run.stderr, /PILOT_SELECTED_ON_BINDING_INVALID/);
    assert.equal(await exists(run.output), false, item.name);
  }
  assert.deepEqual(await f.calls(), []);
});
