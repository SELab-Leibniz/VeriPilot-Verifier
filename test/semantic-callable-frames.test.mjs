import assert from 'node:assert/strict';
import test from 'node:test';
import { scanSemanticSource } from '../lib/semantic-graph-syntax.mjs';

const scan = (source, file = 'module.ts') => scanSemanticSource(source, file);
const calls = (value, name) => value.uses.filter(use => use.name === name && use.relation === 'call');
const imports = 'import { format } from "./format.mjs";\n';

test('member callbacks have source-offset identity and a separate navigation label', async t => {
  for (const header of ['(message)', '(message: any): void', 'async (message: any): Promise<void>', 'message'])
    await t.test(header, () => {
      const source = `const port = globalThis.inbox;\nport.receive =\n  ${header} => {\n  const selected = message.data;\n  format(selected);\n};\n`;
      const value = scan(imports + source), [frame] = value.callableFrames;
      assert.equal(value.callableFramesComplete, true);
      assert.equal(frame.supported, true, frame.reason);
      assert.equal(frame.bindingKind, 'ANONYMOUS');
      assert.equal(frame.start, 3, 'the member assignment starts before its multiline parameter header');
      assert.equal(frame.displayLabel, 'port.receive');
      assert.deepEqual(frame.opaqueReferenceNames, ['receive']);
      assert(frame.record.item.symbol.startsWith('@callback:'));
      assert.equal(frame.record.item.qualified, undefined);
      assert.equal(value.exports.size, 0);
      assert(value.symbols.includes(frame.record));
      assert.equal(calls(value, 'format')[0].origin, frame.record);
      assert.doesNotThrow(() => JSON.stringify(value.callableFrames), 'the shared record never points back to its frame');
    });
});

test('frame offsets count UTF16 units and distinguish same-line callbacks and files', () => {
  const source = 'const note = "🧩"; port.first = () => {}; port.second = () => {};';
  const a = scan(source, 'one.mjs'), b = scan(source, 'two.mjs');
  assert.equal(a.callableFrames.length, 2);
  assert.equal(new Set(a.callableFrames.map(frame => frame.id)).size, 2);
  for (const [index, frame] of a.callableFrames.entries()) {
    const [file, arrowOffset, endOffset] = JSON.parse(frame.id.slice('callable:'.length));
    assert.equal(file, 'one.mjs');
    assert.equal(source.slice(arrowOffset, arrowOffset + 2), '=>');
    assert.equal(endOffset, frame.endOffset);
    assert.equal(source.slice(frame.body.startOffset, frame.body.endOffset), '{}');
    assert.notEqual(frame.id, b.callableFrames[index].id);
  }
});

test('typed parameters shadow imports without turning declarations or type headers into calls', async t => {
  for (const header of ['(format)', '(format: any): void', 'async (format: any): Promise<void>'])
    await t.test(header, () => {
      const value = scan(imports + `port.receive = ${header} => {\n  format("payload");\n};\n`);
      assert.equal(value.callableFrames[0].supported, true);
      assert.deepEqual(value.uses.filter(use => use.name === 'format'), []);
    });
  const value = scan(imports + 'export function run(\n  callback: (format: unknown) => string,\n): void {\n  format("body");\n}\n');
  assert.equal(value.callableFrames.length, 1, 'a function type arrow is not a runtime callback');
  assert.equal(value.callableFrames[0].supported, true);
  assert.deepEqual(calls(value, 'format').map(use => use.line), [5]);
});

test('named exported const arrows reuse their actual variable binding and export', () => {
  const source = imports + 'export const render =\n  (value: string): string => {\n  format(value);\n  return render(value);\n};\n';
  const value = scan(source), [frame] = value.callableFrames;
  assert.equal(frame.supported, true);
  assert.equal(frame.bindingKind, 'VARIABLE');
  assert.equal(frame.record.item.symbol, 'render');
  assert.equal(value.symbols.filter(record => record.item.symbol === 'render').length, 1);
  assert.equal(value.exports.get('render'), frame.record);
  assert.equal(frame.start, 2);
  assert.equal(frame.record.endLine, 6);
  assert.equal(calls(value, 'format')[0].origin, frame.record);
  assert.equal(calls(value, 'render')[0].origin, frame.record, 'recursive references retain the real binding');
});

