import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { originalSourceCoverage, unstartedSourceCoverage, unverifiedSources } from '../lib/runtime-v2/stop-source-coverage.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { scriptedWorkspaceReview } from './helpers/scripted-workspace-review.mjs';

async function project(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-sdd-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return root;
}
const snapshot = text => ({ entries: [{ type: 'user', uuid: 'request', message: { content: text } }] });
const manifest = (root, text, extra = {}) => loadStopOriginalRequirements({ projectRoot: root, snapshot: snapshot(text),
  referenceTier: true, ...extra });

test('dense unbroken prose and unclosed markup preserve a trailing normative path and its line', { timeout: 10000 }, async t => {
  const text = '约'.repeat(128000) + ' follow contract.md';
  const body = ['# SDD', 'Required ' + '['.repeat(64000) + ' tail.md', 'Mandatory ' + '《'.repeat(64000) + ' extra.md'].join('\n');
  const root = await project(t, { 'contract.md': body, 'tail.md': 'Use zero.', 'extra.md': 'Keep the receipt.' });
  const basis = await manifest(root, text);
  assert.equal(basis.userMessages[0].sha256, sha256(text));
  assert.deepEqual(basis.referencedFiles.map(entry => entry.path), ['contract.md']);
  assert.deepEqual(basis.acceptanceSources.map(entry => [entry.path, entry.declaredBy.line, entry.sha256]), [
    ['contract.md', 1, sha256(body)], ['tail.md', 2, sha256('Use zero.')], ['extra.md', 3, sha256('Keep the receipt.')],
  ]);
});

test('whole SDD adopts normative relative Markdown references, separates examples and closes a cycle', async t => {
  const root = await project(t, {
    'docs/main.md': ['# SDD', '## 规范性附录', '- [附件甲](sub/a%20b.md#rule)', '### 资料性示例', '- [old](example.md)',
      '#### An old release', '- sample.md', '## Requirements', '附录为强制约束：`second.md`，`other.md` 仅供参考。',
      '```markdown', 'Required annex: pretend.md', '```'].join('\n'),
    'docs/sub/a b.md': 'The governing original is [main](../main.md).\nRequired annex: ../second.md.',
    'docs/second.md': 'No retries.', 'docs/example.md': 'Old.', 'docs/other.md': 'Old.',
  });
  const result = await manifest(root, '请依据 [主规范](docs/main.md) 验收。');
  assert.deepEqual(result.acceptanceSources.map(row => row.path), ['docs/main.md', 'docs/sub/a b.md', 'docs/second.md']);
  assert.deepEqual(result.acceptanceSources[1].declaredBy, { ref: 'docs/main.md', line: 3 });
  assert(result.acceptanceSources.every(row => row.sha256 && !row.issue));
});

test('explicit missing and unreadable annexes and indirect paths outside the authority stay visible', async t => {
  const root = await project(t, { 'sdd.md': 'Required annexes:\n- absent.md\n- ../external.md\n- material.pdf\n- .env.md\n- wire.proto',
    'material.pdf': Buffer.from([0, 1, 2]), '.env.md': 'private', 'wire.proto': 'message Limit {}' });
  const basis = await manifest(root, 'Implement sdd.md.');
  const sources = basis.acceptanceSources;
  assert.equal(sources.find(row => row.path === 'absent.md').issue, 'SOURCE_UNAVAILABLE');
  assert.equal(sources.find(row => row.path.endsWith('/external.md')).issue, 'SOURCE_NOT_ADMISSIBLE');
  assert.equal(sources.find(row => row.path === 'material.pdf').issue, 'SOURCE_UNREADABLE');
  assert.equal(sources.find(row => row.path === '.env.md').sha256, undefined);
  assert(sources.find(row => row.path === 'wire.proto').sha256);
});

