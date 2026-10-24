// Scripted transport evidence still performs the same original-byte reads and
// cite registration as a worker. It supplies no model or semantic oracle.
import { promises as fs } from "node:fs";
import path from "node:path";
import { registerCitation } from "../../lib/review-task/review-task.mjs";
import { sha256 } from "../../lib/runtime-v2/utils.mjs";

export async function observedTaskResult(options, { file, verdict = "PASS", reason = "The fixture's read witness supports its assigned obligation." }) {
  const reads = [], basis = [];
  for (const file of options.task.basisFiles) {
    const bytes = await fs.readFile(path.join(options.root, file));
    const end = bytes.toString("utf8").split("\n").length;
    reads.push({ path: file, start: 1, end });
    basis.push({ path: file, start: 1, end, sha256: sha256(bytes), rangeKind: "file" });
  }
  const bytes = await fs.readFile(path.join(options.root, file));
  const range = { start: 1, end: Math.min(2, bytes.toString("utf8").split("\n").length) };
  const registry = new Map(), ref = registerCitation({ registry, bytes, file, sha256: sha256(bytes), range });
  reads.push({ path: file, ...range });
  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.cp(options.root, path.join(options.outputDir, "frozen-source"), { recursive: true });
  await fs.writeFile(path.join(options.outputDir, "reads.json"), JSON.stringify(reads));
  await fs.writeFile(path.join(options.outputDir, "citations.json"), JSON.stringify([...registry.values()]));
  const result = { taskId: options.task.id, scope: options.task.scope, completed: true, verdict, reason,
    refs: [ref], citeIds: [ref.citeId], basis, attempts: 1, elapsedMs: 1, artifacts: options.outputDir,
    metrics: { turns: 1, toolCalls: reads.length, readBytes: bytes.length, repeatedLines: 0 } };
  if (options.task.reviewType === "production-implementation-coverage-reviewer" && verdict === "PASS") {
    // This is a scripted engine transport witness, not a semantic claim about
    // arbitrary fixture code. Real-model counterexamples are validated separately.
    result.productionTrace = { version: 1, entryPoint: "Scripted fixture entry", actualInput: "Assigned fixture input",
      producerToConsumer: "Scripted source witness for transport validation only", stateful: false,
      statelessReason: "This controlled transport does not assess application semantics.", stateTargets: [], targetRelations: [] };
  }
  await fs.writeFile(path.join(options.outputDir, "result.json"), JSON.stringify(result));
  return result;
}

export async function observedFileCitation({ file, basisFiles, usedBy, owner = "ARTIFACT" }) {
  if (!basisFiles.length) throw new Error("The fixture must declare its complete original basis.");
  for (const basis of basisFiles) await fs.readFile(basis);
  const bytes = await fs.readFile(file);
  const end = Math.min(2, bytes.toString("utf8").split("\n").length);
  return { path: file, snapshotPath: file, contentHash: sha256(bytes), selection: `${file}#L1-L${end}`,
    start: 1, end, usedBy, frozen: false,
    readProof: { version: 1, observed: true, basisComplete: true, owner } };
}