test('bounded top-level const expression arrows preserve bindings and parameter intervals', async t => {
  for (const header of ['value', '(value: string): string']) await t.test(header, () => {
    const value = scan(imports + `export const render = ${header} => format(value);\n`);
    const [frame] = value.callableFrames;
    assert.equal(frame.supported, true, frame.reason);
    assert.equal(frame.body.kind, 'expression');
    assert.equal(frame.record.item.symbol, 'render');
    assert.equal(value.exports.get('render'), frame.record);
    assert.equal(calls(value, 'format')[0].origin, frame.record);
  });
  const value = scan(imports + 'export const render = format => format("inside")\nformat("outside");\n');
  assert.equal(value.callableFrames[0].supported, true);
  assert.equal(value.callableFrames[0].end, 2);
  assert.deepEqual(calls(value, 'format').map(use => use.line), [3], 'the parameter cannot shadow the next module statement');
  for (const statement of ['let render = value => value;', 'const render = value => `${format(value)}`;',
    'const render = value => value +;', 'const render = value => next => format(value, next);',
    'const render = value => value ? 1;', 'const render = value => format(value) format(value);',
    'const render = value => value ===;', 'const render = value => @value;']) {
    const checked = scan(imports + statement);
    assert.equal(checked.callableFrames[0].supported, false, statement);
  }
  let executed = false;
  globalThis.__rcExpressionCompilationProbe = () => { executed = true; };
  try {
    const checked = scan('export const render = () => globalThis.__rcExpressionCompilationProbe();');
    assert.equal(checked.callableFrames[0].supported, true);
    assert.equal(executed, false, 'syntax compilation never executes or evaluates actor source');
  } finally { delete globalThis.__rcExpressionCompilationProbe; }
});

test('expression intervals follow grammar across prefix/infix newlines and end before separate statements', async t => {
  for (const [expression, asynchronous] of [
    ['await\nformat("payload")', true], ['typeof\nformat', false], ['new\nformat()', false],
    ['void\nformat("payload")', false], ['delete\nformat.key', false],
    ['packet in\nformat', false], ['packet instanceof\nformat', false],
  ]) await t.test(expression, () => {
    const value = scan(imports + `export const render = ${asynchronous ? 'async ' : ''}(packet, format) => ${expression};\nformat("outside");\n`, 'module.mjs');
    assert.equal(value.callableFrames[0].supported, true, value.callableFrames[0].reason);
    assert.equal(value.callableFrames[0].end, 3);
    assert.deepEqual(calls(value, 'format').filter(use => use.resolvable).map(use => use.line), [4]);
    assert.equal(value.uses.filter(use => use.name === 'format' && use.resolvable).length, 1, 'the inner operand belongs to the parameter, not the imported binding');
  });
  for (const expression of ['packet.await', 'packet.new', 'packet.typeof', 'packet?.await', 'as', 'satisfies', 'true', 'null', '`text`', '/text/'])
    await t.test(expression, () => {
      const value = scan(imports + `export const render = (packet, format) => ${expression}\nformat("outside");\n`, 'module.mjs');
      assert.equal(value.callableFrames[0].end, 2);
      assert.deepEqual(calls(value, 'format').map(use => use.line), [3], 'member spellings and literals end before the real module call');
    });
  const divided = scan(imports + 'export const render = (packet, width, format) => packet / width /\nformat("payload");\nformat("outside");\n', 'module.mjs');
  assert.equal(divided.callableFrames[0].supported, true);
  assert.equal(divided.callableFrames[0].end, 3);
  assert.deepEqual(calls(divided, 'format').map(use => use.line), [4], 'a tokenized division prefix still requires its next-line operand');
});

test('ordinary functions, constructors and class/struct methods retain actual records', async t => {
  for (const kind of ['class', 'struct']) await t.test(kind, () => {
    const value = scan(imports + `export ${kind} Panel {\n  constructor(value: string) { format(value); }\n  static draw(value: string): void { format(value); }\n}\n`);
    assert.equal(value.callableFrames.length, 2);
    assert(value.callableFrames.every(frame => frame.supported && frame.bindingKind === 'DECLARATION'));
    assert.deepEqual(value.callableFrames.map(frame => frame.record.item.qualified), ['Panel.constructor', 'Panel.draw']);
    assert.deepEqual(calls(value, 'format').map(use => use.origin.item.qualified), ['Panel.constructor', 'Panel.draw']);
  });
  const value = scan('export function recur(value) { return recur(value); }');
  assert.equal(calls(value, 'recur')[0].origin, value.callableFrames[0].record);
});

