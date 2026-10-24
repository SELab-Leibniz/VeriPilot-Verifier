// A small local git experiment only: no host, provider or model call.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertIsolatedWorktree } from "./worktree-fence.mjs";
const execute=promisify(execFile),repository=await fs.realpath(process.cwd()),base=path.dirname(fileURLToPath(import.meta.url));
const run=path.join(repository,"experiments",`live-worktree-fence-preflight-${Date.now()}`),defaultDir=path.join(run,"default"),stateDir=path.join(run,"state");
const projectRoot=path.join(stateDir,"worktrees","owned","case");
await fs.mkdir(defaultDir,{recursive:true});await fs.mkdir(path.dirname(projectRoot),{recursive:true});
await fs.writeFile(path.join(defaultDir,"frozen.txt"),"owned isolated input\n");
const git=(cwd,args)=>execute("git",["-C",cwd,...args],{encoding:"utf8",timeout:20000});
await git(defaultDir,["init","--quiet"]);await git(defaultDir,["add","frozen.txt"]);
await git(defaultDir,["-c","user.name=RC Fence Check","-c","user.email=fence@example.invalid","commit","--quiet","-m","Independent frozen source"]);
await git(defaultDir,["worktree","add","--detach",projectRoot,"HEAD"]);
const input={projectRoot,defaultDir,runRoot:run,stateDir,repositoryRoot:repository,forbiddenRoots:["C:/Users/user/workspace/program_workspace/RC-Exp/ma-vk-rc-r0"]};
const positive=await assertIsolatedWorktree(input);
const rejected=[];
for(const [name,changed]of [["source-repository",{projectRoot:repository}],["default-source",{projectRoot:defaultDir}],["wrong-state-owner",{stateDir:defaultDir}],["original-project-root",{forbiddenRoots:[projectRoot]}]]){
  await assert.rejects(()=>assertIsolatedWorktree({...input,...changed}));rejected.push(name);
}
const wrongDefault=path.join(run,"other-default");await fs.mkdir(wrongDefault);await git(wrongDefault,["init","--quiet"]);
await fs.writeFile(path.join(wrongDefault,"frozen.txt"),"other independent repository\n");await git(wrongDefault,["add","frozen.txt"]);
await git(wrongDefault,["-c","user.name=RC Fence Check","-c","user.email=fence@example.invalid","commit","--quiet","-m","Other independent source"]);
await assert.rejects(()=>assertIsolatedWorktree({...input,defaultDir:wrongDefault}),/not owned by this run/u);rejected.push("wrong-git-common-owner");
const result={status:"PASS",at:new Date().toISOString(),modelCalls:0,gatewayUsed:false,productionFilesModified:false,originalProjectOrSessionReadOrWritten:false,
  positive,rejected,isolatedArtifact:run,source:"Native host service resolves worktrees under resolveStateDir(env)/worktrees; isolatedHost supplies this run's OPENCLAW_STATE_DIR."};
await fs.writeFile(path.join(run,"report.json"),JSON.stringify(result,null,2)+"\n");
await fs.writeFile(path.join(base,"worktree-fence-preflight.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({status:result.status,rejected,output:run}));
