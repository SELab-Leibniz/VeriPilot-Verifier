import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectArktsInstrumentDevice, runArktsInstrumentDevice } from '../scripts/bench/arkts-instrument-device.mjs';

const bundleName = 'com.example.bench';
const testModuleName = 'entry_test';
const route = { hdc: path.resolve('mock-hdc'), server: '127.0.0.1:8710', target: '127.0.0.1:12487' };
const prefix = ['-p', '-s', route.server, '-t', route.target];
const devices = {
  'const.ohos.apiversion': '24', 'const.product.devicetype': 'phone',
  'const.product.software.version': 'HarmonyOS 6.1.0.126', 'bootevent.boot.completed': 'true',
};
const response = (stdout, exitCode = 0) => ({ stdout, execution: { exitCode, interrupted: false, outputComplete: true, reason: 'closed' } });

async function fixture(t, overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-instrument-device-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const haps = [path.join(temporary, 'entry.hap'), path.join(temporary, 'test.hap')];
  await Promise.all(haps.map(hap => fs.writeFile(hap, path.basename(hap))));
  const calls = [];
  const run = async (command, args, options) => {
    assert(options.timeout > 0);
    if (command === 'unzip') {
      const type = args[1].endsWith('0.hap') ? 'entry' : 'feature';
      const name = type === 'entry' ? 'entry' : testModuleName;
      return response(JSON.stringify({ app: { bundleName: overrides.hapBundle ?? bundleName }, module: { type, name } }));
    }
    assert.equal(command, route.hdc);
    assert.deepEqual(args.slice(0, 5), prefix);
    const sub = args.slice(5);
    calls.push(sub);
    if (sub[1] === 'param') return response(devices[sub[3]]);
    if (sub[1] === 'bm') return response(overrides.installed ?? 'ID: 100:\r\n\tcom.ohos.settings\r\n\tcom.huawei.hmos.launcher\r\n');
    if (sub[0] === 'install') {
      assert.deepEqual((await fs.readdir(sub[1])).sort(), ['0.hap', '1.hap']);
      return response(overrides.install ?? '[Info]App install path:/tmp/h msg:install bundle successfully.');
    }
    if (sub[1] === 'aa') {
      await overrides.test?.();
      return response('OHOS_REPORT_STATUS_CODE: 0\n', overrides.testExit);
    }
    if (sub[0] === 'uninstall') return response('uninstall bundle successfully.');
    throw new Error(`Unexpected action ${sub.join(' ')}`);
  };
  const inspectArgs = { ...route, deadline: Date.now() + 30_000 };
  return { calls, inspectArgs, args: { ...inspectArgs, bundleName, testModuleName, haps, compatibleDeviceTypes: ['phone'] },
    dependencies: { run, lockDirectory: temporary } };
}

test('qualifies a single booted API 24 device with exact HDC routing', async t => {
  const { calls, inspectArgs, dependencies } = await fixture(t);
  const device = await inspectArktsInstrumentDevice(inspectArgs, dependencies);
  assert.deepEqual(device, { server: route.server, target: route.target, api: 24, type: 'phone', image: 'HarmonyOS 6.1.0.126', bootReady: true });
  await assert.rejects(inspectArktsInstrumentDevice({ ...inspectArgs, server: '0.0.0.0:8710' }, dependencies), /explicit loopback/u);
  await assert.rejects(inspectArktsInstrumentDevice({ ...inspectArgs, target: 'localhost:12487' }, dependencies), /explicit loopback/u);
  assert.equal(calls.length, 4);
});

test('installs only after checking bundle absence and cleans up a test failure', async t => {
  const { calls, args, dependencies } = await fixture(t, { testExit: 1 });
  const expectedDevice = { server: route.server, target: route.target, api: 24, type: 'phone', image: 'HarmonyOS 6.1.0.126', bootReady: true };
  const result = await runArktsInstrumentDevice({ ...args, expectedDevice }, dependencies);
  assert.equal(result.output, 'OHOS_REPORT_STATUS_CODE: 0\n');
  assert.equal(result.execution.exitCode, 1);
  assert.equal(result.device.api, 24);
  assert.deepEqual(calls.slice(4).map(call => call.slice(0, 2)), [['shell', 'bm'], ['install', calls[5][1]], ['shell', 'aa'], ['uninstall', bundleName]]);
  assert.deepEqual(calls[6].slice(0, 10), ['shell', 'aa', 'test', '-b', bundleName, '-m', testModuleName, '-s', 'unittest', '/ets/testrunner/OpenHarmonyTestRunner']);
  await assert.rejects(fs.stat(calls[5][1]), { code: 'ENOENT' });
});

test('refuses to install when the locked target has a different image', async t => {
  const { calls, args, dependencies } = await fixture(t);
  const expectedDevice = { server: route.server, target: route.target, api: 24, type: 'phone', image: 'HarmonyOS 6.1.0.125', bootReady: true };
  await assert.rejects(runArktsInstrumentDevice({ ...args, expectedDevice }, dependencies), /device identity changed/u);
  assert(calls.length === 4 && calls.every(call => call[0] === 'shell' && call[1] === 'param'));
});

test('refuses mismatched HAPs, ambiguous bundle listings, existing bundles, and unconfirmed installations', async t => {
  for (const [overrides, error, expectedCalls] of [
    [{ hapBundle: 'com.other.bench' }, /bundle does not match/u, 0],
    [{ installed: 'error: service unavailable' }, /Unable to establish/u, 5],
    [{ installed: `ID: 100:\n\tcom.ohos.settings\nID: 101:\n\t${bundleName}\n` }, /already installed/u, 5],
    [{ install: 'AppMod finish' }, /did not confirm installation/u, 6],
  ]) {
    const { calls, args, dependencies } = await fixture(t, overrides);
    await assert.rejects(runArktsInstrumentDevice(args, dependencies), error);
    assert.equal(calls.length, expectedCalls);
    assert(!calls.some(call => call[0] === 'uninstall'));
  }
});

test('cleans a confirmed installation after the caller cancels', async t => {
  const abort = new AbortController();
  const cancelled = new Error('test cancelled');
  const { calls, args, dependencies } = await fixture(t, { test: async () => { abort.abort(cancelled); throw cancelled; } });
  await assert.rejects(runArktsInstrumentDevice({ ...args, signal: abort.signal }, dependencies), cancelled);
  assert.deepEqual(calls.at(-1), ['uninstall', bundleName]);
});

test('serializes concurrent deployment on the target through cleanup', async t => {
  let markFirstStarted, finishFirst;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstEnd = new Promise(resolve => { finishFirst = resolve; });
  const context = await fixture(t, { test: async () => { markFirstStarted(); await firstEnd; } });
  const first = runArktsInstrumentDevice(context.args, context.dependencies);
  await firstStarted;
  const second = runArktsInstrumentDevice(context.args, context.dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(context.calls.filter(call => call[0] === 'install').length, 1);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(context.calls.filter(call => ['install', 'uninstall'].includes(call[0])).map(call => call[0]),
    ['install', 'uninstall', 'install', 'uninstall']);
});
