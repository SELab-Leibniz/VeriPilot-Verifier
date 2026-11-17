#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadInputs } from '../lib/config.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const args = process.argv.slice(2), native = args.includes('--native');
  const at = args.indexOf('--machine'); let machine = path.join(root, 'machine.yaml');
  if (at >= 0) {
    if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error('Missing --machine value');
    machine = args[at + 1]; args.splice(at, 2);
  }
  if (args.some(arg => arg !== '--native')) throw new Error('Usage: node scripts/test.mjs [--native] [--machine machine.yaml]');
  const env = { ...process.env };
  delete env.RC_TEST_HOST_ROOT; delete env.RC_TEST_PACKAGE;
  if (native) {
    if (process.platform !== 'win32') throw new Error('Native portability qualification requires Windows');
    const input = await loadInputs(path.join(root, 'examples/quicksort/experiment.yaml'), machine);
    env.RC_TEST_HOST_ROOT = input.paths.openclawRoot; env.RC_TEST_PACKAGE = input.paths.rcPluginPackage;
  }
  const files = (await fs.readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(root, 'test', name));
  const child = spawn(process.execPath, ['--test', ...files], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} catch (error) { console.error(error.message); process.exitCode = 1; }
