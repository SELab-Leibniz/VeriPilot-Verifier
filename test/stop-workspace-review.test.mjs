import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { persistSkillGroundTruth } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { buildMetricPopulation } from '../lib/runtime-v2/metrics.mjs';
import { prepareMixedSkillEvaluation, MIXED_SKILL_EXPECTED } from '../scripts/helpers/mixed-skill-evaluation.mjs';

async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' };
  delete f.input.request.fixedStopClassification;
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: f.file, old_string: 'before', new_string: 'after' } }] } });
  const scope = submit => submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'The original response claims completion.' });
  const result = (submit, citeIds = [], verdict = 'PASS') => submit('submit_review', { taskId: 'M01:R1', verdict, reason: 'Checked the current original delivery.', citeIds });
  return { ...f, scope, result };
}

test('one workspace reviewer reads external and linked originals, plans, saves notes and submits a complete checklist without copying source', async t => {
  const f = await fixture(t);
  const external = path.join(path.dirname(f.root), `external-${path.basename(f.root)}.md`);
  await fs.writeFile(external, 'External requirement dependency.\n'); t.after(() => fs.rm(external, { force: true }));
  const externalDir = path.join(path.dirname(f.root), `linked-${path.basename(f.root)}`);
  await fs.mkdir(externalDir); await fs.writeFile(path.join(externalDir, 'linked.md'), 'Linked original requirement.\n');
  t.after(() => fs.rm(externalDir, { recursive: true, force: true }));
  const junction = path.join(f.root, 'reference'); await fs.symlink(externalDir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const handle = await f.run(async ({ params, brief, tools, readAll, read, submit }) => {
    assert.equal(params.cwd, f.root); assert.equal(params.workspaceDir, f.root);
    await assert.rejects(f.scope(submit), /not fully read/);
    await readAll(); await f.scope(submit);
    await assert.rejects(submit('finish_stop_review', { summary: 'Premature.' }), /incomplete/);
    await submit('review_plan', { steps: [{ text: 'Start with edits, then follow the external contract.', status: 'active' }] });
    await submit('review_notes', { note: 'The original external contract is relevant; this note itself is not proof.' });
    assert.equal((await submit('review_notes', {})).notes.length, 1);
    const changed = await submit('review_changes', {});
    assert(changed.hostEdits.some(edit => edit.path === f.file));
    await read(external); await read(path.join(junction, 'linked.md'));
    const actual = await read(f.file);
    await f.result(submit, [actual.details.citation.citeId]);
    await assert.rejects(f.result(submit, [actual.details.citation.citeId]), /already has/);
    await submit('finish_stop_review', { summary: 'The original checklist is complete.' });
    assert.equal(brief.task.scope, 'workspace-stop');
  });
  assert.equal(f.calls.length, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(handle.sourceCitations[0].path, f.file);
  assert.equal(handle.sourceCitations[0].frozen, false);
  assert(handle.reviewEvidence.files.includes(external));
  assert(handle.reviewEvidence.files.includes(path.join(externalDir, 'linked.md')));
  await assert.rejects(fs.stat(path.join(handle.artifacts, 'input', 'project')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(handle.artifacts, 'frozen-source')), { code: 'ENOENT' });
  assert((await fs.readFile(path.join(handle.artifacts, 'review-checkpoint.json'), 'utf8')).includes(f.file.replaceAll('\\', '\\\\')));
  const checkpoint = await loadReviewCheckpoint(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert.equal(checkpoint.sourceMode, 'live');
  assert(checkpoint.files.some(([file]) => file === external));
});

test('combined scope/checklist and final submission preserve original proof and checklist completion', async t => {
  const f = await fixture(t);
  f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2', sourceId: 'R2' });
  let selections = 0;
  f.input.onScope = async () => { selections++; return { verification: { build: { status: 'passed' } } }; };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    const choose = () => submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    await assert.rejects(choose(), /not fully read/);
    await readAll();
    const checklist = await choose();
    assert.equal(checklist.items.length, 2); assert.equal(checklist.pending, 2);
    assert.equal(checklist.programEvidenceFiles.length, 1);
    assert(checklist.processFiles.includes(checklist.programEvidenceFiles[0]));
    await assert.rejects(submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'Missing proof.', citeIds: [], finish: true }), /No checked original evidence/);
    const actual = await read(f.file), citeIds = [actual.details.citation.citeId];
    const first = await submit('submit_review', { taskId: 'M01:R1', verdict: 'PASS', reason: 'Checked first original obligation.', citeIds, finish: true });
    assert.equal(first.pending, 1); assert.notEqual(first.complete, true);
    const remaining = await choose();
    assert.equal(selections, 1); assert.equal(remaining.pending, 1);
    assert.deepEqual(remaining.programEvidenceFiles, checklist.programEvidenceFiles);
    assert.equal(remaining.items[0].savedResult.judgement, 'PASS');
    const last = await submit('submit_review', { taskId: 'M01:R2', verdict: 'PASS', reason: 'Checked second original obligation.', citeIds, finish: true });
    assert.equal(last.complete, true); assert.equal(last.pending, 0);
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.metricObjectJudgements.length, 2);
  assert.equal(handle.collection, undefined);
});

