import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { withNativeReviewerTools, withReadOnlyReviewerTools } from "../lib/openclaw/native-config.mjs";
import { buildArguments } from "../lib/runtime-v2/reviewer.mjs";
import * as claude from "../lib/hosts/claude.mjs";
import * as codeagent from "../lib/hosts/codeagent.mjs";
import { HOST_TOOL_REVIEWER_ROLES, blockReviewerToolCall } from "../lib/reviewer-tools.mjs";

test("private grants retain host tools, explicit denies and unrelated agent policies without mutating the host", () => {
  for (const tools of [{ alsoAllow: ["host-agent-tool"], deny: ["exec"] }, { allow: ["read", "exec"], deny: ["rc_progress"] }]) {
    const config = { tools: { profile: "coding", alsoAllow: ["host-global-tool"], deny: ["write"] },
      agents: { list: [{ id: "main", tools }, { id: "other", tools: { allow: ["browser"] } }] } };
    const before = structuredClone(config);
    const actual = withNativeReviewerTools(config, "main", ["rc_progress"]);
    assert.deepEqual(config, before);
    assert.deepEqual(actual.tools, before.tools);
    assert.deepEqual(actual.agents.list[1], before.agents.list[1]);
    assert.deepEqual(actual.agents.list[0].tools.deny, tools.deny);
    const field = tools.allow ? "allow" : "alsoAllow";
    assert.deepEqual(actual.agents.list[0].tools[field], [...tools[field], "rc_progress"]);
    assert.equal(Boolean(actual.agents.list[0].tools.allow?.length && actual.agents.list[0].tools.alsoAllow?.length), false);
  }
});

test("only the five explicit roles inherit CLI tools and permissions in either host dialect", () => {
  for (const hostAdapter of [claude, codeagent]) for (const role of [...HOST_TOOL_REVIEWER_ROLES, "stop-reviewer", "ground-truth-extractor", "unknown-role", null]) {
    const args = buildArguments({ role, hostAdapter, prompt: "Inspect the assigned request.", schema: { type: "object" },
      reviewer: { effort: "low" }, sessionId: null, fork: false });
    for (const flag of ["--tools", "--allowedTools", "--strict-mcp-config", "--permission-mode"])
      assert.equal(args.includes(flag), !HOST_TOOL_REVIEWER_ROLES.includes(role), `${hostAdapter.host}/${role}/${flag}`);
    const denied = args[args.indexOf("--disallowedTools") + 1].split(",");
    for (const tool of ["Write", "Edit", "Bash", "NotebookEdit", "CodeExecution"])
      assert(denied.includes(tool), `${hostAdapter.host}/${role} must deny ${tool}`);
  }
});

test("read-only private copies disable execution wrappers while preserving host context and private tools", () => {
  const host = { tools: { profile: "full", deny: ["host-sensitive"], codeMode: { enabled: true, timeoutMs: 5000 } },
    agents: { defaults: { contextTokens: 48000, compaction: { mode: "safeguard" } },
      list: [{ id: "main", tools: { alsoAllow: ["browser"], codeMode: { enabled: true } } }, { id: "other", tools: { allow: ["read"] } }] } };
  const before = structuredClone(host);
  const actual = withReadOnlyReviewerTools(withNativeReviewerTools(host, "main", ["read", "rc_progress"]), "main");
  assert.deepEqual(host, before);
  assert.deepEqual(actual.agents.defaults, before.agents.defaults);
  assert.deepEqual(actual.agents.list[1], before.agents.list[1]);
  assert.equal(actual.tools.codeMode.enabled, false);
  assert.equal(actual.tools.codeMode.timeoutMs, 5000);
  assert.equal(actual.agents.list[0].tools.codeMode.enabled, false);
  assert(actual.tools.deny.includes("host-sensitive"));
  for (const tool of ["write", "edit", "apply_patch", "exec", "process", "code_execution"]) {
    assert(actual.tools.deny.includes(tool));
    assert(actual.agents.list[0].tools.deny.includes(tool));
  }
  assert(actual.agents.list[0].tools.alsoAllow.includes("rc_progress"));
});

