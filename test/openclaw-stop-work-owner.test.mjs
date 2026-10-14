import test from "node:test";
import assert from "node:assert/strict";
import { registerStopWorkOwner } from "../lib/openclaw/stop-work-owner.mjs";

function fixture() {
  let service;
  const state = {}, api = { runtime: { version: "2026.10.3" }, registerService(value) { service = value; } };
  const owner = registerStopWorkOwner(api, state);
  const controller = new AbortController(), jobs = new Map();
  const scheduler = { version: 1, signal: controller.signal,
    schedule(params) { jobs.set(params.id, params); return { cancel() { jobs.delete(params.id); } }; } };
  return { api, state, owner, service, controller, scheduler, jobs };
}
test("legacy Stop retains its pinned host lifecycle without registering a newer service", () => {
  assert.equal(registerStopWorkOwner({ runtime: { version: "2026.7.1-2" }, registerService() { assert.fail(); } }, {}), undefined);
});
test("native Stop requires an active V2 service and runs only through the supplied scheduler", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.equal(f.service.apiVersion, 2);
  await assert.rejects(f.owner.execute({ id: "review", signal, run() { assert.fail(); } }), { code: "RC_STOP_OWNER_UNAVAILABLE" });
  f.service.start({ scheduler: f.scheduler });
  let called = false;
  const work = f.owner.execute({ id: "review", signal, run({ ownerSignal }) {
    called = true; assert.equal(ownerSignal, f.controller.signal); return "PASS";
  } });
  assert.equal(called, false);
  assert.equal(f.jobs.get("review").delayMs, 0);
  await f.jobs.get("review").run(); assert.equal(await work, "PASS");
  f.service.stop({ scheduler: f.scheduler });
  await assert.rejects(f.owner.execute({ id: "closed", signal, run() { assert.fail(); } }), { code: "RC_STOP_OWNER_UNAVAILABLE" });
});
test("service shutdown cancels pending Stop work without waiting for an undispatched callback", async () => {
  const f = fixture(); f.service.start({ scheduler: f.scheduler });
  const work = f.owner.execute({ id: "pending", signal: new AbortController().signal, run() { assert.fail(); } });
  f.controller.abort();
  await assert.rejects(work, { code: "RC_STOP_OWNER_CANCELLED" }); assert.equal(f.jobs.size, 0);
});
test("service reload preserves the shared owner and cannot close the replacement scheduler", () => {
  const f = fixture(); f.service.start({ scheduler: f.scheduler });
  assert.equal(registerStopWorkOwner(f.api, f.state), f.owner);
  const replacement = { ...f.scheduler, signal: new AbortController().signal };
  f.service.start({ scheduler: replacement }); f.service.stop({ scheduler: f.scheduler });
  assert.equal(f.owner.scheduler, replacement);
});
