import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { openSpecChecklistInventory, readOpenSpecPlan } from '../lib/openspec-plan.mjs';
import { recordProposalCoverage, selectApprovedPlanCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { beginOpenSpecRun, hasArmedOpenSpecApply, openSpecProposalReviewRequirements, registerOpenSpecPlanControl } from '../lib/openclaw/openspec-plan-control.mjs';
import { nativeTranscriptObservation } from '../lib/openclaw/native-transcript.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
import { mergeSemanticReview } from '../lib/result-processing.mjs';
import { createRoundMetadata, persistResult } from '../lib/result-store.mjs';

const changeName = 'restore-default';
const prefix = `openspec/changes/${changeName}`;
const tasksPath = `${prefix}/tasks.md`;
const proposalPath = `${prefix}/proposal.md`;
const specPath = `${prefix}/specs/default/spec.md`;
const originalRef = 'transcript:requested-default';
const originalText = 'Preserve the known input and return the documented default for unknown inputs.\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = { code: 'DOCUMENT_PLAN_READINESS_INVALID' };

const checklist = [
  '## Implementation',
  '- [ ] Preserve the known input and implement the unknown-input default.',
  '- [ ] Verify both behaviors using the repository test entry point.',
  '## Notes',
  '* [ ] Review the documented verification prerequisites before completion.',
  'Optional example: use a separate exploratory check when convenient.',
  '',
].join('\n');

async function fixture(t, { taskText = checklist, originals = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-plan-readiness-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, text) => {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text);
  };
  await write(tasksPath, taskText);
  await write(proposalPath, '# Proposal\nPreserve the known behavior and restore the default.\n');
  await write(specPath, '# Requirement\nBoth known and unknown inputs have the documented result.\n');
  const semantic = { artifactFiles: [tasksPath, proposalPath, specPath],
    ...(originals ? { originalRequirements: { digest: digest(originalText),
      userMessages: [{ ref: originalRef, text: originalText, sha256: digest(originalText) }] } } : {}) };
  const tools = await createDocumentTools({ projectRoot: root, semantic, requiredPlanReadiness: { changeName } });
  const inventory = openSpecChecklistInventory(Buffer.from(taskText), tasksPath);
  const read = (file, start, count) => tools.execute({ action: 'read', path: file, start, count });
  const acknowledgeTasks = async () => {
    for (const task of inventory.tasks) await read(task.path, task.line, 1);
  };
  const assessment = (overrides = {}) => ({ inventorySha256: inventory.sha256, status: 'READY',
    rows: inventory.tasks.map(task => ({ taskId: task.id, status: 'READY',
      reason: 'This is planned work with a documented verification route, not a claim of execution.',
      targets: [{ path: task.path, start: task.line, end: task.line }] })), ...overrides });
  return { root, write, tools, inventory, read, acknowledgeTasks, assessment, semantic };
}

test('the readiness inventory uses supported top-level Apply checkboxes under every heading', () => {
  const text = [
    '# Work',
    '- [ ] Implement the default.',
    '## Optional notes',
    '*[X]A real checkbox remains completion-blocking, even with UNVERIFIED prose.',
    '- Optional example outside the checklist.',
    '  Indented prose without a checkbox remains prose.',
    '+ [ ] A plus-marker lookalike is outside the Apply parser.',
    'Text [ ] is not a task.',
    '',
  ].join('\r\n');
  const inventory = openSpecChecklistInventory(Buffer.from(text), tasksPath);
  assert.equal(inventory.tasks.length, 2);
  assert.deepEqual(inventory.tasks.map(task => [task.path, task.line, task.text]), [
    [tasksPath, 2, '- [ ] Implement the default.\r'],
    [tasksPath, 4, '*[ ]A real checkbox remains completion-blocking, even with UNVERIFIED prose.\r'],
  ]);
  for (const task of inventory.tasks) {
    assert.equal(task.sha256, digest(task.text));
    assert.equal(task.id, digest(JSON.stringify({ path: task.path, line: task.line, text: task.text, sha256: task.sha256 })));
  }
  const marked = text.replace('[ ] Implement', '[x] Implement').replace('[X]A', '[ ]A');
  assert.deepEqual(openSpecChecklistInventory(Buffer.from(marked), tasksPath), inventory);
  assert.notEqual(openSpecChecklistInventory(Buffer.from(text.replace('default.', 'fallback.')), tasksPath).sha256, inventory.sha256);
  assert.notEqual(openSpecChecklistInventory(Buffer.from(`\n${text}`), tasksPath).sha256, inventory.sha256);
  assert.notEqual(openSpecChecklistInventory(Buffer.from(text), 'openspec/changes/another-change/tasks.md').sha256, inventory.sha256);
});

