import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testDependencyWarnings, testEnvironmentWarnings } from "../scripts/test.mjs";

test("test dependency diagnostics resolve from review-task and name the exact install command", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-test-dependencies-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = testDependencyWarnings(root);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /npm ci --prefix lib\/review-task --ignore-scripts/u);
  const dependency = path.join(root, "lib", "review-task", "node_modules", "typebox");
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "typebox", main: "index.cjs" }));
  await fs.writeFile(path.join(dependency, "index.cjs"), "module.exports = {};\n");
  assert.deepEqual(testDependencyWarnings(root), []);
});

test("test environment diagnostics name the OpenClaw host and locale inputs the suite depends on", () => {
  const [host, locale] = testEnvironmentWarnings({});
  assert.match(host, /--openclaw-host=/u);
  assert.match(locale, /LANG=en_US\.UTF-8/u);
  assert.deepEqual(testEnvironmentWarnings({ RC_OPENCLAW_HOST_ROOT: "x", LC_ALL: "en_US.UTF-8" }), []);
  assert.equal(testEnvironmentWarnings({ RC_OPENCLAW_HOST_ROOT: "x", LANG: "zh_CN.UTF-8" }).length, 0);
});
