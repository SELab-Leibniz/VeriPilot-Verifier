import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const baseConfig = () => ({ agents: { defaults: { model: "test/reviewer" }, list: [{ id: "main" }] },
  tools: { alsoAllow: ["browser"], deny: ["exec"] },
  plugins: { allow: ["existing"], entries: { existing: { enabled: true, config: { keep: true } } } },
  untouched: { value: "keep" } });

export async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for the committed MA lifecycle state.");
}

export async function marketFixture(t, artifact, config = baseConfig(), { legacyCache = false, defaultMarketPath = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc-ma-market-user-"));
  const { version } = JSON.parse(await fs.readFile(path.join(artifact, "package.json"), "utf8"));
  const home = path.join(root, "user home 中文");
  const pluginDir = defaultMarketPath ? path.join(home, ".matrixassistant", "plugins", "runtime-corrector")
    : path.join(home, ".openclaw", "extensions", `runtime-corrector-${version}`);
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  const cache = path.join(home, ".openclaw", legacyCache ? "runtime-corrector-ma" : "runtime-corrector");
  const statePath = path.join(cache, "state.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (legacyCache) await fs.mkdir(cache);
  await fs.cp(artifact, pluginDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const markerPath = path.join(pluginDir, "install-complete.json");
  const writeMarker = enabled => fs.writeFile(markerPath, JSON.stringify({ pluginId: "runtime-corrector", version, source: "system", enabled }));
  await writeMarker(false);
  const api = { logger: { info() {}, warn() {}, error() {} } };
  const init = { homeDir: home, pluginDir, pluginId: "runtime-corrector", version, isPackaged: true };
  const plugin = require(path.join(pluginDir, "index.js"));
  const readConfig = async () => JSON.parse(await fs.readFile(configPath, "utf8"));
  const readState = async () => JSON.parse(await fs.readFile(statePath, "utf8"));
  const disable = async () => {
    const result = await plugin.deactivate(api, init);
    assert.equal(result.error, undefined, result.error);
    await writeMarker(false);
    // The deferred installer commits inactive state before releasing its lock.
    // Wait for both so a following enable cannot race the still-finishing job.
    await waitFor(async () => !(await readState()).active
      && !await fs.stat(path.join(path.dirname(statePath), "installer.lock")).then(() => true, error => {
        if (error.code === "ENOENT") return false;
        throw error;
      }));
  };
  t.after(async () => {
    // Finish an observer before removing its fake home, so it cannot recreate
    // fixture state after the test's directory has been deleted.
    try { await disable(); } catch {}
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, home, pluginDir, configPath, statePath, markerPath, plugin, api, init, readConfig, readState, writeMarker, disable,
    payload: pluginDir };
}
