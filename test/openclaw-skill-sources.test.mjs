import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as openclaw from '../lib/hosts/openclaw.mjs';
import { selectedSkillRead } from '../lib/openclaw/tools.mjs';
import { bindSkillGraph, resolveSkillDirectory, retainedSkillSourceIdentity, scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { skillGraphCandidate } from './helpers/skill-source-interpretation.mjs';
import { persistSkillGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sharedOriginalBasis } from '../lib/runtime-v2/baseline-shared-basis.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-ma-skill-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'workspace'), pluginRoot = path.join(root, 'rc');
  const hostOptions = { homeDirectory: path.join(root, 'home'), hostRoot: path.join(root, 'openclaw'),
    config: { skills: { load: { extraDirs: [path.join(root, 'extra'), '~/extra-skills'] } } } };
  const roots = openclaw.localSkillRoots({ projectRoot, pluginRoot, ...hostOptions });
  const write = async (directory, text = 'Verify the current delivery.\n') => {
    await fs.mkdir(directory, { recursive: true }); const file = path.join(directory, 'SKILL.md');
    await fs.writeFile(file, text); return await fs.realpath(file);
  };
  return { root, projectRoot, pluginRoot, hostOptions, roots, write };
}

test('OpenClaw Skill roots follow host priority and include configured, bundled and plugin sources', async t => {
  const f = await fixture(t), { projectRoot, pluginRoot, hostOptions, roots } = f, home = hostOptions.homeDirectory;
  assert.deepEqual(roots, [path.join(projectRoot, 'skills'), path.join(projectRoot, '.agents/skills'),
    path.join(home, '.agents/skills'), path.join(home, '.openclaw/skills'), path.join(hostOptions.hostRoot, 'skills'),
    path.join(f.root, 'extra'), path.join(home, 'extra-skills'), path.join(home, '.openclaw/plugin-skills'), path.join(pluginRoot, 'skills')]);
  for (const root of roots) await f.write(path.join(root, 'demo'), `---\nname: demo\n---\nVerify ${root}.\n`);
  for (const root of roots) {
    const actual = await resolveSkillDirectory({ skillId: 'demo', projectRoot, pluginRoot, hostAdapter: openclaw, hostOptions,
      configuredRoots: [roots.at(-1)] });
    assert.equal(actual, await fs.realpath(path.join(root, 'demo')));
    await fs.rm(path.join(root, 'demo'), { recursive: true });
  }
});

test('bundled Skills are found from the running OpenClaw package without a configured root', async t => {
  const f = await fixture(t), entry = path.join(f.hostOptions.hostRoot, 'dist/entry.mjs');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(path.join(f.hostOptions.hostRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version: openclaw.targetVersion }));
  await fs.writeFile(entry, `import {localSkillRoots} from ${JSON.stringify(pathToFileURL(path.resolve('lib/hosts/openclaw.mjs')).href)};
console.log(JSON.stringify(localSkillRoots(${JSON.stringify({ projectRoot: f.projectRoot, pluginRoot: f.pluginRoot, homeDirectory: f.hostOptions.homeDirectory })})));\n`);
  const roots = JSON.parse(execFileSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true }));
  assert(roots.includes(path.join(f.hostOptions.hostRoot, 'skills')));
});

test('each plugin Junction and bundled Skill is recognized by its exact physical source', async t => {
  const f = await fixture(t), links = path.join(f.hostOptions.homeDirectory, '.openclaw/plugin-skills');
  await fs.mkdir(links, { recursive: true });
  for (let index = 0; index < 16; index++) {
    const name = `plugin-${index}`, file = await f.write(path.join(f.root, 'external', name), `Verify plugin ${index}.\n`);
    await fs.symlink(path.dirname(file), path.join(links, name), process.platform === 'win32' ? 'junction' : 'dir');
    const selected = await selectedSkillRead('read', { path: file }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions);
    assert.deepEqual(selected, { skillId: name, sourceIdentity: { path: file, sha256: sha256(await fs.readFile(file)) } });
    const viaLink = await selectedSkillRead('read', { path: path.join(links, name, 'SKILL.md') }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions);
    assert.deepEqual(viaLink, selected);
  }
  for (const name of ['bundled-a', 'bundled-b']) {
    const file = await f.write(path.join(f.hostOptions.hostRoot, 'skills', name));
    assert.equal((await selectedSkillRead('read', { path: file }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions)).skillId, name);
  }
});

