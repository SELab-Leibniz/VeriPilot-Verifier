import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/plugin-builder.mjs";

test("installed 2026.7.1-2 acknowledged queue, native selection and user transcript recorder contracts", async (t) => {
  let executable;
  try { executable = await fs.realpath(process.env.RC_OPENCLAW_HOST_ROOT
    ? path.join(process.env.RC_OPENCLAW_HOST_ROOT, "openclaw.mjs")
    : execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim()); }
  catch { t.skip("OpenClaw is not installed on this test machine."); return; }
  const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(executable), "package.json")));
  if (pkg.version !== "2026.7.1-2") { t.skip("The exact target OpenClaw version is not installed."); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oc-host-contract-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {loadSupervisedCompatibility, loadInteractionCompatibility} from ${JSON.stringify(new URL("../lib/openclaw/compat-2026.7.1-2.mjs", import.meta.url).href)};
    process.argv[1] = ${JSON.stringify(executable)};
    const sdk = await loadSupervisedCompatibility();
    const interaction = await loadInteractionCompatibility();
    assert.equal(interaction.version, '2026.7.1-2');
    assert.equal(interaction.browserClient, 'gateway-CWCQz7bR.js');
    assert.equal(typeof interaction.callGatewayFromCli, 'function');
    const {B:createWriteToolDefinition} = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/sessions-D8qGY7uC.js")).href)});
    let writeCount = 0, storedContent = 'BROKEN\\n';
    const nativeWrite = createWriteToolDefinition(${JSON.stringify(directory)}, {operations:{
      readFile:async()=>Buffer.from(storedContent),
      statFile:async()=>({type:'file',size:Buffer.byteLength(storedContent),mtimeMs:1}),
      mkdir:async()=>{},
      writeFile:async(_file,content)=>{writeCount++;storedContent=content;}
    }});
    const unchangedWrite = await nativeWrite.execute('same-write',{path:'draft.txt',content:'BROKEN\\n'});
    assert.equal(unchangedWrite.terminate,true,'the stock host terminates a no-op write before another model turn');
    assert.equal(writeCount,0,'the no-op result must not perform a file write');
    const changedWrite = await nativeWrite.execute('changed-write',{path:'draft.txt',content:'READY_A\\n'});
    assert.notEqual(changedWrite.terminate,true,'a real write leaves the stock agent loop able to continue');
    assert.equal(writeCount,1);
    const fs = await import('node:fs/promises');
    const store = ${JSON.stringify(path.join(directory, "sessions.json"))};
    await fs.writeFile(store, JSON.stringify({'agent:main:bound':{sessionId:'original',updatedAt:1}}));
    assert.equal(interaction.currentSession({session:{store}}, 'main', 'agent:main:bound').sessionId, 'original');
    await fs.writeFile(store, JSON.stringify({'agent:main:bound':{sessionId:'replaced',updatedAt:2}}));
    assert.equal(interaction.currentSession({session:{store}}, 'main', 'agent:main:bound').sessionId, 'replaced');
    const hooks = await fs.readFile(${JSON.stringify(path.join(path.dirname(executable), "dist/hook-types-DQ9eTy2x.d.ts"))}, 'utf8');
    const reply = hooks.slice(hooks.indexOf('type PluginHookReplyDispatchContext'), hooks.indexOf('type PluginHookReplyDispatchResult'));
    assert.ok(reply.includes('PluginHookReplyDispatchContext'));
    assert.ok(!reply.includes('userTurnTranscriptRecorder'));
    const diagnostics = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/plugin-sdk/diagnostic-runtime.js")).href)});
    const activity = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/diagnostic-run-activity-Jf95dtVL.js")).href)});
    sdk.reportProgress({sessionId:'parent-progress',sessionKey:'agent:main:progress',runId:'progress-run'},'native-review-progress');
    await diagnostics.waitForDiagnosticEventsDrained();
    assert.equal(activity.r({sessionId:'parent-progress'}).lastProgressReason,'native-review-progress',
      'real native progress must reach the stock stuck-session detector');
    const {relayNativeReviewActivity} = await import(${JSON.stringify(new URL("../lib/openclaw/review-activity.mjs", import.meta.url).href)});
    const relayAbort = new AbortController();
    const closeRelay = relayNativeReviewActivity({sdk,parent:{sessionId:'native-parent',sessionKey:'agent:main:native-parent',runId:'native-parent-run'},
      runId:'owned-native-review',role:'onboarding-extractor',controller:relayAbort});
    diagnostics.emitTrustedDiagnosticEvent({type:'run.progress',runId:'owned-native-review',sessionId:'private-review',reason:'model-stream'});
    await diagnostics.waitForDiagnosticEventsDrained();
    assert.equal(activity.r({sessionId:'native-parent'}).lastProgressReason,'runtime-corrector:review:run.progress',
      'native hook mode must reach the exact same stock watchdog as supervised mode');
    closeRelay();
    const projector = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/live-chat-projector-BfpgAbEg.js")).href)});
    assert.equal(projector.i({previousText:'正在执行任务。',nextText:'VERIFIED',nextDelta:''}),'VERIFIED',
      'final snapshots must replace progress in the stock web/TUI transport');
    assert.equal(sdk.nativeHarness({provider:'anthropic',modelId:'contract',config:{}}).id,'openclaw');
    const nativeParams = { provider:'test-native',modelId:'contract',runId:'one-lifecycle',
      agentDir:${JSON.stringify(directory)},workspaceDir:${JSON.stringify(directory)},
      config:{models:{providers:{'test-native':{apiKey:'contract-fixture-only',baseUrl:'https://example.invalid',models:[]}}}},
      model:{id:'contract',provider:'test-native',api:'anthropic-messages',baseUrl:'https://example.invalid'},
      runtimePlan:{observability:{harnessId:'runtime-corrector-supervised'}} };
    const prepared = await sdk.prepareNativeAttempt(nativeParams);
    assert.equal(prepared.runId, nativeParams.runId);
    assert.equal(prepared.agentHarnessId,'openclaw');
    assert.equal(prepared.runtimePlan, undefined);
    assert.ok(prepared.resolvedApiKey);
    assert.equal(await prepared.authStorage.getApiKey(prepared.model.provider), prepared.resolvedApiKey);
    assert.notEqual((await sdk.prepareNativeAttempt(nativeParams)).authStorage, prepared.authStorage,
      'provider credentials must stay in per-attempt stores');
    const {createSupervisedHarness} = await import(${JSON.stringify(new URL("../lib/openclaw/supervised.mjs", import.meta.url).href)});
    const harnessRegistry = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/registry-DtLZ3rba.js")).href)});
    const compaction = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/compaction-DiGBGVZl.js")).href)});
    const supervised = createSupervisedHarness({id:'runtime-corrector'}, {});
    const compactParams = {provider:'test-native',model:'contract',agentDir:${JSON.stringify(directory)},
      workspaceDir:${JSON.stringify(directory)},sessionId:'compact-contract',sessionKey:'agent:main:compact-contract',
      config:{models:{providers:{'test-native':{apiKey:'contract-fixture-only',baseUrl:'https://example.invalid',
        agentRuntime:{id:supervised.id},models:[]}}}}};
    const missingCompact = {...supervised}; delete missingCompact.compact;
    harnessRegistry.a(missingCompact);
    assert.equal((await compaction.t(compactParams)).failure.reason,'unsupported_harness_compaction',
      'reproduce the stock host rejecting the old supervised harness');
    harnessRegistry.a(supervised);
    assert.equal(await compaction.t(compactParams),undefined,
      'the supervised harness must hand compaction back to the stock context engine');
    for (const mode of ['off','non-main','all']) {
      const config={agents:{defaults:{sandbox:{mode}}},tools:{sandbox:{tools:{allow:['read'],deny:['exec']}}}};
      const policy=sdk.workerPolicy({config,sessionKey:'agent:main:main'},'agent:main:rc-worker:test');
      assert.equal(policy.sandboxSessionKey,'agent:main:rc-worker:test');
      assert.equal(config.agents.defaults.sandbox.mode,mode,'never mutate the host config');
      assert.deepEqual(policy.config.tools,config.tools);
    }
    await assert.rejects(sdk.queueAcknowledged('absent-session','not delivered'), /did not acknowledge/);
    const recorder = sdk.workerRecorder({role:'user', content:'A genuine requirement', timestamp:Date.now(), provenance:{kind:'external_user'}},
      {transcriptPath:${JSON.stringify(path.join(directory, "worker.jsonl"))},sessionId:'contract',cwd:${JSON.stringify(directory)}});
    assert.equal((await recorder.resolveMessage()).provenance.kind,'external_user');
    await recorder.persistApproved();
    assert.equal(recorder.hasPersisted(),true);
    console.log('CONTRACT_PASS');
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000,
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(directory, 'host-state'), OPENCLAW_CONFIG_PATH: path.join(directory, 'host-config.json') } });
  assert.match(output, /CONTRACT_PASS/u);
});

