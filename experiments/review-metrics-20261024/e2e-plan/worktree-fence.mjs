// Read-only ownership proof before any business task enters a fresh Gateway session.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const same=(a,b)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const real=async file=>fs.realpath(path.resolve(file));
async function git(directory,args){return (await execute("git",["-C",directory,...args],{encoding:"utf8",timeout:15000})).stdout.trim();}

export async function assertIsolatedWorktree({projectRoot,defaultDir,runRoot,stateDir,repositoryRoot,forbiddenRoots=[]}){
  const [project,defaultRoot,run,state,repository]=await Promise.all([projectRoot,defaultDir,runRoot,stateDir,repositoryRoot].map(real));
  assert(!same(project,repository),"Refuse the corrector source repository as a business worktree");
  assert(!same(project,defaultRoot),"Expected a new native worktree, not its frozen source repository");
  for(const forbidden of forbiddenRoots){const root=path.resolve(forbidden);assert(!same(project,root)&&!inside(root,project),"Refuse an original business project or one of its descendants");}
  assert(inside(run,defaultRoot)&&inside(run,state)&&inside(run,project),"Project and owned repository/state must remain in this new run");
  const expectedWorktrees=path.join(state,"worktrees");
  assert(inside(expectedWorktrees,project),"Native worktree must use this run's OPENCLAW_STATE_DIR/worktrees");
  const gitEntry=path.join(defaultRoot,".git"),stat=await fs.lstat(gitEntry);
  assert(stat.isDirectory()&&!stat.isSymbolicLink(),"Frozen source must own an independent .git directory");
  const expectedCommon=await real(gitEntry);
  const [projectCommon,defaultCommon,top,projectHead,defaultHead,listing]=await Promise.all([
    git(project,["rev-parse","--path-format=absolute","--git-common-dir"]).then(real),
    git(defaultRoot,["rev-parse","--path-format=absolute","--git-common-dir"]).then(real),
    git(project,["rev-parse","--show-toplevel"]).then(real),
    git(project,["rev-parse","HEAD"]),git(defaultRoot,["rev-parse","HEAD"]),
    git(defaultRoot,["-c","core.quotePath=false","worktree","list","--porcelain","-z"]),
  ]);
  assert(same(defaultCommon,expectedCommon)&&same(projectCommon,expectedCommon),"Native worktree is not owned by this run's frozen default repository");
  assert(same(top,project),"Returned projectRoot must be the exact worktree root");
  assert.equal(projectHead,defaultHead,"Native worktree must start at the frozen input commit");
  const registered=await Promise.all(listing.split("\0").filter(field=>field.startsWith("worktree ")).map(field=>real(field.slice(9))));
  assert(registered.some(file=>same(file,project)),"Native worktree is missing from the owned repository registry");
  return {status:"PASS_OWNED_ISOLATED_NATIVE_WORKTREE",projectRoot:project,defaultDir:defaultRoot,runRoot:run,stateDir:state,
    expectedWorktreesRoot:expectedWorktrees,gitCommonDir:projectCommon,expectedGitCommonDir:expectedCommon,
    head:projectHead,registeredWithOwnedDefaultRepository:true,sourceRepositoryRejected:true,originalBusinessRootsRejected:forbiddenRoots,
    method:"realpath + run/state containment + independent default .git + matching git-common-dir/HEAD + git worktree registration",readOnly:true};
}
