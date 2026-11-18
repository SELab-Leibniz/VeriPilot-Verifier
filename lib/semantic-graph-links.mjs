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
    for (const record of source.symbols) if (!record.item.kind.startsWith('test')) append(source.definitions, qualified(record), record);
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

  const incoming = new Map(), outgoing = new Map(), callTargets = new Map(), callOrigins = new Map();
  for (const [file, source] of sources) {
    const testSource = isTestSource(file);
    for (const use of source.uses) {
      const target = use.resolvable ? resolve(source, use) : null;
      if (!target && !(use.origin && use.relation === 'call')) continue;
      const catchReturns = use.relation === 'call' ? target?.catchReturns : undefined;
      const targetPath = target ? { path: target.item.path, symbol: qualified(target), line: target.item.line,
        ...(catchReturns?.length ? { catchReturns: catchReturns.slice(0, 3), catchReturnCount: catchReturns.length } : {}) }
        : { symbol: use.label, resolution: 'unresolved' };
      const origin = use.origin;
      const ref = {
        path: file, line: use.line, relation: use.relation, target: targetPath,
        ...(origin ? { within: qualified(origin) } : {}),
        ...(testSource ? { testSource: true } : {}),
        ...(origin?.item.kind === 'test-hook' ? { testScope: describeSemanticSymbol(origin) } : {}),
        ...(use.argumentTo ? { argumentTo: use.argumentTo } : {}),
        ...(use.awaited ? { awaited: true } : {}),
        ...(use.members.length > 1 ? { access: use.members.join('.') } : {}),
      };
      if (target && use.relation === 'call') {
        callTargets.set(ref, target);
        if (origin) callOrigins.set(ref, origin);
      }
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
  return { incoming, outgoing, callTargets, callOrigins,
    // Internal lexical lookup for conservative opaque-origin navigation. A
    // resolved name is not a newly observed use, call or edge.
    resolveLexicalTarget: (file, use) => sources.has(file) ? resolve(sources.get(file), use) : null };
}

export function* semanticReferences(record, references, { direction, depth = 1 } = {}) {
  for (const selected of ['outgoing', 'incoming']) {
    if (direction && direction !== selected) continue;
    const queue = [{ record, via: [] }], visited = new Set([record]);
    for (const { record: current, via } of queue) {
      for (const ref of references[selected].get(current) ?? []) {
        yield { direction: selected, ...ref, ...(via.length ? { via } : {}) };
        const target = (selected === 'outgoing' ? references.callTargets : references.callOrigins).get(ref);
        if (!target || via.length + 1 >= depth || visited.has(target)) continue;
        visited.add(target);
        queue.push({ record: target, via: [...via, { path: ref.path, line: ref.line, within: ref.within, target: ref.target.symbol }] });
      }
    }
  }
}

export const describeSemanticSymbol = ({ item, endLine }) => ({ ...item, endLine });

// These are syntactic navigation facts, not assertions that a helper replaces
// the dependency or that the later calls are reached on the same control path.
export function semanticTestBoundaries(record, references, limit = 6) {
  const callers = [record];
  for (const ref of references.incoming.get(record) ?? []) {
    const caller = !ref.testSource && references.callOrigins.get(ref);
    if (caller && !callers.includes(caller)) callers.push(caller);
  }
  const groups = [], seen = new Set();
  for (const caller of callers) {
    const outgoing = references.outgoing.get(caller) ?? [];
    const testPaths = new Set((references.incoming.get(caller) ?? []).filter(ref => ref.testSource).map(ref => ref.path));
    const calls = outgoing.filter(ref => references.callTargets.has(ref)).sort((a, b) =>
      Number(references.callTargets.get(b) === record) - Number(references.callTargets.get(a) === record));
    const group = [];
    for (const call of calls) {
      if (call.testSource) continue;
      const dependency = references.callTargets.get(call);
      if (!dependency) continue;
      const argumentsInTests = (references.incoming.get(dependency) ?? []).filter(ref => ref.testSource && ref.argumentTo)
        .sort((a, b) => Number(testPaths.has(b.path)) - Number(testPaths.has(a.path)));
      for (const argument of argumentsInTests) {
        const key = [call.path, call.line, argument.path, argument.line, argument.argumentTo.argumentIndex].join('\0');
        if (seen.has(key)) continue;
        seen.add(key);
        group.push({ caller: describeSemanticSymbol(caller), call, testArgument: argument,
          laterSites: outgoing.filter(ref => ref.line > call.line && ['call', 'write'].includes(ref.relation)).slice(0, 4) });
        if (group.length >= limit) break;
      }
      if (group.length >= limit) break;
    }
    groups.push(group);
  }
  // One heavily tested caller must not hide the other public entry points.
  const boundaries = [];
  for (let i = 0; i < limit; i++) for (const group of groups) if (group[i]) {
    boundaries.push(group[i]);
    if (boundaries.length >= limit) return boundaries;
  }
  return boundaries;
}

export function affectedSemanticSymbols(sources, references, changes) {
  const sites = [];
  for (const { path: file, hunks } of changes) {
    if (!hunks?.length || isTestSource(file)) continue;
    for (const record of sources.get(file)?.symbols ?? []) {
      if (!(['function', 'method', 'field'].includes(record.item.kind) || record.literalMembers)
        || !hunks.some(([start, end]) => start <= record.endLine && record.item.line <= end)) continue;
      const incoming = references.incoming.get(record) ?? [];
      const caller = incoming.find(ref => !ref.testSource);
      const test = incoming.find(ref => ref.testSource);
      if (!caller && !test) continue;
      const outgoing = references.outgoing.get(record) ?? [];
      const effects = ['call', 'write'].map(relation => outgoing.find(ref => ref.relation === relation)).filter(Boolean);
      const testBoundaries = semanticTestBoundaries(record, references, 3);
      sites.push({ definition: describeSemanticSymbol(record), ...(caller ? { caller } : {}), ...(test ? { test } : {}), effects,
        ...(testBoundaries.length ? { testBoundaries } : {}) });
    }
  }
  return sites.sort((a, b) => Number(Boolean(b.test)) - Number(Boolean(a.test))).slice(0, 6);
}
