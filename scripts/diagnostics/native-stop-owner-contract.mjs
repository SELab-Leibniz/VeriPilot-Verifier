// Diagnostic only: inspect the verified release's installed implementations.
// Production RC uses registerService + ctx.scheduler, without private exports.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { registerStopWorkOwner } from "../../lib/openclaw/stop-work-owner.mjs";
const [hostRoot, destination] = process.argv.slice(2);
if (!hostRoot || !destination) throw new Error("hostRoot new-output-directory required");
assert.equal(JSON.parse(await fs.readFile(path.join(hostRoot, "package.json"))).version, "2026.10.3");
await fs.mkdir(destination, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = path.join(destination, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(destination, "openclaw.json");
await fs.mkdir(process.env.OPENCLAW_STATE_DIR);
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ gateway: { mode: "local" }, agents: { defaults: { workspace: destination } } }));
const dist = path.join(hostRoot, "dist"), entries = await fs.readdir(dist);
async function load(prefix) {
  const file = entries.find(name => name.startsWith(prefix) && name.endsWith(".mjs"));
  if (!file) throw new Error(`Missing verified diagnostic implementation: ${prefix}`);
  return import(pathToFileURL(path.join(dist, file)));
}
const gate = await load("gateway-work-admission-"), queue = await load("command-queue-"), sessions = await load("session-lifecycle-admission-");
const { t: GatewayScheduler } = await load("gateway-scheduler-"), { t: createPluginServiceScheduler } = await load("service-scheduler-");
const scheduler = new GatewayScheduler(), serviceScope = createPluginServiceScheduler(scheduler, run => run()).scheduler;
let service;
const owner = registerStopWorkOwner({ runtime: { version: "2026.10.3" }, registerService(value) { service = value; } }, {});
service.start({ scheduler: serviceScope });
const result = { hostVersion: "2026.10.3", modelCalls: 0, businessCodeWritten: false, productionUsesPrivateExports: false };
const parent = gate.k("rc-stop-contract-terminal");
let baseline, owned;
await parent.run(() => {
  baseline = new Promise(resolve => setImmediate(async () => {
    const value = { globalClosed: gate.f(), subordinateClosed: gate.d() };
    try { await queue.i("rc-stop-contract-baseline", async () => { value.executed = true; }); }
    catch (error) { value.errorName = error.name; }
    resolve(value);
  }));
  owned = owner.execute({ id: "rc-stop-contract", signal: new AbortController().signal, run: async () => {
    const value = { globalClosed: gate.f(), subordinateClosed: gate.d() };
    await queue.i("rc-stop-contract-owned", async () => { value.executed = true; });
    const lease = await (sessions.beginSessionWorkAdmission ?? sessions.n)({ scope: path.join(destination, "sessions.json"), identities: ["rc-contract-session"],
      signal: new AbortController().signal, assertAllowed: async () => {} });
    value.sessionAdmissionAcquired = lease.isActive(); lease.release(); return value;
  } });
});
parent.release();
const keepAlive = setTimeout(() => {}, 10000);
try { result.baseline = await baseline; result.serviceOwned = await owned; }
finally { clearTimeout(keepAlive); serviceScope.beginClose(); await serviceScope.stop(); scheduler.beginClose(); await scheduler.stop(); }
assert.equal(result.baseline.globalClosed, false); assert.equal(result.baseline.subordinateClosed, true);
assert.equal(result.baseline.errorName, "GatewayDrainingError");
assert.equal(result.serviceOwned.subordinateClosed, false); assert.equal(result.serviceOwned.executed, true);
assert.equal(result.serviceOwned.sessionAdmissionAcquired, true); result.status = "PASS";
await fs.writeFile(path.join(destination, "result.json"), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result) + "\n");
