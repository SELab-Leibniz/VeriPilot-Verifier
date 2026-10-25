import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateJsonSchema } from "../json-schema-validator.mjs";
import { parseSimpleYaml } from "../simple-yaml.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const queues = new Map();
const identityFields = ["agentId", "sessionKey", "sessionId"];
const settingsSchema = {
  type: "object", required: ["version"], additionalProperties: false,
  properties: {
    version: { const: 1 },
    sessions: { type: "object", additionalProperties: {
      type: "object", additionalProperties: false,
      required: ["namespace", ...identityFields, "enabled"],
      properties: {
        namespace: { type: "string", pattern: "^[a-f0-9]{64}$" },
        agentId: { type: "string", minLength: 1 },
        sessionKey: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        enabled: { type: "boolean" },
        label: { type: "string" },
      },
    } },
  },
};

function keyFor(namespace, identity) {
  return `s_${digest([namespace, ...identityFields.map(field => identity[field])])}`;
}

function target({ projectRoot, namespace, identity, defaultEnabled = true }) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
    || typeof namespace !== "string" || !namespace || namespace.includes("\0")
    || !identityFields.every(field => typeof identity?.[field] === "string" && identity[field] && !identity[field].includes("\0"))
    || typeof defaultEnabled !== "boolean") throw new Error("RC_SESSION_SETTINGS_IDENTITY_INVALID");
  const namespaceHash = digest(namespace);
  return { path: path.join(projectRoot, ".runtime-corrector", "sessions.local.yaml"),
    key: keyFor(namespaceHash, identity), namespace: namespaceHash,
    identity: Object.fromEntries(identityFields.map(field => [field, identity[field]])), defaultEnabled };
}

async function load(file) {
  let contents;
  try { contents = await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { contents: null, document: { version: 1 } }; throw error; }
  const document = parseSimpleYaml(contents, { source: file });
  const issue = validateJsonSchema(document, settingsSchema)[0];
  if (issue) throw new Error(`${file}${issue.pointer}: ${issue.message}`);
  for (const [key, record] of Object.entries(document.sessions ?? {})) {
    if (key !== keyFor(record.namespace, record)) throw new Error(`${file}: RC_SESSION_SETTINGS_KEY_MISMATCH (${key})`);
  }
  return { contents, document };
}

const result = (selection, document) => ({
  path: selection.path, key: selection.key,
  registered: Object.hasOwn(document.sessions ?? {}, selection.key),
  enabled: document.sessions?.[selection.key]?.enabled ?? selection.defaultEnabled,
});

export async function readSessionSetting(options) {
  const selection = target(options);
  return result(selection, (await load(selection.path)).document);
}

async function withFileLock(file, callback) {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`, started = Date.now();
    let handle;
    while (!handle) {
      try { handle = await fs.open(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - started >= 5000) throw new Error(`RC_SESSION_SETTINGS_BUSY: ${file}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await callback(); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); }
  });
  queues.set(file, next);
  try { return await next; }
  finally { if (queues.get(file) === next) queues.delete(file); }
}

// Replace only the target boolean, retaining hand-written labels and comments.
function updateContents(contents, selection, record, registered) {
  const newline = contents?.includes("\r\n") ? "\r\n" : "\n";
  const lines = (contents ?? "version: 1\n").split(/\r?\n/);
  if (registered) {
    const start = lines.findIndex(line => new RegExp(`^  ${selection.key}\\s*:`).test(line));
    for (let index = start + 1; start >= 0 && index < lines.length; index += 1) {
      if (/^ {0,2}\S/u.test(lines[index]) && !lines[index].trimStart().startsWith("#")) break;
      if (/^    enabled\s*:/u.test(lines[index])) {
        lines[index] = lines[index].replace(/(?:true|false)\s*$/u, String(record.enabled));
        return lines.join(newline);
      }
    }
    throw new Error("RC_SESSION_SETTINGS_RECORD_INVALID");
  }
  const rendered = [`  ${selection.key}:`,
    ...["namespace", ...identityFields, "label", "enabled"].filter(field => record[field] !== undefined)
      .map(field => `    ${field}: ${JSON.stringify(record[field])}`)];
  const start = lines.findIndex(line => /^sessions\s*:\s*$/u.test(line));
  if (start < 0) {
    if (lines.at(-1) === "") lines.pop();
    lines.push("sessions:", ...rendered, "");
  } else {
    let end = start + 1;
    while (end < lines.length && (!/^\S/u.test(lines[end]) || lines[end].startsWith("#"))) end += 1;
    lines.splice(end, 0, ...rendered);
  }
  return lines.join(newline);
}

async function save(file, contents, previousContents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    // Editors do not share this lock. Refuse an observed competing edit.
    let latest = null;
    try { latest = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (latest !== previousContents) throw new Error(`RC_SESSION_SETTINGS_CONFLICT: ${file}`);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function writeSetting(options, onlyIfAbsent) {
  const selection = target(options);
  if (!onlyIfAbsent && typeof options.enabled !== "boolean") throw new Error("RC_SESSION_SETTINGS_ENABLED_INVALID");
  if (options.label !== undefined && typeof options.label !== "string") throw new Error("RC_SESSION_SETTINGS_LABEL_INVALID");
  return withFileLock(selection.path, async () => {
    const loaded = await load(selection.path), current = result(selection, loaded.document);
    if (current.registered && (onlyIfAbsent || current.enabled === options.enabled)) return current;
    const record = { namespace: selection.namespace, ...selection.identity,
      ...(options.label === undefined ? {} : { label: options.label }), enabled: onlyIfAbsent ? selection.defaultEnabled : options.enabled };
    const contents = updateContents(loaded.contents, selection, record, current.registered);
    // Validate the exact bytes being published as well as the input document.
    const document = parseSimpleYaml(contents, { source: selection.path });
    const issue = validateJsonSchema(document, settingsSchema)[0];
    if (issue) throw new Error(`${selection.path}${issue.pointer}: ${issue.message}`);
    await save(selection.path, contents, loaded.contents);
    return result(selection, document);
  });
}

export const ensureSessionSetting = options => writeSetting(options, true);
export const setSessionSetting = options => writeSetting(options, false);