test('nested callbacks own their body while registration remains in the enclosing function', () => {
  const value = scan(imports + 'export function setup(port) {\n  port.receive = (packet: any): void => {\n    format(packet);\n  };\n}\n');
  const [outer, inner] = value.callableFrames;
  assert(outer.supported && inner.supported);
  assert.notEqual(inner.record, outer.record);
  assert.equal(calls(value, 'format')[0].origin, inner.record);
  assert.equal(inner.record.item.owner, undefined, 'the property label is not a class or receiver binding');
});

test('arrows retain lexical class this without making the callback a class member', () => {
  const value = scan('export class Panel {\n  draw() {\n    register(() => { this.paint(); });\n  }\n  paint() {}\n}\n');
  const callback = value.callableFrames.find(frame => frame.record?.item.kind === 'callback');
  assert.equal(callback.supported, true);
  assert.equal(callback.record.item.owner, undefined);
  assert.equal(callback.record.lexicalThisOwner, 'Panel');
  const paint = value.uses.find(use => use.members.includes('paint'));
  assert.equal(paint.origin, callback.record);
  assert.equal(paint.name, 'Panel');
});

test('lexical this survives static and nested arrows but resets at ordinary callables', async t => {
  for (const [name, body, expected, isStatic] of [
    ['double arrow', 'register(() => { register(() => { this.paint(); }); });', 'Panel', false],
    ['static arrow', 'register(() => { this.paint(); });', 'Panel', true],
    ['function reset', 'register(function () { this.paint(); });', 'this', false],
    ['object method reset', 'const api = { receive() { register(() => { this.paint(); }); } };', 'this', false],
    ['unrelated receiver', 'register(() => { other.paint(); });', 'other', false],
  ]) await t.test(name, () => {
    const value = scan(`export class Panel {\n  ${isStatic ? 'static ' : ''}draw() { ${body} }\n  ${isStatic ? 'static ' : ''}paint() {}\n}\n`);
    const use = value.uses.find(item => item.members.includes('paint'));
    assert.equal(use.name, expected);
    if (expected === 'Panel') {
      assert.equal(use.origin.item.kind, 'callback');
      assert.equal(use.origin.item.owner, undefined);
      assert.equal(use.origin.isStatic, isStatic);
    }
  });
});

test('unsupported local, mutable and assigned arrows remain explicit ownership barriers', async t => {
  for (const statement of ['const local = (packet) => { format(packet); };', 'let local = (packet) => { format(packet); };',
    'port[key] = (packet) => { format(packet); };', 'holder = (packet) => { format(packet); };'])
    await t.test(statement, () => {
      const value = scan(imports + `export function setup(port, key) {\n  ${statement}\n}\n`);
      const [outer, inner] = value.callableFrames;
      assert.equal(inner.supported, false);
      assert.equal(inner.record, undefined);
      assert.notEqual(calls(value, 'format')[0].origin, outer.record);
      assert(calls(value, 'format')[0].origin.item.symbol.startsWith('@unsupported:'));
    });
  const value = scan('let mutable = (value) => { return value; };');
  assert.equal(value.callableFrames[0].supported, false);
});

test('function expressions keep inner names local and never borrow the outer owner', () => {
  const value = scan(imports + 'export function setup() {\n  const local = function format(packet) {\n    return format(packet);\n  };\n}\nformat("outside");\n');
  assert.equal(value.symbols.some(record => record.item.symbol === 'format'), false);
  assert.equal(value.callableFrames.find(frame => frame.kind === 'function' && frame.start === 3).supported, false);
  assert.deepEqual(calls(value, 'format').map(use => use.line), [7]);
});

test('object and local-class methods are barriers until their binding is supported', async t => {
  for (const declaration of [
    'const api = { receive(packet) { format(packet); } };',
    'const api = { async receive(packet) { format(packet); } };',
    'const api = { get value() { return format("x"); } };',
    'const api = { first() {}, receive(packet) { format(packet); } };',
    'const api = { [key](packet) { format(packet); } };',
    'class Local { receive(packet) { format(packet); } }',
  ]) await t.test(declaration, () => {
    const value = scan(imports + `export function setup(key) {\n  ${declaration}\n}\n`);
    const outer = value.callableFrames.find(frame => frame.record?.item.symbol === 'setup');
    assert(value.callableFrames.some(frame => frame.kind === 'method' && !frame.supported));
    assert.notEqual(calls(value, 'format')[0].origin, outer.record);
  });
});

