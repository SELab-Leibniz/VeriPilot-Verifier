// Repair candidate capture from frozen native receipts and workspace.patch.
// No model, new business run, live workspace diff, or original-file overwrite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { businessMutationPaths, validateBusinessMutationPaths } from './bench/business-mutations.mjs';
const arg = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
if (!arg('--run') || !arg('--output')) throw new Error('--run and a new --output directory required');
const directory = await fs.realpath(arg('--run'));
const files = ['manifest.json', 'result.json', 'workspace.patch', 'candidate.patch', 'inherited-business-scope.json'];
const source = Object.fromEntries(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(directory, file))])));
const manifest = JSON.parse(source['manifest.json']), result = JSON.parse(source['result.json']);
if (!Number.isSafeInteger(manifest.ownerPid) || manifest.ownerPid < 1) throw new Error('Missing original owner identity');
try { process.kill(manifest.ownerPid, 0); throw new Error('Original experiment owner is still alive'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
if (!['SETTLED', 'INCOMPLETE'].includes(result.state) || result.actualBusinessStart !== true || !result.sessionId
  || result.ownerPid !== manifest.ownerPid || result.instanceId !== manifest.instanceId
  || result.datasetDigest !== manifest.datasetDigest || result.projectRoot !== manifest.projectRoot
  || result.preparedHead !== manifest.preparedHead) throw new Error('Original business identity mismatch');
const projectRoot = await fs.realpath(manifest.projectRoot);
const transcriptName = `native-host/${result.sessionId}.jsonl`;
source[transcriptName] = await fs.readFile(path.join(directory, transcriptName));
const records = source[transcriptName].toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
const inherited = JSON.parse(source['inherited-business-scope.json']);
const mutationPaths = [...new Set([...validateBusinessMutationPaths(inherited.mutationPaths, projectRoot), ...businessMutationPaths(records, projectRoot)])].sort();
const output = path.resolve(arg('--output'));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output, { recursive: false });
const indexFile = path.join(output, 'capture.index');
const git = arg('--git') ?? (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');
const execute = args => execFileSync(git, ['--literal-pathspecs', '-C', projectRoot, ...args], {
  env: { ...process.env, GIT_INDEX_FILE: indexFile }, windowsHide: true, maxBuffer: 16 * 1024 * 1024
});
let patch;
try {
  if (execute(['rev-parse', 'HEAD']).toString().trim() !== manifest.preparedHead) throw new Error('Prepared business HEAD changed');
  execute(['read-tree', manifest.preparedHead]);
  if (source['workspace.patch'].length) execute(['apply', '--cached', '--binary', '--whitespace=nowarn', path.join(directory, 'workspace.patch')]);
  for (const file of mutationPaths) {
    const inIndex = execute(['ls-files', '-z', '--', file]).length > 0;
    let inBase = false;
    try { execute(['cat-file', '-e', `${manifest.preparedHead}:${file}`]); inBase = true; } catch { /* A captured addition need not exist at base. */ }
    if (!inIndex && !inBase) throw new Error(`Frozen workspace patch does not capture mutation: ${file}`);
  }
  patch = mutationPaths.length ? execute(['diff', '--cached', '--binary', '--no-ext-diff', manifest.preparedHead, '--', ...mutationPaths]) : Buffer.alloc(0);
} finally { await fs.rm(indexFile, { force: true }); }
// Reject a concurrently replaced source instead of blessing a mixed snapshot.
for (const [file, bytes] of Object.entries(source)) if (!(await fs.readFile(path.join(directory, file))).equals(bytes)) throw new Error(`Original capture changed: ${file}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = { kind: 'reconstructed-business-candidate', sourceRun: directory, instanceId: manifest.instanceId,
  datasetDigest: manifest.datasetDigest, preparedHead: manifest.preparedHead, sessionId: result.sessionId,
  createdAt: new Date().toISOString(), sourceSha256: Object.fromEntries(Object.entries(source).map(([file, bytes]) => [file, sha(bytes)])),
  mutationPaths, candidateSha256: sha(patch), patchBytes: patch.length,
  exporterSha256: sha(await fs.readFile(new URL(import.meta.url))),
  mutationAttributionSha256: sha(await fs.readFile(new URL('./bench/business-mutations.mjs', import.meta.url))),
  basis: 'Frozen workspace.patch selected by successful native mutation receipts and inherited scope; original run, candidate and grade remain immutable. No new model work or verdict is inferred.' };
await fs.writeFile(path.join(output, 'candidate.patch'), patch, { flag: 'wx' });
await fs.writeFile(path.join(output, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, mutationPaths, patchBytes: patch.length, candidateSha256: proof.candidateSha256 }));
