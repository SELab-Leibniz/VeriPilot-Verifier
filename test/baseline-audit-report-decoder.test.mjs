import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBaselineAuditReport } from '../lib/runtime-v2/baseline-coverage-audit.mjs';
import { sharedBasisFixture as fixture } from './helpers/runtime-v2-shared-basis-fixture.mjs';
import { readJson } from '../lib/runtime-v2/utils.mjs';
import { ensureTask, withTaskState } from '../lib/runtime-v2/task-store.mjs';

const actualWrapped = "All 12 required files read in full (all single-line JSON parts reassembled in byte order; nextOffset null on every read). I compared the complete originals against all 12 candidate operations, the EXCLUDE/SYNTHESIZE decisions, the finish record, and the effective v1 ledger (12 ACTIVE claims, all APPLIED).\n\nFindings:\n- transcript:04caf120: all six duties (implement app.mjs / complete guide / read+follow Skill / run verifier exit 0 / repeat after later correction / edit-only-two-files read-only constraint incl. \"Preserve the contract and explicit exclusions\") are ACTIVE claims with faithful owners and conditions.\n- original-contract.md: accept() +1 stateless IMPLEMENTATION claim and guide-content ARTIFACT claim both ACTIVE and faithful.\n- SKILL.md L6/L8/L10: exact-command, exit-0, conditional re-run (\"an earlier success does not satisfy the new verification duty\" preserved in claim text and applicability), and read-only/no-permissions constraint all ACTIVE. L1-L4 frontmatter (name/description metadata) correctly excluded as non-duty context — no obligation exists there to omit.\n\nCondition-preservation check: \"If any later correction is made\" (requirements-add0c24152c31198) and \"If a later correction changes either deliverable\" (requirements-f8c0cf056aad8280) each faithfully carry the original conditional branch; all other claims carry CURRENT_TASK with no lost internal branches. Every effective ACTIVE claim is supported by a mapping; no wrong owners, no lost conditions, no omissions found.\n\n```json\n{\"identityDigest\":\"0600529b6dfd1f3e01587fbbecc1ea48f7475f086726ac10a241889df66bbbd2\",\"verdict\":\"PASS\",\"sources\":[{\"ref\":\"transcript:04caf120\",\"kind\":\"USER_MESSAGE\",\"sha256\":\"169cb687efbe5ed07be39d771421d6c947c83dbb120a37b84fa1de40562452f5\",\"disposition\":\"COVERED\",\"reason\":\"Complete single-line user request read in full. All six duties (implement app.mjs, complete docs/guide.md, read+follow Skill, run verifier with exit 0 before declaring completion, repeat verification after later correction, edit-only-two-files/read-only/preserve-contract-and-exclusions constraint) are present as effective ACTIVE claims requirements-5b373578d81ebf63, requirements-f79888002378d72b, requirements-5329754ae2263e84, requirements-24a8c4876f6eab36, requirements-add0c24152c31198, constraints-9c34b078f0a20590; no omission, wrong owner or lost condition.\",\"mappings\":[{\"citeIds\":[\"rccite_bagligagollcmjkjmhpjiaacdnaifmoj\"],\"quote\":\"Implement app.mjs and complete docs/guide.md according to the complete original contract in requirements/original-contract.md.\",\"claimIds\":[\"requirements-5b373578d81ebf63\",\"requirements-f79888002378d72b\"],\"owner\":\"IMPLEMENTATION\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Split into faithful separate claims: app.mjs implementation (IMPLEMENTATION/PRODUCTION, expectedFiles app.mjs) and docs/guide.md completion (ARTIFACT, expectedFiles docs/guide.md); both ACTIVE.\"},{\"citeIds\":[\"rccite_bagligagollcmjkjmhpjiaacdnaifmoj\"],\"quote\":\"Read and follow the matching delivery-verifier Skill at skills/delivery-verifier/SKILL.md.\",\"claimIds\":[\"requirements-5329754ae2263e84\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Reading/following the Skill is a task process duty, correctly PROCESS and ACTIVE.\"},{\"citeIds\":[\"rccite_bagligagollcmjkjmhpjiaacdnaifmoj\"],\"quote\":\"actually run its supplied public verifier and establish exit code 0 before declaring completion\",\"claimIds\":[\"requirements-24a8c4876f6eab36\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Execution duty retained as PROCESS with exit-code-0 acceptance; ACTIVE.\"},{\"citeIds\":[\"rccite_bagligagollcmjkjmhpjiaacdnaifmoj\"],\"quote\":\"Repeat verification after any later correction.\",\"claimIds\":[\"requirements-add0c24152c31198\"],\"owner\":\"PROCESS\",\"condition\":\"If any later correction is made\",\"reason\":\"Conditional re-verification preserved; applicability string faithfully carries the original condition.\"},{\"citeIds\":[\"rccite_bagligagollcmjkjmhpjiaacdnaifmoj\"],\"quote\":\"Preserve the contract and explicit exclusions. Edit only app.mjs and docs/guide.md; the supplied contract, Skill and verifier are read-only.\",\"claimIds\":[\"constraints-9c34b078f0a20590\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Prohibition and preservation clauses retained verbatim in an ACTIVE HARD constraint claim.\"}],\"issues\":[]},{\"ref\":\"requirements/original-contract.md\",\"kind\":\"MATERIAL\",\"sha256\":\"b817230ba4e9bbba2ab0894f777adac13c5ed58575a8f5f72c2f9051f39e3f00\",\"disposition\":\"COVERED\",\"reason\":\"Complete contract material read in full (both obligations in line 1). accept(value) behavior claim and docs/guide.md content claim are both effective ACTIVE claims with correct owners; scope exclusion (other input types outside scope) preserved in both claim texts.\",\"mappings\":[{\"citeIds\":[\"rccite_fmphfmonkooklcjdmjaocfjnldmncbeh\"],\"quote\":\"The exported accept(value) in app.mjs must return the supplied finite number plus one without storing state. Other input types are outside scope.\",\"claimIds\":[\"requirements-315274042e418813\"],\"owner\":\"IMPLEMENTATION\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Runtime behavior obligation, correctly IMPLEMENTATION/PRODUCTION, ACTIVE, statelessness and scope exclusion preserved.\"},{\"citeIds\":[\"rccite_fmphfmonkooklcjdmjaocfjnldmncbeh\"],\"quote\":\"docs/guide.md must describe the supported finite-number input, show accept(2) === 3, explain that the operation is stateless, and identify other input types as outside scope.\",\"claimIds\":[\"requirements-f75d79dd2d051a84\"],\"owner\":\"ARTIFACT\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Document deliverable contents, correctly ARTIFACT, ACTIVE with all four content elements retained.\"}],\"issues\":[]},{\"ref\":\"skills/delivery-verifier/SKILL.md\",\"kind\":\"MATERIAL\",\"sha256\":\"1a780294da40d565e342d988a19466fadbc4f041a075b1854aa976d12c21a61c\",\"disposition\":\"COVERED\",\"reason\":\"Complete Skill read in full (11 lines). Duties from L6 (run exact command after final change, establish exit 0; re-run after later correction where earlier success does not satisfy the new duty), L8 (exact public verifier command) and L10 (read-only inputs / no network, write or child-process permissions; edit only two deliverables) are all effective ACTIVE claims. The EXCLUDE decision for L1-L4 frontmatter was reviewed: name/description metadata carries no duty, so exclusion is faithful, not an omission.\",\"mappings\":[{\"citeIds\":[\"rccite_gcgnnjaegdcmlkcmioadldocebhkioib\"],\"quote\":\"After the final change to either deliverable, run the following exact public command with the native exec tool\",\"claimIds\":[\"requirements-f90c0ee5fd08216c\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Verification execution duty retained as PROCESS with tool parameters (workdir, timeout 10, yieldMs 10000, background false) and exit-code-0 requirement; ACTIVE.\"},{\"citeIds\":[\"rccite_gcgnnjaegdcmlkcmioadldocebhkioib\"],\"quote\":\"If a later correction changes either deliverable, run it again after that change; an earlier success does not satisfy the new verification duty.\",\"claimIds\":[\"requirements-f8c0cf056aad8280\"],\"owner\":\"PROCESS\",\"condition\":\"If a later correction changes either deliverable\",\"reason\":\"Conditional re-verification branch preserved verbatim including the earlier-success clause; applicability string matches the original condition.\"},{\"citeIds\":[\"rccite_gcgnnjaegdcmlkcmioadldocebhkioib\"],\"quote\":\"/usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin '/opt/homebrew/Cellar/node/26.0.0/bin/node' --permission\",\"claimIds\":[\"requirements-2bbe01fb0e1439d1\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Exact-command claim text contains the complete verbatim command from L8; ACTIVE.\"},{\"citeIds\":[\"rccite_gcgnnjaegdcmlkcmioadldocebhkioib\"],\"quote\":\"Inputs and the verifier are supplied read-only; edit only the two deliverables.\",\"claimIds\":[\"constraints-a2c3689cfa419133\"],\"owner\":\"PROCESS\",\"condition\":\"CURRENT_TASK\",\"reason\":\"Read-only/no-permissions constraint and edit-only-deliverables prohibition retained; ACTIVE.\"}],\"issues\":[]}]}\n```";
const report = { inventoryDigest: 'format-inventory', identityDigest: 'format-fixture', verdict: 'PASS', sources: [{ ref: 'transcript:U1', kind: 'USER_MESSAGE',
  unitIds: ['format-unit'], disposition: 'CONTEXT', reason: 'Controlled format-only context.', mappings: [], issues: [] }] };
