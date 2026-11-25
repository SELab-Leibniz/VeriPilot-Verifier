import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { matchConfiguredArtifact } from '../artifact-pipeline.mjs';
import { outsideDecision } from './decision-scope.mjs';
import { OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY } from './paths.mjs';
import { atomicWriteJson, readJson, sha256 } from './utils.mjs';
import { REGRESSION_TRIAGE_VERSION, triageRegressionFailures, applyCollateralReceipt, isolatedRegressionResult,
  REGRESSION_OUTPUT_STREAM_POLICY as OUTPUT_STREAM_POLICY,
  regressionProtocolOutputs as protocolOutputs, regressionProtocolRecords as protocolRecords } from './regression-triage.mjs';

const executeFile = promisify(execFile);
export const STANDING_REGRESSION = 'REGRESSION';
export const STANDING_REGRESSION_TEXT = 'Changes must preserve pre-existing behavior the request did not ask to change (existing test assertions, return values/state relied on by existing callers).';
// Line 2 binds the standing claim; stable bytes keep its identity across Stops.
export const STANDING_OBLIGATIONS_TEXT = [
  'Runtime Corrector program-owned standing obligation. The program adds it to this Stop checklist because the task changed non-artifact source files. It is not an original user requirement; do not recreate it with set_original_checklist.',
  `REGRESSION (M16 IMPLEMENTATION/PRODUCTION, HARD): ${STANDING_REGRESSION_TEXT}`,
  'A behavior change that the original request asks for is not a regression. Report DEVIATION only with acknowledged source_read receipts for both the pre-existing test assertion or caller dependency and the changed code that contradicts it.',
  'Existing public entry points and service/test-substitute boundaries are compatibility contracts unless the original request explicitly replaces that boundary. A method used only by existing tests is not automatically safe to delete. Rewriting those tests or their mocks does not establish compatibility; read their removed lines in regressionEvidence.evidenceFiles and the program-run original tests.',
  'For each failed original test, distinguish its expected behavior from its setup. An expectation that directly contradicts the requested new behavior may be obsolete. An unchanged expectation that fails because production bypasses the original service/test-substitute entry point is a compatibility regression, including a new path that unexpectedly reaches a real backend. Adding a helper or needing fresh data is an implementation choice, not authorization to bypass that entry point. Equivalent effects after remocking do not prove compatibility with the original callers. Trace the old assertion and the bypass in changed production source; preserve the existing boundary while implementing the requested behavior.',
  'An obsolete assertion does not retire the rest of its test case. Execution can stop at the first failed assertion, leaving later assertions untested. Inspect every surviving assertion in that case and compare the changed return fields and effects, including display text, status and identity. Also inspect related invalid, empty and missing-input cases even if the program run passes them under its current substitutes; do not assume a passing suite covers every dependency outcome.',
  'Static/global state includes cached function values and mutable dependency hooks. A static field initialized from an existing service/repository function can retain an earlier implementation or test substitute after the canonical API is replaced or restored. Trace lookup at the time of each call, not just the initial default. Tests that switch to newly introduced production injection fields do not establish that callers and tests using the original API still work; prefer the established service/repository invocation boundary and verify successive calls with restored substitutes.',
  'Changed tests can also corrupt shared production state: inspect setup, cleanup and later calls through the canonical API. A cached original function or private helper used by rewritten tests can mask a substitute that remains installed for other callers. Verify the actual mock library cleanup semantics; a method named clear or reset is not proof that it restores the original function. For this standing regression item, changed test source may prove such a state leak when paired with the pre-existing caller/assertion it breaks. It does not prove fulfillment of a production implementation requirement.',
  'Preserve invalid/empty-input fallbacks and observable fields outside the requested behavior change. For newly added static/global state, inspect behavior across successive calls and the whole existing suite, not only isolated tests with newly added reset hooks.',
  'A failing program-run existing test supports a deviation only when its assertion concerns behavior touched by the changed code. A launch failure, timeout or missing run is unavailable evidence, never a deviation.',
  'Entry points: review_checklist regressionEvidence on this item lists the changed hunks, pre-existing tests that reference changed identifiers and any program-run output. Pointers grant no proof.',
].join('\n') + '\n';
export const standingRegressionItem = ({ sha256: hash }) => ({ metricId: 'M16', text: STANDING_REGRESSION_TEXT,
  verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', programStanding: STANDING_REGRESSION,
  source: { kind: 'PROGRAM_STANDING', ref: 'runtime-corrector:standing-obligations', sha256: hash, start: 2, end: 2 } });
const LIMITS = { changes: 200, diffFiles: 60, fileDiffBytes: 4 * 1024 * 1024, evidenceDiffBytes: 64 * 1024, identifiers: 60,
  testFiles: 4000, testFileBytes: 512 * 1024, pointers: 12, lines: 16, cases: 8, originalTestBytes: 12 * 1024, digestFiles: 2000,
  verifierFiles: 32, verifierBytes: 256 * 1024 * 1024 };
const CODE = /\.(?:[cm]?[jt]sx?|ets|vue|svelte|py|java|kts?|scala|groovy|rs|go|c|cc|cpp|cxx|h|hh|hpp|cs|swift|mm?|rb|php|lua|dart|sh|ps1)$/iu;
const RUNTIME_MANIFESTS = new Set([
  'package.json', 'deno.json', 'deno.jsonc', 'pyproject.toml', 'setup.cfg', 'cargo.toml', 'go.mod', 'go.work',
  'pom.xml', 'build.gradle', 'settings.gradle', 'directory.build.props', 'directory.build.targets', 'gemfile',
  'composer.json', 'oh-package.json5', 'build-profile.json5', 'module.json5',
]);
const RUNTIME_SOURCE_EXTENSION = /\.(?:sql|csproj|fsproj|vbproj)$/iu;
export const isRegressionCodePath = file => CODE.test(file);
export const isRegressionSourcePath = file => isRegressionCodePath(file) || RUNTIME_SOURCE_EXTENSION.test(file)
  || RUNTIME_MANIFESTS.has(path.basename(file).toLowerCase());
