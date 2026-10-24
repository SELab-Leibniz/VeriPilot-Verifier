// Extra read-only checks for the first run's Windows checkout and host delivery.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { fixtureConfig } from "./fixture-config.mjs";
const execute = promisify(execFile), root = path.resolve(process.argv[2]);
assert.equal(path.dirname(root), path.join(process.cwd(), "experiments"));
assert(/^live-(?:todolist|kitchen)-/u.test(path.basename(root)));
const here = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(await fs.readFile(path.join(root, "report.json"), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const norm = bytes => bytes.toString("utf8").replaceAll("\r\n", "\n");
const model = report.model.slice(report.model.indexOf("/") + 1);
const kitchen = report.scenario === "kitchen";
const skillRoot = path.resolve("examples/openclaw-offline-kitchen/skills/build-offline-kitchen");
const expected = kitchen ? {
  "spec/requirements.md": await fs.readFile(path.join(skillRoot, "references/requirements.md")),
  "skills/build-offline-kitchen/SKILL.md": await fs.readFile(path.join(skillRoot, "SKILL.md")),
  "skills/build-offline-kitchen/references/requirements.md": await fs.readFile(path.join(skillRoot, "references/requirements.md")),
  "skills/build-offline-kitchen/scripts/verify_kitchen.py": await fs.readFile(path.join(skillRoot, "scripts/verify_kitchen.py")),
} : {
  "spec/requirements.md": await fs.readFile(path.join(here, "requirements.md")),
  "test_todo.py": await fs.readFile("examples/python-todolist-transactions/test_todo.py"),
  "acceptance/verify_todolist.py": await fs.readFile(path.join(here, "verify_todolist.py")),
  ".runtime-corrector/config.yaml": fixtureConfig(await fs.readFile(path.join(here, "config.yaml"), "utf8"),
    { modelId: model, scenario: "todolist", maxCorrections: report.maxCorrectionsOverride ?? null }),
  ".gitignore": Buffer.from(".runtime-correction/\n__pycache__/\n"),
};
if (kitchen) {
  expected[".runtime-corrector/config.yaml"] = fixtureConfig(await fs.readFile(path.join(here, "config.yaml"), "utf8"),
    { modelId: model, scenario: "kitchen", maxCorrections: report.maxCorrectionsOverride ?? null });
  expected[".gitignore"] = Buffer.from(".runtime-correction/\n__pycache__/\n");
}
const checks = {};
for (const [file, fixture] of Object.entries(expected)) {
  assert.equal(hash(fixture), report.protectedHashes[file], "Observer fixture changed since admission");
  const actual = await fs.readFile(path.join(report.projectRoot, file));
  const head = (await execute("git", ["-C", report.projectRoot, "show", `HEAD:${file}`], { encoding: "buffer" })).stdout;
  checks[file] = { rawFixtureSha256: hash(fixture), actualSha256: hash(actual),
    byteEqualToWorktreeAdmission: report.worktreeProtectedHashes?.[file] ? hash(actual) === report.worktreeProtectedHashes[file] : null,
    byteEqualToFixture: hash(fixture) === hash(actual), normalizedEqualToFixture: norm(actual) === norm(fixture),
    normalizedEqualToFrozenGitHead: norm(actual) === norm(head),
    actualCRLF: actual.toString("utf8").includes("\r\n") };
}
const eol = (await execute("git", ["-C", report.projectRoot, "ls-files", "--eol"], { encoding: "utf8" })).stdout;
const diff = (await execute("git", ["-C", report.projectRoot, "diff", "--name-status", "HEAD"], { encoding: "utf8" })).stdout;
const mainSessionFile = path.join(root, "host/host-state/agents/main/sessions", `${report.sessionId}.jsonl`);
const mainLines = (await fs.readFile(mainSessionFile, "utf8")).split(/\r?\n/u).filter(Boolean);
const nonAppPythonWrites = [];
for (let index = 0; index < mainLines.length; index++) {
  const row = JSON.parse(mainLines[index]);
  for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
    if (block.type !== "toolCall" || !["write", "edit"].includes(block.name)) continue;
    const target = block.arguments?.path ?? block.arguments?.file_path;
    if (!target || !target.endsWith(".py") || path.resolve(target) === path.join(report.projectRoot, report.appFile ?? "todo.py")) continue;
    nonAppPythonWrites.push({ at: row.timestamp, tool: block.name, toolCallId: block.id,
      target, relative: path.relative(report.projectRoot, target), mainSessionFile, jsonlLine: index + 1,
      presentAtFinalCheck: await fs.stat(target).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; }) });
  }
}
const runtime = JSON.parse(await fs.readFile(path.join(root, "runtime-final.json"), "utf8"));
const task = runtime.tasks.find(t => t.rootSessionId === report.sessionId || t.sessionIds?.includes(report.sessionId));
const truth = task ? JSON.parse(await fs.readFile(path.join(report.projectRoot, ".runtime-correction/tasks", task.taskId, "ground-truth/current.json"), "utf8")) : null;
const metricObjects = runtime.evaluations.flatMap(e => e.metricReport?.metrics?.flatMap(m => m.objects ?? []) ?? []);
const processConstraints = (truth?.claims ?? []).filter(c => c.category === "constraints" && c.verificationTarget === "PROCESS")
  .map(c => ({ claimId: c.claimId, text: c.text, metricBindings: metricObjects.filter(o => o.sourceId === c.claimId)
    .map(o => ({ objectId: o.objectId, judgement: o.judgement, reason: o.reason })) }));
