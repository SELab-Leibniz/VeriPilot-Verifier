import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arktsToolchainCommand } from './arkts-toolchain-runner.mjs';
export const devEcoJbr = 'C:\\Program Files\\Huawei\\DevEco Studio\\jbr';
export const macDevEcoJbr = '/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home';
const executable = (home, platform) => path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java');
// Same order as run-arkts-toolchain.ps1: explicit choices must be valid; an
// unusable inherited JAVA_HOME falls through to the DevEco runtime.
export function resolveJavaHome({ explicit, env = process.env, exists = existsSync, platform = process.platform,
  devEco = platform === 'darwin' ? macDevEcoJbr : devEcoJbr } = {}) {
  for (const [source, value, strict] of [['option', explicit, true], ['RC_JAVA_HOME', env.RC_JAVA_HOME, true], ['JAVA_HOME', env.JAVA_HOME, false], ['deveco', devEco, false]]) {
    if (!value) continue;
    const javaHome = path.resolve(value), java = executable(javaHome, platform);
    if (exists(java)) return { javaHome, source, java };
    if (strict) throw new Error(`Java home from ${source} has no ${path.basename(java)}: ${javaHome}`);
  }
  throw new Error('No JDK: pass --java-home, set RC_JAVA_HOME/JAVA_HOME, or install DevEco Studio jbr');
}
export function applyJavaEnvironment(javaHome, env = process.env) {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH', bin = path.join(javaHome, 'bin');
  const entries = String(env[key] ?? '').split(path.delimiter).filter(entry => entry && path.resolve(entry).toLowerCase() !== bin.toLowerCase());
  env[key] = [bin, ...entries].join(path.delimiter);
  env.JAVA_HOME = javaHome; env.RC_JAVA_HOME = javaHome;
  return env;
}
const versionOf = text => /version "([^"]+)"/u.exec(text)?.[1] ?? null;
// Resolves `java` through PATH in the exact environment business tools inherit,
// then through the toolchain wrapper, which applies its own resolution.
export function assertJavaRuns({ env = process.env, projectRoot, toolRoot, javaHome, timeout = 60000 } = {}) {
  const plain = spawnSync('java', ['-version'], { env, encoding: 'utf8', windowsHide: true, timeout });
  const version = versionOf(`${plain.stderr}${plain.stdout}`);
  if (plain.status !== 0 || !version) throw new Error(`java -version failed in the business environment (${plain.error?.code ?? plain.status})`);
  const result = { javaHome, version, path: true };
  if (!projectRoot || !toolRoot) return result;
  const wrapper = arktsToolchainCommand({ toolRoot, javaHome, projectRoot, phase: 'java', env });
  const wrapped = spawnSync(wrapper.command, wrapper.args, { env: wrapper.env, encoding: 'utf8', windowsHide: true, timeout });
  const line = /\[RC_ARKTS_JAVA\] (\{.*\})/u.exec(wrapped.stdout ?? '')?.[1], toolchain = line ? JSON.parse(line) : null;
  if (wrapped.status !== 0 || !versionOf(wrapped.stdout ?? '') || !toolchain?.javaHome || (javaHome && path.resolve(toolchain.javaHome).toLowerCase() !== path.resolve(javaHome).toLowerCase()))
    throw new Error(`Toolchain java preflight failed (${wrapped.error?.code ?? wrapped.status})`);
  return { ...result, toolchain: { ...toolchain, version: versionOf(wrapped.stdout) } };
}
// Resolve, apply to this process (the in-process Gateway and every business
// tool child inherit it) and prove `java -version` before any model request.
export function prepareJava({ explicit, projectRoot, toolRoot, env = process.env } = {}) {
  const resolved = resolveJavaHome({ explicit, env });
  applyJavaEnvironment(resolved.javaHome, env);
  return { ...resolved, ...assertJavaRuns({ env, projectRoot, toolRoot, javaHome: resolved.javaHome }) };
}
