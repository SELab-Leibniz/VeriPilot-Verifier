import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeExecutable } from "../lib/claude-executable.mjs";
import * as claudeHost from "../lib/hosts/claude.mjs";
import * as codeAgentHost from "../lib/hosts/codeagent.mjs";
import * as launcher from "../lib/reviewer-launcher.mjs";

const {
  resolveReviewerLaunchPlan,
} = launcher;

test("reviewer launcher keeps legacy defaults when unconfigured", async () => {
  assert.deepEqual(await resolveReviewerLaunchPlan({ env: {}, platform: "linux" }), {
    executable: "claude", argsPrefix: [],
  });
});

test("unconfigured launchers preserve the old executable precedence and API", async () => {
  const env = {
    RUNTIME_CORRECTOR_AGENT_EXECUTABLE: "codeagent",
    RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: "legacy-override",
    CLAUDE_CODE_EXECUTABLE: "parent-claude",
  };
  assert.equal(await resolveClaudeExecutable(env, "linux"), "legacy-override");
  delete env.RUNTIME_CORRECTOR_AGENT_EXECUTABLE;
  assert.deepEqual(await resolveReviewerLaunchPlan({ env, platform: "linux" }), {
    executable: "legacy-override", argsPrefix: [],
  });
  delete env.RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE;
  assert.equal((await resolveReviewerLaunchPlan({ env, platform: "linux" })).executable, "parent-claude");
  assert.deepEqual(await resolveReviewerLaunchPlan({ env: {}, platform: "win32" }), {
    executable: "claude.exe", argsPrefix: [],
  });
});

test("runtime configuration is selected as one pair ahead of legacy overrides", async () => {
  assert.deepEqual(await resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: "node", argsPrefix: ["/opt/agent/entry.mjs"] },
    env: { RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: "claude-from-parent" },
    platform: "linux",
  }), { executable: "node", argsPrefix: ["/opt/agent/entry.mjs"] });
});

test("neutral executable override discards configured wrapper arguments", async () => {
  assert.deepEqual(await resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: "node", argsPrefix: ["/opt/agent/entry.mjs"] },
    env: { RUNTIME_CORRECTOR_AGENT_EXECUTABLE: "codeagent" },
    platform: "linux",
  }), { executable: "codeagent", argsPrefix: [] });
});


test("host protocol comes from the adapter and the removed environment override is ignored", async () => {
  assert.deepEqual(await resolveReviewerLaunchPlan({
    reviewerRuntime: {
      executable: "codeagentcli",
      argsPrefix: ["--wrapper"],
    },
    env: {},
    platform: "linux",
    hostAdapter: codeAgentHost,
  }), {
    executable: "codeagentcli",
    argsPrefix: ["--wrapper"],
  });
  for (const value of ["claude", "codeagent", "", "future"]) {
    assert.deepEqual(await resolveReviewerLaunchPlan({
      env: { RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT: value },
      platform: "linux",
      hostAdapter: codeAgentHost,
    }), { executable: "codeagentcli", argsPrefix: [] });
  }
  assert.equal((await resolveReviewerLaunchPlan({
    env: {}, platform: "linux", hostAdapter: codeAgentHost,
  })).executable, "codeagentcli");
});

test("reviewer environment sanitization removes only the obsolete dialect from a copy", () => {
  const source = {
    RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT: "codeagent",
    RUNTIME_CORRECTOR_AGENT_EXECUTABLE: "agent",
    KEEP: "value",
  };
  const sanitized = launcher.sanitizeReviewerEnvironment(source);
  assert.notEqual(sanitized, source);
  assert.equal(source.RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT, "codeagent");
  assert.equal(Object.hasOwn(sanitized, "RUNTIME_CORRECTOR_AGENT_SESSION_DIALECT"), false);
  assert.deepEqual(sanitized, {
    RUNTIME_CORRECTOR_AGENT_EXECUTABLE: "agent",
    KEEP: "value",
  });
});

