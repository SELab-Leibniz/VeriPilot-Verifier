import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDocumentTools, registerDocumentTools } from '../lib/document-tools.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { sealRequiredProposalCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';
import { mergeSemanticReview } from '../lib/result-processing.mjs';
import { createRoundMetadata, persistResult } from '../lib/result-store.mjs';
import { buildOriginalRequirements, writeOriginalRequirementSources } from '../lib/runtime-v2/original-requirements.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const proposal = 'openspec/changes/preferences/proposal.md';
const spec = 'openspec/changes/preferences/specs/preferences/spec.md';
const reference = 'requirements.md';
const proposalText = '# Proposal\nRestore the saved sort order.\nShow the result after loading.\n';
const specText = '# Preferences\nThe saved selection survives reopening.\n';
const prefix = 'Current preferences\r\n';
const requirement = '保留已保存的排序。';
const originalText = `${prefix}${requirement}\r\nTreat invalid values as unknown.\n`;
const ref = 'transcript:preferences';
const invalid = { code: 'DOCUMENT_REQUIREMENT_COVERAGE_INVALID' };
const candidateAtom = (requirement, start = 2, end = start) => ({ requirement, start, end,
  source: createOriginalSourceAnchor({ ref, sha256: sha256(originalText), bytes: Buffer.from(originalText), start, end }) });

async function fixture(t, requiredProposalReview) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'document-requirement-coverage-')));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (file, text) => {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text);
  };
  await Promise.all([write(proposal, proposalText), write(spec, specText), write(reference, `${requirement}\n`)]);
  const snapshot = { entries: [{ type: 'user', uuid: 'preferences', message: { content: originalText } }] };
  const original = await buildOriginalRequirements({ projectRoot: root, snapshot });
  const requestDirectory = path.join(root, 'request');
  const originalRequirements = await writeOriginalRequirementSources(requestDirectory, original, { inlineBudget: 0 });
  const requestPath = path.join(requestDirectory, 'request.json');
  const semantic = { artifactFiles: [proposal], originalRequirements,
    workflow: { targetFiles: [proposal], editableArtifactFiles: [proposal], incomingEdges: [{ sourceFiles: [spec] }],
      groundTruthInputs: [{ status: 'ready', files: [reference] }] } };
  const openTools = required => createDocumentTools({ projectRoot: root, requestPath, semantic, requiredProposalReview: required });
  const tools = await openTools(requiredProposalReview);
  const read = (file, start, count) => tools.execute({ action: 'read', path: file, start, count });
  const readOriginal = () => tools.execute({ action: 'read_original', ref, start: 2, count: 1 });
  const sourcePath = originalRequirements.userMessages[0].path;
  return { root, tools, read, readOriginal, sourcePath, write, openTools, semantic, requestPath, snapshot };
}

const row = (anchorId, overrides = {}) => ({ originalSourceAnchorId: anchorId,
  requirement: 'Restore the previously saved sorting preference.', disposition: 'COVERED',
  reason: 'The proposal describes restoration on load.', targets: [{ path: proposal, start: 2, end: 2 }], ...overrides });

test('coverage records the issued original byte range and the disclosed plan target', async t => {
  const f = await fixture(t);
  const { anchor, text } = await f.readOriginal();
  assert.equal(text, `${requirement}\r`);
  assert.deepEqual(anchor, { anchorId: anchor.anchorId, kind: 'USER_MESSAGE', ref, sha256: sha256(originalText),
    byteStart: Buffer.byteLength(prefix), byteEnd: Buffer.byteLength(`${prefix}${requirement}\r`) });
  assert.deepEqual((await f.read(proposal, 2, 1)).lines, ['2: Restore the saved sort order.']);
  const supplied = row(anchor.anchorId, { targets: [{ path: path.join(f.root, proposal), start: 2, end: 2 }] });
  const receipt = await f.tools.verifyRequirementCoverage([supplied]);
  assert.deepEqual(receipt, { schemaVersion: 1,
    scope: [{ path: proposal, sha256: sha256(proposalText), lines: 4 }, { path: spec, sha256: sha256(specText), lines: 3 }],
    rows: [{ source: anchor, requirement: supplied.requirement, disposition: 'COVERED', reason: supplied.reason,
      targets: [{ path: proposal, start: 2, end: 2, sha256: sha256(proposalText) }] }] });
});

