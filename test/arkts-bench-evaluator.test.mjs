import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHypium, gradeArkts } from '../scripts/bench/hypium-results.mjs';
import { arktsAgentInput, digest } from '../scripts/bench/arkts-dataset.mjs';
import { arktsInstrumentRuntime } from '../scripts/bench/arkts-instrument-results.mjs';
import { compareArktsCandidateGrades, sealArktsGradingCandidate } from '../scripts/bench/simplify-arkts-inputs.mjs';
const lines = (name, status) => `[Hypium]start running case '${name}'\nOHOS_REPORT_STATUS: class=Spec\n[Hypium][${status}]${name} ; consuming 1ms\nOHOS_REPORT_STATUS: class=Spec\nOHOS_REPORT_STATUS: test=${name}\nOHOS_REPORT_STATUS_CODE: ${status === 'pass' ? 0 : status === 'fail' ? -2 : -3}\n`;
const task = { instance_id: 'toy', FAIL_TO_PASS: ['entry::Spec::new'], PASS_TO_PASS: ['entry::Spec::old'] };
const execution = { timedOut: false, compileSucceeded: true, freshReport: true, code: 0 };
const parse = text => parseHypium(text + '\n[Hypium][end] run suites end\n');
test('runtime assertions override misleading exit zero and summary text', () => {
  const base = gradeArkts(task, parse(lines('new', 'fail') + lines('old', 'pass')), execution);
  assert.equal(base.validFailToPassBase, true); assert.equal(base.resolved, false);
  const fixed = gradeArkts(task, parse(lines('new', 'pass') + lines('old', 'pass')), execution);
  assert.equal(fixed.resolved, true);
});
test('grading records the runtime case inventory and failures outside the published populations', () => {
  const expectedRun = lines('new', 'pass') + lines('old', 'pass');
  const normal = gradeArkts(task, parse(expectedRun), execution);
  const extra = gradeArkts(task, parse(expectedRun + lines('uncatalogued', 'fail')), execution);
  const reordered = gradeArkts(task, parse(lines('uncatalogued', 'pass') + expectedRun), execution);
  assert.equal(normal.testInventory.observed, 2);
  assert.deepEqual(extra.testInventory, { expected: 2, observed: 3, extra: 1, extraFailed: 1,
    observedIdsSha256: reordered.testInventory.observedIdsSha256 });
  assert.notEqual(extra.testInventory.observedIdsSha256, normal.testInventory.observedIdsSha256);
  assert.deepEqual(extra.f2p, normal.f2p);
  assert.deepEqual(extra.p2p, normal.p2p);
});
test('missing, unfinished, duplicate, ignored and stale outcomes never count as resolved', () => {
  for (const text of [lines('old', 'pass'), lines('new', 'pass') + lines('old', 'ignore'),
    lines('new', 'pass') + lines('old', 'pass') + lines('new', 'pass'),
    lines('new', 'pass') + "[Hypium]start running case 'old'\nOHOS_REPORT_STATUS: class=Spec\n"]) {
    assert.equal(gradeArkts(task, parse(text), execution).resolved, false);
  }
  const passed = parse(lines('new', 'pass') + lines('old', 'pass'));
  assert.equal(gradeArkts(task, passed, { ...execution, freshReport: false }).resolved, false);
  assert.equal(gradeArkts(task, passed, { ...execution, timedOut: true }).resolved, false);
});
test('an attributable test runtime exception is a failing base case, not an infrastructure error', () => {
  const parsed = parse(lines('new', 'pass').replace('[pass]new', '[error]new').replace('STATUS_CODE: 0', 'STATUS_CODE: -1') + lines('old', 'pass'));
  const grade = gradeArkts(task, parsed, execution);
  assert.equal(grade.validFailToPassBase, true); assert.deepEqual(grade.f2p.testErrors, ['entry::Spec::new']);
  assert.equal(grade.resolved, false); assert.deepEqual(grade.runtimeErrors, []);
  assert.equal(gradeArkts(task, parseHypium(lines('new', 'pass') + lines('old', 'pass')), execution).executed, false);
});
test('agent input excludes gold, hidden tests, verdicts and gold-derived changed paths', () => {
  const raw = { instance_id: 'toy', repo: 'a/b', base_commit: 'base', problem_statement: 'Fix behavior', hints_text: '',
    patch: 'secret gold', test_patch: 'hidden oracle', FAIL_TO_PASS: ['secret case'], implementation_files_changed: ['answer.ets'] };
  assert.deepEqual(Object.keys(arktsAgentInput(raw)), ['instance_id', 'repo', 'base_commit', 'problem_statement', 'hints_text']);
  assert.doesNotMatch(JSON.stringify(arktsAgentInput(raw)), /secret|hidden|answer/);
});
test('independent grading seals the exact candidate before applying or recording it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-arkts-candidate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.patch');
  await fs.writeFile(input, 'sealed version');
  await assert.rejects(sealArktsGradingCandidate(input, root, digest('other version')), /frozen digest/);
  const sealed = await sealArktsGradingCandidate(input, root, digest('sealed version'));
  await fs.writeFile(input, 'later mutation');
  assert.equal(await fs.readFile(sealed.file, 'utf8'), 'sealed version');
  assert.equal(sealed.sha256, digest('sealed version'));
  assert.equal(sealed.bytes, Buffer.byteLength('sealed version'));
  await assert.rejects(sealArktsGradingCandidate(input, root), { code: 'EEXIST' });
});
test('saved candidate grades count a gain and loss separately at a net tie', () => {
  const beforePatchSha256 = digest('before patch'), afterPatchSha256 = digest('after patch');
  const pins = { beforePatchSha256, afterPatchSha256 };
  const caseA = 'entry::PrivateSuite::case A', caseB = 'entry::PrivateSuite::case B';
  const cases = { ...task, FAIL_TO_PASS: [caseA, caseB] };
  const receipt = (candidateSha256, pass, fail) => ({ kind: 'hidden-test-candidate-grade', candidateSha256,
    instanceId: task.instance_id, baseCommit: 'a'.repeat(40), calibrationDirectory: '/calibration/independent',
    environment: { datasetDigest: digest('dataset'), testPatchSha256: digest('private test patch'), toolchain: { sha256: digest('toolchain') } },
    results: [{ phase: 'candidate', ...gradeArkts(cases, { statuses: { [pass]: 'PASS', [fail]: 'FAIL', 'entry::Spec::old': 'PASS' },
      finished: true, errors: [] }, execution) }] });
  const before = receipt(beforePatchSha256, caseA, caseB), after = receipt(afterPatchSha256, caseB, caseA);
  assert.deepEqual(compareArktsCandidateGrades(before, after, pins), { kind: 'sealed-arkts-grade-comparison', ...pins,
    f2p: { total: 2, gains: 1, losses: 1, unchanged: 0 }, p2p: { total: 1, gains: 0, losses: 0, unchanged: 1 } });

  for (const invalidate of [
    grade => { grade.candidateSha256 = beforePatchSha256; },
    grade => { grade.calibrationDirectory += '-other'; },
    grade => { grade.environment.toolchain.sha256 = digest('other toolchain'); },
    grade => { grade.results[0].executed = false; },
    grade => { grade.results[0].execution.freshReport = false; },
    grade => { grade.results[0].execution.compileSucceeded = false; },
    grade => { grade.results[0].execution.timedOut = true; },
    grade => { grade.results[0].f2p.failed = []; },
    grade => { grade.results[0].f2p.failed = [caseB]; },
    grade => { grade.results[0].f2p.failed = ['entry::PrivateSuite::other case']; },
  ]) {
    const invalid = structuredClone(after);
    invalidate(invalid);
    assert.throws(() => compareArktsCandidateGrades(before, invalid, pins), error => {
      assert.doesNotMatch(error.message, /PrivateSuite/u);
      return true;
    });
  }

  const [instrumentBefore, instrumentAfter] = structuredClone([before, after]);
  for (const grade of [instrumentBefore, instrumentAfter]) {
    grade.environment.runtime = arktsInstrumentRuntime;
    Object.assign(grade.results[0].execution, { suiteSha256: digest('suite'), runnerSha256: digest('runner') });
  }
  assert.deepEqual(compareArktsCandidateGrades(instrumentBefore, instrumentAfter, pins), compareArktsCandidateGrades(before, after, pins));
  for (const key of ['suiteSha256', 'runnerSha256']) {
    const changed = structuredClone(instrumentAfter);
    changed.results[0].execution[key] = digest('different fingerprint');
    assert.throws(() => compareArktsCandidateGrades(instrumentBefore, changed, pins), /fingerprints must match/u);
    delete changed.results[0].execution[key];
    assert.throws(() => compareArktsCandidateGrades(instrumentBefore, changed, pins), /lacks its exact suite or runner fingerprint/u);
  }
});
test('corrupted start logs require an independently matching terminal runtime frame', () => {
  const noisy = lines('old', 'pass').replace("case 'old'", "case 'old'.");
  const parsed = parseHypium(noisy);
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.statuses['entry::Spec::old'], 'PASS');
  assert.equal(parsed.recovered.length, 1);
  assert.ok(parseHypium(noisy.replace('test=old', 'test=unrelated')).errors.length);
  assert.ok(parseHypium(noisy.replace('STATUS_CODE: 0', 'STATUS_CODE: -2')).errors.length);
});
test('conflicting class names need an independent same-run witness, never an expected-ID guess', () => {
  const confirmed = lines('anchor', 'pass');
  const damaged = lines('old', 'pass').replace('class=Spec', 'class=Spec3f00');
  const parsed = parse(confirmed + damaged);
  assert.equal(parsed.statuses['entry::Spec::old'], 'PASS');
  assert.equal(parsed.statuses['entry::Spec3f00::old'], undefined); assert.deepEqual(parsed.errors, []);
  const ambiguous = parse(damaged);
  assert.ok(ambiguous.errors.some(error => error.code === 'CONFLICTING_CLASS'));
});

