import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { scanSemanticSource } from './semantic-graph-syntax.mjs';
import { affectedSemanticSymbols, describeSemanticSymbol, linkSemanticSources, semanticReferences, semanticTestBoundaries } from './semantic-graph-links.mjs';
import { createSemanticSearch } from './semantic-graph-search.mjs';

const runGit = promisify(execFile);
const extensions = ['.ets', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const emittedExtensions = new Map([['.js', '.ts'], ['.mjs', '.mts'], ['.cjs', '.cts'], ['.jsx', '.tsx']]);
const generated = new Set(['.git', '.runtime-correction', '.runtime-corrector', '.test', '.hvigor', '.ohpm', 'node_modules', 'oh_modules', 'build', 'dist', 'coverage']);
const relativeModule = /^\.{1,2}\//u;
const normalizePath = value => value.replaceAll('\\', '/').replace(/^\.\//u, '');
const sourceHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

const frameView = frame => ({ id: frame.id, kind: frame.kind, bindingKind: frame.bindingKind,
  start: frame.start, end: frame.end, startOffset: frame.startOffset, endOffset: frame.endOffset,
  ...(frame.displayLabel ? { displayLabel: frame.displayLabel } : {}), navigationOnly: true });

// A line citation cannot disambiguate two callables on the same line. Offsets
// establish lexical containment, but never invent precision absent from the
// acknowledged line range. Unsupported inner frames cannot borrow an owner.
function selectOriginEntry(source, { start, end }) {
  const unknown = (reason, frames = []) => ({ status: 'UNKNOWN', reason, navigationOnly: true,
    ...(frames.length ? { frames: frames.slice(0, 3).map(frameView), frameCount: frames.length } : {}) });
  if (!source) return unknown('ENTRY_SOURCE_NOT_INDEXED');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    return unknown('ENTRY_RANGE_INVALID');
  const frames = source.callableFrames;
  if (!Array.isArray(frames) || source.callableFramesComplete !== true || frames.length > 512)
    return unknown('ENTRY_FRAME_INDEX_INCOMPLETE');
  if (frames.some(frame => !Number.isSafeInteger(frame.start) || !Number.isSafeInteger(frame.end)
    || frame.start < 1 || frame.end < frame.start || !Number.isSafeInteger(frame.startOffset)
    || !Number.isSafeInteger(frame.endOffset) || frame.startOffset < 0 || frame.endOffset <= frame.startOffset))
    return unknown('ENTRY_FRAME_INDEX_INCOMPLETE');
  const overlaps = frames.filter(frame => frame.start <= end && frame.end >= start);
  const containers = overlaps.filter(frame => frame.start <= start && frame.end >= end)
    .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
  const [selected] = containers;
  if (selected) {
    const ancestors = containers.slice(1);
    if (ancestors.some(frame => frame.start === selected.start && frame.end === selected.end
      || frame.startOffset >= selected.startOffset || frame.endOffset <= selected.endOffset))
      return unknown('AMBIGUOUS_ENTRY_SYMBOL', containers);
    for (const frame of overlaps) {
      if (frame === selected) continue;
      const ancestor = frame.startOffset < selected.startOffset && frame.endOffset > selected.endOffset;
      const descendant = frame.startOffset > selected.startOffset && frame.endOffset < selected.endOffset;
      const complete = start <= frame.start && end >= frame.end;
      if (ancestor) {
        // A shared header/closing line also contains part of the outer frame.
        if (start <= frame.start && frame.start <= end || start <= frame.end && frame.end <= end)
          return unknown('ENTRY_RANGE_CROSSES_CALLABLE', [selected, frame]);
      } else if (!descendant || !complete) return unknown('ENTRY_RANGE_CROSSES_CALLABLE', [selected, frame]);
    }
    if (selected.supported !== true || !selected.record || !source.symbols.includes(selected.record))
      return { ...unknown('ENTRY_CALLABLE_UNSUPPORTED', [selected]), callableReason: selected.reason ?? 'UNSUPPORTED_CALLABLE' };
    return { status: 'READY', reason: 'LEXICAL_CALLABLE_ENTRY', navigationOnly: true,
      frame: frameView(selected), definition: describeSemanticSymbol(selected.record) };
  }
  const symbols = source.symbols.filter(record => !record.item.kind.startsWith('test')
    && record.item.line <= start && record.endLine >= end)
    .sort((left, right) => (left.endLine - left.item.line) - (right.endLine - right.item.line));
  const [record] = symbols;
  if (!record) return unknown('ENTRY_SYMBOL_UNRESOLVED', overlaps);
  if (symbols[1] && record.item.line === symbols[1].item.line && record.endLine === symbols[1].endLine)
    return unknown('AMBIGUOUS_ENTRY_SYMBOL');
  if (['function', 'method', 'constructor'].includes(record.item.kind))
    return unknown('ENTRY_FRAME_INDEX_INCOMPLETE');
  // Whole non-callable declarations remain navigable. A partial citation that
  // crosses a callable cannot fall back to a containing class or declaration.
  if (overlaps.length && (record.item.line !== start || record.endLine !== end
    || overlaps.some(frame => frame.start < start || frame.end > end)))
    return unknown('ENTRY_SYMBOL_UNRESOLVED', overlaps);
  return { status: 'READY', reason: 'DECLARATION_ENTRY', navigationOnly: true,
    definition: describeSemanticSymbol(record) };
}

export const SEMANTIC_GRAPH_TOOL = {
  name: 'semantic_graph',
  label: 'semantic_graph',
  description: 'Navigate source. Use search for a short phrase, definition/context for a symbol such as Type.method, or literal for an exact string value. Incoming finds callers and tests; outgoing finds calls, writes and callee catch returns. Context also reports testBoundaries: a caller, its dependency passed to a test helper, setup scope and later call/write sites. These are navigation facts; read source to determine substitution semantics and control flow. Outline/dependencies take a project-relative file. Dependencies can show file name case mismatches. Follow nextOffset for more hits.',
  parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { enum: ['summary', 'definition', 'dependencies', 'outline', 'context', 'search', 'incoming', 'outgoing', 'literal'] },
    query: { type: 'string', minLength: 1, maxLength: 512 },
    value: { type: 'string' },
    symbol: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 0 },
    depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Call levels to follow for incoming/outgoing/context. Defaults to one. Each caller or callee is expanded once, with its first resolved route in via. Use incoming depth 2 or 3 to find public callers and their tests through helper layers.' },
    direction: { enum: ['incoming', 'outgoing'] },
  } },
};