const json = JSON.stringify(report), fenced = '```json\n' + json + '\n```';
for (const [name, text] of [['bare', json], ['fenced', fenced], ['legacy whole fence', '```\n' + json + '\n```'],
  ['neutral prefix', 'All originals and current candidate controls were read.\n\n' + fenced],
  ['neutral sources', 'All sources were read in full.\n' + fenced],
  ['neutral mappings', 'The mappings relate claimIds and citeIds from the complete evidence.\n' + fenced]]) test(`audit report decodes ${name}`, () => {
  assert.deepEqual(decodeBaselineAuditReport(text), report);
});
for (const [name, text] of [['second object', '{}\n' + fenced], ['second array', '[]\n' + fenced], ['second scalar', 'true\n' + fenced],
  ['outside verdict', 'Verdict: REPAIR\n' + fenced], ['outside decision', 'PASS\n' + fenced],
  ['sources assignment', 'sources: other\n' + fenced], ['quoted mappings assignment', '"mappings": other\n' + fenced],
  ['quoted claimIds assignment', "'claimIds' = other\n" + fenced], ['identity assignment', 'identityDigest=foreign\n' + fenced],
  ['citeIds assignment', 'citeIds: other\n' + fenced],
  ['two fences', fenced + '\n' + fenced], ['tail text', fenced + '\nThere are omissions.'], ['tail report', fenced + '\n{}'],
  ['unlabelled prefix', 'Read complete.\n```\n' + json + '\n```'], ['wrong language', '```javascript\n' + json + '\n```'],
  ['malformed', '```json\n{broken}\n```'], ['wrong schema', '{"verdict":"PASS"}'], ['plain summary', 'All duties are covered.']])
  test(`audit report rejects ${name}`, () => assert.throws(() => decodeBaselineAuditReport(text), { code: 'BASELINE_COVERAGE_UNVERIFIED' }));