test('opt-in readiness rejects indented checkbox syntax while default Apply keeps its existing parser', async t => {
  for (const indent of ['  - [ ]', '\t- [x]', ' \t * [ ]', '\t *[X]']) await t.test(JSON.stringify(indent), async t => {
    const f = await approvalFixture(t);
    const mixed = `${checklist}${indent} An unresolved nested task must not disappear from readiness.\n`;
    await f.write(tasksPath, mixed);
    const ordinary = await readOpenSpecPlan(f.root, changeName);
    assert.equal(ordinary.taskCount, f.inventory.tasks.length, 'The default Apply parser remains unchanged.');
    assert.equal(Object.hasOwn(ordinary, 'checklistInventory'), false);
    const strict = await readOpenSpecPlan(f.root, changeName, { includeChecklist: true });
    assert.equal(strict.checklistInventory, null);
    assert.equal(strict.checklistInventoryIssue, 'UNSUPPORTED_TASK_SYNTAX');
    assert.equal(openSpecChecklistInventory(Buffer.from(mixed), tasksPath), null);
    await assert.rejects(createDocumentTools({ projectRoot: f.root, semantic: f.semantic,
      requiredPlanReadiness: { changeName } }), {
      code: 'DOCUMENT_PLAN_READINESS_UNVERIFIED', reason: 'UNSUPPORTED_TASK_SYNTAX' });
    // Even a host-shaped top-level-only READY cannot make the ambiguous current
    // inventory eligible. Unsupported syntax grants no new original obligation.
    const scope = strict.documents;
    const readiness = { ...f.readiness, scope };
    recordProposalCoverage(f.state, tasksPath, { ...f.coverage, scope }, { ...f.owner,
      result: { status: 'passed', diagnostics: [], metadata: { inputs: scope,
        semanticReview: { status: 'completed', planReadiness: readiness } } } });
    assert.match((await f.rejected('approve', { ...f.approveArgs, expectedRevision: strict.revision })).message, /not READY/u);
    await f.rejected('arm', { expectedRevision: strict.revision, expectedInventorySha256: '0'.repeat(64), applyRunId: 'ambiguous-apply' });
  });
});

test('empty, malformed, oversized, or foreign checklist inventory remains unavailable', () => {
  for (const bytes of [Buffer.from('# Notes\nOptional example only.\n'), Buffer.from([0xff]),
    Buffer.from(Array.from({ length: 129 }, (_, index) => `- [ ] Task ${index}`).join('\n')),
    Buffer.from(`- [ ] ${'x'.repeat(4096)}`)]) {
    assert.equal(openSpecChecklistInventory(bytes, tasksPath), null);
  }
  assert.equal(openSpecChecklistInventory(Buffer.from('- [ ] A'), '../tasks.md'), null);
  assert.equal(openSpecChecklistInventory(Buffer.from('- [ ] A'), 'openspec/changes/Invalid/tasks.md'), null);
  assert.equal(openSpecChecklistInventory(Buffer.from(Array.from({ length: 128 }, (_, index) => `- [ ] Task ${index}`).join('\n')), tasksPath).tasks.length, 128);
});

test('checkbox navigation is paged and grants no source-reading authority', async t => {
  const f = await fixture(t);
  const page = await f.tools.execute({ action: 'plan_checklist', start: 1, count: 1 });
  assert.deepEqual(page, { navigationOnly: true, inventorySha256: f.inventory.sha256,
    total: 3, items: [f.inventory.tasks[0]], nextStart: 2 });
  const last = await f.tools.execute({ action: 'plan_checklist', start: 2, count: 20 });
  assert.deepEqual(last.items, f.inventory.tasks.slice(1));
  assert.equal(last.nextStart, null);
  await assert.rejects(f.tools.verifyPlanReadiness(f.assessment()), invalid);
});

test('an encoded oversized task page fails explicitly without an empty page or invented progress', async t => {
  for (const character of ['\\', '"']) await t.test(character === '\\' ? 'backslashes' : 'quotes', async t => {
    const taskText = `- [ ] ${character.repeat(4090)}`;
    const f = await fixture(t, { taskText });
    assert.equal(Buffer.byteLength(f.inventory.tasks[0].text), 4096, 'the raw task satisfies the inventory limit');
    for (const count of [1, 20]) await assert.rejects(f.tools.execute({ action: 'plan_checklist', count }),
      /DOCUMENT_PLAN_READINESS_LIMIT/u, 'an unreadable first item must not be silently skipped');
    await assert.rejects(f.tools.verifyPlanReadiness(f.assessment()), invalid,
      'the failed navigation page grants no source acknowledgement');
  });
});

