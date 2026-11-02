import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { baselineAuditSourceUnits, coverageIdentity, validateBaselineAuditReport, encodeBaselineAuditView, decodeBaselineAuditView,
  prepareBaselineCoverageAudit, verifyBaselineCoverageProof, BASELINE_COVERAGE_PROTOCOL, BASELINE_AUDIT_UNIT_LAYOUT,
  BASELINE_COVERAGE_INSTRUCTIONS, BASELINE_COVERAGE_SCHEMA, BASELINE_INVENTORY_SCHEMA, BASELINE_AUDIT_VIEW_PROTOCOL, BASELINE_COVERAGE_POLICY } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { groundTruthPlanDigest } from '../lib/runtime-v2/ground-truth-ledger.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';

function fixture(text, partBytes = Infinity) {
  const bytes = Buffer.from(text), files = [], parts = [];
  for (let start = 0; start < bytes.length || !parts.length;) {
    let end = Math.min(bytes.length, start + partBytes);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const part = bytes.subarray(start, end), file = `source-${parts.length}.txt`;
    parts.push({ file, startByte: start, endByte: end, sha256: sha256(part) });
    files.push({ path: `original-${file}`, text: part.toString('utf8'), sha256: sha256(part) });
    start = end; if (!bytes.length) break;
  }
  const delta = { operations: [], taskClassification: 'NO_CHANGE', summary: 'Controlled structural fixture.' };
  const input = { identity: { requestId: 'unit-test', taskId: 'unit-task', baselineVersion: 1, baselineDigest: 'base',
    sources: [{ ref: 'transcript:unit-test', kind: 'USER_MESSAGE', bytes: bytes.length, sha256: sha256(bytes), parts }] },
    delta, batches: [], retainedSourceUnits: [], generation: 0,
    finish: { requestId: 'unit-test', delta, digest: sha256(delta),
      hash: sha256({ batchIds: [], taskClassification: delta.taskClassification, summary: delta.summary }),
      receipt: { requestId: 'unit-test', generation: 0, complete: true, status: 'NO_CHANGE', deltaDigest: sha256(delta) } },
    plan: { digest: 'controlled-plan', current: { claims: text ? [{ claimId: 'verify', status: 'ACTIVE', verificationTarget: 'PROCESS' }] : [] } } };
  const units = baselineAuditSourceUnits(input, files), citations = files.map((file, index) => ({
    citeId: `cite-${index}`, path: file.path, sha256: file.sha256, start: 1, end: file.text.split('\n').length }));
  // Authored structural expectation: nonempty synthetic units are PROCESS in
  // this fixture. It is created solely from originals, before report mapping.
  const inventory = { identityDigest: sha256(coverageIdentity(input)), sources: [{ ref: 'transcript:unit-test', kind: 'USER_MESSAGE',
    units: units.map(unit => ({ rangeMode: 'UNIT', unitId: unit.unitId, citeIds: citations.map(cite => cite.citeId),
      disposition: text ? 'DUTIES' : 'CONTEXT', reason: 'Explicit structural fixture semantics.', obligations: text ? [{
        obligationId: `${unit.unitId}-process`, statement: unit.text, owner: 'PROCESS', condition: 'During the original task.',
        reason: 'Controlled source-only expectation; not a normative language classifier.' }] : [] })) }] };
  const report = { inventoryDigest: sha256(inventory), identityDigest: sha256(coverageIdentity(input)), verdict: 'PASS', sources: [{ ref: 'transcript:unit-test', kind: 'USER_MESSAGE',
    unitIds: units.map(unit => unit.unitId), disposition: text ? 'COVERED' : 'CONTEXT', reason: 'Structural fixture only.', issues: [],
    mappings: units.map(unit => ({ rangeMode: 'QUOTE', supportMode: 'DIRECT', dependencyUnitIds: [],
      obligationIds: text ? [`${unit.unitId}-process`] : [], unitId: unit.unitId, quote: unit.text, citeIds: citations.map(cite => cite.citeId),
      claimIds: text ? ['verify'] : [], owner: text ? 'PROCESS' : 'CONTEXT', condition: '', reason: 'This is not a semantic oracle.' })) }] };
  return { input, files, units, citations, inventory, report, check: value => validateBaselineAuditReport(value, input, files, citations, inventory) };
}

