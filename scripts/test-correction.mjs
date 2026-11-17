#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs } from '../lib/config.mjs';
import { run, experimentExitCode } from '../lib/runner.mjs';
import { copyTree, json, writeJson, manifest, redact } from '../lib/files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
try {
  const args = process.argv.slice(2), prepareOnly = args.includes('--prepare-only'), withoutFrame = args.includes('--without-frame');
  const files = args.filter(arg => !['--prepare-only', '--without-frame'].includes(arg));
  if (files.length > 1) throw new Error('Usage: node scripts/test-correction.mjs [machine.yaml] [--prepare-only] [--without-frame]');
  const machineFile = files[0] ?? path.join(root, 'machine.yaml');
  const sample = withoutFrame ? 'experiment-no-frame.yaml' : 'experiment.yaml';
  const input = await loadInputs(path.join(root, 'examples/quicksort-correction', sample), machineFile);
  const { record, result } = await run(input, { prepareOnly, shouldStop: () => stop,
    async beforeStart(record) {
      const pluginRoot = path.join(record.runDir, 'runtime/correction-fixture');
      await copyTree(path.join(root, 'test/support/correction-fixture'), pluginRoot);
      const cfg = await json(record.configPath);
      cfg.plugins.allow.push('rc-correction-fixture'); cfg.plugins.load.paths.push(pluginRoot);
      cfg.plugins.entries['rc-correction-fixture'] = { enabled: true, config: { runDir: record.runDir },
        hooks: { allowConversationAccess: true, allowPromptInjection: true } };
      await writeJson(record.configPath, cfg);
      await writeJson(path.join(record.runDir, 'config/host.redacted.json'), redact(cfg));
      record.fixture = { kind: 'single controlled defect', pluginRoot, files: await manifest(pluginRoot) };
    },
    async beforeDispatch(record) {
      const loaded = await json(path.join(record.runDir, 'rc-status/fault-fixture-loaded.json'));
      if (loaded.pid !== record.gatewayPid) throw new Error('Fixture not loaded by the actual Gateway; no model task submitted');
    }
  });
  console.log(`${result.status}: ${record.runDir}`);
  process.exitCode = experimentExitCode(result);
} catch (e) { console.error(e.message); process.exitCode = 1; }
