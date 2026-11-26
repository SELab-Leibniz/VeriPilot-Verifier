import { readFileSync } from "node:fs";
import plugin from "./lib/openclaw/entry.mjs";

// MA can restart before deferred teardown finishes, or after a process crash.
// Its installation marker is the source of truth for the market switch.
export default {
  ...plugin,
  register(api) {
    let marker;
    try { marker = JSON.parse(readFileSync(new URL("./install-complete.json", import.meta.url), "utf8").replace(/^\uFEFF/u, "")); }
    catch { return; }
    if (marker.enabled !== true || marker.status === "error") return;
    return plugin.register(api);
  },
};
