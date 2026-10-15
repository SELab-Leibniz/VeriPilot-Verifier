// Semantic proposal probe, not an OpenClaw Gateway/native Stop acceptance test.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkProcessEvidence, CANDIDATE_INSTRUCTIONS } from "./process-contract-lab/contract.mjs";
import { fixtures, modelInputs } from "./process-contract-lab/fixtures.mjs";
import { SOURCE_INSTRUCTIONS } from "../../lib/runtime-v2/ground-truth-provenance.mjs";
import { PROCESS_REVIEW_INSTRUCTIONS } from "../../lib/runtime-v2/process-checks.mjs";

const destination = process.argv[2];
const production = process.argv.includes("--production");
if (!destination || !process.env.RC_TEST_MODEL_KEY) throw new Error("New output directory and RC_TEST_MODEL_KEY required");
await fs.mkdir(destination, { mode: 0o700 });
const root = await fs.realpath(destination), sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
const key = process.env.RC_TEST_MODEL_KEY;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value).replaceAll(key, "<redacted>");
const save = (name, value) => fs.writeFile(path.join(root, name), redact(JSON.stringify(value, null, 2)) + "\n");
const paths = ["lib/runtime-v2/onboarding.mjs", "lib/runtime-v2/ground-truth-provenance.mjs", "lib/runtime-v2/ground-truth-ledger.mjs", "lib/runtime-v2/orchestrator.mjs", "lib/runtime-v2/metrics.mjs"];
const sources = Object.fromEntries(await Promise.all(paths.map(async file => [file, await fs.readFile(path.join(sourceRoot, file), "utf8")])));
const onboarding = sources[paths[0]], start = onboarding.indexOf("const ONBOARDING_INSTRUCTIONS = ["), end = onboarding.indexOf("\n];", start) + 3;
const baselineInstructions = [
  "Apply the following existing extractor policy when deriving process rules, then assess the supplied complete event trace against each derived rule.",
  sources[paths[1]].slice(sources[paths[1]].indexOf("export const SOURCE_INSTRUCTIONS"), sources[paths[1]].indexOf("function normalizedRef")),
  onboarding.slice(start, end),
  "Classify completion separately from verification. Judge the supplied obligations; do not invent or omit obligations. Use NOT_APPLICABLE, UNVERIFIED and CHECKER_ERROR distinctly.",
];
const outputContract = `Return exactly one JSON object with cases:[{id,rule:{text,strength: HARD|SOFT,ordering: REQUIRED|SUGGESTED|UNSPECIFIED},judgement: PASS|DEVIATION|UNVERIFIED|CHECKER_ERROR|NOT_APPLICABLE,reasonType: ORDER|OTHER,reason,orderEvidence: null|{requiredFirstEvent,requiredSecondEvent}}]. Return one row per case with its exact supplied id; never add suffixes or split cases. Assess ONLY whether the read-before-edit order is mandatory and violated. Other obligations remain outside this probe. Keep reasons concise. This is a frozen semantic probe; do not execute tools.`;
await save("inputs.json", { cases: modelInputs, sourceHashes: Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, hash(s)])),
  model: "doubao-seed-2.1-lite", endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  limits: { calls: production ? 1 : 2, attemptsPerArm: 1, timeoutMs: 60000, maxTokens: 3500 },
  syntheticOnly: true, gatewayUsed: false, baselineIsScopedPolicyProbeNotFullRuntime: true });
async function arm(name, candidate) {
  const instructions = production ? [...SOURCE_INSTRUCTIONS, ...PROCESS_REVIEW_INSTRUCTIONS, outputContract]
    : [...baselineInstructions, ...(candidate ? CANDIDATE_INSTRUCTIONS : []), outputContract];
  await save(`${name}-request.json`, { instructions, cases: modelInputs });
  const startedAt = Date.now();
  try {
    const response = await fetch("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "doubao-seed-2.1-lite", max_tokens: 3500, reasoning_effort: "low", temperature: 0,
        messages: [{ role: "system", content: instructions.join("\n") }, { role: "user", content: JSON.stringify(modelInputs) }] }),
      signal: AbortSignal.timeout(60000),
    });
    const envelope = await response.json();
    const message = envelope.choices?.[0]?.message;
    // Reasoning is neither displayed nor used as an acceptance result.
    const raw = message?.content ?? "";
    await save(`${name}-response.json`, { status: response.status, finishReason: envelope.choices?.[0]?.finish_reason,
      content: raw, usage: envelope.usage, error: envelope.error });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(envelope.error)}`);
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, ""));
    if (!Array.isArray(parsed.cases) || parsed.cases.length !== fixtures.length
      || new Set(parsed.cases.map(row => row.id)).size !== fixtures.length) throw new Error("Incomplete or duplicated case results");
    const results = fixtures.map(fixture => {
      const row = parsed.cases.find(item => item.id === fixture.id);
      if (!row) throw new Error(`Missing case ${fixture.id}`);
      const required = row.rule?.strength === "HARD" && row.rule?.ordering === "REQUIRED";
      const deviation = row.judgement === "DEVIATION" && row.reasonType === "ORDER";
      return { id: fixture.id, result: row, guard: production ? null : checkProcessEvidence(fixture, row),
        semanticExpected: fixture.expected, semanticChecksPass: required === fixture.expected.orderRequired && deviation === fixture.expected.confirmedOrderDeviation };
    });
    return { name, status: "COMPLETED", durationMs: Date.now() - startedAt, results,
      semanticPass: results.filter(row => row.semanticChecksPass).length, total: results.length };
  } catch (error) { return { name, status: "FAILED", durationMs: Date.now() - startedAt, error: redact(error.message) }; }
}
const results = await Promise.allSettled(production ? [arm("production", false)] : [arm("baseline", false), arm("candidate", true)]);
const arms = results.map(result => result.status === "fulfilled" ? result.value : ({status:"FAILED",error:redact(result.reason)}));
const unchanged = (await Promise.all(Object.entries(sources).map(async ([file, text]) =>
  hash(await fs.readFile(path.join(sourceRoot, file))) === hash(text)))).every(Boolean);
const report = { experiment: "process-contract-semantic-probe", realModel: true, nativeGateway: false,
  productionCodeUnchanged: unchanged, arms,
  productionPolicy: production, literalGuardUsed: !production,
  conclusion: production ? "Bounded semantic probe of the current shared policy, not full native acceptance or proof of general robustness."
    : "Mechanical provenance/order checks are necessary, not proof of semantic entailment or general robustness. Do not authorize production HARD gates solely from this prototype." };
await save("summary.json", report);
for (const a of arms) process.stdout.write(JSON.stringify({ arm:a.name,status:a.status,semanticPass:a.semanticPass,total:a.total,error:a.error }) + "\n");
if (!unchanged || arms.some(a => a.status !== "COMPLETED" || (production && a.semanticPass !== a.total))) process.exitCode = 1;
