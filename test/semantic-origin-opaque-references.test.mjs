import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSemanticGraph } from '../lib/semantic-graph.mjs';
import { scanSemanticSource } from '../lib/semantic-graph-syntax.mjs';
import { createProductionOriginCoverage } from '../lib/runtime-v2/production-origin-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

async function project(t, { target, body, caller, extras = {}, line = 2, callerFile = 'entry.mjs' }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-opaque-origin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = { [target]: body, [callerFile]: caller, ...extras };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const graph = await buildSemanticGraph(root, { snapshotPaths: Object.keys(files), budgetMs: 5000 });
  assert.equal(graph.status, 'ready');
  const origin = createProductionOriginCoverage({ projectRoot: root, graph, contextId: 'generic-reference-test' });
  const receipt = await origin.discover({ objectId: 'source-obligation',
    entry: { path: path.join(root, target), start: line, end: line, sha256: sha256(body) } });
  const selected = graph.originEntry({ file: target, start: line, end: line });
  assert.equal(selected.status, 'READY');
  const incoming = graph.query({ operation: 'incoming', file: target,
    symbol: selected.definition.qualified ?? selected.definition.symbol, depth: 3 });
  return { graph, receipt, incoming };
}
const render = 'export function renderReport(value) {\n  return value;\n}\n';
const format = 'export function format(value) {\n  return value;\n}\n';
const service = 'export class Service {\n  static run(value) {\n    return value;\n  }\n}\n';
function uncertain(receipt, reason) {
  assert.equal(receipt.status, 'UNKNOWN');
  assert.equal(receipt.reason, 'UNPARSED_POTENTIAL_ORIGIN');
  assert.equal(receipt.unparsedOrigin.reason, reason);
  assert.equal(receipt.unparsedOrigin.sourceReadAcknowledged, false);
  assert.deepEqual(receipt.candidates, []);
}

test('equivalent escaped selectors retain scoped uncertainty instead of an empty certificate', async t => {
  for (const literal of ['"views/\\x52eport"', '"views/\\u0052eport"', '"views/\\u{52}eport"',
    '"views/\\u{0000000000000000000052}eport"', '"views/\\\nReport"'])
    await t.test(literal, async t => {
      assert.equal(runInNewContext(literal), 'views/Report', 'independent JavaScript runtime establishes literal equivalence');
      const { receipt, incoming } = await project(t, { target: 'views/Report.mjs', body: render,
        caller: `export function open(navigate) { navigate(${literal}, { mode: "full" }); }\n` });
      uncertain(receipt, 'ESCAPED_RUNTIME_STRING');
      assert.equal(receipt.unparsedOrigin.selector, 'views/Report');
      assert.equal(receipt.unparsedOrigin.path, 'entry.mjs');
      assert.deepEqual(incoming.hits, [], 'a selector witness is not an invented call');
    });
});

test('plain selectors remain candidates and unrelated escaped strings do not disable discovery', async t => {
  for (const [literal, count] of [['"views/Report"', 1], ['"views/\\x52eporter"', 0],
    ['"widgets/\\x52eport"', 0], ['"widgets/\\u{000000000052}eport"', 0], ['"views/Other"', 0]]) await t.test(literal, async t => {
    const { receipt } = await project(t, { target: 'views/Report.mjs', body: render,
      caller: `export function open(navigate) { navigate(${literal}, {}); }\n`,
      extras: { 'unrelated.mjs': 'export const greeting = "hello\\nworld";\n' } });
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.equal(receipt.candidates.length, count);
  });
});

