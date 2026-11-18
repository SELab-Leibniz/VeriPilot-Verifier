import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureArktsToolchainIdentity } from '../scripts/bench/arkts-toolchain-identity.mjs';

const expectedMetadata = [
  '# Command Line Tools(windows-x64)',
  '# Version: 6.1.1.280',
  'hvigor         : 6.24.2',
  'HarmonyOS SDK  : HarmonyOS 6.1.1 Release (API Version 24 Release)',
  'ohpm           : 6.1.1.224',
].join('\r\n');
const windows = {
  platform: 'win32', arch: 'x64', systemRelease: '10.0.26300', controllerNode: 'v24.16.0',
  async readRuntimeVersion(executable, flag) {
    const name = path.basename(executable);
    assert(name === 'node.exe' && flag === '--version' || name === 'java.exe' && flag === '-version');
    return name === 'node.exe' ? 'v18.20.1' : 'openjdk version "21.0.8"\nOpenJDK Runtime Environment';
  },
};

async function write(root, relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arkts-toolchain-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const toolRoot = path.join(root, 'clt'), javaHome = path.join(root, 'jbr');
  await fs.mkdir(path.join(toolRoot, 'sdk'), { recursive: true });
  for (const file of ['bin/hvigorw.bat', 'hvigor/bin/hvigorw.bat', 'hvigor/bin/hvigorw.js', 'tool/node/node.exe', 'ohpm/bin/pm-cli.js'])
    await write(toolRoot, file, `frozen ${file}`);
  await write(toolRoot, 'version.txt', expectedMetadata);
  await write(javaHome, 'bin/java.exe', 'frozen java.exe');
  return { toolRoot, javaHome };
}

test('binds the supported Windows runtime sentinels without assuming optional vendor paths', async t => {
  const paths = await fixture(t), other = await fixture(t);
  const identity = await captureArktsToolchainIdentity(paths, windows);
  assert.deepEqual(await captureArktsToolchainIdentity(other, windows), identity);
  assert.equal(identity.versions.commandLineTools, '6.1.1.280');
  assert.equal(identity.versions.api, 24);
  assert.equal(identity.versions.hvigor, '6.24.2');
  assert.equal(identity.versions.sdkNode, 'v18.20.1');
  assert.equal(identity.versions.jbr, '21.0.8');
  assert.equal(identity.versions.ohosPlugin, null);
  assert(identity.missingMetadata.includes('sdk/default/sdk-pkg.json'));
  assert.match(identity.files['clt/hvigor/bin/hvigorw.bat'], /^[a-f0-9]{64}$/u);
  await write(other.toolRoot, 'version.txt', expectedMetadata.replace('6.1.1 Release (API Version 24 Release)', '6.1.1(24)'));
  assert.equal((await captureArktsToolchainIdentity(other, windows)).versions.api, 24);
  await write(paths.toolRoot, 'hvigor/bin/hvigorw.bat', 'changed launcher');
  assert.notEqual((await captureArktsToolchainIdentity(paths, windows)).sha256, identity.sha256);
});

test('fails qualification for unsupported platforms, missing files, and measured version conflicts', async t => {
  const paths = await fixture(t);
  await assert.rejects(captureArktsToolchainIdentity(paths, { ...windows, platform: 'darwin' }), /Windows x64/u);
  await write(paths.toolRoot, 'version.txt', expectedMetadata.replace('6.1.1.280', '26.0.0.865'));
  await assert.rejects(captureArktsToolchainIdentity(paths, windows), /Unexpected Huawei Command Line Tools version/u);
  await write(paths.toolRoot, 'version.txt', expectedMetadata.replace('API Version 24', 'API Version 26'));
  await assert.rejects(captureArktsToolchainIdentity(paths, windows), /establish API 24/u);
  await write(paths.toolRoot, 'version.txt', expectedMetadata);
  await fs.unlink(path.join(paths.toolRoot, 'ohpm/bin/pm-cli.js'));
  await assert.rejects(captureArktsToolchainIdentity(paths, windows), /ohpm\/bin\/pm-cli.js \(ENOENT\)/u);
});

test('reads observed SDK and Hvigor manifests and refuses conflicting vendor versions', async t => {
  const paths = await fixture(t);
  const sdk = 'sdk/default/openharmony/previewer/oh-uni-package.json';
  const plugin = 'hvigor/hvigor-ohos-plugin/package.json';
  await write(paths.toolRoot, sdk, JSON.stringify({ apiVersion: '24', version: '6.1.1.125' }));
  await write(paths.toolRoot, plugin, JSON.stringify({ version: '6.24.2' }));
  const identity = await captureArktsToolchainIdentity(paths, windows);
  assert.equal(identity.versions.ohosPlugin, '6.24.2');
  assert.deepEqual(identity.versions.sdkPackages[sdk], { apiVersion: 24, version: '6.1.1.125' });
  await write(paths.toolRoot, sdk, JSON.stringify({ apiVersion: '24', version: '6.1.1.115' }));
  await assert.rejects(captureArktsToolchainIdentity(paths, windows), /differs from benchmark release 6\.1\.1\.125/u);
  await write(paths.toolRoot, sdk, JSON.stringify({ apiVersion: '24', version: '6.1.1.125' }));
  await write(paths.toolRoot, plugin, JSON.stringify({ version: '6.26.9' }));
  await assert.rejects(captureArktsToolchainIdentity(paths, windows), /Installed Hvigor OHOS plugin differs/u);
});

test('macOS verifies and fingerprints Previewer and its linked extension before running a task', async t => {
  const { toolRoot, javaHome } = await fixture(t);
  await write(toolRoot, 'version.txt', '# Command Line Tools(mac-arm64)\n# Version: 26.0.0.865\nhvigor: 6.26.9\napiVersion: 26\n'
    + 'HarmonyOS SDK: HarmonyOS 26.0.0 Release (include Ohos_sdk_public 26.0.0.105 (API Version 26 Release))\n');
  for (const file of ['bin/hvigorw', 'hvigor/bin/hvigorw', 'tool/node/bin/node',
    'sdk/default/openharmony/previewer/common/bin/Previewer', 'sdk/default/openharmony/previewer/common/bin/libide_extension.dylib'])
    await write(toolRoot, file, file);
  await write(javaHome, 'bin/java', 'java');
  const verified = [];
  const mac = { ...windows, platform: 'darwin', arch: 'arm64',
    async readRuntimeVersion(file) { return path.basename(file) === 'node' ? 'v24.14.1' : 'openjdk version "25.0.2"'; },
    async verifySignature(file) { verified.push(path.basename(file)); } };
  const installed = await captureArktsToolchainIdentity({ toolRoot, javaHome }, mac);
  assert.equal(installed.versions.api, 26);
  assert.deepEqual(verified, ['Previewer', 'libide_extension.dylib']);
  assert(Object.keys(installed.files).some(file => file.endsWith('/libide_extension.dylib')));
  await assert.rejects(captureArktsToolchainIdentity({ toolRoot, javaHome }, { ...mac,
    async verifySignature() { throw new Error('codesign invalid'); },
    async readRuntimeVersion() { assert.fail('preflight must reject the signature first'); } }), /codesign invalid/u);
});
