import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { buildArktsInstrumentHaps } from './arkts-instrument-build.mjs';
import { assertArktsInstrumentDeviceCompatibility, inspectArktsInstrumentDevice, runArktsInstrumentDevice } from './arkts-instrument-device.mjs';
import { arktsInstrumentRuntime } from './arkts-instrument-results.mjs';
import { prepareArktsInstrumentWorkspace, verifyArktsInstrumentWorkspace } from './arkts-instrument-workspace.mjs';
import { copyArktsPublicTestSnapshot } from './arkts-public-test-snapshot.mjs';
import { captureArktsToolchainIdentity } from './arkts-toolchain-identity.mjs';

const loopbackAddress = value => {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value);
  return match && Number(match[1]) > 0 && Number(match[1]) <= 65535;
};

export async function loadArktsInstrumentConfig(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert(path.isAbsolute(value?.hdc ?? '') && loopbackAddress(value.server), 'Instrument config requires an absolute HDC path and loopback server');
  assert(value.cases && Object.keys(value.cases).length, 'Instrument config requires at least one benchmark case');
  const cases = Object.fromEntries(Object.entries(value.cases).sort(([a], [b]) => a.localeCompare(b)).map(([id, route]) => {
    assert(/^[a-z0-9_-]+$/u.test(id) && loopbackAddress(route?.target)
      && ['debug', 'test'].includes(route.appBuildMode), `Invalid Instrument Test route for ${id}`);
    return [id, { target: route.target, appBuildMode: route.appBuildMode }];
  }));
  return { hdc: await fs.realpath(value.hdc), server: value.server, cases };
}

export function arktsInstrumentRoute(config, caseId) {
  assert(Object.hasOwn(config.cases, caseId), `No Instrument Test route configured for ${caseId}`);
  return { hdc: config.hdc, server: config.server, ...config.cases[caseId] };
}

export async function captureArktsInstrumentIdentity({ config, toolRoot, javaHome, signal }) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Instrument Test qualification requires macOS arm64');
  const targets = [...new Set(Object.values(config.cases).map(route => route.target))].sort();
  const deadline = Date.now() + 30_000;
  const [build, devices, hdc] = await Promise.all([
    captureArktsToolchainIdentity({ toolRoot, javaHome, localTests: false }),
    Promise.all(targets.map(target => inspectArktsInstrumentDevice({ hdc: config.hdc, server: config.server, target, deadline, signal }))),
    fs.readFile(config.hdc).then(digest),
  ]);
  assert(devices.every(device => device.api === 24 && device.bootReady), 'Instrument Test requires booted API 24 emulator routes');
  const identity = { ...build, runtime: arktsInstrumentRuntime, devices, hdc, cases: config.cases };
  return { ...identity, sha256: digest(JSON.stringify(identity)) };
}

export async function runArktsInstrumentTests({ projectRoot, toolRoot, javaHome, json5Package, route, expectedDevice, scope, timeoutMs, signal }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Instrument Test requires a positive deadline');
  const startedAt = performance.now(), deadline = Date.now() + timeoutMs;
  const parent = await fs.mkdtemp(path.join(path.dirname(await fs.realpath(projectRoot)), 'rc-it-'));
  let outcome;
  try {
    const worktree = path.join(parent, 'source');
    const snapshotSha256 = await copyArktsPublicTestSnapshot(await fs.realpath(projectRoot), worktree, { signal });
    const parse = createRequire(json5Package)('json5').parse;
    const { bundleName, testModuleName, deviceTypes, runnerSha256, suiteSha256 } = await prepareArktsInstrumentWorkspace({ projectRoot: worktree, parse, scope });
    if (expectedDevice) assertArktsInstrumentDeviceCompatibility(expectedDevice, deviceTypes, route);
    const built = await buildArktsInstrumentHaps({ projectRoot: worktree, toolRoot, javaHome, appBuildMode: route.appBuildMode, deadline, signal });
    if (built.haps.length !== 2) {
      const { code, timedOut, reason } = built.execution;
      outcome = { execution: { exitCode: code, interrupted: Boolean(timedOut), outputComplete: false, reason,
        runtime: arktsInstrumentRuntime, compileSucceeded: false, snapshotSha256 }, output: built.output, raw: '', freshReport: false };
    } else {
      await verifyArktsInstrumentWorkspace({ projectRoot: worktree, suiteSha256, runnerSha256 });
      const result = await runArktsInstrumentDevice({ ...route, bundleName, testModuleName, haps: built.haps,
        compatibleDeviceTypes: deviceTypes, expectedDevice, deadline, signal });
      outcome = { execution: { ...result.execution, runtime: arktsInstrumentRuntime, compileSucceeded: true,
        device: result.device, snapshotSha256, runnerSha256, suiteSha256, appBuildMode: route.appBuildMode,
        deviceDurationMs: result.execution.durationMs },
      output: built.output, raw: result.output, freshReport: Boolean(result.execution.outputComplete && !result.execution.interrupted && result.output) };
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
  return { ...outcome, execution: { ...outcome.execution, durationMs: Math.round(performance.now() - startedAt) } };
}
