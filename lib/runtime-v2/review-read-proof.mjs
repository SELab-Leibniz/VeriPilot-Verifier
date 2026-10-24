import { promises as fs, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { sha256 } from "./utils.mjs";

const within = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const selection = ref => typeof ref === "string" ? /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref) : null;
const covers = (ranges, start, end) => {
  let next = start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > next) break;
    next = Math.max(next, range.end + 1);
  }
  return next > end;
};

// Stream the hash and only the requested bytes: one large line/file must not
// become another unbounded in-memory copy just to authenticate a short read.
async function originalRange(file, start, limit, signal) {
  const hash = createHash("sha256"), parts = [];
  let line = 1, bytes = 0, tooLarge = false, terminalEmptyLine = false;
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(chunk);
    terminalEmptyLine = chunk.at(-1) === 10;
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline + 1;
      if (line >= start && (limit == null || line < start + limit)) {
        bytes += end - offset;
        if (bytes <= 64 * 1024) parts.push(chunk.subarray(offset, end)); else tooLarge = true;
      }
      if (newline >= 0) line++;
      offset = end;
    }
  }
  const end = Math.min(line, limit == null ? line : start + limit - 1);
  let body = tooLarge ? null : Buffer.concat(parts);
  if (body && end < line && body.at(-1) === 10) body = body.subarray(0, body.length - 1);
  const text = body?.toString("utf8");
  return { hash: hash.digest("hex"), lines: line, start, end, terminalEmptyLine,
    text: body && Buffer.from(text, "utf8").equals(body) && !body.includes(0) ? text : null };
}