test('all future unchecked work may be READY using current read citations without execution claims', async t => {
  const f = await fixture(t);
  await f.acknowledgeTasks();
  const receipt = await f.tools.verifyPlanReadiness(f.assessment());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.inventorySha256, f.inventory.sha256);
  assert.equal(receipt.status, 'READY');
  assert.deepEqual(receipt.tasks, f.inventory.tasks);
  assert.equal(receipt.rows.length, 3, 'optional prose requires no invented row, while a checkbox under Notes does');
  assert.deepEqual(receipt.rows.map(row => row.targets[0]), f.inventory.tasks.map(task => ({
    path: task.path, start: task.line, end: task.line, sha256: digest(checklist),
  })));
  assert.deepEqual(receipt.scope.map(file => file.path), [tasksPath, proposalPath, specPath]);
  assert(receipt.rows.every(row => row.status === 'READY' && row.sources.length === 0));
});

test('task source acknowledgements do not depend on having native user messages', async t => {
  const f = await fixture(t, { originals: false });
  await f.acknowledgeTasks();
  assert.equal((await f.tools.verifyPlanReadiness(f.assessment())).status, 'READY');
});

test('missing, duplicated, foreign, nonblocking, and inconsistent task judgements are rejected', async t => {
  const f = await fixture(t);
  await f.acknowledgeTasks();
  const complete = f.assessment();
  const cases = [
    { ...complete, rows: complete.rows.slice(1) },
    { ...complete, rows: [complete.rows[0], complete.rows[0], complete.rows[2]] },
    { ...complete, rows: [{ ...complete.rows[0], taskId: 'f'.repeat(64) }, ...complete.rows.slice(1)] },
    { ...complete, inventorySha256: '0'.repeat(64) },
    { ...complete, rows: [{ ...complete.rows[0], status: 'NOT_APPLICABLE' }, ...complete.rows.slice(1)] },
    { ...complete, rows: [{ ...complete.rows[0], reason: ' ' }, ...complete.rows.slice(1)] },
    { ...complete, rows: [{ ...complete.rows[0], targets: [] }, ...complete.rows.slice(1)] },
    { ...complete, rows: [{ ...complete.rows[0], status: 'UNVERIFIED' }, ...complete.rows.slice(1)] },
    { ...complete, status: 'UNVERIFIED' },
  ];
  for (const value of cases) await assert.rejects(f.tools.verifyPlanReadiness(value), invalid);
});

test('an acknowledged different range or document cannot stand in for the actual checkbox', async t => {
  const f = await fixture(t);
  await f.read(proposalPath, 1, 2);
  await f.read(tasksPath, 1, 1);
  await f.acknowledgeTasks();
  const value = f.assessment();
  for (const target of [{ path: tasksPath, start: 1, end: 1 }, { path: proposalPath, start: 2, end: 2 },
    { path: tasksPath, start: 2, end: 4 }, { path: 'outside.md', start: 1, end: 1 }]) {
    await assert.rejects(f.tools.verifyPlanReadiness({ ...value,
      rows: [{ ...value.rows[0], targets: [target] }, ...value.rows.slice(1)] }), invalid);
  }
});

test('known required verification blockers stay separate from production coverage and cannot aggregate READY', async t => {
  const f = await fixture(t, { taskText: '- [ ] Implement the requested behavior.\n- [ ] Perform the required verification; its execution prerequisite is unavailable.\n' });
  await f.acknowledgeTasks();
  const complete = f.assessment();
  for (const status of ['BLOCKED', 'UNVERIFIED']) {
    const rows = [complete.rows[0], { ...complete.rows[1], status,
      reason: 'The original mandatory verification remains required; its unresolved execution prerequisite prevents readiness.' }];
    await assert.rejects(f.tools.verifyPlanReadiness({ ...complete, rows }), invalid);
    const receipt = await f.tools.verifyPlanReadiness({ ...complete, status, rows });
    assert.equal(receipt.status, status);
    assert.deepEqual(receipt.tasks, f.inventory.tasks, 'the unavailable task is retained without an inferred deletion or exemption');
  }
});

test('issued original anchors bind readiness reasons and are reverified without inventing authority', async t => {
  const f = await fixture(t);
  await f.acknowledgeTasks();
  const value = f.assessment();
  const foreign = { ...value.rows[0], originalSourceAnchorIds: [`original-source-${'0'.repeat(64)}`] };
  await assert.rejects(f.tools.verifyPlanReadiness({ ...value, rows: [foreign, ...value.rows.slice(1)] }), invalid);
  const { anchor } = await f.tools.execute({ action: 'read_original', ref: originalRef, start: 1, count: 1 });
  const row = { ...value.rows[0], originalSourceAnchorIds: [anchor.anchorId] };
  const receipt = await f.tools.verifyPlanReadiness({ ...value, rows: [row, ...value.rows.slice(1)] });
  assert.deepEqual(receipt.rows[0].sources, [anchor]);
  await assert.rejects(f.tools.verifyPlanReadiness({ ...value,
    rows: [{ ...row, originalSourceAnchorIds: [anchor.anchorId, anchor.anchorId] }, ...value.rows.slice(1)] }), invalid);
  f.semantic.originalRequirements.userMessages[0].text += 'Changed after disclosure.\n';
  await assert.rejects(f.tools.verifyPlanReadiness({ ...value, rows: [row, ...value.rows.slice(1)] }), /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u);
});

