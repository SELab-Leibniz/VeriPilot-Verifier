
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { arktsAgentInput, digest, loadArktsTask } from './bench/arkts-dataset.mjs';
import { prepareArktsModelWorkspace } from './bench/prepare-arkts-model-workspace.mjs';
import { createArktsBenchTools } from './bench/native-arkts-tools.mjs';
import { runBoundedProcess } from './bench/bounded-process.mjs';
import { verifyFrozenArtifact } from './bench/frozen-artifact-verification.mjs';
import { assertBusinessSessionIdentity } from './bench/session-continuity.mjs';
import { businessMutationPaths } from './bench/business-mutations.mjs';
import { businessCompleted, createBusinessRunTracker, createBusinessTerminalObserver } from './bench/business-completion.mjs';
import { installOriginalBasisPolicy, loadOriginalBasisWorkflow, prepareOpenSpecSession, runOpenSpecCli, workflowMessages } from './bench/original-basis-workflow.mjs';
import { collectAutomaticDocumentEvidence } from './evaluate-openclaw-document-e2e.mjs';
import { prepareJava } from './bench/arkts-java.mjs';
import { loadRcConfigOverrides } from './bench/rc-config-overrides.mjs';
import { localTestEvidence } from './bench/local-test-evidence.mjs';
import { codeChanged, collectReleaseEvidence, finalStopOf, tokenSplit } from './bench/release-evidence.mjs';
import { waitNativeStopSettled } from './bench/native-stop-settlement.mjs';
import { createSimplifyGateway, loadPackaged, readProviderTiming, redactEvaluationText, summarizeProviderUsage } from './helpers/simplify-native-evaluation.mjs';
import { measureSimplifyBenchmark } from './helpers/simplify-stop-benchmark.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const jsonl = text => text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const model = 'deepseek-v4-flash';
const cases = ['security_tool_1', 'security_tool_2'];
const configFile = path.join(sourceRoot, 'docs/original-basis-release-inputs.json');
const timeoutMs = 120 * 60_000;
const { values: args } = parseArgs({ options: Object.fromEntries([
  ...['case','output','host-root','package','package-sha256','source-commit','workflow-root','openclaw-profile','dataset','tool-root',
    'cache','workspace-root','json5-package','pair-rate-limit-file','pair-rate-limit-pause-ms','provider','model','deadline-at','java-home','rc-config-overrides']
    .map(name => [name, { type: 'string' }]),
  ['offline', { type: 'boolean' }], ['live', { type: 'boolean' }], ['baseline-local-tests', { type: 'boolean' }],
]) });
const offline = args.offline === true;
if (offline === (args.live === true) || args.provider !== 'host-profile' || args.model !== model
  || !['output','host-root','package','package-sha256','workflow-root','openclaw-profile'].every(key => args[key])
  || !offline && (!cases.includes(args.case) || !['dataset','tool-root','cache','workspace-root','json5-package'].every(key => args[key])))
  throw new Error('Supply the pinned release package, local workflow and host profile, and choose offline preflight or a live ArkTS case.');

const inputs = await read(configFile);
const outputRoot = path.resolve(args.output);
const archive = path.resolve(args.package);
const deadline = Math.min(Date.now() + timeoutMs, args['deadline-at'] ? Number(args['deadline-at']) : Infinity);
assert(Number.isFinite(deadline) && deadline > Date.now());
// A new package names its exact commit; the archive digest, the plugin version
// at that commit and every runtime module are still verified below.
const packageSha256 = args['package-sha256'], sourceCommit = args['source-commit'] ?? inputs.sourceCommit;
if (!args['source-commit']) assert.equal(packageSha256, inputs.packageSha256);
assert.match(sourceCommit, /^[0-9a-f]{40}$/u);
assert.equal(digest(await fs.readFile(archive)), packageSha256);
const expectedVersion = args['source-commit'] ? JSON.parse(execFileSync('git', ['show', `${sourceCommit}:packaging/hosts/openclaw/openclaw.plugin.json`],
  { cwd: sourceRoot, windowsHide: true, encoding: 'utf8' })).version : inputs.version;
