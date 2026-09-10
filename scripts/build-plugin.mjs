#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin, resolvePluginHost } from "../lib/plugin-builder.mjs";


const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const explicitIndex = args.indexOf("--host");
let hosts;
if (args.includes("--all")) {
  hosts = ["claude", "codeagent"];
} else if (explicitIndex >= 0) {
  hosts = [args[explicitIndex + 1]];
} else {
  const target = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin-target.json"), "utf8"));
  hosts = [target.host];
}
for (const host of hosts) {
  resolvePluginHost(host);
  const artifact = await buildPlugin({ host, sourceRoot, outputRoot: path.join(sourceRoot, "dist") });
  process.stdout.write(`${artifact}\n`);
}
