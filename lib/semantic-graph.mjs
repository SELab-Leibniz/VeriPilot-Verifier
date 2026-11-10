import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runGit = promisify(execFile);
const extensions = ['.ets', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const emittedExtensions = new Map([['.js', '.ts'], ['.mjs', '.mts'], ['.cjs', '.cts'], ['.jsx', '.tsx']]);
const generated = new Set(['.git', '.runtime-correction', '.test', '.hvigor', '.ohpm', 'node_modules', 'oh_modules', 'build', 'dist', 'coverage']);
const declarations = new Set(['class', 'struct', 'interface', 'enum', 'namespace', 'function', 'type', 'const', 'let', 'var']);
const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*(?:`|$)|\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*|[\p{ID_Start}$_][\p{ID_Continue}$]*|\s+|./gu;
const newline = /\r\n?|\n|\u2028|\u2029/gu;
const relativeModule = /^['"](\.{1,2}\/[^'"\\]+)['"]$/u;
const normalizePath = value => value.replaceAll('\\', '/').replace(/^\.\//u, '');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export const SEMANTIC_GRAPH_TOOL = {
  name: 'semantic_graph',
  label: 'semantic_graph',
  description: 'Query the source index. Use summary, definition with an exact symbol (optionally scoped to file), or dependencies with a project-relative file. Follow nextOffset for additional hits. Results are navigation only.',
  parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { enum: ['summary', 'definition', 'dependencies'] },
    symbol: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 0 },
  } },
};

function lexicalTokens(source) {
  const code = [];
  let line = 1;
  for (const [value] of source.matchAll(tokens)) {
    if (!/^\s|^\/\/|^\/\*/u.test(value)) code.push({ value, line });
    line += [...value.matchAll(newline)].length;
  }
  return code;
}

function moduleSpecifier(code, index) {
  const kind = code[index].value;
  const at = offset => code[offset]?.value ?? '';
  let cursor = index + 1;
  if (kind === 'import' && /^['"]/u.test(at(cursor))) return at(cursor);
  if (at(cursor) === 'type' && at(cursor + 1) !== 'from') cursor++;
  if (kind === 'import' && identifier.test(at(cursor))) {
    cursor++;
    if (at(cursor) === ',') cursor++;
  }
  if (at(cursor) === '{') {
    while (cursor < code.length && at(cursor) !== '}') cursor++;
    cursor++;
  } else if (at(cursor) === '*') {
    cursor++;
    if (at(cursor) === 'as' && identifier.test(at(cursor + 1))) cursor += 2;
  } else if (kind === 'export') return '';
  return at(cursor) === 'from' ? at(cursor + 1) : '';
}

function indexSource(source, file) {
  const code = lexicalTokens(source);
  const symbols = [], references = [];
  let depth = 0;
  for (const [index, token] of code.entries()) {
    const { value, line } = token, next = code[index + 1]?.value ?? '';
    if (value === '{') depth++;
    if (value === '}') depth = Math.max(0, depth - 1);
    if (depth || code[index - 1]?.value === '.') continue;
    if (declarations.has(value) && identifier.test(next) && next !== 'enum'
      && !(value === 'type' && code[index - 1]?.value === 'import'))
      symbols.push({ path: file, symbol: next, kind: value, line });
    if (value === 'import' || value === 'export') {
      const specifier = relativeModule.exec(moduleSpecifier(code, index))?.[1];
      if (specifier) references.push({ from: file, specifier, kind: value, line });
    }
  }
  return { symbols, references };
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
  const files = new Set(), definitions = new Map(), outgoing = new Map(), incoming = new Map();
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
  const references = [];
  let readBytes = 0, incomplete = false;
  for (const file of paths) {
    signal?.throwIfAborted();
    if (timeout.aborted || files.size >= 4000 || readBytes >= 16 * 1024 * 1024) { incomplete = true; break; }
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
      const indexed = indexSource(source, file);
      files.add(file);
      for (const item of indexed.symbols) {
        if (!definitions.has(item.symbol)) definitions.set(item.symbol, []);
        definitions.get(item.symbol).push(item);
      }
      references.push(...indexed.references);
    } catch (error) {
      if (error.code !== 'ENOENT') incomplete = true;
    }
  }
  signal?.throwIfAborted();
  let unresolved = 0;
  for (const { from, specifier, kind, line } of references) {
    const to = resolveModule(from, specifier, candidates);
    if (!files.has(to)) { unresolved++; continue; }
    const edge = { from, to, kind, line };
    if (!outgoing.has(from)) outgoing.set(from, []);
    if (!incoming.has(to)) incoming.set(to, []);
    outgoing.get(from).push(edge);
    incoming.get(to).push(edge);
  }
  const summary = { status: incomplete ? 'partial' : 'ready', navigationOnly: true, files: files.size, unresolved };
  return {
    ...summary,
    query({ operation, symbol, file, offset = 0 }) {
      if (operation === 'summary') return summary;
      if (operation === 'definition' && !symbol || operation === 'dependencies' && !file)
        throw Object.assign(new Error('Supply symbol for definition or file for dependencies.'), { code: 'TASK_SUBMISSION_INVALID' });
      const relative = typeof file === 'string' ? normalizePath(file) : null;
      const results = operation === 'definition' ? (definitions.get(symbol) ?? []).filter(item => !relative || item.path === relative)
        : operation === 'dependencies' ? [...outgoing.get(relative) ?? [], ...incoming.get(relative) ?? []] : [];
      const limit = 12;
      return { ...summary, ...(relative ? { indexed: files.has(relative) } : {}),
        hits: results.slice(offset, offset + limit), nextOffset: results.length > offset + limit ? offset + limit : null };
    },
  };
}