test('unobserved reads, invented citations and reviewer notes cannot certify an item; honest UNVERIFIED remains available', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, read, submit, params }) => {
    await readAll(); await f.scope(submit);
    const unobserved = await read(f.file, { receipt: false });
    await assert.rejects(f.result(submit, [unobserved.details.citation.citeId]), /Unknown or unread/);
    await submit('review_notes', { note: 'I claim the code passes.' });
    const notes = path.join(path.dirname(JSON.parse(params.prompt).task.basisFiles[0]), '..', 'notes.json');
    const note = await read(notes);
    assert.equal(note.details.contextOnly, true); assert.equal(note.details.citation, undefined);
    await assert.rejects(f.result(submit, []), /No checked original evidence/);
    await f.result(submit, [], 'UNVERIFIED');
    await submit('finish_stop_review', { summary: 'Evidence is incomplete.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
});

test('a changed read dependency invalidates the review while unrelated edits do not', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit);
    const actual = await read(f.file);
    await fs.writeFile(path.join(f.root, 'unrelated.md'), 'An unrelated concurrent edit.\n');
    await f.result(submit, [actual.details.citation.citeId]);
    await fs.writeFile(f.file, 'The evidence changed after its item receipt.\n');
    await submit('finish_stop_review', { summary: 'A stale claim must not pass.' });
  }));
});

test('Git diff and untracked files are available as entry points without creating evidence receipts', async t => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet', f.root], { windowsHide: true });
  execFileSync('git', ['-C', f.root, 'add', 'spec.md'], { windowsHide: true });
  execFileSync('git', ['-C', f.root, '-c', 'user.name=RC Test', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'fixture'], { windowsHide: true });
  await fs.writeFile(f.file, 'Updated original value.\n');
  await fs.writeFile(path.join(f.root, 'new.md'), 'New untracked delivery.\n');
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const status = await submit('review_changes', {}); assert.match(status.text, /spec\.md/u); assert.match(status.text, /new\.md/u);
    assert.doesNotMatch(status.text, /\.runtime-correction/u, 'Program-owned notes and logs must not crowd the business change hints.');
    const diff = await submit('review_changes', { path: 'spec.md' }); assert.match(diff.text, /\+Updated original value/u);
    assert.equal(diff.navigationOnly, true);
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Diff alone is not acceptance evidence.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('Windows Git change hints do not invent edits for unchanged long original paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const long = path.join(f.root, ...Array.from({ length: 5 }, (_, index) => `${index}-` + 'original'.repeat(6)), 'long-business.md');
  assert(long.length > 300);
  await fs.mkdir(path.dirname(long), { recursive: true }); await fs.writeFile(long, 'Unchanged original document.\n');
  const git = args => execFileSync('git', ['-c', 'core.longpaths=true', '-C', f.root, ...args], { windowsHide: true });
  execFileSync('git', ['init', '--quiet', f.root], { windowsHide: true });
  git(['config', 'core.longpaths', 'false']);
  git(['add', '--', 'spec.md', long]);
  git(['-c', 'user.name=RC Test', '-c', 'user.email=rc@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'original long path']);
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const status = await submit('review_changes', {});
    assert.doesNotMatch(status.text, /long-business\.md/u, 'An unchanged long path is not a source edit.');
    const diff = await submit('review_changes', { path: long }); assert.equal(diff.text, '');
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Navigation does not grant citations.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('native batch edits and patch contents remain accessible as paged investigation hints', async t => {
  const f = await fixture(t);
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'native-edit', name: 'edit', input: { path: f.file,
      edits: Array.from({ length: 12 }, (_, index) => ({ oldText: `old ${index}`, newText: `new ${index}` })) } },
    { type: 'tool_use', id: 'native-patch', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: spec.md\n@@\n-before\n+patched value\n*** End Patch'.replaceAll('\n', '\r\n') } },
  ] } });
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll(); await f.scope(submit);
    const first = await submit('review_changes', {});
    assert.equal(first.navigationOnly, true); assert.equal(first.hostEditCount, 14); assert.equal(first.nextEditOffset, 10);
    const last = await submit('review_changes', { editOffset: first.nextEditOffset });
    assert.equal(last.nextEditOffset, null);
    const edits = [...first.hostEdits, ...last.hostEdits];
    assert.deepEqual(edits.filter(edit => edit.toolCallId === 'native-edit').map(edit => [edit.editIndex, edit.before, edit.after]),
      Array.from({ length: 12 }, (_, index) => [index, `old ${index}`, `new ${index}`]));
    assert(edits.every(edit => edit.path === f.file && edit.processFiles.length > 0));
    assert.match(edits.find(edit => edit.toolCallId === 'native-patch').patch, /\+patched value/u);
    assert.equal(edits[0].before, 'before'); assert.equal(edits[0].after, 'after');
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Edit hints do not establish acceptance.' });
  });
  assert.equal(handle.sourceCitations.length, 0);
});

