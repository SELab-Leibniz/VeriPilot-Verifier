#!/usr/bin/env node

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";


const DELIVERY_SCHEMA = "veripilot.delivery_manifest.v2";
const REQUIRED_CAPABILITIES = [
  "protocol-v2-conformance-r1",
  "semantic-input-v1",
];
const DEFAULT_SOURCE_ROOT = "delivery/planning-projection";
const ARTIFACTS = [
  { role: "sr", name: "SR.md", schema_version: "veripilot.sr.markdown.v1" },
  { role: "pilot-plan", name: "PilotPlan.md", schema_version: "veripilot.pilot_plan.markdown.v1" },
  { role: "relations", name: "relations.json", schema_version: "planning.relations.v1" },
  {
    role: "granularity-choice",
    name: "granularity-choice.json",
    schema_version: "planning.granularity_choice.v1",
  },
];


function parseArguments(argv) {
  const options = {
    workspaceRoot: null,
    sourceRoot: DEFAULT_SOURCE_ROOT,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace-root") {
      options.workspaceRoot = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--source-root") {
      options.sourceRoot = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--check") {
      options.check = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.workspaceRoot) throw new Error("--workspace-root is required");
  if (!options.sourceRoot) throw new Error("--source-root cannot be empty");
  return options;
}


function normalizeProtocolPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`protocol path must be workspace-relative: ${value}`);
  }
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`protocol path contains an invalid segment: ${value}`);
  }
  return normalized;
}


function ensureInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`path escapes workspace root: ${relativePath}`);
}


function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("canonical JSON rejects lone UTF-16 surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("canonical JSON rejects lone UTF-16 surrogates");
    }
  }
}


function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("canonical JSON accepts plain JSON values only");
  }
  const keys = Object.keys(value).sort();
  for (const key of keys) assertUnicodeScalarString(key);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}


function sha256Bytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}


async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}


function manifestHash(manifest) {
  const value = JSON.parse(JSON.stringify(manifest));
  delete value.manifest_hash;
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}


async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}


async function buildManifest({ workspaceRoot, sourceRoot, publishedAt }) {
  const normalizedSourceRoot = normalizeProtocolPath(sourceRoot);
  const workspaceFile = ensureInside(workspaceRoot, "workspace.json");
  const workspace = await readJson(workspaceFile);
  if (workspace.schema_version !== "veripilot.workspace.v2") {
    throw new Error(`unsupported workspace schema: ${workspace.schema_version ?? "missing"}`);
  }
  if (!workspace.request_id || !workspace.workspace_id) {
    throw new Error("workspace.json is missing request_id or workspace_id");
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!(workspace.required_capabilities ?? []).includes(capability)) {
      throw new Error(`workspace does not negotiate required capability: ${capability}`);
    }
  }

  const artifacts = [];
  for (const definition of ARTIFACTS) {
    const artifactPath = normalizeProtocolPath(`${normalizedSourceRoot}/${definition.name}`);
    const filePath = ensureInside(workspaceRoot, artifactPath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Planning projection artifact is not a file: ${artifactPath}`);
    artifacts.push({
      role: definition.role,
      path: artifactPath,
      schema_version: definition.schema_version,
      sha256: await sha256File(filePath),
    });
  }

  const manifest = {
    schema_version: DELIVERY_SCHEMA,
    schema_revision: 1,
    request_id: workspace.request_id,
    workspace_id: workspace.workspace_id,
    scope: "planning-projection",
    status: "verified",
    producer: {
      kind: "orchestrator",
      component_id: "guarded-delivery",
      version: "3.1.0",
    },
    source_outputs: [],
    artifacts,
    producer_capabilities: REQUIRED_CAPABILITIES,
    required_capabilities: REQUIRED_CAPABILITIES,
    published_at: publishedAt,
    manifest_hash: null,
  };
  manifest.manifest_hash = manifestHash(manifest);
  return manifest;
}


async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const sourceRoot = normalizeProtocolPath(options.sourceRoot);
  const manifestPath = ensureInside(workspaceRoot, `${sourceRoot}/manifest.json`);

  if (options.check) {
    const existing = await readJson(manifestPath);
    const expected = await buildManifest({
      workspaceRoot,
      sourceRoot,
      publishedAt: existing.published_at,
    });
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      throw new Error("Planning projection manifest is stale or invalid");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: "verified",
      manifest: normalizeProtocolPath(`${sourceRoot}/manifest.json`),
      manifest_hash: existing.manifest_hash,
    })}\n`);
    return;
  }

  const manifest = await buildManifest({
    workspaceRoot,
    sourceRoot,
    publishedAt: new Date().toISOString(),
  });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporaryPath, manifestPath);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.rm(manifestPath, { force: true });
    await fs.rename(temporaryPath, manifestPath);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "verified",
    manifest: normalizeProtocolPath(`${sourceRoot}/manifest.json`),
    manifest_hash: manifest.manifest_hash,
  })}\n`);
}


main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