test('reference-style annexes bind to their target and an explicitly named unlocated annex remains open', async t => {
  const root = await project(t, { 'docs/sdd.md': [
    '# Contract', 'Required [Annex B][sealed] and [Limits][].', 'Annex C is mandatory.', '附录甲必须遵循。',
    '## 附录甲', 'The ordinary rate is one.', '[sealed]: <annex b.md#zero>', '[Limits]: limits.md', 'Required [Other][not-defined].',
  ].join('\n'), 'docs/annex b.md': 'Zero.', 'docs/limits.md': 'At most one.' });
  const original = await manifest(root, 'Implement [the entire specification][primary].\n[primary]: docs/sdd.md');
  const sources = original.acceptanceSources;
  assert.deepEqual(sources.filter(row => row.sha256).map(row => row.path), ['docs/sdd.md', 'docs/annex b.md', 'docs/limits.md']);
  assert.deepEqual(sources.filter(row => row.issue).map(row => [row.path, row.issue, row.declaredBy.line]),
    [['docs/sdd.md [Annex C]', 'SOURCE_LINK_UNRESOLVED', 3], ['docs/sdd.md [Other]', 'SOURCE_LINK_UNRESOLVED', 9]]);
});

test('unclear annex authority stays open, and a later explicit declaration resolves the same file', async t => {
  const root = await project(t, { 'sdd.md': 'Appendix alpha.md accompanies this release.\nAppendix beta.md accompanies this release.\n'
    + 'The governing annex is beta.md.\nreport.md is a required deliverable.\nSee also appendix-example.md.',
    'alpha.md': 'Maybe applicable.', 'beta.md': 'Use zero.' });
  const basis = await manifest(root, 'Implement sdd.md.');
  assert.deepEqual(basis.acceptanceSources.map(row => row.path), ['sdd.md', 'alpha.md', 'beta.md']);
  assert.equal(basis.acceptanceSources[1].issue, 'SOURCE_ROLE_UNRESOLVED');
  assert.equal(basis.acceptanceSources[2].declaredBy.line, 3);
  assert(basis.acceptanceSources[2].sha256);
});

test('full-source scope survives reference count and upfront byte limits without expanding the legacy named-file tier', async t => {
  const names = Array.from({ length: 21 }, (_, i) => 'rule-' + i + '.md');
  const root = await project(t, Object.fromEntries(names.map((name, i) => [name, i === 0 ? 'A'.repeat(300000) : 'A'])));
  const basis = await manifest(root, 'Every file in this list is normative: ' + names.join(' '));
  assert.equal(basis.referencedFiles.length, 20);
  assert.equal(basis.referencedFiles[0].mandatory, false);
  assert.deepEqual(basis.acceptanceSources.map(source => source.path), names);
  assert(basis.acceptanceSources.every(source => source.sha256));
});

test('the task-start original supplies transitive annexes after the live root is edited', async t => {
  const original = Buffer.from('Mandatory annex: original.md.');
  const root = await project(t, { 'sdd.md': 'Mandatory annex: replacement.md.', 'original.md': 'Use zero.', 'replacement.md': 'Use three.' });
  const basis = await manifest(root, 'Implement sdd.md.', { readReferenceMaterials: async () =>
    [{ root, path: 'sdd.md', status: 'MODIFIED', original, bytes: original.length, sha256: sha256(original) }] });
  assert.deepEqual(basis.acceptanceSources.map(row => row.path), ['sdd.md', 'original.md']);
  assert.equal(basis.acceptanceSources[0].sha256, sha256(original));
});

test('an implicit project SDD and its annex stay in scope even above the legacy manifest limit', async t => {
  const root = await project(t, { 'AGENTS.md': '# SDD\nMandatory annex: rules.md.', 'rules.md': 'Sealed mode uses zero.' });
  const expected = ['AGENTS.md', 'rules.md'];
  const first = await manifest(root, 'Implement the release.');
  assert.deepEqual(first.acceptanceSources.map(row => row.path), expected);
  assert.equal(first.acceptanceSources[0].declaredBy.ref, 'project:instructions');
  const original = ('A'.repeat(120) + '\n').repeat(35000) + 'Mandatory annex: rules.md.';
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  const large = await manifest(root, 'Implement the release.');
  assert(!large.projectFiles.some(row => row.path === 'AGENTS.md'));
  assert.deepEqual(large.acceptanceSources.map(row => row.path), expected);
  assert.equal(large.acceptanceSources[0].sha256, sha256(original));
  assert.equal(large.acceptanceSources[0].lines, 35001);
});