test('exact historical v16 wrapper remains rejected by the new protocol without conversion', () => {
  const payload = JSON.parse(actualWrapped.slice(actualWrapped.indexOf('```json\n') + 8, actualWrapped.lastIndexOf('\n```')));
  assert(payload.sources.every(source => Object.hasOwn(source, 'sha256')), 'Keep the actual historical fixture intact');
  assert.throws(() => decodeBaselineAuditReport(actualWrapped), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
});

const mapping = (claimIds, owner = 'IMPLEMENTATION') => ({ rangeMode: 'QUOTE', obligationIds: claimIds.length ? ['format-duty'] : [], supportMode: 'DIRECT', dependencyUnitIds: [], unitId: 'format-unit', citeIds: ['format-citation'], quote: 'Controlled original.',
  claimIds, owner, condition: '', reason: 'Controlled format-only mapping, not a semantic judgement.' });

for (const [name, ids] of [['homogeneous', ['implementation-one', 'implementation-two']],
  ['mixed owners', ['implementation-one', 'artifact-one']]]) test(`decoder rejects ${name} multi-target positive mappings`, () => {
  const value = structuredClone(report);
  value.sources[0].disposition = 'COVERED'; value.sources[0].mappings = [mapping(ids)];
  assert.throws(() => decodeBaselineAuditReport(JSON.stringify(value)), error => error.code === 'BASELINE_COVERAGE_UNVERIFIED'
    && /at most one effective claim/u.test(error.message));
});

test('decoder preserves single-target mappings, CONTEXT empty arrays and multi-target issues without rewriting', () => {
  const value = structuredClone(report), row = value.sources[0];
  value.verdict = 'REPAIR'; row.disposition = 'REPAIR';
  row.mappings = [mapping(['faithful-target']), mapping([], 'CONTEXT')];
  row.issues = [mapping(['wrong-target-one', 'wrong-target-two'], 'ARTIFACT'), mapping([], 'PROCESS')]
    .map(entry => ({ ...entry, issueKind: 'CANDIDATE', expectedDuty: 'Controlled original duty.' }));
  const text = JSON.stringify(value);
  assert.deepEqual(decodeBaselineAuditReport(text), value);
  assert.equal(JSON.stringify(value), text, 'Decoding never repairs or enriches the model report');
  for (const [verdict, disposition, invalid] of [
    ['PASS', 'COVERED', 'missing'], ['PASS', 'CONTEXT', 'missing'], ['REPAIR', 'REPAIR', 'missing'],
    ['UNRESOLVED', 'UNRESOLVED', 'missing'], ['PASS', 'CONTEXT', 'null'],
    ['PASS', 'CONTEXT', 'object'], ['PASS', 'CONTEXT', 'string'], ['PASS', 'CONTEXT', 'extra-key'],
  ]) {
    const bad = structuredClone(report); bad.verdict = verdict; bad.sources[0].disposition = disposition;
    if (invalid === 'missing') delete bad.sources[0].issues;
    if (invalid === 'null') bad.sources[0].issues = null;
    if (invalid === 'object') bad.sources[0].issues = {};
    if (invalid === 'string') bad.sources[0].issues = '[]';
    if (invalid === 'extra-key') bad.sources[0].unexpected = [];
    const raw = JSON.stringify(bad);
    assert.throws(() => decodeBaselineAuditReport(raw), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
    assert.equal(JSON.stringify(bad), raw); assert.equal(Object.hasOwn(bad.sources[0], 'issues'), invalid !== 'missing');
  }
});

test('new report rejects even a well-formed legacy source hash rather than dropping or replacing it', () => {
  const value = structuredClone(report); value.sources[0].sha256 = 'a'.repeat(64);
  assert.throws(() => decodeBaselineAuditReport(JSON.stringify(value)), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
});

test('typed audit accepts the same native finish report and never relies on wrapped display output', async t => {
  const f = await fixture(t);
  const initial = await ensureTask({ projectRoot: f.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: f.root, taskId: initial.taskId }, task => { task.control ??= {}; });
  assert.equal(initial.groundTruth.sharedBasis, undefined);
  f.state.formatCoverageReport = value => 'All originals and current candidate controls were read.\n\n```json\n' + JSON.stringify(value) + '\n```';
  await f.refresh();
  const record = (await f.task()).groundTruth.sharedBasis;
  assert(record.coverageAudit);
  const bundle = await readJson(record.coverageAudit.pointer.path);
  const messages = bundle.nativeTranscript.split('\n').filter(Boolean).map(line => JSON.parse(line).message).filter(Boolean);
  const call = messages.flatMap(message => message.role === 'assistant' ? message.content : [])
    .find(block => block.type === 'toolCall' && block.name === 'finish_baseline_audit');
  assert.deepEqual(decodeBaselineAuditReport(JSON.stringify(call.arguments.report)), bundle.report);
  assert.equal(bundle.finish.nativeToolCallId, call.id);
  assert(bundle.citations.length > 0); assert.equal(bundle.nativeRecord.status, 'SETTLED');
});

// Exact closed v16 response11 content; format fixture only, never an accepted semantic proof.


test('decoder requires explicit range choice and never inserts a quote into UNIT', () => {
  const value = structuredClone(report), row = value.sources[0];
  row.disposition = 'COVERED'; row.mappings = [{ ...mapping(['one']), rangeMode: 'UNIT' }]; delete row.mappings[0].quote;
  const wire = JSON.stringify(value); assert.deepEqual(decodeBaselineAuditReport(wire), value);
  assert.equal(JSON.stringify(value), wire); assert(!Object.hasOwn(row.mappings[0], 'quote'));
  for (const mutate of [r => { delete r.sources[0].mappings[0].rangeMode; },
    r => { r.sources[0].mappings[0].quote = ''; }, r => { r.sources[0].mappings[0].rangeMode = 'QUOTE'; }]) {
    const bad = structuredClone(value); mutate(bad);
    assert.throws(() => decodeBaselineAuditReport(JSON.stringify(bad)), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  }
});
