import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export async function json(file) {
  const contents = await fs.readFile(file, 'utf8');
  try { return JSON.parse(contents.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON: ${file}`); } // Never print credential file snippets.
}
export const hash = data => createHash('sha256').update(data).digest('hex');
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function optionalJson(file) {
  try { return await json(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function regular(file, directory = false) {
  const s = await fs.lstat(file);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) throw new Error(`Expected regular ${directory ? 'directory' : 'file'}: ${file}`);
}
export async function filesUnder(root) {
  const out = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`Symlinks/junctions are unsupported in MVP input: ${file}`);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) out.push(file);
      else throw new Error(`Unsupported file: ${file}`);
    }
  }
  try { await walk(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return out.sort();
}
export async function copyTree(from, to, { skip = new Set() } = {}) {
  await regular(from, true);
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst, { skip });
    else { await regular(src); await fs.copyFile(src, dst); }
  }
}
export async function manifest(root, skip = new Set(['.git', '.runtime-correction'])) {
  const entries = {};
  async function walk(dir) {
    await regular(dir, true);
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (skip.has(item.name)) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else { await regular(file); entries[path.relative(root, file).split(path.sep).join('/')] = hash(await fs.readFile(file)); }
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}
// RC's MA archive is regular USTAR. Reject links/extensions/path escapes before writing.
export async function extractPackage(archive, dest) {
  const buffer = gunzipSync(await fs.readFile(archive), { maxOutputLength: 128 * 1024 * 1024 });
  const entries = [], seen = new Set();
  const str = b => b.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = [str(header.subarray(345, 500)), str(header.subarray(0, 100))].filter(Boolean).join('/');
    const type = String.fromCharCode(header[156] || 48);
    const size = parseInt(str(header.subarray(124, 136)).trim(), 8);
    const checksum = parseInt(str(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    const target = path.resolve(dest, name);
    if (actual !== checksum || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length
      || !['0', '5'].includes(type) || !name || name.includes('\\') || name.includes(':')
      || name.startsWith('/') || name.split('/').includes('..') || !within(dest, target) || seen.has(target.toLowerCase())) {
      throw new Error(`Unsupported/unsafe RC archive entry: ${name}`);
    }
    seen.add(target.toLowerCase());
    entries.push({ target, type, data: buffer.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const e of entries) {
    await fs.mkdir(e.type === '5' ? e.target : path.dirname(e.target), { recursive: true });
    if (e.type === '0') await fs.writeFile(e.target, e.data, { flag: 'wx' });
  }
  await regular(path.join(dest, 'installer.mjs'));
  await regular(path.join(dest, 'payload/runtime-corrector/openclaw.plugin.json'));
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /api.?key|token|password|secret|authorization|private.?key/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
