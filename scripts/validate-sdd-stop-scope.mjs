// Compare the normal SessionStart -> Stop entry points on two local RC revisions.
// Only the reviewer's choices are scripted. Stop owns source reads, scope and publication.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialSddText } from './helpers/initial-sdd-pressure.mjs';

const here = fileURLToPath(new URL('../', import.meta.url));
const revision = path.resolve(process.argv[2] ?? here);
const expected = process.argv[4];
assert(process.argv[3] && ['before', 'after'].includes(expected), 'Pass RC root, a new evidence directory, and before or after.');
const output = path.resolve(process.argv[3]);
const load = file => import(pathToFileURL(path.join(revision, file)).href);
const { compileRuntimeV2Config } = await load('lib/runtime-v2/config.mjs');
const { handleRuntimeV2Event } = await load('lib/runtime-v2/orchestrator.mjs');
const { scriptedWorkspaceReview } = await load('test/helpers/scripted-workspace-review.mjs');
const { sha256 } = await load('lib/runtime-v2/utils.mjs');
const { ensureTask } = await load('lib/runtime-v2/task-store.mjs');
const { stopFeedbackNotice } = await load('lib/openclaw/stop-feedback-notice.mjs');
const { readReport, renderReport } = await load('lib/openclaw/report.mjs');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output);
const ordinary = 'Ordinary mode must return three retries.';
const sealed = 'Sealed mode must return zero retries.';
const candidate = 'export function retryLimit(mode) { return 3; }\n';
const row = (text, file) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
  implementationRole: 'PRODUCTION', text, path: file, lineStart: 1, lineEnd: 1 });
const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false },
  stopCorrection: { enabled: true, originalRequirementsBasis: true, deviationOnly: true } });

