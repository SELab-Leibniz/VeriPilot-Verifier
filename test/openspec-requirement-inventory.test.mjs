import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindOpenSpecRequirementInventory, loadOpenSpecRequirementInventory, prepareOpenSpecRequirementInventory,
  validateOpenSpecRequirementInventoryCase } from '../scripts/bench/openspec-requirement-inventory.mjs';
import { sealRequiredProposalCoverage } from '../lib/openclaw/approved-plan-coverage.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

const problemStatement = 'Original feature title\r\n\r\nKeep the café label and reject an empty name.\r\n';
const requirements = [
  { start: 3, end: 3, requirement: 'Keep the café label.' },
  { start: 3, end: 3, requirement: 'Reject an empty name.' },
];
const entry = { id: 'small-project_1', publicInputSha256: sha256('frozen public bytes'),
  problemStatementSha256: sha256(problemStatement), requirements };
const inventory = { kind: 'openspec-requirement-inventory-v1', cases: [entry] };

test('loads only exact pinned UTF-8 inventory bytes with unique bounded cases and requirement spans', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'openspec-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'inventory.json');
  const bytes = Buffer.from(JSON.stringify(inventory));
  await writeFile(file, bytes);
  const loaded = await loadOpenSpecRequirementInventory(file, sha256(bytes));
  assert.equal(loaded.sha256, sha256(bytes));
  assert.deepEqual([...loaded.cases], [[entry.id, { publicInputSha256: entry.publicInputSha256,
    problemStatementSha256: entry.problemStatementSha256, requirements }]]);
  await assert.rejects(loadOpenSpecRequirementInventory(file, sha256('another file')), /do not match their pin/u);
  const invalid = [
    { ...inventory, unexpected: true },
    { ...inventory, cases: [entry, entry] },
    { ...inventory, cases: [{ ...entry, id: '../other' }] },
    { ...inventory, cases: [{ ...entry, requirements: [requirements[0], { requirement: requirements[0].requirement, end: 3, start: 3 }] }] },
    { ...inventory, cases: [{ ...entry, requirements: [{ ...requirements[0], end: 203 }] }] },
    { ...inventory, cases: [{ ...entry, requirements: Array.from({ length: 49 }, (_, i) => ({ ...requirements[0], requirement: `Check ${i}.` })) }] },
  ];
  for (const value of invalid) {
    const parsed = Buffer.from(JSON.stringify(value));
    await writeFile(file, parsed);
    await assert.rejects(loadOpenSpecRequirementInventory(file, sha256(parsed)), /OpenSpec requirement/u);
  }
});

test('verifies pinned physical public source lines before a native turn exists', () => {
  const input = { publicInputSha256: entry.publicInputSha256, problemStatement };
  assert.doesNotThrow(() => validateOpenSpecRequirementInventoryCase(entry, input));
  assert.throws(() => validateOpenSpecRequirementInventoryCase({ ...entry,
    requirements: [{ start: 2, end: 2, requirement: 'Blank.' }] }, input), /nonempty public source lines/u);
  assert.throws(() => validateOpenSpecRequirementInventoryCase({ ...entry,
    requirements: [{ start: 8, end: 8, requirement: 'Beyond the input.' }] }, input), /nonempty public source lines/u);
});

function nativeInput(proposalMessage = `Transcribed workflow.\nFirst title on this line: ${problemStatement}\nHints.\n`) {
  const sessionId = 'native-session', proposalRunId = 'initial-proposal';
  const records = [
    { type: 'session', id: sessionId, cwd: '/project' },
    { type: 'message', id: 'proposal-user', parentId: null, message: { role: 'user',
      idempotencyKey: `${proposalRunId}:user`, content: [{ type: 'text', text: proposalMessage }] } },
    { type: 'message', id: 'proposal-assistant', parentId: 'proposal-user', message: { role: 'assistant', content: [] } },
    { type: 'message', id: 'validation-retry', parentId: 'proposal-assistant', message: { role: 'user',
      idempotencyKey: 'settled-retry:user', inputProvenance: { kind: 'internal_system' }, content: 'Repair the planning draft.' } },
    { type: 'message', id: 'settled-assistant', parentId: 'validation-retry', message: { role: 'assistant', content: [] } },
  ];
  return { proposalMessage, problemStatement, publicInputSha256: entry.publicInputSha256, sessionId, proposalRunId, records };
}

