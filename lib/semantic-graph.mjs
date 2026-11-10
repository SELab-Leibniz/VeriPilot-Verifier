import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanSemanticSource } from './semantic-graph-syntax.mjs';
import { describeSemanticSymbol, linkSemanticSources } from './semantic-graph-links.mjs';
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
  description: 'Navigate source. Use search with a short query, or definition/context with an exact symbol such as Type.method. Use incoming for callers and tests, outgoing for calls and writes, or outline/dependencies with a project-relative file. Follow nextOffset for more hits. Read source to confirm.',
  parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { enum: ['summary', 'definition', 'dependencies', 'outline', 'context', 'search', 'incoming', 'outgoing'] },
    query: { type: 'string', minLength: 1, maxLength: 512 },
    symbol: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 0 },
    direction: { enum: ['incoming', 'outgoing'] },
  } },
};

export async function semanticGraphInstructions(signal) {
  const file = new URL('./review-task/skills/code-understanding/SKILL.md', import.meta.url);
  const skill = await fs.readFile(file, { encoding: 'utf8', signal }).catch(() => '');
  return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
    || 'Use semantic_graph to locate the relevant entry point and related source. Verify findings with source_read.';
}

function resolveModule(from, specifier, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (files.has(base)) return base;
  // ESM TypeScript projects may spell a source import with its emitted suffix.
  const suffix = path.posix.extname(base);
  const candidates = emittedExtensions.has(suffix) ? [base.slice(0, -suffix.length) + emittedExtensions.get(suffix)]
    : [...extensions.map(ext => base + ext), ...extensions.map(ext => path.posix.join(base, 'index' + ext))];
  const matches = candidates.filter(file => files.has(file));
  return matches.length === 1 ? matches[0] : null;
}

/** Build a bounded navigation index from the given snapshot inventory or the current Git worktree. */
export async function buildSemanticGraph(projectRoot, { signal, budgetMs = 1500, preferredPaths = [], excludedPaths = [], snapshotPaths } = {}) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(budgetMs);
  const buildSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const sources = new Map(), definitions = new Map(), outgoing = new Map(), incoming = new Map();
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
  let unresolved = 0;
  for (const [from, source] of sources) {
    for (const entry of source.modules) {
      if (!relativeModule.test(entry.specifier ?? '')) continue;
      const to = resolveModule(from, entry.specifier, candidates);
      if (!sources.has(to)) { unresolved++; continue; }
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
  const summary = { status: incomplete ? 'partial' : 'ready', navigationOnly: true, files: sources.size, unresolved };
  return {
    ...summary,
    query({ operation, symbol, file, direction, offset = 0, query }) {
      if (operation === 'summary') return summary;
      if (operation === 'incoming' || operation === 'outgoing') {
        direction = operation;
        operation = 'context';
      }
      if (['definition', 'context'].includes(operation) && !symbol || ['dependencies', 'outline'].includes(operation) && !file)
        throw Object.assign(new Error('Supply a symbol for definition/context or a file for dependencies/outline.'), { code: 'TASK_SUBMISSION_INVALID' });
      if (operation === 'search' && (typeof query !== 'string' || !query.trim() || query.length > 512))
        throw Object.assign(new Error('Supply a short query for search.'), { code: 'TASK_SUBMISSION_INVALID' });
      const relative = typeof file === 'string' ? normalizePath(file) : null;
      const limit = 12;
      const matching = (definitions.get(symbol) ?? []).filter(({ item }) => !relative || item.path === relative);
      let results, context;
      if (operation === 'definition') results = matching.map(({ item }) => item);
      if (operation === 'dependencies') results = [...outgoing.get(relative) ?? [], ...incoming.get(relative) ?? []];
      if (operation === 'outline') results = (sources.get(relative)?.symbols ?? []).map(describeSemanticSymbol);
      if (operation === 'search') results = search(query, relative);
      if (operation === 'context') {
        context = { definitions: matching.slice(0, 6).map(describeSemanticSymbol), ambiguous: matching.length > 1 };
        const record = matching.length === 1 ? matching[0] : null;
        if (record?.controls?.length && direction !== 'incoming') {
          // Recovery and exit landmarks are easier to miss in long methods.
          const priority = site => ['try', 'catch', 'finally', 'throw'].includes(site.kind) ? 0 : 1;
          context.controlSites = record.controls.slice().sort((a, b) => priority(a) - priority(b))
            .slice(0, 12).sort((a, b) => a.line - b.line);
        }
        results = record ? [
          ...(direction !== 'incoming' ? (references.outgoing.get(record) ?? []).map(ref => ({ direction: 'outgoing', ...ref })) : []),
          ...(direction !== 'outgoing' ? (references.incoming.get(record) ?? []).map(ref => ({ direction: 'incoming', ...ref })) : []),
        ] : [];
      }
      results ??= [];
      return { ...summary, ...context, ...(relative ? { indexed: sources.has(relative) } : {}),
        hits: results.slice(offset, offset + limit), nextOffset: results.length > offset + limit ? offset + limit : null };
    },
  };
}
