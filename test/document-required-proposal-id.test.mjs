import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDocumentTools, originalRequirementCoverageSchema, registerDocumentTools } from '../lib/document-tools.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { recordProposalCoverage, sealRequiredProposalCoverage, selectApprovedPlanCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { buildOriginalRequirements, writeOriginalRequirementSources } from '../lib/runtime-v2/original-requirements.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
import { validateJsonSchema } from '../lib/json-schema-validator.mjs';

const plan = 'openspec/changes/record-import/proposal.md';
const spec = 'openspec/changes/record-import/specs/records/spec.md';
const reference = 'import-notes.md';
const ref = 'transcript:import-request';
const originalText = 'Validate records before import and preserve original records after validation failures.\nKeep configuration separate.\n';
const requirements = ['Validate every record before import.', 'Preserve the original record when validation fails.'];
const invalid = { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' };

async function fixture(t, { text = originalText, required = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'required-proposal-id-')));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (file, value) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), value); };
  await write(plan, '# Import\nValidate before importing.\nPreserve prior records on validation failure.\n');
  await write(spec, '# Records\nValidation precedes import.\n');
  await write(reference, 'An implementation reference is not a plan artifact.\n');
  const snapshot = { entries: [{ type: 'user', uuid: 'import-request', message: { content: text } }] };
  const original = await buildOriginalRequirements({ projectRoot: root, snapshot });
  const requestPath = path.join(root, 'request/request.json');
  const originalRequirements = await writeOriginalRequirementSources(path.dirname(requestPath), original, { inlineBudget: 0 });
  const source = createOriginalSourceAnchor({ ref, sha256: sha256(text), bytes: Buffer.from(text), start: 1, end: 1 });
  const requiredAtoms = requirements.map(requirement => ({ source, start: 1, end: 1, requirement }));
  const semantic = { artifactFiles: [plan], originalRequirements, workflow: { targetFiles: [plan], editableArtifactFiles: [plan],
    incomingEdges: [{ sourceFiles: [spec] }], groundTruthInputs: [{ status: 'ready', files: [reference] }] } };
  await fs.writeFile(requestPath, JSON.stringify(semantic));
  const open = atoms => createDocumentTools({ projectRoot: root, requestPath, semantic, requiredProposalReview: atoms ? { requiredAtoms: atoms } : null });
  const tools = await open(required ? requiredAtoms : null);
  const page = required ? await tools.execute({ action: 'required_proposal', start: 1, count: 20 }) : null;
  const readOriginal = (start = 1) => tools.execute({ action: 'read_original', ref, start, count: 1 });
  const readPlan = () => tools.execute({ action: 'read', path: plan, start: 1, count: 4 });
  const rows = () => requiredAtoms.map((atom, index) => ({ requiredProposalId: page.items[index].requiredProposalId,
    originalSourceAnchorId: atom.source.anchorId, requirement: `The reviewer summarizes obligation ${index + 1} differently.`, disposition: 'COVERED',
    reason: 'The current plan contains the obligation.', targets: [{ path: plan, start: index + 2, end: index + 2 }] }));
  const seal = coverage => sealRequiredProposalCoverage(requiredAtoms.map(({ source, start, end, requirement }) => ({ requirement,
    source: { ref: source.ref, sha256: source.sha256, start, end } })), [{ ref, text }], { ...coverage, reviewStatus: 'PASSED' });
  return { root, tools, page, requiredAtoms, source, originalRequirements, semantic, snapshot, requestPath, write, open,
    readOriginal, readPlan, rows, seal };
}

async function readEvidence(f) { await f.readOriginal(); await f.readPlan(); }