test('any current plan-byte race invalidates readiness, including an unreferenced scope file', async t => {
  for (const file of [tasksPath, specPath]) {
    await t.test(file === tasksPath ? 'checklist' : 'complete scope', async t => {
      const f = await fixture(t);
      await f.acknowledgeTasks();
      await f.write(file, file === tasksPath ? checklist.replace('unknown-input', 'unknown-value') : '# Changed requirement\n');
      await assert.rejects(f.tools.verifyPlanReadiness(f.assessment()), /DOCUMENT_EVIDENCE_CHANGED/u);
    });
  }
});

async function approvalFixture(t, { requirePlanReadiness = true } = {}) {
  const f = await fixture(t);
  await f.acknowledgeTasks();
  await f.read(specPath, 1, 2);
  const { anchor } = await f.tools.execute({ action: 'read_original', ref: originalRef, start: 1, count: 1 });
  const owner = { runId: 'proposal-run', taskId: 'task-readiness', sessionId: 'session-readiness' };
  const state = { projectRoot: f.root, nativeRunId: owner.runId, scopeTaskId: owner.taskId,
    sessionId: owner.sessionId, sessionKey: 'agent:main:readiness', projectScope: { fingerprint: 'readiness-project' } };
  const snapshot = await readOpenSpecPlan(f.root, changeName, { includeChecklist: true });
  assert.deepEqual(snapshot.checklistInventory, f.inventory);
  const readiness = { ...await f.tools.verifyPlanReadiness(f.assessment()), ...owner };
  const requirement = 'Implement the unknown-input default.';
  const requiredAtoms = [{ source: { ref: originalRef, sha256: digest(originalText), start: 1, end: 1 }, requirement }];
  const coverage = { schemaVersion: 1, ...owner, scope: readiness.scope,
    rows: [{ source: anchor, requirement, disposition: 'COVERED', reason: 'The current spec states the requested default.',
      targets: [{ path: specPath, start: 2, end: 2, sha256: digest('# Requirement\nBoth known and unknown inputs have the documented result.\n') }] }] };
  const publish = (value = readiness, overrides = {}) => {
    const result = { status: 'passed', diagnostics: [], metadata: { inputs: snapshot.documents,
      semanticReview: { status: 'completed', ...(value ? { planReadiness: value } : {}) } }, ...overrides };
    recordProposalCoverage(state, tasksPath, coverage, { ...owner, result });
  };
  const methods = new Map();
  const operator = { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
  const api = { registerGatewayMethod(name, handler) { methods.set(name, handler); } };
  registerOpenSpecPlanControl(api, {
    async openSpecProposalSession(query) {
      return query.runId === owner.runId && query.sessionId === state.sessionId && query.sessionKey === state.sessionKey
        && state.nativeRunId !== query.runId ? state.projectScope.fingerprint : null;
    },
    async openSpecPlanTarget(query) {
      if (query.runId !== state.nativeRunId || query.sessionId !== state.sessionId || query.sessionKey !== state.sessionKey) return null;
      return { state, projectRoot: f.root, requireProposalCoverage: true, requirePlanReadiness,
        readProposalSources: async () => [{ ref: originalRef, text: originalText }],
        current: async () => query.runId === state.nativeRunId };
    },
  });
  const request = async (action, extra = {}) => {
    let response;
    const params = { sessionKey: state.sessionKey, sessionId: state.sessionId, runId: state.nativeRunId, changeName, ...extra };
    await methods.get(`runtime-corrector.openspec.${action}`)({ params, client: operator,
      respond(...args) { response = args; } });
    assert(response, `The registered ${action} handler returned no response.`);
    const [ok, value, error] = response;
    return { ok, value, error };
  };
  const rpc = async (action, extra) => {
    const response = await request(action, extra);
    assert.equal(response.ok, true, response.error?.message);
    return response.value;
  };
  const rejected = async (action, extra) => {
    const response = await request(action, extra);
    assert.equal(response.ok, false, `Expected ${action} to reject the unverified plan.`);
    assert.equal(response.error?.code, 'CONFLICT');
    assert.equal(response.value, undefined);
    return response.error;
  };
  const approveArgs = { expectedRevision: snapshot.revision, requiredAtoms };
  const armArgs = approved => ({ expectedRevision: snapshot.revision, expectedInventorySha256: approved.inventorySha256,
    applyRunId: 'apply-run' });
  return { ...f, api, owner, state, snapshot, readiness, coverage, publish, rpc, rejected, approveArgs, armArgs };
}

test('registered strict approval rejects nonready or unbound evidence even when every original atom is COVERED', async t => {
  const scenarios = [
    ['missing readiness', () => null],
    ['blocked prerequisite', value => ({ ...value, status: 'BLOCKED', rows: value.rows.map((row, index) => index ? row : { ...row, status: 'BLOCKED' }) })],
    ['unverified prerequisite', value => ({ ...value, status: 'UNVERIFIED', rows: value.rows.map((row, index) => index ? row : { ...row, status: 'UNVERIFIED' }) })],
    ['forged READY aggregate', value => ({ ...value, rows: value.rows.map((row, index) => index ? row : { ...row, status: 'BLOCKED' }) })],
    ['wrong inventory', value => ({ ...value, inventorySha256: '0'.repeat(64) })],
    ['missing task row', value => ({ ...value, rows: value.rows.slice(1) })],
    ['duplicated task row', value => ({ ...value, rows: [value.rows[0], value.rows[0], value.rows[2]] })],
    ['foreign task', value => ({ ...value, rows: [{ ...value.rows[0], taskId: '0'.repeat(64) }, ...value.rows.slice(1)] })],
    ['foreign run', value => ({ ...value, runId: 'foreign-proposal' })],
    ['foreign session', value => ({ ...value, sessionId: 'foreign-session' })],
    ['foreign task owner', value => ({ ...value, taskId: 'foreign-task' })],
    ['partial scope', value => ({ ...value, scope: value.scope.slice(1) })],
    ['stale file version', value => ({ ...value, scope: value.scope.map((file, index) => index ? file : { ...file, sha256: '0'.repeat(64) }) })],
  ];
  for (const [name, transform] of scenarios) await t.test(name, async t => {
    const f = await approvalFixture(t);
    f.publish(transform(f.readiness));
    const selected = selectApprovedPlanCoverage(f.state, f.owner.runId, f.snapshot);
    assert.equal(selected.reviewStatus, 'PASSED', 'ordinary semantic pass and atom coverage are insufficient for opt-in readiness');
    assert(selected.rows.every(row => row.disposition === 'COVERED'));
    assert.match((await f.rejected('approve', f.approveArgs)).message, /not READY/u);
    await f.rejected('arm', { expectedRevision: f.snapshot.revision, expectedInventorySha256: '0'.repeat(64), applyRunId: 'apply-run' });
    beginOpenSpecRun(f.state, 'apply-run');
    assert.equal(hasArmedOpenSpecApply(f.state, 'apply-run'), false);
  });
});

test('same-publication complete READY recovers strict approval and arms the exact inventory', async t => {
  const f = await approvalFixture(t);
  f.publish({ ...f.readiness, status: 'UNVERIFIED', rows: f.readiness.rows.map(row => ({ ...row, status: 'UNVERIFIED' })) });
  await f.rejected('approve', f.approveArgs);
  f.publish();
  const approved = await f.rpc('approve', f.approveArgs);
  assert.equal(approved.status, 'APPROVED');
  assert.deepEqual(approved.planReadiness, { status: 'READY', inventorySha256: f.inventory.sha256 });
  const armed = await f.rpc('arm', f.armArgs(approved));
  assert.equal(armed.status, 'ARMED');
  assert.deepEqual(armed.planReadiness, approved.planReadiness);
  beginOpenSpecRun(f.state, 'apply-run');
  assert.equal(hasArmedOpenSpecApply(f.state, 'apply-run'), true);
});

test('a later complete publication cannot borrow an older READY receipt, and a fresh complete recheck recovers', async t => {
  const f = await approvalFixture(t);
  f.publish();
  f.publish(null);
  await f.rejected('approve', f.approveArgs);
  f.publish({ ...f.readiness, status: 'UNVERIFIED', rows: f.readiness.rows.map(row => ({ ...row, status: 'UNVERIFIED' })) });
  await f.rejected('approve', f.approveArgs);
  f.publish();
  assert.equal((await f.rpc('approve', f.approveArgs)).status, 'APPROVED');
});

test('a current blocked readiness publication revokes a pending strict arm before native Apply starts', async t => {
  const f = await approvalFixture(t);
  f.publish();
  const approved = await f.rpc('approve', f.approveArgs);
  await f.rpc('arm', f.armArgs(approved));
  f.publish({ ...f.readiness, status: 'BLOCKED', rows: f.readiness.rows.map((row, index) => index ? row : { ...row, status: 'BLOCKED' }) });
  await f.rejected('arm', f.armArgs(approved));
  beginOpenSpecRun(f.state, 'apply-run');
  assert.equal(hasArmedOpenSpecApply(f.state, 'apply-run'), false);
});

test('unflagged strict original coverage retains legacy approval without manufacturing readiness', async t => {
  const f = await approvalFixture(t, { requirePlanReadiness: false });
  f.publish(null);
  const approved = await f.rpc('approve', f.approveArgs);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(Object.hasOwn(approved, 'planReadiness'), false);
  const armed = await f.rpc('arm', f.armArgs(approved));
  assert.equal(armed.status, 'ARMED');
  assert.equal(Object.hasOwn(armed, 'planReadiness'), false);
  beginOpenSpecRun(f.state, 'apply-run');
  assert.equal(hasArmedOpenSpecApply(f.state, 'apply-run'), true);
});

test('the actual native reviewer binding publishes readiness after one bounded same-session format correction', async t => {
  const f = await fixture(t);
  t.after(() => releaseDocumentSessions(f.root));
  const requestPath = path.join(f.root, 'semantic-request.json');
  await fs.writeFile(requestPath, JSON.stringify(f.semantic));
  let documentTool;
  const calls = [];
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } }, logger: { warn() {} },
    registerTool(factory) { documentTool = factory; }, runtime: { version: '2026.7.1-2', agent: {
      async runEmbeddedAgent(params) {
        calls.push({ sessionId: params.sessionId, timeoutMs: params.timeoutMs });
        assert.match(params.extraSystemPrompt, /plan_checklist/u);
        assert(!params.extraSystemPrompt.includes(checklist), 'the complete fixture task text is obtained through exact private reads');
        assert.equal(documentTool({ sessionId: 'business', runId: params.runId }), null);
        assert.equal(documentTool({ sessionId: params.sessionId, runId: 'foreign-run' }), null);
        assert.equal(documentTool({ sessionId: params.sessionId, runId: params.runId, sandboxed: true }), null);
        const tool = documentTool({ sessionId: params.sessionId, runId: params.runId });
        assert(tool.parameters.properties.action.enum.includes('plan_checklist'));
        const call = async args => JSON.parse((await tool.execute('fixture-call', args)).content[0].text);
        const page = await call({ action: 'plan_checklist', count: 20 });
        assert.equal(page.inventorySha256, f.inventory.sha256);
        assert.equal(page.nextStart, null);
        for (const task of page.items) await call({ action: 'read', path: task.path, start: task.line, count: 1 });
        const original = await call({ action: 'read_original', ref: originalRef, start: 1, count: 1 });
        const rows = page.items.map((task, index) => ({ taskId: task.id, status: index ? 'READY' : 'BLOCKED',
          reason: index ? 'Future planned work does not claim execution.' : 'A required verification prerequisite remains unresolved.',
          targets: [{ path: task.path, start: task.line, end: task.line }], originalSourceAnchorIds: [original.anchor.anchorId] }));
        if (calls.length === 2) assert.match(params.prompt, /Readiness status must match/u);
        return { payloads: [{ text: JSON.stringify({ summary: 'The current plan retains a verification prerequisite.', findings: [], edits: [],
          planReadiness: { inventorySha256: page.inventorySha256, status: calls.length === 1 ? 'READY' : 'BLOCKED', rows } }) }], meta: {} };
      },
    } } };
  registerDocumentTools(api);
  const factory = createOpenClawReviewerFactory(api);
  const handle = await factory({ projectRoot: f.root, taskId: 'native-readiness', role: 'artifact-reviewer', pluginRoot: path.resolve('.'),
    reviewer: { session: 'detached', timeoutMs: 5000, formatRepairAttempts: 1 }, schema: REVIEW_SCHEMA,
    request: { semanticReviewRequestPath: requestPath }, evidence: { requiredPlanReadiness: { changeName },
      semanticRequest: f.semantic, snapshot: { entries: [{ type: 'user', uuid: 'requested-default', message: { content: originalText } }] } } });
  try {
    assert.equal(calls.length, 2, 'the existing format-repair allowance performs one correction without a new review stage');
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 1);
    assert(calls[1].timeoutMs <= calls[0].timeoutMs, 'the correction shares the original finite role deadline');
    assert.equal(handle.planReadiness.status, 'BLOCKED');
    assert.deepEqual(handle.planReadiness.tasks, f.inventory.tasks);
    assert.equal(handle.planReadiness.rows[0].sources[0].ref, originalRef);
    const request = JSON.parse(await fs.readFile(path.join(handle.requestDirectory, 'request.json'), 'utf8'));
    assert.equal(request.requiredPlanReadiness, undefined, 'private operational evidence is not promoted into a task authority field');
    const result = { diagnostics: [], diffs: [], metadata: { stage: 'proposal', artifactType: 'tasks', triggerFile: tasksPath,
      artifactFiles: [tasksPath, proposalPath, specPath], ruleSetIds: [], bundleComplete: true } };
    Object.assign(result.metadata, createRoundMetadata(result));
    mergeSemanticReview(result, { status: 'completed', summary: handle.result.summary, findings: [], edits: [], planReadiness: handle.planReadiness });
    assert.equal(result.status, 'pending', 'nonready typed evidence cannot produce ordinary PASSED feedback');
    const pending = result.diagnostics.find(item => item.ruleId === 'PLAN_READINESS_UNVERIFIED');
    assert.equal(pending.severity, 'pending');
    assert.equal(pending.path, tasksPath);
    assert.equal(pending.line, f.inventory.tasks[0].line);
    assert.equal(pending.evidence.length, 1);
    assert(pending.evidence[0].includes(`${tasksPath}:${f.inventory.tasks[0].line}: BLOCKED:`));
    assert(pending.evidence[0].includes(handle.planReadiness.rows[0].reason));
    assert.equal(result.diffs.length, 0, 'readiness uncertainty creates no automatic repair');
    const { roundFiles } = await persistResult({ result, output: { persist: true, mode: 'centralized' }, cwd: f.root,
      triggerFile: path.join(f.root, tasksPath) });
    const persisted = JSON.parse(await fs.readFile(roundFiles.find(file => path.basename(file) === 'result.json'), 'utf8'));
    assert.deepEqual(persisted.metadata.semanticReview.planReadiness, handle.planReadiness);
    assert.equal(persisted.status, 'pending');
    assert.deepEqual(persisted.diagnostics, [pending]);
  } finally { await handle.close(); }
  assert.equal(documentTool({ sessionId: handle.sessionId }), null);
});