const SKIPPED = new Set(['.git', 'node_modules', 'oh_modules', '.hvigor', '.preview', 'build', 'dist', 'target', 'vendor', 'coverage', OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY]);
const TEST_DIRECTORY = /^(?:tests?|__tests__|specs?|ohosTest|androidTest|unitTest|integrationTest|e2e)$/iu;
const TEST_FILE = /(?:^test_|[._-](?:test|spec)s?\.[^.]+$|(?:Tests?|Spec)\.(?:java|kts?|scala|groovy|cs|swift)$)/u;
const SUPPORT_DIRECTORY = /^(?:mocks?|__mocks__|fixtures?|__fixtures__|stubs?|fakes?|test-support)$/iu;
const SUPPORT_FILE = /(?:^|[._-])(?:mocks?|fixtures?|stubs?|fakes?)(?:[._-]|$)/iu;
const CASE = /\b(?:it|test|describe|xit|fit|specify)\s*\(\s*(['"`])((?:\\.|(?!\1|\\).)+)\1|^\s*(?:async\s+)?def\s+(test\w*)\s*\(|\b(?:void|fun|func)\s+(test\w*)\s*\(/iu;
const WORD = /[A-Za-z_$][\w$]*/gu;
const DECLARATION = /\b(?:function|class|interface|enum|struct|trait|def|fn|func|fun|type|const|let|var|val)\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^()]*\)\s*(?::\s*[^{=;]+)?\{/gu;
const COMMON = new Set(`this that then else return const final static public private protected readonly abstract override async await function
  class interface enum struct type typeof instanceof extends implements import export default from require module package namespace delete
  void null undefined true false none self super yield break continue switch case when match while each foreach loop throw throws catch
  finally raise except pass assert expect equal equals should test tests describe before after beforeeach aftereach beforeall afterall string
  number boolean bigint symbol object array record list dict tuple long float double char byte short bool unknown never promise resolve
  reject error errors value values result results data item items index length size count name names keys type types options option config
  state props param params args input output callback handler event events message console info warn debug print println printf format
  push shift slice splice concat join split trim filter find findindex indexof includes some every reduce foreach done mock mocks
  afterreturn afteraction assertequal asserttrue assertfalse tobe toequal`.split(/\s+/u).filter(Boolean));
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const fileKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const git = async (cwd, args, signal, maxBuffer = 16 * 1024 * 1024) => (await executeFile('git',
  ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args],
  { cwd, windowsHide: true, timeout: 30000, maxBuffer, signal })).stdout;
const stem = file => path.basename(file).replace(/(?:[._-](?:test|spec)s?)?\.[^.]+$/iu, '').replace(/^test_?|(?:Tests?|Spec)$/u, '').toLowerCase().replace(/[^a-z\d]/gu, '');
const testLocation = parts => parts.slice(0, -1).some(part => TEST_DIRECTORY.test(part)) || TEST_FILE.test(parts.at(-1));
const testPath = relative => { const parts = relative.split('/');
  return !parts.some(part => SKIPPED.has(part) || SUPPORT_DIRECTORY.test(part)) && isRegressionCodePath(relative)
    && testLocation(parts); };
const supportPath = relative => relative.split('/').some(part => SUPPORT_DIRECTORY.test(part)) || SUPPORT_FILE.test(path.basename(relative));
export function isTestEvidencePath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return testLocation(parts) || supportPath(normalized) || /(?:^test_|\.(?:test|spec)\.|_test\.)/iu.test(parts.at(-1));
}
const caseDeclarations = lines => lines.flatMap((line, index) => {
  const match = CASE.exec(line);
  return match ? [{ line: index + 1, title: match[2] ?? match[3] ?? match[4] }] : [];
});

const exists = async (projectRoot, ref, file, signal) => {
  try { await git(projectRoot, ['cat-file', '-e', `${ref}:./${file}`], signal); return true; }
  catch (error) { if (signal?.aborted) throw error; return false; }
};
const TASK_STATUS = { MODIFIED: 'modified', DELETED: 'deleted', ADDED: 'added', UNTRACKED: 'untracked' };

// The task-start change set is authoritative when it exists: it keeps changes
// the business already committed. HEAD and the working tree are the fallback.
async function changedFiles({ projectRoot, excluded = [], artifacts = [], signal, taskChanges = null }) {
  let top, output;
  const roots = [path.join(projectRoot, OUTPUT_TREE_DIRECTORY), path.join(projectRoot, POLICY_ROOT_DIRECTORY), ...excluded.map(file => path.resolve(file))];
  if (taskChanges) {
    const changes = [];
    for (const change of taskChanges.changes) {
      const file = path.resolve(projectRoot, change.path);
      if (!inside(projectRoot, file) || roots.some(root => inside(root, file))) continue;
      let status = TASK_STATUS[change.status];
      if (!status) {
        const before = taskChanges.startHead ? await exists(projectRoot, taskChanges.startHead, change.path, signal) : false;
        const after = await fs.access(file).then(() => true, () => false);
        status = before ? after ? 'modified' : 'deleted' : after ? 'added' : null;
      }
      if (status) changes.push({ path: change.path, status });
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  try {
    top = path.resolve((await git(projectRoot, ['rev-parse', '--show-toplevel'], signal)).trim());
    output = await git(projectRoot, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.',
      ...roots.filter(root => inside(projectRoot, root) && path.relative(projectRoot, root))
        .map(root => `:(exclude,literal)${path.relative(projectRoot, root).replaceAll('\\', '/')}`)], signal);
  } catch (error) { if (signal?.aborted) throw error; return null; }
  const changes = [];
  for (const entry of output.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2), file = path.resolve(top, entry.slice(3)), relative = path.relative(projectRoot, file).replaceAll('\\', '/');
    let artifact = null;
    try { artifact = matchConfiguredArtifact(relative, artifacts); } catch {}
    if (!relative || !inside(projectRoot, file) || artifact || roots.some(root => inside(root, file))
      || relative.split('/').some(part => [OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY].includes(part))) continue;
    changes.push({ path: relative, status: code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code[0] === 'A' ? 'added' : 'modified' });
  }
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function parseDiff(text) {
  const hunks = [], changed = [], context = [], removed = new Set();
  let oldLine = 0;
  for (const line of text.split(/\r?\n/u)) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      const newLine = Number(header[2]);
      const count = header[3] === undefined ? 1 : Number(header[3]);
      hunks.push([newLine, newLine + Math.max(count, 1) - 1]); context.push(header[4]); continue;
    }
    if (!hunks.length) continue;
    if (line.startsWith('+')) changed.push(line.slice(1));
    else if (line.startsWith('-')) { changed.push(line.slice(1)); removed.add(oldLine++); }
    else if (line.startsWith(' ')) oldLine++;
  }
  return { hunks, changed, context, removed };
}

function addNames(text, weight, names) {
  for (const [name] of text.matchAll(WORD))
    if (name.length >= 4 && !COMMON.has(name.toLowerCase())) names.set(name, Math.max(names.get(name) ?? 0, weight));
}

async function testPointers({ projectRoot, names, changes, removed, signal, active, base = 'HEAD' }) {
  if (!names.size && !removed.size) return { pointers: [], testFileCount: 0, originalTests: [] };
  let top, listed;
  try {
    top = path.resolve((await git(projectRoot, ['rev-parse', '--show-toplevel'], signal)).trim());
    listed = await git(projectRoot, ['ls-tree', '-r', '-z', '--name-only', '--full-name', base, '--', '.'], signal);
  } catch (error) { if (signal?.aborted) throw error; return { pointers: [], testFileCount: 0, originalTests: [], unavailable: true }; }
  const byPath = new Map(changes.map(change => [change.path, change]));
  const tests = listed.split('\0').filter(Boolean).map(file => path.relative(projectRoot, path.resolve(top, file)).replaceAll('\\', '/'))
    .filter(file => file && !file.startsWith('../') && testPath(file)).sort().slice(0, LIMITS.testFiles);
  const ids = [...names].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, LIMITS.identifiers).map(([name]) => name);
  const pattern = ids.length ? new RegExp(`(?<![\\w$])(?:${ids.map(name => name.replaceAll('$', '\\$')).join('|')})(?![\\w$])`, 'gu') : null;
  const stems = changes.filter(change => isRegressionCodePath(change.path) && !testPath(change.path)).map(change => stem(change.path)).filter(value => value.length >= 4);
  const scanned = [], frequency = new Map();
  for (const file of tests) {
    active();
    const modified = byPath.has(file), deletedLines = removed.get(file) ?? new Set();
    let text;
    try {
      const absolute = path.resolve(projectRoot, file);
      if (modified) text = await git(projectRoot, ['show', `${base}:./${file}`], signal, LIMITS.testFileBytes);
      else {
        if ((await fs.stat(absolute)).size > LIMITS.testFileBytes) continue;
        text = await fs.readFile(absolute, 'utf8');
      }
    } catch (error) { if (signal?.aborted) throw error; continue; }
    const lines = text.split(/\r?\n/u), hits = new Map();
    for (const [index, line] of lines.entries()) for (const [name] of pattern ? line.matchAll(pattern) : []) {
      if (!hits.has(name)) hits.set(name, new Set());
      hits.get(name).add(index + 1);
    }
    if (!hits.size && !deletedLines.size) continue;
    for (const name of hits.keys()) frequency.set(name, (frequency.get(name) ?? 0) + 1);
    scanned.push({ file, lines, hits, modified, deletedLines });
  }
  const rarity = name => names.get(name) / frequency.get(name);
  const ranked = scanned.map(entry => {
    const testStem = stem(entry.file);
    const similar = testStem.length >= 4 && stems.some(value => value.includes(testStem) || testStem.includes(value));
    return { ...entry, score: [...entry.hits.keys()].reduce((total, name) => total + rarity(name), 0) + (entry.modified ? 2 : 0) + (similar ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1)).slice(0, LIMITS.pointers);
  const originalTests = [];
  let originalBytes = 0;
  const pointers = ranked.map(({ file, lines, hits, modified, deletedLines }) => {
    const identifiers = [...hits.keys()].sort((a, b) => rarity(b) - rarity(a) || (a < b ? -1 : 1));
    const lineScore = new Map();
    for (const [name, numbers] of hits) for (const line of numbers) lineScore.set(line, (lineScore.get(line) ?? 0) + rarity(name) / numbers.size);
    const caseLines = caseDeclarations(lines).map(value => ({ ...value, title: value.title.slice(0, 120) }));
    const caseScore = new Map();
    for (const [line, score] of lineScore) {
      const owner = caseLines.findLast(value => value.line <= line);
      if (owner) caseScore.set(owner, (caseScore.get(owner) ?? 0) + score);
    }
    for (const line of deletedLines) {
      if (!lines[line - 1]?.trim()) continue;
      const owner = caseLines.findLast(value => value.line <= line);
      if (owner) caseScore.set(owner, (caseScore.get(owner) ?? 0) + 1);
    }
    const boundary = value => /\b(?:invalid|empty|missing|unsupported|fallback|unknown|restore|cleanup)\b/iu.test(value.title);
    for (const value of caseLines) if (boundary(value) && !caseScore.has(value)) caseScore.set(value, 0);
    const cases = [...caseScore].sort((a, b) => Number(boundary(b[0])) - Number(boundary(a[0])) || b[1] - a[1] || a[0].line - b[0].line)
      .slice(0, LIMITS.cases).map(([value]) => value);
    if (modified) for (const { line, title } of cases) {
      const end = (caseLines.find(value => value.line > line)?.line ?? lines.length + 1) - 1;
      const body = lines.slice(line - 1, end).map((text, index) => `${line + index}: ${text}`).join('\n');
      const bytes = Buffer.byteLength(body);
      if (bytes + originalBytes <= LIMITS.originalTestBytes) {
        originalTests.push({ path: file, title, line, end, body }); originalBytes += bytes;
      }
    }
    return { path: file, ...(modified ? { modifiedByTask: true } : {}), identifiers: identifiers.slice(0, 8),
      lines: [...lineScore].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, LIMITS.lines).map(([line]) => line).sort((a, b) => a - b),
      cases };
  });
  return { pointers, testFileCount: tests.length, originalTests };
}

