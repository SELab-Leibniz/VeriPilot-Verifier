import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_KEYS = ["CLAUDE_PLUGIN_ROOT", "CODEAGENT3_PLUGIN_ROOT"];


async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}


async function sessionStartCommand() {
  const declaration = JSON.parse(
    await fs.readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  );
  return declaration.hooks.SessionStart[0].hooks[0].command;
}


function shellInvocation(command) {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}


async function runCommand(command, { cwd, env, input, invocation = shellInvocation(command) }) {
  return new Promise((resolve, reject) => {
    const processEnv = { ...process.env };
    for (const key of ROOT_KEYS) delete processEnv[key];
    Object.assign(processEnv, env);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: processEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}


async function supportedShellInvocations(command) {
  if (process.platform !== "win32") {
    const candidates = [
      { name: "posix-sh", executable: "/bin/sh", args: ["-c", command] },
      { name: "bash", executable: "/bin/bash", args: ["-c", command] },
    ];
    const available = [];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate.executable);
        available.push(candidate);
      } catch {
        // A shell absent from this operating system is covered by another CI matrix member.
      }
    }
    return available;
  }

  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [
    {
      name: "cmd",
      executable: process.env.ComSpec || path.join(windowsRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", command],
    },
    {
      name: "powershell",
      executable: path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    },
    {
      name: "git-bash",
      executable: path.join(programFiles, "Git", "bin", "bash.exe"),
      args: ["-lc", command],
    },
  ];
  const available = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate.executable);
      available.push(candidate);
    } catch {
      // Optional shell installation; the native cmd candidate is always expected on Windows.
    }
  }
  return available;
}


function sessionStartInput(cwd, suffix) {
  return {
    session_id: `bootstrap-${suffix}`,
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  };
}


test("the raw declared command runs with only CODEAGENT3_PLUGIN_ROOT", async (t) => {
  const cwd = await temporaryDirectory(t);
  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT },
    input: sessionStartInput(cwd, "codeagent3"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});


test("the fixed bootstrap runs through every supported shell installed on this OS", async (t) => {
  const cwd = await temporaryDirectory(t);
  const command = await sessionStartCommand();
  const invocations = await supportedShellInvocations(command);
  assert.ok(invocations.length >= 1, "the operating system must expose at least one supported shell");

  for (const invocation of invocations) {
    const completed = await runCommand(command, {
      cwd,
      env: { CODEAGENT3_PLUGIN_ROOT: PLUGIN_ROOT },
      input: sessionStartInput(cwd, `shell-${invocation.name}`),
      invocation,
    });
    assert.equal(completed.code, 0, `${invocation.name}: ${completed.stderr}`);
    assert.equal(completed.stdout, "", invocation.name);
    assert.equal(completed.stderr, "", invocation.name);
  }
});


test("the raw declared command accepts canonical-equivalent dual roots", async (t) => {
  const cwd = await temporaryDirectory(t);
  const linkedRoot = path.join(cwd, "plugin root link");
  await fs.symlink(PLUGIN_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: linkedRoot,
    },
    input: sessionStartInput(cwd, "equivalent"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});


test("the raw declared command rejects conflicting dual roots before loading an entry", async (t) => {
  const cwd = await temporaryDirectory(t);
  const otherRoot = await temporaryDirectory(t);

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CODEAGENT3_PLUGIN_ROOT: otherRoot,
    },
    input: sessionStartInput(cwd, "conflict"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_CONFLICT/u);
  await assert.rejects(fs.access(path.join(cwd, ".runtime-correction")));
});


test("the raw declared command rejects a missing root without stdout", async (t) => {
  const cwd = await temporaryDirectory(t);
  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: {},
    input: sessionStartInput(cwd, "missing"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_MISSING/u);
});


test("the raw declared command keeps a CodeAgent3 root with spaces and shell characters as data", async (t) => {
  const cwd = await temporaryDirectory(t);
  const linkedRoot = path.join(cwd, "插件 root & (safe)");
  await fs.symlink(PLUGIN_ROOT, linkedRoot, process.platform === "win32" ? "junction" : "dir");

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CODEAGENT3_PLUGIN_ROOT: linkedRoot },
    input: sessionStartInput(cwd, "special-path"),
  });

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "");
  assert.equal(completed.stderr, "");
});


test("the raw declared command rejects a wrong-identity root before executing its entry", async (t) => {
  const cwd = await temporaryDirectory(t);
  const fakeRoot = await temporaryDirectory(t);
  const marker = path.join(cwd, "wrong-identity-executed.txt");
  await fs.mkdir(path.join(fakeRoot, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(fakeRoot, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(fakeRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "another-plugin" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(fakeRoot, "scripts", "runtime-event.mjs"),
    `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "executed");\n`,
    "utf8",
  );

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CODEAGENT3_PLUGIN_ROOT: fakeRoot },
    input: sessionStartInput(cwd, "wrong-identity"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_IDENTITY_MISMATCH/u);
  await assert.rejects(fs.access(marker));
});


test("the raw declared command rejects an entry symlink that escapes the canonical root", async (t) => {
  const cwd = await temporaryDirectory(t);
  const fakeRoot = await temporaryDirectory(t);
  const external = path.join(cwd, "external-entry.mjs");
  const marker = path.join(cwd, "escaped-entry-executed.txt");
  await fs.mkdir(path.join(fakeRoot, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(fakeRoot, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(fakeRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "runtime-corrector" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    external,
    `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "executed");\n`,
    "utf8",
  );
  try {
    await fs.symlink(external, path.join(fakeRoot, "scripts", "runtime-event.mjs"), "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`file symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const completed = await runCommand(await sessionStartCommand(), {
    cwd,
    env: { CLAUDE_PLUGIN_ROOT: fakeRoot },
    input: sessionStartInput(cwd, "entry-escape"),
  });

  assert.notEqual(completed.code, 0);
  assert.equal(completed.stdout, "");
  assert.match(completed.stderr, /PLUGIN_ROOT_ENTRY_ESCAPE/u);
  await assert.rejects(fs.access(marker));
});