test('stable required IDs preserve both shared-anchor obligations and normalize only host-owned text', async t => {
  const f = await fixture(t); await readEvidence(f);
  assert.deepEqual(f.page.items.map(item => item.requiredProposalId), f.requiredAtoms.map(atom => sha256([atom.source.anchorId, atom.requirement])));
  assert.equal(new Set(f.page.items.map(item => item.requiredProposalId)).size, 2);
  const rows = f.rows(), before = structuredClone(rows);
  assert.equal(validateJsonSchema(rows, originalRequirementCoverageSchema).length, 0);
  const legacyParaphrases = rows.map(({ requiredProposalId, ...row }) => row);
  await assert.rejects(f.tools.verifyRequirementCoverage(legacyParaphrases), error => error.code === invalid.code
    && error.coverageIssue.kind === 'MISSING_REQUIRED_PROPOSAL_IDENTITIES' && error.coverageIssue.missingCount === 2);
  const coverage = await f.tools.verifyRequirementCoverage(rows);
  assert.deepEqual(rows, before, 'Validation does not rewrite the original model submission.');
  assert.deepEqual(coverage.rows.map(row => row.requirement), requirements);
  assert(coverage.rows.every(row => !Object.hasOwn(row, 'requiredProposalId')), 'Normalized receipt keeps its existing schema.');
  assert.deepEqual(f.seal(coverage).requiredAtoms.map(atom => atom.id).sort(), f.page.items.map(item => item.requiredProposalId).sort());
  const legacyExact = rows.map(({ requiredProposalId, ...row }, index) => ({ ...row, requirement: requirements[index] }));
  assert.deepEqual(await f.tools.verifyRequirementCoverage(legacyExact), coverage);
  const { requiredProposalId, ...optional } = rows[0];
  const extra = await f.tools.verifyRequirementCoverage([...rows, { ...optional, requirement: 'A separate optional observation.',
    disposition: 'UNVERIFIED', targets: [] }]);
  assert.equal(extra.rows[2].requirement, 'A separate optional observation.');
  assert.equal(extra.rows[2].disposition, 'UNVERIFIED');
  assert.equal(f.seal(extra).requiredAtoms.length, 2);
});

test('known ID alone cannot replace an original read or current plan evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tools.verifyRequirementCoverage(f.rows()), /issued by read_original/u);
  await f.readOriginal();
  await assert.rejects(f.tools.verifyRequirementCoverage(f.rows()), error => error.code === invalid.code && error.coverageIssue.kind === 'TARGET_NOT_DISCLOSED');
  await f.readPlan();
  const wrong = await f.readOriginal(2), rows = f.rows(); rows[0].originalSourceAnchorId = wrong.anchor.anchorId;
  await assert.rejects(f.tools.verifyRequirementCoverage(rows), /exact original source span/u);
});

for (const kind of ['unknown', 'foreign source', 'old source revision', 'removed obligation']) test(`required ID rejects ${kind}`, async t => {
  const f = await fixture(t); await readEvidence(f); const rows = f.rows();
  if (kind === 'unknown') rows[0].requiredProposalId = 'f'.repeat(64);
  if (kind === 'foreign source') {
    const source = createOriginalSourceAnchor({ ref: 'transcript:another-request', sha256: sha256(originalText), bytes: Buffer.from(originalText), start: 1, end: 1 });
    rows[0].requiredProposalId = sha256([source.anchorId, requirements[0]]);
  }
  if (kind === 'old source revision') {
    const text = originalText + 'An earlier instruction.\n';
    const source = createOriginalSourceAnchor({ ref, sha256: sha256(text), bytes: Buffer.from(text), start: 1, end: 1 });
    rows[0].requiredProposalId = sha256([source.anchorId, requirements[0]]);
  }
  if (kind === 'removed obligation') rows[0].requiredProposalId = sha256([f.source.anchorId, 'An obsolete inventory obligation.']);
  await assert.rejects(f.tools.verifyRequirementCoverage(rows), /current required_proposal inventory/u);
});

