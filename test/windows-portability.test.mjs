import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { json } from '../lib/files.mjs';
import { queryExperimentStatus } from '../lib/experiment-status.mjs';

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
    const execution = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { cwd: folder, windowsHide: true, timeout: 160000, env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigFile,
        OPENCLAW_PROFILE: 'unrelated-production-profile', OPENCLAW_GATEWAY_TOKEN: 'must-not-be-used' }, maxBuffer: 2 * 1024 * 1024 });
    let done = false; const observed = new Map();
    execution.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      try {
        const [name] = await fs.readdir(path.join(folder, 'runs'));
        const status = await json(path.join(folder, 'runs', name, 'experiment-status.json'));
        observed.set(status.phase, { phase: status.phase, status: status.status, terminal: status.terminal, canScheduleNext: status.canScheduleNext });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const { stdout } = await execution;
    assert.match(stdout, /PREPARED:/);
    const [name] = await fs.readdir(path.join(folder, 'runs'));
    const runDir = path.join(folder, 'runs', name), record = await json(path.join(runDir, 'run.json'));
    const result = await json(path.join(runDir, 'result.json'));
    assert.equal(result.noModelDispatch, true); assert.equal(result.gatewayRetained, false);
    assert.equal(record.identity.agentId, 'main'); assert.equal(record.firstRunId, undefined);
    assert.ok([...observed.values()].some(s => s.status === 'PREPARING' && !s.terminal && !s.canScheduleNext));
    const status = await queryExperimentStatus(runDir);
    assert.equal(status.status, 'PREPARED'); assert.equal(status.terminal, true); assert.equal(status.canScheduleNext, true);
    assert.equal(status.observer.state, 'STOPPED');
    const { stdout: queryJson } = await execute(process.execPath, [path.join(root, 'scripts/experiment-status.mjs'), runDir], { windowsHide: true, timeout: 10000 });
    assert.equal(JSON.parse(queryJson).status, 'PREPARED');
    console.log(`Native status transitions: ${JSON.stringify([...observed.values()])}`);
    assert.equal(await fs.readFile(gitConfigFile, 'utf8'), gitConfig);
    const cfg = await json(record.configPath);
    assert.ok(cfg.plugins.entries['runtime-corrector'].config.businessRunTimeoutMs > 0);
    assert.ok(cfg.plugins.entries['runtime-corrector'].config.businessRunTimeoutMs <= record.input.execution.maxRuntimeMs);
    assert.equal(cfg.agents.defaults.workspace, record.seedRoot);
    assert.equal(cfg.agents.defaults.timeoutSeconds, Math.ceil(record.input.execution.maxRuntimeMs / 1000));
    const log = await fs.readFile(path.join(runDir, 'logs/gateway.stdout.log'), 'utf8');
    assert.equal(log.includes('[model-fetch] start'), false);
    await assert.rejects(() => fs.stat(path.join(runDir, 'rc-status/send-receipt.json')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(folder, 'Microsoft/Windows/PowerShell/ModuleAnalysisCache')), /ENOENT/);
    console.log(`Windows zero-model qualification artifacts: ${runDir}`);
    // The same public CLI must classify a preparation deadline as a timeout,
    // before any Gateway/session/model can be allocated.
    const tinySample = path.join(folder, 'case/prepare-timeout.yaml');
    await fs.writeFile(tinySample, (await fs.readFile(path.join(folder, 'case/experiment.yaml'), 'utf8')) + 'execution:\n  maxRuntimeMs: 1\n');
    const tinyCommand = command.replace(ps(path.join(folder, 'case/experiment.yaml')), ps(tinySample));
    let timed;
    try {
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(tinyCommand, 'utf16le').toString('base64')],
        { cwd: os.tmpdir(), windowsHide: true, timeout: 20000 });
      assert.fail('Expected timeout exit code');
    } catch (error) {
      assert.equal(error.code, 4);
      const directory = error.stdout.match(/^Run: (.+)\r?$/m)?.[1]?.trim();
      assert.ok(directory); timed = await json(path.join(directory, 'run.json'));
      const result = await json(path.join(directory, 'result.json'));
      assert.equal(result.status, 'TIMED_OUT'); assert.equal(result.cleanupConfirmed, true);
      assert.equal(timed.gatewayPid, undefined); assert.equal(timed.firstRunId, undefined);
      const status = await queryExperimentStatus(directory);
      assert.equal(status.status, 'TIMED_OUT'); assert.equal(status.canScheduleNext, true);
      console.log(`Windows preparation deadline artifacts: ${directory}`);
    }
  });
