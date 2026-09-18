import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

test("installed 2026.7.1-2 acknowledged queue, native selection and user transcript recorder contracts", async (t) => {
  let executable;
  try { executable = await fs.realpath(execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim()); }
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
