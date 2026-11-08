import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { matchConfiguredArtifact } from '../artifact-pipeline.mjs';
import { outsideDecision } from './decision-scope.mjs';
import { OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY } from './paths.mjs';
import { atomicWriteJson, readJson, sha256 } from './utils.mjs';

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
  testFiles: 4000, testFileBytes: 512 * 1024, pointers: 12, lines: 16, cases: 8, originalTestBytes: 12 * 1024, digestFiles: 2000 };
const CODE = /\.(?:[cm]?[jt]sx?|ets|vue|svelte|py|java|kts?|scala|groovy|rs|go|c|cc|cpp|cxx|h|hh|hpp|cs|swift|mm?|rb|php|lua|dart|sh|ps1)$/iu;
const SKIPPED = new Set(['.git', 'node_modules', 'oh_modules', '.hvigor', '.preview', 'build', 'dist', 'target', 'vendor', 'coverage', OUTPUT_TREE_DIRECTORY, POLICY_ROOT_DIRECTORY]);
const TEST_DIRECTORY = /^(?:tests?|__tests__|specs?|ohosTest|androidTest|unitTest|integrationTest|e2e)$/iu;
const TEST_FILE = /(?:^test_|[._-](?:test|spec)s?\.[^.]+$|(?:Tests?|Spec)\.(?:java|kts?|scala|groovy|cs|swift)$)/u;
const SUPPORT_DIRECTORY = /^(?:mocks?|__mocks__|fixtures?)$/iu;
const CASE = /\b(?:it|test|describe|xit|fit|specify)\s*\(\s*(['"`])((?:\\.|(?!\1).){1,200})\1|^\s*(?:async\s+)?def\s+(test\w*)\s*\(|\b(?:void|fun|func)\s+(test\w*)\s*\(/iu;
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
const testPath = relative => { const parts = relative.split('/');
  return !parts.some(part => SKIPPED.has(part) || SUPPORT_DIRECTORY.test(part)) && CODE.test(relative)
    && (parts.slice(0, -1).some(part => TEST_DIRECTORY.test(part)) || TEST_FILE.test(parts.at(-1))); };

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
  const stems = changes.filter(change => CODE.test(change.path) && !testPath(change.path)).map(change => stem(change.path)).filter(value => value.length >= 4);
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
    const caseLines = [];
    for (const [index, line] of lines.entries()) {
      const match = CASE.exec(line);
      if (match) caseLines.push({ line: index + 1, title: (match[2] ?? match[3] ?? match[4]).slice(0, 120) });
    }
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
  if (!all.some(change => CODE.test(change.path) && ['modified', 'deleted'].includes(change.status)))
    return { available: true, triggered: false, changes: all.slice(0, LIMITS.changes), testPointers: [] };
  const names = new Map(), changes = [], diffs = [], removed = new Map();
  let diffBytes = 0, diffFiles = 0;
  for (const change of all.slice(0, LIMITS.changes)) {
    active();
    const record = { ...change, code: CODE.test(change.path), hunks: null };
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
      ...pointer.cases.toSorted((a, b) => a.line - b.line).map(value => `    L${value.line}: ${value.title}`)]),
    ...(evidence.originalTests?.length ? ['Task-start public test excerpts for edited or deleted suites. Cite the excerpt here for original assertions; use the changed production source to test whether each effect survives.',
      ...evidence.originalTests.flatMap(test => [`--- ${test.path}:${test.line}-${test.end} (${test.title}) ---`, test.body])] : []),
    `Changed hunks (git diff ${evidence.base === 'TASK_START' ? evidence.baseCommit : 'HEAD'}; removed lines show the pre-existing code):`,
    ...evidence.diffs,
  ].join('\n') + '\n';
}

