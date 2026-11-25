import fs from 'node:fs/promises';
import path from 'node:path';
import { contiguousBytes } from '../review-task/byte-pages.mjs';
import { covers } from '../review-task/evidence-utils.mjs';
import { taskError } from '../review-task/protocol-task.mjs';
import { sha256 } from './utils.mjs';

export function createOriginalBatches({ projectRoot, originals, sourceDigest, validate, sealed }) {
  const items = new Map(), lineIndexes = new Map();
  let batches = 0;
  const invalid = reason => taskError('STOP_ORIGINAL_CHECKLIST_INVALID', reason);

  async function bind(wire, ctx) {
    const { path: selectedPath, citeId, lineStart, lineEnd, byteStart, byteEnd, ...item } = wire;
    const citation = citeId && ctx.evidence.registry.get(citeId);
    if (citeId && !citation) throw invalid('The citation has no original host receipt.');
    const requested = selectedPath && path.resolve(projectRoot, selectedPath);
    const file = requested ? ctx.evidence.resolutions.get(requested) ?? requested : citation?.path;
    const original = originals.get(file);
    const metadata = ctx.evidence.snapshot.get(file);
    if (!original || !metadata || metadata.sha256 !== original.readHash || citation && citation.path !== file
      || lineStart < 1 || lineStart > lineEnd || lineEnd > metadata.lines)
      throw invalid('Select a registered original at its observed revision and valid local lines.');
    const bytesRequested = byteStart !== undefined || byteEnd !== undefined;
    if (bytesRequested) {
      if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteStart < 0 || byteEnd <= byteStart || byteEnd > metadata.bytes)
        throw invalid('Use a positive exact half-open byte span inside the named file.');
      let offsets = lineIndexes.get(file);
      if (!offsets) {
        const source = await fs.readFile(file);
        if (sha256(source) !== original.readHash) throw invalid('The original changed.');
        offsets = [0];
        for (let at = source.indexOf(10); at !== -1; at = source.indexOf(10, at + 1)) offsets.push(at + 1);
        lineIndexes.set(file, offsets);
      }
      if (byteStart < offsets[lineStart - 1] || byteEnd > (offsets[lineEnd] ?? metadata.bytes))
        throw invalid('Byte and line coordinates select different original text.');
    }
    if (!covers(ctx.evidence.reads, file, lineStart, lineEnd)
      && !(bytesRequested && contiguousBytes(ctx.evidence.registry.values(), file, original.readHash, byteStart, byteEnd)))
      throw invalid('The actual host has not acknowledged these original bytes. Read this range and retry.');
    if (citation && (lineStart < citation.start || lineEnd > citation.end
      || bytesRequested && (byteStart < citation.byteStart || byteEnd > citation.byteEnd)))
      throw invalid('The selected coordinates are outside this citation.');
    const source = { kind: original.kind, ref: original.ref, ...(original.part ? { part: original.part } : {}),
      sha256: original.sha256, start: lineStart + original.lineOffset, end: lineEnd + original.lineOffset,
      ...(bytesRequested ? { byteStart: (original.byteOffset ?? 0) + byteStart, byteEnd: (original.byteOffset ?? 0) + byteEnd } : {}) };
    return { ...item, source };
  }

  async function append(wire, ctx) {
    if (sealed()) throw taskError('TASK_SUBMISSION_CONFLICT', 'This original checklist has already been sealed.');
    const added = new Map();
    for (const value of wire.items) {
      const item = await bind(value, ctx);
      if (item.expectedFiles?.length) await validate.expectedFiles(item, value, ctx);
      const key = sha256([item.metricId, item.source, item.text.trim()]);
      const prior = added.get(key) ?? items.get(key);
      if (prior && sha256(prior) !== sha256(item)) throw invalid('Conflicting obligations at the same original position.');
      if (!prior) added.set(key, item);
    }
    if (added.size) {
      const next = [...added.values()];
      validate.population(next);
      await ctx.persist(`original-batches/${String(batches + 1).padStart(6, '0')}.json`, { sourceDigest, items: next });
      for (const [key, item] of added) items.set(key, item);
      batches++;
    }
    return { saved: true, added: added.size, total: items.size, batches, next: 'append_original_checklist or seal_original_checklist' };
  }

  return { append, get items() { return [...items.values()]; }, get size() { return items.size; },
    status(offset = 0, limit = 12) {
      const values = [...items.values()];
      return { sealed: sealed(), batches, total: values.length, items: values.slice(offset, offset + limit),
        nextOffset: offset + limit < values.length ? offset + limit : null };
    } };
}