test('static object-property arrows have lexical identity without a receiver binding', () => {
  const value = scan(imports + 'export function setup() {\n  const api = { receive: (packet: any): void => { format(packet); } };\n  return api;\n}\n');
  const callback = value.callableFrames.find(frame => frame.kind === 'arrow');
  assert.equal(callback.supported, true);
  assert.equal(callback.displayLabel, 'receive');
  assert.equal(callback.record.item.qualified, undefined);
  assert.equal(calls(value, 'format')[0].origin, callback.record);
});

test('unsupported destructuring and callable defaults keep explicit uncertainty and executable navigation', async t => {
  for (const header of ['({ format })', '(value = () => format("fallback"))', '(value = { name: format("fallback") })']) await t.test(header, () => {
    const value = scan(imports + `port.receive = ${header} => { format("body"); };`);
    assert.equal(value.callableFrames[0].supported, false);
    assert(value.opaqueOrigins.some(origin => origin.unresolved && origin.reason === 'UNSUPPORTED_CALLABLE_HEADER'));
    if (header.includes('fallback')) assert(calls(value, 'format').some(use => use.resolvable), 'unsupported initializers retain calls as navigation');
  });
});

test('simple default and rest parameters keep actual declarations and initializer ownership', async t => {
  for (const header of ['(value = format("fallback"))', '(value: string = format("fallback"))',
    '(value: number = 0, ...rest: number[])', '(...rest: (string | number)[])']) await t.test(header, () => {
    const value = scan(imports + `export function run${header} { format("body"); }\nformat("outside");\n`);
    const [frame] = value.callableFrames;
    assert.equal(frame.supported, true, frame.reason);
    assert.equal(frame.record.item.symbol, 'run');
    assert.deepEqual(value.opaqueOrigins, []);
    const inside = calls(value, 'format').filter(use => use.line === 2);
    assert.equal(inside.length, header.includes('fallback') ? 2 : 1);
    assert(inside.every(use => use.origin === frame.record));
    assert.equal(calls(value, 'format').at(-1).origin, null);
  });
  const constructors = scan(imports + 'export class Panel { constructor(value: number = 0) { format(value); } draw(...items: string[]) { format(items); } }');
  assert.deepEqual(constructors.callableFrames.map(frame => frame.record?.item.qualified), ['Panel.constructor', 'Panel.draw']);
  assert(constructors.callableFrames.every(frame => frame.supported));
});

test('parameter defaults shadow parameters without importing body-local declarations into their environment', () => {
  const shadowed = scan(imports + 'export function run(value = format("tdz"), format = null) { format("body"); }\nformat("outside");');
  assert.equal(shadowed.callableFrames[0].supported, true);
  assert.deepEqual(calls(shadowed, 'format').filter(use => use.resolvable).map(use => use.line), [3]);
  const bodyLocal = scan(imports + 'export function run(value = format("fallback")) { const format = value; }\nformat("outside");');
  assert.equal(calls(bodyLocal, 'format')[0].origin, bodyLocal.callableFrames[0].record);
  assert.equal(calls(bodyLocal, 'format')[0].resolvable, true);
  const nested = scan(imports + 'export function setup() {\n register((value = format("fallback")) => { format(value); });\n}');
  const inner = nested.callableFrames.find(frame => frame.kind === 'arrow');
  assert(inner.supported);
  assert(calls(nested, 'format').every(use => use.origin === inner.record), 'the outer registration is not the initializer owner');
  const rest = scan(imports + 'export const run = (...format: unknown[]) => { format("body"); };\nformat("outside");');
  assert(rest.callableFrames[0].supported);
  assert.deepEqual(calls(rest, 'format').map(use => use.line), [3]);
  const deferred = scan(imports + 'export function run(value = () => { format("deferred"); }) {}');
  const [outer, innerFrame] = deferred.callableFrames;
  assert(!outer.supported && !innerFrame.supported);
  assert.equal(calls(deferred, 'format')[0].origin.item.line, innerFrame.start);
  assert.equal(calls(deferred, 'format')[0].origin.item.symbol, '@unsupported:' + JSON.parse(innerFrame.id.slice('callable:'.length))[1],
    'a nested default callback does not borrow the function whose body starts later');
});

