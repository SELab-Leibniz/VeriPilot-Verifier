import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { withFileLock } from './file-lock.mjs';

const exec = promisify(execFile);
const bundlePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const modulePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const lockRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();

function loopbackPort(address) {
  const port = Number(/^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(address)?.[1]);
  if (!Number.isInteger(port) || port > 65535) throw new Error('Instrument Test requires explicit loopback HDC server and target addresses');
  return port;
}

function devicePrefix({ hdc, server, target }) {
  if (typeof hdc !== 'string' || !path.isAbsolute(hdc)) throw new Error('Instrument Test requires an absolute HDC executable path');
  loopbackPort(server);
  loopbackPort(target);
  return ['-p', '-s', server, '-t', target];
}

function remaining(deadline, signal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(deadline)) throw new Error('Instrument Test requires a finite absolute deadline');
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error('Instrument Test deadline expired');
  return timeout;
}

async function execute(command, args, { timeout, signal }) {
  const started = Date.now();
  const result = (stdout, exitCode, interrupted, outputComplete, reason) => ({
    stdout, execution: { exitCode, interrupted, outputComplete, reason, durationMs: Date.now() - started },
  });
  try {
    const { stdout } = await exec(command, args, { timeout, signal, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      killSignal: 'SIGKILL', windowsHide: true });
    return result(stdout, 0, false, true, 'closed');
  } catch (error) {
    if (Number.isInteger(error.code)) return result(error.stdout, error.code, false, true, 'closed');
    const reason = signal?.aborted ? 'cancelled' : error.killed ? 'deadline' : error.code ?? 'process-error';
    return result(error.stdout ?? '', null, true, false, reason);
  }
}

const succeeded = result => result.execution.exitCode === 0 && result.execution.outputComplete && !result.execution.interrupted;

function guestCommand(route, run) {
  const prefix = devicePrefix(route);
  return (args, deadline, signal, limit) => run(route.hdc, [...prefix, ...args], {
    timeout: Math.min(limit, remaining(deadline, signal)), signal,
  });
}

export async function inspectArktsInstrumentDevice({ hdc, target, server, deadline, signal }, { run = execute } = {}) {
  const guest = guestCommand({ hdc, target, server }, run);
  const read = async name => {
    const result = await guest(['shell', 'param', 'get', name], deadline, signal, 8_000);
    return succeeded(result) ? result.stdout.trim() : '';
  };
  const [apiText, type, software, boot] = await Promise.all([
    read('const.ohos.apiversion'), read('const.product.devicetype'),
    read('const.product.software.version'), read('bootevent.boot.completed'),
  ]);
  const version = /\b\d+\.\d+\.\d+(?:\.\d+)?\b/u;
  const image = version.test(software) ? software : await read('const.ohos.fullname');
  if (!/^\d{1,3}$/u.test(apiText) || !/^[A-Za-z0-9_-]+$/u.test(type)
    || !version.test(image) || !['true', 'false'].includes(boot)) {
    throw new Error(`Unable to qualify Instrument Test device ${target}`);
  }
  return { target, server, api: Number(apiText), type, image, bootReady: boot === 'true' };
}

export function assertArktsInstrumentDeviceCompatibility(device, deviceTypes, { server, target }) {
  if (device?.server !== server || device?.target !== target || device.api !== 24 || !device.bootReady
    || !deviceTypes.includes(device.type)) {
    throw new Error(`Instrument Test requires a booted API 24 device at ${target} with one of these project device types: ${deviceTypes.join(', ')}`);
  }
}