test('grouped Skills preserve their name and an execution workspace supplies its own .agents source', async t => {
  const f = await fixture(t), file = await f.write(path.join(f.projectRoot, 'skills/group/demo'));
  const selected = await selectedSkillRead('read', { path: file }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions);
  assert.equal(selected.skillId, 'group/demo');
  assert.equal(await resolveSkillDirectory({ skillId: selected.skillId, projectRoot: f.projectRoot, pluginRoot: f.pluginRoot,
    hostAdapter: openclaw, hostOptions: f.hostOptions }), path.dirname(file));
  const workspace = path.join(f.root, 'execution'), named = await f.write(path.join(workspace, '.agents/skills/group/named'), '---\nname: host-name\n---\nVerify output.\n');
  assert.equal((await selectedSkillRead('read', { filePath: named }, { projectRoot: f.projectRoot, executionDirectory: workspace },
    f.pluginRoot, [], f.hostOptions)).skillId, 'host-name');
});

test('a successful actual read binds the lower-priority original through graph and rejects later replacement', async t => {
  const f = await fixture(t), primary = await f.write(path.join(f.projectRoot, 'skills/demo'), 'Follow the workspace instructions.\n');
  const original = await f.write(path.join(f.root, 'extra/demo'), 'Follow the selected plugin instructions.\n');
  const selected = await selectedSkillRead('read', { path: original }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions);
  const options = { skillId: 'demo', projectRoot: f.projectRoot, pluginRoot: f.pluginRoot, hostAdapter: openclaw, hostOptions: f.hostOptions };
  assert.equal(await resolveSkillDirectory(options), path.dirname(primary));
  assert.equal(await resolveSkillDirectory({ ...options, sourceIdentity: selected.sourceIdentity }), path.dirname(original));
  const source = await scanSkillDirectory(path.dirname(original), { sourceIdentity: selected.sourceIdentity });
  const graph = bindSkillGraph(skillGraphCandidate(source), source);
  assert.deepEqual(graph.sourceContract.sourceIdentity, selected.sourceIdentity);
  const taskState = await ensureTask({ projectRoot: f.projectRoot, sessionId: 'source-binding' });
  const { document } = await persistSkillGroundTruth({ projectRoot: f.projectRoot, taskId: taskState.taskId,
    skillId: selected.skillId, skillDigest: source.digest, ...graph });
  const population = await buildMetricPopulation({ projectRoot: f.projectRoot, taskId: taskState.taskId,
    groundTruth: { version: 0, claims: [] }, skillDocuments: [document] });
  assert(population.metrics.M08.length > 0);
  assert.deepEqual(population.metrics.M08[0].skillSourceIdentity, selected.sourceIdentity);
  assert.equal(population.metrics.M08[0].skillGraphDigest, document.digest);
  const runtimeV2 = compileRuntimeV2Config({ version: 2, skillCorrection: { enabled: true } },
    { policyRoot: path.join(f.projectRoot, '.runtime-corrector') });
  const basisOptions = { projectRoot: f.projectRoot, pluginRoot: f.pluginRoot, task: taskState,
    snapshot: { entries: [] }, materials: { entries: [] }, runtimeV2 };
  const basis = await sharedOriginalBasis({ ...basisOptions, skill: { skillId: selected.skillId, directory: path.dirname(original), source } });
  assert.deepEqual(basis.adoptedSkills[0].sourceIdentity, selected.sourceIdentity);
  const recovered = await sharedOriginalBasis(basisOptions);
  assert.deepEqual(recovered.adoptedSkills[0].sourceIdentity, selected.sourceIdentity,
    'restoring from the bound graph must not resolve the duplicate short name again');
  const identical = await f.write(path.join(f.root, 'other/demo'), source.files[0].content);
  const otherSource = await scanSkillDirectory(path.dirname(identical), { sourceIdentity: { path: identical, sha256: selected.sourceIdentity.sha256 } });
  assert.notEqual(bindSkillGraph(skillGraphCandidate(otherSource), otherSource).sourceContract.digest, graph.sourceContract.digest,
    'same bytes at another path must not reuse the original graph binding');
  const task = { watchers: { old: { skillId: 'demo', status: 'COMPLETED', sourceIdentity: { path: primary } },
    current: { skillId: 'demo', status: 'ACTIVE', sourceIdentity: selected.sourceIdentity } } };
  assert.deepEqual(retainedSkillSourceIdentity(task, 'demo'), selected.sourceIdentity);
  await fs.writeFile(original, 'Changed after the host read.\n');
  assert.equal(await resolveSkillDirectory({ ...options, sourceIdentity: selected.sourceIdentity }), null);
  await assert.rejects(scanSkillDirectory(path.dirname(original), { sourceIdentity: selected.sourceIdentity }), { code: 'SKILL_SOURCE_STALE' });
});

test('cyclic directory aliases are bounded and an unregistered SKILL.md remains unavailable', async t => {
  const f = await fixture(t), root = path.join(f.projectRoot, 'skills');
  await fs.mkdir(root, { recursive: true });
  await fs.symlink(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const foreign = await f.write(path.join(f.root, 'foreign'));
  await fs.symlink(path.dirname(foreign), path.join(root, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await selectedSkillRead('read', { path: foreign }, { projectRoot: f.projectRoot }, f.pluginRoot, [], f.hostOptions), null);
});