test('arrow headers distinguish their immediate parameters from earlier ternary expressions', async t => {
  for (const header of ['()', '(packet)', '(packet: string): void', 'async (packet: string): Promise<void>']) await t.test(header, () => {
    const value = scan(imports + `export function setup() {\n const entry={label: flag ? select() : alternate(), onPick: ${header} => {\n  format("body");\n }};\n}`);
    const callback = value.callableFrames.find(frame => frame.kind === 'arrow');
    assert(callback.supported, callback.reason);
    assert.equal(callback.displayLabel, 'onPick');
    assert.equal(callback.start, 3);
    assert.equal(calls(value, 'format')[0].origin, callback.record);
    assert.deepEqual(value.opaqueOrigins, []);
  });
  const complexType = scan(imports + 'export const run = (value): First | (Second) => { format(value); };');
  assert.equal(complexType.callableFrames[0].supported, false, 'unsupported return-type grouping cannot become a fake parameter');
  assert(complexType.opaqueOrigins.some(origin => origin.unresolved));
});

test('multiline optional typed async functions retain frames without crossing a following declaration', () => {
  const value = scan(imports + 'export async function run(value?: string):\n Promise<void> { format(value); }\n');
  assert.equal(value.callableFrames[0].supported, true);
  assert.equal(value.callableFrames[0].record.item.symbol, 'run');
  const malformed = scan('declare function contract(value?: string): Result\nexport function run() {}');
  const first = malformed.callableFrames.find(frame => frame.start === 1);
  assert(first && !first.supported, 'an unfinished return annotation cannot consume the following function body');
});

test('class-expression inner names stay local and their methods remain unsupported barriers', () => {
  const value = scan(imports + 'export const Factory = class Local { draw() { format("body"); } };\nformat("outside");');
  assert.deepEqual(value.symbols.map(record => record.item.symbol), ['Factory']);
  assert.equal(value.callableFrames[0].supported, false);
  assert.equal(value.callableFrames[0].reason, 'UNSUPPORTED_METHOD_BINDING');
  assert(calls(value, 'format')[0].origin.item.symbol.startsWith('@unsupported:'));
  for (const prefix of ['export abstract', 'export default abstract']) {
    const declared = scan(`${prefix} class Panel { draw(value: number = 0) {} }`);
    assert(declared.symbols.some(record => record.item.symbol === 'Panel' && record.item.kind === 'class'), prefix);
    assert.equal(declared.callableFrames[0].record?.item.qualified, 'Panel.draw', prefix);
  }
  const ambient = scan('declare class Panel { draw(value?: number): void; }');
  assert(ambient.symbols.some(record => record.item.symbol === 'Panel' && record.item.kind === 'class'));
  assert.equal(ambient.callableFrames.length, 0, 'an ambient method signature is not an executable body');
});

test('expression-local names do not shadow the enclosing callable or escape their own defaults', async t => {
  for (const expression of ['class format { draw() { format("self"); } }',
    'function format(value = format("self default")) { format("self body"); }']) await t.test(expression, () => {
    const value = scan(imports + `export function setup() {\n const Factory = ${expression};\n format("outside expression");\n}`);
    assert.deepEqual(calls(value, 'format').filter(use => use.resolvable).map(use => use.line), [4]);
    assert.equal(calls(value, 'format').at(-1).origin.item.symbol, 'setup');
  });
  for (const declaration of ['function format() {}', 'function* format() {}', 'class format {}']) {
    const value = scan(imports + `export function setup() { ${declaration} format("local"); }`);
    assert.deepEqual(calls(value, 'format').filter(use => use.resolvable), [], 'a real same-line declaration still shadows the import');
  }
});

