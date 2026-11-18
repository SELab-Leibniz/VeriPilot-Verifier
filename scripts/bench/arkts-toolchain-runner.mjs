import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const instrumentTargets = new Map([['instrument-app', 'default'], ['instrument-test', 'ohosTest']]);
const appBuildModes = new Set(['debug', 'test']);
const phases = new Set(['install', 'test', 'build', 'verified-build', 'java', ...instrumentTargets.keys()]);
const hvigorArguments = {
  build: ['--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon'],
  test: ['test', '-p', 'module=entry', '-p', 'coverage=false', '--no-daemon'],
};
const macJavaHome = '/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home';

export function arktsToolchainCommand({ toolRoot, javaHome, projectRoot, phase, appBuildMode, env = process.env, platform = process.platform }) {
  if (!phases.has(phase) || !toolRoot || !projectRoot) throw new Error('ArkTS phase, tool root, and project root are required');
  if (instrumentTargets.has(phase) && platform !== 'darwin') throw new Error('ArkTS instrumentation builds require macOS');
  if (phase === 'verified-build' && platform !== 'darwin') throw new Error('Fresh ArkTS HAP capture requires macOS');
  if (phase === 'instrument-app' && !appBuildModes.has(appBuildMode)) throw new Error('ArkTS instrumentation app build mode must be debug or test');
  if (platform === 'win32') {
    const shell = path.win32.join(env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = fileURLToPath(new URL('./run-arkts-toolchain.ps1', import.meta.url));
    return { command: shell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Project', projectRoot, '-ToolRoot', toolRoot, '-Phase', phase, ...(javaHome ? ['-JavaHome', javaHome] : [])], env };
  }
  if (platform !== 'darwin') throw new Error(`Unsupported ArkTS toolchain platform ${platform}`);
  const nativeEnv = { ...env };
  delete nativeEnv.NODE_OPTIONS;
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), phase, projectRoot, toolRoot, javaHome ?? '',
    ...(phase === 'instrument-app' ? [appBuildMode] : [])], env: nativeEnv };
}

function findJava(explicit, env) {
  for (const [source, home, strict] of [['parameter', explicit, true], ['RC_JAVA_HOME', env.RC_JAVA_HOME, true],
    ['JAVA_HOME', env.JAVA_HOME, false], ['deveco', macJavaHome, false]]) {
    if (!home) continue;
    const javaHome = path.resolve(home), java = path.join(javaHome, 'bin/java');
    try {
      fs.accessSync(java, fs.constants.X_OK);
      return { javaHome, source, java };
    } catch (error) {
      if (strict) return { javaHome: null, source, error: `bin/java unavailable (${error.code})` };
    }
  }
  return { javaHome: null, source: null };
}

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  return result.signal ? 128 + osConstants.signals[result.signal] : result.status;
}

function buildFreshHap(cwd, target, build) {
  let directory = cwd;
  for (const segment of ['entry', 'build', 'default', 'outputs', target]) {
    directory = path.join(directory, segment);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error('Expected a regular ArkTS HAP output directory');
  }
  const files = ['signed', 'unsigned'].map(kind => path.join(directory, `entry-${target}-${kind}.hap`));
  const inspect = file => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('Expected a regular ArkTS HAP output file');
    return stat;
  };
  const previous = files.filter(file => inspect(file));
  for (const file of previous) fs.unlinkSync(file);
  const code = build();
  if (code !== 0) return code;
  const hap = files.find(file => inspect(file)?.size > 0);
  if (!hap || fs.realpathSync(hap) !== hap) throw new Error(`No fresh ArkTS HAP for entry@${target}`);
  console.log(`[RC_ARKTS_HAP] ${JSON.stringify(hap)}`);
  return code;
}

function runMacToolchain(phase, projectRoot, toolRoot, javaHome, appBuildMode) {
  if (process.platform !== 'darwin' || !phases.has(phase)) throw new Error('A supported macOS ArkTS phase is required');
  if (phase === 'instrument-app' && !appBuildModes.has(appBuildMode)) throw new Error('ArkTS instrumentation app build mode must be debug or test');
  const target = instrumentTargets.get(phase);
  const cwd = fs.realpathSync(projectRoot), root = fs.realpathSync(toolRoot);
  const { java, ...javaReceipt } = findJava(javaHome, process.env);
  console.log(`[RC_ARKTS_JAVA] ${JSON.stringify(javaReceipt)}`);
  if (javaReceipt.error || (!java && (phase === 'build' || phase === 'verified-build' || phase === 'java' || target))) return 3;

  const nodeHome = path.join(root, 'tool/node');
  const env = { ...process.env, DEVECO_SDK_HOME: path.join(root, 'sdk'), DEVECO_NODE_HOME: nodeHome, NODE_HOME: nodeHome };
  const bin = [path.join(nodeHome, 'bin'), path.join(root, 'bin')];
  if (java) {
    env.JAVA_HOME = javaReceipt.javaHome;
    env.RC_JAVA_HOME = javaReceipt.javaHome;
    bin.unshift(path.dirname(java));
  }
  env.PATH = [...bin, env.PATH ?? '/usr/bin:/bin'].join(path.delimiter);
  if (phase === 'java') return run(java, ['-version'], { cwd, env, stdio: ['ignore', 1, 1] });

  const node = path.join(nodeHome, 'bin/node');
  const hvigor = target
    ? ['--mode', 'module', '-p', `module=entry@${target}`, '-p', 'product=default',
      '-p', `buildMode=${phase === 'instrument-app' ? appBuildMode : 'test'}`, '-p', 'isOhosTest=true', 'assembleHap', '--no-daemon']
    : hvigorArguments[phase === 'verified-build' ? 'build' : phase];
  const args = phase === 'install'
    ? ['--no-deprecation', path.join(root, 'ohpm/bin/pm-cli.js'), 'install']
    : ['--', path.join(root, 'hvigor/bin/hvigorw.js'), ...hvigor];
  // lockf shares the open file description with this process and the vendor
  // child. Keeping the same file across runs prevents an inode replacement race.
  const uid = process.getuid(), lock = `/private/tmp/runtime-corrector-arkts-hvigor-${uid}.lock`;
  const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022)) throw new Error(`Unsafe ArkTS toolchain lock ${lock}`);
    const started = performance.now();
    const code = run('/usr/bin/lockf', ['3'], { stdio: ['ignore', 1, 2, fd] });
    if (code !== 0) return code;
    console.log(`[RC_ARKTS_LOCK] ${JSON.stringify({ phase, waitMs: Math.round(performance.now() - started), acquiredAt: new Date().toISOString() })}`);
    const build = () => run(node, args, { cwd, env, stdio: ['ignore', 1, 2, fd] });
    const hapTarget = target ?? (phase === 'verified-build' ? 'default' : null);
    return hapTarget ? buildFreshHap(cwd, hapTarget, build) : build();
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = runMacToolchain(...process.argv.slice(2));
  } catch (error) {
    console.error(`ArkTS toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
