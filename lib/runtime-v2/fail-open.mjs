import { promises as fs } from "node:fs";
import path from "node:path";

import { OUTPUT_TREE_DIRECTORY } from "./paths.mjs";
import { safeId, sha256 } from "./utils.mjs";


export async function recordFailOpenWarning({ projectRoot, category, message }) {
  const warningId = sha256({ category, message }).slice(0, 24);
  const directory = path.join(projectRoot, OUTPUT_TREE_DIRECTORY, "runtime-v2-warnings");
  const filePath = path.join(directory, `${safeId(category)}-${warningId}.json`);
  try {
    await fs.mkdir(directory, { recursive: true });
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: "runtime-corrector.fail-open-warning.v2",
        warningId,
        category,
        message,
        firstSeenAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    return { shouldNotify: true, warningId, filePath };
  } catch (error) {
    if (error.code === "EEXIST") return { shouldNotify: false, warningId, filePath };
    return { shouldNotify: true, warningId, filePath: null, persistenceError: error };
  }
}
