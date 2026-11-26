#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildMAPackage, MA_PACKAGE_NAME } from "../lib/ma-package-builder.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const { values } = parseArgs({ options: { version: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("npm run build:ma [-- --version <x.y.z>]\nRequires the system tar executable (included with Windows).");
  else console.log(JSON.stringify(await buildMAPackage({ sourceRoot, version: values.version }), null, 2));
} catch (error) {
  console.error(`[${MA_PACKAGE_NAME}] ${error.message}`);
  process.exitCode = 1;
}