test('missing rows and duplicate identity remain failures across ID and exact-text legacy paths', async t => {
  const f = await fixture(t); await readEvidence(f); const rows = f.rows();
  for (const value of [undefined, null, [], rows.slice(0, 1)]) await assert.rejects(f.tools.verifyRequirementCoverage(value), invalid);
  for (const duplicate of [rows[0], { ...rows[0], requirement: 'A second summary of the same duty.' },
    { ...rows[0], requiredProposalId: f.page.items[1].requiredProposalId, originalSourceAnchorId: f.source.anchorId }]) {
    await assert.rejects(f.tools.verifyRequirementCoverage([...rows, duplicate]), /distinct obligation/u);
  }
  const { requiredProposalId, ...legacy } = rows[0];
  await assert.rejects(f.tools.verifyRequirementCoverage([...rows, { ...legacy, requirement: requirements[0] }]), /distinct obligation/u);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...rows[0], requiredProposalId: undefined }, rows[1]]), /current required_proposal inventory/u);
});

test('ID membership is not a capability across document review invocations', async t => {
  const f = await fixture(t); const other = await f.open(f.requiredAtoms);
  const rows = f.rows();
  await readEvidence(f);
  await assert.rejects(other.verifyRequirementCoverage(rows), /issued by read_original/u);
  await other.execute(f.page.items[0].readOriginal);
  await assert.rejects(other.verifyRequirementCoverage(rows), /plan range read/u);
  await other.execute({ action: 'read', path: plan, start: 1, count: 4 });
  assert.equal((await other.verifyRequirementCoverage(rows)).rows.length, 2);
});

for (const kind of ['original mutation', 'plan mutation', 'outside artifact', 'COVERED without target']) test(`ID path preserves ${kind} rejection`, async t => {
  const f = await fixture(t); await readEvidence(f); const rows = f.rows();
  if (kind === 'original mutation') {
    await fs.writeFile(f.originalRequirements.userMessages[0].path, originalText + 'Changed after read.\n');
    await assert.rejects(f.tools.verifyRequirementCoverage(rows), /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u); return;
  }
  if (kind === 'plan mutation') {
    await f.write(spec, 'Changed unread companion plan.\n');
    await assert.rejects(f.tools.verifyRequirementCoverage(rows), /DOCUMENT_EVIDENCE_CHANGED/u); return;
  }
  if (kind === 'outside artifact') {
    await f.tools.execute({ action: 'read', path: reference, start: 1, count: 1 });
    rows[0].targets = [{ path: reference, start: 1, end: 1 }];
    await assert.rejects(f.tools.verifyRequirementCoverage(rows), error => error.code === invalid.code && error.coverageIssue.kind === 'OUTSIDE_ARTIFACT_SCOPE'); return;
  }
  rows[0].targets = [];
  await assert.rejects(f.tools.verifyRequirementCoverage(rows), error => error.code === invalid.code && error.coverageIssue.kind === 'EMPTY_COVERED_TARGETS');
});

test('IDs preserve GAP and UNVERIFIED without manufacturing approval', async t => {
  const f = await fixture(t); await f.readOriginal(); const rows = f.rows();
  rows[0] = { ...rows[0], disposition: 'GAP', targets: [] };
  rows[1] = { ...rows[1], disposition: 'UNVERIFIED', targets: [] };
  await f.readPlan();
  await assert.rejects(f.tools.verifyRequirementCoverage(rows), error => error.code === invalid.code && error.coverageIssue.kind === 'INCOMPLETE_GAP_SCOPE');
  await f.tools.execute({ action: 'read', path: spec, start: 1, count: 3 });
  const coverage = await f.tools.verifyRequirementCoverage(rows);
  assert.deepEqual(coverage.rows.map(row => row.requirement), requirements);
  assert.deepEqual(coverage.rows.map(row => row.disposition), ['GAP', 'UNVERIFIED']);
  assert.throws(() => f.seal(coverage), /unambiguous current coverage/u);
});

test('optional legacy coverage remains available without a required inventory; supplied IDs do not', async t => {
  const f = await fixture(t, { required: false }); await readEvidence(f);
  const row = { originalSourceAnchorId: f.source.anchorId, requirement: 'An optional obligation.', disposition: 'UNVERIFIED',
    reason: 'Not established by this review.', targets: [] };
  assert.equal((await f.tools.verifyRequirementCoverage([row])).rows[0].requirement, row.requirement);
  await assert.rejects(f.tools.verifyRequirementCoverage([{ ...row, requiredProposalId: sha256([f.source.anchorId, requirements[0]]) }]), /current required_proposal inventory/u);
});

