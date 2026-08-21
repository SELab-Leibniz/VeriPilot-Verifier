// Platform adapters declare the platform-specific conventions the
// deterministic kit-integration check needs: the kit module prefix, the
// module-name casing convention plus its irregular special cases, and the
// production source roots/extensions to scan. Adapters live under
// config/platforms/<name>.json and are selected by the project config key
// `implementationCorrection.platform` (default "harmonyos"). A null or
// unknown platform yields no adapter, and the caller skips the kit check.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const PLATFORMS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "config", "platforms",
);

export const DEFAULT_PLATFORM = "harmonyos";


export async function loadPlatformAdapter(platform = DEFAULT_PLATFORM) {
  if (!platform) return null;
  const name = String(platform).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) return null;
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(path.join(PLATFORMS_ROOT, `${name}.json`), "utf8"));
  } catch {
    // An unknown platform is not an error: the kit check simply does not
    // apply to it. Other implementation-review methods are unaffected.
    return null;
  }
  const kitCheck = raw.kitCheck ?? {};
  return Object.freeze({
    name: raw.name ?? name,
    kitCheck: Object.freeze({
      modulePrefix: kitCheck.modulePrefix ?? "",
      moduleSpecialCases: new Map(Object.entries(kitCheck.moduleSpecialCases ?? {})),
      sourceRoots: Object.freeze([...(kitCheck.sourceRoots ?? [])]),
      sourceExtensions: Object.freeze(
        (kitCheck.sourceExtensions ?? []).map((extension) => String(extension).toLowerCase()),
      ),
    }),
    // Host-environment discovery and read-only probe declarations. Keeping
    // these beside deviceCheck makes the adapter the single source of
    // platform-specific paths and commands.
    environmentCheck: raw.environmentCheck ? Object.freeze(raw.environmentCheck) : null,
    // Device-verification ladder declarations (probes, build gate, smoke
    // steps). Absent for platforms without device tooling — the ladder then
    // caps at the static assurance level (device-verify.mjs).
    deviceCheck: raw.deviceCheck ? Object.freeze(raw.deviceCheck) : null,
  });
}
