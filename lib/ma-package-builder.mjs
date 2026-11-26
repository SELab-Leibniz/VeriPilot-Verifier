import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "./plugin-builder.mjs";

const execute = promisify(execFile);
// MA's gateway-alive lookup matches the market ID against `plugins list` IDs.
export const MA_PLUGIN_ID = "runtime-corrector";
export const MA_PACKAGE_NAME = MA_PLUGIN_ID;

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
    // A direct MA install and a native copy use the same payload. Each host
    // selects its own entry point.
    await fs.rename(native, staging);
    const template = path.join(source, "packaging", "hosts", "matrixassistant");
    const nativeEntry = "./ma-entry.mjs";
    await fs.copyFile(path.join(template, "native-entry.mjs"), path.join(staging, nativeEntry));
    const manifestPath = path.join(staging, "openclaw.plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.main = nativeEntry;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const marketPackage = JSON.parse(await fs.readFile(path.join(template, "package.json"), "utf8"));
    if (marketPackage.name !== MA_PACKAGE_NAME || marketPackage.type !== "commonjs" || marketPackage.main !== "index.js") {
      throw new Error("Invalid MA package template.");
    }
    const packagePath = path.join(staging, "package.json");
    const nativePackage = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const pkg = { ...nativePackage, ...marketPackage, version,
      openclaw: { ...nativePackage.openclaw, extensions: [nativeEntry] } };
    await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    for (const name of ["index.js", "installer.mjs", "native-install.mjs"]) {
      await fs.copyFile(path.join(template, name), path.join(staging, name));
    }
    await fs.copyFile(path.join(source, "docs", "ma-market.md"), path.join(staging, "README.md"));
    await assertRegularTree(staging);
    const filename = `${MA_PACKAGE_NAME}-${version}.tgz`;
    const stagedArchive = path.join(temporary, filename);
    // Windows ships bsdtar; USTAR also works with MA's two built-in extractors.
    // List the archive roots directly so both MA extractors and strict
    // package inventory tools see canonical paths.
    const roots = (await fs.readdir(staging)).sort();
    await execute("tar", ["--format=ustar", "-czf", stagedArchive, "-C", staging, "--", ...roots], { windowsHide: true });
    const { stdout } = await execute("tar", ["-tzf", stagedArchive], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const entries = stdout.trim().split(/\r?\n/u).map(name => name.replace(/^\.\//u, ""));
    for (const required of ["index.js", "installer.mjs", "native-install.mjs", "ma-entry.mjs", "package.json", "openclaw.plugin.json",
      "lib/openclaw/entry.mjs", ".runtime-corrector-default/config.yaml"]) {
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
      if (previous.name !== MA_PACKAGE_NAME || previous.type !== "commonjs" || previous.main !== "index.js"
        || !Array.isArray(previous.openclaw?.extensions) || !previous.openclaw.extensions.includes(nativeEntry)) {
        throw new Error("Refusing to replace an unrelated MA build directory.");
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(staging, directory);
    const archive = path.join(output, filename);
    await fs.rename(stagedArchive, archive);
    const registry = path.join(output, `${MA_PACKAGE_NAME}-${version}.registry.json`);
    const record = { plugins: { [MA_PLUGIN_ID]: {
      name: "Runtime Corrector", version, description: pkg.description,
      downloadUrl: pathToFileURL(archive).href, installPath: "~/.openclaw/extensions",
      sha256, mode: "client", pluginType: "user", restart: "gateway",
    } } };
    await fs.writeFile(registry, `${JSON.stringify(record, null, 2)}\n`);
    await fs.writeFile(`${archive}.sha256`, `${sha256}  ${filename}\n`);
    return { directory, archive, registry, sha256, version, pluginId: MA_PLUGIN_ID, packageName: MA_PACKAGE_NAME, entries: entries.length };
  } finally {
    await fs.rm(dedicated(output, temporary), { recursive: true, force: true });
  }
}
