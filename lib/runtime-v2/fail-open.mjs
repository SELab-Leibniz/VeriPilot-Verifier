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


/**
 * Consecutive-failure counter for the OUTER Stop hook (a crash before any
 * terminal decision could be produced). The Stop gate may fail closed while
 * retries remain, but a persistent fault in the plugin itself must never trap
 * a session — so this ceiling exists, and if the counter cannot be persisted
 * (exactly the case where local state is what is broken) the caller releases
 * rather than blocks: the failure mode must degrade toward the fail-open
 * covenant, never away from it.
 */
export const MAX_OUTER_STOP_FAILURES = 2;

export async function countOuterStopFailure(projectRoot) {
  const filePath = path.join(projectRoot, OUTPUT_TREE_DIRECTORY, "runtime-v2-warnings", "outer-stop-failures.json");
  try {
    let count = 0;
    try {
      count = JSON.parse(await fs.readFile(filePath, "utf8")).consecutiveFailures ?? 0;
    } catch {
      // No counter yet (or unreadable): this is the first failure we can see.
    }
    const consecutiveFailures = count + 1;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify({ consecutiveFailures, updatedAt: new Date().toISOString() })}\n`);
    return { consecutiveFailures, released: consecutiveFailures > MAX_OUTER_STOP_FAILURES, persisted: true };
  } catch {
    // Local state is unwritable: blocking here could never be undone by a
    // later attempt, so release with disclosure instead.
    return { consecutiveFailures: null, released: true, persisted: false };
  }
}

export async function clearOuterStopFailures(projectRoot) {
  const filePath = path.join(projectRoot, OUTPUT_TREE_DIRECTORY, "runtime-v2-warnings", "outer-stop-failures.json");
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Best-effort: a stale counter only costs retries, never correctness.
  }
}
