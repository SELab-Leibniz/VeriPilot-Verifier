import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";

// A decision stages existing core writes without holding a lock across a model
// request. The task head later publishes their immutable manifest atomically.
export const decisionScope = new AsyncLocalStorage();
export const outsideDecision = (callback) => decisionScope.run(null, callback);
export function scopedDecision(file) {
  const scope = decisionScope.getStore();
  if (!scope) return null;
  const relative = path.relative(scope.directory, path.resolve(file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? scope : null;
}
export function stageWrite(file, contents) {
  const scope = scopedDecision(file);
  if (!scope) return false;
  scope.files[path.relative(scope.directory, path.resolve(file))] = String(contents);
  return true;
}
export function stageAppend(file, value) {
  const scope = scopedDecision(file);
  if (!scope) return false;
  scope.events.push({ file: path.relative(scope.directory, path.resolve(file)), value });
  return true;
}
export async function decisionRead(file) {
  const scope = scopedDecision(file);
  if (scope) {
    const value = scope.files[path.relative(scope.directory, path.resolve(file))];
    if (value !== undefined) return { found: true, value: JSON.parse(value) };
  }
  // Readers use the same committed manifest even if projection materialization
  // was interrupted. Never turn a half-published evaluation into current truth.
  const normalized = path.resolve(file);
  const match = normalized.match(/^(.*[/\\]\.runtime-correction[/\\]tasks[/\\][^/\\]+)[/\\](.+)$/u);
  if (!match || match[2] === "task.json" || match[2].startsWith("transactions" + path.sep)) return { found: false };
  try {
    const head = JSON.parse(await fs.readFile(path.join(match[1], "task.json"), "utf8"));
    if (!head.decisionCommitId || !head.projectionPending) return { found: false };
    const commit = JSON.parse(await fs.readFile(path.join(match[1], "transactions", `${head.decisionCommitId}.json`), "utf8"));
    const value = commit.files[match[2]];
    return value === undefined ? { found: false } : { found: true, value: JSON.parse(value) };
  } catch (error) { if (error.code === "ENOENT") return { found: false }; throw error; }
}