test('valid quoted escape families retain exact values without unresolved decoder limits', async t => {
  for (const literal of [String.raw`"\u{000000000041}"`, String.raw`"\u{0000000000000000000000000000}"`,
    String.raw`"\u{0000000010ffff}"`, String.raw`"\uD800"`, String.raw`"\x41"`, String.raw`"\0"`,
    String.raw`"\c"`, String.raw`"\'\"\\"`, '"line\\\ncontinued"']) await t.test(literal, () => {
    const expected = runInNewContext('"use strict";' + literal);
    const scanned = scanSemanticSource(`export const label = ${literal};\n`, 'strings.mjs');
    const [witness] = scanned.opaqueOrigins;
    assert(witness, 'a runtime escaped literal remains a potential navigation witness');
    assert.notEqual(witness.unresolved, true, 'a valid literal is not an unresolved decoder limit');
    assert.deepEqual(witness.literals, [expected]);
  });
  for (const literal of [String.raw`"\u{110000}"`, String.raw`"\u{}"`, String.raw`"\u{41"`,
    String.raw`"\xZ0"`, String.raw`"\uZZZZ"`]) await t.test(literal, () => {
    assert.throws(() => runInNewContext('"use strict";' + literal), { name: 'SyntaxError' });
    const scanned = scanSemanticSource(`export const label = ${literal};\n`, 'invalid.mjs');
    assert(scanned.opaqueOrigins.some(witness => witness.unresolved === true), 'invalid undecodable syntax retains uncertainty');
  });
});

test('type-only aliases, unions and headers preserve plain-string navigation for unrelated origins', async t => {
  const templates = [
    literal => `type Label = ${literal};\n`,
    literal => `type Label = ${literal} | "other";\n`,
    literal => `type Options = { label: ${literal} };\n`,
    literal => `interface Options { label: ${literal}; }\n`,
    literal => `export function accept(label: ${literal}): void {}\n`,
    literal => `export function provide(): ${literal} { throw Error("unused"); }\n`,
    literal => `type Handler = (label: ${literal}) => void;\n`,
    literal => `export const label: ${literal} = "alpha";\n`,
  ];
  for (const template of templates) for (const literal of ['"alpha"', '"\\u0061lpha"', '"\\u{000000000061}lpha"'])
    await t.test(template(literal), async t => {
      const { receipt } = await project(t, { target: 'format.mjs', body: format,
        caller: template(literal) });
      assert.equal(receipt.status, 'READY', receipt.reason);
      assert.deepEqual(receipt.candidates, []);
    });
});

test('equivalent type-only selectors preserve candidates while callable headers stay excluded', async t => {
  for (const [template, count] of [
    [literal => `type Route = ${literal};\n`, 1],
    [literal => `type Route = ${literal} | "other";\n`, 1],
    [literal => `type Options = { route: ${literal} };\n`, 1],
    [literal => `export function accept(route: ${literal}): void {}\n`, 0],
    [literal => `export function provide(): ${literal} { throw Error("unused"); }\n`, 0],
  ]) for (const literal of ['"views/Report"', '"views/\\u0052eport"', '"views/\\u{000000000052}eport"'])
    await t.test(template(literal), async t => {
      const { receipt } = await project(t, { target: 'views/Report.mjs', body: render, caller: template(literal) });
      assert.equal(receipt.status, 'READY', receipt.reason);
      assert.equal(receipt.candidates.length, count);
    });
});

test('runtime initializers and defaults retain escaped-selector witnesses outside their type annotations', async t => {
  for (const caller of [
    'export const route: string = "views/\\u{000000000052}eport";\n',
    'export function accept(route: string = "views/\\u{000000000052}eport"): void {}\n',
  ]) await t.test(caller, async t => {
    const { receipt } = await project(t, { target: 'views/Report.mjs', body: render, caller });
    uncertain(receipt, 'ESCAPED_RUNTIME_STRING');
    assert.equal(receipt.unparsedOrigin.selector, 'views/Report');
  });
});

test('known function call/apply/bind receivers produce uncertainty without activation edges', async t => {
  for (const expression of ['format.call(null, value)', 'format.apply(null, [value])',
    'bus.on("work", format.bind(null))']) await t.test(expression, async t => {
    const { receipt, incoming } = await project(t, { target: 'format.mjs', body: format,
      caller: `import { format } from "./format.mjs";\nexport function start(value, bus) { return ${expression}; }\n` });
    uncertain(receipt, 'INDIRECT_CALLABLE_REFERENCE');
    assert.deepEqual(incoming.hits, [], 'potential receivers do not become proved calls');
  });
});

