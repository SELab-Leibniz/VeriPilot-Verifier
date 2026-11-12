import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "./plugin-builder.mjs";

const execute = promisify(execFile);
export const MA_PACKAGE_NAME = "runtime-corrector-ma";
// MA's gateway-alive lookup matches the market ID against `plugins list` IDs.
export const MA_PLUGIN_ID = "runtime-corrector";

function dedicated(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MA build output must be a dedicated child directory.");
  }
  return target;
}

async function assertRegularTree(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await assertRegularTree(file);
    else if (!entry.isFile()) throw new Error(`MA packages cannot contain links or special files: ${file}`);
  }
}

export async function buildMAPackage({ sourceRoot, outputRoot, version } = {}) {
  const source = await fs.realpath(path.resolve(sourceRoot));
  const sourcePackage = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  version ??= sourcePackage.version;
  // MA's fallback installed-directory scanner rejects multi-part prereleases.
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error("MA distribution version must be a simple x.y.z release.");
  }
  const output = path.resolve(outputRoot ?? path.join(source, "dist"));
  const relativeSource = path.relative(output, source);
  if (!relativeSource || (!relativeSource.startsWith(`..${path.sep}`) && relativeSource !== ".." && !path.isAbsolute(relativeSource))) {
    throw new Error("MA build output cannot contain the source checkout.");
  }
  await fs.mkdir(output, { recursive: true });
  const temporary = dedicated(output, await fs.mkdtemp(path.join(output, ".ma-build-")));
  try {
    const staging = path.join(temporary, MA_PACKAGE_NAME);
    const native = await buildPlugin({ host: "openclaw", sourceRoot: source, outputRoot: path.join(temporary, "native") });
    await fs.mkdir(path.join(staging, "payload"), { recursive: true });
    await fs.rename(native, path.join(staging, "payload", "runtime-corrector"));
    const template = path.join(source, "packaging", "hosts", "matrixassistant");
    const payload = path.join(staging, "payload", "runtime-corrector");
    await fs.copyFile(path.join(template, "native-entry.mjs"), path.join(payload, "ma-entry.mjs"));
    for (const name of ["package.json", "openclaw.plugin.json"]) {
      const file = path.join(payload, name);
      const document = JSON.parse(await fs.readFile(file, "utf8"));
      if (name === "package.json") document.openclaw.extensions = ["./ma-entry.mjs"];
      else document.main = "./ma-entry.mjs";
      await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    }
    const pkg = JSON.parse(await fs.readFile(path.join(template, "package.json"), "utf8"));
    if (pkg.name !== MA_PACKAGE_NAME || pkg.type !== "commonjs" || pkg.main !== "index.js") throw new Error("Invalid MA package template.");
    pkg.version = version;
    await fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    for (const name of ["index.js", "installer.mjs"]) await fs.copyFile(path.join(template, name), path.join(staging, name));
    await fs.copyFile(path.join(source, "docs", "ma-market.md"), path.join(staging, "README.md"));
    await assertRegularTree(staging);
    const filename = `${MA_PACKAGE_NAME}-${version}.tgz`;
    const stagedArchive = path.join(temporary, filename);
    // Windows ships bsdtar; USTAR also works with MA's two built-in extractors.
    // Archive directory contents, so no npm "package/" wrapper is introduced.
    await execute("tar", ["--format=ustar", "-czf", stagedArchive, "-C", staging, "."], { windowsHide: true });
    const { stdout } = await execute("tar", ["-tzf", stagedArchive], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const entries = stdout.trim().split(/\r?\n/u).map(name => name.replace(/^\.\//u, ""));
    for (const required of ["index.js", "installer.mjs", "package.json", "payload/runtime-corrector/openclaw.plugin.json",
      "payload/runtime-corrector/lib/openclaw/entry.mjs", "payload/runtime-corrector/.runtime-corrector-default/config.yaml"]) {
      if (!entries.includes(required)) throw new Error(`MA archive is missing ${required}`);
    }
    const sha256 = createHash("sha256").update(await fs.readFile(stagedArchive)).digest("hex");
    const directory = dedicated(output, path.join(output, MA_PACKAGE_NAME));
    let previousDirectory;
    try { previousDirectory = await fs.lstat(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previousDirectory) {
      if (!previousDirectory.isDirectory() || previousDirectory.isSymbolicLink()) throw new Error("Refusing to replace an unrelated MA build path.");
      const previous = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (previous.name !== MA_PACKAGE_NAME) throw new Error("Refusing to replace an unrelated MA build directory.");
    }
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(staging, directory);
    const archive = path.join(output, filename);
    await fs.rename(stagedArchive, archive);
    const registry = path.join(output, `${MA_PACKAGE_NAME}-${version}.registry.json`);
    const record = { plugins: { [MA_PLUGIN_ID]: {
      name: "Runtime Corrector", version, description: pkg.description,
      downloadUrl: pathToFileURL(archive).href, installPath: "~/.matrixassistant/plugins",
      sha256, mode: "client", pluginType: "user", restart: "gateway",
    } } };
    await fs.writeFile(registry, `${JSON.stringify(record, null, 2)}\n`);
    await fs.writeFile(`${archive}.sha256`, `${sha256}  ${filename}\n`);
    return { directory, archive, registry, sha256, version, pluginId: MA_PLUGIN_ID, packageName: MA_PACKAGE_NAME, entries: entries.length };
  } finally {
    await fs.rm(dedicated(output, temporary), { recursive: true, force: true });
  }
}