test("explicit host runtime supports plugin registration, automatic projects, logs and manual fallback", async t => {
  if (!process.env.RC_OPENCLAW_HOST_ROOT) { t.skip("Set RC_OPENCLAW_HOST_ROOT for an isolated installed-host probe."); return; }
  const host = await fs.realpath(process.env.RC_OPENCLAW_HOST_ROOT);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-matrix-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = await buildPlugin({ host: "openclaw", sourceRoot: path.resolve("."), outputRoot: path.join(root, "build") });
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const host = ${JSON.stringify(host)}, root = ${JSON.stringify(root)}, pluginRoot = ${JSON.stringify(pluginRoot)};
    process.argv[1] = path.join(host,'openclaw.mjs');
    const {createPluginRuntime} = await import(pathToFileURL(path.join(host,'dist/plugins/runtime/index.js')));
    const runtime = createPluginRuntime();
    for (const key of ['agent.runEmbeddedAgent','agent.session.getSessionEntry','agent.session.resolveStorePath',
      'agent.session.resolveSessionFilePath','agent.session.runWithWorkAdmission','subagent.run','state.resolveStateDir','config.current']) {
      assert.equal(typeof key.split('.').reduce((obj,part)=>obj?.[part],runtime),'function',key);
    }
    const a = path.join(root,'a'), b = path.join(root,'b'), off = path.join(root,'off');
    for (const dir of [a,b,off]) await fs.mkdir(dir);
    for (const dir of [a,b]) {
      await fs.mkdir(path.join(dir,'.runtime-corrector'));
      await fs.writeFile(path.join(dir,'.runtime-corrector/config.yaml'),'version: 2\\nartifacts:\\n  - name: draft\\n    stage: drafting\\n    patterns: [draft.md]\\n    rules:\\n      enabled: false\\n    review:\\n      enabled: false\\ndynamicGroundTruth:\\n  enabled: false\\nstopCorrection:\\n  enabled: false\\n');
    }
    const config = {agents:{defaults:{workspace:off,sandbox:{mode:'off'}}},session:{store:path.join(root,'sessions.json')}};
    runtime.config.current = () => config;
    const logs = [], hooks = [];
    const api = {id:'runtime-corrector',rootDir:pluginRoot,runtime,config,pluginConfig:{},logger:{info:m=>logs.push(m),warn:m=>{throw new Error(m)}},
      on:name=>hooks.push(name),registerTool(){},registerCommand(){},registerAgentToolResultMiddleware(){}};
    const entry = (await import(pathToFileURL(path.join(pluginRoot,'lib/openclaw/entry.mjs')))).default;
    entry.register(api);
    assert.deepEqual(hooks,['reply_dispatch','before_model_resolve','session_start','before_prompt_build','before_tool_call','reply_payload_sending','before_compaction','session_end','before_reset','agent_end','gateway_stop']);
    const identity = {agentId:'main',sessionKey:'agent:main:chat-rc-project-contract',sessionId:'rc-project-contract'};
    const sessionFile = path.join(root,'session.jsonl');
    await fs.writeFile(sessionFile,JSON.stringify({type:'session',id:identity.sessionId})+'\\n'+JSON.stringify({type:'message',id:'a-user',parentId:null,message:{role:'user',content:'A task'}})+'\\n');
    const params = {...identity,storePath:config.session.store};
    await runtime.agent.session.upsertSessionEntry({...params,entry:{sessionId:identity.sessionId,updatedAt:Date.now(),sessionFile,spawnedCwd:a}});
    const {createSessionProjects} = await import(pathToFileURL(path.join(pluginRoot,'lib/openclaw/session-projects.mjs')));
    const projects = createSessionProjects(api,{pluginRoot});
    const ctx = {...identity,workspaceDir:off,isAuthorizedSender:true,gatewayClientScopes:['operator.admin']};
    const first = await projects.resolve({},ctx);
    assert.equal(first.enabled,true,first.reason); assert.equal(first.source,'host'); assert.equal(first.projectRoot,a); assert.equal(first.executionDirectory,a);
    const activeA = await projects.activate(first);
    await runtime.agent.session.patchSessionEntry({...params,update:()=>({spawnedCwd:b})});
    await fs.appendFile(sessionFile,JSON.stringify({type:'message',id:'b-user',parentId:'a-user',message:{role:'user',content:'B task'}})+'\\n');
    const second = await projects.resolve({},ctx), activeB = await projects.activate(second);
    assert.equal(second.projectRoot,b); assert.notEqual(activeA.taskId,activeB.taskId);
    await runtime.agent.session.patchSessionEntry({...params,update:()=>({spawnedCwd:off})});
    assert.equal((await projects.resolve({},ctx)).reason,'RC_PROJECT_NOT_ENABLED');
    assert.deepEqual(await fs.readdir(off),[]);
    await runtime.agent.session.patchSessionEntry({...params,update:()=>({spawnedCwd:null})});
    assert.equal((await projects.resolve({},ctx)).reason,'RC_SESSION_PROJECT_UNBOUND');
    assert.equal((await projects.command({...ctx,args:'bind '+a})).source,'rc');
    assert(logs.map(line=>JSON.parse(line.slice(line.indexOf('{')))).some(event=>event.type==='RC_PROJECT_SCOPE_ACTIVATED'&&event.projectRoot===b));
    console.log('MATRIX_PROJECT_CONTRACT_PASS');
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000,
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "host-state"), OPENCLAW_CONFIG_PATH: path.join(root, "host-config.json") } });
  assert.match(output, /MATRIX_PROJECT_CONTRACT_PASS/u);
});
