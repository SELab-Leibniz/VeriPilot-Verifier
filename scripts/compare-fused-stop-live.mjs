// Fresh paired production-Stop probes against the requested original branch.
// Only generated tiny business fixtures and normal release bundles are written.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const fused = fileURLToPath(new URL('../', import.meta.url));
const before = path.resolve(arg('--before') ?? path.join(fused, '../../fusion-stop-review/runtime-corrector-toy'));
const host = arg('--host-root'); if (!host) throw new Error('--host-root=<read-only-installed-openclaw> required');
const root = path.resolve(arg('--output') ?? `.runtime-correction/five-branch-fusion/stop-live-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const digest = async source => {
  const files = execFileSync('git', ['ls-files', 'lib', 'knowledge', 'skills', 'packaging', 'config'], { cwd: source, encoding: 'utf8' }).trim().split('\n').sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(await fs.readFile(path.join(source, file))); }
  return hash.digest('hex');
};
const sources = Object.fromEntries(await Promise.all([['before', before], ['fused', fused]].map(async ([arm, source]) => [arm, {
  source, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), runtimeDigest: await digest(source),
}])));
const rows = [];
const cases = ['correct', 'hidden', 'execution', 'optional', 'six', 'external'].filter(id => !arg('--case') || id === arg('--case'));
if (!cases.length) throw new Error('Unknown --case');
for (const [index, scenario] of cases.entries()) {
  for (const arm of index % 2 ? ['fused', 'before'] : ['before', 'fused']) {
    const output = path.join(root, `${scenario}-${arm}`);
    const command = [path.join(fused, 'scripts/evaluate-branch-fusion.mjs'), '--live', '--source', sources[arm].source,
      '--output', output, '--host-root', host, '--case', scenario];
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, command, { cwd: fused, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true;
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill();
      }, 270000);
      child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
      child.once('error', error => log += error.message);
      child.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, log }); });
    });
    // Existing harness redacts provider credentials in its report. Raw local
    // logs remain ignored; only explicitly selected fields enter public docs.
    await fs.writeFile(path.join(root, `${scenario}-${arm}.log`), result.log);
    const report = await fs.readFile(path.join(output, 'result.json'), 'utf8').then(JSON.parse, () => null);
    const row = { arm, scenario, code: result.code, timedOut: result.timedOut, report };
    rows.push(row);
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({ kind: 'fresh-paired-production-stop', sources, rows,
      caveats: 'One sample per case per arm; alternating order. Programmed fixtures, real review model. No natural business-model error or installed desktop UI claim.' }, null, 2));
    console.log(JSON.stringify({ arm, scenario, code: row.code, match: report?.match, status: report?.status, elapsedMs: report?.elapsedMs, tokens: report?.hostTokenCounters }));
  }
}
if (sources.fused.runtimeDigest !== await digest(fused)) throw new Error('Fusion runtime changed during live comparison');
process.exitCode = rows.every(row => row.code === 0 && row.report?.match && !row.timedOut) ? 0 : 1;
