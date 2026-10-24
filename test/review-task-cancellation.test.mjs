import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureFiles, runReviewTask } from "../lib/review-task/review-task.mjs";

async function fixture(t) {
  const scratch = fileURLToPath(new URL("../.runtime-correction/review-task-cancellation-tests/", import.meta.url));
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, "run-"));
  assert.equal(path.dirname(directory), path.resolve(scratch));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "basis.md"), "The original condition must remain intact.\n");
  await fs.writeFile(path.join(root, "app.py"), "acknowledge()\n");
  const task = { id: "cancelled-scope", requirement: "Check the complete original condition.", basisFiles: ["basis.md"], targetFiles: ["app.py"] };
  return { root, directory, task };
}

test("pre-cancelled review stops before source capture, output creation or model access", async t => {
  const f = await fixture(t), controller = new AbortController();
  const reason = Object.assign(new Error("Caller cancelled this review."), { code: "REVIEW_COLLECTION_CANCELLED" });
  controller.abort(reason);
  let modelAccess = 0;
  const modelRuntime = new Proxy({}, { get() { modelAccess++; throw new Error("A cancelled review must not access a model."); } });
  const outputDir = path.join(f.directory, "review");
  await assert.rejects(runReviewTask({ task: f.task, root: f.root, outputDir, modelRuntime,
    model: { id: "scripted", provider: "scripted", contextWindow: 204800, maxTokens: 8192 }, signal: controller.signal }), error => error === reason);
  await assert.rejects(captureFiles(path.join(f.directory, "nonexistent-source"), { signal: controller.signal }), error => error === reason);
  assert.equal(modelAccess, 0);
  await assert.rejects(fs.stat(outputDir), { code: "ENOENT" });
});

test("source-scan and frozen-copy cancellation stop further preprocessing before any model access", async t => {
  for (const phase of ["scan", "copy"]) await t.test(phase, async t => {
    const f = await fixture(t), controller = new AbortController();
    const reason = Object.assign(new Error(`Cancelled during ${phase}.`), { code: "REVIEW_COLLECTION_CANCELLED" });
    const baseline = await captureFiles(f.root);
    assert.deepEqual(await captureFiles(f.root, { signal: controller.signal }), baseline, "An active optional signal preserves default capture bytes.");
    const originalRead = fs.readFile, reads = new Map();
    let abortedAtRead = false, modelAccess = 0;
    fs.readFile = async function(file, ...args) {
      const bytes = await originalRead.call(this, file, ...args);
      const absolute = path.resolve(String(file));
      if (path.dirname(absolute) === f.root) {
        const count = (reads.get(absolute) ?? 0) + 1; reads.set(absolute, count);
        if (count === (phase === "scan" ? 1 : 2)) { abortedAtRead = true; controller.abort(reason); }
      }
      return bytes;
    };
    t.after(() => { fs.readFile = originalRead; });
    const modelRuntime = new Proxy({}, { get() { modelAccess++; throw new Error("Cancellation must precede model use."); } });
    const outputDir = path.join(f.directory, "review");
    await assert.rejects(runReviewTask({ task: f.task, root: f.root, outputDir, modelRuntime,
      model: { id: "scripted", provider: "scripted", contextWindow: 204800, maxTokens: 8192 }, signal: controller.signal }), error => error === reason);
    fs.readFile = originalRead;
    assert.equal(abortedAtRead, true);
    assert.equal(modelAccess, 0);
    assert.equal([...reads.values()].reduce((sum, count) => sum + count, 0), phase === "scan" ? 1 : baseline.size + 1);
    await assert.rejects(fs.stat(path.join(outputDir, "decision.json")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(outputDir, "sessions")), { code: "ENOENT" });
  });
});