/** Program-owned entry points for the standing regression item. */
export async function collectRegressionEvidence({ projectRoot, excluded = [], artifacts = [], signal, active = () => {}, taskChanges = null }) {
  const base = taskChanges?.startHead ?? 'HEAD';
  const all = await changedFiles({ projectRoot, excluded, artifacts, signal, taskChanges });
  active();
  if (!all) return { available: false, triggered: false, changes: [], testPointers: [] };
  if (!all.some(change => isRegressionSourcePath(change.path) && ['modified', 'deleted'].includes(change.status)))
    return { available: true, triggered: false, changes: all.slice(0, LIMITS.changes), testPointers: [] };
  const names = new Map(), changes = [], diffs = [], removed = new Map();
  let diffBytes = 0, diffFiles = 0;
  for (const change of all.slice(0, LIMITS.changes)) {
    active();
    const record = { ...change, code: isRegressionSourcePath(change.path), hunks: null };
    changes.push(record);
    if (!record.code || change.status === 'untracked' || diffFiles >= LIMITS.diffFiles) continue;
    diffFiles++;
    let text = null;
    try { text = await git(projectRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', base, '--', path.resolve(projectRoot, change.path)], signal, LIMITS.fileDiffBytes); }
    catch (error) { if (signal?.aborted) throw error; }
    if (!text) continue;
    const parsed = parseDiff(text);
    record.hunks = parsed.hunks;
    if (testPath(change.path)) {
      if (parsed.removed.size) removed.set(change.path, parsed.removed);
    } else if (change.status !== 'added') {
      for (const line of parsed.context) addNames(line, 2, names);
      for (const line of parsed.changed) {
        for (const match of line.matchAll(DECLARATION)) addNames(match[1] ?? match[2], 2, names);
        addNames(line, 1, names);
      }
      if (change.status === 'deleted') addNames(path.basename(change.path).replace(/\..*$/u, ''), 2, names);
    }
    const bytes = Buffer.byteLength(text);
    if (diffBytes + bytes <= LIMITS.evidenceDiffBytes) { diffs.push(text.replace(/\s+$/u, '')); diffBytes += bytes; }
    else diffs.push(`(diff of ${change.path} omitted: ${bytes} bytes beyond the evidence budget; use review_changes path=${change.path})`);
  }
  const { pointers, testFileCount, originalTests, unavailable } = await testPointers({ projectRoot, names, changes, removed, signal, active, base });
  return { available: true, triggered: true, base: taskChanges ? 'TASK_START' : 'HEAD', baseCommit: base, changes, changeCount: all.length, diffs,
    testPointers: pointers, testFileCount, originalTests, ...(unavailable ? { testIndexUnavailable: true } : {}) };
}

export function renderRegressionEvidence(evidence) {
  const code = evidence.changes.filter(change => change.code);
  return [
    'Runtime Corrector regression evidence for the standing REGRESSION checklist item. Program-owned navigation: it grants no PASS and is not a requirement.',
    evidence.base === 'TASK_START'
      ? `Base: the current working tree against the task-start commit ${evidence.baseCommit} (including commits made during the task) plus untracked files. Runtime Corrector private paths and configured workflow artifacts are excluded.`
      : 'Base: the current working tree against Git HEAD plus untracked files. Runtime Corrector private paths and configured workflow artifacts are excluded.',
    `Changed source files (${code.length} of ${evidence.changeCount} changed paths):`,
    ...code.map(change => `  ${change.status} ${change.path}${change.hunks?.length ? `  hunks(new lines): ${change.hunks.map(([start, end]) => `${start}-${end}`).join(', ')}` : ''}`),
    `Pre-existing tests at ${evidence.base === 'TASK_START' ? 'the task start' : 'HEAD'} that reference changed identifiers (${evidence.testPointers.length} listed of ${evidence.testFileCount} test files${evidence.testIndexUnavailable ? '; test index unavailable' : ''}):`,
    ...evidence.testPointers.flatMap(pointer => [`  ${pointer.path}${pointer.modifiedByTask ? '  (task-start line numbers; changed or deleted by this task)' : ''}`,
      `    identifiers: ${pointer.identifiers.join(', ')}`, `    lines: ${pointer.lines.join(', ')}`,
      ...[...pointer.cases].sort((a, b) => a.line - b.line).map(value => `    L${value.line}: ${value.title}`)]),
    ...(evidence.originalTests?.length ? ['Task-start public test excerpts for edited or deleted suites. Cite the excerpt here for original assertions; use the changed production source to test whether each effect survives.',
      ...evidence.originalTests.flatMap(test => [`--- ${test.path}:${test.line}-${test.end} (${test.title}) ---`, test.body])] : []),
    `Changed hunks (git diff ${evidence.base === 'TASK_START' ? evidence.baseCommit : 'HEAD'}; removed lines show the pre-existing code):`,
    ...evidence.diffs,
  ].join('\n') + '\n';
}

const runSummary = (run, files) => run.requirementOnly
  ? `Program-run requirement probe: ${run.requirementCheck?.status ?? 'INCOMPLETE'}; record at ${files[0] ?? 'unavailable'}`
  : ['PASSED', 'FAILED'].includes(run.status)
  ? `Program-run existing tests: exit ${run.exitCode}${run.cached ? ' (cached for this unchanged workspace)' : ''}; output at ${files[0] ?? 'unavailable'}`
  : `Program-run existing tests unavailable (${run.reason ?? run.status}); this is not evidence of a deviation. Record at ${files[0] ?? 'unavailable'}`;

function readMachineInventory(run) {
  const reports = protocolRecords(run, /^RC_REGRESSION_INVENTORY[ \t]+([^\r\n]*)/gmu);
  if (!reports) return { complete: false, failures: [] };
  if (!reports.length) return null;
  if (reports.length !== 1) return { complete: false, failures: [] };
  let inventory;
  try { inventory = JSON.parse(reports[0][1]); } catch { return { complete: false, failures: [] }; }
  const failures = inventory?.failures;
  if (inventory?.complete !== true || !Array.isArray(failures)
    || failures.some(item => typeof item?.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title)
    || new Set(failures.map(item => item.id)).size !== failures.length) return { complete: false, failures: [] };
  return { complete: true, failures, executedTests: inventory.executedTests };
}

export function regressionFailureInventory(run) {
  if ((run.reportProtocol || run.separateRequirement) && run.status === 'UNAVAILABLE') return { complete: false, failures: [] };
  const strict = protocolOutputs(run);
  const machine = strict ? readMachineInventory(run) : null;
  if (machine) {
    if (!machine.complete) return machine;
    const excluded = run.triage?.cases.filter(item => item.type === 'PRE_EXISTING_FAILURE').map(item => item.id);
    return { complete: true, failures: machine.failures.filter(item => !excluded?.includes(item.id)), ...(excluded ? { excluded } : {}) };
  }
  if (!strict && (run.reportProtocol || run.separateRequirement)) return { complete: false, failures: [] };
  const outputs = protocolOutputs(run, { allowTruncated: true });
  if (!outputs || !strict && outputs.some(output => /^RC_REGRESSION_INVENTORY[ \t]+/mu.test(output)))
    return { complete: false, failures: [] };
  // The legacy flat-TAP/native-failure adapter deliberately supports bounded
  // tails. Keep that behavior within one original channel; never combine its
  // failure names/count with another channel or override strict protocol gates.
  const candidates = outputs.filter(output => /^(?:RC_REGRESSION_CHECK[ \t]+|[ \t]*not ok \d+ - |# fail \d+)/mu.test(output));
  return candidates.length === 1 ? legacyFailureInventory(run, candidates[0]) : { complete: false, failures: [] };
}

function legacyFailureInventory(run, output) {
  const reports = [...output.matchAll(/^RC_REGRESSION_CHECK[ \t]+(\S+)([^\r\n]*)/gmu)];
  let expected, failures = [];
  if (reports.length) {
    if (reports.length === 1 && reports[0][1] === 'FAIL') {
      const [report, , summary] = reports[0];
      const count = name => Number(new RegExp(`\\b${name}=(\\d+)(?=\\s|$)`, 'u').exec(summary)?.[1]);
      expected = summary.includes('regressions=') || summary.includes('newFailures=')
        ? count('regressions') + count('newFailures') : count('failed');
      failures = [...output.slice(reports[0].index + report.length).matchAll(/^- (?:FAIL|ERROR) (.+)$/gmu)]
        .map(([, value]) => {
          const id = value.trim();
          return { id, title: id.replace(/^[^:]+::[^:]+::/u, '') };
        });
      for (const [, diagnostic] of output.matchAll(/^\s+public assertion: Error in ([^\r\n]+)$/gmu)) {
        const cases = failures.filter(({ title }) => diagnostic.startsWith(title + ', '));
        if (cases.length === 1) (cases[0].observedDiagnostics ??= []).push(diagnostic.slice(cases[0].title.length + 2));
      }
    }
  } else {
    const counts = [...output.matchAll(/^# fail (\d+)[ \t]*$/gmu)];
    // A flat TAP report names each failing test. Nested suite failures can
    // include both a parent and a child, so a matching count is insufficient.
    if (counts.length === 1 && !/^[ \t]+not ok \d+ - /mu.test(output)) expected = Number(counts[0][1]);
    failures = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(([, title]) => title.trim())
      .filter(title => !/\s+#\s*(?:TODO|SKIP)\b/iu.test(title)).map(title => ({ id: title, title }));
  }
  const complete = run.status === 'FAILED' && Number.isSafeInteger(expected) && expected > 0
    && failures.length === expected && failures.every(({ id, title }) => id && title)
    && new Set(failures.map(({ id }) => id)).size === failures.length;
  if (complete && run.triage) {
    const excluded = new Set(run.triage.cases.filter(item => item.type === 'PRE_EXISTING_FAILURE').map(item => item.id));
    return { complete, failures: failures.filter(item => !excluded.has(item.id)), excluded: [...excluded] };
  }
  return { complete, failures };
}

/** Resolve a report case against the task-start commit, independently of ranked test pointers. */
export async function collectRegressionFailureTests({ projectRoot, start, failures, signal }) {
  const base = start?.head;
  const tests = new Map();
  if (start?.complete !== true || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/u.test(base ?? '')
    || Object.keys(start.entries ?? {}).some(file => testPath(file) && !supportPath(file))) return tests;
  const titles = new Set(failures.map(({ title }) => title));
  const matches = new Map();
  let listed;
  try {
    listed = await git(projectRoot, ['grep', '-F', '-l', '-z', ...[...titles].flatMap(title => ['-e', title]), base, '--', '.'], signal);
  } catch (error) { if (signal?.aborted) throw error; return tests; }
  for (const name of listed.split('\0').filter(Boolean)) {
    const file = name.slice(base.length + 1);
    if (!testPath(file) || supportPath(file)) continue;
    let source;
    try { source = await git(projectRoot, ['show', `${base}:./${file}`], signal, LIMITS.testFileBytes); }
    catch (error) { if (signal?.aborted) throw error; return tests; }
    const lines = source.split(/\r?\n/u), cases = caseDeclarations(lines);
    for (const [index, { title, line }] of cases.entries()) {
      if (!titles.has(title)) continue;
      const end = (cases[index + 1]?.line ?? lines.length + 1) - 1;
      const body = lines.slice(line - 1, end).join('\n');
      matches.set(title, matches.has(title) ? null : { path: file, line, end, body });
    }
  }
  for (const { id, title } of failures) {
    const match = matches.get(title);
    if (match && Buffer.byteLength(match.body) <= LIMITS.originalTestBytes) tests.set(id, match);
  }
  return tests;
}

export async function readRegressionOriginalFiles({ projectRoot, baseCommit, paths, signal }) {
  if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/u.test(baseCommit ?? '')) return [];
  const originals = [];
  const relativePaths = paths.map(file => path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/'));
  for (const file of new Set(relativePaths)) {
    if (!inside(projectRoot, path.resolve(projectRoot, file))) continue;
    try { originals.push({ path: file, source: await git(projectRoot, ['show', `${baseCommit}:./${file}`], signal) }); }
    catch (error) {
      signal?.throwIfAborted();
      originals.push({ path: file, unavailable: true });
    }
  }
  return originals;
}

function regressionTestSource(run) {
  if (run?.requirementOnly) return { mode: 'NOT_APPLICABLE', currentTestEditsExecuted: null };
  if (run?.testSource === 'task-start') return { mode: 'TASK_START_PUBLIC_TESTS', currentTestEditsExecuted: false };
  if (run?.testSource === 'current') return { mode: 'CURRENT_PUBLIC_TESTS', currentTestEditsExecuted: true };
  return { mode: 'CONFIGURED_COMMAND', currentTestEditsExecuted: null };
}

export function regressionNavigation({ evidence, files = [], run = null, runFiles = [], failureInventory = null }) {
  const code = evidence.changes.filter(change => change.code);
  return { navigationOnly: true, evidenceFiles: files,
    changedFiles: code.slice(0, 8).map(({ path: file, status }) => ({ path: file, status })), changedFileCount: code.length,
    testPointers: evidence.testPointers.slice(0, 6).map(pointer => ({ path: pointer.path, ...(pointer.modifiedByTask ? { modifiedByTask: true } : {}),
      identifiers: pointer.identifiers.slice(0, 4), cases: pointer.cases.slice(0, 4).map(value => `L${value.line} ${value.title}`) })),
    testPointerCount: evidence.testPointers.length,
    programRun: run ? { status: run.status, exitCode: run.exitCode ?? null, timedOut: run.timedOut === true, durationMs: run.durationMs ?? 0,
      ...(run.cached ? { cached: true } : {}), testSource: regressionTestSource(run), files: runFiles, summary: runSummary(run, runFiles),
      ...(failureInventory ? { failureInventory } : {}) }
      : { status: 'NOT_RUN', summary: 'No program-run existing-test check ran for this Stop.' },
    instruction: 'Read the changed hunks and the listed pre-existing tests or callers with source_read. For DEVIATION cite both the pre-existing assertion or caller dependency and the changed code that contradicts it. Pointers grant no proof.' };
}

/** Structural floor for a standing-regression deviation; semantics stay with the reviewer. */
export function regressionDeviationProblem({ projectRoot, evidence, citations, evidenceFiles = [], run = null, runFiles = [], productionOnly = false }) {
  const changes = new Map(evidence.changes.map(change => [fileKey(path.resolve(projectRoot, change.path)), change]));
  const overlaps = (citation, ranges) => ranges.some(([start, end]) => citation.start <= end && start <= citation.end);
  if (productionOnly && citations.some(citation => {
    if (citation.readProof?.owner !== 'SOURCE') return false;
    const relative = path.relative(projectRoot, citation.path).replaceAll('\\', '/');
    return isTestEvidencePath(relative);
  })) return 'Test and mock source cannot certify an explained change to production behavior.';
  const changedCode = citations.filter(citation => {
    const change = changes.get(fileKey(citation.path));
    if (citation.readProof?.owner !== 'SOURCE' || !change?.code || change.status === 'deleted') return false;
    if (change.hunks) return overlaps(citation, change.hunks);
    return !productionOnly || change.status === 'added' || change.status === 'untracked';
  });
  const program = new Set([...evidenceFiles, ...(run?.status === 'FAILED' ? runFiles : [])].map(fileKey));
  const existing = citations.some(citation => {
    if (program.has(fileKey(citation.path))) return true;
    if (!['SOURCE', 'ARTIFACT'].includes(citation.readProof?.owner) || !inside(projectRoot, citation.path)) return false;
    const change = changes.get(fileKey(citation.path));
    return !change || Boolean(change.hunks) && !overlaps(citation, change.hunks);
  });
  if (!changedCode.length) return 'Cite the changed code that contradicts the pre-existing behavior: source_read the changed lines of a file in regressionEvidence.changedFiles.';
  if (!existing) return 'Cite the pre-existing behavior it breaks: source_read a pre-existing test assertion or caller (regressionEvidence.testPointers), the removed lines in regressionEvidence.evidenceFiles, or a failing program-run existing test. A passing, timed-out or unlaunched run is not counterevidence.';
  return null;
}

function clippedTail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

const decodeTail = buffer => clippedTail(buffer).toString('utf8');
const isUtf8 = buffer => {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return true; }
  catch { return false; }
};

function readRunnerRoute(names) {
  if (!names?.length) return null;
  return names.map(name => {
    const value = process.env[name];
    return [name, typeof value === 'string' ? value : null];
  });
}

function fingerprintRunnerRoute(environment) {
  return environment?.some(([, value]) => value !== null) ? sha256(environment) : undefined;
}

function runCommand(argv, { cwd, timeoutMs, maxOutputBytes, signal, routeSnapshot }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let child, timer, drain, tail = Buffer.alloc(0), outputBytes = 0, settled = false, stopping = false, closed;
    const streams = { stdout: { bytes: 0 }, stderr: { bytes: 0 } };
    let tailOwners = Buffer.alloc(0);
    const exited = new Promise(resolve => { closed = resolve; });
    const finish = extra => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drain); signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      const counts = { stdout: 0, stderr: 0 };
      for (const owner of tailOwners) counts[owner === 0 ? 'stdout' : 'stderr']++;
      const captured = { stdout: Buffer.allocUnsafe(counts.stdout), stderr: Buffer.allocUnsafe(counts.stderr) };
      const offsets = { stdout: 0, stderr: 0 };
      for (let index = 0; index < tail.length; index++) {
        const name = tailOwners[index] === 0 ? 'stdout' : 'stderr';
        captured[name][offsets[name]++] = tail[index];
      }
      resolve({ exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - startedAt, outputBytes, maxOutputBytes,
        truncated: outputBytes > tail.length, outputTail: decodeTail(tail), outputStreamPolicy: OUTPUT_STREAM_POLICY,
        outputStreams: Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, {
          outputBytes: stream.bytes, truncated: stream.bytes > captured[name].length, outputTail: decodeTail(captured[name]),
          complete: child?.[name]?.readableEnded === true,
          // Only a clipped leading codepoint may be omitted from a retained
          // bounded tail. Malformed interior bytes never become replacement-ID proof.
          utf8Valid: isUtf8(stream.bytes > captured[name].length ? clippedTail(captured[name]) : captured[name]),
        }])), ...extra });
    };
    const kill = () => new Promise(done => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return done();
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } return done(); }
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); done(); }); killer.once('exit', () => done());
    });
    // A stopped tree must release the workspace before its evidence is read.
    const stop = async extra => {
      if (stopping || settled) return; stopping = true; clearTimeout(drain);
      await kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]); finish(extra);
    };
    const cancel = () => { void stop({ reason: 'CANCELLED' }); };
    const output = (name, chunk) => {
      outputBytes += chunk.length; tail = Buffer.concat([tail, chunk]);
      if (tail.length > maxOutputBytes) tail = tail.subarray(tail.length - maxOutputBytes);
      const stream = streams[name]; stream.bytes += chunk.length;
      // One retained byte window, with one bounded ownership byte per byte.
      // Projecting its two channels never gives them separate output budgets
      // and needs no unbounded list of alternating stdout/stderr frames.
      tailOwners = Buffer.concat([tailOwners, Buffer.alloc(chunk.length, name === 'stdout' ? 0 : 1)]);
      if (tailOwners.length > maxOutputBytes) tailOwners = tailOwners.subarray(tailOwners.length - maxOutputBytes);
    };
    const env = Object.assign(Object.create(null), process.env);
    // Windows treats environment keys case-insensitively, including in spawn.
    if (routeSnapshot && process.platform === 'win32') {
      const names = new Set(routeSnapshot.map(([name]) => name.toUpperCase()));
      for (const key of Object.keys(env)) if (names.has(key.toUpperCase())) delete env[key];
    }
    for (const [key, value] of routeSnapshot ?? []) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    env.RC_REGRESSION_DEADLINE_AT = String(startedAt + timeoutMs);
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ reason: 'LAUNCH_FAILED', launchError: String(error.code ?? error.message).slice(0, 200) }); return; }
    timer = setTimeout(() => { void stop({ timedOut: true, reason: 'TIMEOUT' }); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => output('stdout', chunk)); child.stderr.on('data', chunk => output('stderr', chunk));
    child.once('error', error => { closed(); if (!stopping) finish({ reason: 'LAUNCH_FAILED', launchError: String(error.code ?? error.message).slice(0, 200) }); });
    child.once('exit', (code, name) => {
      if (!stopping) drain = setTimeout(() => finish({ exitCode: code, signal: name, outputComplete: false }), 2000);
    });
    child.once('close', (code, name) => { closed(); if (!stopping) finish({ exitCode: code, signal: name }); });
    if (signal?.aborted) cancel();
  });
}

