import { Script } from 'node:vm';

const declarations = new Set(['class', 'struct', 'interface', 'enum', 'namespace', 'function', 'type', 'const', 'let', 'var']);
const classKinds = new Set(['class', 'struct', 'interface']);
const variables = new Set(['const', 'let', 'var']);
const modifiers = new Set(['public', 'protected', 'private', 'readonly', 'static', 'async', 'override', 'abstract', 'get', 'set', 'declare']);
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '??=', '||=', '&&=', '++', '--']);
const flowKeywords = new Set(['if', 'else', 'switch', 'try', 'catch', 'finally', 'return', 'throw']);
const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;
const identifierParts = /^[\p{ID_Continue}$\u200c\u200d]+$/u;
const lexeme = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*(?:`|$)|\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*|[\p{ID_Start}$_][\p{ID_Continue}$]*|===|!==|==|!=|=>|\?\?=|\|\|=|&&=|\?\.|[+-]{2}|[-+*/]=|\s+|./gu;
const newline = /\r\n?|\n|\u2028|\u2029/gu;
const delimiters = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const isDot = value => value === '.' || value === '?.';
const unquote = value => /^(['"])(?:(?!\1)[^\\\r\n])*\1$/u.test(value) ? value.slice(1, -1) : null;
export const isTestSource = file => /(?:^|\/)(?:test|tests|ohosTest|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(file);

const operandStartWords = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await']);
const controlHeaders = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const divisionRightPrefixes = new Set(['+', '-', '!', '~', '++', '--', 'new', 'typeof', 'void', 'delete', 'await', 'yield']);

function parenthesisRole(code) {
  const last = code.at(-1), before = code.at(-2), earlier = code.at(-3);
  if (!isDot(before?.value) && controlHeaders.has(last?.value)) return { controlHeader: last.value };
  if (last?.value === 'await' && before?.value === 'for' && !isDot(earlier?.value)) return { controlHeader: 'for' };
  if (last?.value === 'function' || last?.value === '*' && before?.value === 'function'
    || identifier.test(last?.value ?? '') && (before?.value === 'function'
      || before?.value === '*' && earlier?.value === 'function')) return { functionParameters: true };
  return {};
}

function escapedIdentifierTail(code) {
  let offset = code.at(-1)?.offset + (code.at(-1)?.value.length ?? 0);
  for (let index = code.length - 1, work = 0; index >= 0; index--) {
    if (++work > 128) return true; // An overlong suffix cannot prove an operand.
    const token = code[index];
    if (token.offset + token.value.length !== offset) return false;
    if (identifierParts.test(token.value)) { offset = token.offset; continue; }
    if (token.value === '\\') return true;
    if (token.value !== '}' || token.pair < 0) return false;
    const open = code[token.pair], prefix = code[token.pair - 1], escape = code[token.pair - 2];
    // A braced escape may precede letters, digits or other IdentifierParts.
    // Detect its contiguous lexical shape; never decode or bind the name.
    return prefix?.value === 'u' && escape?.value === '\\'
      && escape.offset + 1 === prefix.offset && prefix.offset + 1 === open.offset;
  }
  return false;
}

// This answers only whether a slash can continue a visible expression. An
// ambiguous closing brace remains opaque; regex tokens after control headers,
// prefix operators and restricted break/continue labels are never split into
// apparent executable callers.
function canEndOperand(code) {
  const token = code.at(-1), before = code.at(-2), earlier = code.at(-3);
  if (!token) return false;
  const value = token.value;
  // Escaped names may be jump labels, including suffixes lexed as digits.
  // Their following slash cannot be proven to continue an expression.
  if (escapedIdentifierTail(code)) return false;
  if (identifier.test(value)) {
    if (isDot(before?.value)) return true;
    if (operandStartWords.has(value)) return false;
    if (['break', 'continue'].includes(before?.value) && !isDot(earlier?.value)) return false;
    if (value === 'of' && code[token.parent]?.controlHeader === 'for'
      && (identifier.test(before?.value ?? '') && !operandStartWords.has(before.value)
        || [')', ']', '}'].includes(before?.value))) return false;
    return true;
  }
  if (/^\d$/u.test(value)) return true;
  if (value.length > 1 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) return true;
  if (token.regexLiteral) return true;
  if (['++', '--'].includes(value)) return token.postfix === true;
  if (value === ']') return token.pair >= 0;
  if (value === ')') return token.pair >= 0 && !code[token.pair].controlHeader && !code[token.pair].functionParameters;
  return false;
}

function tokenize(source) {
  const code = [], stack = [], braces = [], matcher = new RegExp(lexeme.source, 'uy');
  let line = 1, cursor = 0;
  while (cursor < source.length) {
    matcher.lastIndex = cursor;
    const match = matcher.exec(source);
    if (!match) throw new Error('Source tokenization could not preserve the input.');
    let [value] = match;
    const trivia = /^\s|^\/\/|^\/\*/u.test(value);
    const division = !trivia && value.startsWith('/') && canEndOperand(code);
    // Re-read the remainder after a proven operator instead of allowing the
    // regex alternative to swallow a later division and its actual callees.
    if (division) value = source[cursor + 1] === '=' ? '/=' : '/';
    const endLine = line + [...value.matchAll(newline)].length;
    if (!trivia) {
      const token = { value, line, endLine, offset: cursor, pair: -1,
        parent: stack.at(-1) ?? -1, brace: braces.at(-1) ?? -1,
        ...(division ? { division: true } : {}),
        ...(!division && value.startsWith('/') && value.lastIndexOf('/') > 0 ? { regexLiteral: true } : {}),
        ...(value === '(' ? parenthesisRole(code) : {}),
        ...(['++', '--'].includes(value) ? { postfix: canEndOperand(code) && code.at(-1)?.endLine === line } : {}) };
      const index = code.push(token) - 1;
      if (delimiters.has(value)) {
        stack.push(index);
        if (value === '{') braces.push(index);
      } else if (delimiters.get(code[stack.at(-1)]?.value) === value) {
        const open = stack.pop(); token.pair = open; code[open].pair = index;
        if (value === '}') braces.pop();
      }
    }
    cursor += value.length; line = endLine;
  }
  return code;
}

// Only the contextual lexer can establish that the token is an operator.
// Unbalanced input retains uncertainty. Sibling-dispatch execution analysis
// keeps its independent conservative slash-syntax boundary.
function visibleDivisionOperator(code, index, balanced) {
  if (!balanced || code[index]?.division !== true) return false;
  for (let next = index + 1, work = 0; next < code.length && work++ < 32; next++) {
    const token = code[next], value = token.value;
    if (divisionRightPrefixes.has(value)) continue;
    if (identifier.test(value)) return !operandStartWords.has(value);
    if (/^\d$/u.test(value) || token.regexLiteral || value.length > 1 && ['"', "'", '`'].includes(value[0])) return true;
    return ['(', '[', '{'].includes(value) && token.pair > next;
  }
  return false;
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
    for (const [index, token] of tokens.entries()) {
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
      else if (token.value.startsWith('`') || token.value === '\\'
        && (templateExpression || tokens[index + 1]?.value.startsWith('u'))) unresolved = true;
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

const callableTypeOperators = new Set(['keyof', 'typeof', 'readonly', 'infer', 'unique', 'asserts', 'is', 'extends']);

function bodyAfterParameters(code, parameters) {
  const end = code[parameters]?.pair;
  if (code[parameters]?.value !== '(' || !(end > parameters)) return -1;
  let i = end + 1;
  if (code[i]?.value === ':') {
    i++;
    // A leading object type and balanced tuple/generic types can precede the body.
    if (code[i]?.value === '{' && code[i].pair > i) i = code[i].pair + 1;
    for (; i < Math.min(code.length, end + 256); i++) {
      const token = code[i];
      if (token.value === '{') break;
      if ([';', '}', '=', '=>', 'export', 'function', 'class', 'const', 'let', 'var'].includes(token.value)) return -1;
      const previous = code[i - 1]?.value;
      if (identifier.test(token.value) && identifier.test(previous ?? '')
        && !callableTypeOperators.has(token.value) && !callableTypeOperators.has(previous)) return -1;
      if (token.value === '(' && identifier.test(previous ?? '') && !['new', 'abstract'].includes(previous)) return -1;
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

function lexicalClassBody(code, index, spend = () => true) {
  const parent = code[index].parent;
  for (let next = index + 1; next < Math.min(code.length, index + 256) && spend(); next++) {
    if (code[next].parent !== parent) continue;
    if (code[next].value === '{') return code[next].pair >= 0 ? next : -1;
    if (['=', ';'].includes(code[next].value)) break;
  }
  return -1;
}

function functionParameters(code, index) {
  let i = index + 1;
  if (code[i]?.value === '*') i++;
  if (identifier.test(code[i]?.value ?? '')) i++;
  return skipTypeParameters(code, i);
}

const maxCallableFrames = 512;
const maxCallableDepth = 64;
const maxCallableHeaderTokens = 256;
const callableExpressionPrefixes = new Set(['=', '(', '[', ',', 'return', '=>', '?', ':']);
const primitiveTypes = new Set(['any', 'unknown', 'never', 'void', 'string', 'number', 'boolean', 'object', 'undefined', 'null', 'true', 'false']);
const parameterKeywords = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'await', 'let', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static']);

function typeReferences(code, start, end) {
  const result = [];
  for (let index = start; index < end; index++) {
    const token = code[index], next = code[index + 1]?.value;
    const typeParameter = code[token.parent]?.value === '(' && code[code[token.parent].pair + 1]?.value === '=>'
      && (index === token.parent + 1 || code[index - 1]?.value === ',');
    if (identifier.test(token.value) && !primitiveTypes.has(token.value) && ![':', '?'].includes(next)
      && code[index - 1]?.value !== 'infer' && !typeParameter) result.push(index);
  }
  return result;
}

function parameterBindings(code, parameters, source) {
  if (identifier.test(code[parameters]?.value ?? '') && !parameterKeywords.has(code[parameters].value))
    return { supported: true, names: [parameters], indices: [parameters] };
  const close = code[parameters]?.pair;
  if (code[parameters]?.value !== '(' || !(close > parameters) || close - parameters > maxCallableHeaderTokens)
    return { supported: false, names: [], indices: [] };
  const indices = Array.from({ length: close - parameters + 1 }, (_, n) => parameters + n);
  const segments = []; let from = parameters + 1, typeDepth = 0, annotation = false;
  for (let i = from; i <= close; i++) {
    if (code[i]?.parent === parameters) {
      if (code[i].value === ':') annotation = true;
      if (code[i].value === '=') { annotation = false; typeDepth = 0; }
      if (annotation && code[i].value === '<') typeDepth++;
      if (annotation && code[i].value === '>') typeDepth--;
    }
    if (i === close || code[i].parent === parameters && code[i].value === ',' && typeDepth === 0) {
      if (i > from) segments.push([from, i]);
      else if (i !== close) return { supported: false, names: [], indices };
      from = i + 1; annotation = false; typeDepth = 0;
    }
  }
  const names = [], typeIndices = [], executableIndices = [], plain = []; let supported = true;
  for (const [segment, end] of segments) {
    let start = segment;
    const rest = code[start]?.value === '.' && code[start + 1]?.value === '.' && code[start + 2]?.value === '.';
    if (rest) start += 3;
    let equal = -1;
    for (let i = start; i < end; i++) if (code[i].parent === parameters && code[i].value === '=') { equal = i; break; }
    if (equal >= 0) for (let i = equal + 1; i < end; i++) executableIndices.push(i);
    if (!identifier.test(code[start]?.value ?? '') || parameterKeywords.has(code[start].value)) {
      supported = false;
      // An unsupported binding pattern is a shadow barrier. Its initializer is
      // executable; names appearing there are never parameter declarations.
      for (let i = start; i < (equal < 0 ? end : equal); i++) if (identifier.test(code[i].value)) names.push(i);
      continue;
    }
    names.push(start);
    let next = start + 1;
    const optional = code[next]?.value === '?';
    if (optional) next++;
    const typeEnd = equal < 0 ? end : equal;
    if (next < typeEnd) {
      if (code[next]?.value !== ':' || next + 1 >= typeEnd) supported = false;
      else {
        typeIndices.push(...typeReferences(code, next + 1, typeEnd));
        let angles = 0;
        for (let i = next + 1; i < typeEnd; i++) {
          const token = code[i];
          if (token.value === '<') angles++;
          if (token.value === '>') angles--;
          if (angles < 0 || ['=', ';', '\\'].includes(token.value) || /^[`/]/u.test(token.value)
            || delimiters.has(token.value) && token.pair < 0) supported = false;
        }
        if (angles !== 0) supported = false;
      }
    }
    if (rest && (optional || equal >= 0 || end !== close || code[close - 1]?.value === ',')) supported = false;
    if (optional && equal >= 0) supported = false;
    let initializer = '';
    if (equal >= 0) {
      if (equal + 1 >= end || typeof source !== 'string') supported = false;
      else {
        initializer = source.slice(code[equal + 1].offset, code[end - 1].offset + code[end - 1].value.length);
        if (Buffer.byteLength(initializer) > 8192 || code.slice(equal + 1, end).some(token =>
          ['=>', 'function', 'class', '{', '}', '\\'].includes(token.value) || token.value.startsWith('`'))) supported = false;
      }
    }
    plain.push((rest ? '...' : '') + code[start].value + (equal >= 0 ? '=' + initializer : ''));
  }
  if (new Set(names.map(index => code[index].value)).size !== names.length) supported = false;
  if (Buffer.byteLength(plain.join(',')) > 16 * 1024) supported = false;
  if (supported) try {
    // Compile only the bounded, type-erased binding header; never evaluate a
    // default value or invoke the resulting function.
    new Script(`"use strict"; (function(${plain.join(',')}) {});`, { filename: 'runtime-corrector-parameter-header' });
  } catch { supported = false; }
  return { supported, names, indices, typeIndices, executableIndices };
}

function arrowHeader(code, index, source) {
  let parameters = -1, annotation = false;
  const previous = index - 1, immediate = code[previous]?.value === ')' ? code[previous].pair : -1;
  // A direct parameter list wins over unrelated earlier ternary/object colons.
  // A parenthesized return type starts after a parameter-close and colon, so
  // it needs the annotation path rather than being invented as parameters.
  if (immediate >= 0 && !(code[immediate - 1]?.value === ':' && code[immediate - 2]?.value === ')')
    && !['|', '&'].includes(code[immediate - 1]?.value)) parameters = immediate;
  else if (identifier.test(code[previous]?.value ?? '')
    && (previous === 0 || callableExpressionPrefixes.has(code[previous - 1]?.value) || code[previous - 1]?.value === 'async')
    && !(code[previous - 1]?.value === ':' && code[previous - 2]?.value === ')')) parameters = previous;
  // Return annotations come after the parameter close, so a typed arrow's
  // preceding identifier (often void) is never its parameter declaration.
  for (let i = index - 1; parameters < 0 && i >= Math.max(0, index - maxCallableHeaderTokens); i--) {
    if (code[i].value === ')' && code[i].pair >= 0 && code[code[i].pair].parent === code[index].parent && code[i + 1]?.value === ':') {
      const before = code[code[i].pair - 1]?.value;
      if (code[i].pair > 0 && !callableExpressionPrefixes.has(before) && before !== 'async') continue;
      const tail = code.slice(i + 2, index);
      if (tail.length && !tail.some(token => [';', '=', '\\', '{', '}'].includes(token.value)
        || token.parent === code[index].parent && [':', '?'].includes(token.value))) {
        parameters = code[i].pair; annotation = true; break;
      }
    }
    if ([';', '=', '{', '}'].includes(code[i].value) && code[i].parent === code[index].parent) break;
  }
  if (parameters < 0) parameters = code[index - 1]?.value === ')' ? code[index - 1].pair : index - 1;
  const info = parameterBindings(code, parameters, source);
  let start = parameters;
  if (code[start - 1]?.value === 'async') start--;
  let supported = info.supported;
  if (annotation) {
    const close = code[parameters].pair;
    if (code.slice(close + 2, index).some(token => ['=>', '(', ')', '{', '}', '\\'].includes(token.value))) supported = false;
  }
  if (code[start - 1]?.value === '>') supported = false;
  return { parameters, start: Math.max(0, start), info, supported };
}

function explicitCallableScope(code, i) {
  const { value } = code[i];
  if (value === '=>' && code[i + 1]?.value === '{' && code[i + 1].pair > i) {
    const { parameters } = arrowHeader(code, i);
    return { body: i + 1, parameters };
  }
  if (value !== 'function' || isDot(code[i - 1]?.value)) return null;
  const parameters = functionParameters(code, i), body = bodyAfterParameters(code, parameters);
  return body >= 0 ? { body, parameters } : null;
}

function declarationFunction(code, index) {
  let previous = index - 1;
  if (code[previous]?.value === 'async') previous--;
  if (code[previous]?.value === 'default' && code[previous - 1]?.value === 'export') return true;
  return previous < 0 || ['export', ';', '{', '}'].includes(code[previous]?.value)
    || code[previous].line < code[index].line && !callableExpressionPrefixes.has(code[previous].value);
}

function declarationClass(code, index) {
  let start = index;
  while (['abstract', 'declare'].includes(code[start - 1]?.value)) start--;
  return declarationFunction(code, start);
}

function typeDeclarationAt(code, index, moduleTokens) {
  const kind = code[index].value;
  if (!['type', 'interface'].includes(kind) || !identifier.test(code[index + 1]?.value ?? '')
    || moduleTokens?.has(index) || isDot(code[index - 1]?.value)) return null;
  let before = index - 1;
  if (code[before]?.value === 'declare') before--;
  if (kind === 'interface' && code[before]?.value === 'default' && code[before - 1]?.value === 'export') before--;
  const previous = code[before];
  if (previous && !['export', ';', '{', '}'].includes(previous.value)
    && !(previous.endLine < code[index].line && !callableExpressionPrefixes.has(previous.value) && !isDot(previous.value))) return null;
  let next = index + 2;
  if (code[next]?.value === '<') {
    let depth = 0, close = -1;
    for (let cursor = next; cursor < Math.min(code.length, index + maxCallableHeaderTokens); cursor++) {
      const token = code[cursor];
      if (token.parent !== code[index].parent) continue;
      if (token.value === '<') depth++;
      else if (token.value === '>' && --depth === 0) { close = cursor; break; }
      else if (token.pair > cursor) cursor = token.pair;
      else if ([';', '}'].includes(token.value)) break;
    }
    if (close < 0) return null;
    next = close + 1;
  }
  if (code[next]?.parent !== code[index].parent) return null;
  if (kind === 'type' ? code[next].value !== '=' : !['{', 'extends'].includes(code[next].value)) return null;
  return { kind, name: index + 1, afterName: next };
}

function compiledExpressionInterval(code, source, header, start, end) {
  if (!header.info.supported || end < start || !code[start] || !code[end]) return false;
  const body = source.slice(code[start].offset, code[end].offset + code[end].value.length);
  if (Buffer.byteLength(body) > 16 * 1024) return false;
  const asynchronous = header.start !== header.parameters && code[header.start]?.value === 'async';
  // Parse only. No source, function, name, getter or constructor is executed.
  try {
    new Script(`"use strict"; (${asynchronous ? 'async ' : ''}(${header.info.names.map(index => code[index].value).join(',')}) => (${body}\n));`,
      { filename: 'runtime-corrector-visible-expression' });
  } catch { return false; }
  return true;
}

function callableInventory(code, file, source, owners, recordTokens, scopes, moduleTokens) {
  const candidates = [], ignored = new Set(), typeRanges = [], typeDeclarationNames = new Set();
  const fieldDeclarations = new Set([...recordTokens].filter(([record]) => record.item.kind === 'field').map(([, index]) => index));
  const annotationBoundaries = new Set();
  for (const [, index] of recordTokens) {
    annotationBoundaries.add(index);
    if (declarations.has(code[index - 1]?.value)) annotationBoundaries.add(index - 1);
  }
  let complete = true, work = 0, incompleteReason = null;
  const spend = () => { if (++work > 131072) complete = false; return complete; };
  const typeOperandPrefixes = new Set([...callableTypeOperators, 'new', 'abstract', 'as', 'in']);
  const runtimePrefixes = new Set([...flowKeywords, 'new', 'delete', 'typeof', 'void', 'await', 'yield', 'debugger', 'do', 'for', 'while']);
  const typeOperandEnd = token => token && (identifier.test(token.value) && !typeOperandPrefixes.has(token.value)
    || /^\d$/u.test(token.value) || /^['"]/u.test(token.value) || [')', ']', '}', '>'].includes(token.value));
  const valueCallAt = index => {
    let next = index + 1;
    while (isDot(code[next]?.value) && identifier.test(code[next + 1]?.value ?? '')) next += 2;
    return ['(', '=>'].includes(code[next]?.value);
  };
  for (let i = 0; i < code.length && spend(); i++) {
    const typeDeclaration = typeDeclarationAt(code, i, moduleTokens);
    if (typeDeclaration) {
      typeDeclarationNames.add(typeDeclaration.name);
      let end = i + 2, rhs = false, angles = 0;
      if (code[i].value === 'interface') {
        const body = lexicalClassBody(code, i, spend);
        if (body >= 0) { typeRanges.push([i, code[body].pair]); continue; }
        incompleteReason = 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY';
      }
      for (; end < code.length && spend(); end++) {
        if (code[end].parent !== code[i].parent) continue;
        const token = code[end], previous = code[end - 1];
        if (token.value === ';' || token.value === '}' || token.line > previous.endLine
          && ['export', ...declarations].includes(token.value)) break;
        if (token.value === '=' && angles === 0) { rhs = true; continue; }
        if (token.value === '<') angles++;
        if (token.value === '>') angles--;
        if (angles < 0 || angles > maxCallableDepth) incompleteReason = 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY';
        if (!rhs || angles !== 0 || token.line <= previous.endLine) continue;
        if (typeOperandEnd(previous) && token.pair > end && ['(', '['].includes(token.value)) {
          const after = code[token.pair + 1]?.value;
          let bracketCallable = false;
          if (token.value === '[') for (let nested = end + 1; nested < token.pair && spend(); nested++) {
            if (['=>', 'function'].includes(code[nested].value)) { bracketCallable = true; break; }
          }
          if (token.value === '(' || isDot(after) || after === '(' || bracketCallable || !complete) {
            // A following value group is not part of the preceding complete
            // type operand. Array/indexed-access ambiguity remains explicit.
            if (token.value === '[') incompleteReason = 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY';
            break;
          }
        }
        if (!typeOperandEnd(previous) && (typeOperandPrefixes.has(token.value) || primitiveTypes.has(token.value))) continue;
        const ordinaryWord = identifier.test(token.value) && !typeOperandPrefixes.has(token.value);
        const valueCall = identifier.test(token.value) && token.value !== 'import' && valueCallAt(end);
        if (runtimePrefixes.has(token.value) || valueCall || ordinaryWord && typeOperandEnd(previous)) {
          // This is a bounded ASI extent, not a TypeScript type parser. An
          // ambiguous word boundary stops suppression and invalidates positive
          // closure, while still enumerating the real callbacks that follow.
          if (!typeOperandEnd(previous) || !runtimePrefixes.has(token.value) && !valueCall)
            incompleteReason = 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY';
          break;
        }
      }
      typeRanges.push([i, end - 1]);
    }
    // Arrow signatures in a variable/field annotation are types, not runtime
    // callbacks. The annotation ends at its initializer or statement boundary.
    const variable = variables.has(code[i].value) && identifier.test(code[i + 1]?.value ?? '');
    const field = fieldDeclarations.has(i), name = variable ? i + 1 : i;
    let colon = name + 1;
    if (code[colon]?.value === '!' || field && code[colon]?.value === '?') colon++;
    if ((variable || field) && code[colon]?.value === ':') {
      const from = colon + 1;
      let end = from;
      for (; end < code.length && spend(); end++) {
        if (code[end].parent !== code[i].parent) continue;
        const memberMetadata = field && (code[end].value === '@' || code[end].value === 'static'
          && code[end + 1]?.value === '{' && code[end + 1].parent === code[i].parent);
        if (['=', ';', '}'].includes(code[end].value)
          || end > from && (annotationBoundaries.has(end) || memberMetadata)) break;
      }
      typeRanges.push([from, end - 1]);
    }
  }
  const typeOnly = index => {
    for (const [start, end] of typeRanges) {
      if (!spend()) return true;
      if (start <= index && index <= end) return true;
    }
    return false;
  };
  const endOfExpression = (index, header) => {
    const first = index + 1, parent = code[index].parent;
    const continuationWords = new Set(['in', 'instanceof', ...(/\.(?:ts|tsx|mts|cts|ets)$/iu.test(file) ? ['as', 'satisfies'] : [])]);
    let end = first, prefixChecks = 0;
    for (; end < code.length && end - first < 512 && spend(); end++) {
      const token = code[end];
      if (token.parent === parent && [',', ';'].includes(token.value) || token.pair >= 0 && token.pair < first
        || end > first && token.line > code[end - 1]?.line && token.parent === parent && ['export', ...declarations].includes(token.value)) break;
      const previous = code[end - 1];
      // Words/literals can start a separate statement after a complete operand,
      // but follow await/new/typeof or an infix operator as its required input.
      // Parse the bounded prefix instead of treating operator spellings (or
      // dotted member names with those spellings) as a blanket keyword class.
      if (end > first && token.line > previous?.line && token.parent === parent
        && !continuationWords.has(token.value)
        && (identifier.test(token.value) || /^\d|^["']/u.test(token.value) || ['++', '--', '\\'].includes(token.value))) {
        if (++prefixChecks > 32) { complete = false; break; }
        if (compiledExpressionInterval(code, source, header, first, end - 1)) break;
      }
    }
    if (end - first >= 512) complete = false;
    end = Math.max(index, end - 1);
    return { end, certain: compiledExpressionInterval(code, source, header, first, end) };
  };
  for (let i = 0; i < code.length && spend(); i++) {
    const token = code[i];
    if (token.value === '=>' && !typeOnly(i)) {
      const header = arrowHeader(code, i, source), body = i + 1;
      const block = code[body]?.value === '{';
      const interval = block ? null : endOfExpression(i, header);
      const end = block ? code[body].pair >= 0 ? code[body].pair : code.length - 1 : interval.end;
      candidates.push({ token: i, start: header.start, body, end, kind: 'arrow', block,
        expressionScopeCertain: block || interval.certain, ...header });
    } else if (token.value === 'function' && !isDot(code[i - 1]?.value) && !typeOnly(i)) {
      const parameters = functionParameters(code, i), body = bodyAfterParameters(code, parameters);
      if (body >= 0) candidates.push({ token: i, start: code[i - 1]?.value === 'async' ? i - 1 : i, parameters, body, end: code[body].pair,
        kind: 'function', block: true, info: parameterBindings(code, parameters, source), supported: true });
      else {
        let end = i + 1;
        for (; end < code.length && end - i < maxCallableHeaderTokens && spend(); end++) if (['{', ';'].includes(code[end].value)) break;
        candidates.push({ token: i, start: i, parameters, body: end, end: code[end]?.value === '{' ? code.length - 1 : Math.min(end, code.length - 1),
          kind: 'function', block: code[end]?.value === '{', bodylessSignature: code[end]?.value === ';',
          info: parameterBindings(code, parameters, source), supported: false });
      }
    }
    if (candidates.length > maxCallableFrames) { complete = false; break; }
  }
  const localClassBodies = new Set();
  for (let i = 0; i < code.length && spend(); i++) if (classKinds.has(code[i].value)) {
    const body = lexicalClassBody(code, i, spend);
    if (body >= 0) localClassBodies.add(body);
  }
  const knownBodies = new Set(candidates.map(candidate => candidate.body));
  for (let i = 0; i < code.length && spend(); i++) {
    const parent = code[i].parent;
    const objectBody = code[parent]?.value === '{'
      && ['=', '(', '[', ',', 'return', ':'].includes(code[parent - 1]?.value);
    if (!(objectBody || localClassBodies.has(parent))) continue;
    if (code[i].value === '(' && code[i - 1]?.value === ']' && code[i - 1].pair >= 0) {
      const body = bodyAfterParameters(code, i);
      if (body >= 0 && !knownBodies.has(body) && !owners.has(body)) {
        knownBodies.add(body);
        candidates.push({ token: code[i - 1].pair, start: code[i - 1].pair, parameters: i, body,
          end: code[body].pair, kind: 'method', block: true, info: parameterBindings(code, i, source), supported: false });
        if (candidates.length > maxCallableFrames) { complete = false; break; }
      }
      continue;
    }
    let previous = i - 1;
    while (modifiers.has(code[previous]?.value) || code[previous]?.value === '*') previous--;
    const boundary = previous === parent || [',', ';', '}'].includes(code[previous]?.value)
      || code[previous]?.line < code[previous + 1]?.line;
    if (!identifier.test(code[i].value) || modifiers.has(code[i].value) && code[i + 1]?.value !== '(' || !boundary) continue;
    const parameters = skipTypeParameters(code, i + 1), body = bodyAfterParameters(code, parameters);
    if (body < 0 || owners.has(body) || knownBodies.has(body)) continue;
    knownBodies.add(body);
    candidates.push({ token: i, start: i, parameters, body, end: code[body].pair, kind: 'method', block: true,
      info: parameterBindings(code, parameters, source), supported: true });
    if (candidates.length > maxCallableFrames) { complete = false; break; }
  }
  // Existing class/struct records participate in header filtering too: a
  // callback type in their parameters is not an executable anonymous arrow.
  for (const [body, record] of owners) {
    if (!['method', 'constructor'].includes(record.item.kind)) continue;
    const start = recordTokens.get(record), parameters = scopes.get(body);
    candidates.push({ token: start, start, parameters, body, end: code[body].pair, kind: 'method', block: true,
      info: parameterBindings(code, parameters, source), supported: true });
    if (candidates.length > maxCallableFrames) { complete = false; break; }
  }
  // A => within a parsed parameter/return annotation belongs to that header.
  // Executable default values keep their own lexical callback barriers.
  for (const candidate of candidates) {
    const executable = new Set(candidate.info.executableIndices ?? []);
    for (let i = candidate.start; i < candidate.body && spend(); i++)
      if (i !== candidate.token && !executable.has(i)) ignored.add(i);
  }
  const selected = candidates.filter(candidate => !ignored.has(candidate.token));
  if (selected.length > maxCallableFrames) complete = false;
  const frames = [];
  for (const candidate of selected.slice(0, maxCallableFrames)) {
    const endToken = code[candidate.end] ?? code.at(-1), startToken = code[candidate.start] ?? code[candidate.token];
    const endOffset = endToken ? endToken.offset + endToken.value.length : source.length;
    const bodyToken = code[candidate.body];
    const frame = { id: 'callable:' + JSON.stringify([file, code[candidate.token].offset, endOffset]), path: file,
      kind: candidate.kind, start: startToken.line, end: endToken?.line ?? startToken.line,
      startOffset: startToken.offset, endOffset, body: bodyToken && !candidate.bodylessSignature && candidate.end >= candidate.body ? { kind: candidate.block ? 'block' : 'expression', start: bodyToken.line, end: endToken?.line ?? bodyToken.line,
        startOffset: bodyToken.offset, endOffset } : null, supported: candidate.supported && candidate.info.supported
          && candidate.block && code[candidate.body]?.pair >= 0,
      reason: !candidate.block ? candidate.kind === 'arrow' ? 'UNSUPPORTED_EXPRESSION_ARROW' : 'UNSUPPORTED_CALLABLE_BODY' : !candidate.info.supported || !candidate.supported
        ? 'UNSUPPORTED_CALLABLE_HEADER' : code[candidate.body]?.pair < 0 ? 'UNBALANCED_CALLABLE_BODY' : 'LEXICAL_CALLABLE',
      bindingKind: 'UNSUPPORTED' };
    frames.push({ frame, candidate });
  }
  const nesting = [];
  for (const value of [...frames].sort((a, b) => a.frame.startOffset - b.frame.startOffset || b.frame.endOffset - a.frame.endOffset)) {
    while (nesting.length && nesting.at(-1) <= value.frame.startOffset) nesting.pop();
    if (nesting.length >= maxCallableDepth) complete = false;
    nesting.push(value.frame.endOffset);
  }
  return { frames, complete: complete && !incompleteReason, incompleteReason, typeRanges, typeDeclarationNames };
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

function localBindings(code, scopes, moduleTokens) {
  const bindings = new Map();
  const bind = (brace, i) => {
    if (!bindings.has(brace)) bindings.set(brace, new Map());
    const local = bindings.get(brace), name = code[i].value, type = typeBinding(code, i);
    local.set(name, local.has(name) ? null : type);
  };
  for (const [body, parameters] of scopes) {
    if (parameters && typeof parameters === 'object') {
      for (const index of parameters.names ?? []) bind(body, index);
      for (const index of parameters.extraNames ?? []) {
        if (!bindings.has(body)) bindings.set(body, new Map());
        bindings.get(body).set(code[index].value, null);
      }
      continue;
    }
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
    if (!declarations.has(token.value) || isDot(code[i - 1]?.value)) continue;
    const name = i + (token.value === 'function' && code[i + 1]?.value === '*' ? 2 : 1);
    if (!identifier.test(code[name]?.value ?? '')) continue;
    // Type-only declarations do not hide values from the enclosing runtime
    // environment. This does not merge module type/value symbol namespaces.
    if (typeDeclarationAt(code, i, moduleTokens)) continue;
    if (['class', 'struct'].includes(token.value) && !declarationClass(code, i)) {
      const body = lexicalClassBody(code, i);
      if (body >= 0) bind(body, name);
      continue;
    }
    if (token.brace < 0 || token.value === 'function' && !declarationFunction(code, i)) continue;
    let brace = token.brace;
    if (token.value === 'var') {
      while (brace >= 0 && !scopes.has(brace)) brace = code[brace].brace;
    }
    bind(brace, name);
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
  const owners = new Map(), fields = new Map(), ordinaryFunctions = new Set(), recordTokens = new Map();
  const unionOwners = new Map();
  const testSource = isTestSource(file);
  const balanced = !code.some(token => (delimiters.has(token.value) || [')', ']', '}'].includes(token.value)) && token.pair < 0);
  // Bare escapes outside quoted/comment/opaque lexemes are unsupported code,
  // including escaped identifier calls that ordinary symbol indexing cannot
  // resolve. Removing an unrelated division marker must not hide those calls.
  const opaqueTokens = testSource ? [] : code.filter((token, index) => token.value === '\\'
    || /^[`/]/u.test(token.value) && !visibleDivisionOperator(code, index, balanced));
  const opaqueOrigins = opaqueTokens.slice(0, 256).map(token => ({
    start: token.line, end: token.line + [...token.value.matchAll(newline)].length,
    reason: token.value === '\\' ? 'UNSUPPORTED_CODE_ESCAPE' : token.value[0] === '`' ? 'OPAQUE_TEMPLATE' : 'REGEX_OR_DIVISION',
    ...(token.value === '\\' ? { literals: [], identifiers: [], unresolved: true } : opaqueOriginVocabulary(token.value)),
  }));
  if (opaqueTokens.length > 256) opaqueOrigins.push({ start: 1, end: code.at(-1)?.line ?? 1,
    reason: 'OPAQUE_SOURCE_LIMIT', literals: [], identifiers: [], unresolved: true });
  const add = (i, kind, owner, body, isStatic = false) => {
    const { value: symbol, line } = code[i];
    const item = { path: file, symbol, kind, line, ...(owner ? { owner, qualified: owner + '.' + symbol } : {}) };
    const endLine = body >= 0 ? code[code[body].pair].line : line;
    const record = { item, endLine, isStatic };
    symbols.push(record);
    recordTokens.set(record, i);
    declared.add(i);
    if (body >= 0) owners.set(body, record);
    if (owner && kind === 'field') fields.set(item.qualified, typeBinding(code, i));
    return record;
  };
  for (const [i, token] of code.entries()) {
    const { value, line, parent } = token;
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
    if (['type', 'interface'].includes(value) && !typeDeclarationAt(code, i, moduleTokens)) continue;
    if (value === 'function' && !declarationFunction(code, i)) continue;
    if (['class', 'struct'].includes(value) && !declarationClass(code, i)) {
      declared.add(i + 1); // A class-expression inner name is not a module binding.
      continue;
    }
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
  const inventory = callableInventory(code, file, source, owners, recordTokens, scopes, moduleTokens);
  for (const index of inventory.typeDeclarationNames) declared.add(index);
  if (!balanced) inventory.complete = false;
  const headerTokens = new Set(), headerTypeTokens = new Set(), expressionOwners = new Map(), expressionShadows = new Map(), ownerOffsets = new Map();
  const bodyFrames = new Map(inventory.frames.filter(({ candidate }) => candidate.block).map(value => [value.candidate.body, value]));
  const lexicalThis = body => {
    for (let brace = code[body]?.brace ?? -1, depth = 0; brace >= 0 && depth++ < maxCallableDepth; brace = code[brace].brace) {
      const owner = owners.get(brace);
      if (owner?.lexicalThisOwner || owner?.item.owner) return { owner: owner.lexicalThisOwner ?? owner.item.owner, isStatic: owner.isStatic };
      if (bodyFrames.has(brace)) return null;
    }
    return null;
  };
  const existingRecord = index => symbols.find(record => recordTokens.get(record) === index);
  const visibleExpression = candidate => {
    if (!balanced || !candidate.supported || !candidate.info.supported || candidate.end < candidate.body
      || inventory.frames.some(other => other.candidate !== candidate && other.candidate.token >= candidate.body && other.candidate.token <= candidate.end)) return false;
    for (let index = candidate.body; index <= candidate.end; index++) {
      const token = code[index];
      if (['{', '}', ';', '=>', 'function', '\\'].includes(token.value) || token.value.startsWith('`')
        || token.value.startsWith('/') && !visibleDivisionOperator(code, index, balanced)) return false;
    }
    return candidate.expressionScopeCertain === true;
  };
  for (const value of inventory.frames.sort((a, b) => a.candidate.token - b.candidate.token)) {
    const { frame, candidate } = value;
    const executableHeader = new Set(candidate.info.executableIndices ?? []);
    for (let index = candidate.start; index < candidate.body; index++) if (!executableHeader.has(index)) headerTokens.add(index);
    if (candidate.info.supported) {
      for (const index of candidate.info.typeIndices ?? []) headerTypeTokens.add(index);
      const close = code[candidate.parameters]?.value === '(' ? code[candidate.parameters].pair : candidate.parameters;
      if (code[close + 1]?.value === ':') for (const index of typeReferences(code, close + 2,
        candidate.kind === 'arrow' ? candidate.token : candidate.body)) headerTypeTokens.add(index);
    }
    let record = candidate.block ? owners.get(candidate.body) : null;
    const thisContext = candidate.kind === 'arrow' ? lexicalThis(candidate.body) : null;
    const functionName = candidate.token + (code[candidate.token + 1]?.value === '*' ? 2 : 1);
    const extraNames = candidate.kind === 'function' && !record && identifier.test(code[functionName]?.value ?? '')
      ? [functionName] : [];
    if (candidate.block) {
      ordinaryFunctions.add(candidate.body); // Every callable is an ownership barrier.
      scopes.set(candidate.body, { ...candidate.info, extraNames });
    }
    if (!balanced) { frame.supported = false; frame.reason = 'UNBALANCED_DELIMITERS'; }
    if (record && ['function', 'method', 'constructor', 'test', 'test-hook'].includes(record.item.kind)) {
      frame.bindingKind = 'DECLARATION';
    } else if (candidate.kind === 'arrow') {
      const equal = candidate.start - 1, left = equal - 1;
      let bindingStart = left;
      if (code[equal]?.value === '=' && identifier.test(code[left]?.value ?? '')) {
        while (bindingStart >= 2 && code[bindingStart - 1].value === '.' && identifier.test(code[bindingStart - 2].value)) bindingStart -= 2;
        const variableDeclaration = bindingStart === left && variables.has(code[left - 1]?.value);
        const declaredVariable = variableDeclaration
          && code[left].parent === -1 && existingRecord(left);
        if (declaredVariable) {
          const matches = symbols.filter(item => item.item.symbol === code[left].value && !item.item.owner);
          const written = code.some((token, index) => index !== left && token.value === code[left].value
            && !isDot(code[index - 1]?.value) && assignments.has(code[index + 1]?.value));
          frame.bindingKind = 'VARIABLE';
          frame.start = code[left - 1].line; frame.startOffset = code[left - 1].offset;
          if (code[left - 1].value !== 'const' || matches.length !== 1 || written) {
            frame.supported = false; frame.reason = 'UNSUPPORTED_MUTABLE_OR_AMBIGUOUS_ARROW_BINDING';
          } else {
            record = declaredVariable;
            if (!candidate.block && visibleExpression(candidate)) {
              frame.supported = true; frame.reason = 'LEXICAL_CALLABLE';
            }
          }
        } else if (variableDeclaration) {
          frame.start = code[left - 1].line; frame.startOffset = code[left - 1].offset;
          frame.supported = false; frame.reason = 'UNSUPPORTED_LOCAL_ARROW_BINDING';
          frame.displayLabel = code[left].value; frame.opaqueReferenceNames = [code[left].value];
        } else if (bindingStart < left && !isDot(code[bindingStart - 1]?.value)) {
          frame.bindingKind = 'ANONYMOUS';
          frame.start = code[bindingStart].line; frame.startOffset = code[bindingStart].offset;
          frame.displayLabel = code.slice(bindingStart, left + 1).map(token => token.value).join('');
          frame.opaqueReferenceNames = [code[left].value];
        } else {
          frame.supported = false; frame.reason = 'UNSUPPORTED_ASSIGNED_ARROW_BINDING';
        }
      } else if (['(', '[', ',', 'return', '=>', '?', ':'].includes(code[candidate.start - 1]?.value)) {
        frame.bindingKind = 'ANONYMOUS';
        if (code[candidate.start - 1]?.value === ':' && identifier.test(code[candidate.start - 2]?.value ?? '')) {
          frame.displayLabel = code[candidate.start - 2].value;
          frame.opaqueReferenceNames = [frame.displayLabel];
          frame.start = code[candidate.start - 2].line; frame.startOffset = code[candidate.start - 2].offset;
        }
      }
      else { frame.supported = false; frame.reason = 'UNSUPPORTED_ARROW_CONTEXT'; }
    } else {
      frame.supported = false; frame.reason = candidate.kind === 'method' ? 'UNSUPPORTED_METHOD_BINDING'
        : 'UNSUPPORTED_FUNCTION_EXPRESSION_OR_LOCAL_BINDING';
    }
    if (!balanced) frame.reason = 'UNBALANCED_DELIMITERS';
    else if (!candidate.block && !frame.supported) frame.reason = candidate.kind === 'arrow' ? 'UNSUPPORTED_EXPRESSION_ARROW' : 'UNSUPPORTED_CALLABLE_BODY';
    else if (!candidate.info.supported || !candidate.supported) frame.reason = 'UNSUPPORTED_CALLABLE_HEADER';
    if (frame.supported && !record && !testSource) {
      record = { item: { path: file, symbol: '@callback:' + code[candidate.token].offset, kind: 'callback', line: frame.start },
        endLine: frame.end, isStatic: thisContext?.isStatic ?? false };
      if (thisContext) record.lexicalThisOwner = thisContext.owner;
      if (frame.opaqueReferenceNames) record.opaqueReferenceNames = frame.opaqueReferenceNames;
      symbols.push(record);
    }
    if (frame.supported && record) {
      record.endLine = frame.end;
      frame.record = record;
    }
    const lexicalOwner = record && frame.supported ? record : { item: { path: file,
      symbol: '@unsupported:' + code[candidate.token].offset, kind: 'callback', line: frame.start },
      endLine: frame.end, isStatic: thisContext?.isStatic ?? false,
      ...(thisContext ? { lexicalThisOwner: thisContext.owner } : {}) };
    ownerOffsets.set(lexicalOwner, frame.startOffset);
    // Parameter initializers run in the callable's parameter environment, not
    // its enclosing registration body or its later body-local declarations.
    // All parameter names (including later/TDZ names) shadow outer imports.
    for (const index of executableHeader) {
      expressionOwners.set(index, lexicalOwner);
      if (!expressionShadows.has(index)) expressionShadows.set(index, new Map());
      for (const name of [...candidate.info.names, ...extraNames]) expressionShadows.get(index).set(code[name].value, frame.startOffset);
    }
    if (!testSource || !owners.has(candidate.body)) {
      if (candidate.block) owners.set(candidate.body, lexicalOwner);
      else for (let index = candidate.body; index <= candidate.end; index++) {
        expressionOwners.set(index, lexicalOwner);
        if (!expressionShadows.has(index)) expressionShadows.set(index, new Map());
        for (const name of candidate.info.names) expressionShadows.get(index).set(code[name].value, frame.body?.startOffset ?? frame.startOffset);
      }
    }
    if (!testSource && (!candidate.info.supported || !candidate.supported && !candidate.bodylessSignature)) opaqueOrigins.push({
      start: code[candidate.start]?.line ?? frame.start, end: code[candidate.token].line,
      reason: 'UNSUPPORTED_CALLABLE_HEADER', literals: [], identifiers: [], unresolved: true });
    if (!testSource && candidate.kind === 'arrow' && !candidate.block && !candidate.expressionScopeCertain) opaqueOrigins.push({
      start: frame.start, end: frame.end, reason: 'UNSUPPORTED_EXPRESSION_SCOPE', literals: [], identifiers: [], unresolved: true });
  }
  if (!inventory.complete && !testSource) opaqueOrigins.push({ start: 1, end: code.at(-1)?.line ?? 1,
    reason: !balanced ? 'UNBALANCED_CALLABLE_SOURCE' : inventory.incompleteReason ?? 'CALLABLE_FRAME_LIMIT',
    literals: [], identifiers: [], unresolved: true });
  const bindings = localBindings(code, scopes, moduleTokens);
  const aliases = new Set(modules.filter(module => module.kind === 'import').flatMap(module => module.names.map(([name]) => name)));
  const topLevel = new Set(symbols.filter(({ item }) => !item.owner && !item.kind.startsWith('test')).map(({ item }) => item.symbol));
  const ownerAt = new Map();
  const catchBlocks = new Map();
  const enclosing = brace => {
    if (brace < 0) return null;
    if (!ownerAt.has(brace)) ownerAt.set(brace, owners.get(brace) ?? (ordinaryFunctions.has(brace) ? null : enclosing(code[brace].brace)));
    return ownerAt.get(brace);
  };
  const originAt = index => {
    const expression = expressionOwners.get(index), block = enclosing(code[index].brace);
    return expression && (!block || ownerOffsets.get(expression) > (ownerOffsets.get(block) ?? -1)) ? expression : block;
  };
  const localAt = (index, name) => {
    const expression = expressionShadows.get(index)?.get(name);
    if (expression === undefined) return lookupBinding(code, bindings, code[index], name);
    for (let brace = code[index].brace; brace >= 0; brace = code[brace].brace) {
      if (bindings.get(brace)?.has(name)) return code[brace].offset > expression ? bindings.get(brace).get(name) : null;
    }
    return null;
  };
  for (let i = 0; i < code.length; i++) {
    const token = code[i];
    if (moduleTokens.has(i) || headerTokens.has(i) && !headerTypeTokens.has(i)) continue;
    const previous = code[i - 1]?.value;
    if (token.value.startsWith("'") || token.value.startsWith('"')) {
      const value = unquote(token.value);
      if (value === null) continue;
      const union = unionOwners.get(i);
      const origin = union ?? originAt(i);
      const kind = union ? 'union-member' : previous === 'case' ? 'case' : 'value';
      literals.push({ value, path: file, line: token.line, kind,
        ...(origin ? { within: origin.item.qualified ?? origin.item.symbol } : {}), ...(testSource ? { testSource: true } : {}) });
      continue;
    }
    if (!identifier.test(token.value) || declared.has(i) || isDot(previous)) continue;
    const local = headerTypeTokens.has(i) || token.value === 'this' ? undefined : localAt(i, token.value);
    const origin = headerTypeTokens.has(i) ? null : originAt(i);
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
    const self = token.value === 'this' && (origin?.lexicalThisOwner ?? origin?.item.owner);
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
    const relation = headerTypeTokens.has(i) ? 'reference' : assignments.has(next) || previous === '++' || previous === '--' ? 'write'
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
  return { symbols, modules, uses, exports, literals, opaqueOrigins,
    callableFrames: inventory.frames.map(({ frame }) => frame), callableFramesComplete: inventory.complete };
}
