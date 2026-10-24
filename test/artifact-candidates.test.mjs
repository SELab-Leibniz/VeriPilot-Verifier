import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { localSkillRoots } from "../lib/active-host.mjs";
import { compileRuntimePolicy } from "../lib/policy/compiler.mjs";
import { collectArtifactCandidates } from "../lib/runtime-v2/artifact-candidates.mjs";
import { compileRuntimeV2Config } from "../lib/runtime-v2/config.mjs";
import { applyGroundTruthDelta } from "../lib/runtime-v2/ground-truth-ledger.mjs";
import { handleRuntimeV2Event } from "../lib/runtime-v2/orchestrator.mjs";
import { ensureTask, taskDirectory, decisionGuard } from "../lib/runtime-v2/task-store.mjs";
import { sha256 } from "../lib/runtime-v2/utils.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-artifact-candidates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, bytes = relative) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  return { root, write };
}

const artifact = (nodeId, patterns, metrics = []) => ({ nodeId, stage: "requirements", patterns, metrics });

test("a source declaration and metricCheckpoint alone do not invent artifact proof subjects", async t => {
  const f = await fixture(t);
  await f.write("kitchen.py", "print('ready')\n");
  await f.write("docs/decomposition.md", "An undeclared ordinary file.\n");
  const source = artifact("kitchen-source", ["kitchen.py"]);
  source.metricCheckpoint = true;
  assert.deepEqual(await collectArtifactCandidates({ projectRoot: f.root, plan: { artifacts: [source] } }), []);
});

test("explicit configured ownership binds complete hashed files without a related-file cap or filename role guesses", async t => {
  const f = await fixture(t);
  for (const name of ["config.md", "reviewer.md", "requirements.md"]) await f.write(`docs/${name}`);
  await f.write("docs/large.md", "x".repeat(2 * 1024 * 1024 + 1));
  const plan = compileRuntimePolicy({ artifacts: [artifact("unusual-role-name", ["docs/*.md"], ["M05", "M01"])],
    limits: { maxRelatedFiles: 1 } }, { projectRoot: f.root });
  const [binding] = await collectArtifactCandidates({ projectRoot: f.root, plan });
  assert.equal(binding.artifactId, "unusual-role-name");
  assert.deepEqual(binding.metricIds, ["M01", "M05"]);
  assert.equal(binding.files.length, 4);
  for (const file of binding.files) assert.equal(file.sha256, sha256(await fs.readFile(path.join(f.root, file.path))));
  assert.deepEqual(binding.declaration, { configPath: null, configSha256: null, digest: binding.declaration.digest });
  assert.match(binding.declaration.digest, /^[a-f0-9]{64}$/u);
});

test("ownership honors the existing first configured matcher and path-template identities", async t => {
  const f = await fixture(t);
  await f.write("docs/reference.md"); await f.write("docs/candidate.md"); await f.write("tasks/one/criteria.md");
  const blocker = artifact("reference-owner", ["docs/reference.md"]);
  const bound = artifact("candidate-owner", ["docs/*.md"], ["M01"]);
  const template = { nodeId: "criteria-owner", stage: "requirements", pathTemplates: ["tasks/{task}/criteria.md"], metrics: ["M05"] };
  const plan = compileRuntimePolicy({ artifacts: [blocker, bound, template] }, { projectRoot: f.root });
  const result = await collectArtifactCandidates({ projectRoot: f.root, plan });
  assert.deepEqual(result.map(binding => binding.files.map(file => file.path)), [["docs/candidate.md"], ["tasks/one/criteria.md"]]);
});

test("actual authority and control identities stay separate from explicitly bound business candidates", async t => {
  const f = await fixture(t);
  const configPath = await f.write("policy.yaml", "version: 2\n");
  const reviewerFile = await f.write("checks/criteria.md");
  const simpleRulesFile = await f.write("checks/rules.md");
  for (const name of ["spec/original.md", "reference/contract.md", "playbooks/build/SKILL.md",
    ".runtime-correction/internal.md", ".runtime-corrector/policy.md", ".runtime-corrector.json", "AGENTS.md",
    "private-output/state.md", "ignored/old.md", "docs/config.md", "docs/reviewer.md", "docs/requirements.md"])
    await f.write(name);
  const hostSkillRoot = localSkillRoots({ projectRoot: f.root }).find(directory => directory.startsWith(f.root));
  await f.write(path.relative(f.root, path.join(hostSkillRoot, "example/SKILL.md")));
  const plan = { configPath, artifacts: [{ ...artifact("business", ["**/*"], ["M01"]),
    reviewerFile: process.platform === "win32" ? reviewerFile.toUpperCase() : reviewerFile, simpleRulesFile }],
    groundTruthSources: [{ id: "contract", patterns: ["reference/*.md"] }], ignorePatterns: ["ignored/**"],
    output: { directory: "private-output" }, runtimeV2: { dynamicGroundTruth: { materialRoots: [path.join(f.root, "spec")] },
      skillCorrection: { skillRoots: [path.join(f.root, "playbooks")] } } };
  const [binding] = await collectArtifactCandidates({ projectRoot: f.root, plan });
  assert.deepEqual(binding.files.map(file => file.path), ["docs/config.md", "docs/requirements.md", "docs/reviewer.md"]);
  assert.equal(binding.declaration.configPath, configPath);
  assert.equal(binding.declaration.configSha256, sha256(await fs.readFile(configPath)));
});

