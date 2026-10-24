// Preparation only: read frozen local materials, copy to independent review workspaces.
// Never execute business code, build tools, models or the original agent session.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const output = path.dirname(fileURLToPath(import.meta.url));
const original = 'C:/Users/user/workspace/program_workspace/runtime-corrector-exp/experiments/ma-rc/run0/flower_eshop';
const taskRoot = `${original}/.runtime-correction/tasks/oc-scope-6ada1545-314a-46b4-9e5f-7310a278c80c`;
const archive = `${original}/openspec/changes/archive/2026-10-21-agent-main-session-1792621726192-8kt0bj`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => { const bytes = await fs.readFile(file); return { file, bytes, sha256: digest(bytes), lines: bytes.toString('utf8').split('\n').length }; };
const saved = new Map();
async function remember(file) { if (!saved.has(file)) saved.set(file, await read(file)); return saved.get(file); }
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }

const population = JSON.parse((await remember(`${taskRoot}/metrics/population.json`)).bytes);
const groundTruth = await remember(`${taskRoot}/ground-truth/current.md`);
await remember(`${taskRoot}/ground-truth/current.json`);
const requirements = await remember(`${original}/app-requirements.md`);
const specs = new Map();
for (const entry of (await fs.readdir(`${original}/openspec/specs`, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
  specs.set(`candidate/specs/${entry.name}/spec.md`, await remember(`${original}/openspec/specs/${entry.name}/spec.md`));
}
assert.equal(specs.size, 8);
specs.set('candidate/design.md', await remember(`${archive}/design.md`));
const code = new Map();
async function sourceTree(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Source symlink is outside the declared fixture contract');
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceTree(absolute);
    else if (entry.isFile() && entry.name.endsWith('.ets')) {
      const relative = path.relative(original, absolute).replaceAll('\\', '/');
      code.set(`implementation/${relative}`, await remember(absolute));
    }
  }
}
await sourceTree(`${original}/entry/src/main/ets`);
for (const name of ['entry/src/main/module.json5', 'entry/src/main/resources/base/profile/main_pages.json']) code.set(`implementation/${name}`, await remember(`${original}/${name}`));
const report = await remember(`${original}/ACCEPTANCE.md`);
const formalPaths = [...specs.keys()];
const homeSpec = 'candidate/specs/commodity-browsing/spec.md';
const detailSpec = 'candidate/specs/commodity-detail/spec.md';
const homeSource = 'implementation/entry/src/main/ets/pages/Index.ets';
const modelSource = 'implementation/entry/src/main/ets/model/Commodity.ets';
const manifestSource = 'implementation/entry/src/main/module.json5';
const storageSource = 'implementation/entry/src/main/ets/data/StorageUtil.ets';

const originalHome = specs.get(homeSpec).bytes.toString('utf8');
const imageSentence = '图片加载时 SHALL 显示占位图，加载失败 SHALL 显示默认占位图。';
assert(originalHome.includes(imageSentence));
const scenarioPattern = /#### Scenario: 图片加载中或失败\r?\n- \*\*WHEN\*\* 商品图片正在加载或加载失败\r?\n- \*\*THEN\*\* 显示占位图，不阻塞列表其他内容展示\r?\n\r?\n/u;
assert(scenarioPattern.test(originalHome));
const missingCondition = originalHome.replace(imageSentence, '').replace(scenarioPattern, '');
const missingCriterion = originalHome.replace(scenarioPattern, '');
assert(!missingCondition.includes('占位图'));
assert(missingCriterion.includes(imageSentence));

const rows = [
  { caseId: 'F01', metricId: 'M01', sourceId: 'gt-007', split: 'dev', expected: 'PASS', kind: 'original', evidence: [{path:homeSpec,start:6,end:15}], rootCause:'The formal requirement and its scenario explicitly identify home-card image/name/price and the loading placeholder. Source implementation defects are outside M01.' },
  { caseId: 'F02', metricId: 'M01', sourceId: 'gt-007', split: 'dev', expected: 'DEVIATION', kind: 'controlled-requirement-and-scenario-omission', mutation: missingCondition, evidence: [{path:homeSpec,start:6,end:15}], rootCause:'The complete declared formal corpus no longer identifies the home-card image-loading placeholder. Both equivalent requirement text and its scenario are removed in the isolated candidate; original requirements and Ground Truth remain intact.' },
  { caseId: 'F03', metricId: 'M01', sourceId: 'gt-009', split: 'holdout', expected: 'PASS', kind: 'original-cross-artifact-coverage', evidence: [{path:homeSpec,start:28,end:37},{path:'candidate/design.md',start:36,end:39}], rootCause:'The browsing requirement/scenarios identify bottom history, last-ten retention and restart persistence; the design identifies Preferences and browse_history. Together they cover the entire frozen object.' },
  { caseId: 'F04', metricId: 'M05', sourceId: 'gt-007', split: 'dev', expected: 'PASS', kind: 'original', evidence: [{path:homeSpec,start:9,end:15}], rootCause:'The normal-display and loading/failure scenarios jointly cover every core obligation of the selected home-card requirement.' },
  { caseId: 'F05', metricId: 'M05', sourceId: 'gt-007', split: 'dev', expected: 'DEVIATION', kind: 'controlled-scenario-omission', mutation: missingCriterion, evidence: [{path:homeSpec,start:6,end:15}], rootCause:'The candidate requirement still states image-loading placeholders, but the candidate acceptance scenarios cover only normal display. The original input PRD is a basis, not a generated acceptance criterion.' },
  { caseId: 'F06', metricId: 'M05', sourceId: 'gt-014', split: 'holdout', expected: 'DEVIATION', kind: 'original-missing-failure-criterion', evidence: [{path:detailSpec,start:6,end:15}], rootCause:'The selected detail requirement includes fallback placeholder on image-load failure. Existing acceptance scenarios cover displayed details and price screen-reading, but none covers that failure outcome.' },
  { caseId: 'F07', metricId: 'M12', sourceId: 'gt-025', split: 'dev', expected: 'PASS', kind: 'original-static-configuration', evidence: [{path:manifestSource,start:14,end:80}], rootCause:'All eight permissions required by the entire gt-025 object appear in requestPermissions. This obligation concerns declarations and is statically decidable, without asserting runtime permission grants.' },
  { caseId: 'F08', metricId: 'M12', sourceId: 'gt-007', split: 'dev', expected: 'DEVIATION', kind: 'original-source-contradiction', evidence: [{path:homeSource,start:234,end:260},{path:modelSource,start:1,end:18}], rootCause:'Home commodityCard renders Text(c.emoji) on a colored surface with name/price. The model has no product-image field, and the card has no image loading transition or corresponding placeholder. A comment calling emoji a placeholder and a self-reported PASS do not implement the image obligation.' },
  { caseId: 'F09', metricId: 'M12', sourceId: 'gt-009', split: 'holdout', expected: 'UNVERIFIED', kind: 'original-source-without-trusted-runtime-record', evidence: [{path:storageSource,start:51,end:87},{path:'background/self-reported-acceptance.md',start:23,end:28}], rootCause:'Code and a self-authored acceptance report suggest restart persistence, but the frozen review input contains no independently verifiable execution record bound to its current source/build. Actual restart/persistence acceptance is not established from source or an unbound self-report.' },
];

const definitions = {
  M01: {name:'Requirement decomposition coverage', owner:'ARTIFACT', scope:'METRIC_ARTIFACT_REVIEW', definition:'Evaluate whether the entire frozen requirement object is recognizably represented in the declared formal decomposition artifacts, including its applicable conditions and exceptions. This is requirement-understanding coverage, not correctness of implementation or runtime execution.'},
  M05: {name:'Acceptance criteria coverage', owner:'ARTIFACT', scope:'METRIC_ARTIFACT_REVIEW', definition:'Evaluate whether all core obligations of the selected frozen requirement are covered by the candidate acceptance criteria/scenarios. The declared candidate scenarios/acceptance units are evaluated semantically; they need no particular title, syntax or identifier. General requirement-body statements and the input PRD do not themselves substitute for candidate acceptance criteria.'},
  M12: {name:'Requirement execution rate', owner:'IMPLEMENTATION', scope:'SOURCE_IMPLEMENTATION', definition:'Evaluate fulfillment of exactly the supplied frozen requirement object, with proof appropriate to its verification target. Source-decidable declarations or concrete contradictions may be decided from source. Actual runtime behavior must not be marked PASS merely from code, comments, checked tasks or an unbound self-report.'},
};

const cases = [];
for (const row of rows) {
  const directory = path.join(output,row.caseId), workspace = path.join(directory,'workspace');
  await fs.mkdir(workspace,{recursive:true});
  const frozenObject = population.metrics[row.metricId].find(object => object.sourceId === row.sourceId);
  assert(frozenObject);
  const metric = definitions[row.metricId];
  const runtime = row.caseId === 'F09';
  const selectedPaths = row.metricId === 'M12' ? (runtime ? [storageSource,homeSource,'implementation/entry/src/main/ets/pages/CommodityDetail.ets',modelSource] : row.caseId === 'F07' ? [manifestSource] : [homeSource,modelSource]) : formalPaths;
  const task = {
    id: `${row.metricId}:${row.sourceId}`,
    scope: runtime ? 'RUNTIME_ACCEPTANCE' : metric.scope,
    metricId: row.metricId, metricName: metric.name, metricCatalogVersion: population.catalogVersion,
    owner: runtime ? 'RUNTIME' : metric.owner, phase: runtime ? 'VERIFICATION' : row.metricId === 'M12' ? 'IMPLEMENTATION' : 'REQUIREMENTS',
    requirement: `${metric.definition} Judge the complete object in basis/selected-object.json using the complete original basis and the role manifest. Review only this one metric/object; observations about other metrics do not substitute for this proof question. The original GT and source PRD remain authoritative. The complete candidate artifact set for this review is enumerated in basis/input-roles.json. All available files are frozen and read-only. ${runtime ? 'This task asks whether actual restart persistence has been acceptably verified for the supplied state. The input contains source and a self-reported narrative, but no trusted source/build-bound execution record. Do not run the application.' : ''}`.trim(),
    basisFiles:['basis/metric-contract.md','basis/selected-object.json','basis/input-roles.json','basis/original-ground-truth.md','source/app-requirements.md'],
    targetFiles:selectedPaths,
    navigation:{diff:null,baseline:null,workspace:'FROZEN_REVIEW_STAGE',primaryEvidence:selectedPaths,formalArtifacts:formalPaths},
  };
  const copies=[];
  const copy = async (name, source, replacement) => {
    const bytes = replacement === undefined ? source.bytes : Buffer.from(replacement);
    await write(path.join(workspace,name),bytes);
    copies.push({path:name,source:source.file,sourceSha256:source.sha256,candidateSha256:digest(bytes),unchanged:replacement===undefined,bytes:bytes.length});
  };
  await copy('source/app-requirements.md',requirements);
  await copy('basis/original-ground-truth.md',groundTruth);
  await write(path.join(workspace,'basis/selected-object.json'),frozenObject);
  await write(path.join(workspace,'basis/metric-contract.md'),`# Frozen metric contract\n\nCatalog: ${population.catalogVersion}\nMetric: ${row.metricId} — ${metric.name}\n\n${metric.definition}\n\nOwner: ${runtime?'RUNTIME':metric.owner}. Scope: ${task.scope}.\nThe selected object is preserved verbatim from the original frozen population. Its original verificationTarget field does not change the metric's meaning: M01 is formal decomposition coverage and M05 is candidate acceptance coverage.\nThe original PRD and original Ground Truth are reference inputs; candidate/specs and candidate/design.md are the formally produced documents being reviewed. Requirements and constraints remain applicable, but only the selected metric/object is judged.\n`);
  for (const [name,source] of specs) await copy(name,source,name===homeSpec?row.mutation:undefined);
  for (const [name,source] of code) await copy(name,source);
  await copy('background/self-reported-acceptance.md',report);
  await write(path.join(workspace,'basis/input-roles.json'),{
    schemaVersion:'metric-review-input-roles.v1',
    authoritativeInputs:['basis/selected-object.json','basis/original-ground-truth.md','source/app-requirements.md'],
    formalCandidateArtifacts:formalPaths,
    candidateAcceptanceUnits:'The semantically defined candidate acceptance/scenario units in the declared formal candidate artifacts; no mandatory heading/ID syntax.',
    sourceImplementation:[...code.keys()],
    backgroundSelfReports:['background/self-reported-acceptance.md'],
    trustedSourceBuildBoundRuntimeEvidence:[],
    corpusCompleteness:'The enumerated candidate formal corpus is the complete candidate artifact set for this isolated review. Original input PRD, source implementation and self-reports are separate roles.',
  });
  await write(path.join(directory,'task.json'),task);
  const evidence = [];
  for (const anchor of row.evidence) {
    const bytes=await fs.readFile(path.join(workspace,anchor.path));
    evidence.push({...anchor,sha256:digest(bytes),text:bytes.toString('utf8').split('\n').slice(anchor.start-1,anchor.end).join('\n')});
  }
  await write(path.join(directory,'oracle.json'),{
    schemaVersion:'metric-review-independent-oracle.v1',caseId:row.caseId,domain:'flower',metricId:row.metricId,sourceObjectId:frozenObject.objectId,
    expected:row.expected,rootCause:row.rootCause,kind:row.kind,scope:task.scope,
    authority:{populationPath:`${taskRoot}/metrics/population.json`,populationSha256:(await remember(`${taskRoot}/metrics/population.json`)).sha256,originalObject:frozenObject},
    mutation:row.mutation?{path:homeSpec,originalSha256:specs.get(homeSpec).sha256,candidateSha256:digest(Buffer.from(row.mutation)),controlled:true,changesGroundTruth:false}:null,
    evidence,sourceCopies:copies,
    limits:['One complete frozen object, not the whole metric denominator','Evidence labels and this oracle are excluded from model workspace','For M12 runtime scope, missing trusted execution evidence is UNVERIFIED, not a business defect','Controlled candidate document mutations never alter original project files or original requirements'],
  });
  cases.push({caseId:row.caseId,domain:'flower',metricId:row.metricId,split:row.split,workspace,task:path.join(directory,'task.json'),oracle:path.join(directory,'oracle.json')});
}
await write(path.join(output,'cases.json'),cases);
const integrity=[];
for (const source of saved.values()) {
  const after=await read(source.file);assert.equal(after.sha256,source.sha256,source.file);
  integrity.push({path:source.file,sha256:source.sha256,bytes:source.bytes.length,lines:source.lines,unchanged:true});
}
await write(path.join(output,'source-integrity.json'),{schemaVersion:'read-only-fixture-provenance.v1',originalProject:original,originalSessionAccessed:false,originalProjectWritten:false,E2ERun:false,modelCalled:false,files:integrity});
console.log(JSON.stringify({cases:cases.length,originalSourceFilesVerified:integrity.length,output}));