test('READY produces no false pending result while a nonready plan preserves stronger existing errors', async t => {
  const f = await fixture(t);
  await f.acknowledgeTasks();
  const ready = await f.tools.verifyPlanReadiness(f.assessment());
  const makeResult = diagnostics => ({ diagnostics, diffs: [], metadata: { triggerFile: tasksPath } });
  const clean = makeResult([]);
  mergeSemanticReview(clean, { status: 'completed', summary: 'Planned work is ready.', findings: [], edits: [], planReadiness: ready });
  assert.equal(clean.status, 'passed');
  assert.deepEqual(clean.diagnostics, []);

  const value = f.assessment();
  const unverified = await f.tools.verifyPlanReadiness({ ...value, status: 'UNVERIFIED',
    rows: value.rows.map((row, index) => index ? row : { ...row, status: 'UNVERIFIED', reason: 'The necessary prerequisite remains unverified.' }) });
  const existing = { ruleId: 'EXISTING-PLAN-CONTRADICTION', severity: 'error', path: proposalPath, line: 2,
    message: 'The existing plan contradicts its original constraint.', evidence: ['Original plan evidence.'] };
  const failed = makeResult([existing]);
  mergeSemanticReview(failed, { status: 'completed', summary: 'A prerequisite remains unresolved.', findings: [], edits: [], planReadiness: unverified });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.diagnostics[0], existing);
  assert.equal(failed.diagnostics[1].ruleId, 'PLAN_READINESS_UNVERIFIED');
  assert.equal(failed.diagnostics[1].severity, 'pending');
  assert.equal(failed.diffs.length, 0);
});

