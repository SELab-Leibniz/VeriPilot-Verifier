import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const JOURNAL_FORMAT = "runtime-corrector.file-journal.v3";
function canonical(value) {
  if (value && typeof value.toJSON === "function") return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export const journalDigest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
const hash = journalDigest;
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const reference = (value) => object(value) && Object.keys(value).length === 1 && own(value, "$journalBlob");
const jsonText = (value) => object(value) && own(value, "$journalJsonText") && (Object.keys(value).length === 1 || (Object.keys(value).length === 2 && own(value, "$journalJsonFormat")));
const literal = (value) => object(value) && Object.keys(value).length === 1 && own(value, "$journalLiteral");
const assign = (value, key, item) => Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true });
const sequenceName = (sequence) => `${String(sequence).padStart(12, "0")}.json`;

async function read(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function names(directory) {
  try { return await fs.readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, "r"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) return;
    throw error;
  }
  try { await handle.sync(); }
  catch (error) {
    // Windows can open a directory yet reject FlushFileBuffers on its handle.
    // File contents above are still fsynced; only directory fsync is optional.
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)
      && !(process.platform === "win32" && ["EPERM", "EACCES", "EISDIR"].includes(error.code))) throw error;
  }
  finally { await handle.close(); }
}

// Journal publication needs durability ordering, in addition to the existing
// projection helper's atomic rename. All callers serialize writers with the task lock.
export async function durableWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  try {
    // Retain the original atomic writer's Windows/antivirus rename retries.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * (2 ** attempt), 250)));
      }
    }
    await syncDirectory(path.dirname(file));
  }
  finally { await fs.rm(temporary, { force: true }); }
}
const write = (file, value) => durableWrite(file, `${JSON.stringify(value)}\n`);
function sealed(value) { return { ...value, checksum: hash(value) }; }
function checked(value) {
  if (!value) throw new Error("Missing committed journal data");
  const { checksum, ...body } = value;
  if (hash(body) !== checksum) throw new Error("Committed journal checksum mismatch");
  return value;
}

// Paths are arrays, so dictionary keys containing '/' or '__proto__' round-trip.
// Arrays use append, indexed changes and truncate; history is never replaced as a whole.
export function stateDelta(before, after, at = [], changes = []) {
  if (isDeepStrictEqual(before, after)) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.min(before.length, after.length); index++) stateDelta(before[index], after[index], [...at, index], changes);
    if (after.length < before.length) changes.push({ op: "truncate", path: at, length: after.length });
    if (after.length > before.length) changes.push({ op: "append", path: at, values: after.slice(before.length) });
  } else if (object(before) && object(after) && !reference(before) && !reference(after)) {
    for (const key of Object.keys(before)) if (!own(after, key)) changes.push({ op: "delete", path: [...at, key] });
    for (const key of Object.keys(after)) {
      if (!own(before, key)) changes.push({ op: "set", path: [...at, key], value: after[key] });
      else stateDelta(before[key], after[key], [...at, key], changes);
    }
  } else changes.push({ op: "set", path: at, value: after });
  return changes;
}
export function applyDelta(state, changes) {
  for (const change of changes) {
    if (!change.path.length && change.op === "set") { state = structuredClone(change.value); continue; }
    let target = state;
    const parentPath = ["append", "truncate"].includes(change.op) ? change.path : change.path.slice(0, -1);
    for (const key of parentPath) {
      if (!own(target, key)) throw new Error("Invalid journal delta path");
      target = target[key];
    }
    const key = change.path.at(-1);
    if (change.op === "set") assign(target, key, structuredClone(change.value));
    else if (change.op === "delete") delete target[key];
    else if (change.op === "append") { for (const value of change.values) target.push(structuredClone(value)); }
    else if (change.op === "truncate") target.length = change.length;
    else throw new Error("Unknown journal delta operation");
  }
  return state;
}

