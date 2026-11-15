import fs from 'node:fs/promises';
import path from 'node:path';
import { scanSemanticSource, isTestSource } from '../semantic-graph-syntax.mjs';
import { sha256 } from './utils.mjs';

export const ORIGINAL_CONTEXT_VERSION = 1;
const MAX_CONTEXT_BYTES = 24 * 1024;
const numbered = (lines, start, end) => lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');

/** Syntactic context, never a verdict about what a hook intercepts or authorizes. */
export function originalTestRanges(source, file, testLines = [], symbols = scanSemanticSource(source, file).symbols) {
  const lines = source.split(/\r?\n/u);
  const tests = symbols.filter(record => record.item.kind === 'test');
  const ranges = [];
  const first = tests[0]?.item.line;
  // Imports, fixture values, helper functions and the initial suite hooks are
  // often the decisive part that a case-only excerpt loses.
  if (first > 1) ranges.push({ start: 1, end: first - 1 });
  for (const record of symbols.filter(record => record.item.kind === 'test-hook'))
    ranges.push({ start: record.item.line, end: record.endLine });
  for (const line of testLines) {
    const record = tests.find(test => test.item.line <= line && test.endLine >= line);
    if (record) ranges.push({ start: record.item.line, end: record.endLine });
  }
  return mergeRanges(ranges, lines.length);
}

function mergeRanges(ranges, lineCount) {
  const result = [];
  for (const range of ranges.filter(range => range.start > 0 && range.end >= range.start)
    .map(range => ({ start: range.start, end: Math.min(range.end, lineCount) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** Bind already discovered original cases to their original setup, once per file. */
export function originalFailureContext(source, file, line, end, maxBytes = MAX_CONTEXT_BYTES) {
  const lines = source.split(/\r?\n/u);
  let context = `Task-start public test: ${file}\nSource SHA256: ${sha256(source)}\n`
    + 'Setup and assertions below are original source, not candidate test edits. A failed early assertion does not execute or retire the later assertions.\n'
    + numbered(lines, line, end);
  for (const range of originalTestRanges(source, file)) {
    const excerpt = '\n[Original setup / cleanup]\n' + numbered(lines, range.start, range.end);
    context += Buffer.byteLength(context + excerpt) <= maxBytes - 512 ? excerpt
      : `\n[Additional original setup at ${file}:${range.start}-${range.end}; read original source if needed.]`;
  }
  return context;
}

/**
 * Prepare existing source for the existing counterexample/selector/Stop calls.
 * No extra model call, obligation, response field or citation is introduced.
 */
export async function prepareOriginalContractContext({ tree, inventory, graph, candidates, signal, sourceDirectory, maxBytes = MAX_CONTEXT_BYTES }) {
  const requested = new Map(), sources = new Map(), omitted = [], entries = new Map();
  const add = (file, start, end) => {
    if (!inventory.has(file)) return;
    if (!requested.has(file)) requested.set(file, []);
    requested.get(file).push({ start, end });
  };
  const source = async file => {
    if (!sources.has(file)) {
      const absolute = path.resolve(tree, file), relative = path.relative(tree, absolute);
      try {
        if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..'
          || await fs.realpath(absolute) !== absolute) throw new Error('Original context must stay inside its immutable snapshot.');
        const bytes = await fs.readFile(absolute, { signal }), text = bytes.toString('utf8'), hash = sha256(bytes);
        if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('Original source encoding is unavailable.');
        if (sourceDirectory) {
          await fs.mkdir(sourceDirectory, { recursive: true });
          const saved = path.join(sourceDirectory, hash);
          await fs.writeFile(saved, bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          if (sha256(await fs.readFile(saved)) !== hash) throw new Error('Original snapshot bytes changed.');
        }
        sources.set(file, { hash, text,
          ...(isTestSource(file) ? { symbols: scanSemanticSource(text, file).symbols } : {}) });
      } catch {
        signal?.throwIfAborted();
        sources.set(file, { unavailable: true });
        omitted.push({ path: file, reason: 'Original source could not be read; no candidate source was substituted.' });
      }
    }
    return sources.get(file);
  };
  for (const item of candidates) {
    if (item.entryPoint) entries.set(JSON.stringify(item.entryPoint), item.entryPoint);
    for (const range of item.evidence ?? []) add(range.path, range.startLine, range.endLine);
  }
  // Evidence can identify a public owner or configuration ingress without a
  // scenario. Carry those original lines too; do not silently narrow to the
  // selector's preferred implementation entry.
  for (const entry of entries.values()) {
    if (!inventory.has(entry.path) || !graph?.query) continue;
    let firstTest = false;
    for (let offset = 0; offset < 72; offset += 12) {
      signal?.throwIfAborted();
      const context = graph.query({ operation: 'context', file: entry.path, symbol: entry.symbol, direction: 'incoming', depth: 1, offset });
      for (const definition of context.definitions ?? []) add(definition.path, definition.line, definition.endLine);
      for (const ref of context.hits ?? []) {
        if (!ref.testSource || !inventory.has(ref.path) || !isTestSource(ref.path)) continue;
        const original = await source(ref.path);
        if (original.unavailable) continue;
        // All setup/cleanup stays visible. One complete original invocation
        // per entry keeps this bounded; other cases retain source navigation.
        for (const range of originalTestRanges(original.text, ref.path, firstTest ? [] : [ref.line], original.symbols))
          add(ref.path, range.start, range.end);
        if (original.symbols.some(record => record.item.kind === 'test' && record.item.line <= ref.line && record.endLine >= ref.line))
          firstTest = true;
      }
      if (context.nextOffset == null) break;
      if (offset === 60) omitted.push({ path: entry.path, symbol: entry.symbol, reason: 'More incoming source navigation is available.' });
    }
  }
  // Account for frozen-source navigation before spending the excerpt budget.
  const ordered = [...requested].sort(([a], [b]) => Number(isTestSource(b)) - Number(isTestSource(a)));
  for (const [file] of ordered) await source(file);
  const context = { version: ORIGINAL_CONTEXT_VERSION, source: 'TASK_START',
    notice: 'Program-prepared original source, not new requirements or proof. Keep the original entry, setup and dependency outcomes while judging which observations the user changes. Read further original source when these bounded excerpts are insufficient; do not replace a successful substitute with a failing one. No additional response fields or citations are required.',
    excerpts: [], omitted, sources: [...sources].filter(([, original]) => !original.unavailable)
      .map(([file, original]) => ({ path: file, sha256: original.hash })) };
  // Original substitutes must not lose their place to the much larger advice
  // evidence. Entire ranges are carried or explicitly left for source_read.
  for (const [file, ranges] of ordered) {
    signal?.throwIfAborted();
    const original = await source(file);
    if (original.unavailable) continue;
    const lines = original.text.split(/\r?\n/u);
    for (const range of mergeRanges(ranges, lines.length)) {
      const excerpt = { path: file, sha256: original.hash, ...range, text: numbered(lines, range.start, range.end) };
      context.excerpts.push(excerpt);
      if (Buffer.byteLength(JSON.stringify(context)) > Math.max(0, maxBytes - Math.min(4096, Math.floor(maxBytes / 4)))) {
        context.excerpts.pop();
        omitted.push({ path: file, ...range, reason: 'Context size limit; original source remains available.' });
      }
    }
  }
  return context;
}
