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
    import {loadSupervisedCompatibility} from ${JSON.stringify(new URL("../lib/openclaw/compat-2026.7.1-2.mjs", import.meta.url).href)};
    process.argv[1] = ${JSON.stringify(executable)};
    const sdk = await loadSupervisedCompatibility();
    const diagnostics = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/plugin-sdk/diagnostic-runtime.js")).href)});
    const activity = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/diagnostic-run-activity-Jf95dtVL.js")).href)});
    sdk.reportProgress({sessionId:'parent-progress',sessionKey:'agent:main:progress',runId:'progress-run'},'native-review-progress');
    await diagnostics.waitForDiagnosticEventsDrained();
    assert.equal(activity.r({sessionId:'parent-progress'}).lastProgressReason,'native-review-progress',
      'real native progress must reach the stock stuck-session detector');
    const projector = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(executable), "dist/live-chat-projector-BfpgAbEg.js")).href)});
    assert.equal(projector.i({previousText:'正在执行任务。',nextText:'VERIFIED',nextDelta:''}),'VERIFIED',
      'final snapshots must replace progress in the stock web/TUI transport');
    assert.equal(sdk.nativeHarness({provider:'anthropic',modelId:'contract',config:{}}).id,'openclaw');
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
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000 });
  assert.match(output, /CONTRACT_PASS/u);
});
