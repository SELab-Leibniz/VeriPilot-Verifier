import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHypium, gradeArkts } from '../scripts/bench/hypium-results.mjs';
import { arktsAgentInput } from '../scripts/bench/arkts-dataset.mjs';
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
