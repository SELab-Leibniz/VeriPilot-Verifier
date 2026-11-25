import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { arktsToolchainCommand } from './arkts-toolchain-runner.mjs';
import { runBoundedProcess } from './bounded-process.mjs';

function reportedHap(output, projectRoot, target) {
  const receipts = [...output.matchAll(/^\[RC_ARKTS_HAP\] (.+)$/gmu)];
  if (receipts.length !== 1) return null;
  let file;
  try { file = JSON.parse(receipts[0][1]); }
  catch { return null; }
  const directory = path.join(projectRoot, 'entry/build/default/outputs', target);
  return ['signed', 'unsigned'].some(kind => file === path.join(directory, `entry-${target}-${kind}.hap`)) ? file : null;
}

async function hapDigest(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && stat.size > 0 ? digest(await fs.readFile(file)) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function buildArktsInstrumentHaps({ projectRoot, toolRoot, javaHome, appBuildMode, deadline, signal, executor = runBoundedProcess }) {
  if (typeof executor !== 'function') throw new TypeError('ArkTS instrumentation build executor must be a function');
  if (!Number.isFinite(deadline)) throw new Error('An absolute ArkTS instrumentation build deadline is required');
  const root = await fs.realpath(projectRoot), started = Date.now();
  const commands = [['install', null], ['instrument-app', 'default'], ['instrument-test', 'ohosTest']]
    .map(([phase, target]) => ({ phase, target, tool: arktsToolchainCommand({ toolRoot, javaHome, projectRoot: root, phase, appBuildMode }) }));
  const phases = [], haps = [];
  let appDigest;
  let output = '';
  const result = (step, compileSucceeded = false) => ({
    haps: compileSucceeded ? haps : [],
    execution: { ...step, code: step.exitCode, timedOut: step.reason === 'deadline', compileSucceeded, appBuildMode,
      durationMs: Date.now() - started, phases },
    output,
  });
  for (const { phase, target, tool } of commands) {
    const timeoutMs = Math.ceil(deadline - Date.now());
    if (timeoutMs <= 0) return result({ exitCode: null, interrupted: true, outputComplete: false, reason: 'deadline' });
    let phaseOutput = '';
    const step = await executor(tool.command, tool.args, { cwd: root, env: tool.env, signal, processGroup: true,
      timeoutMs, onOutput(chunk) { phaseOutput += chunk; } });
    phases.push({ phase, ...step });
    output += phaseOutput;
    if (step.exitCode !== 0 || step.interrupted || !step.outputComplete) return result(step);
    if (target) {
      const hap = reportedHap(phaseOutput, root, target);
      if (!hap) return result({ ...step, exitCode: 1, reason: 'instrument-hap-receipt-missing' });
      const sha256 = await hapDigest(hap);
      if (!sha256) return result({ ...step, exitCode: 1, reason: 'instrument-hap-missing-after-build' });
      if (target === 'default') appDigest = sha256;
      haps.push(hap);
    }
  }
  // The test build can also compile the app. Keep the HAP built with the
  // requested app mode independent of the test build's fixed test mode.
  if (await hapDigest(haps[0]) !== appDigest)
    return result({ ...phases.at(-1), exitCode: 1, reason: 'instrument-app-hap-changed' });
  return result(phases.at(-1), true);
}