/** Real read results, not tool arguments or citation text, establish disclosure. */
export async function createReviewReadProof({ projectRoot, requestDirectory, requestPath, prepared, request, signal }) {
  const root = path.resolve(projectRoot), privateRoot = path.resolve(requestDirectory);
  const files = new Map(), required = new Set(), observations = new Map(), pending = new Map(), visited = new Set();
  const publicReads = new Map();
  let unstable = false;
  let available = true;
  const add = (file, owner, mandatory, hash = null) => {
    const absolute = path.resolve(root, file);
    if (!within(privateRoot, absolute)) throw new Error("Required read proof points outside this request.");
    const prior = files.get(absolute);
    if (prior && prior.owner !== owner && prior.owner !== "NAVIGATION") throw new Error("Conflicting native proof owner.");
    files.set(absolute, { owner, hash: hash ?? prior?.hash ?? null });
    if (mandatory) required.add(absolute);
    return absolute;
  };
  async function metadata(file, owner, mandatory) {
    const absolute = add(file, owner, mandatory), stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 24 * 1024 || await fs.realpath(absolute) !== absolute) throw new Error("Invalid generated read-proof index.");
    const bytes = await fs.readFile(absolute); files.get(absolute).hash = sha256(bytes);
    return JSON.parse(bytes);
  }
  async function descriptor(value, owner, mandatory = false) {
    if (!value?.path) return;
    const key = `${value.path}\0${owner}\0${mandatory}`;
    if (visited.has(key)) return; visited.add(key);
    const node = await metadata(value.path, mandatory ? "BASIS" : "NAVIGATION", mandatory);
    for (const page of node.pages ?? []) await descriptor(page, owner, mandatory);
    for (const record of node.records ?? []) {
      if (typeof record.offset === "number" && typeof record.sha256 === "string") add(record.path, owner, mandatory, record.sha256);
      else if (record.source) await descriptor(record.source, owner, mandatory);
    }
  }
  async function mandatoryPointers(value) {
    if (!value || typeof value !== "object") return;
    if (value.path && value.required === true) { await descriptor(value, "BASIS", true); return; }
    for (const child of Object.values(value)) await mandatoryPointers(child);
  }
  try {
    await metadata(requestPath, "BASIS", true);
    if (prepared.groundTruthPath) await mandatoryPointers(await metadata(prepared.groundTruthPath, "BASIS", true));
    for (const key of ["skillGroundTruthPath", "skillSourcePath"]) if (prepared[key]) await metadata(prepared[key], "BASIS", true);
    await mandatoryPointers(prepared);
    if (prepared.transcript?.path) {
      const transcript = await metadata(prepared.transcript.path, "NAVIGATION", false);
      if (Array.isArray(transcript.entries)) files.get(path.resolve(root, prepared.transcript.path)).owner = "PROCESS";
      await descriptor(transcript.entryIndex, "PROCESS");
      await descriptor(transcript.toolIndex, "PROCESS");
    }
    if (prepared.reviewSources?.originalGroundTruth) await descriptor(prepared.reviewSources.originalGroundTruth, "BASIS");
  } catch { available = false; }
  const manifest = new Map((request.sourceManifest ?? []).map(file => [path.resolve(root, file.path ?? file.relativePath), file.sha256]));
  const keyOf = (file, args) => JSON.stringify([file, args?.offset ?? 1, args?.limit ?? null]);
  const complete = () => available && !unstable && required.size > 0 && [...required].every(file => {
    const value = observations.get(file), expected = files.get(file);
    // A terminating LF creates a zero-byte split('\n') element, not another
    // source line Claude must display. Its bytes remain in the full-file hash;
    // cited ranges still describe only the lines actually disclosed.
    return value && value.hash === expected.hash && covers(value.ranges, 1,
      Math.max(1, value.lines - (value.terminalEmptyLine ? 1 : 0)));
  });
  return {
    async observe(name, value) {
      const result = name === "read:result", args = result ? value?.args : value;
      if (String(result ? value?.toolName : name).toLowerCase() !== "read") return;
      const target = args?.path ?? args?.file_path;
      if (typeof target !== "string" || !target || target.includes("\0")) return;
      const file = path.resolve(root, target), key = keyOf(file, args);
      if (!within(root, file) || file.split(path.sep).some(part => /^(?:\.git|\.aws|\.ssh|\.env(?:\..*)?|auth-profiles\.json|openclaw\.json)$/iu.test(part))) return;
      if (!result) { pending.set(key, (pending.get(key) ?? 0) + 1); return; }
      if (!pending.get(key)) return;
      pending.set(key, pending.get(key) - 1);
      if (value.isError || value.result?.isError) return;
      if (await fs.realpath(file).catch(() => null) !== file) {
        publicReads.set(file, "missing"); unstable = true; return;
      }
      const content = value.result?.content;
      if (!Array.isArray(content) || content.length !== 1 || content[0].type !== "text") { unstable = true; return; }
      const text = content[0].text;
      if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) { unstable = true; return; }
      const start = args.offset ?? 1, requestedLimit = args.limit;
      if (!Number.isInteger(start) || start < 1 || requestedLimit != null && (!Number.isInteger(requestedLimit) || requestedLimit < 1)) { unstable = true; return; }
      const footer = /\n\n\[Showing lines ([1-9]\d*)-([1-9]\d*) of ([1-9]\d*)(?: \([^\]\n]+\))?\. Use offset=([1-9]\d*) to continue\.\]$/u.exec(text);
      const limit = footer ? Number(footer[2]) - start + 1 : requestedLimit;
      if (footer && (Number(footer[1]) !== start || Number(footer[4]) !== Number(footer[2]) + 1
        || limit < 1 || requestedLimit != null && limit > requestedLimit)) { unstable = true; return; }
      const original = await originalRange(file, start, limit, signal);
      const isPrivate = within(path.join(root, ".runtime-correction"), file);
      if (!isPrivate) {
        if (publicReads.has(file) && publicReads.get(file) !== original.hash) unstable = true;
        else publicReads.set(file, original.hash);
      }
      if (original.text == null || start > original.lines) { unstable = true; return; }
      // Claude's numbered Read display normalizes CRLF separators. This
      // comparison-only normalization never changes the original hash/ranges
      // or the durable source excerpt, and does not apply to native raw reads.
      let comparison = original.text;
      if (value.result?.details?.readDisplay === "CLAUDE_NUMBERED_LINES") {
        comparison = comparison.replace(/\r\n/gu, "\n");
        if (original.end < original.lines && comparison.endsWith("\r")) comparison = comparison.slice(0, -1);
      }
      const remainder = original.lines - original.end;
      const full = text === comparison || text === `${comparison}\n\n[${remainder} more lines in file. Use offset=${original.end + 1} to continue.]`;
      if (!(footer ? Number(footer[3]) === original.lines && text.slice(0, footer.index) === comparison : full)) { unstable = true; return; }
      const registered = files.get(file);
      if (isPrivate && !registered || registered?.hash && registered.hash !== original.hash || manifest.has(file) && manifest.get(file) !== original.hash) return;
      const owner = registered?.owner ?? (manifest.has(file) ? "SOURCE" : "ARTIFACT");
      if (owner === "NAVIGATION") return;
      const prior = observations.get(file);
      if (prior && prior.hash !== original.hash) { available = false; return; }
      observations.set(file, { ...original, owner, ranges: [...(prior?.ranges ?? []), { start, end: original.end }] });
    },
    get reviewEvidence() {
      const entries = [...publicReads].sort(([a], [b]) => a.localeCompare(b));
      return { files: entries.map(([file]) => file), fingerprints: Object.fromEntries(entries), unstable,
        missing: entries.filter(([, hash]) => hash === "missing").map(([file]) => file), digest: sha256(entries) };
    },
    citations(report, supplied = []) {
      const requestFile = path.resolve(requestPath);
      // The role request is mandatory navigation, never original business
      // evidence. Do not inherit old progress snapshots' rights to cite it.
      supplied = supplied.filter(cite => ![cite.path, cite.source, cite.snapshotPath]
        .some(file => typeof file === "string" && path.resolve(root, file) === requestFile));
      const output = new Map(), basisComplete = complete();
      for (const row of [...(report?.metricObjectJudgements ?? []), ...(report?.findings ?? []), ...(report?.fileAssessments ?? [])]) {
        const owner = row.objectId ?? row.deviationKey ?? row.path;
        for (const ref of [...(row.evidence ?? []), ...(row.actualEvidence ?? [])]) {
          const parsed = selection(ref); if (!parsed) continue;
          const start = Number(parsed[2]), end = Number(parsed[3] ?? parsed[2]);
          const known = supplied.find(cite => cite.usedBy?.includes(owner) && (cite.selection === ref
            || [cite.path, cite.snapshotPath].includes(path.resolve(root, parsed[1])) && cite.start === start && cite.end === end));
          const file = known?.path ?? path.resolve(root, parsed[1]), observed = observations.get(file);
          if (path.resolve(root, file) === requestFile) continue;
          if (!observed || !covers(observed.ranges, start, end) || known?.contentHash && known.contentHash !== observed.hash) continue;
          const value = known ? { ...known } : { selection: ref, path: file, snapshotPath: file, contentHash: observed.hash,
            start, end, frozen: within(privateRoot, file), usedBy: [owner] };
          const identity = `${value.selection}\0${owner}`;
          output.set(identity, { ...value, usedBy: [owner], readProof: { version: 1, owner: observed.owner, observed: true, basisComplete } });
        }
      }
      // Retain unproved citations so malformed/stale references still reach the
      // existing validator. Their mere existence must not become a read proof.
      return [...supplied.filter(cite => ![...output.values()].some(proven => proven.selection === cite.selection
        && proven.usedBy.some(id => cite.usedBy?.includes(id)))), ...output.values()];
    },
  };
}
