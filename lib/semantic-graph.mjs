import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanSemanticSource } from './semantic-graph-syntax.mjs';
import { affectedSemanticSymbols, describeSemanticSymbol, linkSemanticSources, semanticReferences } from './semantic-graph-links.mjs';
import { createSemanticSearch } from './semantic-graph-search.mjs';

const runGit = promisify(execFile);
const extensions = ['.ets', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const emittedExtensions = new Map([['.js', '.ts'], ['.mjs', '.mts'], ['.cjs', '.cts'], ['.jsx', '.tsx']]);
const generated = new Set(['.git', '.runtime-correction', '.runtime-corrector', '.test', '.hvigor', '.ohpm', 'node_modules', 'oh_modules', 'build', 'dist', 'coverage']);
const relativeModule = /^\.{1,2}\//u;
const normalizePath = value => value.replaceAll('\\', '/').replace(/^\.\//u, '');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export const SEMANTIC_GRAPH_TOOL = {
  name: 'semantic_graph',
  label: 'semantic_graph',
  description: 'Navigate source. Use search for a short phrase, definition/context for a symbol such as Type.method, or literal with an exact string value to find its case branches and other occurrences. Use incoming for callers and tests, including argumentTo locations and zero-based argumentIndex where a test passes the symbol into a helper. Use outgoing for calls, writes and returns inside callee catch blocks, or outline/dependencies with a project-relative file. Dependencies can show file name case mismatches. Follow nextOffset for more hits. Read source to confirm.',
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
      for (const record of indexed.symbols) {
        for (const symbol of [record.item.symbol, record.item.qualified].filter(Boolean)) {
          if (!definitions.has(symbol)) definitions.set(symbol, []);
          definitions.get(symbol).push(record);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') incomplete = true;
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
  return {
    ...summary,
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
