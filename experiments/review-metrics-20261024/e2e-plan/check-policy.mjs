import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const repository = await fs.realpath(process.cwd()), base = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(repository, ".runtime-correction", "all-metrics-lab-20261024", `e2e-policy-preflight-${Date.now()}`);
await fs.mkdir(path.join(root,".runtime-corrector"),{recursive:true});
await fs.mkdir(path.join(root,"spec"),{recursive:true});
const policy = (await fs.readFile(path.join(base,"kitchen-policy.yaml"),"utf8")).replaceAll("{{modelId}}","deepseek-v4-flash");
await fs.writeFile(path.join(root,".runtime-corrector/config.yaml"),policy);
await fs.copyFile(path.join(repository,"examples/openclaw-offline-kitchen/skills/build-offline-kitchen/references/requirements.md"),path.join(root,"spec/requirements.md"));
const {loadProjectConfigDocument}=await import(pathToFileURL(path.join(repository,"lib/policy/config-loader.mjs")));
const {loadConfig}=await import(pathToFileURL(path.join(repository,"lib/runtime-corrector.mjs")));
const document=await loadProjectConfigDocument(root);
const plan=await loadConfig({cwd:root,pluginRoot:repository});
const runtime=plan.runtimeV2;
for(const value of [runtime.enabled,runtime.dynamicGroundTruth.enabled,runtime.skillCorrection.enabled,
  runtime.artifactCorrection.groundTruthReviewEnabled,runtime.artifactCorrection.stageMetricsEnabled,
  runtime.implementationCorrection.enabled,runtime.stopCorrection.enabled])assert.equal(value,true);
assert.equal(plan.artifacts.length,1);
assert.equal(plan.artifacts[0].reviewEnabled,true);
assert.equal(plan.artifacts[0].rulesPolicy.enabled,false);
assert.equal(plan.artifacts[0].format,"text");
assert.equal(runtime.dynamicGroundTruth.materialRoots[0],path.join(root,"spec/requirements.md"));
const sha=value=>createHash("sha256").update(value).digest("hex");
const report={status:"PASS_CONFIG_SCHEMA_AND_PRODUCTION_LOAD",at:new Date().toISOString(),modelCalls:0,gatewayUsed:false,
 policySha256:sha(policy),templateSha256:sha(await fs.readFile(path.join(base,"kitchen-policy.yaml"))),
 configPath:document.configPath,
 enabled:{runtime:runtime.enabled,dynamicGroundTruth:runtime.dynamicGroundTruth.enabled,
   skillCorrection:runtime.skillCorrection.enabled,artifactGroundTruth:runtime.artifactCorrection.groundTruthReviewEnabled,
   artifactStageMetrics:runtime.artifactCorrection.stageMetricsEnabled,implementationCorrection:runtime.implementationCorrection.enabled,
   stopCorrection:runtime.stopCorrection.enabled},
 artifact:plan.artifacts[0],configuredReviewerModel:runtime.reviewers.defaults??runtime.reviewers.stopReviewer?.model,
 stopBudgetOverrides:{assessmentTimeoutMs:runtime.stopCorrection.assessmentTimeoutMs,waitTimeoutMs:runtime.stopCorrection.waitTimeoutMs},
 runtimeStatePaths:{tasks:"<project>/.runtime-correction/tasks/**/task.json",population:"<project>/.runtime-correction/tasks/**/metrics/population.json",stop:"<project>/.runtime-correction/openclaw/native-stop-reviews/**/*.json",followup:"<project>/.runtime-correction/openclaw/native-followups/**/*.json",nativeRuns:"<project>/.runtime-correction/openclaw/native-runs/**/*.json",evaluations:"<project>/.runtime-correction/tasks/**/evaluations/stop-*.json"},
 limitations:["Policy loading does not prove model, Gateway, artifact-review or workflow success.","stageMetricsEnabled is configured but kitchen-source has no metricCheckpoint; full Stop owns the complete metric population.","This preflight root is private and is never used as an authoritative live business project."]};
await fs.writeFile(path.join(base,"policy-preflight.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({status:report.status,enabled:report.enabled,format:report.artifact.format,configuredReviewerModel:report.configuredReviewerModel,stopBudgetOverrides:report.stopBudgetOverrides}));