export class FileTransactionJournal {
  constructor(directory, { checkpointEvery = 128, checkpointBytes = 4 * 1024 * 1024, blobBytes = 4096, fault = async () => {} } = {}) {
    this.directory = directory;
    this.root = path.join(directory, "transactions");
    this.options = { checkpointEvery, checkpointBytes, blobBytes };
    this.fault = fault;
    this.metrics = { stateProjectionBytes: 0, commitBytes: 0, checkpointBytes: 0 };
  }
  file(...parts) { return path.join(this.root, ...parts); }
  async put(value) {
    const contents = JSON.stringify(value);
    const id = hash(contents);
    const file = this.file("blobs", `${id}.json`);
    try { await fs.access(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; await durableWrite(file, contents); }
    return { $journalBlob: id };
  }
  async encode(value, before, encodedBefore) {
    if (value && typeof value.toJSON === "function") return this.encode(value.toJSON());
    if (encodedBefore !== undefined && isDeepStrictEqual(value, before)) return structuredClone(encodedBefore);
    if (typeof value === "string" && Buffer.byteLength(value) >= this.options.blobBytes) return this.put(value);
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < value.length; i++) items.push(await this.encode(value[i], before?.[i], encodedBefore?.[i]));
      return items;
    }
    if (!object(value)) return value;
    const items = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      // Large results can recur in state, evaluation files and outbox payloads.
      const previous = before && own(before, key) ? before[key] : undefined;
      const previousEncoded = encodedBefore && own(encodedBefore, key) ? encodedBefore[key] : undefined;
      const packed = key === "result" && Buffer.byteLength(JSON.stringify(item)) >= this.options.blobBytes
        ? (previousEncoded !== undefined && isDeepStrictEqual(item, previous) ? previousEncoded : await this.put(await this.encode(item)))
        : await this.encode(item, previous, previousEncoded);
      assign(items, key, packed);
    }
    return own(value, "$journalBlob") || own(value, "$journalLiteral") || own(value, "$journalJsonText") ? { $journalLiteral: items } : items;
  }
  async decode(value, cache = new Map()) {
    if (reference(value)) {
      if (!/^[a-f0-9]{64}$/.test(value.$journalBlob)) throw new Error("Invalid journal blob reference");
      if (!cache.has(value.$journalBlob)) {
        const contents = await fs.readFile(this.file("blobs", `${value.$journalBlob}.json`), "utf8");
        if (hash(contents) !== value.$journalBlob) throw new Error("Journal blob checksum mismatch");
        cache.set(value.$journalBlob, JSON.parse(contents));
      }
      return this.decode(cache.get(value.$journalBlob), cache);
    }
    if (jsonText(value)) {
      const format = value.$journalJsonFormat ?? {};
      let text = JSON.stringify(await this.decode(value.$journalJsonText, cache), null, format.indent);
      if (format.lineEnding === "\r\n") text = text.replaceAll("\n", "\r\n");
      return (format.prefix ?? "") + text + (format.suffix ?? "");
    }
    if (Array.isArray(value)) { const items = []; for (const item of value) items.push(await this.decode(item, cache)); return items; }
    if (!object(value)) return value;
    const items = {};
    for (const [key, item] of Object.entries(literal(value) ? value.$journalLiteral : value)) assign(items, key, await this.decode(item, cache));
    return items;
  }
  async encodeEffects(effects) {
    const { files = {}, ...rest } = effects;
    const encoded = await this.encode(rest);
    if (rest.outputs) {
      encoded.outputs = [];
      for (const output of rest.outputs) encoded.outputs.push(await this.put(await this.encode(output)));
    }
    encoded.files = {};
    for (const [name, contents] of Object.entries(files)) {
      // Structured JSON shares state/outbox blobs, with its original formatting.
      // Unusual JSON layouts and non-JSON files retain their exact text.
      let parsed, format;
      try {
        parsed = JSON.parse(contents);
        const prefix = contents.match(/^\s*/u)[0], suffix = contents.match(/\s*$/u)[0];
        const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
        const inferred = contents.match(/\n([ \t]+)\S/u)?.[1];
        for (const indent of [null, 2, 4, "\t", inferred].filter(value => value !== undefined)) {
          let rendered = JSON.stringify(parsed, null, indent);
          if (lineEnding === "\r\n") rendered = rendered.replaceAll("\n", "\r\n");
          if (prefix + rendered + suffix === contents) { format = { indent, prefix, suffix, lineEnding }; break; }
        }
      } catch { /* plain text */ }
      assign(encoded.files, name, format ? { $journalJsonText: await this.encode(parsed), $journalJsonFormat: format } : await this.encode(contents));
    }
    return encoded;
  }
  async head() { return read(this.file("head.json")); }
  async initialize(state) {
    if (await this.head()) return;
    // A legacy pending manifest must be materialized by the caller before migration.
    const legacy = (await names(this.root)).filter(name => name.endsWith(".json") && name !== "head.json").sort();
    let previous = {};
    const legacyFileNames = new Set();
    for (let offset = 0; offset < legacy.length; offset += 128) {
      const records = [];
      for (const name of legacy.slice(offset, offset + 128)) {
        const commit = await read(this.file(name));
        const encoded = commit.files?.["task.json"] ? await this.encode(JSON.parse(commit.files["task.json"])) : previous;
        const files = { ...commit.files }; delete files["task.json"];
        for (const name of Object.keys(files)) legacyFileNames.add(name);
        records.push(sealed({ format: JOURNAL_FORMAT, legacy: true, commitId: commit.commitId ?? name.slice(0, -5),
          operationId: commit.assessmentId ?? commit.operationId ?? null,
          publication: state.assessments?.[commit.assessmentId] || state.decisionCommitId === name.slice(0, -5) ? "confirmed" : "unknown",
          changes: stateDelta(previous, encoded), effects: await this.encodeEffects({ files, events: commit.events ?? [], outputs: commit.outputs ?? [], result: commit.result }) }));
        previous = encoded;
      }
      await durableWrite(this.file("audit", `legacy-${String(offset).padStart(12, "0")}.jsonl`), records.map(item => JSON.stringify(item)).join("\n") + "\n");
    }
    const encoded = await this.encode(state);
    const baselineFiles = {};
    for (const name of legacyFileNames) {
      try { assign(baselineFiles, name, await fs.readFile(path.join(this.directory, name), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const projections = (await this.encodeEffects({ files: baselineFiles })).files;
    const checkpoint = sealed({ format: JOURNAL_FORMAT, sequence: 0, lastHash: null, state: encoded, projections });
    await write(this.file("audit", "baseline.json"), checkpoint);
    await write(this.file("checkpoints", sequenceName(0)), checkpoint);
    const head = { format: JOURNAL_FORMAT, sequence: 0, lastHash: null, checkpoint: 0, previousCheckpoint: null, logBytes: 0, stateHash: hash(state), legacyFiles: legacy };
    await write(this.file("head.json"), head);
    await this.fault("migration-published");
    // Audit segments and the baseline checkpoint are durable before any old full manifest is removed.
    for (const name of legacy) await fs.rm(this.file(name), { force: true });
    if (legacy.length) { head.legacyFiles = []; await write(this.file("head.json"), head); }
  }
  async readRecord(sequence) {
    const direct = await read(this.file("log", sequenceName(sequence)));
    if (direct) return checked(direct);
    const segments = await names(this.file("audit"));
    for (const name of segments) {
      const match = name.match(/^(\d+)-(\d+)\.jsonl$/);
      if (!match || sequence < Number(match[1]) || sequence > Number(match[2])) continue;
      const contents = await fs.readFile(this.file("audit", name), "utf8");
      // Only newline-terminated records count. A torn suffix is never a commit.
      for (const line of contents.slice(0, contents.lastIndexOf("\n") + 1).split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.sequence === sequence) return checked(record);
      }
    }
    throw new Error(`Missing committed journal record ${sequence}`);
  }
  async load() {
    // A lock-free reader can overlap two compactions. Retry against a fresh
    // head if its pinned checkpoint was reclaimed; audit records remain readable.
    for (let attempt = 0; ; attempt++) {
      const before = await this.head();
      try { return await this.loadHead(before); }
      catch (error) {
        const after = await this.head();
        if (attempt >= 3 || isDeepStrictEqual(before, after)) throw error;
      }
    }
  }
  async loadHead(head) {
    if (!head) return null;
    let checkpoint, checkpointError;
    const candidates = [...new Set([head.checkpoint, head.previousCheckpoint, 0])].filter(value => value !== null && value <= head.sequence);
    for (const sequence of candidates) {
      try {
        const file = this.file("checkpoints", sequenceName(sequence));
        const candidate = await read(file) ?? (sequence === 0 ? await read(this.file("audit", "baseline.json")) : null);
        checkpoint = checked(candidate); break;
      } catch (error) { checkpointError = error; }
    }
    if (!checkpoint) throw checkpointError ?? new Error("No valid journal checkpoint");
    let encoded = structuredClone(checkpoint.state), projections = structuredClone(checkpoint.projections ?? {}), lastHash = checkpoint.lastHash;
    for (let sequence = checkpoint.sequence + 1; sequence <= head.sequence; sequence++) {
      const commit = await this.readRecord(sequence);
      if (commit.baseVersion !== sequence - 1 || commit.newVersion !== sequence || commit.previousHash !== lastHash) throw new Error("Journal version/hash chain mismatch");
      encoded = applyDelta(encoded, commit.changes);
      projections = applyDelta(projections, commit.projectionChanges ?? []); lastHash = commit.checksum;
    }
    if (lastHash !== head.lastHash) throw new Error("Journal head checksum mismatch");
    const state = await this.decode(encoded);
    if (head.stateHash && hash(state) !== head.stateHash) throw new Error("Journal state checksum mismatch");
    return { state, encoded, projections, head };
  }
  async project(state) {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    await durableWrite(path.join(this.directory, "task.json"), contents);
    this.metrics.stateProjectionBytes += Buffer.byteLength(contents);
    await this.fault("projected");
  }
  async publish(loaded, state, effects = {}, { operationId = null, commitId = `state-${randomBytes(12).toString("hex")}` } = {}) {
    const encoded = await this.encode(state, loaded.state, loaded.encoded);
    const sequence = loaded.head.sequence + 1;
    const packedEffects = await this.encodeEffects({ ...effects, outputIds: (effects.outputs ?? []).map((_, index) => `${commitId}:${index}`) });
    const projections = structuredClone(loaded.projections ?? {});
    for (const [name, value] of Object.entries(packedEffects.files)) assign(projections, name, value);
    packedEffects.fileNames = Object.keys(packedEffects.files);
    delete packedEffects.files;
    const commit = sealed({ format: JOURNAL_FORMAT, sequence, commitId, operationId, baseVersion: sequence - 1, newVersion: sequence,
      previousHash: loaded.head.lastHash, changes: stateDelta(loaded.encoded, encoded),
      projectionChanges: stateDelta(loaded.projections ?? {}, projections), effects: packedEffects });
    const contents = `${JSON.stringify(commit)}\n`;
    await durableWrite(this.file("log", sequenceName(sequence)), contents);
    this.metrics.commitBytes += Buffer.byteLength(contents);
    await this.fault("commit-written");
    const head = { ...loaded.head, sequence, lastHash: commit.checksum, logBytes: loaded.head.logBytes + Buffer.byteLength(contents), stateHash: hash(state) };
    await write(this.file("head.json"), head);
    await this.fault("published");
    await this.project(state);
    return { state: structuredClone(state), encoded, projections, head, commit };
  }
  async compact(loaded) {
    const { head } = loaded;
    if (head.sequence - head.checkpoint < this.options.checkpointEvery && head.logBytes < this.options.checkpointBytes) return;
    // Archive exactly the published prefix before removing recovery records.
    const records = [];
    for (let sequence = head.checkpoint + 1; sequence <= head.sequence; sequence++) records.push(await this.readRecord(sequence));
    if (records.length) {
      await durableWrite(this.file("audit", `${head.checkpoint + 1}-${head.sequence}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
      await this.fault("audit-written");
    }
    const checkpoint = sealed({ format: JOURNAL_FORMAT, sequence: head.sequence, lastHash: head.lastHash, state: loaded.encoded, projections: loaded.projections });
    const contents = `${JSON.stringify(checkpoint)}\n`;
    await durableWrite(this.file("checkpoints", sequenceName(head.sequence)), contents);
    this.metrics.checkpointBytes += Buffer.byteLength(contents);
    await this.fault("checkpoint-written");
    const next = { ...head, checkpoint: head.sequence, previousCheckpoint: head.checkpoint, logBytes: 0 };
    await write(this.file("head.json"), next);
    await this.fault("checkpoint-published");
    await this.cleanup(next);
    loaded.head = next;
  }
  async cleanup(head = null) {
    head ??= await this.head();
    if (!head) return;
    if (head.legacyFiles?.length) {
      for (const name of head.legacyFiles) await fs.rm(this.file(name), { force: true });
      head.legacyFiles = [];
      await write(this.file("head.json"), head);
    }
    for (const name of await names(this.file("log"))) {
      if (/^\d+\.json$/.test(name) && Number(name.slice(0, -5)) <= head.checkpoint) await fs.rm(this.file("log", name), { force: true });
    }
    for (const name of await names(this.file("checkpoints"))) {
      if (/^\d+\.json$/.test(name) && ![head.checkpoint, head.previousCheckpoint].includes(Number(name.slice(0, -5)))) await fs.rm(this.file("checkpoints", name), { force: true });
    }
    // Unpublished tails/temp files carry no logical events or outputs.
    for (const name of await names(this.file("log"))) {
      if (name.endsWith(".tmp") || (/^\d+\.json$/.test(name) && Number(name.slice(0, -5)) > head.sequence)) await fs.rm(this.file("log", name), { force: true });
    }
    for (const directory of [this.root, this.file("checkpoints"), this.file("audit"), this.file("blobs")]) {
      for (const name of await names(directory)) if (/\.\d+\.[a-f0-9]{8}\.tmp$/.test(name)) await fs.rm(path.join(directory, name), { force: true });
    }
    await this.fault("logs-reclaimed");
  }
  async effects(sequence) {
    const record = await this.readRecord(sequence);
    const effects = await this.decode(record.effects);
    if (effects.fileNames) {
      effects.files = {};
      if (effects.fileNames.length) {
        const head = await this.head();
        const snapshot = await this.loadHead({ ...head, sequence, lastHash: record.checksum, stateHash: null });
        for (const name of effects.fileNames) assign(effects.files, name, await this.decode(snapshot.projections[name]));
      }
      delete effects.fileNames;
    }
    return effects;
  }
}
