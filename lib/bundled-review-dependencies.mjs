import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// This is a reader for the checksum-pinned npm TypeBox archive shipped in the
// repository, not an installer or a general archive extraction entry point.
export async function bundleReviewDependency({ sourceRoot, artifactRoot, name, version, integrity }) {
  if (name !== "typebox" || !/^\d+\.\d+\.\d+$/u.test(version) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity ?? "")) {
    throw new Error("Unsupported bundled review dependency or integrity.");
  }
  const archivePath = path.join(sourceRoot, "packaging/vendor", `${name}-${version}.tgz`);
  const archive = await fs.readFile(archivePath);
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== integrity) {
    throw new Error(`Bundled ${name} archive integrity does not match the review lockfile.`);
  }
  const tar = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 });
  const files = new Map();
  const field = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const checksum = parseInt(field(header, 148, 8).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    const size = parseInt(field(header, 124, 12).trim(), 8);
    const entry = field(header, 0, 100);
    // The pinned npm archive contains regular files only, with no long names,
    // links or extended headers. Refuse a changed archive format explicitly.
    if (checksum !== actual || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length
      || field(header, 156, 1) !== "0" || field(header, 345, 155)
      || !/^package\/(?:build\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|d\.mts)|package\.json|license|readme\.md)$/u.test(entry)) {
      throw new Error(`Unsupported bundled ${name} archive entry: ${entry}`);
    }
    const relative = entry.slice("package/".length);
    if (files.has(relative)) throw new Error(`Duplicate bundled ${name} archive entry: ${relative}`);
    files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const pkg = JSON.parse(files.get("package.json")?.toString("utf8") ?? "null");
  if (pkg?.name !== name || pkg.version !== version || pkg.license !== "MIT" || !files.has("license")
    || !files.has("build/index.mjs") || ["dependencies", "optionalDependencies", "peerDependencies"].some(key => Object.keys(pkg[key] ?? {}).length)) {
    throw new Error(`Bundled ${name} package identity or dependency closure is invalid.`);
  }
  const destination = path.join(artifactRoot, "vendor", name);
  for (const [relative, contents] of files) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return { version, integrity, path: `vendor/${name}`, license: pkg.license };
}
