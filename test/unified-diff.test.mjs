import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createUnifiedDiff,
  serializeUnifiedDiffs,
  validateUnifiedDiffs,
} from "../lib/unified-diff.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-diff-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root, encoding: "utf8" });
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


test("the unified-diff core handles newline and multi-hunk edge cases as one collection", async (t) => {
  const cwd = await workspace(t);
  const cases = [
    {
      path: "plain/no-final-newline.txt",
      original: "before",
      proposed: "after",
    },
    {
      path: "plain/crlf.txt",
      original: "alpha\r\nbefore\r\nomega\r\n",
      proposed: "alpha\r\nafter\r\nomega\r\n",
    },
    {
      path: "plain/crlf-no-final-newline.txt",
      original: "alpha\r\nbefore",
      proposed: "alpha\r\nafter",
    },
    {
      path: "path with spaces/empty.txt",
      original: "",
      proposed: "created\n",
    },
    {
      path: "plain/trailing-blank-context.txt",
      original: "one\nbefore\n\n",
      proposed: "one\nafter\n\n",
    },
    {
      path: "plain/multiple-hunks.txt",
      original: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
      proposed: Array.from(
        { length: 20 },
        (_, index) => index === 0 ? "changed first" : index === 19 ? "changed last" : `line ${index + 1}`,
      ).join("\n") + "\n",
    },
  ];

  for (const example of cases) {
    await writeFile(cwd, example.path, example.original);
  }
  const diffs = cases.map((example) => createUnifiedDiff({
    relativePath: example.path,
    original: example.original,
    proposed: example.proposed,
  }));

  assert.ok(diffs.every(Boolean));
  assert.match(diffs.at(-1).unifiedDiff, /@@[\s\S]*@@[\s\S]*@@/);
  assert.ok(
    diffs[4].unifiedDiff.endsWith("\n "),
    "a blank context line must keep its unified-diff prefix",
  );

  const serialized = serializeUnifiedDiffs(diffs);
  assert.equal((serialized.match(/^diff --git /gm) ?? []).length, cases.length);
  assert.ok(serialized.endsWith("\n"));
  assert.ok(!serialized.endsWith("\n\n"));
  assert.equal(validateUnifiedDiffs({ cwd, diffs }).status, "passed");
  assert.equal(validateUnifiedDiffs({
    cwd,
    diffs,
    allowedPaths: cases.map((example) => example.path),
  }).status, "passed");

  const patchPath = await writeFile(cwd, "all-cases.diff", serialized);
  execFileSync("git", ["apply", patchPath], { cwd, encoding: "utf8" });
  for (const example of cases) {
    assert.equal(await fs.readFile(path.join(cwd, example.path), "utf8"), example.proposed);
  }
});


test("the unified-diff core rejects unsafe paths and malformed patch records", async (t) => {
  const cwd = await workspace(t);
  assert.throws(
    () => createUnifiedDiff({
      relativePath: "../outside.txt",
      original: "before\n",
      proposed: "after\n",
    }),
    /Unified Diff/,
  );
  assert.throws(
    () => serializeUnifiedDiffs([{
      unifiedDiff: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n",
    }]),
    /Unified Diff/,
  );
  assert.throws(
    () => validateUnifiedDiffs({
      cwd,
      diffs: [{
        unifiedDiff: [
          "diff --git a/file.txt b/file.txt",
          "--- a/file.txt",
          "+++ b/file.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
        ].join("\n"),
      }],
    }),
    /Unified Diff|git apply --check/,
  );
});


test("the unified-diff core returns no patch for identical content", () => {
  assert.equal(createUnifiedDiff({
    relativePath: "same.txt",
    original: "same\n",
    proposed: "same\n",
  }), null);
  assert.equal(serializeUnifiedDiffs([]), "");
});


test("patch validation is anchored to a nested policy root instead of a parent Git worktree", async (t) => {
  const parent = await workspace(t);
  const cwd = path.join(parent, "ignored", "nested-policy-root");
  const relativePath = "spec/complex-todolist/solution.md";
  const original = '"filters": { "status": "uncompleted" }\n';
  const proposed = '"filters": { "status": "all" }\n';
  await writeFile(cwd, relativePath, original);
  await writeFile(parent, ".gitignore", "ignored/\n");
  const diff = createUnifiedDiff({ relativePath, original, proposed });

  assert.equal(validateUnifiedDiffs({
    cwd,
    diffs: [diff],
    allowedPaths: [relativePath],
  }).status, "passed");
});