test('unread anchors, unread ranges, and gaps between disclosed pages cannot support coverage', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tools.verifyRequirementCoverage([row(`original-source-${'0'.repeat(64)}`)]), invalid);
  const { anchor } = await f.readOriginal();
  await f.tools.execute({ action: 'manifest' });
  await assert.rejects(f.tools.verifyRequirementCoverage([row(anchor.anchorId)]), invalid);
  await f.read(proposal, 1, 1);
  await f.read(proposal, 3, 1);
  const span = row(anchor.anchorId, { targets: [{ path: proposal, start: 1, end: 3 }] });
  await assert.rejects(f.tools.verifyRequirementCoverage([span]), invalid);
  const search = await f.tools.execute({ action: 'search', path: proposal, query: 'saved sort order' });
  assert.deepEqual(search.matches.map(match => match.line), [2]);
  const receipt = await f.tools.verifyRequirementCoverage([span]);
  assert.deepEqual(receipt.rows[0].targets, [{ path: proposal, start: 1, end: 3, sha256: sha256(proposalText) }]);
});

test('a readable requirements reference remains outside the declared plan targets', async t => {
  const f = await fixture(t);
  const { anchor } = await f.readOriginal();
  assert.equal((await f.read(reference, 1, 1)).lines[0], `1: ${requirement}`);
  await assert.rejects(f.tools.verifyRequirementCoverage([row(anchor.anchorId, {
    targets: [{ path: reference, start: 1, end: 1 }],
  })]), invalid);
});

test('a gap without a target requires reading the whole declared plan scope', async t => {
  const f = await fixture(t);
  const { anchor } = await f.tools.execute({ action: 'read_original', ref, start: 3, count: 1 });
  const gap = row(anchor.anchorId, { requirement: 'Treat invalid saved selections as unknown.', disposition: 'GAP',
    reason: 'The reviewed plan leaves invalid selections unspecified.', targets: [] });
  await f.read(proposal, 1, 4);
  await assert.rejects(f.tools.verifyRequirementCoverage([gap]), /Read the entire declared plan scope/u);
  await f.read(spec, 1, 2);
  await assert.rejects(f.tools.verifyRequirementCoverage([gap]), /Read the entire declared plan scope/u);
  await f.read(spec, 3, 1);
  const receipt = await f.tools.verifyRequirementCoverage([gap]);
  assert.equal(receipt.rows[0].disposition, 'GAP');
  assert.deepEqual(receipt.rows[0].targets, []);
});

test('a read original can be explicitly unverified while plan evidence is incomplete', async t => {
  const f = await fixture(t);
  const { anchor } = await f.readOriginal();
  assert.equal(await f.tools.verifyRequirementCoverage([]), null);
  await assert.rejects(f.tools.verifyRequirementCoverage([row(anchor.anchorId, { targets: [] })]), /Cite at least one/u);
  const receipt = await f.tools.verifyRequirementCoverage([row(anchor.anchorId, {
    disposition: 'UNVERIFIED', reason: 'The relevant plan clauses were not read.', targets: [],
  })]);
  assert.equal(receipt.rows[0].disposition, 'UNVERIFIED');
  assert.deepEqual(receipt.rows[0].targets, []);
});

