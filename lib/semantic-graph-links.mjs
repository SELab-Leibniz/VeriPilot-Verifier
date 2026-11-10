import { isTestSource } from './semantic-graph-syntax.mjs';

const qualified = ({ item }) => item.qualified ?? item.symbol;
const unique = values => {
  const matches = new Set(values.filter(Boolean));
  return matches.size === 1 ? matches.values().next().value : null;
};

function append(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function linkSemanticSources(sources) {
  for (const source of sources.values()) {
    source.definitions = new Map();
    source.imports = new Map();
    for (const record of source.symbols) if (record.item.kind !== 'test') append(source.definitions, qualified(record), record);
    for (const entry of source.modules.filter(entry => entry.kind === 'import'))
      for (const [name, remote] of entry.names) append(source.imports, name, { remote, file: entry.target });
  }

  const exportCache = new Map();
  const local = (source, name) => unique(source.definitions.get(name) ?? []);
  function exported(file, name, visited = new Set()) {
    const key = file + '\0' + name;
    if (exportCache.has(key)) return exportCache.get(key);
    if (visited.has(key) || visited.size >= 24) return null;
    const source = sources.get(file);
    if (!source) return null;
    if (source.exports.has(name)) return source.exports.get(name);
    const next = new Set([...visited, key]);
    const matches = [];
    for (const entry of source.modules) {
      if (entry.kind !== 'export') continue;
      for (const [alias, remote] of entry.names) {
        if (alias === '*' && remote === '*' && name !== 'default') matches.push(exported(entry.target, name, next));
        else if (alias === name && remote !== '*') {
          if (entry.specifier) matches.push(exported(entry.target, remote, next));
          else {
            const imported = source.imports.get(remote);
            if (imported?.length === 1) matches.push(exported(imported[0].file, imported[0].remote, next));
            else if (!imported) matches.push(local(source, remote));
          }
        }
      }
    }
    const target = unique(matches);
    if (!visited.size) exportCache.set(key, target);
    return target;
  }

  function resolve(source, use) {
    let members = use.members, base;
    const imports = use.localOnly ? null : source.imports.get(use.name);
    if (imports) {
      if (imports.length !== 1) return null;
      const binding = imports[0];
      if (binding.remote === '*') {
        if (!members.length) return null;
        base = exported(binding.file, members[0]);
        members = members.slice(1);
      } else base = exported(binding.file, binding.remote);
    } else base = local(source, use.name);
    if (!base || !members.length) return base;
    const definitions = sources.get(base.item.path)?.definitions;
    const candidates = definitions?.get(base.item.symbol + '.' + members[0]) ?? [];
    const target = unique(candidates.filter(record => record.isStatic !== use.instance));
    if (!target || members.length > 1 && target.item.kind !== 'field') return null;
    return target;
  }

  const incoming = new Map(), outgoing = new Map();
  for (const [file, source] of sources) {
    const testSource = isTestSource(file);
    for (const use of source.uses) {
      const target = use.resolvable ? resolve(source, use) : null;
      if (!target && !(use.origin && use.relation === 'call')) continue;
      const targetPath = target ? { path: target.item.path, symbol: qualified(target), line: target.item.line }
        : { symbol: use.label, resolution: 'unresolved' };
      const origin = use.origin;
      const ref = {
        path: file, line: use.line, relation: use.relation, target: targetPath,
        ...(origin ? { within: qualified(origin) } : {}),
        ...(testSource ? { testSource: true } : {}),
        ...(use.awaited ? { awaited: true } : {}),
        ...(use.members.length > 1 ? { access: use.members.join('.') } : {}),
      };
      if (target) append(incoming, target, ref);
      if (origin) append(outgoing, origin, ref);
    }
  }
  for (const [record, references] of incoming) {
    // Reserve first-page space for both the production path and its tests.
    const score = ref => ref.relation === 'call' ? 2 : ref.relation === 'write' ? 1 : 0;
    const production = references.filter(ref => !ref.testSource).sort((a, b) => score(b) - score(a));
    const tests = references.filter(ref => ref.testSource).sort((a, b) => score(b) - score(a));
    const ranked = [];
    for (let i = 0; i < Math.max(production.length, tests.length); i++) {
      if (production[i]) ranked.push(production[i]);
      if (tests[i]) ranked.push(tests[i]);
    }
    incoming.set(record, ranked);
  }
  for (const [record, references] of outgoing) {
    outgoing.set(record, [...references.filter(ref => ref.relation !== 'reference'), ...references.filter(ref => ref.relation === 'reference')]);
  }
  return { incoming, outgoing };
}

export const describeSemanticSymbol = ({ item, endLine }) => ({ ...item, endLine });