const runSummary = (run, files) => ['PASSED', 'FAILED'].includes(run.status)
  ? `Program-run existing tests: exit ${run.exitCode}${run.cached ? ' (cached for this unchanged workspace)' : ''}; output at ${files[0] ?? 'unavailable'}`
  : `Program-run existing tests unavailable (${run.reason ?? run.status}); this is not evidence of a deviation. Record at ${files[0] ?? 'unavailable'}`;

export function regressionNavigation({ evidence, files = [], run = null, runFiles = [] }) {
  const code = evidence.changes.filter(change => change.code);
  return { navigationOnly: true, evidenceFiles: files,
    changedFiles: code.slice(0, 8).map(({ path: file, status }) => ({ path: file, status })), changedFileCount: code.length,
    testPointers: evidence.testPointers.slice(0, 6).map(pointer => ({ path: pointer.path, ...(pointer.modifiedByTask ? { modifiedByTask: true } : {}),
      identifiers: pointer.identifiers.slice(0, 4), cases: pointer.cases.slice(0, 4).map(value => `L${value.line} ${value.title}`) })),
    testPointerCount: evidence.testPointers.length,
    programRun: run ? { status: run.status, exitCode: run.exitCode ?? null, timedOut: run.timedOut === true, durationMs: run.durationMs ?? 0,
      ...(run.cached ? { cached: true } : {}), files: runFiles, summary: runSummary(run, runFiles) }
      : { status: 'NOT_RUN', summary: 'No program-run existing-test check ran for this Stop.' },
    instruction: 'Read the changed hunks and the listed pre-existing tests or callers with source_read. For DEVIATION cite both the pre-existing assertion or caller dependency and the changed code that contradicts it. Pointers grant no proof.' };
}

/** Structural floor for a standing-regression deviation; semantics stay with the reviewer. */
export function regressionDeviationProblem({ projectRoot, evidence, citations, evidenceFiles = [], run = null, runFiles = [] }) {
  const changes = new Map(evidence.changes.map(change => [fileKey(path.resolve(projectRoot, change.path)), change]));
  const overlaps = (citation, ranges) => ranges.some(([start, end]) => citation.start <= end && start <= citation.end);
  const changedCode = citations.filter(citation => {
    const change = changes.get(fileKey(citation.path));
    return citation.readProof?.owner === 'SOURCE' && change?.code && change.status !== 'deleted' && (!change.hunks || overlaps(citation, change.hunks));
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

function decodeTail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}

function runCommand(argv, { cwd, timeoutMs, maxOutputBytes, signal }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let child, timer, drain, tail = Buffer.alloc(0), outputBytes = 0, settled = false, stopping = false, closed;
    const exited = new Promise(resolve => { closed = resolve; });
    const finish = extra => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drain); signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - startedAt, outputBytes,
        truncated: outputBytes > tail.length, outputTail: decodeTail(tail), ...extra });
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
    const output = chunk => { outputBytes += chunk.length; tail = Buffer.concat([tail, chunk]); if (tail.length > maxOutputBytes) tail = tail.subarray(tail.length - maxOutputBytes); };
    try { child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ reason: 'LAUNCH_FAILED', launchError: String(error.code ?? error.message).slice(0, 200) }); return; }
    timer = setTimeout(() => { void stop({ timedOut: true, reason: 'TIMEOUT' }); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { closed(); if (!stopping) finish({ reason: 'LAUNCH_FAILED', launchError: String(error.code ?? error.message).slice(0, 200) }); });
    child.once('exit', (code, name) => { if (!stopping) drain = setTimeout(() => finish({ exitCode: code, signal: name }), 2000); });
    child.once('close', (code, name) => { closed(); if (!stopping) finish({ exitCode: code, signal: name }); });
    if (signal?.aborted) cancel();
  });
}

