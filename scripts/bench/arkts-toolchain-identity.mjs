import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { digest } from './arkts-dataset.mjs';

const execute = promisify(execFile);
const windowsTools = [
  'version.txt',
  'bin/hvigorw.bat',
  'hvigor/bin/hvigorw.bat',
  'hvigor/bin/hvigorw.js',
  'tool/node/node.exe',
  'ohpm/bin/pm-cli.js',
];
const macPreviewer = ['Previewer', 'libide_extension.dylib'].map(name => `sdk/default/openharmony/previewer/common/bin/${name}`);
const macTools = ['version.txt', 'bin/hvigorw', 'hvigor/bin/hvigorw', 'hvigor/bin/hvigorw.js', 'tool/node/bin/node', 'ohpm/bin/pm-cli.js'];
const hvigorPackage = 'hvigor/hvigor/package.json';
const ohosPluginPackage = 'hvigor/hvigor-ohos-plugin/package.json';
const ohpmPackage = 'ohpm/package.json';
// These are observed vendor paths. The Windows reproduction pins the entire
// install profile but does not establish that these metadata paths are present.
const sdkMetadata = ['sdk/default/sdk-pkg.json',
  ...['ets', 'previewer', 'toolchains'].map(component => `sdk/default/openharmony/${component}/oh-uni-package.json`)];
const optionalMetadata = [hvigorPackage, ohosPluginPackage, ohpmPackage, ...sdkMetadata];

const field = (text, key) => new RegExp(`^[ \\t]*(?:#[ \\t]*)?${key}[ \\t]*:[ \\t]*(.+?)\\s*$`, 'imu').exec(text)?.[1] ?? null;
const versionText = bytes => bytes.toString('utf8').replace(/^\uFEFF/u, '');
const json = bytes => JSON.parse(versionText(bytes));

