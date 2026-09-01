import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withTaskResourceLock } from "../lib/runtime-v2/task-store.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-store-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


function lockPaths(root, taskId = "claim-task", resource = "onboarding") {
  const lockPath = path.join(root, ".runtime-correction", "locks", `${taskId}-${resource}.lock`);
  return { lockPath, claimDirectory: `${lockPath}.claims` };
}


test("a live earlier generation claim keeps a later waiter out", async (t) => {
  const root = await workspace(t);
  const { claimDirectory } = lockPaths(root);
  await fs.mkdir(claimDirectory, { recursive: true });
  await fs.writeFile(path.join(claimDirectory, "earlier.json"), JSON.stringify({
    token: "earlier",
    pid: process.pid,
    createdAtMs: Date.now() - 1_000,
  }), "utf8");
  let entered = false;
  await assert.rejects(withTaskResourceLock({
    projectRoot: root,
    taskId: "claim-task",
    resource: "onboarding",
    timeoutMs: 80,
    staleMs: 60_000,
    reclaimDeadOwner: true,
  }, async () => {
    entered = true;
  }), /Timed out waiting for Runtime Corrector state lock/);
  assert.equal(entered, false);
  assert.deepEqual(await fs.readdir(claimDirectory), ["earlier.json"], "the waiter releases only its own claim");
});


test("an old malformed claim is removed after the short publication grace", async (t) => {
  const root = await workspace(t);
  const { claimDirectory } = lockPaths(root, "malformed-task");
  const malformedPath = path.join(claimDirectory, "malformed.json");
  await fs.mkdir(claimDirectory, { recursive: true });
  await fs.writeFile(malformedPath, "{", "utf8");
  await fs.utimes(malformedPath, new Date(0), new Date(0));
  let entered = false;
  await withTaskResourceLock({
    projectRoot: root,
    taskId: "malformed-task",
    resource: "onboarding",
    timeoutMs: 500,
    staleMs: 31 * 60 * 1_000,
    reclaimDeadOwner: true,
  }, async () => {
    entered = true;
  });
  assert.equal(entered, true);
  await assert.rejects(fs.access(malformedPath), /ENOENT/);
});


test("two dead-owner reclaimers never overlap their callbacks", async (t) => {
  const root = await workspace(t);
  const { lockPath } = lockPaths(root, "dead-owner-race");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  }), "utf8");
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const contender = () => withTaskResourceLock({
    projectRoot: root,
    taskId: "dead-owner-race",
    resource: "onboarding",
    timeoutMs: 1_000,
    staleMs: 60_000,
    reclaimDeadOwner: true,
  }, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
  });
  await Promise.all([contender(), contender()]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});
