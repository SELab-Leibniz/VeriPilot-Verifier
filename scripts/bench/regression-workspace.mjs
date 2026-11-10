import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

const generated = new Set(['.git', '.hvigor', '.test', 'oh_modules', 'node_modules', '.runtime-correction', '.runtime-corrector']);
const run = promisify(execFile);
const suiteRoot = /(?:^|\/)src\/test(?=\/|$)/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function isolateBluetoothAclSuite(workspace, isolatedWorkspace) {
  const registry = 'entry/src/test/List.test.ets';
  const original = await fs.readFile(path.join(workspace, registry), 'utf8');
  const binding = "import peripheralBluetoothAclConsumerTest from './peripheral/connection-record-bluetooth-acl-consumer.test'";
  const invocation = '  peripheralBluetoothAclConsumerTest()';
  const lines = original.split(/\r?\n/u);
  if ([binding, invocation].some(line => lines.filter(value => value === line).length !== 1))
    throw new Error('Cannot isolate the original Bluetooth ACL suite: expected one import and one registration.');
  await fs.writeFile(path.join(workspace, registry),
    lines.filter(line => line !== binding && line !== invocation).join(original.includes('\r\n') ? '\r\n' : '\n'));
  await fs.writeFile(path.join(isolatedWorkspace, registry),
    `${binding}\nexport default function testsuite(): void {\n${invocation}\n}\n`);
}

export async function readRegressionContractProbe(file) {
  const source = path.resolve(file);
  const body = await fs.readFile(source);
  const stem = source.replace(/\.ets$/u, '');
  const optional = name => fs.readFile(name).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const [mock, config] = await Promise.all([optional(stem + '.mock.ets'), optional(stem + '.mock.json')]);
  if (Boolean(mock) !== Boolean(config)) throw new Error('A contract probe mock requires both ArkTS source and its module mapping.');
  const module = config ? JSON.parse(config).module : null;
  if (config && (typeof module !== 'string' || !/^@ohos\.[a-z0-9.]+$/iu.test(module)))
    throw new Error('A contract probe mock requires a system module name.');
  const files = mock ? { source: hash(body), mock: hash(mock), config: hash(config) } : null;
  return { body, mock, module, receipt: { source, sha256: files ? hash(JSON.stringify(files)) : hash(body), ...(files ? { files } : {}) } };
}

// Run the public contract case in a fresh native process: an earlier suite's
// static mocks must not pollute its before/after comparison.
export async function installRegressionContractProbe(workspace, source, { mock = null, module = null } = {}) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > 128 * 1024)
    throw new Error('Contract probe must be a nonempty ArkTS module below 128 KiB.');
  const root = path.join(workspace, 'entry/src/test');
  await fs.copyFile(path.join(root, 'List.test.ets'), path.join(root, '__rc_original_list.test.ets'), constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, '__rc_contract_probe.test.ets'), source, { flag: 'wx' });
  if (mock) {
    const mockRoot = path.join(workspace, 'entry/src/mock');
    const configPath = path.join(mockRoot, 'mock-config.json5');
    const existing = await fs.readFile(configPath, 'utf8').then(JSON.parse,
      error => { if (error.code === 'ENOENT') return {}; throw error; });
    if (Object.hasOwn(existing, module)) throw new Error(`A system mock already exists for ${module}.`);
    await fs.mkdir(mockRoot, { recursive: true });
    await fs.writeFile(path.join(mockRoot, '__rc_contract_probe_sdk.ets'), mock, { flag: 'wx' });
    await fs.writeFile(configPath, JSON.stringify({ ...existing, [module]: { source: 'src/mock/__rc_contract_probe_sdk.ets' } }, null, 2) + '\n');
  }
  await fs.writeFile(path.join(root, 'List.test.ets'), `import contractProbe from './__rc_contract_probe.test'
export default function testsuite(): void { contractProbe() }
`);
}

// A Stop may already have observed the source tree, including build caches.
// Run the mutating toolchain in a sibling snapshot, outside that observed tree.
export async function prepareRegressionWorkspace(project, { originalTestCommit, signal } = {}) {
  const source = await fs.realpath(project);
  const options = { cwd: source, windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 };
  let testRoots = [];
  if (originalTestCommit !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(originalTestCommit)) throw new Error('Original tests require the exact baseline commit.');
    const { stdout } = await run('git', ['ls-tree', '-r', '--full-tree', '--name-only', '-z', originalTestCommit], options);
    testRoots = [...new Set(stdout.split('\0').flatMap(file => {
      const match = suiteRoot.exec(file);
      return match ? [file.slice(0, match.index + match[0].length)] : [];
    }))];
    if (!testRoots.length) throw new Error('The original commit has no public ArkTS unit test directories.');
  }
  const workspace = await fs.mkdtemp(path.join(path.dirname(source), 'rc-regression-'));
  await fs.cp(source, workspace, { recursive: true, dereference: true,
    filter(file) {
      if (file === source) return true;
      return !generated.has(path.basename(file)) && (!originalTestCommit || !suiteRoot.test(path.relative(source, file).replaceAll('\\', '/')));
    } });
  if (originalTestCommit) {
    const archive = `${workspace}.tar`;
    try {
      await run('git', ['--literal-pathspecs', 'archive', '--format=tar', `--output=${archive}`, originalTestCommit, '--', ...testRoots], options);
      await run('tar', ['-xf', archive, '-C', workspace], options);
    } finally { await fs.rm(archive, { force: true }); }
  }
  await fs.writeFile(workspace + '.json', JSON.stringify({ source, workspace, createdAt: new Date().toISOString(),
    ...(originalTestCommit ? { originalTestCommit, testRoots } : {}),
    purpose: 'Public local tests; toolchain outputs are isolated from the Stop evidence tree.' }, null, 2));
  return workspace;
}
