#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInputs } from '../lib/config.mjs';
import { buildSecurityTool2Demo } from '../lib/demo-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name); if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  const value = args[at + 1]; args.splice(at, 2); return value;
}
try {
  if (args.includes('--help')) console.log('node scripts/build-security-tool-2-demo.mjs [--machine machine.yaml] [--out dist/security-tool-2-demo]');
  else {
    const machine = option('--machine', path.join(root, 'machine.yaml'));
    const outDir = option('--out', path.join(root, 'dist/security-tool-2-demo'));
    if (args.length) throw new Error('Unknown arguments; see --help');
    const input = await loadInputs(path.join(root, 'demos/security-tool-2/experiment.yaml'), machine);
    const result = await buildSecurityTool2Demo({ packageFile: input.paths.rcPluginPackage, outDir, git: input.paths.git });
    console.log(`Demo: ${result.outDir}\nArchive: ${result.zip}\nExperiment program: ${result.runnerCommit}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
