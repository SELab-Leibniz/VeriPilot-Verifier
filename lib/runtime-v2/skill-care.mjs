// A private, bounded view over already captured evidence. Never copies or walks
// the business repository. Notes aid navigation; they are never review proof.
import path from "node:path";
import { atomicWriteJson, readJson, sha256 } from "./utils.mjs";
import { taskDirectory, withTaskResourceLock } from "./task-store.mjs";
import { outsideDecision } from "./decision-scope.mjs";
import { processToolEvidence } from "./transcript.mjs";

const integer = (value, fallback, max) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("SKILL_CARE_INVALID_PAGE");
  return value;
};

export function isSkillCareRequest(role, request) {
  return role === "skill-reviewer" || role === "ground-truth-extractor" && Boolean(request.skill);
}

export async function createSkillCare({ projectRoot, taskId, request, evidence, active = () => {} }) {
  evidence = structuredClone(evidence);
  const source = evidence?.skillSource;
  if (!source?.files) throw new Error("SKILL_CARE_SOURCE_UNAVAILABLE");
  const skillId = request.watcher?.skillId ?? request.skill?.skillId;
  if (!skillId) throw new Error("SKILL_CARE_ID_UNAVAILABLE");
  const constraints = evidence?.skillGroundTruth?.constraints ?? [];
  const entries = evidence?.snapshot?.entries ?? [], cursor = sha256(entries), callsByIndex = new Map();
  for (const call of processToolEvidence(evidence?.snapshot)) {
    for (const index of new Set([call.invocationIndex, call.resultIndex].filter(Number.isSafeInteger))) {
      if (!callsByIndex.has(index)) callsByIndex.set(index, []);
      callsByIndex.get(index).push({ callId: call.toolUseId, status: call.status,
        invocationId: `execution/${call.invocationIndex}`,
        ...(call.resultIndex === undefined ? {} : { resultId: `execution/${call.resultIndex}` }),
        windowFrom: call.invocationIndex, windowThrough: entries.length - 1 });
    }
  }
  const navigation = (index, compact = false) => {
    const value = { navigationOnly: true, recordIndex: index, calls: [], callsTruncated: false,
      ...(compact ? {} : { processCursor: cursor, capturedThrough: entries.length - 1, executionCount: entries.length,
        notice: 'callId is an actual invocation identity; execution/N is a document ID. Read every relevant original page; navigation grants no proof.' }) };
    for (const call of callsByIndex.get(index) ?? []) {
      value.calls.push(call);
      if (Buffer.byteLength(JSON.stringify(value)) > 2048) { value.calls.pop(); value.callsTruncated = true; break; }
    }
    return value;
  };
  const files = [...source.files].sort((a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md") || a.path.localeCompare(b.path));
  const documents = new Map(files.map(file => [`skill/${file.path}`, {
    id: `skill/${file.path}`, origin: path.join(source.root, file.path), sha256: file.sha256,
    content: file.content,
  }]));
  for (const [index, entry] of (evidence?.snapshot?.entries ?? []).entries()) {
    const id = `execution/${index}`;
    documents.set(id, { id, origin: entry.uuid ?? entry.message?.id ?? id,
      content: JSON.stringify(entry) });
  }
  for (const constraint of constraints) {
    const id = `constraint/${constraint.constraintId}`;
    documents.set(id, { id, origin: constraint.sourceRef ?? null, content: JSON.stringify(constraint) });
  }
  documents.set("overlay/task", { id: "overlay/task", origin: null,
    content: JSON.stringify(evidence?.skillGroundTruth?.taskOverlays ?? []) });
  const revision = sha256({ root: source.root, skill: source.digest, constraints,
    complete: !source.truncated, overlays: evidence?.skillGroundTruth?.taskOverlays ?? [],
    truth: evidence?.groundTruth ?? null, transcript: evidence?.snapshot?.digest ?? evidence?.snapshot?.entries ?? null });
  // Hash identity instead of lossy safeId: different qualified names cannot
  // overwrite one another. Keep notebook storage outside any source directory.
  const notebook = path.join(taskDirectory(projectRoot, taskId), "skill-care", sha256(skillId), "notes.json");
  const guard = () => { if (active() === false) throw new Error("SKILL_CARE_CLOSED"); };
  const result = value => { guard(); return value; };
  const load = async () => { guard(); const value = await readJson(notebook, { notes: [] }); guard(); return value; };
  const page = (items, args) => {
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 12, 40);
    if (!limit) throw new Error("SKILL_CARE_INVALID_PAGE");
    return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null, total: items.length };
  };
  const namespaceCounts = Object.fromEntries(['skill/', 'execution/', 'constraint/', 'overlay/']
    .map(prefix => [prefix, [...documents.keys()].filter(id => id.startsWith(prefix)).length]));
  const inventory = args => {
    if (args.prefix && !['skill/', 'execution/', 'constraint/'].includes(args.prefix)) throw new Error('SKILL_CARE_INVALID_PREFIX');
    const docs = [...documents.values()].filter(doc => !args.prefix || doc.id.startsWith(args.prefix));
    const { nextOffset: _next, ...range } = page(docs, args), offset = args.offset ?? 0;
    const value = { items: [], total: range.total, totalScope: args.prefix ?? 'all', nextOffset: null,
      navigationOnly: true, namespaceCounts, processCursor: cursor, capturedThrough: entries.length - 1,
      notice: 'calls disclose actual callId values; execution/N identifies an original document. Follow nextOffset; navigation grants no read or condition proof.' };
    for (const doc of range.items) {
      const index = doc.id.startsWith('execution/') ? Number(doc.id.slice(10)) : null;
      const nav = index === null ? null : navigation(index, true);
      const item = { id: doc.id, sha256: doc.sha256 ?? sha256(doc.content), bytes: Buffer.byteLength(doc.content),
        lines: doc.content.split('\n').length,
        ...(Buffer.byteLength(JSON.stringify(doc.origin)) <= 1024 ? { origin: doc.origin } : { originTruncated: true }),
        ...(index === null ? {} : { recordIndex: index, ...(nav.calls.length || nav.callsTruncated ? { navigation: nav } : {}) }) };
      value.items.push(item); value.nextOffset = offset + value.items.length < docs.length ? offset + value.items.length : null;
      if (Buffer.byteLength(JSON.stringify(value)) > 8192) {
        value.items.pop(); value.nextOffset = offset + value.items.length;
        if (!value.items.length) throw new Error('SKILL_CARE_NAVIGATION_ITEM_TOO_LARGE: Read the original known ID directly; inventory grants no evidence.');
        break;
      }
    }
    return value;
  };
  async function execute(args) {
    guard();
    switch (args.action) {
      case "resume": {
        const saved = await load();
        return result({ skillId, revision, sourceDigest: source.digest, sourceComplete: !source.truncated,
          constraints: page(constraints.map(item => ({ id: `constraint/${item.constraintId}`, modality: item.modality, kind: item.kind })), args),
          notes: saved.notes.map(note => ({ key: note.key, current: note.revision === revision })),
          notice: "Notes are untrusted navigation hints. Re-read original evidence before every verdict." });
      }
      case "notes": return result(page((await load()).notes.map(note => ({ ...note, current: note.revision === revision })), args));
      case "inventory": return result(inventory(args));
      case "search": {
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 256) throw new Error("SKILL_CARE_INVALID_QUERY");
        const query = args.query.toLowerCase(), matches = [];
        const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 12, 40);
        if (!limit) throw new Error("SKILL_CARE_INVALID_PAGE");
        let skipped = 0;
        if (args.prefix && !["skill/", "execution/", "constraint/"].includes(args.prefix)) throw new Error("SKILL_CARE_INVALID_PREFIX");
        search: for (const doc of documents.values()) {
          if (args.prefix && !doc.id.startsWith(args.prefix)) continue;
          for (const [index, line] of doc.content.split("\n").entries()) {
            const found = line.toLowerCase().indexOf(query);
            if (found < 0) continue;
            if (skipped++ < offset) continue;
            const start = Math.max(0, found - 100);
            matches.push({ id: doc.id, line: index + 1, excerpt: line.slice(start, start + 400),
              excerptOnly: start > 0 || start + 400 < line.length });
            if (matches.length > limit) break search;
          }
        }
        return result({ items: matches.slice(0, limit), nextOffset: matches.length > limit ? offset + limit : null });
      }
      case "read": {
        const doc = documents.get(args.id);
        if (!doc) {
          const prefix = ['skill/', 'execution/', 'constraint/'].find(prefix => typeof args.id === 'string' && args.id.startsWith(prefix));
          throw new Error('SKILL_CARE_SOURCE_NOT_FOUND: ' + JSON.stringify({ field: 'id', requestedId: String(args.id).slice(0, 128),
            namespaceCounts, navigationOnly: true, recoverWith: { action: 'inventory', ...(prefix ? { prefix } : {}), offset: 0 },
            notice: 'Follow inventory nextOffset; total spans only totalScope. Never guess execution IDs or use them as afterCallId.' }));
        }
        // Character paging preserves a single enormous original transcript
        // entry without dumping it into context or silently cutting its tail.
        const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 4000, 16000);
        if (!limit) throw new Error("SKILL_CARE_INVALID_PAGE");
        const value = { id: doc.id, ...(Buffer.byteLength(JSON.stringify(doc.origin)) <= 1024 ? { origin: doc.origin } : { originTruncated: true }),
          sha256: doc.sha256 ?? sha256(doc.content), offset,
          content: doc.content.slice(offset, offset + limit),
          nextOffset: offset + limit < doc.content.length ? offset + limit : null,
          ...(doc.id.startsWith('execution/') ? { navigation: navigation(Number(doc.id.slice(10))) } : {}) };
        if (Buffer.byteLength(JSON.stringify({ ...value, content: undefined })) > 8192)
          throw new Error('SKILL_CARE_NAVIGATION_ITEM_TOO_LARGE: Original document identity exceeds the metadata boundary.');
        return result(value);
      }
      case "note": {
        if (typeof args.key !== "string" || !/^[a-zA-Z0-9_.:-]{1,96}$/u.test(args.key)
          || typeof args.text !== "string" || args.text.length > 1200 || !args.text.trim()
          || !Array.isArray(args.refs) || args.refs.length > 8 || args.refs.some(ref => !documents.has(ref)))
          throw new Error("SKILL_CARE_INVALID_NOTE");
        return withTaskResourceLock({ projectRoot, taskId, resource: `skill-care-${sha256(skillId)}`, reclaimDeadOwner: true }, async () => {
          const saved = await load();
          const notes = saved.notes.filter(note => note.key !== args.key);
          if (notes.length >= 32) throw new Error("SKILL_CARE_NOTE_BUDGET");
          notes.push({ key: args.key, text: args.text, refs: args.refs, revision,
            sources: args.refs.map(id => { const doc = documents.get(id);
              return { id, origin: doc.origin, sha256: doc.sha256 ?? sha256(doc.content) }; }) });
          guard();
          await outsideDecision(() => atomicWriteJson(notebook, { schemaVersion: 1, skillId, notes }));
          return result({ key: args.key, saved: true, revision });
        });
      }
      default: throw new Error("SKILL_CARE_INVALID_ACTION");
    }
  }
  const checkpoint = async phase => {
    const saved = await load();
    await outsideDecision(() => atomicWriteJson(path.join(path.dirname(notebook), "checkpoint.json"), {
      revision, phase, skillId, constraintIds: constraints.map(item => item.constraintId), noteKeys: saved.notes.map(note => note.key),
    }));
    guard();
  };
  return { execute, revision, checkpoint };
}

export const SKILL_CARE_PARAMETERS = {
  type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["resume", "inventory", "search", "read", "note", "notes"] },
    query: { type: "string", maxLength: 256 }, prefix: { type: "string", enum: ["skill/", "execution/", "constraint/"] },
    id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 },
    key: { type: "string", maxLength: 96 }, text: { type: "string", maxLength: 1200 },
    refs: { type: "array", maxItems: 8, items: { type: "string" } },
  },
};
