import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../lib/plugin-builder.mjs';
import { admittedProjectScopes } from './support/openclaw-project-scope.mjs';
import { createOriginalSourceAnchor } from '../lib/runtime-v2/original-source-anchor.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { readOpenSpecPlan } from '../lib/openspec-plan.mjs';

const changeName = 'preserve-display-order';
const prefix = `openspec/changes/${changeName}`;
const tasks = '# Tasks\n\n- [ ] Retain the selected order.\n';
let output, pluginRoot, createRuntime, registerPlanControl, inspectPlan, findTask, ensureTask;
before(async () => {
  output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-openspec-drift-build-')));
  pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: path.resolve('.'), outputRoot: output });
  ({ createOpenClawRuntime: createRuntime } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/runtime.mjs'))));
  ({ registerOpenSpecPlanControl: registerPlanControl, inspectArmedOpenSpecApply: inspectPlan } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/openspec-plan-control.mjs'))));
  ({ findTask, ensureTask } = await import(pathToFileURL(path.join(pluginRoot, 'lib/runtime-v2/task-store.mjs'))));
});
after(() => output && fs.rm(output, { recursive: true, force: true }));

async function fixture(t, { arm = true, shadow = false, review = false, reviewerFailure = false,
  proposalOnly = false, reviewer, strictSources, partialManualCheck = false, fullPlanReview = false, configVersion = 2,
  skipProgress = true, extraConfig = '', forbidProgress = false, stageMetrics = false,
  dynamicGroundTruth = false, groundTruthReview = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-native-plan-drift-')));
  let runtime;
  t.after(async () => { await runtime?.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); });
  await fs.mkdir(path.join(root, '.runtime-corrector'));
  await fs.writeFile(path.join(root, '.runtime-corrector/config.yaml'), `version: ${configVersion}
artifacts:
${partialManualCheck ? `  - name: partial-plan
    stage: proposal
    patterns: ["${prefix}/design.md"]
    rules:
      enabled: false
    review:
      enabled: true
` : ""}  - name: plan
    stage: proposal
    patterns: ["openspec/changes/**/proposal.md", "openspec/changes/**/design.md", "openspec/changes/**/tasks.md", "openspec/changes/**/specs/**/spec.md"]
${strictSources || fullPlanReview ? `    relatedRoot: project
    relatedPatterns: ["${prefix}/**/*.md"]
` : ""}    rules:
      enabled: ${forbidProgress}
${forbidProgress ? '      file: progress.rules.yaml\n' : ''}    review:
      enabled: ${review}
${skipProgress === null ? '' : `      skipApprovedTaskProgress: ${skipProgress}\n`}
      criteria: review.md
${configVersion === 2 ? `dynamicGroundTruth:
  enabled: ${dynamicGroundTruth}
stopCorrection:
  enabled: false
` : ''}artifactCorrection:
  originalRequirementsEnabled: true
  requireOpenSpecProposalCoverage: true
  groundTruthReviewEnabled: ${groundTruthReview}
  stageMetricsEnabled: ${stageMetrics}
${extraConfig}
shadowMode: ${shadow}
`);
  await fs.writeFile(path.join(root, '.runtime-corrector/review.md'), 'Review the complete plan against the original request.\n');
  if (forbidProgress) await fs.writeFile(path.join(root, '.runtime-corrector/progress.rules.yaml'),
    'version: 1\nrules:\n  - id: REQUIRE-INDEPENDENT-COMPLETION-CHECK\n    type: forbid-text\n    values: ["[x]"]\n    severity: error\n');
  const documents = {
    [`${prefix}/proposal.md`]: '# Proposal\n\nRetain display preferences.\n',
    [`${prefix}/design.md`]: '# Design\n\nRestore selected order on start.\n',
    [`${prefix}/tasks.md`]: tasks,
    [`${prefix}/specs/order/spec.md`]: '## ADDED Requirements\n\n### Requirement: Order\nThe app SHALL retain the selected order.\n',
  };
  await fs.mkdir(path.join(root, prefix, 'specs/order'), { recursive: true });
  for (const [relative, text] of Object.entries(documents)) await fs.writeFile(path.join(root, relative), text);
  const sid = 'native-plan-parent', sessionKey = 'agent:main:plan-drift';
  const transcript = path.join(root, 'native.jsonl');
  await fs.writeFile(transcript, [{ type: 'session', id: sid }, { type: 'message', id: 'original', parentId: null,
    message: { role: 'user', content: 'Retain the selected display order.' } }].map(JSON.stringify).join('\n'));
  const sharedState = {}, warnings = [], methods = new Map();
  const sessions = { getSessionEntry: async () => ({ sessionId: sid, sessionFile: transcript }),
    resolveStorePath: () => path.join(root, 'sessions.json'), resolveSessionFilePath: () => transcript,
    runWithWorkAdmission: async (params, run) => run(params.signal) };
  const api = { id: 'runtime-corrector', config: { agents: { defaults: { model: { primary: 'test/test' } } } },
    logger: { warn: value => warnings.push(value) }, registerGatewayMethod: (name, handler) => methods.set(name, handler),
    runtime: { version: '2026.7.1-2', gateway: { async request(method, params) {
      if (method === 'agent.wait') return { runId: params.runId, status: 'ok' };
      if (method === 'autopilot.status') return { projection: { status: 'idle' } };
      assert.fail(`Unexpected gateway method: ${method}`);
    } }, agent: { session: sessions,
      runEmbeddedAgent: async () => assert.fail('The plan drift guard must run without a model.') } } };
  const projectScopes = admittedProjectScopes(api);
  const task = await ensureTask({ projectRoot: root, sessionId: sid });
  projectScopes.activate = async () => ({ taskId: task.taskId });
  const calls = [];
  const reviewerFactory = async options => {
    calls.push(options.role);
    if (reviewerFailure) throw new Error('The artifact reviewer is unavailable.');
    if (reviewer) return reviewer(options);
    return { sessionId: 'artifact-review', result: { summary: 'Reviewed the selected artifact.', findings: [], edits: [] },
      async close() {} };
  };
  runtime = createRuntime(api, { pluginRoot, sharedState, nativeHooks: true, projectScopes,
    ...(review ? { reviewerFactory } : {}),
    postRunTerminal: async (_identity, runId) => ({ runId, status: 'ok' }) });
  const ctx = { workspaceDir: root, sessionId: sid, sessionKey, agentId: 'main', runId: 'proposal', trigger: 'user',
    abortSignal: new AbortController().signal };
  await runtime.prompt({ prompt: 'Retain the selected display order.' }, ctx);
  const state = sharedState.states.get(`main:${sid}`);
  registerPlanControl(api, { async openSpecPlanTarget(query) {
    return query.runId === state.nativeRunId && query.sessionId === sid && query.sessionKey === sessionKey
      ? { state, projectRoot: root, current: async () => true,
        ...(strictSources ? { requireProposalCoverage: true, readProposalSources: async () => strictSources } : {}) } : null;
  } });
  async function request(action, params) {
    let response;
    await methods.get(`runtime-corrector.openspec.${action}`)({ params,
      client: { connect: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
      respond(...args) { response = args; } });
    assert(response);
    return response;
  }
  async function rpc(action, params) {
    const [ok, value, error] = await request(action, params);
    assert.equal(ok, true, error?.message);
    return value;
  }
  const address = { sessionKey, sessionId: sid, runId: ctx.runId, changeName };
  if (arm) {
    const preview = await rpc('preview', address);
    const approval = { ...address, expectedRevision: preview.revision };
    await rpc('approve', approval);
    await rpc('arm', { ...approval, applyRunId: 'apply' });
  }
  if (!proposalOnly) {
    await runtime.agentEnd({ runId: ctx.runId, success: true }, ctx);
    await runtime.waitForNativeReviews({ drain: true });
    ctx.runId = 'apply';
    await runtime.prompt({ prompt: 'Apply the approved plan.' }, ctx);
  }

  const journal = async () => {
    const task = await findTask({ projectRoot: root, sessionId: sid });
    const file = path.join(root, '.runtime-correction/tasks', task.taskId, 'journal/events.jsonl');
    return fs.readFile(file, 'utf8').then(text => text.split('\n').filter(Boolean).map(JSON.parse), error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  };
  let nextId = 0;
  async function edit(relative, contents, { result = {}, toolName = 'write', args, beforeResult, eventRunId } = {}) {
    const toolCallId = `native-change-${++nextId}`;
    args ??= { path: path.join(root, relative), content: contents };
    await runtime.beforeTool({ toolName, toolCallId, params: args }, ctx);
    if (contents !== null) await fs.writeFile(path.join(root, relative), contents);
    await beforeResult?.();
    const event = { toolName, toolCallId, args, ...(eventRunId ? {runId:eventRunId} : {}), result: {
      content: [{ type: 'text', text: 'Original host tool result' }], details: { original: true }, ...result,
    } };
    return { event, outcome: await runtime.toolResult(event, ctx), toolCallId };
  }
  async function check(relative, options = {}) {
    const toolCallId = `native-check-${++nextId}`;
    await runtime.beforeTool({ toolName: 'runtime_corrector', toolCallId, params: { command: 'check', subject: relative } }, ctx);
    const { runId, abortSignal, ...factoryContext } = ctx;
    return runtime.manualCheck(factoryContext, relative, { toolCallId, signal: abortSignal, ...options });
  }
  return { root, ctx, state, runtime, projectScopes, documents, warnings, calls, edit, check, journal, address, rpc, request,
    api, sharedState, transcript };
}

async function approvedFixture(t, options = {}) {
  const text = 'Retain the selected display order.', source = { ref: 'transcript:original', text };
  const identity = { ref: source.ref, sha256: sha256(text), start: 1, end: 1 };
  const anchor = createOriginalSourceAnchor({ ...identity, bytes: Buffer.from(text) });
  const requiredAtoms = [{ source: identity, requirement: text }];let reviewMode = 'clean';
  const f = await fixture(t, { arm: false, proposalOnly: true, review: true, fullPlanReview: true,
    strictSources: [source], ...options,
    reviewer: async args => {
      const snapshot = await readOpenSpecPlan(args.projectRoot, changeName), target = snapshot.documents.find(file => file.path.endsWith('/spec.md'));
      const findings = reviewMode === 'blocked' ? [{ ruleId:'AGENT-PLAN-CONFLICT',severity:'error',path:`${prefix}/design.md`,
        message:'The plan requires a conflicting default.',evidence:['The current review cannot accept this plan.'],suggestion:'Resolve the conflict.' }] : [];
      if(reviewMode==='unavailable')throw new Error('The independent reviewer is unavailable.');
      return { sessionId: 'prior-clean-plan', result: { summary: 'Reviewed the current complete plan.', findings, edits: [] },
        originalRequirementCoverage: { schemaVersion: 1, scope: snapshot.documents,
          rows: [{ source: anchor, requirement: text, disposition: 'COVERED', targets: [{ ...target, start: 4, end: 4 }] }] }, async close() {} };
    } });
  await f.edit(`${prefix}/proposal.md`, f.documents[`${prefix}/proposal.md`] + 'Preserve the documented public behavior.\n');
  const { selectApprovedPlanCoverage } = await import(pathToFileURL(path.join(pluginRoot, 'lib/openclaw/approved-plan-coverage.mjs')));
  f.priorCoverage = selectApprovedPlanCoverage(f.state, 'proposal', await readOpenSpecPlan(f.root, changeName));
  const preview = await f.rpc('preview', f.address);
  const approved = await f.rpc('approve', { ...f.address, expectedRevision: preview.revision, requiredAtoms });
  if (!options.unarmed) await f.rpc('arm', { ...f.address, expectedRevision: preview.revision, expectedInventorySha256: approved.inventorySha256, applyRunId: 'apply' });
  await f.runtime.agentEnd({ runId: f.ctx.runId, success: true }, f.ctx);
  await f.runtime.waitForNativeReviews({ drain: true });
  await fs.appendFile(f.transcript, '\n'+JSON.stringify({type:'message',id:'apply-user',parentId:'original',message:{role:'user',content:'Apply the approved plan.',idempotencyKey:'apply:user'}})+'\n');
  f.ctx.runId = 'apply'; await f.runtime.prompt({ prompt: 'Apply the approved plan.' }, f.ctx);
  if (!options.unarmed) assert.equal((await inspectPlan(f.state, 'apply')).status, 'PRESERVED');
  f.setReviewMode = value => {reviewMode=value;};
  return f;
}

test('opt-in authenticated checkbox progress preserves mutation evidence without another semantic worker or fresh PASS', async t => {
  const f = await approvedFixture(t), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  const rows = (await f.journal()).filter(row => row.toolCallId === toolCallId);
  assert.equal(f.calls.length, before, JSON.stringify({ warnings: f.warnings, rows: rows.map(row => ({type:row.type,reason:row.reasonCode})) }));
  const skipped = rows.find(row => row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS');
  assert.equal(skipped?.approvedPlanIntegrity.freshSemanticReview, false);
  assert(rows.some(row => row.type === 'OPENCLAW_ARTIFACT_SNAPSHOT'));
  assert(rows.some(row => row.type === 'OPENCLAW_FILE_CHANGED'));
  assert(!rows.some(row => row.type === 'OPENCLAW_ARTIFACT_REVIEW'));
  assert.equal(f.state.nativeNeedsStop, true);
  assert.deepEqual(f.warnings, []);
});

for (const skipProgress of [null, false]) test(`${skipProgress === null ? 'absent' : 'disabled'} option retains a fresh checkbox semantic review`, async t => {
  const f = await approvedFixture(t, { skipProgress }), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 1);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('repeated permitted checkbox markers remain eligible without publishing semantic results', async t => {
  const f=await approvedFixture(t),before=f.calls.length;
  await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[X]'));
  assert.equal(f.calls.length,before);
  assert((await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const file of ['design.md','tasks.md'])test(`real approved ${file} text changes retain immediate plan-drift enforcement`,async t=>{
  const f=await approvedFixture(t),before=f.calls.length;
  const body=file==='tasks.md'?tasks.replace('Retain','Discard'):'# Design\n\nUse a different default.\n';
  const {outcome,toolCallId}=await f.edit(`${prefix}/${file}`,body);
  assert.match(JSON.stringify(outcome),/Apply changed the approved OpenSpec plan/u);
  assert.equal(f.calls.length,before);
  const rows=(await f.journal()).filter(row=>row.toolCallId===toolCallId);
  assert(rows.some(row=>row.reasonCode==='OPENSPEC_APPLY_PLAN_CHANGED'));
  assert(!rows.some(row=>row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const mode of ['blocked','unavailable'])test(`a newer ${mode} manual review retires the earlier clean shortcut`,async t=>{
  const f=await approvedFixture(t);f.setReviewMode(mode);
  const checked=await f.check(`${prefix}/design.md`);assert.notEqual(checked.result.status,'passed');
  const before=f.calls.length;f.setReviewMode('clean');
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1);
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('a later automatic semantic review retires shortcut reuse even when it passes', async t => {
  const f = await approvedFixture(t), before = f.calls.length;
  await f.edit(`${prefix}/design.md`, f.documents[`${prefix}/design.md`]);
  assert.equal(f.calls.length, before + 1);
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 2);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const mutation of ['criteria','config','enable-option-after-approval','foreign-user','unarmed'])test(`${mutation} cannot reuse old approval authority`,async t=>{
  const f=await approvedFixture(t,{skipProgress:mutation!=='enable-option-after-approval',unarmed:mutation==='unarmed'});
  if(mutation==='criteria')await fs.appendFile(path.join(f.root,'.runtime-corrector/review.md'),'Check an additional independent duty.\n');
  if(mutation==='config')await fs.appendFile(path.join(f.root,'.runtime-corrector/config.yaml'),'\n# Updated review policy\n');
  if(mutation==='enable-option-after-approval'){const file=path.join(f.root,'.runtime-corrector/config.yaml');await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('skipApprovedTaskProgress: false','skipApprovedTaskProgress: true'));}
  if(mutation==='foreign-user')await fs.appendFile(f.transcript,JSON.stringify({type:'message',id:'foreign-input',parentId:'apply-user',message:{role:'user',content:'A new unrelated requirement.'}})+'\n');
  const before=f.calls.length,{toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1,JSON.stringify({mutation,warnings:f.warnings}));
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

for(const policy of ['stageMetrics','groundTruthReview'])test(`independent ${policy} work cannot bootstrap approval from incomplete evidence`,async t=>{
  await assert.rejects(approvedFixture(t,{[policy]:true}),/full-plan Proposal review is unavailable or incomplete/u);
});

test('dynamic Ground Truth keeps the ordinary semantic review for approved checkbox progress', async t => {
  const f = await approvedFixture(t, { dynamicGroundTruth: true }), before = f.calls.length;
  const { toolCallId } = await f.edit(`${prefix}/tasks.md`, tasks.replace('[ ]', '[x]'));
  assert.equal(f.calls.length, before + 1);
  assert(!(await f.journal()).some(row => row.toolCallId === toolCallId && row.reasonCode === 'OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('fresh deterministic rules remain enforced even when a semantic worker reports no finding',async t=>{
  const f=await approvedFixture(t,{forbidProgress:true}),before=f.calls.length;
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  assert.equal(f.calls.length,before+1);
  const rows=(await f.journal()).filter(row=>row.toolCallId===toolCallId);
  const result=rows.find(row=>row.type==='OPENCLAW_ARTIFACT_REVIEW')?.result;
  assert.equal(result?.status,'failed');assert(result.diagnostics.some(row=>row.ruleId==='REQUIRE-INDEPENDENT-COMPLETION-CHECK'));
  assert(!rows.some(row=>row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('conflicting native event and context run identities receive no shortcut receipt',async t=>{
  const f=await approvedFixture(t),{toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'),{eventRunId:'foreign-run'});
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('a run replaced during the shortcut freshness check cannot publish old integrity evidence',async t=>{
  const f=await approvedFixture(t),before=f.calls.length,readFile=fs.readFile,criteria=path.join(f.root,'.runtime-corrector/review.md');let reads=0,replaced=false;
  const {toolCallId}=await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'),{beforeResult(){
    t.mock.method(fs,'readFile',async(...args)=>{const value=await readFile(...args);if(args[0]===criteria&&++reads===3){replaced=true;f.state.nativeRunId='replacement';}return value;});
  }});
  assert(replaced,'The run must change inside the policy/input freshness pass.');
  assert.equal(f.calls.length,before,'The obsolete event cannot start a worker for the replacement run.');
  assert(!(await f.journal()).some(row=>row.toolCallId===toolCallId&&row.reasonCode==='OPENSPEC_APPROVED_TASK_PROGRESS'));
});

test('checkbox reuse still reaches a fresh native final Stop and cannot pass without code evidence',{timeout:10000},async t=>{
  const f=await approvedFixture(t);await f.edit(`${prefix}/tasks.md`,tasks.replace('[ ]','[x]'));
  await f.runtime.reply({kind:'final',runId:'apply',sessionKey:f.ctx.sessionKey,payload:{text:'Completed the approved work.'}},f.ctx);
  await f.runtime.agentEnd({runId:'apply',success:true},f.ctx);await f.runtime.waitForNativeReviews({drain:true});
  const directory=path.join(f.root,'.runtime-correction/openclaw/native-stop-reviews'),records=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isDirectory())continue;for(const name of await fs.readdir(path.join(directory,entry.name))){if(name.endsWith('.json'))records.push(JSON.parse(await fs.readFile(path.join(directory,entry.name,name),'utf8')));}}
  const stop=records.find(row=>row.runId==='apply');assert.equal(stop?.status,'SETTLED');assert.equal(stop?.openSpecPlan?.status,'PRESERVED');
  assert(!['PASS','NO_DEVIATION_FOUND'].includes(stop.reviewStatus),'Host plan integrity does not replace fresh production evidence.');
});
