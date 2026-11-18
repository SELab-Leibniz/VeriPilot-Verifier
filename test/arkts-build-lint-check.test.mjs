import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readArktsLintRequirement, runArktsRequiredLint } from '../scripts/bench/arkts-build-lint-check.mjs';
import { copyArktsPublicTestSnapshot } from '../scripts/bench/arkts-public-test-snapshot.mjs';

const buildReceipt = { exitCode: 0, outputComplete: true, interrupted: false, hapSha256: 'a'.repeat(64) };

async function prepare(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rc-build-lint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'After a successful HAP build, run CodeLinter: `codelinter -c ./code-linter.json5 . --fix`\n');
  await fs.writeFile(path.join(project, 'code-linter.json5'), '{}\n');
  const requirement = await readArktsLintRequirement(project);
  return { projectRoot: project, outputRoot: root, requirement, timeoutMs: 10_000 };
}

test('one receipt binds build then lint to the same public project snapshot', async t => {
  const options = await prepare(t);
  assert.equal(options.requirement.source, 'AGENTS.md');
  const snapshotSha256 = await copyArktsPublicTestSnapshot(options.projectRoot);
  const calls = [];
  const result = await runArktsRequiredLint(options, {
    build: async () => { calls.push('build'); return buildReceipt; },
    lint: async ({ configSha256 }) => {
      calls.push('lint');
      assert.equal(configSha256, options.requirement.configSha256);
      return { status: 'PASS', confirmed: true, snapshotSha256 };
    },
  });
  assert.deepEqual(calls, ['build', 'lint']);
  assert.equal(result.success, true);
  assert.equal(result.snapshotSha256, snapshotSha256);
  assert.equal(result.build.hapSha256, buildReceipt.hapSha256);
  const receipt = (await fs.readdir(options.outputRoot)).find(name => name.startsWith('required-lint-'));
  assert.equal(JSON.parse(await fs.readFile(path.join(options.outputRoot, receipt, 'result.json'))).success, true);
});

test('no success is inferred from an inconclusive build, missing linter, or changed input', async t => {
  const options = await prepare(t);
  const lint = async () => assert.fail('lint must follow a successful fresh build on the same snapshot');
  const check = dependencies => runArktsRequiredLint(options, { lint, ...dependencies });
  const failedBuild = await check({ build: async () => ({ ...buildReceipt, hapSha256: null, exitCode: 1 }) });
  assert.equal(failedBuild.status, 'FAIL');
  assert.equal(failedBuild.reason, 'REQUIRED_HAP_BUILD_FAILED');
  const noHap = await check({ build: async () => ({ ...buildReceipt, hapSha256: null }) });
  assert.equal(noHap.status, 'INCOMPLETE');
  assert.equal(noHap.reason, 'REQUIRED_HAP_BUILD_UNVERIFIED');
  const changed = await check({ build: async () => {
    await fs.writeFile(path.join(options.projectRoot, 'main.ets'), 'changed build input');
    return buildReceipt;
  } });
  assert.equal(changed.reason, 'REQUIRED_LINT_BUILD_INPUT_CHANGED');
  const snapshotSha256 = await copyArktsPublicTestSnapshot(options.projectRoot);
  const unverified = await check({ build: async () => buildReceipt,
    lint: async () => ({ status: 'INCOMPLETE', confirmed: false, reason: 'LINTER_AGGREGATE_MISMATCH', snapshotSha256 }) });
  assert.equal(unverified.success, false);
  assert.equal(unverified.reason, 'LINTER_AGGREGATE_MISMATCH');
  const stale = await check({ build: async () => buildReceipt,
    lint: async () => ({ status: 'PASS', confirmed: true, snapshotSha256: 'b'.repeat(64) }) });
  assert.equal(stale.reason, 'REQUIRED_LINT_INPUT_UNVERIFIED');
});
