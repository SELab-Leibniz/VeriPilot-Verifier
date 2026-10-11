import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteJson, readJson, sha256 } from "../runtime-v2/utils.mjs";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { outsideDecision } from "../runtime-v2/decision-scope.mjs";
import { currentReviewerProgress } from "./internal-context.mjs";

const states = new Set(["PENDING", "IN_PROGRESS", "COMPLETED"]);
const judgements = new Set(["PASS", "DEVIATION", "UNVERIFIED", "BASIS_PENDING", "EXTERNAL_BLOCKED", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "CHECKER_ERROR"]);
const blocked = /(?:^|\/)(?:\.git|\.aws|\.ssh|\.env(?:\.[^/]*)?|auth-profiles\.json|openclaw\.json|[^/]*(?:credentials|secret|api[-_]?key)[^/]*)$/iu;
const snapshotKey = Symbol.for("runtime-corrector.openclaw.progress-sources.v1");
const snapshots = globalThis[snapshotKey] ??= new Map();
const clone = value => JSON.parse(JSON.stringify(value));

export async function createReviewerProgress({ projectRoot, taskId, sessionId, role, requestDirectory, request, evidence, prepared, canSave, canRecover, redactEnv = {} }) {
  const root = await fs.realpath(projectRoot), directory = path.join(taskDirectory(projectRoot, taskId), "reviewer-progress", sessionId);
  const population = request.population ?? evidence?.population ?? evidence?.semanticRequest?.runtimeV2?.population;
  const metricIds = request.metricIds ?? evidence?.semanticRequest?.runtimeV2?.metricIds;
  const objects = new Map(Object.entries(population?.metrics ?? {}).filter(([metric]) => !metricIds || metricIds.includes(metric)).flatMap(([,items]) => items).map(item => [item.objectId, item]));
  let frozenGroundTruth = evidence?.groundTruth ?? null;
  if (!frozenGroundTruth && prepared.groundTruthPath) {
    try { frozenGroundTruth = JSON.parse(await fs.readFile(prepared.groundTruthPath,"utf8")); } catch { /* version remains unknown */ }
  }
  const requirementVersion = frozenGroundTruth?.version ?? request.currentGroundTruth?.version ?? null;
  const evidenceVersion = sha256({ snapshot:evidence?.snapshot ?? request.transcript ?? null, groundTruth:frozenGroundTruth, sourceManifest:request.sourceManifest ?? [] });
  const scopeFingerprint = sha256({ taskId, role, request, evidence, frozenGroundTruth });
  const ownSources = new Map(), items = new Map(), privateFiles = new Set(), implementationSources = new Set();
  const secrets = Object.entries(redactEnv).filter(([name,value]) => /key|secret|token|password/iu.test(name) && typeof value==="string" && value.length>7).map(([,value]) => value);
  const redact = value => secrets.reduce((text,secret) => text.split(secret).join("<redacted>"),String(value));
  const taskKey = `${root}\0${taskId}`;
  const taskSources = snapshots.get(taskKey) ?? new Map(); snapshots.set(taskKey, taskSources);
  let queue = Promise.resolve();
  const persist = value => outsideDecision(() => atomicWriteJson(path.join(directory, "progress.json"), value));
  const state = () => ({ reviewId: sessionId, role, requirementVersion, evidenceVersion, scopeFingerprint, objects: [...objects.keys()], items: [...items.values()] });
  const isWithin = (base, file) => { const rel = path.relative(base, file); return !rel.startsWith("..") && !path.isAbsolute(rel); };
  async function source(file, { frozen = false, expectedHash = null } = {}) {
    const absolute = path.resolve(root, file), real = await fs.realpath(absolute);
    const relative = path.relative(root, real).replaceAll("\\", "/");
    if (!isWithin(root, real) || relative.split("/").some(part => blocked.test(part))
      || (relative.startsWith(".runtime-correction/") && !privateFiles.has(real))) throw new Error("REVIEW_PROGRESS_SOURCE_NOT_AUTHORIZED");
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("REVIEW_PROGRESS_SOURCE_NOT_TEXT");
    const bytes = await fs.readFile(real);
    if (bytes.includes(0)) throw new Error("REVIEW_PROGRESS_SOURCE_NOT_TEXT");
    const text = bytes.toString("utf8"), contentHash = sha256(bytes);
    if (secrets.some(secret => text.includes(secret))) throw new Error("REVIEW_PROGRESS_SOURCE_CONTAINS_SECRET");
    if (expectedHash && expectedHash !== contentHash) throw new Error("REVIEW_PROGRESS_SOURCE_VERSION_MISMATCH");
    const previous = ownSources.get(real);
    if (previous && previous.contentHash !== contentHash) throw new Error("REVIEW_PROGRESS_SOURCE_VERSION_MISMATCH");
    if (previous) return previous;
    const snapshotPath = path.join(directory, "sources", `${sha256([real,contentHash]).slice(0,32)}.txt`);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, text, { mode: 0o600 });
    const record = { path: real, snapshotPath, contentHash, frozen, text, lines: text.split("\n").length };
    ownSources.set(real, record); taskSources.set(real, record); taskSources.set(absolute, record); taskSources.set(snapshotPath, record);
    return record;
  }
  const capturedPaths = [path.join(requestDirectory,"request.json"), prepared.transcript?.path, prepared.groundTruthPath, prepared.semanticReviewRequestPath].filter(Boolean);
  for (const file of capturedPaths) privateFiles.add(await fs.realpath(file));
  for (const file of capturedPaths) await source(file, { frozen: true });
  for (const entry of request.sourceManifest ?? []) {
    try { const record = await source(entry.path ?? entry.relativePath, { expectedHash: entry.sha256 ?? null }); implementationSources.add(record.path); }
    catch { /* An unavailable source is not promoted into evidence by a draft. */ }
  }
  const originalGroundTruthPath = request.groundTruthPath ?? evidence?.semanticRequest?.runtimeV2?.groundTruthPath;
  let originalGroundTruthHash = null;
  if (originalGroundTruthPath && !isWithin(requestDirectory, path.resolve(originalGroundTruthPath))) {
    try { const current = await readJson(originalGroundTruthPath); if(current)originalGroundTruthHash = sha256(current); } catch { /* frozen request remains authoritative */ }
  }
  async function select(ref) {
    let file, start, end;
    if (typeof ref === "string") {
      const match = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref);
      if (!match) throw new Error("REVIEW_PROGRESS_REFERENCE_INVALID");
      [,file,start,end] = match; start = Number(start); end = Number(end ?? start);
    } else if (ref && typeof ref.path === "string") { file = ref.path; start = ref.start ?? 1; end = ref.end ?? start; }
    else throw new Error("REVIEW_PROGRESS_REFERENCE_INVALID");
    const record = await source(file);
    if (role === "implementation-reviewer" && !implementationSources.has(record.path)) throw new Error("REVIEW_PROGRESS_SOURCE_NOT_OWNED_BY_IMPLEMENTATION");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > record.lines) throw new Error("REVIEW_PROGRESS_REFERENCE_RANGE_INVALID");
    return { selection: `${record.snapshotPath}#L${start}-L${end}`, path: record.path, snapshotPath: record.snapshotPath, frozen: record.frozen,
      start, end, contentHash: record.contentHash, exactQuote: record.text.split("\n").slice(start-1,end).join("\n") };
  }
  async function sourceUnchanged(ref) {
    const record = ownSources.get(ref.path);
    if (!record || record.contentHash !== ref.contentHash) return false;
    if (record.frozen) return true;
    try { return sha256(await fs.readFile(record.path)) === record.contentHash; } catch { return false; }
  }
  function requirementFor(object) {
    const record = ownSources.get(prepared.groundTruthPath) ?? ownSources.get(path.join(requestDirectory,"request.json"));
    const rows = record?.text.split("\n") ?? [];
    let position = rows.findIndex(line => line.includes(JSON.stringify(object.sourceId)));
    if (position < 0) position = rows.findIndex(line => line.includes(JSON.stringify(object.objectId)));
    return { sourceId: object.sourceId, sourceRevisionId: object.sourceRevisionId, description: object.description ?? "",
      refs: position < 0 ? [] : [`${record.snapshotPath}#L${position+1}-L${Math.min(rows.length,position+12)}`] };
  }
  async function save(item) {
    if (!canSave()) throw new Error("REVIEW_PROGRESS_CLOSED");
    if (!objects.has(item.objectId)) throw new Error("REVIEW_PROGRESS_OBJECT_NOT_AUTHORIZED");
    if (!states.has(item.state) || (item.judgement != null && !judgements.has(item.judgement))
      || typeof item.reason !== "string" || item.reason.length > 2000 || !Array.isArray(item.refs)
      || !Array.isArray(item.unresolved ?? []) || (item.unresolved ?? []).some(value => typeof value !== "string")
      || (item.state === "COMPLETED" && (!item.judgement || !item.reason.trim() || !item.refs.length))
      || (item.judgement === "PASS" && (item.state !== "COMPLETED" || item.unresolved?.length))) throw new Error("REVIEW_PROGRESS_INVALID");
    const selected = [];
    for (const ref of item.refs) selected.push(await select(ref));
    if (!canSave()) throw new Error("REVIEW_PROGRESS_CLOSED");
    const stored = { objectId: item.objectId, state: item.state, judgement: item.judgement ?? null, reason: redact(item.reason),
      refs: selected, unresolved: (item.unresolved ?? []).map(redact), requirementVersion, evidenceVersion, scopeFingerprint };
    const write = queue.then(async () => {
      if (!canSave()) throw new Error("REVIEW_PROGRESS_CLOSED");
      const previous = items.get(item.objectId); items.set(item.objectId, stored);
      try { await persist(state()); }
      catch(error) { if(previous)items.set(item.objectId,previous);else items.delete(item.objectId);throw error; }
      return { saved: true, objectId: item.objectId, state: item.state };
    }); queue = write.catch(() => {}); return write;
  }
  async function recover(error = null) {
    if (!["stop-reviewer", "implementation-reviewer"].includes(role) || !canRecover()) return null;
    await queue;
    if (originalGroundTruthHash) {
      try { if (sha256(await readJson(originalGroundTruthPath)) !== originalGroundTruthHash) return null; } catch { return null; }
    }
    const metricObjectJudgements = [], citations = [], rejectedObjectIds = [];
    for (const item of items.values()) {
      if (!canRecover()) return null;
      if (item.state !== "COMPLETED" || !item.judgement || !item.refs.length || item.scopeFingerprint !== scopeFingerprint
        || (item.judgement === "PASS" && item.unresolved.length)) continue;
      if (!(await Promise.all(item.refs.map(sourceUnchanged))).every(Boolean)) { rejectedObjectIds.push(item.objectId); continue; }
      metricObjectJudgements.push({ objectId:item.objectId, judgement:item.judgement, reason:item.reason,
        evidence:item.refs.map(ref => ref.selection), requirement:requirementFor(objects.get(item.objectId)) });
      citations.push(...item.refs.map(ref => ({ ...ref, usedBy:[item.objectId] })));
    }
    if (!metricObjectJudgements.length || !canRecover()) return null;
    const recoveredIds = new Set(metricObjectJudgements.map(item => item.objectId));
    const partial = { status:"PARTIAL", finalClassification:null, reviewId:sessionId, requirementVersion, evidenceVersion, scopeFingerprint,
      failureReason:error ? redact(error.message) : null, totalObjects:objects.size, recoveredObjects:metricObjectJudgements.length, metricObjectJudgements,
      unreviewedObjectIds:[...objects.keys()].filter(id => !recoveredIds.has(id)), rejectedObjectIds, citations };
    await outsideDecision(() => atomicWriteJson(path.join(directory,"partial-report.json"),partial));
    return canRecover() ? partial : null;
  }
  async function getSourceCitations(report) {
    const selections = new Map();
    for (const item of [...(report?.metricObjectJudgements ?? []),...(report?.findings ?? [])]) {
      const owner = item.objectId ?? item.deviationKey ?? "finding";
      for (const text of [...(item.evidence ?? []),...(item.actualEvidence ?? [])]) {
        if (typeof text !== "string") continue;
        const patterns = /([^\s"'`()[\],;]+)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?/gu;
        for (const match of text.matchAll(patterns)) {
          const file = path.resolve(root,match[1]), known = taskSources.get(file);
          let citation;
          try {
            if (known) {
              const start=Number(match[2]),end=Number(match[3] ?? start);
              if (start < 1 || end < start || end > known.lines || (!known.frozen && sha256(await fs.readFile(known.path))!==known.contentHash)) continue;
              citation={selection:`${known.snapshotPath}#L${start}-L${end}`,path:known.path,snapshotPath:known.snapshotPath,frozen:known.frozen,start,end,contentHash:known.contentHash,exactQuote:known.text.split("\n").slice(start-1,end).join("\n")};
            } else citation=await select(`${match[1]}#L${match[2]}-L${match[3] ?? match[2]}`);
          } catch { continue; }
          const old=selections.get(citation.selection);
          if(old) {if(!old.usedBy.includes(owner))old.usedBy.push(owner);} else selections.set(citation.selection,{...citation,usedBy:[owner]});
        }
      }
    }
    const result=[...selections.values()];
    await outsideDecision(() => atomicWriteJson(path.join(directory,"citations.json"),result)); return result;
  }
  await persist(state());
  return { hasObjects:objects.size>0, sessionId, role, save, get:() => clone(state()), recover, getSourceCitations };
}

export function registerReviewerProgress(api) {
  const referenceSchema = { type:"object", additionalProperties:false, required:["path","start","end"],
    properties:{path:{type:"string"},start:{type:"integer",minimum:1},end:{type:"integer",minimum:1}} };
  const itemSchema = { type:"object", additionalProperties:false, required:["objectId","state","reason","refs"], properties:{
    objectId:{type:"string"},state:{type:"string",enum:[...states]},judgement:{type:["string","null"],enum:[...judgements,null]},
    reason:{type:"string",maxLength:2000},unresolved:{type:"array",items:{type:"string"}},refs:{type:"array",items:referenceSchema} } };
  api.registerTool(ctx => {
    const progress=currentReviewerProgress(ctx);
    if (!progress?.hasObjects) return null;
    return { name:"rc_progress", label:"Private review progress", description:"Save/get this isolated review's item checkpoints. Select source path and line ranges; quotes are captured by the program. Saves acknowledge only the item identity/state.",
      parameters:{type:"object",additionalProperties:false,required:["action"],properties:{action:{type:"string",enum:["save","get"]},item:itemSchema}},
      async execute(_id,args) {
        if (currentReviewerProgress(ctx)!==progress) throw new Error("REVIEW_PROGRESS_NOT_OWNED");
        const value=args.action==="get"?progress.get():args.action==="save"?await progress.save(args.item):null;
        if(!value)throw new Error("REVIEW_PROGRESS_ACTION_INVALID");
        return {content:[{type:"text",text:JSON.stringify(value)}],details:value};
      }};
  },{names:["rc_progress"]});
}