async function workspaceDigest(projectRoot, excluded, signal) {
  const changes = await changedFiles({ projectRoot, excluded, signal });
  if (!changes || changes.length > LIMITS.digestFiles) return null;
  let head = null;
  try { head = (await git(projectRoot, ['rev-parse', '--verify', '-q', 'HEAD'], signal)).trim() || null; } catch (error) { if (signal?.aborted) throw error; }
  const files = [];
  for (const change of changes) files.push([change.path, change.status,
    change.status === 'deleted' ? null : await fs.readFile(path.resolve(projectRoot, change.path)).then(sha256, () => null)]);
  return sha256({ head, files });
}

/** Runs the configured existing-test command once for a Stop whose scope
 * selected the standing regression item. Never throws for command failure. */
export async function runStopRegressionCheck({ projectRoot, config, population, deadlineAt = Infinity, signal, cacheDirectory = null, excluded = [], now = Date.now }) {
  if (config?.enabled !== true || !Object.values(population?.metrics ?? {}).flat().some(object => object.programStanding === STANDING_REGRESSION)) return null;
  signal?.throwIfAborted();
  const root = await fs.realpath(projectRoot);
  const identity = { command: [...config.command], cwd: config.cwd, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes };
  const budget = Math.min(config.timeoutMs, Math.floor((deadlineAt - now()) / 2));
  if (!(budget >= 1000)) return { kind: 'runtime-corrector.regression-check.v1', ...identity, status: 'UNAVAILABLE', reason: 'STOP_DEADLINE',
    exitCode: null, timedOut: false, durationMs: 0, outputBytes: 0, truncated: false, outputTail: '' };
  const digest = await workspaceDigest(root, excluded, signal);
  const key = digest && sha256({ command: identity.command, cwd: identity.cwd, maxOutputBytes: identity.maxOutputBytes, digest });
  const cacheFile = key && cacheDirectory ? path.join(cacheDirectory, `${key}.json`) : null;
  const cached = cacheFile ? await outsideDecision(() => readJson(cacheFile)).catch(() => null) : null;
  if (cached?.key === key && ['PASSED', 'FAILED'].includes(cached.status)) return { ...cached, cached: true };
  const startedAt = now();
  const run = await runCommand(identity.command, { cwd: path.resolve(root, config.cwd), timeoutMs: budget, maxOutputBytes: config.maxOutputBytes, signal });
  const status = run.reason ? 'UNAVAILABLE' : run.exitCode === 0 ? 'PASSED' : Number.isInteger(run.exitCode) ? 'FAILED' : 'UNAVAILABLE';
  const result = { kind: 'runtime-corrector.regression-check.v1', key, workspaceDigest: digest, ...identity, effectiveTimeoutMs: budget, startedAt,
    status, ...(status === 'UNAVAILABLE' ? { reason: run.reason ?? 'KILLED' } : {}), ...run };
  if (cacheFile && ['PASSED', 'FAILED'].includes(status)) await outsideDecision(() => atomicWriteJson(cacheFile, result)).catch(() => {});
  return result;
}

export function renderRegressionRun(run) {
  const text = [
    'Runtime Corrector program-run regression check (program-owned evidence from the project\'s existing tests).',
    `status: ${run.status}${run.reason ? ` (${run.reason})` : ''}`,
    `command: ${JSON.stringify(run.command)}`, `cwd: ${run.cwd}`,
    `exitCode: ${run.exitCode ?? 'none'}`, `timedOut: ${run.timedOut === true}`, `durationMs: ${run.durationMs ?? 0}`,
    `cached: ${run.cached === true}`, `outputBytes: ${run.outputBytes ?? 0} (tail limit ${run.maxOutputBytes} bytes; truncated: ${run.truncated === true})`,
    ...(run.launchError ? [`launchError: ${run.launchError}`] : []),
    run.status === 'FAILED' ? 'A failing existing test is counterevidence only when its assertion concerns behavior touched by the changed code.'
      : run.status === 'PASSED' ? 'A passing run does not prove that untested behavior is preserved.' : 'This run is unavailable evidence and never a deviation by itself.',
    '--- output tail ---',
    run.outputTail ?? '',
  ].join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}
