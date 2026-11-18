import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set(['.git', '.hvigor', '.test', '.runtime-correction', '.runtime-corrector',
  '.openclaw', 'build', 'oh_modules', 'node_modules', '.env', '.npmrc', '.ohpmrc', '.ds_store']);

// Copy regular project files only. The digest binds relative paths and exact
// bytes; it works across different mount points on the coordinator and worker.
export async function copyArktsPublicTestSnapshot(source, destination, { signal } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  async function walk(relative) {
    signal?.throwIfAborted();
    if (destination) await fs.mkdir(path.join(destination, relative));
    hash.update(JSON.stringify([relative, 'directory']) + '\n');
    const names = (await fs.readdir(path.join(source, relative))).sort();
    for (const name of names) {
      signal?.throwIfAborted();
      const lower = name.toLowerCase();
      if (excluded.has(lower) || lower.startsWith('.env.')) continue;
      assert(!/[\\:\0]/u.test(name) && !/[. ]$/u.test(name), 'Unsupported path in an ArkTS public test snapshot');
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(source, child);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        await walk(child);
        continue;
      }
      assert(stat.isFile(), 'Public test snapshots require regular files');
      bytes += stat.size;
      assert(bytes <= 256 * 1024 * 1024, 'ArkTS public test snapshot exceeds 256 MiB');
      const body = await fs.readFile(file, { signal });
      assert.equal(body.length, stat.size, 'Public test source changed while copying');
      hash.update(JSON.stringify([child, body.length]) + '\n').update(body);
      if (destination) await fs.writeFile(path.join(destination, child), body, { flag: 'wx', mode: stat.mode & 0o777 });
    }
  }
  assert((await fs.lstat(source)).isDirectory(), 'Public test snapshot root must be a directory');
  await walk('');
  return hash.digest('hex');
}
