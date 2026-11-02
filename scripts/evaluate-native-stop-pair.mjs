// Real normal delivery and one injected-fault repair, on the same built plugin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeStopTimeouts } from './helpers/native-stop-timeouts.mjs';
import { buildPlugin } from '../lib/plugin-builder.mjs';

const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${flag} value`);
  return args[index + 1];
}
const hostRoot = value('--host-root');
if (!hostRoot) throw new Error('Use --host-root <installed OpenClaw 2026.7.1-2>. This command calls real models.');
const timeoutMs = nativeStopTimeouts(Number(value('--timeout-ms', '1200000'))).wallMs;
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.resolve(value('--output', path.join(sourceRoot, '.runtime-correction',
  'stop-e2e', new Date().toISOString().replaceAll(/[:.]/gu, '-'))));
if (await fs.stat(outputRoot).catch(() => null)) throw new Error('Choose a new output directory; previous evidence is preserved.');
const codingPlan = args.includes('--coding-plan');
for (const name of codingPlan ? ['RC_EVAL_API_KEY'] : ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name}`);
if (!(process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL)?.trim()) throw new Error('Missing native model');
await fs.mkdir(outputRoot, { recursive: true });
const artifact = await buildPlugin({ host: 'openclaw', sourceRoot, outputRoot: path.join(outputRoot, 'build') });
let child, cancelled = false;
const cancel = () => { cancelled = true; child?.kill('SIGTERM'); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const cases = [];
try {
  for (const name of ['normal', 'fault']) {
    if (cancelled) break;
    const output = path.join(outputRoot, name);
    const options = [path.join(sourceRoot, 'scripts/evaluate-native-stop-loop.mjs'), '--live', '--initial-turn',
      '--host-root', path.resolve(hostRoot), '--artifact', artifact, '--timeout-ms', String(timeoutMs), '--output', output,
      ...(codingPlan ? ['--coding-plan'] : []), ...(name === 'fault' ? ['--inject-defect'] : [])];
    const startedAt = Date.now();
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, options, { stdio: 'inherit' });
      child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    child = null;
    const result = await fs.readFile(path.join(output, 'result.json'), 'utf8').then(JSON.parse, () => null);
    const closure = await fs.readFile(path.join(output, 'closure.json'), 'utf8').then(JSON.parse, () => null);
    const complete = exitCode === 0 && result?.complete === true && closure?.gatewayClosed === true;
    cases.push({ name, complete, exitCode, elapsedMs: Date.now() - startedAt, output,
      verification: result?.verification ?? null, used: result?.used ?? null,
      error: result?.error ?? result?.earlyTermination ?? null, gatewayClosed: closure?.gatewayClosed === true });
    // A failed normal control is evidence to fix, not a reason to keep spending
    // requests on a more complex fault control with the same broken dependency.
    if (!complete) break;
  }
} finally {
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  const complete = cases.length === 2 && cases.every(item => item.complete);
  const report = { complete, cancelled, timeoutMsPerCase: timeoutMs, artifact, cases, outputRoot };
  await fs.writeFile(path.join(outputRoot, 'pair-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!complete) process.exitCode = 1;
}