test("CodeAgent executable resolution honors override, native install, and PATH fallback", async (t) => {
  const programFiles = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-program-files-"));
  t.after(() => fs.rm(programFiles, { recursive: true, force: true }));
  const native = path.join(programFiles, "CodeAgentCLI", "bin", "codeagentcli.exe");
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, "");

  assert.equal(await codeAgentHost.resolveDefaultReviewerExecutable({
    RUNTIME_CORRECTOR_CODEAGENT_EXECUTABLE: "dedicated-codeagent",
    ProgramFiles: programFiles,
  }, "win32"), "dedicated-codeagent");
  assert.equal(await codeAgentHost.resolveDefaultReviewerExecutable({
    ProgramFiles: programFiles,
  }, "win32"), native);
  assert.equal(await codeAgentHost.resolveDefaultReviewerExecutable({}, "linux"), "codeagentcli");
});


test("session argument builder maps Claude and CodeAgent identities exactly", () => {
  assert.deepEqual(claudeHost.buildReviewerSessionArguments(), []);
  assert.deepEqual(claudeHost.buildReviewerSessionArguments({
    sessionId: "parent", fork: true,
  }), ["--resume", "parent", "--fork-session"]);
  assert.deepEqual(claudeHost.buildReviewerSessionArguments({
    sessionId: "reviewer", noSessionPersistence: true,
  }), ["--resume", "reviewer", "--no-session-persistence"]);

  assert.deepEqual(codeAgentHost.buildReviewerSessionArguments(), []);
  assert.deepEqual(codeAgentHost.buildReviewerSessionArguments({
    sessionId: "reviewer",
  }), ["--sessions", "reviewer"]);
  assert.deepEqual(codeAgentHost.buildReviewerSessionArguments({
    sessionId: "parent", fork: true,
  }), ["--sessions", "parent", "--fork-session"]);
  assert.deepEqual(codeAgentHost.buildReviewerSessionArguments({
    sessionId: "reviewer", noSessionPersistence: true,
  }), ["--sessions", "reviewer", "--no-session-persistence"]);
});

test("normalization resolves executable paths once and captures an immutable argv prefix", async () => {
  const input = { executable: "./tools/codeagent", argsPrefix: ["/opt/entry file.mjs", "", "--flag=a,b"] };
  const plan = await resolveReviewerLaunchPlan({ reviewerRuntime: input, env: {}, platform: "linux", projectRoot: "/workspace/owner" });
  input.executable = "claude";
  input.argsPrefix[0] = "different.mjs";
  assert.deepEqual(plan, {
    executable: "/workspace/owner/tools/codeagent",
    argsPrefix: ["/opt/entry file.mjs", "", "--flag=a,b"],
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.argsPrefix));
  assert.deepEqual(await resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: "tools\\codeagent.exe" }, env: {}, platform: "win32", projectRoot: "C:\\workspace\\owner",
  }), {
    executable: "C:\\workspace\\owner\\tools\\codeagent.exe",
    argsPrefix: [],
  });
});

test("only undefined runtime is absent; invalid declared configuration cannot hide behind env", async () => {
  assert.equal(typeof launcher.normalizeReviewerRuntime, "function");
  assert.equal(launcher.normalizeReviewerRuntime(undefined), undefined);
  const invalid = [null, [], "codeagent", {}, { executable: "" }, { executable: " " },
    { executable: 1 }, { executable: "agent\u0000" }, { executable: "agent", argsPrefix: null },
    { executable: "agent", argsPrefix: "entry.mjs" }, { executable: "agent", argsPrefix: [4] },
    { executable: "agent", argsPrefix: ["arg\u0000"] }, { executable: "agent", argsPrefix: Array(1) },
    { executable: "agent", sessionDialect: "future" }, { executable: "agent", shell: true }];
  for (const reviewerRuntime of invalid) {
    await assert.rejects(resolveReviewerLaunchPlan({
      reviewerRuntime, env: { RUNTIME_CORRECTOR_AGENT_EXECUTABLE: "codeagent" }, platform: "linux",
    }), /reviewerRuntime/);
  }
});

