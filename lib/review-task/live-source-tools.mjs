// Read the real workspace on demand. Paths select evidence; they do not define
// a permission boundary. The operating system/host still owns access rights.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourcePage, textBlocks, literalFindHint } from './source-tools.mjs';

const navigation = value => ({ content: textBlocks(JSON.stringify({ navigationOnly: true, ...value })), details: {} });
// Skip dependency/build caches during broad navigation. An explicit path still
// selects them, and includeGenerated opts into traversing them from a parent.
// Do not exclude broad names such as build, target or vendor: they can be
// intentional project sources.
const usualGenerated = new Set(['.git', 'node_modules', '.runtime-correction', '.hvigor', 'oh_modules', '.test', '__pycache__', '.venv']);

export function createLiveSourceTools(cwd, { onDirectory = () => {}, onSearchFile = () => {}, onPath = () => {},
  navigationBudget = { entries: 4096, bytes: 16 * 1024 * 1024 } } = {}) {
  if (!['entries', 'bytes'].every(key => Number.isSafeInteger(navigationBudget[key]) && navigationBudget[key] > 0))
    throw new Error('Navigation budget must contain positive entry and byte counts');
  return ['read', 'grep', 'find', 'ls'].map(name => ({
    name, label: `Workspace ${name}`,
    description: name === 'read'
      ? 'Read original UTF-8 file lines. Absolute paths, parent paths and linked files are supported. Follow nextOffset for more lines. Only observed read receipts grant citations.'
      : 'Navigate original files in the current project. Omit path or use . to start here; narrow to the relevant source directory before recursive grep/find. Absolute and parent paths remain supported for original references and necessary dependencies. Searching an entire parent workspace can be slow and may skip nested generated directories. scanIncomplete means the recursive scan budget was reached: narrow the path instead of treating no hits or nextOffset=null as completion. Results are navigation hints, not citations or proof of absence. grep matches literal text; find matches path fragments. Use offset to page; includeGenerated also searches dependency and RC output directories.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', description: `Current project: ${cwd}. Omit path or use . for this root. Read known files directly; expand a recursive search to a parent or external directory only when the original references or production dependency trail calls for it.` }, offset: { type: 'integer', minimum: name === 'read' ? 1 : 0 },
      limit: { type: 'integer', minimum: 1, maximum: name === 'read' ? 400 : 100 },
      ...(name !== 'read' ? { includeGenerated: { type: 'boolean' } } : {}),
      ...(['grep', 'find'].includes(name) ? { pattern: { type: 'string', minLength: 1, maxLength: 500,
        description: name === 'find' ? 'Case-sensitive literal path fragment, not file contents, glob or regex. Use grep for code symbols.' : 'Literal text in original UTF-8 lines.' } } : {}),
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
      const scanned = { entries: 0, bytes: 0 };
      let scanIncomplete = false;
      async function* walk(file) {
        signal?.throwIfAborted();
        if (scanIncomplete) return;
        if (scanned.entries >= navigationBudget.entries) { scanIncomplete = true; return; }
        scanned.entries++;
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
          if (scanIncomplete) return;
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
          const size = (await fs.stat(file)).size;
          if (size > 4 * 1024 * 1024) continue;
          if (scanned.bytes + size > navigationBudget.bytes) { scanIncomplete = true; return; }
          const bytes = await fs.readFile(file, { signal });
          scanned.bytes += bytes.length;
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
      const hint = scanIncomplete
        ? 'Recursive search is incomplete because its scan budget was reached. Narrow the path to a relevant subdirectory or read a known file directly. nextOffset=null is not a completion marker for this partial scan; no hits do not prove absence.'
        : name === 'find' ? literalFindHint(args.pattern, hits, offset) : null;
      return navigation({ hits, nextOffset: more ? offset + hits.length : null,
        ...(scanIncomplete ? { scanIncomplete: true, scanned } : {}), ...(hint ? { hint } : {}) });
    },
  }));
}