test('incomplete review preserves checked items across one continuation and never claims the remaining checklist passed', async t => {
  const f = await fixture(t);
  f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2', sourceId: 'R2' });
  const handle = await f.run(async ({ brief, readAll, read, submit }) => {
    if (brief.attempt === 1) {
      await readAll(); await f.scope(submit);
      const actual = await read(f.file); await f.result(submit, [actual.details.citation.citeId]);
      await submit('review_notes', { note: 'One item is saved, another still needs investigation.' });
    } else {
      const state = await submit('review_checklist', {});
      assert.equal(state.pending, 1); assert.equal(state.items[0].savedResult.judgement, 'PASS');
      assert.equal((await submit('review_notes', {})).notes.length, 1);
    }
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  assert.equal(handle.collection.complete, false);
  assert.equal(handle.result.metricObjectJudgements.length, 1);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
});

test('new files after a searched inventory invalidate the review instead of proving the earlier search complete', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async ({ readAll, read, submit, tools }) => {
    await readAll(); await f.scope(submit);
    await tools.get('source_find').execute(crypto.randomUUID(), { path: f.root, pattern: 'spec.md' });
    const original = await read(f.file);
    await fs.writeFile(path.join(f.root, 'new-writer.mjs'), 'export const value = 0;\n');
    await f.result(submit, [original.details.citation.citeId]);
  }));
});

