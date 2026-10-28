// Run identical specialty suites against original shared Git worktrees and the
// fusion. No checkout, repository copy, model verdict fabrication or host edit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const here = fileURLToPath(new URL('../', import.meta.url));
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const mode = arg('--mode') ?? 'before';
if (!['before', 'after'].includes(mode)) throw new Error('Expected --mode=before|after');
const directory = path.resolve(arg('--output') ?? `.runtime-correction/five-branch-fusion/${mode}-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const specifications = [
  ['stop', 'fusion-stop-review', 'codex/fuse-until-pass-workspace-review', ['stop-workspace-review', 'stop-fusion', 'multi-turn-requirements']],
  ['skill', 'skill-care-efficiency', 'codex/skill-care-efficiency', ['skill-care', 'runtime-v2', 'openclaw-session-projects']],
  ['document', 'document-corrector-efficiency', 'codex/document-corrector-efficiency', ['document-agent', 'document-agent-lifecycle']],
  ['baseline', 'baseline-extraction', 'codex/optimize-baseline-extraction', ['baseline-efficiency', 'stop-baseline-task', 'openclaw-review-activity']],
  ['console', 'rc-console-observability', 'codex/rc-console-observability', ['console-observations', 'post-run-controls']],
];
const results = [];
for (const [area, folder, branch, tests] of specifications) {
  const root = mode === 'after' ? here : path.resolve(here, '../../', folder, 'runtime-corrector-toy');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const command = ['--test', '--test-concurrency=1', ...tests.map(test => `test/${test}.test.mjs`)];
  const started = performance.now();
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, command, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 240_000);
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.once('error', error => output += error.stack);
    child.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, output }); });
  });
  await fs.writeFile(path.join(directory, `${area}.log`), result.output);
  const counts = Object.fromEntries([...result.output.matchAll(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped) (\d+)\r?$/gmu)].map(([, key, value]) => [key, Number(value)]));
  const row = { area, branch: mode === 'before' ? branch : 'codex/fuse-care-observability-baseline', source: root, sha, command, counts, code: result.code, timedOut: result.timedOut, elapsedMs: performance.now() - started };
  results.push(row); console.log(JSON.stringify(row));
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ kind: 'specialty-regression-comparison', mode, results, note: 'Programmed regression assertions; not a semantic model accuracy estimate. Suites share tests, so totals are not unique.' }, null, 2));
}
process.exitCode = results.every(row => row.code === 0 && !row.timedOut) ? 0 : 1;