const rcOverrides = await loadRcConfigOverrides(args['rc-config-overrides']);
const hostRoot = path.resolve(args['host-root']);
const workflow = await loadOriginalBasisWorkflow(path.resolve(args['workflow-root']), hostRoot, inputs.workflow);
const git = (cwd, ...params) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...params],
  { windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
const commit = (cwd, message) => git(cwd, '-c', 'user.name=RC Benchmark', '-c', 'user.email=rc@example.invalid',
  '-c', 'core.hooksPath=nonexistent', 'commit', '--quiet', '--allow-empty', '-m', message);
let projectRoot, preparedHead, instance, publicInput;
const startedAt = Date.now();
if (offline) {
  await fs.mkdir(outputRoot);
  projectRoot = path.join(outputRoot, 'project');
  await fs.mkdir(projectRoot);
  publicInput = { problem_statement: 'Offline preflight. Keep the proposed importer entirely local.' };
} else {
  const { task, datasetDigest } = await loadArktsTask(args.dataset, args.case);
  instance = { id: task.instance_id, baseCommit: task.base_commit, datasetDigest };
  publicInput = arktsAgentInput(task);
  ({ projectRoot } = await prepareArktsModelWorkspace({ task, outputRoot, cacheRoot: args.cache,
    workspaceRoot: args['workspace-root'], json5Package: args['json5-package'] }));
}
const changeName = offline ? 'release-preflight' : 'arkts-permission-update';
const spec = await prepareOpenSpecSession(workflow, projectRoot, outputRoot, changeName);
const artifact = path.join(outputRoot, 'package');
execFileSync('tar', ['-xf', archive, '-C', outputRoot], { windowsHide: true, stdio: 'pipe' });
const artifactManifest = await read(path.join(artifact, 'openclaw.plugin.json'));
assert.equal(artifactManifest.version, expectedVersion);
await write(path.join(outputRoot, 'package-validation.json'), await verifyFrozenArtifact({ cwd: sourceRoot,
  reference: sourceCommit, artifact }));
// The isolated Gateway runs in this process, so business tools inherit the
// resolved JDK; `java -version` must work before any model request.
const java = offline ? null : prepareJava({ explicit: args['java-home'], projectRoot, toolRoot: args['tool-root'] });
if (java) await write(path.join(outputRoot, 'java.json'), java);
const policies = await installOriginalBasisPolicy({ artifact, projectRoot, outputRoot, overrides: rcOverrides,
  variables: { projectRoot, outputRoot, harnessRoot: path.resolve(sourceRoot), node: process.execPath,
    ...(args['tool-root'] ? { toolRoot: path.resolve(args['tool-root']) } : {}), ...(java ? { javaHome: java.javaHome } : {}) } });
const messages = workflowMessages(workflow, projectRoot, changeName,
  [publicInput.problem_statement, publicInput.hints_text].filter(value => value?.trim()).join('\n\n'));
await write(path.join(outputRoot, 'public-input.json'), publicInput);
await write(path.join(outputRoot, 'workflow-messages.json'), { flow: 'OpenSpec(solo)', version: spec.version, changeName,
  dispatch: 'MatrixAssistant sequential-stage text and workspace prefix, selected by the isolated controller', ...messages });
const extraPluginPaths = [workflow.plugin, spec.plugin];
const businessToolNames = ['read', 'write', 'edit', 'apply_patch', 'openspec_cli', 'sdd_next_step'];
if (!offline) {
  const installed = await runBoundedProcess('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',
    fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url)), '-Project', projectRoot,
    '-ToolRoot', args['tool-root'], '-Phase','install'], { timeoutMs: 600_000, maxTail: 40_000 });
  await fs.writeFile(path.join(outputRoot, 'install.log'), redactEvaluationText(installed.tail));
  if (installed.exitCode !== 0 || installed.interrupted) throw new Error('Business dependency preparation failed.');
  const setup = git(projectRoot,'status','--porcelain','--untracked-files=all','-z').toString('utf8').split('\0').filter(Boolean);
  const paths = setup.map(entry => entry.slice(3)).filter(file => !file.startsWith('.runtime-corrector/'));
  assert(paths.every(file=>/^(?:\.opencode\/|openspec\/|(?:entry\/)?oh-package-lock\.json5$)/u.test(file)), JSON.stringify(paths));
  if (paths.length) git(projectRoot,'add','--',...paths);
  commit(projectRoot,'Prepare shared ArkTS and OpenSpec environment');
  preparedHead = git(projectRoot,'rev-parse','HEAD').toString().trim();
  let baselineLocalTests = null;
  if (args['baseline-local-tests']) {
    // The workspace's own original tests, before any model request; never the hidden oracle.
    const coverage = path.join(projectRoot, 'entry/.test/default/intermediates/test/coverage_data/coverage.log');
    await fs.rm(coverage, { force: true });
    let output = ''; const checkedAt = Date.now();
    const execution = await runBoundedProcess('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',
      fileURLToPath(new URL('./bench/run-arkts-toolchain.ps1', import.meta.url)), '-Project', projectRoot, '-ToolRoot', args['tool-root'],
      '-Phase', 'test', '-JavaHome', java.javaHome], { cwd: projectRoot, timeoutMs: 900_000, onOutput(value) { output += value; } });
    await fs.writeFile(path.join(outputRoot, 'baseline-local-test.log'), redactEvaluationText(output));
    const stat = await fs.stat(coverage).catch(() => null), freshReport = Boolean(stat && stat.mtimeMs >= checkedAt - 2000);
    baselineLocalTests = localTestEvidence(freshReport ? await fs.readFile(coverage, 'utf8') : '', execution, { freshReport, compileOutput: output });
    if (!baselineLocalTests.completeRuntime) throw new Error('Original local-test baseline did not finish; inspect baseline-local-test.log before starting a model.');
    await write(path.join(outputRoot, 'baseline-local-tests.json'), baselineLocalTests);
  }
  extraPluginPaths.push(await createArktsBenchTools({ outputRoot, projectRoot, toolRoot: args['tool-root'],
    stableNavigationRoot: artifact, checkTimeoutMs: policies.runtimeV2.stopCorrection.assessmentTimeoutMs, baselineLocalTests, javaHome: java.javaHome }));
  businessToolNames.push('bench_nav','bench_check');
}
await write(path.join(outputRoot, 'manifest.json'), { instance, projectRoot, preparedHead, changeName,
  packageSha256, sourceCommit, version: artifactManifest.version, modelRef: 'custom/'+model,
  java: java ? { javaHome: java.javaHome, source: java.source, version: java.version } : null,
  rcConfigOverrides: policies.experimentOverrides, regressionCheck: policies.regressionCheck,
  startedAt, deadline, offline });