test('callable references retain exact imported aliases and namespace/re-export bindings', async t => {
  for (const [imports, expression, extras] of [
    ['import { format as encode } from "./format.mjs";', 'encode.call(null, value)', {}],
    ['import * as codec from "./format.mjs";', 'codec.format.apply(null, [value])', {}],
    ['import { encode } from "./bridge.mjs";', 'encode.bind(null)', { 'bridge.mjs': 'export { format as encode } from "./format.mjs";\n' }],
  ]) await t.test(expression, async t => {
    const { receipt } = await project(t, { target: 'format.mjs', body: format,
      caller: `${imports}\nexport function start(value) { return ${expression}; }\n`, extras });
    uncertain(receipt, 'INDIRECT_CALLABLE_REFERENCE');
  });
});

test('overridden call remains uncertain because member invocation need not activate its receiver', async t => {
  assert.equal(runInNewContext('function format(value) { throw Error("must not run"); }\nformat.call = () => "replacement";\nformat.call(null, 1);'), 'replacement');
  const { receipt, incoming } = await project(t, { target: 'format.mjs', body: format,
    caller: 'import { format } from "./format.mjs";\nformat.call = () => { return "replacement"; };\nexport function start(value) { return format.call(null, value); }\n' });
  uncertain(receipt, 'INDIRECT_CALLABLE_REFERENCE');
  assert(!incoming.hits.some(hit => hit.relation === 'call'));
});

test('static bracket references require the exact resolved owner and do not assert invocation', async t => {
  for (const key of ['"run"', '"r\\u0075n"']) await t.test(key, async t => {
    const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3,
      caller: `import { Service } from "./service.mjs";\nexport function start(value) { return Service[${key}](value); }\n` });
    uncertain(receipt, 'STATIC_COMPUTED_MEMBER_REFERENCE');
    assert.deepEqual(incoming.hits, []);
  });
});

test('optional quoted bracket receivers retain exact callable witnesses without call edges', async t => {
  for (const expression of ['Service?.["run"](value)', 'Service?.["r\\u0075n"](value)',
    'Service?.["run"]?.(value)', 'Service["run"]?.(value)']) await t.test(expression, async t => {
    const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3,
      caller: `import { Service } from "./service.mjs";\nexport function start(value) { return ${expression}; }\n` });
    uncertain(receipt, 'STATIC_COMPUTED_MEMBER_REFERENCE');
    assert.deepEqual(incoming.hits, [], 'a potential optional receiver is not a proved invocation');
  });
  const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3,
    caller: 'import * as api from "./service.mjs";\nexport function start(value) { return api?.["Service"]["run"](value); }\n' });
  uncertain(receipt, 'STATIC_COMPUTED_MEMBER_REFERENCE');
  assert.deepEqual(incoming.hits, []);
});

test('proven erased indexed-access references do not create runtime witnesses', async t => {
  for (const caller of [
    'import { Service } from "./service.mjs";\ntype Handler = typeof Service["run"];\n',
    'import { Service } from "./service.mjs";\ninterface Holder { action: typeof Service["run"]; }\n',
    'import type { Service } from "./service.mjs";\ntype Handler = typeof Service["run"];\n',
    'import { Service } from "./service.mjs";\ntype Result = ReturnType<typeof Service["run"]>;\n',
    'import { Service } from "./service.mjs";\nexport function start(action: typeof Service["run"]) { return action; }\n',
  ]) await t.test(caller, async t => {
    const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3, caller });
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.deepEqual(receipt.candidates, []);
    assert.deepEqual(incoming.hits, [], 'erased type syntax grants no activation edge');
  });
});

test('runtime bracket initializers and defaults remain separate from erased annotations', async t => {
  for (const expression of ['export const value: number = Service?.["run"](1);',
    'export function start(action: unknown = Service?.["run"]) { return action; }'])
    await t.test(expression, async t => {
      const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3,
        caller: `import { Service } from "./service.mjs";\n${expression}\n` });
      uncertain(receipt, 'STATIC_COMPUTED_MEMBER_REFERENCE');
    });
  const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3,
    caller: 'import { Service } from "./service.mjs";\nexport function start() { type Handler = Maybe\n[() => Service?.["run"]]; }\n' });
  assert.equal(receipt.status, 'UNKNOWN', 'ambiguous type extent cannot erase a potential runtime callback');
  assert.equal(receipt.unparsedOrigin?.sourceReadAcknowledged, false);
});

