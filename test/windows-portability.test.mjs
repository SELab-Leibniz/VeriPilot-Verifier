import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { json } from '../lib/files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const enabled = process.platform === 'win32' && process.env.RC_TEST_HOST_ROOT && process.env.RC_TEST_PACKAGE;
test('Windows PowerShell 5.1: Chinese/spaced paths, JSON5 profile, implicit main, poisoned old profile and global Git hooks/signing',
  { skip: !enabled, timeout: 180000 }, async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'RC 迁移 验证-'));
    await fs.mkdir(path.join(folder, 'case/project'), { recursive: true });
    await fs.mkdir(path.join(folder, 'state'));
    await fs.writeFile(path.join(folder, 'case/project/input.md'), 'Offline qualification fixture.\n');
    await fs.writeFile(path.join(folder, 'case/prompt.md'), 'This task must not be submitted in prepare-only mode.');
    await fs.copyFile(path.join(root, 'examples/quicksort/rc-config.yaml'), path.join(folder, 'case/rc-config.yaml'));
    await fs.writeFile(path.join(folder, 'case/experiment.yaml'),
      'version: 1\nid: windows-portability\nprojectDir: ./project\npromptFile: ./prompt.md\nrcConfigFile: ./rc-config.yaml\n');
    const profile = `// JSON5 profile without explicit agents.list (implicit main)\n{
      agents: { defaults: { model: 'fixture/offline-model' } },
      models: { providers: { fixture: { baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
        apiKey: 'offline-test-placeholder', models: [{ id: 'offline-model', name: 'Offline fixture' }], } } },
      plugins: { entries: { 'runtime-corrector': { config: { reviewerModel: 'fixture/offline-model' } } } },
    }\n`;
    await fs.writeFile(path.join(folder, 'host.json5'), profile);
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    const quoted = value => JSON.stringify(value.replaceAll('\\', '/'));
    await fs.writeFile(path.join(folder, 'machine.yaml'), `version: 1\npaths:
  node: ${quoted(process.execPath)}
  git: ${quoted(git)}
  openclawRoot: ${quoted(process.env.RC_TEST_HOST_ROOT)}
  rcPluginPackage: ${quoted(process.env.RC_TEST_PACKAGE)}
  hostConfig: ./host.json5
  hostState: ./state
  outputRoot: ./runs
harmony:
  sdk: ""
extraPath: []
`);
    const badHooks = path.join(folder, 'global-hooks'); await fs.mkdir(badHooks);
    await fs.writeFile(path.join(badHooks, 'pre-commit'), '#!/bin/sh\nexit 99\n');
    const gitConfig = '[commit]\n  gpgsign = true\n[core]\n  hooksPath = ' + quoted(badHooks) + '\n';
    const gitConfigFile = path.join(folder, 'global.gitconfig'); await fs.writeFile(gitConfigFile, gitConfig);
    const ps = value => "'" + value.replaceAll("'", "''") + "'";
    const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & ${ps(process.execPath)} ${ps(path.join(root, 'scripts/run-experiment.mjs'))} ${ps(path.join(folder, 'case/experiment.yaml'))} --machine ${ps(path.join(folder, 'machine.yaml'))} --prepare-only; exit $LASTEXITCODE`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { cwd: os.tmpdir(), windowsHide: true, timeout: 160000, env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigFile,
        OPENCLAW_PROFILE: 'unrelated-production-profile', OPENCLAW_GATEWAY_TOKEN: 'must-not-be-used' }, maxBuffer: 2 * 1024 * 1024 });
    assert.match(stdout, /PREPARED:/);
    const [name] = await fs.readdir(path.join(folder, 'runs'));
    const runDir = path.join(folder, 'runs', name), record = await json(path.join(runDir, 'run.json'));
    const result = await json(path.join(runDir, 'result.json'));
    assert.equal(result.noModelDispatch, true); assert.equal(result.gatewayRetained, false);
    assert.equal(record.identity.agentId, 'main'); assert.equal(record.firstRunId, undefined);
    assert.equal(await fs.readFile(gitConfigFile, 'utf8'), gitConfig);
    const cfg = await json(record.configPath);
    assert.equal(cfg.plugins.entries['runtime-corrector'].config.businessRunTimeoutMs, 0);
    assert.equal(cfg.agents.defaults.workspace, record.seedRoot);
    const log = await fs.readFile(path.join(runDir, 'logs/gateway.stdout.log'), 'utf8');
    assert.equal(log.includes('[model-fetch] start'), false);
    await assert.rejects(() => fs.stat(path.join(runDir, 'rc-status/send-receipt.json')), /ENOENT/);
    console.log(`Windows zero-model qualification artifacts: ${runDir}`);
  });