async function runtimeVersion(executable, flag) {
  const { NODE_OPTIONS, ...env } = process.env;
  const { stdout, stderr } = await execute(executable, [flag],
    { env, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
  return `${stdout}\n${stderr}`.trim();
}

async function verifyMacSignature(file) {
  try {
    await execute('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 15_000, maxBuffer: 64 * 1024 });
  } catch (cause) {
    throw new Error(`Invalid macOS code signature for Huawei ${path.basename(file)}. Use a valid Huawei Previewer installation before calibrating.`, { cause });
  }
}

async function readToolFile(root, relative, required) {
  try {
    return await fs.readFile(path.join(root, relative));
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ArkTS toolchain file ${relative} (${error.code ?? 'read failed'})`);
  }
}

export async function captureArktsToolchainIdentity({ toolRoot, javaHome, localTests = true }, {
  platform = process.platform, arch = process.arch, systemRelease = os.release(),
  controllerNode = process.version, readRuntimeVersion = runtimeVersion, verifySignature = verifyMacSignature,
} = {}) {
  const mac = platform === 'darwin' && arch === 'arm64';
  assert(mac || platform === 'win32' && arch === 'x64', 'ArkTS benchmark toolchain requires Windows x64 or macOS arm64');
  assert(toolRoot && javaHome, 'Provide the Huawei tool root and explicit JBR home for ArkTS qualification');
  const toolFiles = mac ? (localTests ? [...macTools, ...macPreviewer] : macTools) : windowsTools;
  const nodePath = mac ? 'tool/node/bin/node' : 'tool/node/node.exe';
  const javaPath = mac ? 'bin/java' : 'bin/java.exe';
  const sdk = await fs.stat(path.join(toolRoot, 'sdk')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert(sdk?.isDirectory(), 'Huawei tool root has no SDK directory');
  const [required, optional, java] = await Promise.all([
    Promise.all(toolFiles.map(relative => readToolFile(toolRoot, relative, true))),
    Promise.all(optionalMetadata.map(relative => readToolFile(toolRoot, relative, false))),
    readToolFile(javaHome, javaPath, true),
  ]);
  const metadata = Object.fromEntries(optionalMetadata.flatMap((relative, index) =>
    optional[index] ? [[relative, json(optional[index])]] : []));
  const cltText = versionText(required[0]);
  const commandLineTools = field(cltText, 'Version');
  const sdkSummary = field(cltText, 'HarmonyOS SDK') ?? '';
  const apiInText = field(cltText, 'apiVersion')
    ?? /\bAPI\s+Version\s+(\d+)\b/iu.exec(sdkSummary)?.[1]
    ?? /\bHarmonyOS\s+\d+(?:\.\d+)+\s*\(\s*(\d+)\s*\)/iu.exec(sdkSummary)?.[1];
  const sdkPackages = Object.fromEntries(sdkMetadata.filter(relative => metadata[relative]).map(relative => {
    const value = relative === 'sdk/default/sdk-pkg.json' ? metadata[relative].data : metadata[relative];
    assert(/^\d+$/u.test(String(value?.apiVersion)) && typeof value?.version === 'string',
      `Invalid SDK API/package version in ${relative}`);
    return [relative, { apiVersion: Number(value.apiVersion), version: value.version }];
  }));
  const apis = [apiInText, ...Object.values(sdkPackages).map(value => value.apiVersion)]
    .filter(value => value !== undefined).map(Number);
  const hvigorDeclared = field(cltText, 'hvigor'), hvigorInstalled = metadata[hvigorPackage]?.version;
  const ohosPlugin = metadata[ohosPluginPackage]?.version ?? null;
  const sdkComponents = Object.values(sdkPackages);
  const api = mac ? 26 : 24;
  const sdkVersion = mac ? /\bOhos_sdk_public\s+(\d+(?:\.\d+)+)\b/iu.exec(sdkSummary)?.[1] ?? sdkComponents[0]?.version : '6.1.1.125';
  const hvigor = mac ? hvigorDeclared ?? hvigorInstalled : '6.24.2';
  if (mac) {
    assert(/Command Line Tools\(mac-arm64\)/u.test(cltText), 'Expected the native macOS arm64 Huawei tools');
    assert([commandLineTools, sdkVersion, hvigor].every(version => /^\d+(?:\.\d+)+$/u.test(version ?? '')),
      'Huawei metadata must establish the Command Line Tools, SDK, and Hvigor versions');
  } else assert.equal(commandLineTools, '6.1.1.280', 'Unexpected Huawei Command Line Tools version');
  assert(apis.length && apis.every(value => value === api), `Huawei SDK metadata must establish API ${api}`);
  assert(sdkComponents.every(entry => entry.version === sdkVersion),
    `Installed HarmonyOS SDK package differs from benchmark release ${sdkVersion}`);
  assert.equal(hvigorDeclared ?? hvigorInstalled, hvigor, 'Unexpected Hvigor version');
  if (metadata[hvigorPackage]) assert.equal(hvigorInstalled, hvigor, 'Installed Hvigor package differs from the benchmark toolchain');
  if (metadata[ohosPluginPackage]) assert.equal(ohosPlugin, hvigor, 'Installed Hvigor OHOS plugin differs from the benchmark toolchain');
  if (mac && localTests) {
    // Hvigor waits for Previewer output even after macOS refuses to launch it.
    for (const file of macPreviewer) await verifySignature(path.join(toolRoot, file));
  }

  const [nodeVersion, javaVersion] = await Promise.all([
    readRuntimeVersion(path.join(toolRoot, nodePath), '--version'),
    readRuntimeVersion(path.join(javaHome, javaPath), '-version'),
  ]);
  const sdkNode = /^v\d+\.\d+\.\d+$/u.exec(nodeVersion)?.[0];
  const jbr = /\b(?:openjdk|java) version "([^"]+)"/iu.exec(javaVersion)?.[1];
  assert(sdkNode && jbr, 'Could not measure the Huawei SDK Node and Java executable versions');
  const versions = { systemRelease, controllerNode, commandLineTools, api, hvigor,
    ohosPlugin, ohpm: metadata[ohpmPackage]?.version ?? field(cltText, 'ohpm'), sdkNode, jbr, sdkPackages,
    ...(mac ? { sdkVersion } : {}) };
  const files = Object.fromEntries([
    ...toolFiles.map((relative, index) => [`clt/${relative}`, digest(required[index])]),
    ...optionalMetadata.flatMap((relative, index) => optional[index] ? [[`clt/${relative}`, digest(optional[index])]] : []),
    [`jbr/${javaPath}`, digest(java)],
  ]);
  const identity = { platform, arch, versions, files, ...(localTests ? {} : { scope: 'build' }),
    missingMetadata: optionalMetadata.filter((_, index) => !optional[index]) };
  return { ...identity, sha256: digest(JSON.stringify(identity)) };
}