const events = {}, streams = {}, notices = [], chat = [], lifecycle = [];
for await (const line of readline.createInterface({ input: createReadStream(path.join(root, "host/wire.jsonl")), crlfDelay: Infinity })) {
  if (!line) continue;
  const event = JSON.parse(line); events[event.event] = (events[event.event] ?? 0) + 1;
  if (event.payload?.stream) streams[event.payload.stream] = (streams[event.payload.stream] ?? 0) + 1;
  if (line.includes("STOP_VERIFICATION_INCOMPLETE") || line.includes("verificationFeedback"))
    notices.push({ at: event.at, event: event.event, stream: event.payload?.stream, dataKeys: Object.keys(event.payload?.data ?? {}) });
  if (event.event === "chat" && ["final", "error", "aborted"].includes(event.payload?.state)) {
    const blocks = event.payload.message?.content;
    const text = typeof blocks === "string" ? blocks : blocks?.filter(b => b.type === "text").map(b => b.text).join("\n");
    chat.push({ at: event.at, runId: event.payload.runId, sessionKey: event.payload.sessionKey,
      state: event.payload.state, usage: event.payload.message?.usage ?? null,
      errorMessage: event.payload.errorMessage, error: event.payload.error, text });
  }
  if (event.payload?.stream === "lifecycle") lifecycle.push({ at: event.at, runId: event.payload.runId, ...event.payload.data });
}
const result = { checkedAt: Date.now(), checks, gitEol: eol, gitProtectedDiff: diff,
  contractObservations: { nonAppPythonWrites, processConstraints,
    caveat: "Read-only independent observations; these do not rewrite the core's verdict. A clean final Git diff does not erase earlier tool writes." },
  normalizedFrozenInputsUnchanged: Object.values(checks).every(c => c.normalizedEqualToFixture && c.normalizedEqualToFrozenGitHead),
  rawCheckInterpretation: report.worktreeProtectedHashes
    ? "This run captured actual worktree byte hashes after checkout and before admission. Raw fixture-vs-checkout differences can reflect LF/CRLF; actual integrity is checked against worktreeProtectedHashes."
    : "The first harness compared fixture bytes before git checkout against CRLF checkout bytes. Raw false values remain in report.json. Postcheck verifies line-ending-normalized text against both the admitted fixtures and frozen Git HEAD; no strict per-file pre-admission worktree byte hashes were captured in this run.",
  wire: { events, streams, verificationNoticeEvents: notices, chatTerminals: chat, lifecycle },
  originalHostChecks: report.originalHostChecks };
await fs.writeFile(path.join(root, "postcheck.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ normalizedFrozenInputsUnchanged: result.normalizedFrozenInputsUnchanged,
  gitProtectedDiff: diff, wireEventCounts: events, noticeCount: notices.length, chatTerminalCount: chat.length, postcheck: path.join(root, "postcheck.json") }, null, 2));
