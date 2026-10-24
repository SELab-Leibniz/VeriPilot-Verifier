// Targeted source regression; never changes or re-admits the original business run.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { runOpenClawStopTask } from "../../lib/openclaw/stop-task-runtime.mjs";
import { ensureTask, taskDirectory } from "../../lib/runtime-v2/task-store.mjs";
import { buildMetricPopulation, METRIC_CATALOG_VERSION } from "../../lib/runtime-v2/metrics.mjs";
import { validateReviewJudgement } from "../../lib/runtime-v2/review-result-validation.mjs";
import { sha256 } from "../../lib/runtime-v2/utils.mjs";
import { REVIEW_PROMPT_PROFILE_DIGEST } from "../../lib/review-task/prompt-profile.mjs";

const repository = process.cwd(), exec = promisify(execFile);
const output = path.resolve(process.argv[2] ?? "experiments/live-m16-repair-validation-20261025-01");
assert.equal(path.dirname(output), path.join(repository, "experiments"));
assert(/^live-m16-repair-validation-[\w-]+$/u.test(path.basename(output)));
await fs.mkdir(output); // A previous evidence set must never be overwritten.
const originalFile = path.join(repository, "experiments/live-todolist-m16-20261025-02/host/host-state/worktrees/d35cec1e59d75abb/wt-6f351508/todo.py");
const original = await fs.readFile(originalFile, "utf8"), originalHash = sha256(Buffer.from(original));
assert.equal(originalHash, "24d9c868db040cef0279b798feccc2e112acf498e534b2b6a03bb38bc89d79ca");
const contract = await fs.readFile(new URL("requirements.md", import.meta.url), "utf8");
const replace = (s, a, b) => { assert(s.includes(a)); return s.replace(a, b); };
let fixed = replace(original, 'def meta_path(store_path):\n    parent = os.path.dirname(os.path.abspath(store_path))\n    return os.path.join(parent, "todo.meta.json")', '# Items and metadata share one atomic envelope at the selected path.');
fixed = replace(fixed, '        return json.load(handle)', '        data = json.load(handle)\n        return data["items"] if isinstance(data, dict) else data');
fixed = replace(fixed, '    path = meta_path(store_path)', '    path = store_path');
fixed = replace(fixed, '                data = json.load(handle)', '                envelope = json.load(handle)\n                data = envelope.get("meta", {}) if isinstance(envelope, dict) else {}');
fixed = replace(fixed, '        persist_atomic(store_path, items)\n', '');
fixed = replace(fixed, '        persist_atomic(meta_path(store_path), meta)', '        persist_atomic(store_path, {"items": items, "meta": meta})');
fixed = replace(fixed, 'are persisted in a small metadata file (``todo.meta.json``) next to the store,', 'are persisted together with business items in the selected JSON store,');
const requirement = "List returns an array of persisted todo items selected by --store PATH across separate command processes. An absent store lists as [] without creating a file.";
const cases = [
  { name: "original-a", source: original, requirement, basis: contract, expected: "DEVIATION", todo: true },
  { name: "original-b", source: original, requirement, basis: contract, expected: "DEVIATION", todo: true },
  { name: "repaired-envelope", source: fixed, requirement, basis: contract, expected: "PASS", todo: true, acceptance: true },
  { name: "fixed-success", source: 'export async function authenticate(credentials) { return { authenticated: true, userId: "demo" }; }\n', requirement: "authenticate(credentials) must authenticate the actual credentials with the production identity provider and return its real user result.", expected: "DEVIATION" },
  { name: "discarded-result", source: 'import { authenticate } from "./provider.js";\nexport async function login(credentials) { await authenticate(credentials); return { authenticated: true }; }\n', extra: { "provider.js": 'export async function authenticate(credentials) { const response = await fetch("https://identity.example/auth", { method: "POST", body: JSON.stringify(credentials) }); return response.json(); }\n' }, requirement: "login(credentials) must return the actual provider authentication result, including denial, to its caller.", expected: "DEVIATION" },
  { name: "unreachable", source: 'import { authenticate } from "./provider.js";\nexport async function login(credentials) { return { pending: true }; return authenticate(credentials); }\n', extra: { "provider.js": 'export const authenticate = async credentials => fetch("https://identity.example/auth", { method: "POST", body: JSON.stringify(credentials) });\n' }, requirement: "Calling login(credentials) must reach the production authentication provider with the supplied credentials.", expected: "DEVIATION" },
  { name: "authorized-mock", source: 'export const preview = input => ({ mode: "mock", echo: input });\n', requirement: "Provide preview(input). This milestone explicitly authorizes a Mock-only preview that returns mode mock and echoes the actual input. Real external processing is outside this milestone.", expected: "PASS" },
];
const report = { kind: "targeted-source-regression-not-a-new-business-e2e", catalogVersion: METRIC_CATALOG_VERSION,
  promptDigest: REVIEW_PROMPT_PROFILE_DIGEST, originalFile, originalHash, startedAt: new Date().toISOString(), cases: [] };
