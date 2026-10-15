// Correct-project isolation/restart is independent of fault-injection compliance.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isolatedHost, runtimeState, pause } from "./lib/isolated-openclaw.mjs";
const [hostRoot, providerFile, destination, port] = process.argv.slice(2);
if (!hostRoot || !providerFile || !destination || !port) throw new Error("hostRoot providerFile new-output-directory port required");
const h = await isolatedHost({ hostRoot, providerFile, destination, port: Number(port), platformAdapters: {
  "mini-python-stop-test": { name: "mini-python-stop-test", kitCheck: { modulePrefix: "", sourceRoots: [], sourceExtensions: [] },
    sourceManifest: { roots: [], files: ["mini_app.py"], extensions: [".py"] } },
} });
const native = h.version === "2026.10.3", hash = bytes => createHash("sha256").update(bytes).digest("hex");
const result = { experiment: "correct-peer-session-isolation-and-restart", hostVersion: h.version,
  baseline: process.env.RC_EXPERIMENT_BASELINE ?? "working-tree", status: "RUNNING", cases: [] };
const milestone = value => process.stdout.write(JSON.stringify({ at: Date.now(), hostVersion: h.version, ...value }) + "\n");
const policy = `version: 2
artifacts:
  - name: app
    stage: proposal
    patterns: [mini_app.py]
    rules:
      enabled: false
    review:
      enabled: false
dynamicGroundTruth:
  enabled: true
  materialRoots: [spec/requirements.md]
  panel:
    size: 1
    adjudicator: false
artifactCorrection:
  groundTruthReviewEnabled: false
stopCorrection:
  enabled: true
  assessmentTimeoutMs: 720000
  maxCorrectionsPerEpoch: 2
implementationCorrection:
  enabled: true
  platform: mini-python-stop-test
reviewers:
  defaults:
    model: ${h.model}
    effort: low
    timeoutMs: 240000
`;
async function prepare(name, stamp) {
  const directory = path.join(h.root, name); await fs.mkdir(path.join(directory, ".runtime-corrector"), { recursive: true });
  await fs.mkdir(path.join(directory, "spec"));
  await fs.writeFile(path.join(directory, ".runtime-corrector/config.yaml"), policy);
  await fs.writeFile(path.join(directory, "mini_app.py"), `import argparse\np=argparse.ArgumentParser(description="Readiness CLI")\np.parse_args()\nprint("${stamp}")\n`);
  const spec = `R01 Default python3.13 mini_app.py exits 0, stdout is exactly ${stamp} plus newline, stderr empty.\nR02 --help exits 0 and shows usage; Python standard library only.\nR03 This app is already correct. Read and verify only; preserve all project files and do not create project-external files.\n`;
  await fs.writeFile(path.join(directory, "spec/requirements.md"), spec);
  const key = `agent:main:rc-peer-${name.toLowerCase()}`;
  const created = await h.request("sessions.create", { key, model: h.model, emitCommandHooks: false, ...(native ? { cwd: directory } : {}) });
  if (!native) await h.send(key, `/rc-project bind ${directory}`, 30000);
  const scope = await h.status(key); assert.equal(scope.projectRoot, directory);
  const hashes = Object.fromEntries(await Promise.all(["mini_app.py", "spec/requirements.md", ".runtime-corrector/config.yaml"].map(async file => [file, hash(await fs.readFile(path.join(directory,file)))])));
  const code = `import json, subprocess; a=subprocess.run(["python3.13","mini_app.py"],capture_output=True,text=True); b=subprocess.run(["python3.13","mini_app.py","--help"],capture_output=True,text=True); print(json.dumps({"default_exit":a.returncode,"stdout":a.stdout,"stderr":a.stderr,"help_exit":b.returncode,"help_usage":"usage" in b.stdout.lower()})); assert a.returncode==0 and a.stdout==${JSON.stringify(stamp+"\n")} and a.stderr=="" and b.returncode==0 and "usage" in b.stdout.lower(); print("PEER_ACCEPTED")`;
  const prompt = `验证独立项目${directory}。该代码已经正确，无需开发或修复。正式要求：\n${spec}\nread读取spec/requirements.md与mini_app.py，然后仅调用一次exec，显式workdir=${directory}，原样执行下面的只读Python断言。它已分别执行默认入口和--help并检查退出码、stdout、stderr；PEER_ACCEPTED代表所有断言通过。不要再增加exec，不要使用shell复合命令、重定向或临时文件，不写任何业务文件；最后交付验收报告。\npython3.13 -c '${code}'`;
  await h.save(`${name}-request.md`, prompt);
  return { name, stamp, key, directory, sessionId: created.sessionId, scope, hashes, prompt };
}
async function verified(project) {
  const deadline = Date.now()+1800000;
  while(Date.now()<deadline) {
    const state=await runtimeState(project.directory), active=state.records.some(r=>["PENDING","RUNNING","DISPATCH_COMMITTED"].includes(r.status));
    const task=state.tasks.find(t=>t.status==="COMPLETED" && t.verification?.status==="PASS");
    if(task && !active) return {state,task};
    if(!active && state.records.some(r=>r.file.includes("/native-stop-reviews/") && ["UNVERIFIED","CANCELLED"].includes(r.reviewStatus))) throw new Error(`Peer ${project.name} Stop unavailable`);
    await pause(1000);
  }
  throw new Error(`Peer ${project.name} observer deadline`);
}
try {
  const projects=[await prepare("A","READY"),await prepare("B","PEER_READY")];
  await h.save("manifest.json",{...result,model:h.model,projects});
  milestone({phase:"correct peer validation"});
  const trials=await Promise.all(projects.map(async project=>{
    const terminal=await h.send(project.key,project.prompt); await h.save(`${project.name}-terminal.json`,terminal);
    const value=await verified(project); await h.save(`${project.name}-runtime-final.json`,value.state); return value;
  }));
  assert.notEqual(trials[0].task.taskId,trials[1].task.taskId);
  for(let i=0;i<2;i++) {
    const p=projects[i],v=trials[i]; assert.equal(v.task.stop.correctionAttempts,0); assert.deepEqual(v.task.sessionIds,[p.sessionId]);
    assert(!v.state.records.some(r=>r.file.includes("/native-followups/")));
    for(const[file,digest]of Object.entries(p.hashes)) assert.equal(hash(await fs.readFile(path.join(p.directory,file))),digest);
  }
  const ar=trials[0].state.records.filter(r=>r.role),br=trials[1].state.records.filter(r=>r.role);
  const overlaps=ar.flatMap(a=>br.filter(b=>a.startedAt<b.settledAt && b.startedAt<a.settledAt).map(b=>({aRunId:a.runId,bRunId:b.runId})));
  assert(overlaps.length,"The actual independent reviewer intervals did not overlap");
  result.cases.push({id:"E2-L-correct-peers",status:"PASS",tasks:trials.map(v=>({taskId:v.task.taskId,groundTruthVersion:v.task.groundTruth.version,k:v.task.stop.correctionAttempts})),overlaps});
  const scopes=await Promise.all(projects.map(p=>h.status(p.key))),count=h.events.filter(e=>e.event==="agent"&&e.payload?.stream==="lifecycle"&&e.payload.data?.phase==="start").length;
  await h.restart();
  for(let i=0;i<2;i++) {
    const scope=await h.status(projects[i].key),state=await runtimeState(projects[i].directory);
    assert.deepEqual(scope.identity,scopes[i].identity);assert.equal(scope.projectRoot,scopes[i].projectRoot);
    for(const field of["taskId","groundTruth","stop","correctionEpoch"])assert.deepEqual(state.tasks[0][field],trials[i].task[field]);
  }
  assert.equal(h.events.filter(e=>e.event==="agent"&&e.payload?.stream==="lifecycle"&&e.payload.data?.phase==="start").length,count);
  assert(!(await fs.readdir(h.defaultDir)).includes(".runtime-correction"));
  result.cases.push({id:"E4-L-correct-peers",status:"PASS",queryStartedNoModel:true});result.status="PASS";
}catch(error){result.status="FAIL";result.error=h.redact(error.stack);milestone({phase:"failed",error:h.redact(error.message)});}
finally{await h.save("summary.json",result);await h.close();}
milestone({phase:"finished",status:result.status,output:h.root});process.exitCode=result.status==="PASS"?0:1;