const sameFileState = (left, right) => ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs']
  .every(key => left[key] === right[key]);

async function verifierFileState(file) {
  const resolved = await fs.realpath(file).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
  if (!resolved) return { resolved, stat: null };
  const stat = await fs.lstat(resolved);
  return { resolved, stat: stat.isFile() ? stat : null };
}

const sameVerifierFileState = (left, right) => left.resolved === right.resolved
  && (left.stat && right.stat ? sameFileState(left.stat, right.stat) : left.stat === right.stat);

let hostExecutableFingerprint;

async function verifierFileDigest(file, state, signal) {
  const hostExecutable = file === path.resolve(process.execPath);
  // Reuse the host interpreter hash while its file identity stays stable.
  if (hostExecutable && hostExecutableFingerprint && sameVerifierFileState(state, hostExecutableFingerprint.state))
    return hostExecutableFingerprint.digest;
  const handle = await fs.open(state.resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFileState(state.stat, await handle.stat())) return null;
    const hash = createHash('sha256');
    const { size } = state.stat;
    let bytes = 0;
    if (size) {
      for await (const chunk of handle.createReadStream({ autoClose: false, end: size - 1, signal })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
    }
    if (bytes !== size || !sameVerifierFileState(state, await verifierFileState(file))) return null;
    const digest = hash.digest('hex');
    if (hostExecutable) hostExecutableFingerprint = { state, digest };
    return digest;
  } finally { await handle.close(); }
}

