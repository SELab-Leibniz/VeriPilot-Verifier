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
  for (const match of source.matchAll(lexeme)) {
    const [value] = match;
    if (!/^\s|^\/\/|^\/\*/u.test(value)) code.push({ value, line, offset: match.index, pair: -1, parent: -1, brace: -1 });
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

// These are lexical potential references in text the bounded lexer cannot
// interpret as code. They never assert a call, edge, routing rule or execution.
// Decode quoted tokens without evaluating source, so escaped exact selectors
// cannot disappear from the conservative origin query.
function opaqueQuotedValue(value) {
  const quote = value[0];
  if (value.length < 2 || !["'", '"', '`'].includes(quote) || value.at(-1) !== quote) return null;
  let result = '';
  const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 1; i < value.length - 1; i++) {
    let char = value[i];
    if (char !== '\\') { result += char; continue; }
    char = value[++i];
    if (char === undefined) return null;
    if (['\r', '\n', '\u2028', '\u2029'].includes(char)) { if (char === '\r' && value[i + 1] === '\n') i++; continue; }
    if (char === 'u' || char === 'x') {
      const braced = char === 'u' && value[i + 1] === '{';
      const count = braced ? value.indexOf('}', i + 2) - i - 2 : char === 'u' ? 4 : 2;
      const from = i + (braced ? 2 : 1), digits = value.slice(from, from + count);
      if (count < 1 || count > 6 || digits.length !== count || !/^[a-f\d]+$/iu.test(digits)) return null;
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) return null;
      result += String.fromCodePoint(point); i = from + count - 1 + Number(braced); continue;
    }
    if (/[0-7]/u.test(char)) {
      const digits = (char + value.slice(i + 1, i + (char < '4' ? 3 : 2))).match(/^[0-7]+/u)[0];
      result += String.fromCharCode(Number.parseInt(digits, 8)); i += digits.length - 1; continue;
    }
    result += escapes[char] ?? char;
  }
  return result;
}