test("invalid neutral overrides fail without falling back to a configured agent", async () => {
  for (const executable of ["", " ", "./agent", "agent/bin", "bad\u0000agent"]) {
    await assert.rejects(resolveReviewerLaunchPlan({
      reviewerRuntime: { executable: "configured-agent" },
      env: { RUNTIME_CORRECTOR_AGENT_EXECUTABLE: executable }, platform: "linux", projectRoot: "/workspace",
    }), /RUNTIME_CORRECTOR_AGENT_EXECUTABLE/);
  }
  await assert.rejects(resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: "./agent" }, env: {}, platform: "linux",
  }), /projectRoot/);
});

test("Windows accepts native and Node entry points but diagnoses explicit shell shims", async () => {
  assert.deepEqual(await resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: "C:\\Program Files\\nodejs\\node.exe", argsPrefix: ["C:\\Agent Files\\entry.js"] },
    env: {}, platform: "win32",
  }), {
    executable: "C:\\Program Files\\nodejs\\node.exe",
    argsPrefix: ["C:\\Agent Files\\entry.js"],
  });
  for (const executable of ["codeagent.cmd", "C:\\agent\\entry.BAT", "entry.ps1"]) {
    await assert.rejects(resolveReviewerLaunchPlan({ reviewerRuntime: { executable }, env: {}, platform: "win32" }), /shell.*native|native.*shell/i);
  }
  for (const executable of ["C:agent.exe", "\\agent.exe"]) {
    await assert.rejects(resolveReviewerLaunchPlan({ reviewerRuntime: { executable }, env: {}, platform: "win32", projectRoot: "C:\\workspace" }), /absolute|relative/);
  }
});

test("invocation keeps wrapper and CLI arguments literal without mutating either", async () => {
  assert.equal(typeof launcher.buildReviewerInvocation, "function");
  const plan = await resolveReviewerLaunchPlan({
    reviewerRuntime: { executable: process.execPath, argsPrefix: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"] },
    env: {},
  });
  const cliArgs = ["prompt with spaces", "--json-schema", '{"enum":["a,b","$HOME","`literal`"]}', "$(literal)"];
  const invocation = launcher.buildReviewerInvocation(plan, cliArgs);
  const result = spawnSync(invocation.executable, invocation.args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cliArgs);
  invocation.args.push("another");
  assert.equal(cliArgs.length, 4);
  assert.equal(plan.argsPrefix.length, 3);
});


test("CodeAgent launch plans defensively reject Claude and implicit continuation flags", () => {
  const plan = {
    executable: "codeagentcli",
    argsPrefix: [],
  };
  for (const forbidden of ["--session-id", "--session-id=new", "--resume", "--resume=session", "--continue", "--continue=true"]) {
    assert.throws(
      () => launcher.buildReviewerInvocation(plan, ["prompt", forbidden, "session"], codeAgentHost),
      /cannot contain --session-id, --resume, or --continue/u,
    );
  }
});

test("Windows launch errors retain their original code with actionable no-shell guidance", () => {
  assert.equal(typeof launcher.decorateReviewerLaunchError, "function");
  const original = Object.assign(new Error("spawn codeagent EINVAL"), { code: "EINVAL", path: "codeagent" });
  const decorated = launcher.decorateReviewerLaunchError(original, "win32");
  assert.equal(decorated, original);
  assert.equal(decorated.code, "EINVAL");
  assert.equal(decorated.path, "codeagent");
  assert.match(decorated.message, /spawn codeagent EINVAL/);
  assert.match(decorated.message, /without a shell/);
  assert.match(decorated.message, /node\.exe/);
  const posix = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.equal(launcher.decorateReviewerLaunchError(posix, "linux").message, "missing");
});