test('method and constructor type-arrow headers do not become runtime callbacks', () => {
  const value = scan(imports + 'export class Handler {\n'
    + ' constructor(onValue: (value: string) => void) { onValue("x"); }\n'
    + ' handle(onValue: (value: string) => void): Promise<void> { format("body"); return Promise.resolve(); }\n'
    + '}');
  assert.equal(value.callableFramesComplete, true);
  assert.deepEqual(value.callableFrames.map(frame => frame.record?.item.qualified), ['Handler.constructor', 'Handler.handle']);
  assert(value.callableFrames.every(frame => frame.supported));
  assert.deepEqual(value.opaqueOrigins, []);
  assert.equal(calls(value, 'format')[0].origin.item.qualified, 'Handler.handle');

  const executable = scan(imports + 'export class Handler {\n'
    + ' handle(onValue: (value: string) => void = (value) => { format("default callback"); }) {\n'
    + '   register(() => { format("body callback"); });\n'
    + ' }\n}');
  assert.equal(executable.callableFrames.filter(frame => frame.kind === 'arrow').length, 2, 'only the real default/body callbacks remain');
  const [defaultCall, bodyCall] = calls(executable, 'format');
  assert.notEqual(defaultCall.origin, bodyCall.origin);
  assert(defaultCall.origin.item.symbol.startsWith('@unsupported:'));
  assert(bodyCall.origin.item.symbol.startsWith('@callback:'));
  assert(executable.opaqueOrigins.some(row => row.unresolved && row.reason === 'UNSUPPORTED_CALLABLE_HEADER'));
});

test('semicolon-free annotations stop at owning closes and actual member/declaration boundaries', async t => {
  for (const fields of ['value: number', 'callback: (value: string) => void',
    'callback?: (value: string) => void', 'callback!: (value: string) => void',
    'callback: (value: string) => { done: boolean }',
    'items: Map<string, Array<number>>\n choice:\n  | string\n  | number']) await t.test(fields, () => {
    const value = scan(imports + `export class Holder {\n ${fields}\n run() { register(() => { format("method callback"); }); }\n}\n`
      + 'export function operation(input: number): number { return format(input); }\n');
    assert.equal(value.callableFramesComplete, true);
    assert.equal(value.callableFrames.length, 3, 'later methods, real callbacks and exported functions are all framed');
    assert(value.callableFrames.every(frame => frame.supported));
    assert(value.callableFrames.some(frame => frame.record.item.qualified === 'Holder.run'));
    assert(value.callableFrames.some(frame => frame.record.item.symbol === 'operation'));
    assert(calls(value, 'format').some(use => use.origin.item.kind === 'callback'));
    assert(calls(value, 'format').some(use => use.origin.item.symbol === 'operation'));
    assert.deepEqual(value.opaqueOrigins, []);
  });
  const close = scan('export class Holder {\n value: number\n}\nexport function operation(input: number) { return input; }');
  assert.deepEqual(close.callableFrames.map(frame => frame.record?.item.symbol), ['operation']);
  const variable = scan(imports + 'let callback: (value: string) => void\nexport function operation() { register(() => { format("body"); }); }');
  assert.equal(variable.callableFrames.length, 2);
  assert(variable.callableFrames.every(frame => frame.supported));
  const initializer = scan(imports + 'export class Holder {\n callback: (value: string) => void\n handler = (value) => { format(value); }\n}');
  assert.equal(initializer.callableFrames.length, 1, 'a later field initializer is executable, independently of receiver-binding support');
  assert.equal(calls(initializer, 'format').length, 1);
});

test('field annotations stop before static initializers and member decorators with runtime callbacks', async t => {
  for (const terminator of ['', ';']) await t.test(terminator || 'semicolon-free', () => {
    const value = scan(imports + `export class Port {\n value: number${terminator}\n static { register(() => { format("body"); }); }\n}`);
    assert.equal(value.callableFramesComplete, true);
    assert.equal(value.callableFrames.length, 1);
    const [callback] = value.callableFrames;
    assert(callback.supported);
    assert.equal(callback.record.item.kind, 'callback');
    assert.equal(callback.record.item.owner, undefined);
    assert.equal(calls(value, 'format')[0].origin, callback.record);
    assert.deepEqual(value.opaqueOrigins, []);
  });
  const decorated = scan(imports + 'export class Port {\n value: number\n @decorate(() => { format("decorator callback"); })\n handle() {}\n}');
  assert.equal(decorated.callableFrames.length, 2);
  assert.equal(calls(decorated, 'format')[0].origin.item.kind, 'callback');
  assert(decorated.callableFrames.some(frame => frame.record?.item.qualified === 'Port.handle'));
});