function opaqueOriginVocabulary(value, depth = 0) {
  const literals = new Set(), identifiers = new Set();
  if (Buffer.byteLength(value) > 16 * 1024) return { literals: [], identifiers: [], unresolved: true };
  let unresolved = false;
  const collect = (tokens, templateExpression = false) => {
    for (const token of tokens) {
      if (literals.size + identifiers.size >= 128) { unresolved = true; break; }
      const literal = opaqueQuotedValue(token.value);
      if (literal !== null && token.value[0] !== '`') literals.add(literal);
      else if (identifier.test(token.value)) identifiers.add(token.value);
      else if (token.value.startsWith('`') && depth < 8) {
        const nested = opaqueOriginVocabulary(token.value, depth + 1);
        for (const literal of nested.literals) literals.add(literal);
        for (const name of nested.identifiers) identifiers.add(name);
        unresolved ||= nested.unresolved;
      }
      else if (token.value.startsWith('`') || templateExpression && token.value === '\\') unresolved = true;
      else if (/^['"]/u.test(token.value) || dispatchDelimiters.has(token.value) && token.pair < 0) unresolved = true;
    }
  };
  if (!value.startsWith('`')) {
    const close = value.lastIndexOf('/');
    if (close < 1) unresolved = true;
    else collect(tokenize(value.slice(1, close)));
  }
  else {
    const literal = opaqueQuotedValue(value);
    let interpolationSteps = 0, lexemes = 0;
    for (let i = 1; i < value.length - 1;) {
      if (value[i] === '\\') { i += 2; continue; }
      if (value[i] !== '$' || value[i + 1] !== '{') { i++; continue; }
      if (++interpolationSteps > 64) { unresolved = true; break; }
      const fragment = value.slice(i + 1);
      let braces = 0, end = -1;
      // Stop at this expression's lexical close. Repeated short interpolations
      // must not repeatedly tokenize the complete remaining template tail.
      for (const match of fragment.matchAll(lexeme)) {
        if (++lexemes > 1024) { unresolved = true; break; }
        if (match[0] === '{') braces++;
        if (match[0] === '}' && --braces === 0) { end = match.index + 1; break; }
      }
      if (end < 0) { unresolved = true; break; }
      const tokens = tokenize(fragment.slice(0, end));
      collect(tokens.slice(1, -1), true);
      i += 1 + end;
    }
    if (!interpolationSteps && literal !== null) literals.add(literal);
  }
  return { literals: [...literals], identifiers: [...identifiers], ...(unresolved ? { unresolved: true } : {}) };
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

function explicitCallableScope(code, i) {
  const { value } = code[i];
  if (value === '=>' && code[i + 1]?.value === '{' && code[i + 1].pair > i) {
    const parameters = code[i - 1]?.value === ')' ? code[i - 1].pair : i - 1;
    return { body: i + 1, parameters };
  }
  if (value !== 'function' || isDot(code[i - 1]?.value)) return null;
  const parameters = functionParameters(code, i), body = bodyAfterParameters(code, parameters);
  return body >= 0 ? { body, parameters } : null;
}

function testBody(code, index, hook = false) {
  const call = index + 1;
  if (code[call]?.value !== '(' || code[call].pair <= call) return null;
  const name = hook ? code[index].value : unquote(code[call + 1]?.value ?? '');
  if (!name || !hook && code[call + 2]?.value !== ',') return null;
  for (let i = call + (hook ? 1 : 3); i < code[call].pair; i++) {
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
  const body = code[after]?.value === '{' && code[after].pair > after ? after : -1;
  const end = body >= 0 ? code[body].pair : after - 1;
  return { body, site: { kind, line, ...(code[end].line > line ? { endLine: code[end].line } : {}) } };
}

const dispatchBranches = new Set(['if', 'else', 'try', 'catch', 'finally']);
const nonCallNames = new Set([...flowKeywords, 'for', 'while', 'with', 'function', 'import', 'new']);
const dispatchDelimiters = new Set([...delimiters.keys(), ...delimiters.values()]);
const maxDispatchSourceBytes = 256 * 1024;
const maxDispatchSiblings = 4;

// Support one bounded call statement after a standalone if. A brace-less
// branch still needs its own identity: flattening it into its enclosing block
// would hide an alternate dispatch. Other statement forms remain unknown.
function unbracedCallBranch(code, index) {
  const condition = index + 1;
  if (code[index].value !== 'if' || code[condition]?.value !== '(' || code[condition].pair <= condition + 1) return null;
  // Do not flatten a possible dispatch in the condition into the enclosing
  // branch. Templates can hide interpolation, and a regex-looking token may
  // actually be division. Nested parentheses/callables also need parsing.
  if (code.slice(condition + 1, code[condition].pair).some(token =>
    ['(', '=>', 'function'].includes(token.value) || /^[`/]/u.test(token.value))) return null;
  const start = code[condition].pair + 1;
  if (!identifier.test(code[start]?.value ?? '') || nonCallNames.has(code[start].value)
    || declarations.has(code[start].value) || ['await', 'yield', 'void', 'delete', 'do', 'break', 'continue'].includes(code[start].value)) return null;
  let open = start + 1;
  while (code[open]?.value === '.' && identifier.test(code[open + 1]?.value ?? '')) open += 2;
  if (code[open]?.value !== '(' || code[open].pair <= open) return null;
  const end = code[open].pair;
  // Deferred/nested callables and opaque template/regex tokens need separate
  // parsing. Plain backticks and regex literals stay unknown too.
  if (code.slice(open + 1, end).some(token =>
    ['=>', 'function'].includes(token.value) || /^[`/]/u.test(token.value))) return null;
  const next = code[end + 1], after = next?.value === ';' ? code[end + 2] : next;
  if (after?.value === 'else') return null;
  const endsAtBoundary = !next || next.value === ';' || next.value === '}'
    || next.line > code[end].line && identifier.test(next.value)
      && !['else', 'in', 'instanceof', 'as', 'satisfies'].includes(next.value);
  return endsAtBoundary ? { start, end } : null;
}

function staticDispatchArgument(code, open) {
  const first = code[open + 1];
  if (!first || first.parent !== open) return null;
  const argEnd = index => [',', ')'].includes(code[index]?.value);
  const destination = unquote(first.value);
  if (destination && argEnd(open + 2)) return { destination, property: null, literalLine: first.line };
  if (first.value !== '{' || first.pair <= open + 1 || !argEnd(first.pair + 1)) return null;
  let selected = null;
  const keys = new Set();
  for (let i = open + 2; i < first.pair;) {
    const { value } = code[i];
    const key = identifier.test(value) ? value : unquote(value);
    if (key === null || keys.has(key)) return null; // Dynamic keys and overrides are ambiguous.
    keys.add(key);
    let end = i + 1;
    while (end < first.pair && code[end].value !== ',') end = Math.max(end, code[end].pair) + 1;
    if (end === i + 3 && code[i + 1].value === ':') {
      const literal = code[i + 2];
      const destination = unquote(literal.value);
      if (destination) {
        if (selected) return null;
        selected = { destination, property: key, literalLine: literal.line };
      }
    }
    i = end + 1;
  }
  return selected;
}

const dispatchDiscoveryScope = 'SAME_LEXICAL_CALLABLE';
const dispatchDiscoveryResult = (status, reason, extra = {}) => ({
  status, complete: status === 'READY', scope: dispatchDiscoveryScope, reason, siblings: [], ...extra,
});

function inspectSiblingLiteralDispatches(source, { start, end } = {}, selectors) {
  const unknown = reason => ({ result: dispatchDiscoveryResult('UNKNOWN', reason), legacySiblings: [] });
  if (typeof source !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    return unknown('INVALID_INPUT');
  if (Buffer.byteLength(source) > maxDispatchSourceBytes) return unknown('SOURCE_LIMIT');
  const code = tokenize(source);
  const malformed = code.some(token => dispatchDelimiters.has(token.value) && token.pair < 0);
  const scopes = new Set(), branches = new Set(), expressionArrows = new Set(), sites = [], calls = [], unsupportedBranches = [];
  const opaqueExecutionSites = [];
  const recordOpaqueExecution = token => {
    let scope = token.parent;
    for (; scope >= 0 && !scopes.has(scope) && !expressionArrows.has(scope); scope = code[scope].parent) {}
    // Expression-arrow state is transient. Capture it before its enclosing
    // comma/semicolon clears navigation, rather than folding a deferred body
    // back into the outer callable at the end of the scan.
    opaqueExecutionSites.push({ scope, deferred: expressionArrows.has(scope) });
  };
  const unbracedBranches = [];
  for (const [i, token] of code.entries()) {
    while (unbracedBranches.at(-1)?.end < i) unbracedBranches.pop();
    const callable = explicitCallableScope(code, i);
    if (callable) scopes.add(callable.body);
    if (token.value === '=>' && !callable) expressionArrows.add(token.parent);
    if ([',', ';'].includes(token.value)) expressionArrows.delete(token.parent);
    // The lexer treats templates and regex-looking text as opaque tokens.
    // They can contain interpolation or actually be division with executable
    // calls. Indirect/optional call heads are not parsed into a static callee
    // either. Never certify the remaining static group by omitting them.
    // Comments and ordinary quoted strings have already been separated.
    if (/^[`/]/u.test(token.value) || token.value === '\\'
      || token.value === '(' && ['?.', ']', ')', '!', '>'].includes(code[i - 1]?.value))
      recordOpaqueExecution(token);
    if (dispatchBranches.has(token.value) && !isDot(code[i - 1]?.value) && code[i + 1]?.value !== ':') {
      const { body } = controlSite(code, i);
      if (body >= 0) branches.add(body);
      else if (token.value !== 'else' || code[i + 1]?.value !== 'if') {
        const range = unbracedCallBranch(code, i);
        if (!range) unsupportedBranches.push(token);
        else {
          let scope = token.parent;
          while (scope >= 0 && !scopes.has(scope) && !expressionArrows.has(scope)) scope = code[scope].parent;
          unbracedBranches.push({ ...range, scope });
        }
      }
    }
    if (token.value === 'switch' && !isDot(code[i - 1]?.value) && code[i + 1]?.value !== ':') unsupportedBranches.push(token);
    const name = code[i - 1]?.value;
    if (token.value !== '(' || token.pair <= i || !identifier.test(name ?? '') || nonCallNames.has(name)) continue;
    // Method bodies are scope boundaries too, including nested object methods.
    if (!isDot(code[i - 2]?.value)) {
      const body = bodyAfterParameters(code, i);
      if (body >= 0) { scopes.add(body); continue; }
    }
    const argument = staticDispatchArgument(code, i);
    let first = i - 1;
    while (isDot(code[first - 1]?.value) && identifier.test(code[first - 2]?.value ?? '')) first -= 2;
    if (code.slice(first, i).some(part => part.value === '?.')) recordOpaqueExecution(token);
    if (code[first - 1]?.value === 'new') continue;
    let scope = token.parent, branch = -1;
    for (; scope >= 0 && !scopes.has(scope) && !expressionArrows.has(scope); scope = code[scope].parent)
      if (branch < 0 && branches.has(scope)) branch = scope;
    const unbraced = unbracedBranches.findLast(range => range.start <= i && i <= range.end && range.scope === scope);
    if (unbraced) branch = unbraced.start;
    const unsupportedReason = isDot(code[first - 1]?.value) ? 'UNSUPPORTED_CALLEE'
      : scope < 0 || expressionArrows.has(scope) ? 'UNSUPPORTED_SCOPE'
        : !argument ? 'UNSUPPORTED_ARGUMENT' : argument.destination.length > 256 ? 'DESTINATION_LIMIT' : null;
    const call = { scope, branch, ...(argument ?? {}), callee: code.slice(first, i).map(part => part.value).join(''),
      start: code[first].line, end: code[token.pair].line, unsupportedReason };
    calls.push(call);
    if (!unsupportedReason) sites.push(call);
  }
  const withinAnchor = line => start <= line && line <= end;
  const selectedSites = selectors === undefined ? sites : sites.filter(site => selectors.has(site.destination));
  const anchors = selectedSites.filter(site => withinAnchor(site.start) || withinAnchor(site.literalLine));
  if (anchors.length !== 1) {
    const unsupported = calls.filter(site => site.unsupportedReason && (withinAnchor(site.start) || withinAnchor(site.literalLine))
      && (selectors === undefined || selectors.has(site.destination)
        || selectedSites.some(peer => peer.scope === site.scope && peer.callee === site.callee)));
    if (selectors !== undefined && !anchors.length && !unsupported.length)
      return { result: dispatchDiscoveryResult('NOT_APPLICABLE', 'NO_FILE_SELECTOR_DISPATCH_AT_ANCHOR'), legacySiblings: [] };
    const reason = malformed ? 'UNBALANCED_DELIMITERS'
      : anchors.length > 1 || unsupported.length > 1 ? 'AMBIGUOUS_ANCHOR' : unsupported[0]?.unsupportedReason;
    return { result: reason ? dispatchDiscoveryResult('UNKNOWN', reason)
      : dispatchDiscoveryResult('NOT_APPLICABLE', 'NO_LITERAL_DISPATCH_AT_ANCHOR'), legacySiblings: [] };
  }
  const [anchor] = anchors;
  const siblings = sites.filter(site => site.scope === anchor.scope && site.branch !== anchor.branch
    && site.callee === anchor.callee && site.property === anchor.property && site.destination === anchor.destination);
  const witness = ({ start, end, callee, destination }) => ({ start, end, callee, destination });
  const extra = { anchor: witness(anchor), observedSiblingCount: siblings.length };
  if (siblings.length > maxDispatchSiblings)
    return { result: dispatchDiscoveryResult('UNKNOWN', 'SIBLING_LIMIT', extra), legacySiblings: [] };
  if (new Set([anchor, ...siblings].map(site => site.start)).size !== siblings.length + 1)
    return { result: dispatchDiscoveryResult('UNKNOWN', 'AMBIGUOUS_LINE_ANCHORS', extra), legacySiblings: [] };
  const legacySiblings = siblings.map(witness);
  // An unresolved alternate call may target this same literal. Keep the old
  // static-only navigation available, but never certify its partial group.
  const unresolvedSibling = calls.some(site => site.unsupportedReason && site.scope === anchor.scope
    && site.callee === anchor.callee);
  const unsupportedBranch = unsupportedBranches.some(token => {
    let scope = token.parent;
    for (; scope >= 0 && !scopes.has(scope) && !expressionArrows.has(scope); scope = code[scope].parent) {}
    return scope === anchor.scope;
  });
  const opaqueExecution = opaqueExecutionSites.some(site => !site.deferred && site.scope === anchor.scope);
  const result = malformed ? dispatchDiscoveryResult('UNKNOWN', 'UNBALANCED_DELIMITERS', extra)
    : unsupportedBranch ? dispatchDiscoveryResult('UNKNOWN', 'UNSUPPORTED_BRANCH_SYNTAX', extra)
    : opaqueExecution ? dispatchDiscoveryResult('UNKNOWN', 'UNSUPPORTED_EXECUTABLE_SYNTAX', extra)
      : unresolvedSibling ? dispatchDiscoveryResult('UNKNOWN', 'UNRESOLVED_SIBLING', extra)
        : dispatchDiscoveryResult('READY', 'STATIC_LITERAL_GROUP', { ...extra, siblings: legacySiblings });
  return { result, legacySiblings };
}

/**
 * Discover a bounded static group in one lexical callable. READY says nothing
 * about upstream callers, indirect registrations, aliases or semantic scope.
 * Other statuses never supply authoritative partial sibling witnesses.
 */
export function discoverSiblingLiteralDispatches(source, range) {
  return inspectSiblingLiteralDispatches(source, range).result;
}

/** Primary-flow applicability is limited to supplied qualified file selectors.
 * A matching literal is a possible dispatch reference, never routing proof.
 * Ordinary processing calls do not become incomplete dispatch groups merely
 * because their arguments are dynamic or contain unrelated string literals. */
export function discoverFileSelectorSiblingDispatches(source, range, selectors) {
  return inspectSiblingLiteralDispatches(source, range, new Set(selectors)).result;
}

/** Legacy static-only navigation; an empty array does not establish closure. */
export function findSiblingLiteralDispatches(source, range) {
  return inspectSiblingLiteralDispatches(source, range).legacySiblings;
}

export function scanSemanticSource(source, file) {
  const code = tokenize(source);
  const symbols = [], modules = [], uses = [], literals = [], declared = new Set(), moduleTokens = new Set(), scopes = new Map(), exports = new Map();
  const owners = new Map(), fields = new Map(), ordinaryFunctions = new Set();
  const unionOwners = new Map();
  const testSource = isTestSource(file);
  const opaqueTokens = testSource ? [] : code.filter(token => /^[`/]/u.test(token.value));
  const opaqueOrigins = opaqueTokens.slice(0, 256).map(token => ({
    start: token.line, end: token.line + [...token.value.matchAll(newline)].length,
    reason: token.value[0] === '`' ? 'OPAQUE_TEMPLATE' : 'REGEX_OR_DIVISION',
    ...opaqueOriginVocabulary(token.value),
  }));
  if (opaqueTokens.length > 256) opaqueOrigins.push({ start: 1, end: code.at(-1)?.line ?? 1,
    reason: 'OPAQUE_SOURCE_LIMIT', literals: [], identifiers: [], unresolved: true });
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
    const callable = explicitCallableScope(code, i);
    if (callable) {
      scopes.set(callable.body, callable.parameters);
      if (value === 'function') ordinaryFunctions.add(callable.body);
    }
    const hook = ['beforeEach', 'beforeAll', 'afterEach', 'afterAll', 'setup', 'teardown'].includes(value);
    if (testSource && (hook || ['test', 'it'].includes(value)) && !isDot(code[i - 1]?.value)) {
      const test = testBody(code, i, hook);
      if (test) {
        const record = { item: { path: file, symbol: test.name, kind: hook ? 'test-hook' : 'test', line },
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
  const topLevel = new Set(symbols.filter(({ item }) => !item.owner && !item.kind.startsWith('test')).map(({ item }) => item.symbol));
  const ownerAt = new Map();
  const catchBlocks = new Map();
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
      const { body, site } = controlSite(code, i);
      (origin.controls ??= []).push(site);
      if (site.kind === 'catch' && body >= 0 && previous === '}') catchBlocks.set(body, site.line);
      if (site.kind === 'return') {
        let catchLine;
        for (let brace = token.brace; brace >= 0; brace = code[brace].brace) {
          if (scopes.has(brace)) {
            if (catchLine !== undefined && owners.get(brace) === origin)
              (origin.catchReturns ??= []).push({ catchLine, line: site.line, ...(site.endLine ? { endLine: site.endLine } : {}) });
            break;
          }
          catchLine ??= catchBlocks.get(brace);
        }
      }
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
    let argumentTo;
    const argumentsAt = token.parent, callee = argumentsAt - 1;
    if (testSource && relation === 'reference' && code[argumentsAt]?.value === '('
      && identifier.test(code[callee]?.value ?? '') && !flowKeywords.has(code[callee].value)
      && !['for', 'while', 'with', 'function'].includes(code[callee].value) && !declared.has(callee)) {
      let start = callee;
      while (start >= 2 && isDot(code[start - 1].value) && identifier.test(code[start - 2].value)) start -= 2;
      const argumentIndex = code.slice(argumentsAt + 1, i).filter(part => part.parent === argumentsAt && part.value === ',').length;
      argumentTo = { symbol: code.slice(start, argumentsAt).map(part => part.value).join(''), line: code[callee].line, argumentIndex };
    }
    uses.push({ name: receiverType || local || self || token.value, members: receiverType ? members.slice(1) : members, origin,
      localOnly: Boolean(self && !receiverType), instance: Boolean(local || receiverType || self && !origin.isStatic), relation, line: token.line,
      ...(argumentTo ? { argumentTo } : {}),
      awaited: relation === 'call' && previous === 'await', resolvable, label: [token.value, ...members].join('.') });
    i = end - 1;
  }
  return { symbols, modules, uses, exports, literals, opaqueOrigins };
}
