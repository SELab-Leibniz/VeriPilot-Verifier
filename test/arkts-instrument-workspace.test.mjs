import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../scripts/bench/arkts-dataset.mjs';
import { prepareArktsInstrumentWorkspace, verifyArktsInstrumentWorkspace } from '../scripts/bench/arkts-instrument-workspace.mjs';
import { runArktsInstrumentTests } from '../scripts/bench/arkts-instrument-runtime.mjs';

const runner = 'entry/src/ohosTest/ets/testrunner/OpenHarmonyTestRunner.ets';
const suite = 'entry/src/test/List.test.ets';
const manifest = 'entry/src/ohosTest/module.json5';

async function workspace(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-arkts-instrument-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, 'project');
  const save = async (file, value) => {
    const target = path.join(projectRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await Promise.all([
    save('AppScope/app.json5', { app: { bundleName: 'com.example.fixture' } }),
    save('entry/build-profile.json5', { targets: [{ name: 'default' }, { name: 'ohosTest' }] }),
    save('entry/src/main/module.json5', { module: { name: 'entry', deviceTypes: ['phone', 'tablet'] } }),
    save('entry/src/main/ets/Example.ets', 'app source\n'),
    save(suite, 'export default function cases() {}\r\n'),
    save('entry/src/test/nested/Contract.test.ets', 'test source\r\n'),
  ]);
  return { temp, projectRoot, save, read: file => fs.readFile(path.join(projectRoot, file), 'utf8'),
    prepare: () => prepareArktsInstrumentWorkspace({ projectRoot, parse: JSON.parse }) };
}

test('grafts a device runner over the existing test module while preserving app and suite bytes', async t => {
  const { save, read, prepare } = await workspace(t);
  const originalManifest = '{ "module": { "name": "alternate_test", "type": "feature", "deviceTypes": ["tablet", "phone"] } }\n';
  await save(manifest, originalManifest);
  await save(runner, 'previous runner\n');
  const originalList = await read(suite);
  const result = await prepare();
  assert.equal(result.bundleName, 'com.example.fixture');
  assert.equal(result.testModuleName, 'alternate_test');
  assert.deepEqual(result.deviceTypes, ['phone', 'tablet']);
  assert.deepEqual(result.suiteSeal, { 'List.test.ets': digest(originalList), 'nested/Contract.test.ets': digest('test source\r\n') });
  assert.equal(result.suiteSha256, digest(JSON.stringify(result.suiteSeal)));
  const source = await read(runner);
  assert.match(source, /import testsuite from '\.\.\/\.\.\/\.\.\/test\/List\.test'/u);
  assert.equal(result.runnerSha256, digest(source));
  assert.equal(await read(manifest), originalManifest);
  assert.equal(await read(suite), originalList);
  assert.equal(await read('entry/src/main/ets/Example.ets'), 'app source\n');
  assert.deepEqual(await prepare(), result);
});

test('scaffolds a missing feature manifest from the application device types', async t => {
  const { save, read, prepare } = await workspace(t);
  await save('entry/src/ohosTest/resources/free.txt', 'existing content');
  const result = await prepare();
  assert.deepEqual(JSON.parse(await read(manifest)), { module: { name: 'entry_test', type: 'feature',
    deviceTypes: ['phone', 'tablet'], deliveryWithInstall: true, installationFree: false } });
  assert.equal(result.testModuleName, 'entry_test');
  assert.equal(await read('entry/src/ohosTest/resources/free.txt'), 'existing content');
});

test('post-build verification rejects changed suite bytes, runner bytes, and linked paths', async t => {
  const { temp, projectRoot, save, read, prepare } = await workspace(t);
  const prepared = await prepare();
  const verify = () => verifyArktsInstrumentWorkspace({ projectRoot, ...prepared });
  await verify();

  for (const [file, changed] of [[suite, /suite changed during build/u], [runner, /runner changed during build/u]]) {
    const original = await read(file);
    await save(file, original + '// changed during assembly\n');
    await assert.rejects(verify(), changed);
    await save(file, original);
  }
  await verify();

  const directory = path.dirname(path.join(projectRoot, runner));
  const outside = path.join(temp, 'copied-runner');
  await fs.rename(directory, outside);
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verify(), /regular ArkTS directory/u);
});

test('rejects an instrumentation directory linked outside the disposable workspace', async t => {
  const { temp, projectRoot, prepare } = await workspace(t);
  const outside = path.join(temp, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(projectRoot, 'entry/src/ohosTest'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare(), /regular ArkTS ohosTest directory/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('rejects a pinned phone route for a PC project before any vendor build', async t => {
  const { temp, projectRoot, save } = await workspace(t);
  await save('entry/src/main/module.json5', { module: { name: 'entry', deviceTypes: ['2in1'] } });
  const nodeModules = path.join(temp, 'node_modules/json5');
  await fs.mkdir(nodeModules, { recursive: true });
  await fs.writeFile(path.join(nodeModules, 'package.json'), '{"name":"json5","main":"index.cjs"}');
  await fs.writeFile(path.join(nodeModules, 'index.cjs'), 'exports.parse = JSON.parse;');
  const route = { server: '127.0.0.1:8710', target: '127.0.0.1:12487', appBuildMode: 'debug' };
  const expectedDevice = { server: route.server, target: route.target, api: 24, bootReady: true, type: 'phone' };
  await assert.rejects(runArktsInstrumentTests({ projectRoot, json5Package: path.join(nodeModules, 'package.json'),
    route, expectedDevice, timeoutMs: 1000 }), /project device types: 2in1/u);
  assert(!(await fs.readdir(temp)).some(name => name.startsWith('rc-it-')));
});