test('one session reuses reads across metrics while preserving process ownership, production evidence and M16 tracing', async t => {
  const f = await fixture(t), source = path.join(f.root, 'app.mjs'), testFile = path.join(f.root, 'app.test.mjs');
  await fs.writeFile(source, 'export const accept = value => value;\n'); await fs.writeFile(testFile, 'assert.equal(accept(1), 1);\n');
  const original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = Object.fromEntries(['M09', 'M12', 'M16'].map(id => [id, [{ ...original, objectId: `${id}:R1`, metricId: id, verificationTarget: 'IMPLEMENTATION' }]]));
  f.input.evidence.snapshot.entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'verify', name: 'Bash', input: { command: 'node --test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'verify', content: 'Exit code 0; verification passed.' }] } });
  const handle = await f.run(async ({ readAll, read, submit, tools }) => {
    await readAll(); const scope = await f.scope(submit);
    assert.deepEqual(tools.get('submit_review').parameters.properties.productionTrace.required,
      ['version', 'entryPoint', 'actualInput', 'producerToConsumer', 'stateful', 'statelessReason', 'stateTargets', 'targetRelations']);
    const sourceRead = await read(source), testRead = await read(testFile), id = sourceRead.details.citation.citeId;
    const save = (metricId, ids, extra = {}) => submit('submit_review', { taskId: `${metricId}:R1`, verdict: 'PASS', reason: 'The original value flows directly to the production result.', citeIds: ids, ...extra });
    await assert.rejects(save('M16', [testRead.details.citation.citeId]), /actually read SOURCE/);
    await assert.rejects(save('M16', [id]), /M16_PRODUCTION_TRACE/);
    await assert.rejects(save('M16', [id], { productionTrace: { version: 1, entryPoint: 'accept(value)', actualInput: 'Caller supplied value',
      producerToConsumer: 'The input flows directly to the return.', stateful: false, statelessReason: 'No state.', stateTargets: [] } }), /targetRelations/);
    await assert.rejects(save('M12', [id]), /actually read PROCESS/);
    await save('M09', [id]);
    await save('M16', [id], { productionTrace: { version: 1, entryPoint: 'accept(value)', actualInput: 'Caller supplied value',
      producerToConsumer: 'The input parameter flows unchanged to the arrow return.', stateful: false,
      statelessReason: 'This production function has no state reads or writes.', stateTargets: [], targetRelations: [] } });
    await read(scope.processFiles.find(file => file.endsWith('000002-0000.txt')));
    const process = await read(scope.processFiles.find(file => file.endsWith('000003-0000.txt')));
    await save('M12', [process.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'All three original items have separate checked receipts.' });
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(handle.result.metricObjectJudgements.map(row => row.objectId).sort(), ['M09:R1', 'M12:R1', 'M16:R1']);
  assert.equal(handle.sourceCitations.filter(citation => citation.path === source).length, 2);
  assert.equal(handle.proofs['M16:R1'].sourceCiteIds.length, 1);
});

test('missing execution records and completion claims cannot become runtime PASS or DEVIATION', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M12: [{ ...original, objectId: 'M12:R1', metricId: 'M12', verificationTarget: 'PROCESS' }] };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const scope = await f.scope(submit), process = await read(scope.processFiles[0]);
    const checklist = await submit('review_checklist', {});
    assert.deepEqual(checklist.items[0].executionProof, { forVerdicts: ['PASS', 'DEVIATION'], availableResultFileCount: 0 });
    assert.equal(checklist.processEvidence.navigationOnly, true);
    assert.equal(checklist.processEvidence.executionResultFileCount, 0);
    for (const verdict of ['PASS', 'DEVIATION']) await assert.rejects(submit('submit_review', { taskId: 'M12:R1', verdict,
      reason: 'The report alone should not determine execution.', citeIds: [process.details.citation.citeId] }), /attributable original execution result/);
    await assert.rejects(submit('submit_finding', { deviationKey: 'missing', rootCauseId: 'missing', severity: 'error', reason: 'No execution record is present.',
      expectedConstraint: 'Execute verification.', violatedGroundTruthIds: ['R1'], citeIds: [process.details.citation.citeId] }), /attributable original execution result/);
    await submit('submit_review', { taskId: 'M12:R1', verdict: 'UNVERIFIED', reason: 'No attributed execution result is available.', citeIds: [] });
    await submit('finish_stop_review', { summary: 'Execution remains unverified.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED'); assert.deepEqual(handle.result.findings, []);
});

test('long process history points directly to a late invocation and result without granting proof from the guide', async t => {
  const f = await fixture(t), original = f.input.request.population.metrics.M01[0];
  f.input.request.population.metrics = { M12: [{ ...original, objectId: 'M12:R1', metricId: 'M12', verificationTarget: 'PROCESS' }] };
  f.input.evidence.snapshot.entries.push(...Array.from({ length: 25 }, (_, index) => ({ type: 'assistant', message: { content: `Earlier observation ${index}.` } })),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'late-run', name: 'Bash', input: { command: 'node --test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'late-run', content: 'Exit code 0; tests passed.' }] } });
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.equal(checklist.processEvidence.executionResultFileCount, 1);
    const sample = checklist.processEvidence.executionSamples[0];
    assert(!checklist.processFiles.includes(sample.resultFile), 'The execution lies beyond the first navigation page.');
    assert.equal(sample.invocationFileCount, 1); assert.equal(sample.invocationFiles.length, 1);
    const save = citeIds => submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'The matching original invocation and successful result were read.', citeIds, finish: true });
    await assert.rejects(save([]), /No checked original evidence/);
    const result = await read(sample.resultFile);
    await assert.rejects(save([result.details.citation.citeId]), /attributable original execution result/);
    await read(sample.invocationFiles[0]);
    await save([result.details.citation.citeId]);
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
});

test('optional file quality shares the session and requires the actual declared delivery bytes', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other.md'); await fs.writeFile(other, 'An unrelated file.\n');
  f.input.request.fileQualityReviewEnabled = true;
  f.input.request.artifactCandidates = [{ artifactId: 'spec', files: [{ path: 'spec.md', sha256: sha256(await fs.readFile(f.file)) }] }];
  f.input.request.workflowArtifacts = [{ name: 'spec', stage: 'design', metrics: ['M01'] }];
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); await submit('review_scope', { stopClassification: 'STAGE_COMPLETE', stage: 'design', summary: 'The design delivery is complete.' });
    const unrelated = await read(other);
    const quality = ids => submit('submit_review', { taskId: 'file:spec.md', verdict: 'PASS', reason: 'The declared document content is correct.', citeIds: ids });
    await assert.rejects(quality([unrelated.details.citation.citeId]), /actual current delivery/);
    const actual = await read(f.file); await quality([actual.details.citation.citeId]); await f.result(submit, [actual.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Metric and file quality have independent receipts.' });
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.fileAssessments[0].status, 'PASS');
});

test('cancellation rejects late submissions and cannot return a partial success', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(f.run(async ({ readAll, read, submit }) => {
    await readAll(); await f.scope(submit); const actual = await read(f.file);
    controller.abort(new Error('The business input was replaced.'));
    await assert.rejects(f.result(submit, [actual.details.citation.citeId]));
  }, { abortSignal: controller.signal }));
});