test('binds exact public spans to retained native source and seals separate atoms sharing that source', () => {
  const input = nativeInput();
  const atoms = bindOpenSpecRequirementInventory(entry, input);
  const ref = 'transcript:proposal-user', digest = sha256(input.proposalMessage);
  const staged = prepareOpenSpecRequirementInventory(entry, input);
  assert.deepEqual(staged, { sourceSha256: digest, requirements: requirements.map(({ requirement }) => ({ start: 4, end: 4, requirement })) });
  assert.deepEqual(atoms, requirements.map(({ requirement }) => ({
    source: { ref, sha256: digest, start: 4, end: 4 }, requirement,
  })));
  const anchor = createOriginalSourceAnchor({ ref, sha256: digest, bytes: Buffer.from(input.proposalMessage), start: 4, end: 4 });
  const sealed = sealRequiredProposalCoverage(atoms, [{ ref, text: input.proposalMessage }], {
    reviewStatus: 'PASSED',
    rows: atoms.map(({ requirement }) => ({ requirement, source: anchor, disposition: 'COVERED', targets: [{ path: 'spec.md' }] })),
  });
  assert.equal(sealed.requiredAtoms.length, 2);
  assert.notEqual(sealed.requiredAtoms[0].id, sealed.requiredAtoms[1].id);
  assert(sealed.requiredAtoms.every(value => value.source.anchorId === anchor.anchorId));
});

test('binds whole native lines when the exact public statement touches an inline workflow wrapper', () => {
  const short = 'Embedded statement.\nIts last line.';
  const input = { ...nativeInput(`Intro\nWorkflow: ${short} Then finish.`), problemStatement: short };
  const inventoryCase = { ...entry, problemStatementSha256: sha256(short), requirements: [
    { start: 1, end: 1, requirement: 'Embedded statement.' },
    { start: 2, end: 2, requirement: 'Its last line.' },
  ] };
  const atoms = bindOpenSpecRequirementInventory(inventoryCase, input);
  assert.deepEqual(atoms.map(({ source }) => [source.start, source.end]), [[2, 2], [3, 3]]);
  assert(atoms.every(({ source }) => source.sha256 === sha256(input.proposalMessage)));
});

test('rejects stale inputs and abandoned or ambiguous Proposal turns', () => {
  const input = nativeInput();
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, publicInputSha256: sha256('another public input') }), /public input/u);
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, proposalMessage: 'not the retained bytes' }), /dispatched Proposal/u);
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, sessionId: 'foreign' }), /session identity/u);
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, proposalRunId: 'settled-retry' }), /original user message/u);
  const duplicate = { ...input.records[1], id: 'duplicate' };
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, records: [...input.records, duplicate] }), /unique Proposal dispatch/u);
  const otherBranch = { ...input.records.at(-1), id: 'other-branch', parentId: null };
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, records: [...input.records, otherBranch] }), /active native transcript/u);
  const clarification = { ...input.records[1], id: 'clarification', parentId: 'settled-assistant',
    message: { role: 'user', idempotencyKey: 'another:user', content: 'A new task requirement.' } };
  assert.throws(() => bindOpenSpecRequirementInventory(entry, { ...input, records: [...input.records, clarification] }), /dispatched Proposal/u);
  assert.throws(() => bindOpenSpecRequirementInventory(entry, nativeInput(`${problemStatement}\n${problemStatement}`)), /ambiguous/u);
  const blankLine = { ...entry, requirements: [{ ...requirements[0], start: 2, end: 2 }] };
  assert.throws(() => bindOpenSpecRequirementInventory(blankLine, input), /nonempty public source lines/u);
});