test("hashes track every candidate byte and declaration semantics independently", async t => {
  const f = await fixture(t), configPath = await f.write("policy.yaml", "first\n");
  await f.write("docs/one.md", "first candidate\n"); await f.write("docs/two.md", "second candidate\n");
  const plan = { configPath, artifacts: [artifact("requirements", ["docs/*.md"], ["M01"])] };
  const collect = async () => (await collectArtifactCandidates({ projectRoot: f.root, plan }))[0];
  const before = await collect();
  await f.write("docs/two.md", "changed without being read by any reviewer\n");
  const changed = await collect();
  assert.equal(changed.files[0].sha256, before.files[0].sha256);
  assert.notEqual(changed.files[1].sha256, before.files[1].sha256);
  assert.equal(changed.declaration.digest, before.declaration.digest);
  await f.write("policy.yaml", "second\n");
  const configChanged = await collect();
  assert.notEqual(configChanged.declaration.configSha256, before.declaration.configSha256);
  plan.artifacts[0].metrics = ["M02"];
  assert.notEqual((await collect()).declaration.digest, before.declaration.digest);
  plan.artifacts[0].metrics = ["M01"];
  plan.artifacts.unshift(artifact("other-owner", ["docs/two.md"]));
  const ownershipChanged = await collect();
  assert.notEqual(ownershipChanged.declaration.digest, before.declaration.digest);
  assert.deepEqual(ownershipChanged.files.map(file => file.path), ["docs/one.md"]);
});

test("missing or unsafe configured paths remain unbound while missing declaration bytes fail honestly", async t => {
  const f = await fixture(t);
  const plan = { artifacts: [artifact("missing", ["docs/absent.md", "../outside.md"], ["M01"])] };
  const [binding] = await collectArtifactCandidates({ projectRoot: f.root, plan });
  assert.deepEqual(binding.files, []);
  assert.deepEqual(binding.metricIds, ["M01"]);
  plan.configPath = path.join(f.root, "absent-policy.yaml");
  await assert.rejects(collectArtifactCandidates({ projectRoot: f.root, plan }), { code: "ENOENT" });
});

test("disabled per-artifact reviews do not erase explicit Stop candidate declarations", async t => {
  const f = await fixture(t); await f.write("docs/requirements.md");
  const declared = { ...artifact("requirements", ["docs/*.md"], ["M01"]), reviewEnabled: false, metricCheckpoint: false };
  const [binding] = await collectArtifactCandidates({ projectRoot: f.root,
    plan: { configuredArtifacts: [declared], artifacts: [] } });
  assert.deepEqual(binding.files.map(file => file.path), ["docs/requirements.md"]);
});

test("the production Stop caller forwards one frozen declaration without changing its metric population", async t => {
  const f = await fixture(t), task = await ensureTask({ projectRoot: f.root, sessionId: "candidate-stop" });
  await applyGroundTruthDelta({ projectRoot: f.root, taskId: task.taskId, delta: { operations: [
    { operation: "ADD", category: "requirements", text: "The current delivery acknowledges this requirement.", authority: "USER_EXPLICIT",
      severity: "HARD", verificationTarget: "ARTIFACT", source: { ref: "user:1", kind: "USER_MESSAGE", subject: "MAIN_TASK" } },
  ] } });
  const file = await f.write("docs/current.md", "Current candidate\n");
  const transcript = await f.write("transcript.jsonl", JSON.stringify({ type: "user", uuid: "user:1",
    message: { content: "The current delivery acknowledges this requirement." } }) + "\n");
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false }, stopCorrection: { enabled: true } },
    { policyRoot: path.join(f.root, ".runtime-corrector") });
  const plan = { runtimeV2, artifacts: [artifact("current-delivery", ["docs/current.md"], ["M01", "M02", "M05"])] };
  const state = JSON.parse(await fs.readFile(path.join(taskDirectory(f.root, task.taskId), "task.json"), "utf8"));
  let captured;
  const reviewerFactory = async input => {
    captured = input.request;
    return { result: { summary: "No semantic verdict in this caller contract test.", stopClassification: "TASK_COMPLETE", stage: null,
      findings: [], metricObjectJudgements: Object.values(input.request.population.metrics).flat().map(object => ({
        objectId: object.objectId, judgement: "UNVERIFIED", reason: "Caller contract only.", evidence: [],
      })) }, close: async () => {} };
  };
  await handleRuntimeV2Event({ projectRoot: f.root, plan, reviewerFactory,
    assessmentContext: { mode: "verify_only", assessmentId: "candidate-contract", guard: decisionGuard(state),
      deadlineAt: Date.now() + 30000, maxCorrections: 1 }, input: { cwd: f.root, session_id: "candidate-stop", transcript_path: transcript,
      hook_event_name: "Stop", hook_event_id: "candidate-stop-event", last_assistant_message: "The delivery is complete." } });
  assert.ok(captured);
  assert.deepEqual(captured.artifactCandidates[0].files, [{ path: "docs/current.md", sha256: sha256(await fs.readFile(file)) }]);
  assert.deepEqual(captured.artifactCandidates[0].metricIds, ["M01", "M02", "M05"]);
  for (const metric of ["M01", "M02", "M05"]) assert.equal(captured.population.metrics[metric].length, 1);
});