test('complete new-schema tail-only report fails for a real original range gap', () => {
  const f = fixture('Read the original contract. After the final edit, run verification.');
  const report = structuredClone(f.report); report.sources[0].mappings[0].quote = 'After the final edit, run verification.';
  assert.throws(() => f.check(report), error => error.code === 'BASELINE_COVERAGE_UNVERIFIED'
    && error.auditValidation?.reason === 'ORIGINAL_RANGE_GAP'
    && error.auditValidation.gaps[0].quote === 'Read the original contract. ');
});

test('unit partition preserves Unicode, CRLF, multipart bytes and every unit beyond200', () => {
  const text = '读原合同🧪。\r\n' + 'x'.repeat(2048 * 201) + '\r\n' + Array.from({ length: 230 }, (_, i) => `line-${i}\r\n`).join('');
  const f = fixture(text, 4096);
  assert(f.units.length > 200); assert(f.input.identity.sources[0].parts.length > 1);
  assert.equal(f.units.map(unit => unit.text).join(''), text);
  assert.equal(new Set(f.units.map(unit => unit.unitId)).size, f.units.length);
  assert(f.units.every(unit => Buffer.from(unit.text).toString('utf8') === unit.text));
  assert(f.units.every(unit => unit.endByte > unit.startByte && unit.endByte - unit.startByte <= BASELINE_AUDIT_UNIT_LAYOUT.maxBytes));
  assert(f.units.every((unit, index) => unit.startByte === (f.units[index - 1]?.endByte ?? 0)));
  assert.equal(f.units.at(-1).endByte, Buffer.byteLength(text));
  f.check(f.report);
});