test('coverage rechecks both archived original bytes and reviewed plan bytes', async t => {
  await t.test('original', async t => {
    const f = await fixture(t);
    const { anchor } = await f.readOriginal();
    await f.read(proposal, 2, 1);
    await fs.writeFile(f.sourcePath, originalText.replace(requirement, 'Change the requested behavior.'));
    await assert.rejects(f.tools.verifyRequirementCoverage([row(anchor.anchorId)]), /DOCUMENT_ORIGINAL_SOURCE_CHANGED/u);
  });
  await t.test('plan scope', async t => {
    const f = await fixture(t);
    const { anchor } = await f.readOriginal();
    await f.read(proposal, 2, 1);
    await f.write(spec, specText.replace('survives', 'vanishes'));
    await assert.rejects(f.tools.verifyRequirementCoverage([row(anchor.anchorId)]), /DOCUMENT_EVIDENCE_CHANGED/u);
  });
});

test('a verified coverage receipt survives semantic merging and the persisted artifact round', async t => {
  const f = await fixture(t);
  const { anchor } = await f.readOriginal();
  await f.read(proposal, 2, 1);
  const originalRequirementCoverage = await f.tools.verifyRequirementCoverage([row(anchor.anchorId)]);
  const result = { diagnostics: [], diffs: [], metadata: { stage: 'proposal', artifactType: 'proposal', triggerFile: proposal,
    artifactFiles: [proposal], ruleSetIds: [], bundleComplete: true } };
  Object.assign(result.metadata, createRoundMetadata(result));
  mergeSemanticReview(result, { status: 'completed', summary: 'Reviewed the proposal.', findings: [], edits: [],
    originalRequirementCoverage });
  const { roundFiles } = await persistResult({ result, output: { persist: true, mode: 'centralized' },
    cwd: f.root, triggerFile: path.join(f.root, proposal) });
  const persisted = JSON.parse(await fs.readFile(roundFiles.find(file => path.basename(file) === 'result.json'), 'utf8'));
  assert.deepEqual(persisted.metadata.semanticReview.originalRequirementCoverage, originalRequirementCoverage);
  assert.deepEqual(persisted.diagnostics, []);
});

test('required Proposal navigation does not grant source reads or coverage and does not merge same-anchor wording', async t => {
  const requiredAtoms = [candidateAtom('Retain the saved sort order.'), candidateAtom('Restore the saved sort order on reopening.')];
  const f = await fixture(t, { requiredAtoms });
  const page = await f.tools.execute({ action: 'required_proposal', start: 1, count: 1 });
  assert.deepEqual(page, { navigationOnly: true, total: 2,
    items: [{ requirement: requiredAtoms[0].requirement, readOriginal: { action: 'read_original', ref, start: 2, count: 1 } }], nextStart: 2 });
  const second = await f.tools.execute({ action: 'required_proposal', start: page.nextStart });
  assert.equal(second.items[0].requirement, requiredAtoms[1].requirement);
  assert.equal(second.nextStart, null);
  const firstRow = row(requiredAtoms[0].source.anchorId, { requirement: requiredAtoms[0].requirement });
  await assert.rejects(f.tools.verifyRequirementCoverage([firstRow]), /issued by read_original/u);
  const { anchor } = await f.tools.execute(page.items[0].readOriginal);
  await assert.rejects(f.tools.verifyRequirementCoverage([firstRow]), /plan range read/u);
  const opened = await f.tools.execute({ action: 'open' });
  assert.deepEqual(opened.requiredProposal, { total: 2, navigationOnly: true, action: 'required_proposal' });
  const receiptFor = rows => f.tools.verifyRequirementCoverage(rows);
  const requested = requiredAtoms.map(({ requirement, start, end, source }) => ({ requirement, source: { ref, start, end, sha256: source.sha256 } }));
  const approve = coverage => sealRequiredProposalCoverage(requested, [{ ref, text: originalText }],
    { ...coverage, reviewStatus: 'PASSED' }); // This fixture assumes a completed, successful host review.
  const partial = await receiptFor([firstRow, row(anchor.anchorId, { requirement: 'Restore the prior saved ordering when reopened.' })]);
  assert.equal(partial.rows.length, 2, 'another valid row can remain optional coverage evidence');
  assert.throws(() => approve(partial), /coverage is incomplete \(1\/2\)/u);
  const both = await receiptFor([firstRow, row(anchor.anchorId, { requirement: requiredAtoms[1].requirement })]);
  assert.equal(approve(both).requiredAtoms.length, 2);
  assert.equal(await receiptFor([]), null);
  await assert.rejects(f.openTools({ requiredAtoms: [{ ...requiredAtoms[0], start: 1 }] }), /DOCUMENT_REQUIRED_PROPOSAL_INVALID/u);
  await assert.rejects(f.openTools({ requiredAtoms: [requiredAtoms[0], requiredAtoms[0]] }), /DOCUMENT_REQUIRED_PROPOSAL_INVALID/u);
});