async function fingerprintVerifierFiles(cwd, argv, signal) {
  const files = [...new Set(argv.filter(file => path.isAbsolute(file)).map(file => path.resolve(cwd, file)))];
  if (files.length > LIMITS.verifierFiles) return null;
  let remainingBytes = LIMITS.verifierBytes;
  const snapshots = [];
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const state = await verifierFileState(file);
      let digest = null;
      if (state.stat) {
        const { size } = state.stat;
        if (size > remainingBytes) return null;
        remainingBytes -= size;
        digest = await verifierFileDigest(file, state, signal);
        if (digest === null) return null;
      }
      snapshots.push({ file, state, digest });
    }
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  return snapshots;
}

async function verifierFilesUnchanged(snapshots, signal) {
  if (!snapshots) return false;
  try {
    const unchanged = await Promise.all(snapshots.map(async ({ file, state }) =>
      sameVerifierFileState(state, await verifierFileState(file))));
    signal?.throwIfAborted();
    return unchanged.every(Boolean);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function changedFileSnapshot(root, { path: relative, status }, signal) {
  const file = path.resolve(root, relative);
  const initial = await fs.lstat(file).catch(error => {
    if (status === 'deleted' && ['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
  if (!initial) return [relative, status, null];
  if (!initial.isFile()) return null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFileState(initial, await handle.stat())) return null;
    const bytes = await handle.readFile({ signal });
    const current = await fs.lstat(file);
    return sameFileState(initial, current) ? [relative, status, current.mode, sha256(bytes)] : null;
  } finally { await handle.close(); }
}

async function workspaceDigest(projectRoot, excluded, signal) {
  const changes = await changedFiles({ projectRoot, excluded, signal });
  if (!changes || changes.length > LIMITS.digestFiles) return null;
  let head;
  try { head = (await git(projectRoot, ['rev-parse', '--verify', 'HEAD'], signal)).trim(); }
  catch { signal?.throwIfAborted(); return null; }
  const files = [];
  for (const change of changes) {
    const snapshot = await changedFileSnapshot(projectRoot, change, signal).catch(() => null);
    signal?.throwIfAborted();
    if (!snapshot) return null;
    files.push(snapshot);
  }
  return sha256({ version: 2, head, files });
}

export function requirementExpectation(argv) {
  const values = flag => argv.filter(value => value.startsWith(flag)).map(value => value.slice(flag.length));
  const hashes = values('--requirement-probe-sha256=');
  const ids = values('--requirement-test=');
  return hashes.length === 1 && /^[a-f0-9]{64}$/u.test(hashes[0]) && ids.length > 0
    && ids.every(id => id && !/[\r\n\0]/u.test(id)) && new Set(ids).size === ids.length
    ? { sha256: hashes[0], ids } : null;
}

function incompleteRequirementProbe(expected, reason) {
  return { sha256: expected.sha256, checks: [], status: 'INCOMPLETE', reason };
}

function readRequirementProbe(run, expected, digest, requirementOnly) {
  const missing = reason => incompleteRequirementProbe(expected, reason);
  if (!run || run.reason || run.signal || ![0, 1, 2].includes(run.exitCode) || run.truncated || run.outputComplete === false || typeof run.outputTail !== 'string')
    return missing('REQUIREMENT_PROBE_OUTPUT_UNAVAILABLE');
  const records = protocolRecords(run, /^RC_REQUIREMENT_PROBE (.+)$/gmu);
  if (!records) return missing('REQUIREMENT_PROBE_OUTPUT_UNAVAILABLE');
  if (records.length !== 1) return missing('REQUIREMENT_PROBE_RECEIPT_MISSING_OR_AMBIGUOUS');
  let receipt;
  try { receipt = JSON.parse(records[0][1]); } catch { return missing('REQUIREMENT_PROBE_RECEIPT_INVALID'); }
  if (receipt?.sha256 !== expected.sha256 || !Array.isArray(receipt.checks)) return missing('REQUIREMENT_PROBE_RECEIPT_INVALID');
  const snapshotSha256 = receipt.snapshotSha256;
  if (Object.hasOwn(receipt, 'snapshotSha256') && (typeof snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshotSha256)))
    return missing('REQUIREMENT_PROBE_RECEIPT_INVALID');
  if (receipt.status === 'INCOMPLETE') return missing('REQUIREMENT_PROBE_RUNTIME_INCOMPLETE');
  const byId = new Map(receipt.checks.map(check => [check?.id, check?.status]));
  if (receipt.checks.length !== expected.ids.length || byId.size !== expected.ids.length
    || expected.ids.some(id => !['PASS', 'FAIL'].includes(byId.get(id)))) return missing('REQUIREMENT_PROBE_CASES_UNVERIFIED');
  const checks = expected.ids.map(id => ({ id, status: byId.get(id) }));
  const status = checks.some(check => check.status === 'FAIL') ? 'FAIL' : 'PASS';
  if (status !== receipt.status) return missing('REQUIREMENT_PROBE_RECEIPT_INVALID');
  if (requirementOnly && run.exitCode !== (status === 'FAIL' ? 1 : 0))
    return missing('REQUIREMENT_PROBE_EXIT_MISMATCH');
  return { sha256: expected.sha256, checks, status, workspaceDigest: digest, ...(snapshotSha256 ? { snapshotSha256 } : {}) };
}

function completedSuiteStatus(run) {
  if (run.signal || run.truncated || run.outputComplete === false) return null;
  const inventory = readMachineInventory(run);
  if (!inventory?.complete || !Number.isSafeInteger(inventory.executedTests) || inventory.executedTests < 1
    || inventory.failures.length > inventory.executedTests) return null;
  if (inventory.failures.length) return run.exitCode === 1 ? 'FAILED' : null;
  return run.exitCode === 0 ? 'PASSED' : null;
}

const unrunCheck = reason => ({ exitCode:null, signal:null, timedOut:false, durationMs:0, outputBytes:0, truncated:false, outputTail:'', reason });

/** Runs the checks applicable to the frozen Stop scope. */
export async function runStopRegressionCheck({ projectRoot, config, population, classification, deadlineAt = Infinity, signal, cacheDirectory = null, excluded = [], now = Date.now, deferIsolation = false }) {
  if (config?.enabled !== true) return null;
  const regressionApplicable = Object.values(population?.metrics ?? {}).flat().some(object => object.programStanding === STANDING_REGRESSION);
  const expectation = classification?.stopClassification === 'TASK_COMPLETE' ? requirementExpectation(config.command) : null;
  const splitVerifier = config.verifierProtocol === 'split-requirement-v1';
  if (splitVerifier && config.command.some(arg => arg === '--requirement-only' || arg === '--regression-only'))
    throw new Error('Stop selects --requirement-only and --regression-only from its frozen scope.');
  if (!regressionApplicable && !expectation) return null;
  const requirementOnly = splitVerifier && !regressionApplicable && Boolean(expectation);
  const separateRequirement = splitVerifier && regressionApplicable && Boolean(expectation);
  const pinnedProbe = requirementOnly || separateRequirement;
  signal?.throwIfAborted();
  const routeEnvironment = config.routeEnvironment && [...config.routeEnvironment];
  const routeSnapshot = readRunnerRoute(routeEnvironment);
  const routeSha256 = fingerprintRunnerRoute(routeSnapshot);
  const sameRoute = () => !routeSnapshot || fingerprintRunnerRoute(readRunnerRoute(routeEnvironment)) === routeSha256;
  const root = await fs.realpath(projectRoot);
  const cwd = path.resolve(root, config.cwd);
  const probeFlags = pinnedProbe ? config.command.filter(arg => arg.startsWith('--requirement-probe=')) : [];
  const probe = probeFlags.length === 1 && probeFlags[0].slice('--requirement-probe='.length);
  const sameProbe = async () => {
    if (!pinnedProbe) return true;
    if (!probe) return false;
    const bytes = await fs.readFile(path.resolve(cwd, probe), { signal }).catch(() => null);
    signal?.throwIfAborted();
    return bytes && sha256(bytes) === expectation.sha256;
  };
  const baselinePath = !requirementOnly && config.baselineFile && path.resolve(root, config.baselineFile);
  let baseline, baselineSha256;
  if (baselinePath) {
    try {
      const bytes = await fs.readFile(baselinePath);
      baseline = JSON.parse(bytes);
      baselineSha256 = sha256(bytes);
    } catch (error) {
      if (!separateRequirement) throw error;
    }
  }
  const baselineAvailable = !baselinePath || Boolean(baselineSha256);
  const identity = { triageVersion: REGRESSION_TRIAGE_VERSION, outcomePolicy: 'native-incomplete-unavailable-v1',
    outputStreamPolicy: OUTPUT_STREAM_POLICY,
    command: [...config.command, ...(requirementOnly ? ['--requirement-only'] : [])], cwd: config.cwd, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes,
    ...(requirementOnly ? { requirementOnly: true } : {}),
    ...(separateRequirement ? { separateRequirement: true, regressionOutputPolicy: 'complete-inventory-v1' } : {}),
    ...(config.reportProtocol ? { reportProtocol: config.reportProtocol } : {}),
    ...(config.verifierProtocol ? { verifierProtocol: config.verifierProtocol } : {}),
    ...(config.collateralProtocol ? { collateralProtocol: config.collateralProtocol } : {}),
    ...(config.testSource ? { testSource: config.testSource } : {}),
    ...(routeEnvironment ? { routeEnvironment } : {}),
    ...(deferIsolation ? { isolationPolicy: 'CONTROLLED_WHOLE_SUITE_AFTER_REVIEW' } : {}),
    ...(baselineSha256 ? { baselineFile: baselinePath, baselineSha256 } : {}),
    ...(config.isolationCommand ? { isolationCommand: [...config.isolationCommand] } : {}),
    ...(routeSha256 ? { runnerRouteSha256: routeSha256 } : {}),
    ...(expectation ? { requirementProbePolicy: 'public-requirement-probe-v1' } : {}),
    ...(!regressionApplicable ? { regressionApplicable: false } : {}) };
  const budgetStartedAt = now();
  const budget = Math.min(config.timeoutMs, Math.floor((deadlineAt - budgetStartedAt) / 2));
  const budgetEndsAt = budgetStartedAt + budget;
  const remainingBudget = () => Math.max(0, Math.floor(budgetEndsAt - now()));
  const unavailable = reason => ({ kind: 'runtime-corrector.regression-check.v1', ...identity,
    status: requirementOnly ? 'NOT_APPLICABLE' : 'UNAVAILABLE', ...unrunCheck(reason),
    ...(expectation ? { requirementCheck: incompleteRequirementProbe(expectation, reason) } : {}) });
  if (!(budget >= 1000)) return unavailable('STOP_DEADLINE');
  const digest = await workspaceDigest(root, excluded, signal);
  if (requirementOnly && !digest) return unavailable('REQUIREMENT_PROBE_WORKSPACE_UNVERIFIED');
  if (config.reportProtocol && !digest) return unavailable('REGRESSION_WORKSPACE_UNVERIFIED');
  const validProbe = await sameProbe();
  if (requirementOnly && !validProbe) return unavailable('REQUIREMENT_PROBE_SHA_MISMATCH');
  const verifierFiles = digest && cacheDirectory ? await fingerprintVerifierFiles(cwd, [
    ...config.command, ...(regressionApplicable && !deferIsolation ? config.isolationCommand ?? [] : []),
  ], signal) : [];
  if (verifierFiles?.length) identity.verifierInputsSha256 = sha256(verifierFiles.map(({ file, state, digest }) =>
    [file, state.resolved, state.stat?.mode ?? null, digest]));
  const key = digest && sha256({ ...identity, digest });
  const cacheFile = key && cacheDirectory && verifierFiles ? path.join(cacheDirectory, `${key}.json`) : null;
  const cached = cacheFile ? await outsideDecision(() => readJson(cacheFile)).catch(() => null) : null;
  const currentCapture = (run, allowTruncated = false) => run?.outputStreamPolicy === OUTPUT_STREAM_POLICY
    && protocolOutputs(run, { allowTruncated }) !== null;
  const cacheable = result => {
    if (!currentCapture(result, !requirementOnly && !separateRequirement && !config.reportProtocol)
      || separateRequirement && !currentCapture(result.requirementExecution)
      || result.triage?.cases?.some(item => item.isolationObserved
        && (!currentCapture(item.isolatedRun) || !isolatedRegressionResult(item.isolatedRun, item.id)))) return false;
    return requirementOnly
      ? result.status === 'NOT_APPLICABLE' && ['PASS', 'FAIL'].includes(result.requirementCheck?.status)
      : ['PASSED', 'FAILED'].includes(result.status) && result.requirementCheck?.status !== 'INCOMPLETE'
        && (!config.reportProtocol || completedSuiteStatus(result) === result.status)
        && (!separateRequirement || readMachineInventory(result)?.complete === true);
  };
  if (!sameRoute()) return unavailable('VERIFIER_ROUTE_CHANGED');
  if (validProbe && baselineAvailable && cached?.key === key && cached.workspaceDigest === digest
    && (!routeSnapshot || cached.runnerRouteSha256 === routeSha256)
    && cacheable(cached) && (!pinnedProbe || isDeepStrictEqual(cached.requirementCheck,
      readRequirementProbe(separateRequirement ? cached.requirementExecution : cached, expectation, digest, true)))
    && await verifierFilesUnchanged(verifierFiles, signal) && sameRoute())
    return { ...cached, cached: true };
  const startedAt = now();
  const execute = (command, timeoutMs) => timeoutMs > 0
    ? runCommand(command, { cwd, timeoutMs, maxOutputBytes:config.maxOutputBytes, signal, routeSnapshot })
    : unrunCheck('STOP_DEADLINE');
  let requirementExecution;
  let run;
  if (separateRequirement) {
    // The first phase may use up to half of the remaining shared window.
    // Whatever it leaves is available to the original regression suite.
    requirementExecution = validProbe ? await execute([...identity.command, '--requirement-only'], Math.floor(remainingBudget() / 2))
      : unrunCheck('REQUIREMENT_PROBE_SHA_MISMATCH');
    signal?.throwIfAborted();
    if (!sameRoute()) return unavailable('VERIFIER_ROUTE_CHANGED');
    if (digest && await workspaceDigest(root, excluded, signal) !== digest) return unavailable('REGRESSION_WORKSPACE_CHANGED');
    run = !baselineAvailable ? unrunCheck('REGRESSION_BASELINE_UNAVAILABLE')
      : await execute([...identity.command, '--regression-only'], remainingBudget());
  } else {
    run = await execute(identity.command, budget);
  }
  if (!sameRoute()) return unavailable('VERIFIER_ROUTE_CHANGED');
  let reason = run.reason, status = 'UNAVAILABLE';
  if (requirementOnly) {
    status = 'NOT_APPLICABLE';
  } else if (!reason && config.reportProtocol) {
    status = completedSuiteStatus(run) ?? 'UNAVAILABLE';
    if (status === 'UNAVAILABLE') reason = 'REGRESSION_REPORT_UNVERIFIED';
  } else if (!reason) {
    const nativeReports = protocolRecords(run, /^RC_REGRESSION_CHECK[ \t]+(\S+)([^\r\n]*)/gmu);
    if (run.exitCode === 2 && !nativeReports) reason = 'REGRESSION_REPORT_UNVERIFIED';
    else if (run.exitCode === 2 && nativeReports.length)
      reason = nativeReports.length === 1 && nativeReports[0][1] === 'INCOMPLETE' ? 'NATIVE_TEST_INCOMPLETE' : 'REGRESSION_REPORT_UNVERIFIED';
    else if (separateRequirement && (run.signal || run.truncated || run.outputComplete === false
      || ![0, 1].includes(run.exitCode) || !readMachineInventory(run)?.complete)) reason = 'REGRESSION_REPORT_UNVERIFIED';
    else if (Number.isInteger(run.exitCode)) status = run.exitCode === 0 ? 'PASSED' : 'FAILED';
  }
  const result = { kind: 'runtime-corrector.regression-check.v1', key, workspaceDigest: digest, ...identity, effectiveTimeoutMs: budget, startedAt,
    ...run, status, ...(status === 'UNAVAILABLE' ? { reason: reason ?? 'KILLED' } : {}),
    ...(requirementExecution ? { requirementExecution, durationMs:requirementExecution.durationMs + run.durationMs } : {}) };
  const inventory = regressionFailureInventory(result);
  if (regressionApplicable && ['FAILED', 'PASSED'].includes(status) && inventory.complete) result.triage = await triageRegressionFailures({ failures: inventory.failures, baseline, signal,
    ...(config.isolationCommand && !deferIsolation ? { isolate: async id => {
      const remaining = separateRequirement ? remainingBudget() : budget - (now() - startedAt);
      if (remaining < 1000) return { reason: 'ISOLATION_BUDGET_EXHAUSTED' };
      return runCommand(config.isolationCommand.map(part => part.replaceAll('{testId}', id)), {
        cwd, timeoutMs: remaining, maxOutputBytes: config.maxOutputBytes, signal, routeSnapshot });
    } } : {}) });
  signal?.throwIfAborted();
  if (baselineSha256 && await fs.readFile(baselinePath).then(sha256, () => null) !== baselineSha256) {
    if (!separateRequirement) throw Object.assign(new Error('The task-start test baseline changed during regression triage.'), { code: 'BASELINE_INPUT_CHANGED' });
    result.status = 'UNAVAILABLE';
    result.reason = 'BASELINE_INPUT_CHANGED';
    delete result.triage;
    delete result.baselineFile;
    delete result.baselineSha256;
  }
  if (digest && (expectation || status !== 'UNAVAILABLE') && await workspaceDigest(root, excluded, signal) !== digest)
    return { ...unavailable('REGRESSION_WORKSPACE_CHANGED'), startedAt, effectiveTimeoutMs: budget, durationMs: result.durationMs };
  if (!sameRoute()) return unavailable('VERIFIER_ROUTE_CHANGED');
  const sameProbeBytes = await sameProbe();
  if (requirementOnly && !sameProbeBytes) return unavailable('REQUIREMENT_PROBE_SHA_MISMATCH');
  if (expectation) {
    if (!validProbe || !sameProbeBytes) result.requirementCheck = incompleteRequirementProbe(expectation, 'REQUIREMENT_PROBE_SHA_MISMATCH');
    else if (!digest) result.requirementCheck = incompleteRequirementProbe(expectation, 'REQUIREMENT_PROBE_WORKSPACE_UNVERIFIED');
    else result.requirementCheck = readRequirementProbe(requirementExecution ?? run, expectation, digest, pinnedProbe);
  }
  if (cacheFile && cacheable(result) && await verifierFilesUnchanged(verifierFiles, signal))
    await outsideDecision(() => atomicWriteJson(cacheFile, result)).catch(() => {});
  return sameRoute() ? result : unavailable('VERIFIER_ROUTE_CHANGED');
}

export function renderRegressionRun(run) {
  const text = [
    'Runtime Corrector program-run regression check (program-owned evidence from the project\'s existing tests).',
    `status: ${run.status}${run.reason ? ` (${run.reason})` : ''}`,
    `command: ${JSON.stringify(run.command)}`, `cwd: ${run.cwd}`,
    ...(run.reportProtocol ? [`reportProtocol: ${run.reportProtocol}`] : []),
    `testSource: ${JSON.stringify(regressionTestSource(run))}`,
    ...(regressionTestSource(run).mode === 'TASK_START_PUBLIC_TESTS'
      ? ['This run restores the task-start public test tree, including setup and mocks. Current candidate test edits are NOT executed. Do not attribute a restored setup to the current candidate or ask to repair this run by editing a test it does not execute.'] : []),
    `exitCode: ${run.exitCode ?? 'none'}`, `timedOut: ${run.timedOut === true}`, `durationMs: ${run.durationMs ?? 0}`,
    `cached: ${run.cached === true}`, `outputBytes: ${run.outputBytes ?? 0} (tail limit ${run.maxOutputBytes} bytes; truncated: ${run.truncated === true})`,
    ...(run.launchError ? [`launchError: ${run.launchError}`] : []),
    run.status === 'FAILED' ? 'A failing existing test is counterevidence only when its assertion concerns behavior touched by the changed code.'
      : run.status === 'PASSED' ? 'A passing run does not prove that untested behavior is preserved.'
        : run.status === 'NOT_APPLICABLE' ? 'This scope has no applicable existing-test regression obligation.'
          : 'This run is unavailable evidence and never a deviation by itself.',
    ...(run.triage?.cases.length ? ['Program triage excludes only established task-start failures. A fresh isolated pass, including a legacy TEST_ISOLATION label, does not explain a current whole-suite failure and remains for review.',
      `triage: ${JSON.stringify(run.triage.cases.map(({ id, type, reason, isolationObserved }) => ({ id, type, reason, ...(isolationObserved ? { isolationObserved } : {}) })))}`,
      'Remaining failures for review:', ...regressionFailureInventory(run).failures.map(failure => `${failure.id}${failure.observedDiagnostics ? ' ' + failure.observedDiagnostics.join(' ') : ''}`)]
      : []),
    '--- output tail ---', run.requirementCheck ? (run.outputTail ?? '').replace(/^RC_REQUIREMENT_PROBE .+\r?\n?/gmu, '') : run.outputTail ?? '',
  ].join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

export async function confirmCollateralRegressionFailures({projectRoot,reviewed,inventory,run,deadlineAt=Infinity,signal,outputDirectory,excluded=[]}) {
  if(run?.collateralProtocol!=='exclude-cases-v1')return reviewed;
  const exclusions=reviewed.cases.filter(x=>x.verdict==='AUTHORIZED_CHANGE').map(x=>({id:x.id,
    path:inventory?.failures?.find(f=>f.id===x.id)?.originalTest?.path}));
  const probes=reviewed.cases.filter(x=>x.verdict==='UNVERIFIED').map(x=>x.id);
  if(!exclusions.length||!probes.length||inventory?.complete!==true||exclusions.some(x=>!x.path)
    ||regressionTestSource(run).mode!=='TASK_START_PUBLIC_TESTS'||!run.baselineFile||!run.baselineSha256)return reviewed;
  const routeSnapshot=readRunnerRoute(run.routeEnvironment);
  if(fingerprintRunnerRoute(routeSnapshot)!==run.runnerRouteSha256)return reviewed;
  const budget=Math.min(run.timeoutMs??120000,deadlineAt-Date.now());if(budget<1000)return reviewed;
  const baseline=await fs.readFile(run.baselineFile);if(sha256(baseline)!==run.baselineSha256)return reviewed;
  if(!run.workspaceDigest||await workspaceDigest(projectRoot,excluded,signal)!==run.workspaceDigest)return reviewed;
  const request={requestId:sha256([run.key,exclusions,probes,Date.now()]),baselineSha256:run.baselineSha256,exclusions,probes};
  await fs.mkdir(outputDirectory,{recursive:true});const file=path.join(outputDirectory,request.requestId+'.request.json');
  await fs.writeFile(file,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
  const result=await runCommand([...run.command,'--exclude-cases='+file],{cwd:path.resolve(projectRoot,run.cwd??'.'),
    timeoutMs:budget,maxOutputBytes:run.maxOutputBytes,signal,routeSnapshot});
  signal?.throwIfAborted();
  if(sha256(await fs.readFile(run.baselineFile))!==run.baselineSha256
    ||await workspaceDigest(projectRoot,excluded,signal)!==run.workspaceDigest
    ||fingerprintRunnerRoute(readRunnerRoute(run.routeEnvironment))!==run.runnerRouteSha256)return reviewed;
  const confirmed=applyCollateralReceipt(reviewed,request,result);
  await atomicWriteJson(path.join(outputDirectory,request.requestId+'.result.json'),{request,result,confirmed});
  return confirmed;
}
