// The original full obligation and conditions are unchanged; no defect hints are supplied.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReviewTask } from './review-task.mjs';
import { verifyCites } from './verify-cites.mjs';
import { save, readJson, sha256, within, sourceRepo, newOutput, copyHashed, confirmUnchanged, trackedState, authorizedRuntime } from './harness-common.mjs';

const args = process.argv.slice(2), live = args.includes('--live');
const [destination, source, captureArgument] = args.filter(value => value !== '--live');
if (!destination) throw new Error('Usage: node complex-neutral.mjs NEW_LAB_OUTPUT_DIRECTORY [SOURCE_REPO] [FROZEN_CAPTURE_ROOT] [--live]');
const repository = await sourceRepo(source), before = await trackedState(repository), output = await newOutput(repository, destination);
const capture = await fs.realpath(captureArgument ?? process.env.REVIEW_COMPLEX_CAPTURE ?? 'C:/Users/user/workspace/program_workspace/RC-Exp/isolatedNEW-complex-stop-f1-final-20261024-01');
const workspace = path.join(output, 'workspace');
await fs.mkdir(workspace);
const provenance = [], captureManifest = await readJson(path.join(capture, 'capture-manifest.json'));
provenance.push(await copyHashed(path.join(capture, 'capture-manifest.json'), path.join(workspace, 'provenance/capture-manifest.original.json')));
const sourceItems = captureManifest.filter(item => typeof item.label === 'string' && item.label.startsWith('source/'));
if (!sourceItems.length) throw new Error('No original source entries in frozen capture');
const sourceManifest = [];
for (const item of sourceItems) {
  const name = item.label.slice('source/'.length).replaceAll('\\', '/');
  const original = path.resolve(capture, item.copy.replaceAll('\\', '/'));
  const local = path.resolve(workspace, 'source', name);
  if (!within(capture, original) || !within(path.join(workspace, 'source'), local)) throw new Error('Frozen manifest path escapes source roots');
  const copied = await copyHashed(original, local, item.sha256);
  provenance.push(copied);
  sourceManifest.push({ path: `source/${name}`, originalPath: item.path, capturedPath: original, bytes: copied.bytes, sha256: copied.sha256 });
}
await save(path.join(workspace, 'provenance/source-manifest.json'), sourceManifest);
const groundItem = captureManifest.find(item => item.label === 'ground-truth/current.json');
const populationItem = captureManifest.find(item => item.label === 'metrics/population.json');
for (const [item, name] of [[groundItem, 'ground-truth.full.original.json'], [populationItem, 'population.full.original.json']]) {
  if (!item) throw new Error(`Missing original ${name}`);
  const original = path.resolve(capture, item.copy.replaceAll('\\', '/'));
  if (!within(capture, original)) throw new Error('Frozen original path escapes capture root');
  provenance.push(await copyHashed(original, path.join(workspace, 'provenance', name), item.sha256));
}
const scope = path.join(capture, 'full-snapshot-preflight/item-24/review-scope');
const scopeIndex = await readJson(path.join(scope, '00004-required-ground-truth-basis-index.json'));
const scopePointer = await readJson(path.join(scope, '00005-required-ground-truth-basis.json'));
provenance.push(await copyHashed(path.join(scope, '00004-required-ground-truth-basis-index.json'), path.join(workspace, 'provenance/required-basis-index.original.json')));
provenance.push(await copyHashed(path.join(scope, '00005-required-ground-truth-basis.json'), path.join(workspace, 'provenance/required-basis-pointer.original.json')));
const chunks = [];
let offset = 0;
for (const [index, part] of scopeIndex.records.entries()) {
  if (part.offset !== offset || !within(scope, path.resolve(part.path))) throw new Error('Frozen required basis has an offset gap or external part');
  const bytes = await fs.readFile(part.path);
  if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error('Frozen required basis part hash/length mismatch');
  provenance.push(await copyHashed(part.path, path.join(workspace, `provenance/required-basis-part-${index + 1}.original.txt`), part.sha256));
  chunks.push(bytes); offset += bytes.length;
}
const exactBasis = Buffer.concat(chunks);
if (exactBasis.length !== scopePointer.sourceBytes || sha256(exactBasis) !== scopePointer.sourceSha256) throw new Error('Frozen required basis reconstruction mismatch');
await fs.mkdir(path.join(workspace, 'basis'));
await fs.writeFile(path.join(workspace, 'provenance/required-basis.original.json'), exactBasis);
const basis = JSON.parse(exactBasis.toString('utf8'));
const f1 = basis.claims.filter(item => item.claimId === 'f1'), common = basis.claims.filter(item => item.claimId !== 'f1');
if (f1.length !== 1 || common.length !== 79 || basis.reviewScope.selectedSourceIds.join(',') !== 'f1') throw new Error('Expected exactly original f1 plus all 79 common claims');
const fullGround = await readJson(path.join(workspace, 'provenance/ground-truth.full.original.json'));
for (const claim of basis.claims) {
  const original = fullGround.claims.find(item => item.claimId === claim.claimId && item.revisionId === claim.revisionId);
  if (!original || JSON.stringify(original) !== JSON.stringify(claim)) throw new Error(`Scoped claim differs from full original ground truth: ${claim.claimId}`);
}
await save(path.join(workspace, 'basis/f1-and-common-79.json'), basis);
const requiredFile = 'source/app-requirements.md', requiredLines = (await fs.readFile(path.join(workspace, requiredFile), 'utf8')).split('\n');
const primaryRequirement = requiredLines.findIndex(line => /^\|\s*商品展示\s*\|/u.test(line)) + 1;
const acceptanceRequirement = requiredLines.findIndex(line => /^- \[ \] 图片加载时显示占位图/u.test(line)) + 1;
if (!primaryRequirement || !acceptanceRequirement) throw new Error('Cannot establish original f1 requirement anchors');
const basisLines = (await fs.readFile(path.join(workspace, 'basis/f1-and-common-79.json'), 'utf8')).split('\n');
const idLine = basisLines.findIndex(line => /^\s*"claimId": "f1",?\s*$/u.test(line));
const claimStart = idLine - 1, indentation = basisLines[claimStart]?.match(/^\s*/u)?.[0] ?? '';
let claimEnd = -1;
for (let index = idLine + 1; index < basisLines.length; index++) {
  if (basisLines[index] === `${indentation}}` || basisLines[index] === `${indentation}},`) { claimEnd = index; break; }
}
if (claimStart < 0 || basisLines[claimStart].trim() !== '{' || claimEnd <= claimStart) throw new Error('Cannot establish the complete original f1 claim anchor');
const entry = [
  '# Assigned implementation review', '',
  `Check the captured current implementation against original f1: ${f1[0].text}`,
  'Read basis/f1-and-common-79.json and source/app-requirements.md completely. All 79 original common conditions and exceptions are retained without summarization or applicability deletion. Preserve any uncertainty about applicability.',
  'The complete captured source tree is available under source/. Use read-only search and source inspection to obtain the evidence needed for the assigned proof question. Original full ground truth, population and source manifest remain in provenance/ for audit and dependency lookup.',
  'This task asks about implementation only, not M01 requirement decomposition coverage, M02 decomposition qualification, M05 acceptance-criteria coverage, runtime acceptance, screenshots or all project requirements. Do not substitute this answer for another proof question.',
  'The original scope has dependencyCompleteness=NOT_PROVEN. No trustworthy Git baseline is available for this capture; absence of a diff does not prove acceptance. Do not infer execution from source. No build, emulator, original project/session access, Stop orchestration or project modification is authorized in this review.', '',
].join('\n');
await fs.writeFile(path.join(workspace, 'basis/review-entry.md'), entry);
const targetFiles = sourceManifest.filter(item => item.path.startsWith('source/entry/src/') && item.path.endsWith('.ets')).map(item => item.path);
if (!targetFiles.length) throw new Error('No captured application source files');
const task = { id: 'f1-implementation', scope: 'SOURCE_IMPLEMENTATION',
  requirement: 'Check the captured implementation against the full original f1 obligation and all original common conditions and exceptions. Preserve applicability and dependency uncertainty. This is one implementation proof question, not requirement-quality metrics or actual runtime acceptance.',
  basisFiles: ['basis/review-entry.md', 'basis/f1-and-common-79.json', requiredFile], targetFiles,
  basisAnchors: [
    { claimId: 'f1', path: 'basis/f1-and-common-79.json', start: claimStart + 1, end: claimEnd + 1 },
    { claimId: 'f1-source-requirement', path: requiredFile, start: primaryRequirement, end: primaryRequirement },
    { claimId: 'f1-source-acceptance', path: requiredFile, start: acceptanceRequirement, end: acceptanceRequirement },
  ],
  navigation: { diff: null, baseline: null, workspace: 'NO_TRUSTED_GIT_BASE', primaryEvidence: 'complete source snapshot with recorded hashes', sourceManifest: 'provenance/source-manifest.json' } };