test("late-discovered write, edit and execution aliases are blocked before invocation while review receipts remain available", () => {
  for (const name of ["Write", "Edit", "apply-patch", "applyPatch", "Bash", "process", "code_execution", "NotebookEdit", "MultiEdit",
    "mcp__files__write_file", "mcp__files__editFile", "mcp__runtime__execute_code", "mcp__runtime__run_command"])
    assert.equal(blockReviewerToolCall(name).block, true, name);
  for (const name of ["read", "grep", "web_search", "mcp__files__read_file", "rc_progress", "save_baseline_batch", "finish_baseline", "submit_review", "read:result"])
    assert.equal(blockReviewerToolCall(name), undefined, name);
});

test("installed MA policy keeps host tools plus private progress and still enforces every deny layer", async t => {
  if (!process.env.RC_OPENCLAW_HOST_ROOT) { t.skip("Set RC_OPENCLAW_HOST_ROOT for the read-only host policy contract."); return; }
  const root = await fs.realpath(process.env.RC_OPENCLAW_HOST_ROOT);
  if (JSON.parse(await fs.readFile(path.join(root, "package.json"))).version !== "2026.7.1-2") {
    t.skip("This read-only policy contract targets MA's OpenClaw 2026.7.1-2."); return;
  }
  const load = file => import(pathToFileURL(path.join(root, "dist", file)));
  const [policies, helpers, pipeline] = await Promise.all([
    load("agent-tools.policy-YD9HuYgO.js"), load("tool-policy-BHUGxE3p.js"), load("tool-policy-pipeline-C3edOW1F.js"),
  ]);
  const tools = ["read", "exec", "write", "edit", "apply_patch", "process", "code_execution", "bash", "apply-patch", "browser",
    "host_agent_tool", "rc_progress", "mcp__files__read_file", "mcp__files__write_file", "mcp__runtime__execute_code"].map(name => ({ name }));
  const toolMeta = tool => ["host_agent_tool", "rc_progress"].includes(tool.name) || tool.name.startsWith("mcp__")
    ? { pluginId: tool.name === "rc_progress" ? "runtime-corrector" : "host-plugin" } : null;
  const available = config => {
    const policy = policies.r({ config, agentId: "main", modelProvider: "fixture", modelId: "model" });
    return pipeline.t({ tools, toolMeta, warn() {}, steps: pipeline.n({ ...policy,
      profilePolicy: helpers.c(helpers.h(policy.profile), policy.profileAlsoAllow),
      providerProfilePolicy: helpers.c(helpers.h(policy.providerProfile), policy.providerProfileAlsoAllow),
    }) }).map(tool => tool.name).sort();
  };
  const config = { tools: { profile: "coding", deny: ["write"], byProvider: { fixture: { deny: ["browser"] } } },
    agents: { list: [{ id: "main", tools: { alsoAllow: ["browser", "host_agent_tool"], deny: ["exec"] } }] } };
  const before = structuredClone(config);
  const original = available(config);
  assert(original.includes("host_agent_tool") && original.includes("read"));
  for (const name of ["exec", "bash", "write", "browser"]) assert.equal(original.includes(name), false, name);
  const granted = withNativeReviewerTools(config, "main", ["rc_progress"]);
  assert.deepEqual(available(granted), [...original, "rc_progress"].sort());
  const denied = structuredClone(granted);
  denied.agents.list[0].tools.deny.push("rc_progress");
  assert.deepEqual(available(denied), original, "a private grant must not defeat an explicit host deny");
  assert.deepEqual(config, before);
  const full = { tools: { profile: "full", codeMode: { enabled: true } },
    agents: { list: [{ id: "main", tools: { alsoAllow: ["host_agent_tool"] } }] } };
  const readonly = withReadOnlyReviewerTools(withNativeReviewerTools(full, "main", ["read", "rc_progress"]), "main");
  assert.deepEqual(available(readonly), ["browser", "host_agent_tool", "mcp__files__read_file", "rc_progress", "read"].sort(),
    "real host filtering must remove writes, edits, patch and execution tools even under the full profile");
});
