import { readFileSync } from "node:fs";

const groups = JSON.parse(readFileSync(new URL("../../config/openclaw-tool-contracts.json", import.meta.url), "utf8"));
export const TASK_TOOL_NAMES = Object.freeze(groups.task);
export const BASELINE_TOOL_NAMES = Object.freeze(groups.baseline);
export const OPENCLAW_TOOL_NAMES = Object.freeze([...new Set(Object.values(groups).flat())]);

export function configureOpenClawToolContract(manifest, sourceGroups = groups) {
  const configured = { ...manifest, contracts: { ...manifest.contracts,
    tools: [...new Set(["public", "task", "baseline"].flatMap(group => sourceGroups?.[group] ?? []))] } };
  assertOpenClawToolContract(configured, sourceGroups);
  return configured;
}

// A missing declaration rejects the whole factory on the supported host.
// Check the source contract before deleting/replacing an existing build.
export function assertOpenClawToolContract(manifest, sourceGroups = groups) {
  for (const group of ["public", "task", "baseline"]) {
    const names = sourceGroups?.[group];
    if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length
      || names.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(name))) {
      throw new Error(`Invalid OpenClaw tool contract group: ${group}`);
    }
  }
  const expected = [...new Set(["public", "task", "baseline"].flatMap(group => sourceGroups[group]))];
  const declared = manifest.contracts?.tools;
  if (!Array.isArray(declared) || new Set(declared).size !== declared.length
    || declared.length !== expected.length || expected.some(name => !declared.includes(name))) {
    throw new Error(`OpenClaw contracts.tools must match every registered tool: ${expected.join(", ")}`);
  }
}
