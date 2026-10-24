import assert from "node:assert/strict";

// Render before admission; existing experiment snapshots keep their defaults.
export function fixtureConfig(template, { modelId, scenario = "todolist", maxCorrections = null }) {
  assert(["todolist", "kitchen"].includes(scenario));
  assert(maxCorrections === null || Number.isSafeInteger(maxCorrections) && maxCorrections >= 0);
  let result = template.replaceAll("{{modelId}}", modelId)
    .replaceAll("todo-source", `${scenario === "kitchen" ? "kitchen" : "todo"}-source`)
    .replaceAll("todo.py", scenario === "kitchen" ? "kitchen.py" : "todo.py")
    .replaceAll("offline-todolist-python-test", `offline-${scenario}-python-test`);
  if (maxCorrections !== null) {
    assert(!result.includes("maxCorrectionsPerEpoch:"), "Do not silently replace a frozen correction budget.");
    const newline = result.includes("\r\n") ? "\r\n" : "\n";
    const anchor = `stopCorrection:${newline}  enabled: true`;
    assert(result.includes(anchor), "Stop configuration anchor is unavailable.");
    result = result.replace(anchor, `${anchor}${newline}  maxCorrectionsPerEpoch: ${maxCorrections}`);
  }
  return Buffer.from(result);
}