async function exercise(mode) {
  const root = path.join(output, mode);
  await fs.mkdir(root);
  await ensureTask({ projectRoot: root, sessionId: 'sdd-scope' });
  const doc = name => path.join(root, name);
  const interrupt = mode === 'interrupted' || mode === 'implicit-interrupted';
  const main = doc('workflow.md'), annex = doc('annex.md'), implementation = doc('retry.mjs');
  const spec = initialSddText(4547, 'chinese');
  const prompt = mode === 'implicit-interrupted' ? '请验收本次发布。' : interrupt ? '请依照 AGENTS.md 的完整规范验收密封模式。'
    : 'Implement workflow.md and all of its mandatory annexes.' + (['named', 'partial'].includes(mode) ? ' This includes annex.md.' : '');
  if (interrupt) await fs.writeFile(doc('AGENTS.md'), spec);
  else await Promise.all([
    fs.writeFile(main, ordinary + '\nAll rules in annex.md are mandatory. example.md is illustrative only.\n'
      + (mode === 'mixed' ? 'Further mandatory annex: unavailable.md.\n' : '')),
    fs.writeFile(annex, sealed + '\nSee workflow.md for the common rules.\n'),
    fs.writeFile(doc('example.md'), 'A historical example used five retries.\n'),
  ]);
  await fs.writeFile(implementation, candidate);
  assert.equal((await import(pathToFileURL(implementation).href)).retryLimit('sealed'), 3);
  const transcript = doc('session.jsonl');
  const last = 'Task complete.';
  const entries = [{ type: 'user', uuid: 'request', message: { content: prompt } },
    { type: 'assistant', uuid: 'final', message: { content: last } }];
  await fs.writeFile(transcript, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  const attempts = [];
  const reviewerFactory = input => scriptedWorkspaceReview(input, { script: async ({ task, call, read }) => {
    const record = { annexInBasis: task.basisFiles.includes(annex), pages: 0 };
    attempts.push(record);
    for (const file of task.basisFiles) {
      if (interrupt && file === doc('AGENTS.md')) continue;
      await read(file);
    }
    if (interrupt) {
      for (let offset = 1; offset <= 4125; offset += 125) {
        await call('source_read', { path: doc('AGENTS.md'), offset, limit: 125, numbered: true });
        record.pages++;
      }
      throw Object.assign(new Error('Reproduce the observed host interruption before the checklist.'), { code: 'REVIEWER_RUN_FAILED' });
    }
    const include = mode === 'follow' || mode !== 'omit' && record.annexInBasis;
    if (include && !record.annexInBasis) await read(annex);
    const items = [row(ordinary, main), ...(include ? [row(sealed, annex)] : [])];
    try { await call('set_original_checklist', { items }); }
    catch (error) { record.rejected = error.code; throw error; }
    const page = await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    if (include) {
      const subject = JSON.parse(page.content[0].text).items.find(item => item.description === sealed);
      assert(subject);
      const citeId = await read(implementation);
      await call('submit_review', { taskId: subject.taskId, verdict: 'DEVIATION', citeIds: [citeId],
        reason: '密封模式实际返回 3 次重试，强制附录规定为 0 次。' });
    }
    if (mode === 'partial') throw Object.assign(new Error('Interrupt after saving the annex deviation.'), { code: 'REVIEWER_RUN_FAILED' });
    await call('finish_stop_review', { summary: 'Finished the registered release obligations.' });
  } });
  const event = (name, extra = {}) => handleRuntimeV2Event({ projectRoot: root, plan: { artifacts: [], runtimeV2 }, reviewerFactory,
    stopHost: { directory: doc('host'), stopId: 'scope-stop', startProtocol: { version: 1 } },
    input: { session_id: 'sdd-scope', hook_event_name: name, cwd: root, transcript_path: transcript, last_assistant_message: last, ...extra } });
  await event('SessionStart', { source: 'startup' });
  const settled = await event('Stop');
  const stop = settled.stop;
  assert(stop, JSON.stringify(settled));
  const evaluation = path.join(root, '.runtime-correction', 'tasks', stop.taskId, 'evaluations', stop.evaluationId + '.json');
  const saved = JSON.parse(await fs.readFile(evaluation, 'utf8'));
  assert.equal(saved.outcome.status, stop.status);
  assert.deepEqual(stop.acceptanceReport, saved.outcome.acceptanceReport);
  const published = await readReport({ workspaceDir: root, sessionId: 'sdd-scope' });
  assert.deepEqual(published.acceptanceReport ?? null, stop.acceptanceReport ?? null);
  const reportSections = renderReport(published).split('\n').filter(line => /^(已证实的偏差|尚未核实的范围|未验证项 )/u.test(line));
  return { mode, promptSha256: sha256(prompt), materialSha256: sha256(await fs.readFile(interrupt ? doc('AGENTS.md') : main)),
    ...(interrupt ? {} : { annexSha256: sha256(await fs.readFile(annex)) }),
    candidateSha256: sha256(candidate), attempts, status: stop.status, reasonCode: stop.reasonCode, decision: stop.decision,
    scanCompleted: stop.coverage?.scanCompleted, confirmed: (stop.review?.metricObjectJudgements ?? []).filter(r => r.judgement === 'DEVIATION').length,
    acceptanceReport: stop.acceptanceReport ?? null, feedback: stop.feedback, notice: stopFeedbackNotice(stop), reportSections,
    evaluation: path.relative(output, evaluation).replaceAll('\\', '/') };
}
const cases = [];
for (const mode of ['registered', 'omit', 'follow', 'named', 'mixed', 'interrupted', 'partial', 'implicit-interrupted']) {
  cases.push(await exercise(mode));
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(cases, null, 2) + '\n');
}
const [registered, omitted, followed, named, mixed, large, partial, implicit] = cases;
assert(named.confirmed === 1 && large.status === 'UNVERIFIED');
assert.equal(large.materialSha256, 'cf01ab06a64b204b09ba2d9f4dedbf3e5bb5c89475c2d23a235b8f0a05c69043');
assert(large.attempts.every(attempt => attempt.pages === 33));
assert.equal(implicit.materialSha256, large.materialSha256);
assert(implicit.attempts.every(attempt => attempt.pages === 33));
if (expected === 'before') {
  assert.equal(registered.status, 'NO_DEVIATION_FOUND');
  assert.equal(omitted.status, 'NO_DEVIATION_FOUND');
  assert(followed.attempts.some(attempt => attempt.rejected === 'STOP_ORIGINAL_CHECKLIST_INVALID'));
  assert.equal(large.acceptanceReport, null);
  assert.equal(implicit.acceptanceReport, null);
} else {
  for (const arm of [registered, followed, named]) {
    assert.equal(arm.status, 'DEVIATION');
    assert.equal(arm.acceptanceReport.confirmedDeviations.length, 1);
    assert(arm.acceptanceReport.complete && !arm.acceptanceReport.unverifiedItems.length);
    assert.deepEqual(arm.acceptanceReport.sourceCoverage.sources.map(source => source.ref), ['workflow.md', 'annex.md']);
  }
  assert.equal(omitted.status, 'UNVERIFIED');
  assert(omitted.acceptanceReport.unverifiedItems.some(item => item.id === 'original:annex.md'));
  assert.equal(omitted.acceptanceReport.confirmedDeviations.length, 0);
  assert.equal(mixed.status, 'UNVERIFIED');
  assert.equal(mixed.acceptanceReport.confirmedDeviations.length, 1);
  assert(mixed.acceptanceReport.unverifiedItems.some(item => item.id === 'original:unavailable.md'));
  assert.match(mixed.notice, /尚未核实的范围[\s\S]*unavailable\.md/u);
  assert(mixed.reportSections.includes('已证实的偏差（1）') && mixed.reportSections.includes('尚未核实的范围（1）'));
  assert(mixed.reportSections.some(line => line.includes('unavailable.md')));
  assert(!mixed.feedback.includes('unavailable.md'), 'A missing original is not a business correction instruction');
  const src = large.acceptanceReport.sourceCoverage.sources.find(source => source.ref === 'AGENTS.md');
  assert.equal(src.disposition, 'CHECKLIST_NOT_SUBMITTED');
  assert.equal(src.readLines, 4125);
  assert.deepEqual(src.unreadRanges, [[4126, 4557]]);
  assert.equal(large.acceptanceReport.confirmedDeviations.length, 0);
  assert.match(large.feedback, /4126–4557/u);
  const projectSdd = implicit.acceptanceReport.sourceCoverage.sources.find(source => source.ref === 'AGENTS.md');
  assert.equal(implicit.status, 'UNVERIFIED');
  assert.equal(projectSdd.declaredBy.ref, 'project:instructions');
  assert.deepEqual(projectSdd.unreadRanges, src.unreadRanges);
  assert.equal(partial.status, 'UNVERIFIED');
  assert.equal(partial.acceptanceReport.confirmedDeviations.length, 1);
  assert(partial.acceptanceReport.unverifiedItems.some(item => item.type === 'REQUIREMENT' && item.source?.ref === 'workflow.md'
    && item.reason.includes(ordinary)));
}
console.log(JSON.stringify(cases.map(({ mode, status, confirmed, acceptanceReport }) =>
  ({ mode, status, confirmed, unverified: acceptanceReport?.unverifiedItems.length }))));
