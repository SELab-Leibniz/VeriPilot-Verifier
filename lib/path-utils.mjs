import path from "node:path";


export function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}


export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
