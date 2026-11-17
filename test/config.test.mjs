import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadInputs, chooseModels, publicPlan, executionPlan } from '../lib/config.mjs';
import { writeJson, hash } from '../lib/files.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'RC 配置 空格-'));
  for (const dir of ['sample/project', 'host', 'state', 'sdk', 'bin']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await writeJson(path.join(root, 'host/package.json'), { name: 'openclaw', version: '2026.7.1-2' });
  await fs.writeFile(path.join(root, 'host/openclaw.mjs'), '');
  await fs.writeFile(path.join(root, 'plugin.tgz'), 'not used by read-only plan');
  await fs.writeFile(path.join(root, 'sample/project/source.py'), 'input');
  await fs.writeFile(path.join(root, 'sample/prompt.md'), 'task');
  await fs.writeFile(path.join(root, 'sample/rc.yaml'), 'enabled: true\n');
  await writeJson(path.join(root, 'state/openclaw.json'), { agents: { list: [{ id: 'main', default: true }], defaults: { model: 'p/m' } },
    models: { providers: { p: { models: [{ id: 'm' }], apiKey: 'private-test-key' } } },
    plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/m' } } } } });
  const sample = path.join(root, 'sample/experiment.yaml'), machine = path.join(root, 'machine.yaml');
  await fs.writeFile(sample, 'version: 1\nid: test\nprojectDir: ./project\npromptFile: ./prompt.md\nrcConfigFile: ./rc.yaml\n');
  const git = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  const content = `version: 1\npaths:\n  node: ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}\n  git: ${JSON.stringify(git.replaceAll('\\', '/'))}\n  openclawRoot: ./host\n  rcPluginPackage: ./plugin.tgz\n  hostConfig: ./state/openclaw.json\n  hostState: ./state\n  outputRoot: ./output\nharmony:\n  sdk: ./sdk\nextraPath:\n  - ./bin\n`;
  await fs.writeFile(machine, content);
  return { root, sample, machine, content };
}
test('machine and sample relative paths use their own directories; plan does not write inputs', async () => {
  const f = await fixture(), before = hash(await fs.readFile(path.join(f.root, 'sample/project/source.py')));
  const result = await loadInputs(f.sample, f.machine);
  assert.equal(result.projectDir, path.join(f.root, 'sample/project'));
  assert.equal(result.paths.outputRoot, path.join(f.root, 'output'));
  assert.equal(result.environment.DEVECO_SDK_HOME, path.join(f.root, 'sdk'));
  assert.ok(result.binPaths.includes(path.join(f.root, 'bin')));
  assert.equal(hash(await fs.readFile(path.join(f.root, 'sample/project/source.py'))), before);
  await assert.rejects(() => fs.stat(result.paths.outputRoot), /ENOENT/);
});
test('new-machine preflight rejects a missing SDK and environment isolation override', async () => {
  const f = await fixture();
  await fs.writeFile(f.machine, f.content.replace('sdk: ./sdk', 'sdk: ./missing-sdk'));
  await assert.rejects(() => loadInputs(f.sample, f.machine), /ENOENT/);
  await fs.writeFile(f.machine, f.content + 'env:\n  OPENCLAW_CONFIG_PATH: production-config\n');
  await assert.rejects(() => loadInputs(f.sample, f.machine), /Unsupported environment/);
});
test('config typos fail before starting a host', async () => {
  const f = await fixture();
  await fs.appendFile(f.sample, 'execuition:\n  pollIntervalMs: 10\n');
  await assert.rejects(() => loadInputs(f.sample, f.machine), /Unknown experiment.execuition/);
});
test('new host implicit main and first listed default follow OpenClaw selection', () => {
  const source = { agents: { defaults: { model: 'p/m' } }, models: { providers: { p: { models: [{ id: 'm' }] } } },
    plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'p/m' } } } } };
  assert.equal(chooseModels(source).agentId, 'main');
  source.agents.list = [{ id: 'Worker' }, { id: 'main' }];
  assert.equal(chooseModels(source).agentId, 'worker');
  assert.throws(() => chooseModels(source, { agent: false }), /nonempty string/);
});
test('plan redacts secrets while runtime plan retains required environment', () => {
  const input = { source: { apiKey: 'private-source' }, prompt: 'private-prompt', environment: { CUSTOM_API_KEY: 'private-key', JAVA_HOME: 'java' } };
  assert.equal(publicPlan(input).environment.CUSTOM_API_KEY, '[REDACTED]');
  assert.equal(publicPlan(input).environment.JAVA_HOME, 'java');
  assert.equal(publicPlan(input).source, undefined);
  assert.equal(executionPlan(input).environment.CUSTOM_API_KEY, 'private-key');
});
test('wrong Git, isolated TEMP override and nested output are rejected before a run', async () => {
  const f = await fixture();
  const badGit = f.content.replace(/  git:.*\n/, `  git: ${JSON.stringify(process.execPath.replaceAll('\\', '/'))}\n`);
  await fs.writeFile(f.machine, badGit);
  await assert.rejects(() => loadInputs(f.sample, f.machine), /not a working Git/);
  await fs.writeFile(f.machine, f.content + 'env:\n  TEMP: production-temp\n');
  await assert.rejects(() => loadInputs(f.sample, f.machine), /Unsupported environment/);
  await fs.writeFile(f.machine, f.content.replace('outputRoot: ./output', 'outputRoot: ./sample/project/runs'));
  await assert.rejects(() => loadInputs(f.sample, f.machine), /must not contain/);
});
test('unset environment paths, stale models and existing RC project config fail preflight', async () => {
  const f = await fixture();
  await fs.writeFile(f.machine, f.content.replace('sdk: ./sdk', 'sdk: ${RC_TEST_VAR_NEVER_SET_20261117}'));
  await assert.rejects(() => loadInputs(f.sample, f.machine), /is not set/);
  await fs.writeFile(f.machine, f.content + 'models:\n  reviewer: p/stale\n');
  await assert.rejects(() => loadInputs(f.sample, f.machine), /Unavailable configured reviewer/);
  await fs.writeFile(f.machine, f.content);
  await fs.mkdir(path.join(f.root, 'sample/project/.runtime-corrector'));
  await assert.rejects(() => loadInputs(f.sample, f.machine), /clean project/);
});