await save(path.join(output, 'task.json'), task);
const runtime = live ? await authorizedRuntime(output) : null;
await save(path.join(output, 'engine.json'), { mode: live ? 'LIVE_REVIEW' : 'OFFLINE_PREFLIGHT', model: runtime?.primary ?? null, maxAttempts: 2, maxTurns: 100,
  tokenBudget: null, deadline: null, nativeCompaction: true, modelRequests: live ? 'See review/events.jsonl' : 0 });
let result = null, citations = null;
if (live) {
  result = await runReviewTask({ task, root: workspace, outputDir: path.join(output, 'review'), modelRuntime: runtime.runtime, model: runtime.model, maxAttempts: 2, maxTurns: 100,
    onEvent: event => { if (['assistant', 'attempt', 'decision_saved'].includes(event.type)) console.log(JSON.stringify({ caseId: 'F01', ...event })); } });
  citations = await verifyCites(path.join(output, 'review'));
  await save(path.join(output, 'citation-verification.json'), citations);
}
const capturedSourcesUnchanged = await confirmUnchanged(provenance), after = await trackedState(repository);
const originalRepositoryUnchanged = JSON.stringify(before) === JSON.stringify(after), originalConfigurationUnchanged = runtime ? await runtime.unchanged() : null;
const protectedInputsUnchanged = capturedSourcesUnchanged && originalRepositoryUnchanged && originalConfigurationUnchanged !== false;
const report = { status: !protectedInputsUnchanged ? 'FAIL' : live ? (result.completed && citations.passed && result.scope === task.scope ? 'REVIEW_COMPLETED' : 'REVIEW_INCOMPLETE') : 'PREFLIGHT_PASS',
  sourceCapture: capture, sourceFiles: sourceManifest.length, targetFiles: targetFiles.length, f1Claims: 1, commonClaims: common.length, mandatoryBasisBytes: exactBasis.length,
  syntheticMaterial: false, defectHintRemoved: true, exactBasisSha256: sha256(exactBasis), originalRepositoryUnchanged, sourceStateBefore: before, sourceStateAfter: after,
  capturedSourcesUnchanged, originalConfigurationUnchanged, originalProjectOrSessionWritten: false, task, result, citations, provenance,
  semanticValidation: 'PENDING_INDEPENDENT_REVIEW: use the prepared source oracle outside the workspace; verdict and citation integrity alone do not prove semantic support.',
  limitations: 'Same captured implementation and retained conditions, one neutral implementation proof only. Not the former four metrics, runtime acceptance, full371 acceptance, Stop integration, a blind project sample or proof of live overflow recovery.' };
const temporary = path.join(output, 'report.json.tmp');
await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await fs.rename(temporary, path.join(output, 'report.json'));
console.log(JSON.stringify({ status: report.status, output, sourceFiles: report.sourceFiles, commonClaims: report.commonClaims, basisBytes: exactBasis.length, verdict: result?.verdict ?? null }));
if (['FAIL', 'REVIEW_INCOMPLETE'].includes(report.status)) process.exitCode = 1;