test('local type-alias ASI extents preserve following callback ownership and multiline types', async t => {
  for (const alias of ['type Alias = string', 'type Alias = { label: string }',
    'type Alias =\n | string\n | number', 'type Alias<T> = Map<\n string,\n T\n>',
    'type Alias = (value: string) =>\n void', 'type Alias = typeof\n globalThis']) await t.test(alias, () => {
    const value = scan(imports + `export function setup() {\n ${alias}\n register(() => { format("child"); });\n}`);
    assert.equal(value.callableFramesComplete, true);
    assert.equal(value.callableFrames.length, 2);
    const callback = value.callableFrames.find(frame => frame.record?.item.kind === 'callback');
    assert(callback?.supported);
    assert.equal(calls(value, 'format')[0].origin, callback.record);
    assert.deepEqual(value.opaqueOrigins, []);
  });
  for (const terminator of ['', ';']) {
    const returned = scan(imports + `export function setup() {\n type Alias = (value: string) => void${terminator}\n return () => { format("child"); };\n}`);
    assert.equal(returned.callableFrames.length, 2);
    assert.equal(calls(returned, 'format')[0].origin.item.kind, 'callback');
    const outer = scan(imports + `export function setup() {\n type Alias = string${terminator}\n return format("outer");\n}`);
    assert.equal(outer.callableFrames.length, 1);
    assert.equal(calls(outer, 'format')[0].origin.item.symbol, 'setup', 'a real outer return call stays in its real owner');
  }
});