test('a gap in either half of a split original line survives overlapping receipts and out-of-order reads', () => {
  const segments = [{ file: 'a', offset: 0, length: 3, hash: 'h1' }, { file: 'b', offset: 2, length: 4, hash: 'h2' }];
  const sources = [{ ref: 'user:1', sha256: 'whole', lines: 6, parts: segments }];
  const evidence = { snapshot: new Map([['a', { sha256: 'h1' }], ['b', { sha256: 'h2' }]]),
    reads: [{ path: 'b', start: 3, end: 4 }, { path: 'a', start: 1, end: 3 }, { path: 'b', start: 3, end: 3 }] };
  const interrupted = originalSourceCoverage(sources, evidence);
  assert.equal(interrupted.sources[0].readLines, 4);
  assert.deepEqual(interrupted.sources[0].unreadRanges, [[3, 4]]);
  assert.equal(interrupted.checklistSubmitted, false);
  assert.equal(unverifiedSources(interrupted).length, 1);
});

test('a short SDD in the initial message has a source even before a reviewer starts', () => {
  const user = text => ({ userMessages: [{ ref: 'initial', text, sha256: sha256(text) }] });
  assert.equal(unstartedSourceCoverage(user('Implement sdd.md.')), null);
  const coverage = unstartedSourceCoverage(user('# SDD\nSealed mode requires zero retries.'));
  assert.equal(coverage.sources[0].ref, 'initial');
  assert.deepEqual(coverage.sources[0].unreadRanges, [[1, 2]]);
});

test('a source with a saved checklist row still reports known unextracted lines', () => {
  const source = { ref: 'sdd.md', sha256: 'h', lines: 5, parts: [{ file: 'a', offset: 0, length: 5, hash: 'h' }] };
  const receipts = { snapshot: new Map([['a', { sha256: 'h' }]]), reads: [{ path: 'a', start: 1, end: 5 }] };
  const result = originalSourceCoverage([source], receipts, [{ source: { ref: source.ref, sha256: 'h' } }], new Map(),
    new Map([['sdd.md', [[4, 5], [3, 4]]]]));
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].readLines, 5);
  assert.deepEqual(result.sources[0].unextractedRanges, [[3, 5]]);
  assert.match(unverifiedSources(result)[0].reason, /3–5/u);
});