export async function semanticGraphInstructions(signal) {
  const file = new URL('./review-task/skills/code-understanding/SKILL.md', import.meta.url);
  const skill = await fs.readFile(file, { encoding: 'utf8', signal }).catch(() => '');
  return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
    || 'Use semantic_graph to locate the relevant entry point and related source. Verify findings with source_read.';
}

function resolveModule(from, specifier, files, fileSpellings) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (files.has(base)) return { target: base };
  // ESM TypeScript projects may spell a source import with its emitted suffix.
  const suffix = path.posix.extname(base);
  const candidates = emittedExtensions.has(suffix) ? [base.slice(0, -suffix.length) + emittedExtensions.get(suffix)]
    : [...extensions.map(ext => base + ext), ...extensions.map(ext => path.posix.join(base, 'index' + ext))];
  const matches = candidates.filter(file => files.has(file));
  if (matches.length) return matches.length === 1 ? { target: matches[0] } : {};
  const spellings = new Map();
  for (const requestedPath of [base, ...candidates])
    for (const existingPath of fileSpellings.get(requestedPath.toLowerCase()) ?? [])
      spellings.set(existingPath, requestedPath);
  if (spellings.size !== 1) return {};
  const [existingPath, requestedPath] = spellings.entries().next().value;
  return { caseMismatch: { existingPath, requestedPath } };
}