let selection;
if (!process.argv.includes("--prepare-only")) {
  // Credentials remain in memory and are never copied into review inputs.
  const configured = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/openclaw.json"), "utf8"));
  const cache = JSON.parse(await fs.readFile(path.join(os.homedir(), ".openclaw/agents/main/agent/models.json"), "utf8"));
  const ref = typeof configured.agents.defaults.model === "string" ? configured.agents.defaults.model : configured.agents.defaults.model.primary;
  const slash = ref.indexOf("/"), id = ref.slice(0, slash), p = configured.models.providers[id], c = cache.providers[id];
  const provider = { ...c, ...p, apiKey: p?.apiKey ?? c?.apiKey, models: p?.models ?? c?.models, headers: p?.headers ?? c?.headers };
  assert.equal(Object.keys(provider.headers ?? {}).length, 0);
  selection = { provider: id, model: ref.slice(slash + 1), config: { models: { providers: { [id]: provider } }, agents: configured.agents } };
  report.model = ref;
  report.destination = new URL(provider.baseUrl).origin;
  assert.equal(report.destination, "https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com");
}
for (const item of cases) {
  const projectRoot = path.join(output, item.name), main = item.todo ? "todo.py" : "main.js";
  await fs.mkdir(projectRoot);
  for (const [name, contents] of Object.entries({ [main]: item.source, ...item.extra })) await fs.writeFile(path.join(projectRoot, name), contents);
  const task = await ensureTask({ projectRoot, sessionId: item.name });
  const claim = { claimId: "R1", revisionId: "R1@1", category: "requirements", text: item.requirement, authority: "USER_EXPLICIT",
    severity: "HARD", status: "ACTIVE", verificationTarget: "IMPLEMENTATION", applicability: "CURRENT_TASK", applicabilityKind: "CURRENT_TASK" };
  const claims = [claim, ...(item.basis ? [{ ...claim, claimId: "SCOPE", revisionId: "SCOPE@1", category: "inScope", text: item.basis }] : [])];
  const truth = { version: 1, claims, digest: sha256(claims) }, groundTruthPath = path.join(taskDirectory(projectRoot, task.taskId), "ground-truth/current.json");
  await fs.mkdir(path.dirname(groundTruthPath), { recursive: true });
  await fs.writeFile(groundTruthPath, JSON.stringify(truth));
  const population = await buildMetricPopulation({ projectRoot, taskId: task.taskId, groundTruth: truth }), object = population.metrics.M16.find(o => o.sourceId === "R1");
  const sourceManifest = await Promise.all([main, ...Object.keys(item.extra ?? {})].map(async name => ({ path: name, sha256: sha256(await fs.readFile(path.join(projectRoot, name))) })));
  const row = { name: item.name, expected: item.expected, sourceManifest };
  if (item.acceptance) {
    await fs.mkdir(path.join(projectRoot, "acceptance"));
    await fs.copyFile(new URL("verify_todolist.py", import.meta.url), path.join(projectRoot, "acceptance/verify_todolist.py"));
    await fs.copyFile(path.join(repository, "examples/python-todolist-transactions/test_todo.py"), path.join(projectRoot, "test_todo.py"));
    row.acceptance = await exec("C:/Users/user/miniforge3/python.exe", [path.join(projectRoot, "acceptance/verify_todolist.py"), "--project", projectRoot]);
    assert(row.acceptance.stdout.includes("TODOLIST_VERIFIED"));
  }
  if (item.todo) {
    const store = path.join(projectRoot, "appdata/todo.meta.json"), python = "C:/Users/user/miniforge3/python.exe";
    const added = await exec(python, [path.join(projectRoot, main), "--store", store, "add", "boundary item"]);
    const listed = await exec(python, [path.join(projectRoot, main), "--store", store, "list"]);
    row.probe = { added: JSON.parse(added.stdout), listed: JSON.parse(listed.stdout) };
    assert.equal(Array.isArray(row.probe.listed), item.acceptance === true);
  }
  if (selection) {
    const started = Date.now();
    try {
      const handle = await runOpenClawStopTask({ projectRoot, taskId: task.taskId, role: "stop-reviewer", reviewer: { timeoutMs: 120000 },
        request: { groundTruthPath, sourceManifest, population: { ...population, metrics: { M16: [object] } }, fixedStopClassification: { stopClassification: "TASK_COMPLETE", stage: null }, reviewScope: { objectIds: [object.objectId] } }, evidence: { groundTruth: truth, snapshot: { entries: [] } } }, { selection, env: process.env });
      Object.assign(row, handle.result.metricObjectJudgements[0], { sourceCitations: handle.sourceCitations });
      validateReviewJudgement({ row, object, citations: handle.sourceCitations });
      row.matched = row.judgement === item.expected;
      await handle.close?.();
    } catch (error) { Object.assign(row, { error: error.code ?? "FAILED", diagnostic: error.reviewDiagnostic, matched: false }); }
    row.elapsedMs = Date.now() - started;
  }
  report.cases.push(row);
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ case: item.name, judgement: row.judgement, matched: row.matched, prepared: !selection }));
}
assert.equal(sha256(await fs.readFile(originalFile)), originalHash);
report.finishedAt = new Date().toISOString();
report.passed = selection ? report.cases.every(item => item.matched) : null;
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
if (report.passed === false) process.exitCode = 1;