test('a fully read delegating SDD can explain why its independent obligations all come from its required annex', async t => {
  const root = await project(t, { 'sdd.md': 'All rules in annex.md are mandatory.', 'annex.md': 'The production return value must be zero.' });
  const text = 'Implement sdd.md.';
  const originalRequirements = await manifest(root, text);
  const task = await ensureTask({ projectRoot: root, sessionId: 'scope' });
  const input = { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 15000 }, evidence: { snapshot: snapshot(text), originalRequirements, groundTruth: { version: 0, claims: [] } },
    request: { reviewScope: { kind: 'workspace-stop' }, workflowStages: [], hook: { last_assistant_message: 'Task complete.' },
      population: { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } } };
  const handle = await scriptedWorkspaceReview(input, { script: async ({ task, call, read }) => {
    for (const file of task.basisFiles) await read(file);
    const items = [{ metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', text: 'Return zero.',
      path: path.join(root, 'annex.md'), lineStart: 1, lineEnd: 1 }];
    await assert.rejects(call('set_original_checklist', { items, noApplicableSources: [{ ref: 'unknown.md', reason: 'invalid' }] }),
      { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
    await assert.rejects(call('set_original_checklist', { items, unextractedRanges: [{ ref: 'annex.md', start: 1, end: 2 }] }),
      { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
    await call('set_original_checklist', { items, noApplicableSources: [{ ref: 'sdd.md', reason: 'Delegates the rules to annex.md.' }] });
    await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    await call('finish_stop_review', { summary: 'Scanned the release contract.' });
  } });
  assert.equal(handle.reviewCompleted, true);
  assert.equal(handle.result.sourceCoverage.sources[0].disposition, 'NO_APPLICABLE_REQUIREMENT');
  assert.equal(handle.result.sourceCoverage.sources[1].disposition, 'REPRESENTED');
  await handle.close();
});

test('a checked long original group covers only explicitly located member lines', async t => {
  const entries = Array.from({ length: 150 }, (_, i) =>
    'Channel ' + i + ' must retain its distinct processing record. ' + 'The configured member result is mandatory. '.repeat(3));
  const memberLines = entries.map((_, index) => index + 2);
  const original = '# Channel provisions\n' + entries.join('\n');
  const delivered = 'export const enabled = id => Number.isSafeInteger(id) && id >= 0 && id < 150;\n';
  const text = 'Implement all requirements in annex.md.';

  for (const mode of ['all-members', 'one-omission', 'missing-proof']) await t.test(mode, async sub => {
    const root = await project(sub, { 'annex.md': original, 'delivery.mjs': delivered });
    const source = path.join(root, 'annex.md'), delivery = path.join(root, 'delivery.mjs');
    const originalRequirements = await manifest(root, text);
    const task = await ensureTask({ projectRoot: root, sessionId: 'member-lines' });
    const input = { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', schema: STOP_REVIEW_SCHEMA,
      reviewer: { timeoutMs: 15000 }, evidence: { snapshot: snapshot(text), originalRequirements, groundTruth: { version: 0, claims: [] } },
      request: { reviewScope: { kind: 'workspace-stop' }, workflowStages: [], hook: { last_assistant_message: 'Task complete.' },
        population: { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } } };
    const expectedMembers = memberLines.filter(line => mode !== 'one-omission' || line !== 87);
    let finished, optionalFailure;
    const handle = await scriptedWorkspaceReview(input, { script: async ({ task: assigned, call, read }) => {
      for (const file of assigned.basisFiles) await read(file);
      const group = { metricId: 'M16', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
        text: 'Compare each separately located channel record with the current implementation.',
        path: source, lineStart: 2, lineEnd: 151, memberLines: expectedMembers };
      try {
        await assert.rejects(call('append_original_checklist', { items: [{ ...group, memberLines: [1, 2] }] }),
          { code: 'STOP_ORIGINAL_CHECKLIST_INVALID' });
        await call('append_original_checklist', { items: [group] });
      } catch (error) { optionalFailure = error; throw error; }
      await call('seal_original_checklist', {});
      const page = JSON.parse((await call('review_checklist', {
        stopClassification: 'TASK_COMPLETE', completionClaim: true,
      })).content[0].text);
      const item = page.items[0];
      assert.deepEqual(item.originalSource.memberLines, expectedMembers);
      assert.equal(item.groupCheckRequired, true);
      const checkedGroups = [];
      if (mode !== 'missing-proof') {
        await read(delivery);
        checkedGroups.push({ taskIds: [item.taskId], method: 'Checked each declared member against the current source.',
          citations: [{ path: delivery, start: 1, end: 1 }] });
      }
      finished = JSON.parse((await call('finish_stop_review', { summary: 'Finished the task review.', checkedGroups })).content[0].text);
    } });
    sub.after(() => handle.close());
    assert.equal(optionalFailure, undefined);
    assert.equal(finished?.complete, true);
    assert.equal(handle.reviewCompleted, mode === 'all-members');
    const coverage = handle.result.sourceCoverage.sources.find(row => row.ref === 'annex.md');
    if (mode === 'all-members') assert.equal(coverage.disposition, 'REPRESENTED');
    else assert.deepEqual(coverage.unextractedRanges, [mode === 'one-omission' ? [87, 87] : [2, 151]]);
  });
});
