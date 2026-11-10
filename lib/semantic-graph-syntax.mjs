const declarations = new Set(['class', 'struct', 'interface', 'enum', 'namespace', 'function', 'type', 'const', 'let', 'var']);
const classKinds = new Set(['class', 'struct', 'interface']);
const variables = new Set(['const', 'let', 'var']);
const modifiers = new Set(['public', 'protected', 'private', 'readonly', 'static', 'async', 'override', 'abstract', 'get', 'set', 'declare']);
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '??=', '||=', '&&=', '++', '--']);
const flowKeywords = new Set(['if', 'else', 'switch', 'try', 'catch', 'finally', 'return', 'throw']);
const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
const lexeme = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*(?:`|$)|\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*|[\p{ID_Start}$_][\p{ID_Continue}$]*|===|!==|==|!=|=>|\?\?=|\|\|=|&&=|\?\.|[+-]{2}|[-+*/]=|\s+|./gu;
const newline = /\r\n?|\n|\u2028|\u2029/gu;
const delimiters = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const isDot = value => value === '.' || value === '?.';
const unquote = value => /^(['"])(?:(?!\1)[^\\\r\n])*\1$/u.test(value) ? value.slice(1, -1) : null;
export const isTestSource = file => /(?:^|\/)(?:test|tests|ohosTest|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(file);

function tokenize(source) {
  const code = [];
  let line = 1;
  for (const [value] of source.matchAll(lexeme)) {
    if (!/^\s|^\/\/|^\/\*/u.test(value)) code.push({ value, line, pair: -1, parent: -1, brace: -1 });
    if (/[\r\n\u2028\u2029]/u.test(value)) line += [...value.matchAll(newline)].length;
  }
  const stack = [], braces = [];
  for (const [i, token] of code.entries()) {
    token.parent = stack.at(-1) ?? -1;
    token.brace = braces.at(-1) ?? -1;
    if (delimiters.has(token.value)) {
      stack.push(i);
      if (token.value === '{') braces.push(i);
    } else if (delimiters.get(code[stack.at(-1)]?.value) === token.value) {
      const open = stack.pop();
      token.pair = open;
      code[open].pair = i;
      if (token.value === '}') braces.pop();
    }
  }
  return code;
}

function statementBinding(code, index) {
  const at = i => code[i]?.value ?? '';
  const kind = at(index);
  let cursor = index + 1;
  if (kind === 'import' && unquote(at(cursor))) return { end: cursor, specifier: unquote(at(cursor)), names: [] };
  if (at(cursor) === 'type' && at(cursor + 1) !== 'from') cursor++;
  const names = [];
  if (kind === 'import' && identifier.test(at(cursor))) {
    names.push([at(cursor++), 'default']);
    if (at(cursor) === ',') cursor++;
  }
  if (at(cursor) === '{' && code[cursor].pair > cursor) {
    const end = code[cursor].pair;
    for (cursor++; cursor < end; cursor++) {
      if (at(cursor) === 'type' && identifier.test(at(cursor + 1)) && at(cursor + 1) !== 'as') cursor++;
      if (!identifier.test(at(cursor))) continue;
      const name = at(cursor);
      if (at(cursor + 1) === 'as' && identifier.test(at(cursor + 2))) cursor += 2;
      names.push([at(cursor), name]);
    }
    cursor = end + 1;
  } else if (at(cursor) === '*') {
    cursor++;
    if (at(cursor) === 'as' && identifier.test(at(cursor + 1))) {
      names.push([at(cursor + 1), '*']);
      cursor += 2;
    } else names.push(['*', '*']);
  } else if (kind === 'export') return null;
  if (at(cursor) === 'from' && unquote(at(cursor + 1))) return { end: cursor + 1, specifier: unquote(at(cursor + 1)), names };
  if (kind === 'export' && names.length) return { end: cursor - 1, specifier: null, names };
  return null;
}

function skipTypeParameters(code, index) {
  if (code[index]?.value !== '<') return index;
  let depth = 0;
  for (let i = index; i < code.length; i++) {
    if (code[i].value === '<') depth++;
    if (code[i].value === '>' && --depth === 0) return i + 1;
    if ([';', '{', '}'].includes(code[i].value)) break;
  }
  return index;
}

function literalUnion(code, index) {
  if (code[index]?.value !== '=') return [];
  let cursor = index + 1;
  if (code[cursor]?.value === '|') cursor++;
  const members = [];
  while (cursor < code.length) {
    const token = code[cursor];
    const value = unquote(token.value);
    if (value === null) break;
    members.push({ value, line: token.line, index: cursor });
    const next = code[++cursor];
    if (!next || next.value === ';' || next.line > token.line && identifier.test(next.value)) return members;
    if (next.value !== '|') break;
    cursor++;
  }
  return [];
}

function bodyAfterParameters(code, parameters) {
  const end = code[parameters]?.pair;
  if (code[parameters]?.value !== '(' || !(end > parameters)) return -1;
  let i = end + 1;
  if (code[i]?.value === ':') {
    i++;
    // A leading object type and balanced tuple/generic types can precede the body.
    if (code[i]?.value === '{' && code[i].pair > i) i = code[i].pair + 1;
    for (; i < code.length; i++) {
      const token = code[i];
      if (token.value === '{') break;
      if ([';', '}', '=', '=>'].includes(token.value) || token.line > code[i - 1].line && identifier.test(token.value)) return -1;
      if (token.value === '<') {
        const after = skipTypeParameters(code, i);
        if (after > i) i = after - 1;
      } else if (token.pair > i) i = token.pair;
    }
  }
  return code[i]?.value === '{' && code[i].pair > i ? i : -1;
}

function classBody(code, index) {
  for (let i = skipTypeParameters(code, index); i < code.length && code[i].parent === -1; i++) {
    if (code[i].value === '{' && code[i].pair > i) return i;
    if ([';', '='].includes(code[i].value)) break;
  }
  return -1;
}

function functionParameters(code, index) {
  let i = index + 1;
  if (code[i]?.value === '*') i++;
  if (identifier.test(code[i]?.value ?? '')) i++;
  return skipTypeParameters(code, i);
}

function testBody(code, index) {
  const call = index + 1;
  if (code[call]?.value !== '(' || code[call].pair <= call) return null;
  const name = unquote(code[call + 1]?.value ?? '');
  if (!name || code[call + 2]?.value !== ',') return null;
  for (let i = call + 3; i < code[call].pair; i++) {
    if (code[i].parent !== call) continue;
    const body = code[i].value === '=>' && code[i + 1]?.value === '{' ? i + 1
      : code[i].value === 'function' ? bodyAfterParameters(code, functionParameters(code, i)) : -1;
    if (body > i && code[body].pair > body) return { name, body };
  }
  return null;
}

function exportName(code, i, name) {
  if (code[i - 1]?.value === 'async' || code[i - 1]?.value === 'abstract') i--;
  if (code[i - 1]?.value === 'default' && code[i - 2]?.value === 'export') return 'default';
  return code[i - 1]?.value === 'export' ? name : null;
}

function memberBoundary(code, i, body) {
  let previous = i - 1;
  while (previous > body && modifiers.has(code[previous].value)) previous--;
  return previous === body || [';', '}'].includes(code[previous].value) || code[previous].line < code[previous + 1].line;
}

function typeBinding(code, i) {
  const at = n => code[n]?.value ?? '';
  const next = at(i + 1) === '?' || at(i + 1) === '!' ? i + 2 : i + 1;
  if (at(next) === ':') {
    // Union/array/function types cannot establish a unique receiver.
    if (identifier.test(at(next + 1)) && !['|', '&', '[', '<', '.'].includes(at(next + 2))) return at(next + 1);
    return null;
  }
  if (at(next) === '=' && at(next + 1) === 'new' && identifier.test(at(next + 2)) && at(next + 3) === '(')
    return at(next + 2);
  return null;
}

function indexMembers(code, body, owner, add, scopes) {
  for (let i = body + 1; i < code[body].pair; i++) {
    const { value: name, parent } = code[i];
    if (parent !== body || !identifier.test(name) || modifiers.has(name) && !['(', '<'].includes(code[i + 1]?.value)
      || !memberBoundary(code, i, body)) continue;
    const parameters = skipTypeParameters(code, i + 1);
    const methodBody = bodyAfterParameters(code, parameters);
    let modifier = i - 1;
    while (modifier > body && modifiers.has(code[modifier].value) && code[modifier].value !== 'static') modifier--;
    const staticallyBound = code[modifier]?.value === 'static';
    if (methodBody >= 0) {
      add(i, name === 'constructor' ? 'constructor' : 'method', owner, methodBody, staticallyBound);
      scopes.set(methodBody, parameters);
    } else if (['=', ':', '?', '!'].includes(code[i + 1]?.value)) {
      add(i, 'field', owner, -1, staticallyBound);
    }
  }
}

function localBindings(code, scopes) {
  const bindings = new Map();
  const bind = (brace, i) => {
    if (!bindings.has(brace)) bindings.set(brace, new Map());
    const local = bindings.get(brace), name = code[i].value, type = typeBinding(code, i);
    local.set(name, local.has(name) ? null : type);
  };
  for (const [body, parameters] of scopes) {
    if (code[parameters]?.value !== '(') {
      if (identifier.test(code[parameters]?.value ?? '')) bind(body, parameters);
      continue;
    }
    for (let i = parameters + 1; i < code[parameters].pair; i++) {
      if (code[i].parent !== parameters || !identifier.test(code[i].value) || modifiers.has(code[i].value)) continue;
      let previous = i - 1;
      while (modifiers.has(code[previous]?.value)) previous--;
      if (previous === parameters || code[previous].value === ',') bind(body, i);
    }
  }
  for (const [i, token] of code.entries()) {
    if (token.brace < 0 || !declarations.has(token.value) || !identifier.test(code[i + 1]?.value ?? '') || isDot(code[i - 1]?.value)) continue;
    let brace = token.brace;
    if (token.value === 'var') {
      while (brace >= 0 && !scopes.has(brace)) brace = code[brace].brace;
    }
    bind(brace, i + 1);
  }
  return bindings;
}

function lookupBinding(code, bindings, token, name) {
  for (let brace = token.brace; brace >= 0; brace = code[brace].brace) {
    const scope = bindings.get(brace);
    if (scope?.has(name)) return scope.get(name);
  }
  return bindings.get(-1)?.get(name);
}

function controlSite(code, i) {
  const { value: kind, line } = code[i];
  let after = i + 1;
  if (code[after]?.value === '(' && code[after].pair > after) after = code[after].pair + 1;
  const end = code[after]?.value === '{' && code[after].pair > after ? code[after].pair : after - 1;
  return { kind, line, ...(code[end].line > line ? { endLine: code[end].line } : {}) };
}

export function scanSemanticSource(source, file) {
  const code = tokenize(source);
  const symbols = [], modules = [], uses = [], literals = [], declared = new Set(), moduleTokens = new Set(), scopes = new Map(), exports = new Map();
  const owners = new Map(), fields = new Map(), ordinaryFunctions = new Set();
  const unionOwners = new Map();
  const testSource = isTestSource(file);
  const add = (i, kind, owner, body, isStatic = false) => {
    const { value: symbol, line } = code[i];
    const item = { path: file, symbol, kind, line, ...(owner ? { owner, qualified: owner + '.' + symbol } : {}) };
    const endLine = body >= 0 ? code[code[body].pair].line : line;
    const record = { item, endLine, isStatic };
    symbols.push(record);
    declared.add(i);
    if (body >= 0) owners.set(body, record);
    if (owner && kind === 'field') fields.set(item.qualified, typeBinding(code, i));
    return record;
  };
  for (const [i, token] of code.entries()) {
    const { value, line, parent } = token;
    if (value === '=>' && code[i + 1]?.value === '{' && code[i + 1].pair > i)
      scopes.set(i + 1, code[i - 1]?.value === ')' ? code[i - 1].pair : i - 1);
    if (value === 'function' && !isDot(code[i - 1]?.value)) {
      const parameters = functionParameters(code, i);
      const body = bodyAfterParameters(code, parameters);
      if (body >= 0) { scopes.set(body, parameters); ordinaryFunctions.add(body); }
    }
    if (testSource && ['test', 'it'].includes(value) && !isDot(code[i - 1]?.value)) {
      const test = testBody(code, i);
      if (test) {
        const record = { item: { path: file, symbol: test.name, kind: 'test', line },
          endLine: code[code[test.body].pair].line, isStatic: false };
        symbols.push(record);
        owners.set(test.body, record);
      }
    }
    if (parent !== -1 || moduleTokens.has(i) || isDot(code[i - 1]?.value)) continue;
    if (value === 'import' || value === 'export') {
      const module = statementBinding(code, i);
      if (module) {
        for (let j = i; j <= module.end; j++) moduleTokens.add(j);
        modules.push({ ...module, kind: value, line });
        continue;
      }
    }
    const name = code[i + 1]?.value ?? '';
    if (!declarations.has(value) || !identifier.test(name) || name === 'enum') continue;
    const parameters = skipTypeParameters(code, i + 2);
    const body = classKinds.has(value) ? classBody(code, i + 2) : value === 'function' ? bodyAfterParameters(code, parameters) : -1;
    const record = add(i + 1, value, null, body);
    if (value === 'type') {
      const members = literalUnion(code, parameters);
      if (members.length) {
        record.endLine = members.at(-1).line;
        record.literalMembers = members.map(({ value, line, index }) => {
          unionOwners.set(index, record);
          return { value, line };
        });
      }
    }
    const exported = exportName(code, i, name);
    if (exported) exports.set(exported, record);
    if (body >= 0 && classKinds.has(value)) indexMembers(code, body, name, add, scopes);
  }
  const bindings = localBindings(code, scopes);
  const aliases = new Set(modules.filter(module => module.kind === 'import').flatMap(module => module.names.map(([name]) => name)));
  const topLevel = new Set(symbols.filter(({ item }) => !item.owner && item.kind !== 'test').map(({ item }) => item.symbol));
  const ownerAt = new Map();
  const enclosing = brace => {
    if (brace < 0) return null;
    if (!ownerAt.has(brace)) ownerAt.set(brace, owners.get(brace) ?? (ordinaryFunctions.has(brace) ? null : enclosing(code[brace].brace)));
    return ownerAt.get(brace);
  };
  for (let i = 0; i < code.length; i++) {
    const token = code[i];
    if (moduleTokens.has(i)) continue;
    const previous = code[i - 1]?.value;
    if (token.value.startsWith("'") || token.value.startsWith('"')) {
      const value = unquote(token.value);
      if (value === null) continue;
      const union = unionOwners.get(i);
      const origin = union ?? enclosing(token.brace);
      const kind = union ? 'union-member' : previous === 'case' ? 'case' : 'value';
      literals.push({ value, path: file, line: token.line, kind,
        ...(origin ? { within: origin.item.qualified ?? origin.item.symbol } : {}), ...(testSource ? { testSource: true } : {}) });
      continue;
    }
    if (!identifier.test(token.value) || declared.has(i) || isDot(previous)) continue;
    const local = token.value === 'this' ? undefined : lookupBinding(code, bindings, token, token.value);
    const origin = enclosing(token.brace);
    if (origin && flowKeywords.has(token.value) && code[i + 1]?.value !== ':') {
      (origin.controls ??= []).push(controlSite(code, i));
      continue;
    }
    const self = token.value === 'this' && origin?.item.owner;
    const resolvable = local !== null && Boolean(local || self || topLevel.has(token.value) || aliases.has(token.value));
    if (!resolvable && !origin) continue;
    const members = [];
    let end = i + 1;
    while (isDot(code[end]?.value) && identifier.test(code[end + 1]?.value ?? '')) {
      members.push(code[end + 1].value);
      end += 2;
    }
    if ((self || local) && !members.length) continue;
    const receiverType = self && members.length > 1 ? fields.get(self + '.' + members[0]) : null;
    const next = code[skipTypeParameters(code, end)]?.value;
    const relation = assignments.has(next) || previous === '++' || previous === '--' ? 'write'
      : next === '(' || previous === 'new' ? 'call' : 'reference';
    if (!resolvable && !(relation === 'call' && (members.length || previous === 'await'))) continue;
    uses.push({ name: receiverType || local || self || token.value, members: receiverType ? members.slice(1) : members, origin,
      localOnly: Boolean(self && !receiverType), instance: Boolean(local || receiverType || self && !origin.isStatic), relation, line: token.line,
      awaited: relation === 'call' && previous === 'await', resolvable, label: [token.value, ...members].join('.') });
    i = end - 1;
  }
  return { symbols, modules, uses, exports, literals };
}
