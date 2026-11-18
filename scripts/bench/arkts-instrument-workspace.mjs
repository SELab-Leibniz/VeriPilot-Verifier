import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../../lib/runtime-v2/utils.mjs';
import { digest } from './arkts-dataset.mjs';

const runnerPath = 'ets/testrunner/OpenHarmonyTestRunner.ets';
const runnerSource = `import { TestRunner, abilityDelegatorRegistry } from '@kit.TestKit';
import { Hypium } from '@ohos/hypium';
import testsuite from '../../../test/List.test';

export default class OpenHarmonyTestRunner implements TestRunner {
  onPrepare(): void {}
  onRun(): void {
    Hypium.hypiumTest(abilityDelegatorRegistry.getAbilityDelegator(), abilityDelegatorRegistry.getArguments(), testsuite);
  }
}
`;

async function lstatOptional(file) {
  return fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function collectRegularFiles(root, relative = '') {
  const result = [];
  for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const stat = await fs.lstat(path.join(root, child));
    if (stat.isDirectory()) result.push(...await collectRegularFiles(root, child));
    else {
      assert(stat.isFile(), `Expected a regular file in ${path.basename(root)} at ${child}`);
      result.push(child);
    }
  }
  return result;
}

async function readManifest(file, parse) {
  assert((await fs.lstat(file)).isFile(), `Expected a regular manifest at ${file}`);
  return parse(await fs.readFile(file, 'utf8'));
}

async function hashRegularFile(file) {
  assert((await fs.lstat(file)).isFile(), `Expected a regular ArkTS file at ${file}`);
  return digest(await fs.readFile(file));
}

async function instrumentSeal(root) {
  for (const relative of ['.', 'entry', 'entry/src', 'entry/src/test', 'entry/src/ohosTest',
    'entry/src/ohosTest/ets', 'entry/src/ohosTest/ets/testrunner']) {
    assert((await fs.lstat(path.join(root, relative))).isDirectory(), `Expected a regular ArkTS directory at ${relative}`);
  }
  const suiteRoot = path.join(root, 'entry/src/test');
  const suiteFiles = await collectRegularFiles(suiteRoot);
  assert(suiteFiles.includes('List.test.ets'), 'Missing ArkTS Local Test suite entry List.test.ets');
  const suiteSeal = Object.fromEntries(await Promise.all(suiteFiles.map(async file =>
    [file, await hashRegularFile(path.join(suiteRoot, file))])));
  return { suiteSeal, suiteSha256: digest(JSON.stringify(suiteSeal)),
    runnerSha256: await hashRegularFile(path.join(root, 'entry/src/ohosTest', runnerPath)) };
}

export async function verifyArktsInstrumentWorkspace({ projectRoot, suiteSha256, runnerSha256 }) {
  const current = await instrumentSeal(projectRoot);
  assert.equal(current.suiteSha256, suiteSha256, 'ArkTS Instrument Test suite changed during build');
  assert.equal(current.runnerSha256, runnerSha256, 'ArkTS Instrument Test runner changed during build');
}

// The caller supplies a disposable, already-prepared evaluation workspace.
// The original suite remains in place so its relative production imports and
// test declarations are identical to those used by Previewer Local Test.
export async function prepareArktsInstrumentWorkspace({ projectRoot, parse, scope }) {
  assert(typeof parse === 'function', 'Supply the pinned JSON5 parser for ArkTS manifests');
  assert((await fs.lstat(projectRoot)).isDirectory(), 'Expected a regular ArkTS evaluation workspace');
  const root = await fs.realpath(projectRoot);
  for (const relative of ['AppScope', 'entry', 'entry/src', 'entry/src/main', 'entry/src/test']) {
    assert((await fs.lstat(path.join(root, relative))).isDirectory(), `Expected a regular ArkTS directory at ${relative}`);
  }
  const source = path.join(root, 'entry/src');
  const mainRoot = path.join(source, 'main'), instrumentRoot = path.join(source, 'ohosTest');
  const instrument = await lstatOptional(instrumentRoot);
  if (instrument) assert(instrument.isDirectory(), 'Expected a regular ArkTS ohosTest directory');
  const [app, main, profile] = await Promise.all([
    readManifest(path.join(root, 'AppScope/app.json5'), parse),
    readManifest(path.join(mainRoot, 'module.json5'), parse),
    readManifest(path.join(root, 'entry/build-profile.json5'), parse),
    collectRegularFiles(path.join(root, 'AppScope')),
    collectRegularFiles(mainRoot),
    ...(instrument ? [collectRegularFiles(instrumentRoot)] : []),
  ]);
  const bundleName = app?.app?.bundleName;
  assert(typeof bundleName === 'string' && /^[A-Za-z][\w]*(?:\.[A-Za-z0-9_]+)+$/u.test(bundleName), 'Invalid ArkTS bundle name');
  const deviceTypes = main?.module?.deviceTypes;
  assert(Array.isArray(deviceTypes) && deviceTypes.length && new Set(deviceTypes).size === deviceTypes.length
    && deviceTypes.every(type => typeof type === 'string' && /^[a-z0-9-]+$/u.test(type)), 'Invalid ArkTS main module device types');
  assert(Array.isArray(profile?.targets) && profile.targets.some(target => target?.name === 'ohosTest'), 'Missing ArkTS ohosTest build target');

  const manifest = path.join(instrumentRoot, 'module.json5');
  let testModuleName = 'entry_test';
  if (await lstatOptional(manifest)) {
    const { module } = await readManifest(manifest, parse);
    assert(module?.type === 'feature' && typeof module.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(module.name),
      'Invalid ArkTS ohosTest module name or type');
    assert(Array.isArray(module.deviceTypes) && deviceTypes.length === module.deviceTypes.length && deviceTypes.every(type => module.deviceTypes.includes(type)),
      'ArkTS ohosTest device types differ from the application');
    testModuleName = module.name;
  } else {
    const scaffold = { module: { name: testModuleName, type: 'feature', deviceTypes, deliveryWithInstall: true, installationFree: false } };
    await fs.mkdir(instrumentRoot, { recursive: true });
    await fs.writeFile(manifest, JSON.stringify(scaffold, null, 2) + '\n', { flag: 'wx' });
  }

  let sourceCode = runnerSource;
  if (scope) {
    assert(scope.module === 'entry' && scope.suite && scope.itName && !/[\r\n#]/u.test(scope.suite + scope.itName),
      'Instrument Test requires an exact suite and test title');
    sourceCode = runnerSource.replace('import { Hypium }', 'import { Core, Hypium }')
      .replace(', testsuite);', `, () => {
      Core.getInstance().getDefaultService('config').class = ${JSON.stringify(scope.suite + '#' + scope.itName)};
      testsuite();
    });`);
  }
  await atomicWrite(path.join(instrumentRoot, runnerPath), sourceCode);
  return { bundleName, testModuleName, deviceTypes, ...await instrumentSeal(root) };
}
