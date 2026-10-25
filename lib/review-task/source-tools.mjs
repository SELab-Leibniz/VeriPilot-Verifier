// RC's frozen-source protocol. These are evidence tools, not an agent runtime.
import fs from 'node:fs/promises';
import path from 'node:path';

export const PAGE_LINES = 400, PAGE_BYTES = 51200;
// The installed host caps each observer text block at 8000 characters. Keep
// original UTF-8 bytes in bounded blocks so a long source line stays verifiable.
export const toolText = result => (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
export function textBlocks(text) {
  const blocks = []; let chunk = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 6000) { blocks.push({ type: 'text', text: chunk }); chunk = ''; size = 0; }
    chunk += char; size += bytes;
  }
  if (chunk || !blocks.length) blocks.push({ type: 'text', text: chunk });
  return blocks;
}
const result = (value, details = {}) => ({ content: textBlocks(value), details });
export function sourcePage(bytes, { offset = 1, limit = PAGE_LINES } = {}) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error('Only UTF-8 text is readable evidence');
  const lines = text.split('\n');
  if (!Number.isInteger(offset) || offset < 1 || offset > lines.length || !Number.isInteger(limit) || limit < 1)
    throw new Error('Read offset/limit must be positive integers within the file');
  const selected = [];
  for (const line of lines.slice(offset - 1, offset - 1 + Math.min(limit, PAGE_LINES))) {
    if (Buffer.byteLength([...selected, line].join('\n')) > PAGE_BYTES) break;
    selected.push(line);
  }
  if (!selected.length) throw new Error('First line exceeds the evidence page byte limit');
  const range = { start: offset, end: offset + selected.length - 1 };
  const page = { ...range, totalLines: lines.length, nextOffset: range.end < lines.length ? range.end + 1 : null };
  return result(`${selected.join('\n')}\n[RC page ${JSON.stringify(page)}]`, { page });
}
export function createSourceTools(root, snapshot) {
  const parameters = properties => ({ type: 'object', additionalProperties: false, properties });
  return ['read', 'grep', 'find', 'ls'].map(name => ({
    name, label: `Frozen source ${name}`,
    description: name === 'read' ? 'Read exact frozen UTF-8 lines. Follow nextOffset until the complete basis has been read. Text blocks are consecutive fragments of one exact page; join without separators. Oversized single lines are unavailable.'
      : 'Navigate captured source paths only. Navigation results never grant citation or read coverage. grep is literal; find matches a literal path fragment.',
    parameters: parameters({ path: { type: 'string' }, ...(name === 'read' ? { offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }
      : name === 'grep' || name === 'find' ? { pattern: { type: 'string', maxLength: 500 } } : {}) }),
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const absolute = await fs.realpath(path.resolve(root, args.path ?? '.'));
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Source access outside snapshot is forbidden');
      if (name === 'read') {
        if (!snapshot.has(relative)) throw new Error('File is not part of the frozen snapshot');
        return sourcePage(await fs.readFile(absolute), args);
      }
      if (['grep', 'find'].includes(name) && (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 500)) throw new Error('A short literal pattern is required');
      const files = [...snapshot.keys()].filter(file => file === relative || !relative || file.startsWith(`${relative}/`)).sort();
      const hits = [];
      for (const file of files) {
        signal?.throwIfAborted();
        if (name === 'ls' || name === 'find' && file.includes(args.pattern)) hits.push(file);
        if (name === 'grep') {
          const bytes = await fs.readFile(path.join(root, file)), text = bytes.toString('utf8');
          if (!Buffer.from(text).equals(bytes) || text.includes('\0')) continue;
          text.split('\n').forEach((line, index) => { if (line.includes(args.pattern)) hits.push(`${file}:${index + 1}:${line.slice(0, 300)}`); });
        }
        if (hits.length >= 100) break;
      }
      return result(JSON.stringify({ navigationOnly: true, hits: hits.slice(0, 100), possiblyTruncated: hits.length >= 100 }).slice(0, PAGE_BYTES));
    },
  }));
}