async function stageHaps(haps, bundleName, testModuleName, staging, deadline, signal, run) {
  if (!Array.isArray(haps) || haps.length !== 2 || new Set(haps).size !== 2) {
    throw new Error('Instrument Test requires distinct app and test HAPs');
  }
  const modules = [];
  for (const [index, hap] of haps.entries()) {
    remaining(deadline, signal);
    if (typeof hap !== 'string' || !path.isAbsolute(hap) || path.extname(hap) !== '.hap' || !(await fs.lstat(hap)).isFile()) {
      throw new Error('Instrument Test HAP must be an absolute regular file');
    }
    const staged = path.join(staging, `${index}.hap`);
    await fs.copyFile(hap, staged);
    const result = await run('unzip', ['-p', staged, 'module.json'], {
      timeout: Math.min(8_000, remaining(deadline, signal)), signal,
    });
    if (!succeeded(result)) throw new Error('Unable to read Instrument Test HAP manifest');
    const { app, module } = JSON.parse(result.stdout);
    if (app?.bundleName !== bundleName) throw new Error('Instrument Test HAP bundle does not match the requested bundle');
    modules.push(module);
  }
  if (!modules.some(module => module?.name === 'entry' && module.type === 'entry')
    || !modules.some(module => module?.name === testModuleName && module.type === 'feature')) {
    throw new Error('Instrument Test HAP manifests must contain the entry and requested test module');
  }
}

function installedBundles(result) {
  const unavailable = 'Unable to establish installed bundles on the Instrument Test device';
  if (!succeeded(result)) throw new Error(unavailable);
  const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const names = new Set(), users = new Set();
  for (const line of lines) {
    const user = /^ID: (\d+):$/u.exec(line)?.[1];
    if (user !== undefined) {
      if (users.has(user)) throw new Error(unavailable);
      users.add(user);
    } else {
      if (users.size === 0 || !bundlePattern.test(line)) throw new Error(unavailable);
      names.add(line);
    }
  }
  if (names.size === 0) throw new Error(unavailable);
  return names;
}

export async function runArktsInstrumentDevice({ hdc, target, server, bundleName, testModuleName, haps,
  compatibleDeviceTypes, expectedDevice, deadline, signal }, { run = execute, lockDirectory = lockRoot } = {}) {
  const route = { hdc, target, server };
  const guest = guestCommand(route, run);
  if (!bundlePattern.test(bundleName ?? '') || !modulePattern.test(testModuleName ?? '')
    || !Array.isArray(compatibleDeviceTypes) || compatibleDeviceTypes.length === 0) {
    throw new Error('Instrument Test requires a valid bundle, test module, and compatible device types');
  }
  remaining(deadline, signal);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-instrument-haps-'));
  try {
    await stageHaps(haps, bundleName, testModuleName, staging, deadline, signal, run);
    const lock = path.join(lockDirectory, `rc-arkts-instrument-${loopbackPort(target)}.lock`);
    return await withFileLock(lock, async () => {
      const device = await inspectArktsInstrumentDevice({ ...route, deadline, signal }, { run });
      assertArktsInstrumentDeviceCompatibility(device, compatibleDeviceTypes, route);
      if (expectedDevice && !isDeepStrictEqual(device, expectedDevice)) {
        throw new Error(`Instrument Test device identity changed at ${target}`);
      }
      const available = remaining(deadline, signal);
      const workDeadline = deadline - Math.min(35_000, Math.floor(available / 4));
      const listed = await guest(['shell', 'bm', 'dump', '-a'], workDeadline, signal, 8_000);
      if (installedBundles(listed).has(bundleName)) throw new Error(`Instrument Test bundle ${bundleName} already installed on ${target}`);
      const install = await guest(['install', staging], workDeadline, signal, 60_000);
      if (!succeeded(install) || !/\binstall bundle successfully\b/iu.test(install.stdout)) {
        throw new Error(`Instrument Test did not confirm installation of ${bundleName} on ${target}`);
      }
      try {
        const timeout = Math.min(165_000, remaining(workDeadline, signal));
        const testTimeout = Math.min(150_000, Math.floor(timeout * 0.9));
        const result = await guest(['shell', 'aa', 'test', '-b', bundleName, '-m', testModuleName,
          '-s', 'unittest', '/ets/testrunner/OpenHarmonyTestRunner', '-s', 'timeout', String(testTimeout),
          '-s', 'coverage', 'false'], workDeadline, signal, timeout);
        return { output: result.stdout, execution: result.execution, device };
      } finally {
        const clean = await guest(['uninstall', bundleName], deadline, undefined, 35_000);
        if (!succeeded(clean) || !/\buninstall bundle successfully\b/iu.test(clean.stdout)) {
          throw new Error(`Instrument Test could not confirm cleanup of ${bundleName} on ${target}`);
        }
      }
    }, { timeoutMs: remaining(deadline, signal) });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
