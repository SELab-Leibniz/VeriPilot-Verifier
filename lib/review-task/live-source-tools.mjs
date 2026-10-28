// Read the real workspace on demand. Paths select evidence; they do not define
// a permission boundary. The operating system/host still owns access rights.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourcePage, textBlocks } from './source-tools.mjs';

const navigation = value => ({ content: textBlocks(JSON.stringify({ navigationOnly: true, ...value })), details: {} });
const usualGenerated = new Set(['.git', 'node_modules', '.runtime-correction']);

export function createLiveSourceTools(cwd, { onDirectory = () => {}, onSearchFile = () => {}, onPath = () => {} } = {}) {
  return ['read', 'grep', 'find', 'ls'].map(name => ({
    name, label: `Workspace ${name}`,
    description: name === 'read'
      ? 'Read original UTF-8 file lines. Absolute paths, parent paths and linked files are supported. Follow nextOffset for more lines. Only observed read receipts grant citations.'
      : 'Navigate original files. Absolute and parent paths are supported. Results are navigation hints, not citations. grep matches literal text; find matches path fragments. Use offset to page; includeGenerated also searches dependency and RC output directories.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string' }, offset: { type: 'integer', minimum: name === 'read' ? 1 : 0 },
      limit: { type: 'integer', minimum: 1, maximum: name === 'read' ? 400 : 100 },
      ...(name !== 'read' ? { includeGenerated: { type: 'boolean' } } : {}),
      ...(['grep', 'find'].includes(name) ? { pattern: { type: 'string', minLength: 1, maxLength: 500 } } : {}),
    } },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const requested = path.resolve(cwd, args.path ?? '.'), absolute = await fs.realpath(requested);
      await onPath(requested, absolute);
      if (name === 'read') return sourcePage(await fs.readFile(absolute, { signal }), args);
      if (['grep', 'find'].includes(name) && (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 500))
        throw new Error('A short literal pattern is required');
      const offset = args.offset ?? 0, limit = args.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid navigation page');
      const visited = new Set();
      async function* walk(file) {
        signal?.throwIfAborted();
        const real = await fs.realpath(file);
        await onPath(file, real);
        if (visited.has(real)) return;
        visited.add(real);
        const stat = await fs.stat(real);
        if (stat.isFile()) { yield real; return; }
        if (!stat.isDirectory()) return;
        const names = (await fs.readdir(real)).sort();
        await onDirectory(real, names);
        for (const entry of names) {
          signal?.throwIfAborted();
          if (!args.includeGenerated && usualGenerated.has(entry)) continue;
          try { yield* walk(path.join(real, entry)); }
          catch (error) { if (!['EACCES', 'EPERM', 'ENOENT', 'ELOOP'].includes(error.code)) throw error; }
        }
      }
      async function* matches() {
        if (name === 'ls') {
          const names = (await fs.readdir(absolute)).sort();
          await onDirectory(absolute, names);
          for (const entry of names) yield path.join(absolute, entry);
          return;
        }
        for await (const file of walk(absolute)) {
          if (name === 'find') { if (file.replaceAll('\\', '/').includes(args.pattern.replaceAll('\\', '/'))) yield file; continue; }
          // Searching is navigation only; large/binary files remain directly
          // readable with source_read rather than expanding a search response.
          if ((await fs.stat(file)).size > 4 * 1024 * 1024) continue;
          const bytes = await fs.readFile(file, { signal });
          await onSearchFile(file, bytes);
          if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) continue;
          const lines = bytes.toString('utf8').split('\n');
          for (let index = 0; index < lines.length; index++) {
            signal?.throwIfAborted();
            if (lines[index].includes(args.pattern)) yield `${file}:${index + 1}:${lines[index].slice(0, 300)}`;
          }
        }
      }
      const hits = []; let seen = 0, more = false;
      for await (const hit of matches()) {
        if (seen++ < offset) continue;
        if (hits.length === limit) { more = true; break; }
        hits.push(hit);
      }
      return navigation({ hits, nextOffset: more ? offset + hits.length : null });
    },
  }));
}