test('M08 keeps original Skill conditions and dependencies mandatory within the same review session', async t => {
  const f = await fixture(t), skillId = 'verify-original', sourceRoot = path.join(f.root, 'skills', skillId);
  await fs.mkdir(path.join(sourceRoot, 'references'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'SKILL.md'), '# Original Skill\nRun verification before completion. Preserve the original input; see references/conditions.md.\n');
  await fs.writeFile(path.join(sourceRoot, 'references/conditions.md'), 'The original input must remain unchanged even if optional configuration is absent.\n');
  const source = await scanSkillDirectory(sourceRoot);
  const saved = await persistSkillGroundTruth({ projectRoot: f.root, taskId: f.task.taskId, skillId, skillDigest: source.digest,
    constraints: [{ constraintId: 'verify', statement: 'Run verification before completion.', modality: 'MUST', kind: 'STEP', sourceRef: 'SKILL.md#L2', dependsOn: ['preserve'] },
      { constraintId: 'preserve', statement: 'Preserve the original input.', modality: 'MUST', kind: 'CONDITION', sourceRef: 'references/conditions.md#L1' }], taskOverlays: [] });
  f.input.request.population.metrics = { M08: saved.document.constraints.map(constraint => ({ objectId: `M08:${skillId}:${constraint.constraintId}`, metricId: 'M08',
    sourceId: `${skillId}:${constraint.constraintId}`, sourceRevisionId: `${skillId}@${saved.document.version}`, description: constraint.statement,
    skillId, authority: 'MATERIAL_DERIVED', hard: true, verificationTarget: 'PROCESS' })) };
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const scope = await f.scope(submit), process = await read(scope.processFiles[0]);
    const save = item => submit('submit_review', { taskId: item.objectId, verdict: 'PASS', reason: 'Original conditions and attributed process evidence were checked.', citeIds: [process.details.citation.citeId] });
    const checklist = await submit('review_checklist', {});
    await assert.rejects(save(checklist.items[0]), /Original Skill basis not fully read/);
    const readFiles = new Set();
    for (const item of checklist.items) for (const file of item.originalSkillBasis.requiredFiles) if (!readFiles.has(file)) { await read(file); readFiles.add(file); }
    assert(readFiles.has(path.join(sourceRoot, 'SKILL.md'))); assert(readFiles.has(path.join(sourceRoot, 'references/conditions.md')));
    for (const item of checklist.items) await save(item);
    await submit('finish_stop_review', { summary: 'Both original Skill obligations were separately checked in one session.' });
  });
  assert.equal(f.calls.length, 1); assert.equal(handle.result.metricObjectJudgements.length, 2);
});