test('required Proposal navigation stays within the existing document tool byte budget', async t => {
  const requiredAtoms = Array.from({ length: 48 }, (_, position) => candidateAtom(`Check ${position + 1} ${'科'.repeat(560)}`));
  const f = await fixture(t, { requiredAtoms });
  const seen = [];
  let start = 1;
  while (start !== null) {
    const page = await f.tools.execute({ action: 'required_proposal', start, count: 20 });
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert(page.items.length > 0);
    seen.push(...page.items.map(item => item.requirement));
    start = page.nextStart;
  }
  assert.deepEqual(seen, requiredAtoms.map(item => item.requirement));
});

test('native reviewer receives the inventory only through its bound document tool and omissions do not trigger a retry', async t => {
  const requiredAtoms = [candidateAtom('Retain the saved sort order.')];
  const f = await fixture(t);
  await fs.writeFile(f.requestPath, JSON.stringify(f.semantic));
  let documentTool, calls = 0;
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } }, logger: { warn() {} },
    registerTool(factory) { documentTool = factory; }, runtime: { version: '2026.7.1-2', agent: { async runEmbeddedAgent(params) {
      calls++;
      assert.match(params.extraSystemPrompt, /required_proposal/u);
      assert(!params.extraSystemPrompt.includes(requiredAtoms[0].requirement));
      assert.equal(documentTool({ sessionId: 'business', runId: params.runId }), null);
      assert.equal(documentTool({ sessionId: params.sessionId, runId: 'another-run' }), null);
      const tool = documentTool({ sessionId: params.sessionId, runId: params.runId });
      const call = async args => JSON.parse((await tool.execute('fixture', args)).content[0].text);
      const page = await call({ action: 'required_proposal' });
      assert.equal(page.items[0].requirement, requiredAtoms[0].requirement);
      const result = { summary: 'Current proposal review.', findings: [], edits: [] };
      if (calls === 2) {
        const original = await call(page.items[0].readOriginal);
        await call({ action: 'read', path: proposal, start: 2, count: 1 });
        result.originalRequirementCoverage = [row(original.anchor.anchorId, { requirement: page.items[0].requirement })];
      }
      return { payloads: [{ text: JSON.stringify(result) }], meta: {} };
    } } } };
  registerDocumentTools(api);
  const factory = createOpenClawReviewerFactory(api);
  const input = { projectRoot: f.root, taskId: 'required-proposal-coverage', role: 'artifact-reviewer', pluginRoot: path.resolve('.'),
    reviewer: { session: 'detached', timeoutMs: 5000, formatRepairAttempts: 1 }, schema: REVIEW_SCHEMA,
    request: { semanticReviewRequestPath: f.requestPath }, evidence: { snapshot: f.snapshot, requiredProposalReview: { requiredAtoms } } };
  const omitted = await factory(input);
  assert.equal(omitted.originalRequirementCoverage, null);
  assert.equal(calls, 1);
  const request = JSON.parse(await fs.readFile(path.join(omitted.requestDirectory, 'request.json'), 'utf8'));
  assert.equal(request.requiredProposalReview, undefined);
  await omitted.close();
  assert.equal(documentTool({ sessionId: omitted.sessionId }), null);
  const exact = await factory(input);
  assert.equal(calls, 2, 'an explicitly requested next round does not reuse an omitted strict receipt');
  assert.equal(exact.originalRequirementCoverage.rows[0].requirement, requiredAtoms[0].requirement);
  await exact.close();
});