test('readiness without staged atoms is freshly reviewed when external executor availability changes', async t => {
  const f = await fixture(t);
  t.after(() => releaseDocumentSessions(f.root));
  const requestPath = path.join(f.root, 'cache-readiness-request.json');
  await fs.writeFile(requestPath, JSON.stringify(f.semantic));
  let executorAvailable = true, documentTool;
  const calls = [];
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } }, logger: { warn() {} },
    registerTool(factory) { documentTool = factory; }, runtime: { version: '2026.7.1-2', agent: {
      async runEmbeddedAgent(params) {
        calls.push({ sessionId: params.sessionId, runId: params.runId, executorAvailable });
        const tool = documentTool({ sessionId: params.sessionId, runId: params.runId });
        const call = async args => JSON.parse((await tool.execute('cache-fixture', args)).content[0].text);
        const page = await call({ action: 'plan_checklist', count: 20 });
        const rows = [];
        for (const [index, task] of page.items.entries()) {
          await call({ action: 'read', path: task.path, start: task.line, count: 1 });
          rows.push({ taskId: task.id, status: !executorAvailable && index === page.items.length - 1 ? 'BLOCKED' : 'READY',
            reason: executorAvailable ? 'The documented executor is currently available for future planned work.'
              : 'The required external executor is currently unavailable; retain the mandatory task until its prerequisite is resolved.',
            targets: [{ path: task.path, start: task.line, end: task.line }] });
        }
        return { payloads: [{ text: JSON.stringify({ summary: 'Current verification prerequisites were reviewed.', findings: [], edits: [],
          planReadiness: { inventorySha256: page.inventorySha256, status: executorAvailable ? 'READY' : 'BLOCKED', rows } }) }], meta: {} };
      },
    } } };
  registerDocumentTools(api);
  const factory = createOpenClawReviewerFactory(api);
  const input = { projectRoot: f.root, taskId: 'cache-readiness', role: 'artifact-reviewer', pluginRoot: path.resolve('.'),
    reviewer: { session: 'detached', timeoutMs: 5000, formatRepairAttempts: 0 }, schema: REVIEW_SCHEMA,
    request: { semanticReviewRequestPath: requestPath }, evidence: { requiredPlanReadiness: { changeName }, semanticRequest: f.semantic,
      snapshot: { entries: [{ type: 'user', uuid: 'requested-default', message: { content: originalText } }] } } };
  assert.equal(input.evidence.requiredProposalReview, undefined, 'this path has no staged production-atom list');
  const before = digest(await fs.readFile(path.join(f.root, tasksPath)));
  const first = await factory(input);
  try { assert.equal(first.planReadiness.status, 'READY'); }
  finally { await first.close(); }

  executorAvailable = false; // External state intentionally does not enter the unchanged request/cache identity.
  const second = await factory(input);
  try {
    assert.equal(second.planReadiness.status, 'BLOCKED');
    assert(second.planReadiness.rows.some(row => row.status === 'BLOCKED'));
    assert.notEqual(second.envelope.document_cache_hit, true);
  } finally { await second.close(); }
  assert.equal(calls.length, 2, 'both observations must invoke the native runner instead of reusing old READY authority');
  assert.deepEqual(calls.map(call => call.executorAvailable), [true, false]);
  assert.equal(new Set(calls.map(call => call.sessionId)).size, 1, 'the existing private project session can be reused');
  assert.notEqual(calls[0].runId, calls[1].runId, 'each assessment has its own native invocation');
  assert.equal(digest(await fs.readFile(path.join(f.root, tasksPath))), before);
  const journalPath = path.join(f.root, '.runtime-correction/tasks/cache-readiness/journal/events.jsonl');
  const journal = (await fs.readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(!journal.some(event => event.type === 'DOCUMENT_CACHE_LOCATION_REJECTED'),
    'readiness bypasses the cache itself rather than attempting to replay and repair cached read citations');
});

