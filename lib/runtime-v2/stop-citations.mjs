import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './utils.mjs';

export const STOP_CITATIONS_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['path', 'start', 'end'], properties: { path: { type: 'string', minLength: 1 },
    start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } } } };

const invalid = message => Object.assign(new Error(message), { code: 'TASK_CITATION_INVALID' });
const changed = () => Object.assign(new Error('Cited evidence changed during this review.'), { code: 'BASELINE_INPUT_CHANGED' });
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Bind references to current bytes without claiming the reviewer read them. */
export async function resolveStopCitations(ctx, { citeIds = [], citations = [] }, projectRoot) {
  const references = citeIds.map(id => {
    const known = ctx.evidence.lookupCitation?.(id) ?? ctx.evidence.registry.get(id);
    if (known) return known;
    const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(id);
    if (!match) throw invalid(`Unknown citation ${id}. Use an issued ID, path#Lstart-Lend, or citations with path/start/end.`);
    return { path: match[1], start: Number(match[2]), end: Number(match[3] ?? match[2]) };
  }).concat(citations);
  const resolved = [];
  for (const ref of references) {
    ctx.active();
    const requested = path.resolve(projectRoot, ref.path);
    let real, before, after, bytes;
    try {
      real = await fs.realpath(requested);
      before = await fs.stat(real, { bigint: true });
      if (!before.isFile()) throw invalid(`Citation is not a regular file: ${ref.path}`);
      bytes = await fs.readFile(real);
      after = await fs.stat(real, { bigint: true });
    } catch (error) { if (error.code === 'TASK_CITATION_INVALID') throw error; throw invalid(`Cannot read cited file: ${ref.path}`); }
    ctx.active();
    if (version(before) !== version(after) || await fs.realpath(requested) !== real) throw changed();
    const hash = sha256(bytes), lines = bytes.toString('utf8').split('\n').length;
    if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 1 || ref.end < ref.start || ref.end > lines)
      throw invalid(`Citation range is outside ${ref.path} (1-${lines}).`);
    if (ref.sha256 && ref.sha256.toLowerCase() !== hash) throw invalid(`Citation content hash does not match ${ref.path}.`);
    const captured = ctx.evidence.snapshot.get(real);
    if (captured && captured.sha256 !== hash || ctx.evidence.resolutions.has(requested) && ctx.evidence.resolutions.get(requested) !== real)
      throw changed();
    ctx.evidence.resolutions.set(requested, real);
    ctx.evidence.snapshot.set(real, { sha256: hash, lines });
    resolved.push({ ...ref, path: real, sha256: hash,
      citeId: ref.citeId ?? `path-${sha256([real, hash, ref.start, ref.end]).slice(0, 24)}` });
  }
  return resolved;
}