test('mixed Skill applicability, missing execution and real implementation keep independent verdicts and the full denominator', async t => {
  const f = await fixture(t), source = path.join(f.root, 'app.mjs');
  await fs.writeFile(source, 'export const accept = value => value + 1;\n');
  const claims = [
    { claimId: 'R1', text: 'Allowed inputs for accept(value) are finite numbers only; non-number inputs are outside scope. Return each allowed input plus one without state.', verificationTarget: 'IMPLEMENTATION' },
    { claimId: 'R2', text: 'Actually run node --test before completion, independently of Skill applicability.', verificationTarget: 'PROCESS' },
  ].map(claim => ({ ...claim, revisionId: `${claim.claimId}@1`, category: 'requirements', status: 'ACTIVE', severity: 'HARD', authority: 'USER_EXPLICIT', applicabilityKind: 'CURRENT_TASK' }));
  const truth = { version: 1, digest: sha256(claims), claims };
  f.input.evidence.groundTruth = truth;
  await fs.writeFile(f.input.request.groundTruthPath, JSON.stringify(truth));
  f.input.evidence.snapshot.entries = [{ type: 'user', message: { content: claims.map(claim => claim.text).join('\n') } },
    { type: 'assistant', message: { content: 'The implementation and verification are complete.' } }];
  const external = path.join(path.dirname(f.root), `skills-${path.basename(f.root)}`);
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  f.input.skillRoots = [external];
  const skill = await prepareMixedSkillEvaluation({ projectRoot: f.root, taskId: f.task.taskId, skillRoots: [external] });
  const population = await buildMetricPopulation({ projectRoot: f.root, taskId: f.task.taskId, groundTruth: truth, skillDocuments: [skill] });
  f.input.request.population = { ...population, metrics: Object.fromEntries(Object.entries(population.metrics).filter(([id]) => ['M08', 'M12', 'M16'].includes(id))) };
  assert.deepEqual(Object.values(f.input.request.population.metrics).flat().map(item => item.objectId).sort(), Object.keys(MIXED_SKILL_EXPECTED).sort());
  const handle = await f.run(async ({ readAll, read, submit }) => {
    await readAll(); const checklist = await submit('review_checklist', { stopClassification: 'TASK_COMPLETE' });
    assert.equal(checklist.total, 4); assert.equal(checklist.pending, 4);
    const skillItem = checklist.items.find(item => item.metricId === 'M08');
    assert.deepEqual(skillItem.proofOwners, ['PROCESS']);
    assert.deepEqual(checklist.items.find(item => item.metricId === 'M16').proofOwners, ['SOURCE']);
    assert(checklist.items.filter(item => item.metricId === 'M12').every(item => item.proofOwners.join() === 'PROCESS'));
    assert.equal(checklist.processEvidence.originalUserFiles[0], checklist.processFiles[0]);
    assert.equal(checklist.processEvidence.originalUserFileCount, 1);
    const process = await read(checklist.processFiles[0]), processId = process.details.citation.citeId;
    await assert.rejects(submit('submit_review', { taskId: skillItem.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'The original task handles numbers only.', citeIds: [processId] }), /Original Skill basis not fully read/);
    for (const file of skillItem.originalSkillBasis.requiredFiles) await read(file);
    assert(skillItem.originalSkillBasis.requiredFiles.some(file => file.endsWith(`${path.sep}conditions.md`)), 'The dependent MAY condition remains mandatory source for the MUST step.');
    const actual = await read(source);
    await assert.rejects(submit('submit_review', { taskId: skillItem.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'A source citation cannot stand in for the original user input.', citeIds: [actual.details.citation.citeId] }), error => {
      assert.equal(error.code, 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE');
      assert(error.message.includes(skillItem.objectId)); assert(error.message.includes('source_read'));
      assert(error.message.includes(checklist.processEvidence.originalUserFiles[0])); return true;
    });
    assert.equal((await submit('review_checklist', {})).pending, 4, 'Hints and rejected submissions cannot auto-fill the checklist.');
    await assert.rejects(submit('submit_review', { taskId: 'M12:R1', verdict: 'PASS', reason: 'Source is not execution evidence.',
      citeIds: [actual.details.citation.citeId] }), error => error.code === 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE'
        && error.message.includes('M12:R1') && error.message.includes('No attributable execution-result file') && error.message.includes('UNVERIFIED'));
    await submit('submit_review', { taskId: skillItem.objectId, verdict: 'NOT_APPLICABLE',
      reason: 'The original numeric-only task does not activate the array-only Skill step; the separate user execution request remains mandatory.', citeIds: [processId] });
    for (const item of checklist.items.filter(item => item.metricId === 'M12')) await submit('submit_review', { taskId: item.objectId, verdict: 'UNVERIFIED',
      reason: 'No attributable invocation and execution result establish the requested node --test run.', citeIds: [] });
    await submit('submit_review', { taskId: 'M16:R1', verdict: 'PASS', reason: 'The exported numeric input flows through value + 1 directly to its caller without shared state.',
      citeIds: [actual.details.citation.citeId], productionTrace: { version: 1, entryPoint: 'Exported accept(value)', actualInput: 'Numeric caller input',
        producerToConsumer: 'The numeric input is incremented and returned directly to the importing caller.', stateful: false,
        statelessReason: 'The complete module contains only a pure expression and no state reads or writes.', stateTargets: [], targetRelations: [] }, finish: true });
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.fromEntries(handle.result.metricObjectJudgements.map(row => [row.objectId, row.judgement])), MIXED_SKILL_EXPECTED);
});

test('reading or searching mutable RC notes and logs neither grants proof nor invalidates original business evidence', async t => {
  const f = await fixture(t);
  const handle = await f.run(async ({ readAll, read, submit, tools, brief }) => {
    await readAll(); await f.scope(submit);
    const directory = path.dirname(path.dirname(brief.task.basisFiles[0])), log = path.join(directory, 'runtime-log.json');
    await fs.writeFile(log, 'This mutable RC log is only context.\n');
    await tools.get('source_grep').execute(crypto.randomUUID(), { path: directory, pattern: 'context', includeGenerated: true });
    const page = await read(log); assert.equal(page.details.contextOnly, true);
    await fs.appendFile(log, 'Another diagnostic arrived.\n');
    const original = await read(f.file); await f.result(submit, [original.details.citation.citeId]);
    await submit('finish_stop_review', { summary: 'Only original business evidence determines this result.' });
  });
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert(handle.reviewEvidence.files.every(file => !/runtime-log|observations\.jsonl|review-checkpoint|history-index/u.test(file)));
});

test('scope recovery is idempotent and rejects irrelevant stage text', async t => {
  const f = await fixture(t); let callbacks = 0;
  f.input.onScope = async () => { callbacks++; return null; };
  f.input.request.fixedStopClassification = { stopClassification: 'TASK_COMPLETE', stage: null };
  const handle = await f.run(async ({ readAll, submit }) => {
    await readAll();
    await assert.rejects(submit('review_scope', { stopClassification: 'TASK_COMPLETE', stage: 'implementation', summary: 'Completion.' }), /Only STAGE_COMPLETE/);
    const scope = await submit('review_scope', { stopClassification: 'TASK_COMPLETE', summary: 'Completion.' });
    assert.equal(scope.stage, null);
    const repeated = await f.scope(submit); assert.equal(repeated.reused, true);
    await assert.rejects(submit('review_scope', { stopClassification: 'INTERMEDIATE', summary: 'Changed scope.' }), /already fixed/);
    await f.result(submit, [], 'UNVERIFIED'); await submit('finish_stop_review', { summary: 'Unverified item saved.' });
  });
  assert.equal(callbacks, 1); assert.equal(handle.result.stopClassification, 'TASK_COMPLETE');
});