test('operator preparation freezes readiness before the exact native source is claimed and cannot be weakened later', async t => {
  const f = await approvalFixture(t, { requirePlanReadiness: false });
  f.state.nativeRunId = 'idle-before-proposal';
  const requirement = f.approveArgs.requiredAtoms[0].requirement;
  const preparedArgs = { runId: f.owner.runId, sourceRunId: f.owner.runId, sourceSha256: digest(originalText),
    requirements: [{ start: 1, end: 1, requirement }], requirePlanReadiness: true };
  const prepared = await f.rpc('prepare', preparedArgs);
  assert.deepEqual(prepared, { status: 'PREPARED', runId: f.owner.runId, sourceRunId: f.owner.runId,
    changeName, requirementCount: 1, requirePlanReadiness: true });
  assert.deepEqual(await f.rpc('prepare', preparedArgs), prepared);
  await f.rejected('prepare', { ...preparedArgs, requirePlanReadiness: false });
  const { requirePlanReadiness: omitted, ...weakened } = preparedArgs;
  await f.rejected('prepare', weakened);

  beginOpenSpecRun(f.state, f.owner.runId, { proposalOwner: f.api });
  f.state.nativeRunId = f.owner.runId;
  const observed = nativeTranscriptObservation([{ id: 'requested-default', type: 'message',
    message: { role: 'user', content: originalText, idempotencyKey: `${f.owner.runId}:user` } }]);
  const review = openSpecProposalReviewRequirements(f.api, f.state, { changeName, observed });
  assert.equal(review.requirePlanReadiness, true);
  assert.equal(review.requiredAtoms.length, 1);
  assert.equal(review.requiredAtoms[0].source.ref, originalRef);
  assert.equal(review.requiredAtoms[0].requirement, requirement);

  f.publish(null);
  assert.match((await f.rejected('approve', f.approveArgs)).message, /not READY/u,
    'operator staging requires readiness even though the project target readiness flag is false');
  f.publish();
  const approved = await f.rpc('approve', f.approveArgs);
  assert.equal(approved.planReadiness.status, 'READY');
  assert.equal((await f.rpc('arm', f.armArgs(approved))).planReadiness.inventorySha256, f.inventory.sha256);
});