async function nativeFixture(t, { missingAfterFirst = false } = {}) {
  const f = await fixture(t); let documentTool, calls = 0;
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } }, logger: { warn() {} }, registerTool(factory) { documentTool = factory; },
    runtime: { version: '2026.7.1-2', agent: { async runEmbeddedAgent(params) {
      calls++;
      assert.match(params.extraSystemPrompt, /Copy its requiredProposalId/u);
      const tool = documentTool({ sessionId: params.sessionId, runId: params.runId });
      const call = async args => JSON.parse((await tool.execute('fixture', args)).content[0].text);
      const page = await call({ action: 'required_proposal', start: 1, count: 20 });
      const original = await call(page.items[0].readOriginal);
      await call({ action: 'read', path: plan, start: 1, count: 4 });
      const coverage = missingAfterFirst && calls > 1 ? [] : page.items.map((item, index) => ({ requiredProposalId: item.requiredProposalId,
        originalSourceAnchorId: original.anchor.anchorId, requirement: 'The native reviewer paraphrases this requirement.', disposition: 'COVERED',
        reason: 'Current artifact evidence.', targets: [{ path: plan, start: index + 2, end: index + 2 }] }));
      return { payloads: [{ text: JSON.stringify({ summary: 'Reviewed current artifacts.', findings: [], edits: [], originalRequirementCoverage: coverage }) }], meta: {} };
    } } } };
  registerDocumentTools(api);
  const factory = createOpenClawReviewerFactory(api);
  const input = { projectRoot: f.root, taskId: 'record-import-plan', role: 'artifact-reviewer', pluginRoot: path.resolve('.'),
    reviewer: { session: 'detached', timeoutMs: 5000, formatRepairAttempts: missingAfterFirst ? 0 : 1 }, schema: REVIEW_SCHEMA,
    request: { semanticReviewRequestPath: f.requestPath }, evidence: { snapshot: f.snapshot, requiredProposalReview: { requiredAtoms: f.requiredAtoms } } };
  return { f, factory, input, calls: () => calls };
}

test('native reviewer accepts paraphrased ID rows in one generation and emits sealer-compatible canonical coverage', async t => {
  const n = await nativeFixture(t); const handle = await n.factory(n.input);
  try {
    assert.equal(n.calls(), 1, 'A valid identity needs no authorized format-repair generation.');
    assert.deepEqual(handle.originalRequirementCoverage.rows.map(row => row.requirement), requirements);
    assert.equal(n.f.seal(handle.originalRequirementCoverage).requiredAtoms.length, 2);
    const state = { nativeRunId: 'proposal-run', scopeTaskId: n.input.taskId, sessionId: 'business-session' };
    const owner = { runId: state.nativeRunId, taskId: state.scopeTaskId, sessionId: state.sessionId };
    const receipt = { ...handle.originalRequirementCoverage, ...owner };
    recordProposalCoverage(state, plan, receipt, { ...owner, result: { status: 'passed', diagnostics: [],
      metadata: { inputs: receipt.scope, semanticReview: { status: 'completed', originalRequirementCoverage: receipt } } } });
    const published = selectApprovedPlanCoverage(state, state.nativeRunId, {
      changeName: 'record-import', revision: 'current-plan-revision', documents: receipt.scope });
    assert.equal(published.reviewStatus, 'PASSED');
    assert.deepEqual(published.rows, receipt.rows);
    assert.equal(n.f.seal(published).requiredAtoms.length, 2, 'The owned publication remains compatible with approval sealing.');
  } finally { await handle.close(); }
});

test('a later strict review cannot borrow prior successful required-ID coverage from the document cache', async t => {
  const n = await nativeFixture(t, { missingAfterFirst: true }); const first = await n.factory(n.input); await first.close();
  await assert.rejects(n.factory(n.input), /MISSING_REQUIRED_PROPOSAL_IDENTITIES/u);
  assert.equal(n.calls(), 2, 'The second strict review actually ran and its missing coverage was rejected.');
});
