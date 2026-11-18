import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runArktsCheckedLint } from './arkts-checked-lint.mjs';
import { digest } from './arkts-dataset.mjs';
import { copyArktsPublicTestSnapshot } from './arkts-public-test-snapshot.mjs';
import { arktsToolchainCommand } from './arkts-toolchain-runner.mjs';
import { runBoundedProcess } from './bounded-process.mjs';

const requiredCommand = /^\s*(?:[-*]\s+)?After (?:a )?successful HAP build, run CodeLinter[^\r\n]*\bcodelinter\s+-c\s+\.\/code-linter\.json5\s+\.\s+--fix\b/imu;

async function readRegular(file) {
  try {
    return (await fs.lstat(file)).isFile() ? await fs.readFile(file) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readArktsLintRequirement(projectRoot) {
  const instructions = await readRegular(path.join(projectRoot, 'AGENTS.md'));
  if (!instructions || !requiredCommand.test(instructions.toString('utf8'))) return null;
  const config = await readRegular(path.join(projectRoot, 'code-linter.json5'));
  return { source: 'AGENTS.md', sourceSha256: digest(instructions), configSha256: config ? digest(config) : null };
}

async function buildVerifiedHap({ projectRoot, toolRoot, javaHome, timeoutMs, signal }) {
  const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HVIGOR_USER_HOME'].flatMap(key =>
    process.env[key] ? [[key, process.env[key]]] : []));
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const tool = arktsToolchainCommand({ projectRoot, toolRoot, javaHome, phase: 'verified-build', env });
  const execution = await runBoundedProcess(tool.command, tool.args, {
    cwd: projectRoot, env: tool.env, timeoutMs, signal, processGroup: true,
  });
  const { exitCode, interrupted, outputComplete, reason, tail } = execution;
  const receipt = { exitCode, interrupted, outputComplete, reason, hapSha256: null };
  if (exitCode !== 0 || interrupted || !outputComplete) return receipt;
  const marker = tail.split('\n').find(line => line.startsWith('[RC_ARKTS_HAP] '));
  if (!marker) return receipt;
  const hap = JSON.parse(marker.slice('[RC_ARKTS_HAP] '.length));
  const output = path.join(await fs.realpath(projectRoot), 'entry', 'build', 'default', 'outputs', 'default');
  if (path.dirname(hap) !== output || !/^entry-default-(?:un)?signed\.hap$/u.test(path.basename(hap))
    || await fs.realpath(hap) !== hap || !(await fs.lstat(hap)).isFile()) return receipt;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(hap, { signal })) hash.update(chunk);
  return { ...receipt, hapSha256: hash.digest('hex') };
}

export async function runArktsRequiredLint({ projectRoot, toolRoot, javaHome, outputRoot, requirement, signal, timeoutMs },
  { build = buildVerifiedHap, lint = runArktsCheckedLint } = {}) {
  const deadline = Date.now() + timeoutMs;
  const fixed = { source: requirement.source, configSha256: requirement.configSha256 };
  const unavailable = (reason, details = {}) => ({ ...fixed, ...details, status: 'INCOMPLETE', success: false, reason });
  const remaining = () => Math.max(0, deadline - Date.now());
  if (!requirement.configSha256) return unavailable('REQUIRED_LINT_CONFIG_MISSING');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || signal?.aborted) return unavailable('REQUIRED_LINT_DEADLINE');
  const directory = await fs.mkdtemp(path.join(outputRoot, 'required-lint-'));
  const evidence = {};
  const snapshot = () => copyArktsPublicTestSnapshot(projectRoot, undefined, { signal });
  async function verify() {
    evidence.snapshotSha256 = await snapshot();
    if (!remaining()) return unavailable('REQUIRED_LINT_DEADLINE', evidence);
    evidence.build = await build({ projectRoot, toolRoot, javaHome, signal, timeoutMs: remaining() });
    if (!evidence.build.hapSha256) {
      const { interrupted, outputComplete, exitCode } = evidence.build;
      if (!interrupted && outputComplete && Number.isInteger(exitCode) && exitCode !== 0) {
        return { ...fixed, ...evidence, status: 'FAIL', success: false, reason: 'REQUIRED_HAP_BUILD_FAILED' };
      }
      return unavailable('REQUIRED_HAP_BUILD_UNVERIFIED', evidence);
    }
    if (await snapshot() !== evidence.snapshotSha256) return unavailable('REQUIRED_LINT_BUILD_INPUT_CHANGED', evidence);
    if (!remaining()) return unavailable('REQUIRED_LINT_DEADLINE', evidence);
    evidence.lint = await lint({ projectRoot, toolRoot, javaHome, configSha256: requirement.configSha256,
      output: path.join(directory, 'linter.json'), signal, timeoutMs: Math.min(60_000, remaining()) });
    if (evidence.lint.snapshotSha256 !== evidence.snapshotSha256 || await snapshot() !== evidence.snapshotSha256) {
      return unavailable('REQUIRED_LINT_INPUT_UNVERIFIED', evidence);
    }
    if (!remaining() || signal?.aborted) return unavailable('REQUIRED_LINT_DEADLINE', evidence);
    const { status, reason, confirmed } = evidence.lint;
    return { ...fixed, ...evidence, status, success: status === 'PASS' && confirmed === true, reason };
  }
  let outcome;
  try {
    outcome = await verify();
  } catch (error) {
    const reason = signal?.aborted ? 'REQUIRED_LINT_CANCELLED' : 'REQUIRED_LINT_UNAVAILABLE';
    outcome = unavailable(reason, { ...evidence, errorCode: error.code ?? error.name });
  }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return outcome;
}
