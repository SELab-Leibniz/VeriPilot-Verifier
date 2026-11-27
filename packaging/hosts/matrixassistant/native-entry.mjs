import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "./lib/openclaw/entry.mjs";
import { directMarketUninstallService, reconcileNativeUninstall } from "./installer.mjs";
import { isMarketOwner, pathKey, readNativeOwner, sameNativeOwner } from "./native-install.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));

function monitorMarketUninstall(api, owner) {
  let timer, pending;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const check = () => {
    if (pending) return;
    pending = reconcileNativeUninstall(owner).then(done => {
      if (done) stop();
    }).catch(error => {
      api.logger?.warn?.(`[runtime-corrector] market uninstall: ${error.message}`);
    }).finally(() => { pending = undefined; });
  };
  api.registerService?.({
    apiVersion: 2,
    id: "runtime-corrector-market",
    start() {
      if (timer) return;
      timer = setInterval(check, 1500);
      timer.unref();
      check();
    },
    stop,
  });
}

// MA can restart before deferred teardown finishes, or after a process crash.
// Its installation marker is the source of truth for the market switch.
export default {
  ...plugin,
  register(api) {
    let marker, owner;
    try { owner = readNativeOwner(directory); }
    catch { return; }
    let marketDirectory = directory;
    if (owner && pathKey(owner.owner) !== pathKey(directory)) {
      const home = os.homedir();
      const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
      if (pathKey(directory) !== pathKey(path.join(stateDir, "extensions", plugin.id)) || !isMarketOwner(home, owner.owner)) return;
      monitorMarketUninstall(api, owner);
      try {
        if (!sameNativeOwner(owner, readNativeOwner(owner.owner))) return;
      } catch { return; }
      // OpenClaw copies the market directory. Only MA's original marker
      // reflects disable/uninstall and survives a full MA restart.
      marketDirectory = owner.owner;
    }
    try { marker = JSON.parse(readFileSync(path.join(marketDirectory, "install-complete.json"), "utf8").replace(/^\uFEFF/u, "")); }
    catch { /* A directly installed package may already be undergoing removal. */ }
    if (!owner) api.registerService?.(directMarketUninstallService(api, directory, marker?.version));
    if (marker?.enabled !== true || marker.status === "error") return;
    return plugin.register(api);
  },
};