/** Build a bounded navigation index from the given snapshot inventory or the current Git worktree. */
export async function buildSemanticGraph(projectRoot, { signal, budgetMs = 1500, preferredPaths = [], excludedPaths = [], snapshotPaths } = {}) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(budgetMs);
  const buildSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const sources = new Map(), definitions = new Map(), outgoing = new Map(), incoming = new Map(), moduleDiagnostics = new Map();
  const originInputs = new Map();
  const originMissing = new Set();
  const root = await fs.realpath(projectRoot);
  const excluded = excludedPaths.map(file => path.resolve(root, file));
  const preferred = new Set(preferredPaths.map(normalizePath));
  let sourcePaths = snapshotPaths;
  if (sourcePaths === undefined) {
    try {
      const { stdout } = await runGit('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
        { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal: buildSignal });
      sourcePaths = stdout.split('\0');
    } catch {
      signal?.throwIfAborted();
      const summary = { status: 'unavailable', reason: timeout.aborted ? 'budget' : 'git-inventory', navigationOnly: true };
      return { ...summary, query: () => summary };
    }
  }
  const candidates = new Set([...sourcePaths].filter(file => extensions.includes(path.posix.extname(file))
    && !file.split('/').some(part => generated.has(part))
    && !excluded.some(parent => within(parent, path.resolve(root, file)))));
  const paths = [...candidates].sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)));
  let readBytes = 0, incomplete = false;
  for (const file of paths) {
    signal?.throwIfAborted();
    if (timeout.aborted || sources.size >= 4000 || readBytes >= 16 * 1024 * 1024) { incomplete = true; break; }
    const absolute = path.resolve(root, file);
    try {
      if (!within(root, absolute) || await fs.realpath(absolute) !== absolute) { incomplete = true; continue; }
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) { incomplete = true; continue; }
      const limit = Math.min(256 * 1024, 16 * 1024 * 1024 - readBytes);
      if (stat.size > limit) { incomplete = true; continue; }
      const handle = await fs.open(absolute, 'r');
      let bytes;
      try {
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        readBytes += bytesRead;
        if (bytesRead !== stat.size) { incomplete = true; continue; }
        bytes = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      if (timeout.aborted) { incomplete = true; break; }
      const source = bytes.toString('utf8');
      if (bytes.includes(0) || !Buffer.from(source).equals(bytes)) { incomplete = true; continue; }
      const indexed = scanSemanticSource(source, file);
      sources.set(file, indexed);
      originInputs.set(file, { path: file, sha256: sourceHash(bytes), bytes: bytes.length });
      for (const record of indexed.symbols) {
        for (const symbol of [record.item.symbol, record.item.qualified].filter(Boolean)) {
          if (!definitions.has(symbol)) definitions.set(symbol, []);
          definitions.get(symbol).push(record);
        }
      }
    } catch (error) {
      // Legitimate unstaged deletions need not disable the whole index, but a
      // cached path must remain absent: recreation otherwise bypasses hashes.
      if (error.code === 'ENOENT') originMissing.add(file);
      else incomplete = true;
    }
  }
  signal?.throwIfAborted();
  const fileSpellings = new Map();
  for (const file of candidates) {
    const folded = file.toLowerCase();
    if (!fileSpellings.has(folded)) fileSpellings.set(folded, []);
    fileSpellings.get(folded).push(file);
  }
  let unresolved = 0;
  for (const [from, source] of sources) {
    for (const entry of source.modules) {
      if (!relativeModule.test(entry.specifier ?? '')) continue;
      const { target: to, caseMismatch } = resolveModule(from, entry.specifier, candidates, fileSpellings);
      if (!sources.has(to)) {
        unresolved++;
        if (caseMismatch && sources.has(caseMismatch.existingPath)) {
          if (!moduleDiagnostics.has(from)) moduleDiagnostics.set(from, []);
          moduleDiagnostics.get(from).push({ from, kind: entry.kind, line: entry.line, resolution: 'case-mismatch', ...caseMismatch });
        }
        continue;
      }
      entry.target = to;
      const edge = { from, to, kind: entry.kind, line: entry.line };
      if (!outgoing.has(from)) outgoing.set(from, []);
      if (!incoming.has(to)) incoming.set(to, []);
      outgoing.get(from).push(edge);
      incoming.get(to).push(edge);
    }
  }
  const references = linkSemanticSources(sources);
  const search = createSemanticSearch(sources);
  const literals = new Map();
  for (const source of sources.values()) for (const hit of source.literals) {
    if (!literals.has(hit.value)) literals.set(hit.value, []);
    literals.get(hit.value).push(hit);
  }
  // The Git base is provided by the Stop controller. Only compare types
  // whose current declaration overlaps a changed hunk in an indexed file.
  async function removedLiteralUses(changes, baseCommit) {
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/u.test(baseCommit ?? '')) return [];
    const timeout = AbortSignal.timeout(budgetMs);
    const compareSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const hints = [];
    for (const { path: file, hunks } of changes) {
      signal?.throwIfAborted();
      if (timeout.aborted || hints.length >= 6) break;
      const touched = sources.get(file)?.symbols.filter(record => record.literalMembers
        && hunks?.some(([start, end]) => start <= record.endLine && record.item.line <= end));
      if (!touched?.length) continue;
      let before;
      try {
        const { stdout } = await runGit('git', ['--no-optional-locks', 'show', `${baseCommit}:./${file}`],
          { cwd: root, windowsHide: true, maxBuffer: 256 * 1024, signal: compareSignal });
        before = scanSemanticSource(stdout, file).symbols;
      } catch { signal?.throwIfAborted(); continue; }
      for (const record of touched) {
        const old = before.filter(candidate => candidate.literalMembers && candidate.item.symbol === record.item.symbol);
        if (old.length !== 1) continue;
        const current = new Set(record.literalMembers.map(member => member.value));
        const consumers = new Set((references.incoming.get(record) ?? []).map(hit => hit.path));
        consumers.add(file);
        for (const member of old[0].literalMembers) {
          if (current.has(member.value)) continue;
          const cases = (literals.get(member.value) ?? []).filter(hit => hit.kind === 'case' && consumers.has(hit.path));
          if (cases.length) hints.push({ definition: describeSemanticSymbol(record), removed: member, cases: cases.slice(0, 4) });
          if (hints.length >= 6) return hints;
        }
      }
    }
    return hints;
  }
  const summary = { status: incomplete ? 'partial' : 'ready', navigationOnly: true, files: sources.size, unresolved };
  // This internal receipt binds the navigation index; it is never a native
  // source-read acknowledgement or a claim that all semantic callers resolved.
  const originSnapshot = { ...summary, entryFramesProtocol: 'LEXICAL_CALLABLE_FRAMES_V1',
    scope: snapshotPaths === undefined ? 'GIT_SOURCE_INVENTORY' : 'SUPPLIED_SOURCE_INVENTORY',
    inventory: [...candidates].sort(), absentSources: [...originMissing].sort(),
    opaqueRanges: [...sources].flatMap(([file, source]) => source.opaqueOrigins.map(({ start, end, reason, unresolved }) =>
      ({ path: file, start, end, reason, ...(unresolved ? { unresolved: true } : {}) }))),
    sources: [...originInputs.values()].sort((left, right) => left.path.localeCompare(right.path)) };
  originSnapshot.fingerprint = sourceHash(originSnapshot);
  function originEntry({ file, start, end }) {
    const relative = typeof file === 'string' ? normalizePath(file) : null;
    return { ...selectOriginEntry(sources.get(relative), { start, end }),
      ...(originInputs.has(relative) ? { sourceSha256: originInputs.get(relative).sha256 } : {}) };
  }
  function originOpaqueReference({ file, symbol, selectors = [] }) {
    const matching = (definitions.get(symbol) ?? []).filter(record => record.item.path === file);
    if (matching.length !== 1) return { status: 'UNKNOWN', reason: 'OPAQUE_ENTRY_SYMBOL_UNRESOLVED' };
    const [target] = matching, values = new Set(selectors), cutoff = Date.now() + budgetMs;
    const [potential] = references.originWitnesses.get(target) ?? [];
    if (potential) return { status: 'READY', witness: { ...potential,
      sha256: originInputs.get(potential.path).sha256, navigationOnly: true, sourceReadAcknowledged: false } };
    const frame = sources.get(file)?.callableFrames?.find(candidate => candidate.record === target);
    const hints = frame?.bindingKind === 'ANONYMOUS' ? frame.opaqueReferenceNames ?? [] : [];
    if (!Array.isArray(hints) || hints.length > 16 || hints.some(name => typeof name !== 'string' || !name || name.length > 256))
      return { status: 'UNKNOWN', reason: 'OPAQUE_ENTRY_REFERENCE_LIMIT' };
    let work = 0;
    for (const [from, source] of sources) for (const range of source.opaqueOrigins) {
      if (++work > 16384 || Date.now() >= cutoff)
        return { status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_QUERY_LIMIT' };
      const witness = { path: from, start: range.start, end: range.end, reason: range.reason,
        sha256: originInputs.get(from).sha256, navigationOnly: true, sourceReadAcknowledged: false };
      if (range.unresolved) return { status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_UNRESOLVED', witness };
      for (const literal of range.literals) {
        if (++work > 16384) return { status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_QUERY_LIMIT' };
        if (values.has(literal)) return { status: 'READY', witness: { ...witness, selector: literal } };
      }
      const names = new Set(range.identifiers);
      // The scanner's spelling hints identify possible references inside
      // unparsed code. They create no receiver binding, caller edge or
      // invocation assertion; another receiver may alias the assigned value.
      let matchingHints = hints.length > 0;
      for (const name of hints) {
        if (++work > 16384) return { status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_QUERY_LIMIT' };
        if (!names.has(name)) { matchingHints = false; break; }
      }
      if (matchingHints)
        return { status: 'READY', witness: { ...witness, referenceLabel: frame.displayLabel ?? 'CALLBACK_REFERENCE' } };
      for (const name of names) {
        if (++work > 16384) return { status: 'UNKNOWN', reason: 'OPAQUE_ORIGIN_QUERY_LIMIT' };
        const direct = references.resolveLexicalTarget(from, { name, members: [] });
        const member = names.has(target.item.symbol) && [false, true].some(instance =>
          references.resolveLexicalTarget(from, { name, members: [target.item.symbol], instance }) === target);
        // An unresolved exact spelling remains a possible reference, including
        // shadowed names. Only the existing linker may identify a known alias.
        if (direct === target || member || !direct && name === target.item.symbol)
          return { status: 'READY', witness: { ...witness, symbol: name } };
      }
    }
    return { status: 'READY', witness: null };
  }
  async function checkOriginIndexCurrent() {
    signal?.throwIfAborted();
    const currentnessDeadline = Date.now() + budgetMs;
    if (summary.status !== 'ready') return { current: false, reason: 'PARTIAL_INDEX' };
    if (snapshotPaths === undefined) {
      let currentPaths;
      try {
        const { stdout } = await runGit('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
          { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: budgetMs, signal });
        currentPaths = [...new Set(stdout.split('\0').filter(file => extensions.includes(path.posix.extname(file))
          && !file.split('/').some(part => generated.has(part))
          && !excluded.some(parent => within(parent, path.resolve(root, file)))))].sort();
      } catch { signal?.throwIfAborted(); return { current: false, reason: 'INDEX_INVENTORY_UNAVAILABLE' }; }
      if (sourceHash(currentPaths) !== sourceHash(originSnapshot.inventory)) return { current: false, reason: 'INDEX_INVENTORY_CHANGED' };
    }
    for (const input of originSnapshot.sources) {
      signal?.throwIfAborted();
      if (Date.now() >= currentnessDeadline) return { current: false, reason: 'INDEX_CURRENTNESS_LIMIT' };
      const absolute = path.resolve(root, input.path);
      try {
        if (await fs.realpath(absolute) !== absolute || (await fs.lstat(absolute)).size !== input.bytes
          || sourceHash(await fs.readFile(absolute, { signal })) !== input.sha256)
          return { current: false, reason: 'INDEX_SOURCE_CHANGED' };
      } catch { signal?.throwIfAborted(); return { current: false, reason: 'INDEX_SOURCE_CHANGED' }; }
    }
    for (const file of originSnapshot.absentSources) {
      signal?.throwIfAborted();
      if (Date.now() >= currentnessDeadline) return { current: false, reason: 'INDEX_CURRENTNESS_LIMIT' };
      try { await fs.lstat(path.resolve(root, file)); return { current: false, reason: 'INDEX_SOURCE_RECREATED' }; }
      catch (error) { if (error.code !== 'ENOENT') return { current: false, reason: 'INDEX_ABSENCE_UNAVAILABLE' }; }
    }
    return { current: true, fingerprint: originSnapshot.fingerprint };
  }
  return {
    ...summary,
    originIndexSnapshot: () => structuredClone(originSnapshot),
    originEntry,
    originOpaqueReference,
    checkOriginIndexCurrent,
    affectedSymbols: changes => affectedSemanticSymbols(sources, references, changes),
    removedLiteralUses,
    query({ operation, symbol, file, direction, offset = 0, query, value, depth = 1 }) {
      if (operation === 'summary') return summary;
      if (operation === 'incoming' || operation === 'outgoing') {
        direction = operation;
        operation = 'context';
      }
      if (['definition', 'context'].includes(operation) && !symbol || ['dependencies', 'outline'].includes(operation) && !file)
        throw Object.assign(new Error('Supply a symbol for definition/context or a file for dependencies/outline.'), { code: 'TASK_SUBMISSION_INVALID' });
      if (operation === 'search' && (typeof query !== 'string' || !query.trim() || query.length > 512))
        throw Object.assign(new Error('Supply a short query for search.'), { code: 'TASK_SUBMISSION_INVALID' });
      if (operation === 'literal' && typeof value !== 'string')
        throw Object.assign(new Error('Supply an exact string value for literal.'), { code: 'TASK_SUBMISSION_INVALID' });
      if (!Number.isInteger(depth) || depth < 1 || depth > 3)
        throw Object.assign(new Error('Supply a call depth between one and three.'), { code: 'TASK_SUBMISSION_INVALID' });
      const relative = typeof file === 'string' ? normalizePath(file) : null;
      const limit = 12;
      const matching = (definitions.get(symbol) ?? []).filter(({ item }) => !relative || item.path === relative);
      let results, context;
      if (operation === 'definition') results = matching.map(({ item }) => item);
      if (operation === 'dependencies') results = [...moduleDiagnostics.get(relative) ?? [], ...outgoing.get(relative) ?? [], ...incoming.get(relative) ?? []];
      if (operation === 'outline') results = (sources.get(relative)?.symbols ?? []).map(describeSemanticSymbol);
      if (operation === 'search') results = search(query, relative);
      if (operation === 'literal') results = (literals.get(value) ?? []).filter(hit => !relative || hit.path === relative)
        .sort((a, b) => Number(b.kind === 'case') - Number(a.kind === 'case'));
      if (operation === 'context') {
        context = { definitions: matching.slice(0, 6).map(describeSemanticSymbol), ambiguous: matching.length > 1 };
        const record = matching.length === 1 ? matching[0] : null;
        if (record) {
          const testBoundaries = semanticTestBoundaries(record, references);
          if (testBoundaries.length) context.testBoundaries = testBoundaries;
        }
        if (record?.literalMembers) {
          context.literalMembers = record.literalMembers.slice(0, limit);
          context.literalMemberCount = record.literalMembers.length;
        }
        if (record?.controls?.length && direction !== 'incoming') {
          // Recovery and exit landmarks are easier to miss in long methods.
          const priority = site => ['try', 'catch', 'finally', 'throw'].includes(site.kind) ? 0 : 1;
          context.controlSites = record.controls.slice().sort((a, b) => priority(a) - priority(b))
            .slice(0, 12).sort((a, b) => a.line - b.line);
        }
        results = [];
        if (record) for (const ref of semanticReferences(record, references, { direction, depth })) {
          results.push(ref);
          if (results.length > offset + limit) break;
        }
      }
      results ??= [];
      return { ...summary, ...context, ...(relative ? { indexed: sources.has(relative) } : {}),
        hits: results.slice(offset, offset + limit), nextOffset: results.length > offset + limit ? offset + limit : null };
    },
  };
}
