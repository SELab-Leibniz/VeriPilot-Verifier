import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function blobs(buffer, count) {
  const output = []; let cursor = 0;
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf(10, cursor);
    if (end < 0) throw new Error('Truncated Git batch header');
    const header = buffer.subarray(cursor, end).toString('utf8');
    const match = /^[a-f0-9]+ blob (\d+)$/u.exec(header);
    if (!match) throw new Error(`Expected a source blob: ${header}`);
    const size = Number(match[1]), start = end + 1;
    if (!Number.isSafeInteger(size) || start + size >= buffer.length || buffer[start + size] !== 10)
      throw new Error('Truncated Git source blob');
    output.push(buffer.subarray(start, start + size).toString('utf8'));
    cursor = start + size + 1;
  }
  if (cursor !== buffer.length) throw new Error('Unexpected trailing Git batch output');
  return output;
}

/** Three Git processes for an entire artifact. Actual package files are still
 * read and compared every time; no unverified cache can bypass integrity. */
export async function verifyFrozenArtifact({ gitExecutable = 'git', cwd, reference, artifact }) {
  const startedAt = performance.now();
  const git = args => execFileSync(gitExecutable, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('Expected an immutable Git commit');
  const modules = JSON.parse(git(['show', `${commit}:packaging/runtime-modules.json`]));
  const files = [...modules.common, ...modules.openclaw];
  if (!files.length) throw new Error('Empty frozen artifact manifest');
  const root = path.resolve(artifact);
  for (const file of files) {
    if (typeof file !== 'string' || /[\r\n\0]/u.test(file) || path.isAbsolute(file)
      || file.split(/[\\/]/u).includes('..')) throw new Error('Unsafe source module path');
    const relative = path.relative(root, path.resolve(root, file));
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new Error('Source module escaped artifact');
  }
  const expected = blobs(execFileSync(gitExecutable, ['cat-file', '--batch'], { cwd, windowsHide: true,
    input: `${files.map(file => `${commit}:${file}`).join('\n')}\n`, maxBuffer: 32 * 1024 * 1024 }), files.length);
  const checks = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index], actual = await fs.readFile(path.join(root, file), 'utf8');
    if (expected[index].replaceAll('\r\n', '\n') !== actual.replaceAll('\r\n', '\n'))
      throw new Error(`Prebuilt artifact differs from baseline: ${file}`);
    checks.push({ file, actualSha256: createHash('sha256').update(actual).digest('hex') });
  }
  return { baselineRef: reference, baselineCommit: commit, checks, verificationMethod: 'git-cat-file-batch-v1',
    gitProcesses: 3, elapsedMs: performance.now() - startedAt };
}