test('semicolon-free variable annotations cannot erase a following runtime optional selector', async t => {
  const variants = [
    { code: 'let handler: typeof Service["run"]\nService?.["run"](1);\n', runtimeLine: 3,
      executable: 'let handler; Service?.["run"](1);' },
    { code: 'export function start() {\n  let handler: typeof Service["run"]\n  Service?.["run"](1);\n}\n', runtimeLine: 4,
      executable: 'function start() { let handler; Service?.["run"](1); } start();' },
    { code: 'let handler: typeof Service["run"]\nconst result = Service?.["run"](1);\n', runtimeLine: 3,
      executable: 'let handler; const result = Service?.["run"](1);' },
    { code: 'let handler: typeof Service["run"]\nexport function start(value: unknown = Service?.["run"](1)) { return value; }\n', runtimeLine: 3,
      executable: 'let handler; function start(value = Service?.["run"](1)) { return value; } start();' },
  ];
  for (const { code, runtimeLine, executable } of variants) await t.test(code, async t => {
    let calls = 0;
    runInNewContext(executable, { Service: { run() { calls++; } } });
    assert.equal(calls, 1, 'the type-erased operation actually invokes the selected method');
    const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3, callerFile: 'entry.ts',
      caller: 'import { Service } from "./service.mjs";\n' + code });
    uncertain(receipt, 'STATIC_COMPUTED_MEMBER_REFERENCE');
    assert.equal(receipt.unparsedOrigin.path, 'entry.ts');
    assert.equal(receipt.unparsedOrigin.start, runtimeLine, 'the witness selects runtime code after the annotation');
    assert.deepEqual(incoming.hits, [], 'an observed optional selector is not an activation edge');
  });
});

test('healthy multiline annotations retain their erased optional-member exclusions', async t => {
  for (const code of [
    'let handler:\n  typeof Service\n  ["run"];\n',
    'let handler:\n  | typeof Service["run"]\n  | undefined;\n',
    'let handlers: Record<\n  string,\n  typeof Service["run"]\n>;\n',
    'let handlers: Array\n  <() => typeof Service["run"]>;\n',
    'let handler: (value: number) =>\n  typeof Service["run"];\n',
    'let handler: true extends false\n  ? never\n  : typeof Service["run"];\n',
    'let handler: typeof Service["run"]\nexport const ready = true;\n',
    'export function start() {\n  let handler: typeof Service["run"]\n  return 1;\n}\n',
    'export function start() {\n  let handler: typeof Service["run"]\n  console?.["log"]("ready");\n}\n',
    'export class Holder {\n  handler: typeof Service["run"]\n  static count: number = 1;\n}\n',
  ]) await t.test(code, async t => {
    const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3, callerFile: 'entry.ts',
      caller: 'import { Service } from "./service.mjs";\n' + code });
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.deepEqual(receipt.candidates, []);
  });
});

test('uncertain annotation ASI extents retain uncertainty instead of a partial type-only certificate', async t => {
  for (const code of ['let handler: Maybe\n[() => Service?.["run"]];\n',
    'let handler: Maybe\n(() => Service?.["run"])();\n']) await t.test(code, async t => {
    const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3, callerFile: 'entry.ts',
      caller: 'import { Service } from "./service.mjs";\n' + code });
    assert.equal(receipt.status, 'UNKNOWN');
    assert.deepEqual(receipt.candidates, []);
    assert.equal(receipt.unparsedOrigin?.sourceReadAcknowledged, false);
  });
});