test('uncertain type-alias boundaries stay incomplete without suppressing later real callbacks', () => {
  const value = scan(imports + 'export function setup() {\n type Alias = string\n probe\n register(() => { format("child"); });\n}');
  assert.equal(value.callableFramesComplete, false);
  assert(value.opaqueOrigins.some(row => row.reason === 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY' && row.unresolved));
  assert.equal(calls(value, 'format')[0].origin.item.kind, 'callback');
  assert.equal(value.callableFrames.length, 2, 'uncertainty does not stop lexical child enumeration');
  const localInterface = scan(imports + 'export function setup() {\n interface Alias { label: string }\n register(() => { format("child"); });\n}');
  assert.equal(localInterface.callableFramesComplete, true);
  assert.equal(localInterface.callableFrames.length, 2);
  assert.equal(calls(localInterface, 'format')[0].origin.item.kind, 'callback');
});

test('local type-only names leave runtime values visible while real value declarations still shadow', () => {
  for (const declaration of ['type format = string;', 'interface format { label: string }']) {
    const value = scan(imports + `export function setup() {\n ${declaration}\n format("outer value");\n}`);
    assert.equal(value.callableFramesComplete, true);
    assert.equal(calls(value, 'format').length, 1);
    assert.equal(calls(value, 'format')[0].resolvable, true);
    assert.equal(calls(value, 'format')[0].origin.item.symbol, 'setup');
    assert.deepEqual(value.uses.filter(use => use.name === 'format').map(use => use.relation), ['call'],
      'a type declaration name is neither a runtime reference nor a write');
  }
  for (const declaration of ['class format {}', 'enum format { Ready }', 'namespace format { export const value = 1; }']) {
    const value = scan(imports + `export function setup() { ${declaration} format("local value"); }`);
    assert.deepEqual(calls(value, 'format').filter(use => use.resolvable), [], declaration);
  }
  const namedType = scan('import { type } from "./value.mjs";\nexport function setup() { const type = null; type("local"); }\ntype("outside");');
  assert.deepEqual(calls(namedType, 'type').filter(use => use.resolvable).map(use => use.line), [3]);
});

test('type words in value expressions do not start alias declarations', async t => {
  for (const statement of ['const selected = message.type as number > 0;',
    'const selected = type as number > 0;', 'for (const type of values) { if (type > 0) format(type); }']) await t.test(statement, () => {
    const value = scan(imports + `export function setup(message, type, values) {\n ${statement}\n register(() => { format("child"); });\n}`);
    assert.equal(value.callableFramesComplete, true);
    assert.deepEqual(value.opaqueOrigins, []);
    assert(value.callableFrames.some(frame => frame.record?.item.kind === 'callback'));
  });
});

test('parenthesized and array-leading value statements after aliases retain child owners', async t => {
  for (const statement of ['(() => { format("child"); });', '(() => { format("child"); })();',
    '[1].forEach(() => { format("child"); });']) await t.test(statement, () => {
    const value = scan(imports + `export function setup() {\n type Alias = string\n ${statement}\n}`);
    assert.equal(calls(value, 'format').length, 1);
    assert.equal(calls(value, 'format')[0].origin.item.kind, 'callback');
    assert.notEqual(calls(value, 'format')[0].origin.item.symbol, 'setup');
  });
  for (const alias of ['type Alias = string\n []', 'type Alias = Map<\n string,\n (value: string) => void\n>']) {
    const value = scan(imports + `export function setup() {\n ${alias}\n register(() => { format("child"); });\n}`);
    assert.equal(value.callableFramesComplete, true);
    assert.equal(value.callableFrames.length, 2, 'array and nested function type continuations remain type-only');
    assert.equal(calls(value, 'format')[0].origin.item.kind, 'callback');
  }
});

test('plain bracket callables after an alias stay uncertain and never borrow the outer owner', async t => {
  for (const statement of ['[() => { format("child"); }];', '[function () { format("child"); }];']) await t.test(statement, () => {
    const value = scan(imports + `export function setup() {\n type Alias = string\n ${statement}\n}`);
    assert.equal(value.callableFramesComplete, false);
    assert(value.opaqueOrigins.some(row => row.reason === 'UNSUPPORTED_TYPE_ALIAS_BOUNDARY' && row.unresolved));
    assert.equal(calls(value, 'format').length, 1);
    assert.notEqual(calls(value, 'format')[0].origin.item.symbol, 'setup');
    assert.equal(value.callableFrames.length, 2, 'the child scope is retained even when its declaration extent is uncertain');
  });
  const definiteType = scan(imports + 'export function setup() {\n type Alias = Array<(value: string) => void>[number];\n register(() => { format("child"); });\n}');
  assert.equal(definiteType.callableFramesComplete, true);
  assert.equal(definiteType.callableFrames.length, 2, 'a definite indexed function type contributes no runtime arrow');
  assert.equal(calls(definiteType, 'format')[0].origin.item.kind, 'callback');
});

test('expression arrows are unsupported frames and preserve parameter shadow barriers', () => {
  const value = scan(imports + 'export function setup() {\n  const local = format => format("payload");\n}\n');
  assert(value.callableFrames.some(frame => !frame.supported && frame.reason === 'UNSUPPORTED_EXPRESSION_ARROW'));
  assert.deepEqual(calls(value, 'format'), []);
});

test('type-only arrows are not runtime frames', () => {
  const value = scan('type Fn = (value: string) => { done: boolean };\n'
    + 'let handler: (value: string) => string;\n'
    + 'export const real = (value: string) => { return value; };\n');
  assert.equal(value.callableFrames.length, 1);
  assert.equal(value.callableFrames[0].record.item.symbol, 'real');
  const declared = scan('declare function contract(value: string): string;\nport.receive = (value: string): void => {};\n');
  assert.equal(declared.callableFrames.find(frame => frame.kind === 'function').supported, false);
  assert.equal(declared.callableFrames.find(frame => frame.kind === 'function').body, null);
  assert.deepEqual(declared.opaqueOrigins, [], 'an unevaluated declaration signature does not hide executable header work');
});

test('test callbacks preserve named test owners and do not poison production opacity', () => {
  const value = scan(imports + 'beforeEach(() => { format("setup"); });\n'
    + 'test("case", (value = format("default")) => { format(value); });\n', 'sample.test.ts');
  assert.deepEqual(value.opaqueOrigins, []);
  assert(calls(value, 'format').some(use => use.origin.item.kind === 'test-hook' && use.origin.item.symbol === 'beforeEach'));
});

test('frame caps expose incompleteness rather than returning a positive truncated inventory', () => {
  const source = Array.from({ length: 514 }, (_, n) => `port.event${n} = () => {};`).join('\n');
  const value = scan(source);
  assert.equal(value.callableFramesComplete, false);
  assert(value.callableFrames.length <= 512);
  assert(value.opaqueOrigins.some(origin => origin.reason === 'CALLABLE_FRAME_LIMIT' && origin.unresolved));
  const nested = scan('register(() => {\n'.repeat(66) + 'format("x");\n' + '});\n'.repeat(66));
  assert.equal(nested.callableFramesComplete, false, 'nested frame depth is bounded independently from count');
  const malformed = scan('export class Panel { run() {');
  assert.equal(malformed.callableFramesComplete, false);
});