let gateway, sessionId, sessionKey, transcriptFile;
async function findFiles(root, match) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const nested = await Promise.all(entries.map(async entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? findFiles(file, match) : entry.isFile() && match(file) ? [file] : [];
  }));
  return nested.flat();
}
try {
  gateway = await createSimplifyGateway({ hostRoot, projectRoot, outputRoot, sourceRoot, prebuiltPluginRoot: artifact,
    extraPluginPaths, businessToolNames, unlimitedBusiness: true, nativeCustomProvider: true, disableMemoryFlush: true,
    preserveSessionHistory: true, model, providerKind: 'host-profile', openclawProfile: args['openclaw-profile'],
    ...(offline ? { maxRequests: 0 } : {}), pairRateLimitFile: args['pair-rate-limit-file'],
    pairRateLimitPauseMs: args['pair-rate-limit-pause-ms'] ? Number(args['pair-rate-limit-pause-ms']) : null });
  assert.equal(gateway.modelRef, 'custom/'+model);
  const created = await gateway.request('sessions.create', { key: 'agent:main:arkts-'+randomUUID(), agentId: 'main', label: 'OpenSpec(solo)' });
  assert(created.ok && created.key);
  sessionKey = created.key;
  const scope = { agentId: 'main', sessionKey, storePath: gateway.config.session.store };
  await gateway.runtime.agent.session.patchSessionEntry({ ...scope, update: entry => ({ ...entry, spawnedCwd: projectRoot }) });
  const entry = await gateway.runtime.agent.session.getSessionEntry({ ...scope, readConsistency: 'latest' });
  sessionId = entry.sessionId;
  transcriptFile = path.join(gateway.root, sessionId+'.jsonl');
  if (offline) {
    await runOpenSpecCli(spec.options, ['new','change',changeName]);
    const runId = randomUUID(), toolCallId = randomUUID();
    await gateway.runtime.agent.session.upsertSessionEntry({ ...scope,
      entry: { ...entry, sessionFile: transcriptFile, spawnedCwd: projectRoot, updatedAt: Date.now() } });
    const seed = jsonl(await fs.readFile(transcriptFile, 'utf8'));
    assert(seed.length === 1 && seed[0].type === 'session' && seed[0].id === sessionId);
    await fs.writeFile(transcriptFile, JSON.stringify({ ...seed[0], cwd: projectRoot })+'\n');
    let parentId = null;
    const append = async message => {
      const id = randomUUID().slice(0,8);
      await fs.appendFile(transcriptFile, JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message})+'\n');
      parentId = id;
    };
    const ctx = { agentId:'main',sessionKey,sessionId,runId,workspaceDir:projectRoot,trigger:'user',
      modelProviderId:'custom',provider:'custom',modelId:model,abortSignal:new AbortController().signal };
    const user = { role:'user',content:messages.proposal };
    await gateway.hooks.runSessionStart({ sessionId,source:'startup' },ctx);
    await gateway.hooks.runBeforeAgentRun({ sessionId,sessionKey,prompt:messages.proposal },ctx);
    await gateway.hooks.runBeforePromptBuild({ prompt:messages.proposal,messages:[user] },ctx);
    await append(user);
    const params = { path:'openspec/changes/'+changeName+'/proposal.md',content:'# Local import proposal\n\nKeep all imports local.\n' };
    await append({ role:'assistant',content:[{type:'toolCall',id:toolCallId,name:'write',arguments:params}] });
    const gate = await gateway.hooks.runBeforeToolCall({ toolName:'write',toolCallId,params },ctx);
    assert(!gate?.block);
    await fs.writeFile(path.join(projectRoot,params.path),params.content);
    const result = { content:[{type:'text',text:'written'}],details:{status:'completed'} };
    await append({role:'toolResult',toolName:'write',toolCallId,isError:false,content:result.content});
    const middleware = gateway.registry.agentToolResultMiddlewares.find(item=>item.pluginId==='runtime-corrector');
    assert(middleware);
    const bound = [];
    let settled = false;
    const deliver = middleware.handler({toolName:'write',toolCallId,args:params,result},ctx).finally(()=>{settled=true;});
    while (!settled && !bound.length) {
      const files = await findFiles(path.join(projectRoot,'.runtime-correction','.semantic-review'),
        file => path.basename(file)==='request.json');
      for (const file of files) try {
        const request = await read(file);
        assert(!/(test_patch|evaluator-gold|f2p_passed|rollback)/u.test(JSON.stringify(request)));
        for (const reference of request.originalRequirements?.userMessages ?? []) {
          const text = await fs.readFile(reference.path,'utf8');
          if (text !== messages.proposal) continue;
          await write(path.join(outputRoot,'proposal-review-request.json'),request);
          bound.push({file,userMessageSha256:digest(text),artifact:params.path});
          break;
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!settled && !bound.length) await sleep(40);
    }
    await deliver;
    assert(bound.length, 'No proposal review request binds the original user message.');
    assert.equal(gateway.providerStatus().requests,0);
    assert.equal(gateway.providerStatus().failure,'PROFILE_REQUEST_LIMIT');
    const { OPENCLAW_TOOL_NAMES } = await loadPackaged(artifact,'lib/openclaw/tool-contracts.mjs');
    assert.deepEqual(artifactManifest.contracts.tools,OPENCLAW_TOOL_NAMES);
    assert(artifactManifest.contracts.tools.includes('set_original_checklist'));
    await write(path.join(outputRoot,'result.json'),{ state:'PREPARED_NO_MODEL',projectRoot,sessionId,
      pluginVersion:artifactManifest.version,workflow:workflow.flow.displayName,openSpecVersion:spec.version,
      proposalRequests:bound,requests:0,wireBlocked:true,registeredTools:artifactManifest.contracts.tools });
  } else {
    const [{findTask},{listNativeRuns},{createStopCorrectionStore}] = await Promise.all([
      loadPackaged(artifact,'lib/runtime-v2/task-store.mjs'),loadPackaged(artifact,'lib/openclaw/native-runs.mjs'),
      loadPackaged(artifact,'lib/runtime-v2/stop-correction-store.mjs'),
    ]);
    const state = gateway.runtime.state.resolveStateDir();
    const postRoot = path.join(state,'runtime-corrector-stop-sessions/post-run');
    const store = createStopCorrectionStore({directory:path.join(state,'runtime-corrector-stop-sessions')});
    const turns = [];
    const stages = ['proposal','codeing'];
    const docNames = ['proposal.md','design.md','tasks.md'];
    const change = path.join(projectRoot,'openspec','changes',changeName);
    for (const stage of stages) {
      if (Date.now() >= deadline || gateway.providerStatus().failure) break;
      const runId = randomUUID(), turnStartedAt = Date.now(), tracker = createBusinessRunTracker(runId, sessionId);
      const observer = createBusinessTerminalObserver();
      gateway.setPhase('business-'+stage);
      await gateway.request('chat.send',{sessionKey,sessionId,message:messages[stage],idempotencyKey:runId,
        deliver:false,thinking:'off',timeoutMs:0});
      let terminal, originalTerminal, post, task, privateRuns = [];
      const original = createBusinessTerminalObserver();
      while (Date.now() < deadline && !gateway.providerStatus().failure) {
        await gateway.drain();
        const entry = () => gateway.runtime.agent.session.getSessionEntry({ ...scope,readConsistency:'latest' });
        let latest = await entry();
        // The host rewrites its session store at run end; one missing read is not yet a replacement.
        if (!latest) { await sleep(650); latest = await entry(); }
        try { assertBusinessSessionIdentity({sessionId,sessionKey,runId},latest,gateway.metrics().modelStarts); }
        catch (error) {
          if (error.code==='ARKTS_SESSION_IDENTITY_DRIFT') await write(path.join(outputRoot,'session-identity-drift.json'),{stage,...error.evidence});
          throw error;
        }
        const posts = await findFiles(postRoot,file=>file.endsWith('.json'));
        post = undefined;
        for (const file of posts) {
          const value = await read(file);
          if (value.sessionId===sessionId && (value.runId===runId || value.completedRuns?.includes(runId))) post=value;
        }
        tracker.observe(post);
        task = await findTask({projectRoot,sessionId});
        privateRuns = task ? await listNativeRuns(projectRoot,task.taskId) : [];
        const starts=()=>gateway.metrics().modelStarts;
        originalTerminal = await original.poll(gateway.request,runId,starts,post?.phase ?? 'OBSERVE');
        terminal = tracker.runId===runId ? originalTerminal
          : await observer.poll(gateway.request,tracker.runId,starts,post?.phase);
        if (terminal && ['IDLE','CLOSED'].includes(post?.phase) && privateRuns.every(worker=>worker.status==='SETTLED')) break;
        await sleep(650);
      }
      turns.push({stage,runId,startedAt:turnStartedAt,finishedAt:Date.now(),finalRunId:tracker.runId,
        originalTerminal,terminal,post:post ?? null});
      if (!businessCompleted(terminal,tracker.runId) || gateway.providerStatus().failure) break;
      if (stage==='proposal' && !(await Promise.all(docNames.map(file=>fs.stat(path.join(change,file)).then(stat=>stat.isFile(),()=>false)))).every(Boolean)) break;
    }
    // Closing the Gateway cancels unsettled native Stop jobs, and the freeze
    // commit below would move HEAD under a review that is still reading it.
    const nativeStop = await waitNativeStopSettled({projectRoot,sessionKey,sessionId,deadlineAt:deadline,beforePoll:()=>gateway.drain(),
      abandon:()=>Boolean(gateway.providerStatus().failure),readVerification:async()=>(await findTask({projectRoot,sessionId}))?.verification??null});
    const ledger = await store.inspect(sessionId);
    const task = await findTask({projectRoot,sessionId});
    const session = await gateway.runtime.subagent.getSession({sessionKey});
    const bytes = await fs.readFile(transcriptFile);
    const records = jsonl(bytes.toString('utf8'));
    const frozenRoot = path.join(outputRoot,'freeze');
    await fs.mkdir(frozenRoot);
    const paths = new Set(businessMutationPaths(records,projectRoot));
    for (const file of await findFiles(change,()=>true)) paths.add(path.relative(projectRoot,file).replaceAll('\\','/'));
    if (paths.size) git(projectRoot,'--literal-pathspecs','add','--all','--',...paths);
    commit(projectRoot,'Freeze release end-to-end result');
    const head=git(projectRoot,'rev-parse','HEAD').toString().trim();
    const patch=git(projectRoot,'diff','--binary',preparedHead,head);
    await fs.writeFile(path.join(frozenRoot,'session.jsonl'),bytes,{flag:'wx'});
    await fs.writeFile(path.join(frozenRoot,'candidate.patch'),patch,{flag:'wx'});
    const frozen = {commit:head,commitSha256:digest(git(projectRoot,'cat-file','commit',head)),
      sessionSha256:digest(bytes),patchSha256:digest(patch),preparedHead,mutationPaths:[...paths].sort()};
    await write(path.join(frozenRoot,'freeze.json'),frozen);
    const evidence = await collectReleaseEvidence({projectRoot,sessionId,nativeRoot:gateway.root,turns});
    const documents = await collectAutomaticDocumentEvidence(projectRoot,session,sessionId);
    const scopeIds = [...new Set([task?.taskId,...evidence.taskIds,...documents.reviews.map(review=>review.scopeTaskId)].filter(Boolean))];
    const privateRuns = [...new Map((await Promise.all(scopeIds.map(id=>listNativeRuns(projectRoot,id)))).flat().map(run=>[run.runId,run])).values()];
    const docRuns = privateRuns.filter(run=>run.role==='artifact-reviewer');
    const stopRuns = privateRuns.filter(run=>run.role==='stop-reviewer');
    const [documentCost,stopCost] = await Promise.all([
      measureSimplifyBenchmark({nativeRoot:gateway.root,privateRuns:docRuns}),
      measureSimplifyBenchmark({nativeRoot:gateway.root,privateRuns:stopRuns,ledger}),
    ]);
    const boundary = gateway.providerStatus();
    const businessUsage = summarizeProviderUsage(Math.max(0,boundary.requests-documentCost.usage.observedCalls-stopCost.usage.observedCalls),
      records.filter(row=>row.message?.role==='assistant').map(row=>row.message.usage));
    const final = turns.at(-1), finalStops = Object.values(ledger?.stops ?? {}).filter(stop=>stop.id.startsWith(final?.runId ?? 'missing:'));
    const firstStop = finalStops[0], admission = ledger?.admissions?.[firstStop?.admissionId];
    const finalStop = finalStopOf(evidence.stopReviews,turns);
    const stopSettled = Boolean(finalStop && ['PASS','NO_DEVIATION_FOUND','DEVIATION'].includes(finalStop.status)
      || finalStop?.status==='SKIPPED' && finalStop.reasonCode==='STOP_DOCUMENT_ONLY_CHANGES');
    const docs = Object.fromEntries(await Promise.all(docNames.map(async file=>[file,
      await fs.readFile(path.join(change,file)).then(data=>({sha256:digest(data),bytes:data.length}),error=>{if(error.code==='ENOENT')return null;throw error;})])));
    const documentFeedback=documents.reviews.map((item,index)=>{
      const meta=item.result.metadata;
      const relative=meta.triggerFile;
      const receipt=documents.receipts.find(row=>row.toolCallId===item.toolCallId);
      const native=docRuns.find(run=>run.sessionId===meta.semanticReview?.forkSessionId);
      const firstHash=meta.inputs?.find(input=>input.path===relative)?.sha256;
      const next=documents.reviews.slice(index+1).find(row=>row.result.metadata.triggerFile===relative
        && row.result.metadata.inputs?.some(input=>input.path===relative&&input.sha256!==firstHash));
      const changedAfterFeedback=receipt && firstHash ? Boolean(next || docs[path.basename(relative)]?.sha256!==firstHash) : null;
      return {result:item.result,relative,file:item.file,toolCallId:item.toolCallId,
        semanticMs:native?.startedAt&&native?.settledAt ? native.settledAt-native.startedAt : null,
        feedback:receipt ? redactEvaluationText(receipt.text) : null,changedAfterFeedback,
        laterRound:next?.result.metadata.roundId??null,laterStatus:next?.result.status??null};
    });
    const businessNatural = turns.length===2 && turns.every(turn=>businessCompleted(turn.terminal,turn.finalRunId));
    const frameworkError = Boolean(boundary.failure && boundary.failure!=='PROFILE_RATE_LIMIT' && boundary.failure!=='PROFILE_PAIR_RATE_LIMIT');
    const timings = await readProviderTiming(gateway.root);
    await write(path.join(outputRoot,'result.json'),{
      state:boundary.failure?.includes('RATE_LIMIT')?'rate-limited':frameworkError?'framework-error':Date.now()>=deadline?'timed-out':'finished',
      reason:boundary.failure ?? final?.post?.reason ?? null,frameworkError,instance,projectRoot,sessionId,sessionKey,
      elapsedMs:Date.now()-startedAt,businessNatural,turns,documents:docs,documentReviews:evidence.documentReviews,documentFeedback,
      stopReviews:evidence.stopReviews,materialBasis:evidence.materialBasis,evidenceCounts:evidence.counts,finalStop,
      codeChanged:codeChanged(frozen.mutationPaths),documentCost,
      firstStop:firstStop??null,admission:admission??null,stopSettled,stopCost,corrections:ledger?.used??0,...nativeStop,
      stopFeedback:admission?.hostRequest?.gate ? redactEvaluationText((admission.currentDeviations??[]).map(item=>
        [item.result?.reason,...(item.result?.evidence??[])].join('\n')).join('\n\n')) : null,
      frozen,privateRuns,modelRequests:boundary.requests,businessUsage,
      tokenSplit:tokenSplit({documentCost,stopCost,businessUsage}),
      requestTimingCount:timings.filter(row=>row.event==='request').length,gateway:gateway.metrics(),
    });
  }
} catch (error) {
  throw new Error(redactEvaluationText(error.message));
} finally {
  await gateway?.close();
}

// The isolated host may retain singleton timers after its close and provider teardown.
process.exit(0);