test('empty original has one explicit unit and cannot become a zero-unit denominator', () => {
  const f = fixture(''); assert.equal(f.units.length, 1); f.check(f.report);
  const missing = structuredClone(f.report); missing.sources[0].unitIds = [];
  assert.throws(() => f.check(missing), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
});

test('ambiguous repeated quote and foreign, missing or duplicate unit containers are rejected', () => {
  const f = fixture('repeat\nrepeat\n' + 'x'.repeat(2048) + '\nnext');
  assert(f.units.length > 1, 'The missing/duplicate container cases still exercise multiple units');
  for (const mutate of [r => { r.sources[0].unitIds.pop(); }, r => { r.sources[0].unitIds[1] = r.sources[0].unitIds[0]; },
    r => { r.sources[0].unitIds[0] = 'foreign'; }, r => { r.sources[0].mappings[0].unitId = 'foreign'; },
    r => { delete r.sources[0].mappings[0].unitId; }, r => { r.sources[0].issues = [{ ...r.sources[0].mappings[0] }]; delete r.sources[0].issues[0].unitId; }]) {
    const report = structuredClone(f.report); mutate(report);
    assert.throws(() => f.check(report), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
  const ambiguous = structuredClone(f.report); ambiguous.sources[0].mappings[0].quote = 'repeat';
  assert.throws(() => f.check(ambiguous), error => /ambiguous within its original unit/u.test(error.message));
});

test('overlapping mappings may share one compound unit and still select different single targets', () => {
  const f = fixture('Read the contract.\nImplement the feature.\r\nWrite the usage guide.\n');
  assert.equal(f.units.length, 1, 'LF and CRLF do not force audit-unit boundaries');
  assert.equal(f.units[0].text, 'Read the contract.\nImplement the feature.\r\nWrite the usage guide.\n');
  f.inventory.sources[0].units[0].obligations[0].statement = 'Read the contract.';
  f.input.plan.current.claims.push({ claimId: 'code', status: 'ACTIVE', verificationTarget: 'IMPLEMENTATION' });
  f.input.plan.current.claims.push({ claimId: 'guide', status: 'ACTIVE', verificationTarget: 'ARTIFACT' });
  f.inventory.sources[0].units[0].obligations.push({ obligationId: 'original-code', statement: 'Implement the feature.',
    owner: 'IMPLEMENTATION', condition: 'During this task.', reason: 'Explicit independently authored second result/owner from the compound original.' });
  f.inventory.sources[0].units[0].obligations.push({ obligationId: 'original-guide', statement: 'Write the usage guide.',
    owner: 'ARTIFACT', condition: 'During this task.', reason: 'An independently authored document result in the same neutral block.' });
  f.report.inventoryDigest = sha256(f.inventory);
  f.report.sources[0].mappings.push({ ...f.report.sources[0].mappings[0], claimIds: ['code'], owner: 'IMPLEMENTATION', obligationIds: ['original-code'] });
  f.report.sources[0].mappings.push({ ...f.report.sources[0].mappings[0], claimIds: ['guide'], owner: 'ARTIFACT', obligationIds: ['original-guide'] });
  assert.deepEqual(f.inventory.sources[0].units[0].obligations.map(duty => duty.owner), ['PROCESS', 'IMPLEMENTATION', 'ARTIFACT']);
  f.check(f.report);
});

test('a line1-only receipt never authorizes an undisclosed trailing LF', () => {
  const f = fixture('first\nsecond');
  f.citations.push({ ...f.citations[0], citeId: 'line-one', end: 1 });
  const partial = structuredClone(f.report); partial.sources[0].mappings[0].citeIds = ['line-one'];
  partial.sources[0].mappings[0].quote = 'first\n';
  partial.sources[0].mappings.push({ ...f.report.sources[0].mappings[0], quote: 'second' });
  assert.throws(() => f.check(partial), error => /absent from its exact disclosed source ranges/u.test(error.message));
  f.check(f.report); // A real full receipt covers the LF; no layout bytes are fabricated.
});

test('whole-unit quote and false CONTEXT remain visible semantic risks rather than mechanical proofs', () => {
  const f = fixture('Read the original contract. Verify the result.');
  f.check(f.report); // Whole quote can conceal partial meaning: this guard is structural only.
  const attack = structuredClone(f.report), row = attack.sources[0];
  row.mappings[0].quote = 'Verify the result.';
  row.mappings.push({ ...row.mappings[0], quote: 'Read the original contract. ', claimIds: [], obligationIds: [], owner: 'CONTEXT',
    reason: 'Deliberately false context assertion: independent semantic review must reject it.' });
  f.check(attack); // Explicitly demonstrates the remaining semantic limitation.
});

function canonicalFixture() {
  const f = fixture('读完整原文。\r\nPreserve the condition and exclusion.\n');
  const op = { operation: 'UPDATE', claimId: 'same-target', category: 'requirements', authority: 'USER_EXPLICIT', severity: 'HARD',
    verificationTarget: 'PROCESS', text: 'After a later edit, verify again; preserve the exception.', applicability: 'after a later edit',
    source: { ref: 'transcript:unit-test#L1-L2', kind: 'USER_MESSAGE' } };
  f.input.delta = { summary: 'Keep exact whitespace. \r\n', taskClassification: 'CONTINUATION', operations: [op, { ...op, applicability: 'after success except the stated exception' }] };
  f.input.batches = [[op], [], [f.input.delta.operations[1]]].map((operations, index) => ({
    requestId: f.input.identity.requestId, generation: 0, batchId: index + 1, operations, digest: sha256(operations),
    decisions: [{ action: index === 1 ? 'EXCLUDE' : 'KEEP', units: ['S0L1'], reason: 'Preserve the exact control, not a semantic default.' }],
    scopeDigest: sha256([{ action: index === 1 ? 'EXCLUDE' : 'KEEP', units: ['S0L1'], reason: 'Preserve the exact control, not a semantic default.' }]),
    bindings: operations.length ? [{ citeIds: ['original-binding'], operationIndex: 0 }] : [],
    receipt: { saved: true, preview: { text: 'Retain this preview and outcome.', operation: 'UPDATE' } }, outcomes: [{ outcome: 'Original outcome' }],
  }));
  f.input.finish = { ...f.input.finish, delta: f.input.delta, digest: sha256(f.input.delta),
    hash: sha256({ batchIds: [1, 2, 3], taskClassification: f.input.delta.taskClassification, summary: f.input.delta.summary }),
    admissionPolicy: 'controlled-source-admission', receipt: { ...f.input.finish.receipt, status: 'DELTA_READY', deltaDigest: sha256(f.input.delta),
      literalAliasLookalike: { path: 'plan.current', target: 'effectiveLedger' }, nullValue: null, emptyValue: '' } };
  const oldClaim = { claimId: 'same-target', revisionId: 'same-target@1', status: 'ACTIVE', verificationTarget: 'ARTIFACT',
    applicability: 'old branch', text: 'Old complete text and exception.', source: { kind: 'USER_MESSAGE', ref: 'transcript:unit-test' } };
  const newClaim = { ...oldClaim, revisionId: 'same-target@2', verificationTarget: 'PROCESS', applicability: 'new branch', text: op.text };
  f.input.plan.current.claims = [newClaim];
  Object.assign(f.input.plan, { accepted: [{ operation: 'UPDATE', claim: oldClaim }, { operation: 'UPDATE', claim: newClaim }],
    operationDispositions: [{ disposition: 'APPLIED', operationIndex: 0 }, { disposition: 'DEDUPLICATED', operationIndex: 1 }],
    droppedPostFreeze: [{ reason: 'Retain even non-applied controls' }], droppedUntrustedSources: [] });
  const source = f.input.identity.sources[0];
  f.input.retainedSourceUnits = [{ action: 'KEEP_EXISTING', units: ['S0L1'], claims: [{ claimId: oldClaim.claimId, revisionId: oldClaim.revisionId, digest: sha256(oldClaim) }],
    sourceGroup: { scope: 'FULL_ORIGINAL', kind: source.kind, ref: source.ref, sha256: source.sha256, claims: [oldClaim] } }];
  f.input.identity.retainedSourcesDigest = sha256(f.input.retainedSourceUnits);
  return f;
}

test('canonical aliases preserve the independent complete view including empty batches and distinct claims', () => {
  const f = canonicalFixture(), before = structuredClone(f.input);
  // Independent pre-codec view construction: no encoder or decoder supplies the oracle.
  const expected = JSON.parse(JSON.stringify({ identity: coverageIdentity(f.input), sources: f.input.identity.sources,
    instructions: BASELINE_COVERAGE_INSTRUCTIONS, delta: f.input.delta, batches: f.input.batches, finish: f.input.finish,
    retainedSourceUnits: f.input.retainedSourceUnits, effectiveLedger: f.input.plan.current, plan: f.input.plan }));
  const encoded = encodeBaselineAuditView(f.input);
  assert.deepEqual(decodeBaselineAuditView(encoded), expected);
  assert.deepEqual(f.input, before);
  assert.equal(encoded.protocol, BASELINE_AUDIT_VIEW_PROTOCOL);
  assert.deepEqual(encoded.aliases, [{ path: 'finish.delta', target: 'delta' },
    { path: 'batches.0.operations', target: 'delta.operations', start: 0, end: 1 },
    { path: 'batches.1.operations', target: 'delta.operations', start: 1, end: 1 },
    { path: 'batches.2.operations', target: 'delta.operations', start: 1, end: 2 }, { path: 'plan.current', target: 'effectiveLedger' }]);
  assert.deepEqual(encoded.data.plan.accepted, f.input.plan.accepted);
  assert.notDeepEqual(encoded.data.plan.accepted[0].claim, encoded.data.effectiveLedger.claims[0]);
  assert.deepEqual(encoded.data.finish.receipt, f.input.finish.receipt, 'raw alias-looking user/control objects remain literal');
  assert.deepEqual(encoded.data.retainedSourceUnits, f.input.retainedSourceUnits);
  const empty = fixture('').input, emptyView = encodeBaselineAuditView(empty);
  assert.equal(emptyView.aliases.length, 2);
  assert.deepEqual(decodeBaselineAuditView(emptyView).delta.operations, []);
});

test('canonical aliases reject extra or foreign paths, coerced slices and missing definitions', () => {
  const original = encodeBaselineAuditView(canonicalFixture().input);
  for (const mutate of [
    value => { value.extra = true; }, value => { delete value.protocol; }, value => { value.protocol = 'old'; },
    value => { value.data.extra = true; }, value => { delete value.data.delta; }, value => { delete value.data.effectiveLedger; },
    value => { value.data.delta.operations = null; }, value => { value.data.finish = []; }, value => { value.data.plan = null; },
    value => { value.data.batches[0] = null; }, value => { value.data.finish.delta = {}; }, value => { value.data.plan.current = {}; },
    value => { value.data.batches[0].operations = []; }, value => { value.aliases.pop(); }, value => { value.aliases.push(value.aliases[0]); },
    value => { value.aliases[0].extra = true; }, value => { delete value.aliases[0].target; },
    value => { value.aliases[0].target = ['delta']; }, value => { value.aliases[0].path = 'data.finish.delta'; },
    value => { value.aliases[1] = { ...value.aliases[0] }; }, value => { value.aliases[1].path = 'batches.00.operations'; },
    value => { value.aliases[1].target = 'plan.accepted'; }, value => { value.aliases[1].end = '1'; },
    value => { value.aliases[1].start = -1; }, value => { value.aliases[1].end = 0.5; },
    value => { value.aliases[1].end = 3; }, value => { value.aliases[2].start = 0; },
    value => { value.aliases[2].end = 0; }, value => { value.aliases[3].end = 1; },
    value => { [value.aliases[1], value.aliases[2]] = [value.aliases[2], value.aliases[1]]; },
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => decodeBaselineAuditView(value), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
});

test('prepared canonical parts keep numeric UTF8 order beyond nine and navigation cannot submit defaults', async t => {
  const f = canonicalFixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-audit-parts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  f.input.finish.receipt.completeLiteralControl = '🧪\r\n'.repeat(30000);
  f.input.directory = path.join(root, 'extractor');
  f.input.requiredFiles = f.files.map(file => file.path.slice(9)); f.input.fileHashes = {};
  await fs.mkdir(path.join(f.input.directory, 'frozen-source'), { recursive: true });
  for (const file of f.files) {
    const name = file.path.slice(9); f.input.fileHashes[name] = file.sha256;
    await fs.writeFile(path.join(f.input.directory, 'frozen-source', name), file.text);
  }
  f.input.plan.digest = groundTruthPlanDigest(f.input.plan);
  const output = path.join(root, 'audit');
  const adapter = await prepareBaselineCoverageAudit({ requestDirectory: output, input: f.input,
    budget: { snapshot: () => ({}), active() {} }, active() {} });
  const initial = JSON.parse(adapter.prompt);
  assert(initial.requiredFiles.every(name => name.startsWith('original-source-') || name.startsWith('unit-catalog-')));
  assert.deepEqual(initial.schema, BASELINE_INVENTORY_SCHEMA);
  assert.equal(initial.phase, 'SOURCE_ONLY');
  const prompt = JSON.parse(await fs.readFile(path.join(output, 'coverage-source', initial.phaseTwoManifest), 'utf8'));
  const names = prompt.requiredFiles.filter(name => name.startsWith('candidate-'));
  assert(names.length > 9);
  assert.deepEqual(names, Array.from({ length: names.length }, (_, index) => `candidate-${index}.txt`));
  const chunks = await Promise.all(names.map(name => fs.readFile(path.join(output, 'coverage-source', name))));
  assert(chunks.every(bytes => bytes.length <= 16384 && Buffer.from(bytes.toString('utf8')).equals(bytes)));
  const expanded = decodeBaselineAuditView(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  assert.deepEqual(expanded.finish, f.input.finish);
  assert.deepEqual(expanded.batches, f.input.batches);
  assert.deepEqual(prompt.readBatches.flat(), prompt.requiredFiles);
  assert.equal(prompt.candidateViewProtocol, BASELINE_AUDIT_VIEW_PROTOCOL);
  assert.deepEqual(prompt.schema, BASELINE_COVERAGE_SCHEMA, 'phase-two typed report schema is exact');
  const rowContract = prompt.instructions.find(instruction => instruction.startsWith('Every source row requires {'));
  assert(rowContract); assert(rowContract.includes(BASELINE_COVERAGE_SCHEMA.properties.sources.items.required.join(', ')));
  assert.match(rowContract, /Write unitIds, mappings and issues arrays explicitly/u);
  assert.match(rowContract, /issues:\[\] only after independently judging no issue/u);
  assert.match(rowContract, /otherwise supply the actual issue entries/u);
  assert.match(rowContract, /PASS\/COVERED never permits omitting required fields/u);
  const finishTool = adapter.tools.find(tool => tool.name === 'finish_baseline_audit');
  assert(finishTool.description.startsWith(rowContract));
  assert.deepEqual(finishTool.parameters.properties.report, BASELINE_COVERAGE_SCHEMA);
  assert.equal(finishTool.parameters.additionalProperties, false);
  assert.deepEqual(BASELINE_COVERAGE_SCHEMA.properties.sources.items.required, ['ref', 'kind', 'unitIds', 'disposition', 'reason', 'mappings', 'issues']);
  assert.deepEqual(prompt.sourceUnitNavigation.sources[0].unitIds, f.units.map(unit => unit.unitId));
  assert.equal(prompt.mappingFormatExample.formatOnly, true);
  const example = prompt.mappingFormatExample.entry;
  assert.deepEqual(Object.keys(example).sort(), ['citeIds', 'claimIds', 'condition', 'dependencyUnitIds', 'obligationIds', 'owner', 'rangeMode', 'reason', 'supportMode', 'unitId']);
  assert(!BASELINE_COVERAGE_SCHEMA.properties.sources.items.properties.mappings.items.properties.owner.enum.includes(example.owner));
  assert(!f.units.some(unit => unit.unitId === example.unitId), 'a placeholder cannot infer an actual unit');
  assert.match(adapter.systemPrompt, /Phase one|Phase1/u);
  assert(!Object.hasOwn(example, 'quote'), 'UNIT examples never imply a synthesized quote');
});


test('UNIT preserves raw wire without quote while QUOTE retains exact prefix and space guards', () => {
  const f = fixture('Read the original. Verify after the final edit.  ');
  const report = structuredClone(f.report), entry = report.sources[0].mappings[0];
  entry.rangeMode = 'UNIT'; delete entry.quote;
  const raw = JSON.stringify(report); f.check(report);
  assert.equal(JSON.stringify(report), raw); assert(!Object.hasOwn(entry, 'quote'));
  for (const mutate of [r => { delete r.sources[0].mappings[0].rangeMode; },
    r => { r.sources[0].mappings[0].rangeMode = 'AUTO'; }, r => { r.sources[0].mappings[0].quote = ''; },
    r => { r.sources[0].mappings[0].quote = null; }, r => { r.sources[0].mappings[0].unitId = 'foreign'; },
    r => { r.sources[0].mappings[0].citeIds = []; }]) {
    const bad = structuredClone(report); mutate(bad); assert.throws(() => f.check(bad), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
  const tail = structuredClone(f.report); tail.sources[0].mappings[0].quote = 'Verify after the final edit.';
  assert.throws(() => f.check(tail), error => error.auditValidation?.reason === 'ORIGINAL_RANGE_GAP');
});

test('natural source condition is independent from target applicability identity', () => {
  const f = fixture('After the final edit, run verification; if edited later, run again.');
  f.inventory.sources[0].units[0].obligations[0].condition = 'After the final edit; repeat if later edited.';
  f.report.inventoryDigest = sha256(f.inventory);
  f.input.plan.current.claims[0].applicability = 'CURRENT_TASK';
  f.input.plan.current.claims[0].text = 'After the final edit run verification; if edited later run again.';
  f.report.sources[0].mappings[0].condition = 'CURRENT_TASK';
  f.check(f.report);
  assert.notEqual(f.inventory.sources[0].units[0].obligations[0].condition, f.report.sources[0].mappings[0].condition);
});

test('every committed duty needs correspondence and a faulty inventory remains UNRESOLVED, never automatic REPAIR', () => {
  const f = fixture('Read the original contract and run verification.');
  f.inventory.sources[0].units[0].obligations.push({ obligationId: 'other-original-duty', statement: 'Read the original contract.',
    owner: 'PROCESS', condition: 'Before verification.', reason: 'An explicit second controlled source expectation.' });
  f.report.inventoryDigest = sha256(f.inventory);
  assert.throws(() => f.check(f.report), error => error.auditValidation?.reason === 'COMMITTED_DUTY_UNACCOUNTED');
  const wrong = structuredClone(f.report); wrong.sources[0].mappings[0].owner = 'IMPLEMENTATION';
  const originalInventory = JSON.stringify(f.inventory), rawWrong = JSON.stringify(wrong);
  assert.throws(() => f.check(wrong), error => {
    const v = error.auditValidation;
    assert.equal(error.code, 'BASELINE_COVERAGE_UNVERIFIED');
    assert.match(error.message, /^Audit claim ownership does not match the independently committed expected owner\/duty/);
    assert.equal(v.reason, 'OWNER_DUTY_MISMATCH'); assert.equal(v.unitId, f.units[0].unitId); assert.equal(v.mappingIndex, 0);
    assert.deepEqual(v.obligations, [{ obligationId: f.inventory.sources[0].units[0].obligations[0].obligationId, expectedInventoryOwner: 'PROCESS' }]);
    assert.equal(v.mappingOwner, 'IMPLEMENTATION'); assert.deepEqual(v.targets, [{ claimId: 'verify', verificationTarget: 'PROCESS' }]);
    assert.equal(v.recoverWith.tool, 'source_read'); assert.equal(v.recoverWith.offset, 1);
    assert.match(v.recovery, /UNRESOLVED\/SOURCE_INVENTORY/); assert.match(v.recovery, /CANDIDATE\/REPAIR/);
    assert(Buffer.byteLength(JSON.stringify({ accepted: false, complete: false, code: error.code, message: error.message,
      validation: v, repair: 'Correct the same owned transaction or disclose its missing evidence in this invocation; original deadline and shared allowance do not reset.' })) <= 3072);
    return true;
  });
  assert.equal(JSON.stringify(wrong), rawWrong); assert.equal(JSON.stringify(f.inventory), originalInventory);
  f.input.plan.current.claims[0].verificationTarget = 'IMPLEMENTATION';
  assert.throws(() => f.check(f.report), error => {
    assert.match(error.message, /^Audit claim ownership does not match the effective ledger/);
    assert.equal(error.auditValidation.mappingOwner, 'PROCESS');
    assert.deepEqual(error.auditValidation.targets, [{ claimId: 'verify', verificationTarget: 'IMPLEMENTATION' }]); return true;
  });
  f.input.plan.current.claims[0].verificationTarget = 'PROCESS';
  const longId = 'verify-' + '\u0001'.repeat(2000), longWrong = structuredClone(wrong);
  f.input.plan.current.claims[0].claimId = longId; longWrong.sources[0].mappings[0].claimIds = [longId];
  assert.throws(() => f.check(longWrong), error => {
    assert.equal(error.auditValidation.targetCount, 1);
    assert.equal(error.auditValidation.targets[0].claimIdOmitted, true);
    assert.equal(error.auditValidation.targets[0].claimIdSha256, sha256(longId));
    assert.equal(Object.hasOwn(error.auditValidation.targets[0], 'claimId'), false);
    assert(Buffer.byteLength(JSON.stringify(error.auditValidation)) <= 2048); return true;
  });
  f.input.plan.current.claims[0].claimId = 'verify';
  const uncertain = structuredClone(f.report), row = uncertain.sources[0];
  uncertain.verdict = 'UNRESOLVED'; row.disposition = 'UNRESOLVED';
  row.issues = [{ ...row.mappings[0], obligationIds: ['other-original-duty'], claimIds: [], issueKind: 'SOURCE_INVENTORY',
    expectedDuty: 'Read the original contract.', condition: 'Before verification.', reason: 'Original inventory may have incorrectly split an immutable dependency; preserve it and ask for source-grounded resolution.' }];
  const original = JSON.stringify(f.inventory); f.check(uncertain); assert.equal(JSON.stringify(f.inventory), original);
  row.issues[0].owner = 'IMPLEMENTATION';
  const uncertainRaw = JSON.stringify(uncertain); f.check(uncertain);
  assert.equal(JSON.stringify(uncertain), uncertainRaw); assert.equal(JSON.stringify(f.inventory), original);
  uncertain.verdict = 'REPAIR';
  assert.throws(() => f.check(uncertain), error => /faulty\/uncertain inventory/u.test(error.message));
});

test('dependency support references current immutable units explicitly without manufacturing a READ claim', () => {
  const f = fixture('Read and follow the complete original Skill.');
  const mapping = f.report.sources[0].mappings[0];
  mapping.supportMode = 'IMMUTABLE_DEPENDENCY'; mapping.dependencyUnitIds = [mapping.unitId];
  mapping.reason = 'Controlled semantic judgement checks the complete immutable original chain; still not an automatic meaning theorem.';
  const raw = JSON.stringify(f.report); f.check(f.report); assert.equal(JSON.stringify(f.report), raw);
  mapping.dependencyUnitIds = ['stale-unit'];
  assert.throws(() => f.check(f.report), error => /absent immutable dependency/u.test(error.message));
});

test('neutral byte boundaries preserve UTF8 and CRLF and never join a cross-block QUOTE', () => {
  for (const suffix of ['\r\nend', '🧪Z']) {
    const text = 'a'.repeat(2047) + suffix, f = fixture(text, 512);
    assert.equal(f.units.length, 2);
    assert.equal(f.units[0].endByte, 2047);
    assert.equal(f.units[1].startByte, 2047);
    assert.equal(f.units.map(unit => unit.text).join(''), text);
    assert(f.units.every(unit => Buffer.byteLength(unit.text) <= 2048 && Buffer.from(unit.text).toString('utf8') === unit.text));
    assert(!f.units.some((unit, index) => unit.text.endsWith('\r') && f.units[index + 1]?.text.startsWith('\n')));
    f.check(f.report);
    const crossing = structuredClone(f.report);
    crossing.sources[0].mappings[0].quote = 'a' + suffix.slice(0, 2);
    assert.throws(() => f.check(crossing), error => error.code === 'BASELINE_COVERAGE_UNVERIFIED'
      && /absent or ambiguous within its original unit/u.test(error.message));
  }
});

test('complete natural conditions survive a neutral boundary through current immutable dependency units', () => {
  const condition = 'If a later correction changes either deliverable, run verification again after that change; an earlier success does not satisfy the new verification duty.';
  const f = fixture('x'.repeat(2040) + condition);
  assert.equal(f.units.length, 2);
  assert(!f.units.some(unit => unit.text.includes(condition)), 'Neither local fragment alone contains the complete condition');
  for (const unit of f.inventory.sources[0].units) {
    unit.obligations[0].statement = condition;
    unit.obligations[0].condition = condition;
    unit.obligations[0].reason = 'Explicit source-only full-original expectation anchored across this controlled boundary; no per-block semantic inference.';
  }
  f.report.inventoryDigest = sha256(f.inventory);
  f.input.plan.current.claims[0].text = condition;
  f.input.plan.current.claims[0].applicability = 'CURRENT_TASK';
  for (const mapping of f.report.sources[0].mappings) {
    mapping.condition = 'CURRENT_TASK';
    mapping.supportMode = 'IMMUTABLE_DEPENDENCY';
    mapping.dependencyUnitIds = f.units.filter(unit => unit.unitId !== mapping.unitId).map(unit => unit.unitId);
    mapping.reason = 'The complete original trigger and exception are retained by this one claim and both current immutable source fragments.';
  }
  const raw = JSON.stringify(f.report); f.check(f.report);
  assert.equal(JSON.stringify(f.report), raw);
  assert(f.inventory.sources[0].units.every(unit => unit.obligations[0].condition === condition));
  assert.equal(new Set(f.report.sources[0].mappings.flatMap(mapping => mapping.claimIds)).size, 1,
    'A neutral boundary does not force additional claims or change the original condition to CURRENT_TASK');
  const stale = structuredClone(f.report); stale.sources[0].mappings[0].dependencyUnitIds = ['old-layout-unit'];
  assert.throws(() => f.check(stale), error => /absent immutable dependency/u.test(error.message));
});

test('the neutral-layout policy rejects a v6 proof without rewriting historical raw bytes', async t => {
  assert.equal(BASELINE_AUDIT_UNIT_LAYOUT.maxBytes, 2048);
  assert.notEqual(BASELINE_COVERAGE_PROTOCOL, 'baseline-original-effective-coverage-v6-source-first-unit-range');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-old-unit-proof-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = { protocol: 'baseline-original-effective-coverage-v6-source-first-unit-range', report: { verdict: 'PASS' } };
  const bytes = Buffer.from(JSON.stringify(old)), file = path.join(root, 'v6-proof.json');
  await fs.writeFile(file, bytes);
  await assert.rejects(verifyBaselineCoverageProof({ path: file, digest: sha256(old), bytesDigest: sha256(bytes) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
  assert.deepEqual(await fs.readFile(file), bytes);
  const oldPolicy = '3f7b89ee82f38c95935a10678383fbad181ef7984bfe96a899500b22aa902e41';
  assert.notEqual(BASELINE_COVERAGE_POLICY, oldPolicy, 'source029 pre-guidance v7 policy must not certify the changed producer');
  const f = fixture('Run verification after the final edit.');
  const oldV7 = { protocol: BASELINE_COVERAGE_PROTOCOL, input: f.input,
    identity: { ...coverageIdentity(f.input), policy: oldPolicy }, report: { verdict: 'PASS' } };
  const oldV7Bytes = Buffer.from(JSON.stringify(oldV7)), oldV7File = path.join(root, 'old-policy-v7-proof.json');
  await fs.writeFile(oldV7File, oldV7Bytes);
  await assert.rejects(verifyBaselineCoverageProof({ path: oldV7File, digest: sha256(oldV7), bytesDigest: sha256(oldV7Bytes) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
  assert.deepEqual(await fs.readFile(oldV7File), oldV7Bytes);
  const source030Policy = '41659b9873f5a5de356318a097bdce90b7ae50fd5429a0e3b3054155756fab26';
  assert.notEqual(BASELINE_COVERAGE_POLICY, source030Policy, 'the actual pre027 v7 policy must reject changed field presentation');
  const source030Proof = { ...oldV7, identity: { ...coverageIdentity(f.input), policy: source030Policy } };
  const source030Bytes = Buffer.from(JSON.stringify(source030Proof)), source030File = path.join(root, 'source030-policy-v7-proof.json');
  await fs.writeFile(source030File, source030Bytes);
  await assert.rejects(verifyBaselineCoverageProof({ path: source030File, digest: sha256(source030Proof), bytesDigest: sha256(source030Bytes) }),
    error => error.code === 'BASELINE_COVERAGE_UNVERIFIED' && /Stale or foreign audit proof/u.test(error.message));
  assert.deepEqual(await fs.readFile(source030File), source030Bytes);
});