test('optional call/apply/bind heads retain exact potential receivers without public invocation edges', async t => {
  for (const expression of ['Service.run.call?.(null, 1)', 'Service.run?.call?.(null, 1)',
    'Service["run"]["call"]?.(null, 1)', 'Service?.["run"]?.["apply"]?.(null, [1])',
    'Service.run.bind?.(null, 1)?.()']) await t.test(expression, async t => {
    let calls = 0;
    runInNewContext(expression, { Service: { run() { calls++; } } });
    assert.equal(calls, 1);
    const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3,
      caller: `import { Service } from "./service.mjs";\nexport function start() { return ${expression}; }\n` });
    uncertain(receipt, 'INDIRECT_CALLABLE_REFERENCE');
    assert.deepEqual(incoming.hits, []);
  });
  const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3,
    caller: 'import { Other } from "./other.mjs";\nexport function start() { return Other.run.call?.(null, 1); }\n',
    extras: { 'other.mjs': 'export class Other { static run(value) { return value; } }\n' } });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert.deepEqual(receipt.candidates, []);
});

test('optional member witnesses retain lexical shadows and foreign owners', async t => {
  for (const caller of [
    'import { Service } from "./service.mjs";\nexport function start(Service, value) { return Service?.["run"](value); }\n',
    'import { Other } from "./other.mjs";\nexport function start(value) { return Other?.["run"](value); }\n',
  ]) await t.test(caller, async t => {
    const { receipt } = await project(t, { target: 'service.mjs', body: service, line: 3, caller,
      extras: { 'other.mjs': 'export class Other { static run(value) { return value; } }\n' } });
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.deepEqual(receipt.candidates, []);
  });
});

test('reading a callable metadata property does not assert activation or handoff', async t => {
  const { receipt, incoming } = await project(t, { target: 'service.mjs', body: service, line: 3,
    caller: 'import { Service } from "./service.mjs";\nexport function describe() { return Service["run"].description; }\n' });
  assert.equal(receipt.status, 'READY', receipt.reason);
  assert.deepEqual(receipt.candidates, []);
  assert.deepEqual(incoming.hits, []);
});

test('foreign bindings, shadowed parameters, foreign owners and near member names stay ready', async t => {
  const cases = [
    { target: 'format.mjs', body: format, caller: 'import { other as encode } from "./other.mjs";\nexport function start(value) { return encode.call(null, value); }\n',
      extras: { 'other.mjs': 'export function other(value) { return value; }\n' } },
    { target: 'format.mjs', body: format, caller: 'import { format } from "./format.mjs";\nexport function start(format, value) { return format.call(null, value); }\n' },
    { target: 'service.mjs', body: service, line: 3, caller: 'import { Other } from "./other.mjs";\nexport function start(value) { return Other["run"](value); }\n',
      extras: { 'other.mjs': 'export class Other { static run(value) { return value; } }\n' } },
    { target: 'service.mjs', body: service, line: 3, caller: 'import { Service } from "./service.mjs";\nexport function start(value) { return Service["runner"](value); }\n' },
    { target: 'service.mjs', body: service, line: 3, caller: 'export function start(other, key, value) { return other[key](value); }\n' },
  ];
  for (const options of cases) await t.test(options.caller, async t => {
    const { receipt } = await project(t, options);
    assert.equal(receipt.status, 'READY', receipt.reason);
    assert.deepEqual(receipt.candidates, []);
  });
});

test('ordinary direct calls remain observed references and overloads retain honest uncertainty', async t => {
  const direct = await project(t, { target: 'format.mjs', body: format,
    caller: 'import { format } from "./format.mjs";\nexport function start(value) { return format(value); }\n' });
  assert.equal(direct.receipt.status, 'READY');
  assert(direct.receipt.candidates.some(row => row.path === 'entry.mjs'));
  assert(direct.incoming.hits.some(row => row.relation === 'call'));
  const overload = await project(t, { target: 'normalize.ts', line: 4,
    body: 'export function normalize(value: string): string;\nexport function normalize(value: number): string;\nexport function normalize(value: string | number): string {\n  return String(value);\n}\n',
    caller: 'import { normalize } from "./normalize";\nexport function start(value) { return normalize(value); }\n' });
  assert.equal(overload.receipt.status, 'UNKNOWN');
  assert.equal(overload.receipt.reason, 'AMBIGUOUS_OR_PARTIAL_QUERY');
});