test('matching suite lifecycle records confirm the class of a single-case suite', () => {
  const start = '[Hypium]Spec suiteStart print success\n';
  const end = '[suite end] Spec consuming 1 ms\n';
  const noisy = lines('old', 'pass').replace('class=Spec', 'class=Spec3f00/\nArkCompiler: [gc] diagnostic');
  const parsed = parse(start + noisy + end);
  assert.deepEqual(parsed.statuses, { 'entry::Spec::old': 'PASS' });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.recovered.length, 1);
  assert.ok(parse(start + noisy).errors.some(error => error.code === 'CONFLICTING_CLASS'));
  assert.ok(parse(noisy + end).errors.some(error => error.code === 'CONFLICTING_CLASS'));
});

test('a split GC suffix needs matching case ordinals and an independently confirmed class', () => {
  const cleanCase = lines('new', 'pass');
  const noisy = [
    "[Hypium]start running case 'old'",
    'OHOS_REPORT_STATUS: class=Spec244',
    'OHOS_REPORT_STATUS: current=7',
    '[Hypium][pass]old ; consuming 1ms',
    'OHOS_REPORT_STATUS: class=Spec',
    'OHOS_REPORT_STATUS: current=7',
    'OHOS_REPORT_STATUS: test=old42996 D',
    'C0b-0a 04:1a:2a.244 03f00/ArkCompiler: [gc] diagnostic',
    'OHOS_REPORT_STATUS_CODE: 0',
    '',
  ].join('\n');
  const parsed = parse(cleanCase + noisy);
  assert.deepEqual(parsed.statuses, { 'entry::Spec::new': 'PASS', 'entry::Spec::old': 'PASS' });
  assert.deepEqual(parsed.errors, []);
  assert.equal(gradeArkts(task, parsed, execution).resolved, true);
  const failed = noisy.replace('[pass]old', '[fail]old').replace('STATUS_CODE: 0', 'STATUS_CODE: -2');
  assert.deepEqual(gradeArkts(task, parse(cleanCase + failed), execution).p2p.failed, ['entry::Spec::old']);
  assert.ok(parse(noisy).errors.some(error => error.code === 'CONFLICTING_CLASS'));
  for (const invalid of [
    noisy.replace('class=Spec\nOHOS_REPORT_STATUS: current=7', 'class=Spec\nOHOS_REPORT_STATUS: current=8'),
    noisy.replace('STATUS_CODE: 0', 'STATUS_CODE: -2'),
    noisy.replace('C0b-0a', '11-10'),
    noisy.replace('test=old', 'test=other'),
  ]) {
    const grade = gradeArkts(task, parse(cleanCase + invalid), execution);
    assert.equal(grade.complete, false);
    assert.equal(grade.resolved, false);
  }
});
