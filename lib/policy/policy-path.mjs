import path from "node:path";

import { isPathInside } from "../path-utils.mjs";


export function resolvePolicyPath(policyRoot, configuredPath, label) {
  if (!configuredPath || typeof configuredPath !== "string") return null;
  if (path.isAbsolute(configuredPath)) {
    throw new Error(`${label} 必须使用相对于 .runtime-corrector 的路径。`);
  }
  const resolved = path.resolve(policyRoot, configuredPath);
  if (!isPathInside(policyRoot, resolved)) {
    throw new Error(`${label} 不能指向 .runtime-corrector 目录之外。`);
  }
  return resolved;
}
