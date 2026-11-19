import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteJson, readJson, sha256 } from "../runtime-v2/utils.mjs";
import { taskDirectory } from "../runtime-v2/task-store.mjs";
import { outsideDecision } from "../runtime-v2/decision-scope.mjs";
import { currentReviewerProgress } from "./internal-context.mjs";
import { createSkillCare, isSkillCareRequest, SKILL_CARE_PARAMETERS } from "../runtime-v2/skill-care.mjs";
import { CONDITIONAL_REVIEW_POLICY_VERSION } from '../review-task/task-evidence.mjs';
import { skillConditionKey } from '../runtime-v2/skill-source.mjs';

const states = new Set(["PENDING", "IN_PROGRESS", "COMPLETED"]);
const judgements = new Set(["PASS", "DEVIATION", "UNVERIFIED", "BASIS_PENDING", "EXTERNAL_BLOCKED", "NOT_APPLICABLE", "NOT_YET_APPLICABLE", "NOT_YET_EXECUTED", "CHECKER_ERROR"]);
const blocked = /(?:^|\/)(?:\.git|\.aws|\.ssh|\.env(?:\.[^/]*)?|auth-profiles\.json|openclaw\.json|[^/]*(?:credentials|secret|api[-_]?key)[^/]*)$/iu;
const snapshotKey = Symbol.for("runtime-corrector.openclaw.progress-sources.v1");
const snapshots = globalThis[snapshotKey] ??= new Map();
const clone = value => JSON.parse(JSON.stringify(value));

export async function createReviewerProgress({ projectRoot, taskId, sessionId, reviewId = sessionId, role, requestDirectory, request, evidence, prepared, canSave, canRecover, redactEnv = {} }) {
  const root = await fs.realpath(projectRoot), directory = path.join(taskDirectory(root, taskId), "reviewer-progress", reviewId);
  requestDirectory = await fs.realpath(requestDirectory);
  const evidenceDirectory = prepared.reviewScope?.evidenceDirectory
    ? await fs.realpath(prepared.reviewScope.evidenceDirectory) : null;
  const careIssued = new Map(), carePrewrite = new Map(), careCoverage = new Map(), careDocuments = new Map();
  let owner;
  const processEntries = structuredClone(evidence?.snapshot?.entries ?? []), processCursor = sha256(processEntries);
  const skillGraphDigest = sha256(evidence?.skillGroundTruth ?? null);
  for (const file of evidence?.skillSource?.files ?? []) careDocuments.set(`skill/${file.path}`, {
    text: file.content, hash: file.sha256, owner: 'BASIS', origin: path.join(evidence.skillSource.root, file.path) });
  for (const [index, entry] of processEntries.entries()) careDocuments.set(`execution/${index}`, {
    text: JSON.stringify(entry), hash: sha256(JSON.stringify(entry)), owner: 'PROCESS', index });
  const covered = id => {
    const doc = careDocuments.get(id); if (!doc) return false;
    let next = 0;
    for (const range of [...(careCoverage.get(id) ?? [])].sort((a, b) => a.start - b.start)) {
      if (range.start > next) break; next = Math.max(next, range.end);
    }
    return next >= doc.text.length;
  };
  const issueSkillRead = (callId, args, value, result, ctx) => {
    if (!canSave() || args.action !== 'read' || typeof callId !== 'string'
      || currentReviewerProgress(ctx) !== owner || ctx.sessionId !== sessionId
      || typeof ctx.sessionKey !== 'string' || !ctx.sessionKey || careIssued.has(callId)) return;
    const doc = careDocuments.get(args.id), start = args.offset ?? 0;
    if (!doc || value.id !== args.id || value.sha256 !== doc.hash || value.offset !== start
      || typeof value.content !== 'string' || value.content !== doc.text.slice(start, start + value.content.length)
      || value.nextOffset !== (start + value.content.length < doc.text.length ? start + value.content.length : null)) return;
    careIssued.set(callId, { id: args.id, start, end: start + value.content.length,
      content: JSON.stringify(result.content), argumentsHash: sha256(args), sessionId: ctx.sessionId, sessionKey: ctx.sessionKey,
      agentId: ctx.agentId ?? null, runId: ctx.runId ?? null });
  };
  const acceptSkillReceipt = (event, ctx) => {
    if (!canSave() || currentReviewerProgress(ctx) !== owner || event.toolName !== 'rc_skill_care' || event.isSynthetic !== false) return;
    const issued = careIssued.get(event.toolCallId), message = event.message;
    // The real persist-hook context omits sessionId/runId. Its trusted ALS
    // owner and exact issued sessionKey/call still bind the acknowledgement.
    // Supplemental identities, when present, may never contradict issuance.
    if (!issued || ctx.sessionKey !== issued.sessionKey
      || issued.agentId != null && ctx.agentId !== issued.agentId
      || ctx.sessionId != null && ctx.sessionId !== issued.sessionId
      || ctx.runId != null && ctx.runId !== issued.runId
      || ctx.toolName != null && ctx.toolName !== event.toolName
      || ctx.toolCallId != null && ctx.toolCallId !== event.toolCallId) return;
    if (message?.role !== 'toolResult' || message.toolName !== event.toolName || message.toolCallId !== event.toolCallId
      || message.isError !== false || JSON.stringify(message.content) !== issued.content) return;
    careIssued.delete(event.toolCallId);
    carePrewrite.set(event.toolCallId, issued);
  };
  const verifySkillPersistence = async () => {
    careCoverage.clear();
    if (!canSave() || !carePrewrite.size) return;
    // tool_result_persist runs before the host's final write hook. It proves
    // an observed prewrite envelope, not durable disclosure. Check the actual
    // owning native session only when collecting the final review's evidence.
    const file = path.join(requestDirectory, 'session.jsonl');
    let text, entries;
    try {
      if (!(await fs.lstat(file)).isFile()) return;
      text = await fs.readFile(file, 'utf8'); entries = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch { return; }
    const headers = entries.filter(entry => entry.type === 'session');
    if (headers.length !== 1 || headers[0].id !== sessionId) return;
    for (const [callId, issued] of carePrewrite) {
      const calls = entries.flatMap((entry, index) => entry.message?.role === 'assistant' && Array.isArray(entry.message.content)
        ? entry.message.content.filter(block => block.type === 'toolCall' && block.id === callId).map(block => ({ index, block })) : []);
      const results = entries.flatMap((entry, index) => entry.message?.role === 'toolResult' && entry.message.toolCallId === callId
        ? [{ index, message: entry.message }] : []);
      if (calls.length !== 1 || results.length !== 1 || calls[0].index >= results[0].index
        || calls[0].block.name !== 'rc_skill_care' || sha256(calls[0].block.arguments) !== issued.argumentsHash
        || results[0].message.toolName !== 'rc_skill_care' || results[0].message.isError !== false
        || JSON.stringify(results[0].message.content) !== issued.content) continue;
      careCoverage.set(issued.id, [...(careCoverage.get(issued.id) ?? []), { start: issued.start, end: issued.end,
        nativePersistence: { sessionId, path: file, sha256: sha256(text), callId, resultIndex: results[0].index } }]);
    }
  };
  const conditionalCitations = async report => {
    const output = [];
    const items = [...(report?.conditionalAssessments ?? []).map(item => ({ ...item, owner: `condition:${skillConditionKey(item)}` })),
      ...(report?.sourceInterpretationReviews ?? []).map(item => ({ ...item, owner: `interpretation:${item.constraintId}` }))];
    if (!items.length) return output;
    await verifySkillPersistence();
    const currentSources = new Map();
    for (const file of evidence?.skillSource?.files ?? []) {
      const doc = careDocuments.get(`skill/${file.path}`);
      try { currentSources.set(file.path, await fs.realpath(doc.origin) === doc.origin && sha256(await fs.readFile(doc.origin)) === doc.hash); }
      catch { currentSources.set(file.path, false); }
    }
    for (const item of items) {
      const constraint = evidence?.skillGroundTruth?.constraints?.find(c => c.constraintId === item.constraintId);
      if (!constraint) continue;
      const ref = String(constraint.sourceRef ?? '').replace(/#.*$/u, '');
      const sourceFiles = (evidence?.skillSource?.files ?? []).filter(file => file.path === 'SKILL.md' || ref === file.path
        || ref.endsWith('/' + file.path) || constraint.sourceContextFiles?.includes(file.path));
      const basisComplete = sourceFiles.some(file => file.path === 'SKILL.md')
        && sourceFiles.every(file => currentSources.get(file.path) === true && covered(`skill/${file.path}`));
      const ids = new Set((item.actualEvidence ?? []).filter(id => careDocuments.has(id)));
      // Already acknowledged original pages may be reused within this exact
      // private review; no citation rights transfer across reviews or sources.
      if (item.conditionAssessment?.evidenceKind === 'PROCESS_WINDOW')
        for (const id of careDocuments.keys()) if (id.startsWith('execution/') && covered(id)) ids.add(id);
      for (const file of sourceFiles) ids.add(`skill/${file.path}`);
      for (const id of ids) {
        const doc = careDocuments.get(id); if (!doc || !covered(id) || !canSave()) continue;
        const target = path.join(directory, 'care-sources', sha256([id, doc.hash]) + '.txt');
        await fs.mkdir(path.dirname(target), { recursive: true });
        try { await fs.writeFile(target, doc.text, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST' || sha256(await fs.readFile(target)) !== doc.hash) throw error; }
        const entry = Number.isInteger(doc.index) ? processEntries[doc.index] : null;
        const originalUser = entry?.type === 'user' && entry.isMeta !== true && typeof entry.message?.content === 'string';
        const matchedActions = entry?.type === 'user' && Array.isArray(entry.message?.content) ? entry.message.content.flatMap(block => {
          if (block.type !== 'tool_result') return false;
          const calls = processEntries.flatMap((candidate, index) => candidate.type === 'assistant' && Array.isArray(candidate.message?.content)
            ? candidate.message.content.filter(call => call.type === 'tool_use' && call.id === block.tool_use_id).map(call => ({ index, call })) : []);
          return calls.length === 1 && calls[0].index < doc.index && covered(`execution/${calls[0].index}`)
            && typeof calls[0].call.name === 'string' && !/^(?:rc_|source_)/iu.test(calls[0].call.name) ? [calls[0].call] : [];
        }).filter(Boolean) : [];
        const executionEvidence = matchedActions.some(call => /^(?:bash|exec|shell|terminal|execute|run_command)$/iu.test(call.name));
        output.push({ path: doc.origin ?? target, snapshotPath: target, frozen: true, contentHash: doc.hash,
          start: 1, end: doc.text.split('\n').length, selection: `${target}#L1-L${doc.text.split('\n').length}`,
          usedBy: [item.owner],
          readProof: { version: 1, protocol: 'native-skill-care-v1', observed: true, basisComplete, owner: doc.owner,
            fullFile: true, activationFact: originalUser, executionEvidence: Boolean(executionEvidence), policy: CONDITIONAL_REVIEW_POLICY_VERSION,
            processActionEvidence: matchedActions.length > 0,
            skillGraphDigest, skillSourceDigest: evidence?.skillSource?.digest ?? null,
            disclosure: 'HOST_PREWRITE_OBSERVED_AND_SESSION_TRANSCRIPT_VERIFIED',
            nativePersistence: (careCoverage.get(id) ?? []).map(range => range.nativePersistence),
            processCursor, ...(entry ? { processIndex: doc.index } : {}) } });
      }
    }
    return output;
  };
  const population = request.population ?? evidence?.population ?? evidence?.semanticRequest?.runtimeV2?.population;
  const metricIds = request.metricIds ?? evidence?.semanticRequest?.runtimeV2?.metricIds;
  const objects = new Map(Object.entries(population?.metrics ?? {}).filter(([metric]) => !metricIds || metricIds.includes(metric)).flatMap(([,items]) => items).map(item => [item.objectId, item]));
  let frozenGroundTruth = evidence?.groundTruth ?? null;
  if (!frozenGroundTruth && prepared.groundTruthPath) {
    try { frozenGroundTruth = JSON.parse(await fs.readFile(prepared.groundTruthPath,"utf8")); } catch { /* version remains unknown */ }
  }
  const requirementVersion = frozenGroundTruth?.version ?? request.currentGroundTruth?.version ?? null;
  const evidenceVersion = sha256({ snapshot:evidence?.snapshot ?? request.transcript ?? null, groundTruth:frozenGroundTruth, sourceManifest:request.sourceManifest ?? [],
    conditionalReviewPolicy: CONDITIONAL_REVIEW_POLICY_VERSION });
  const scopeFingerprint = sha256({ taskId, role, request, evidence, frozenGroundTruth });
  const ownSources = new Map(), items = new Map(), privateFiles = new Set(), implementationSources = new Set();
  const secrets = Object.entries(redactEnv).filter(([name,value]) => /key|secret|token|password/iu.test(name) && typeof value==="string" && value.length>7).map(([,value]) => value);
  const redact = value => secrets.reduce((text,secret) => text.split(secret).join("<redacted>"),String(value));
  const taskKey = `${root}\0${taskId}`;
  const taskSources = snapshots.get(taskKey) ?? new Map(); snapshots.set(taskKey, taskSources);
  let queue = Promise.resolve();
  const persist = value => outsideDecision(() => atomicWriteJson(path.join(directory, "progress.json"), value));
  const state = () => ({ reviewId, role, requirementVersion, evidenceVersion, scopeFingerprint, objects: [...objects.keys()], items: [...items.values()] });
  const isWithin = (base, file) => { const rel = path.relative(base, file); return !rel.startsWith("..") && !path.isAbsolute(rel); };
  async function source(file, { frozen = false, expectedHash = null } = {}) {
    const absolute = path.resolve(root, file), real = await fs.realpath(absolute);
    frozen ||= Boolean(request.reviewScope && evidenceDirectory
      && isWithin(requestDirectory, real) && isWithin(evidenceDirectory, real));
    const relative = path.relative(root, real).replaceAll("\\", "/");
    if (!isWithin(root, real) || relative.split("/").some(part => blocked.test(part))
      || (relative.startsWith(".runtime-correction/") && !privateFiles.has(real)
        && !(request.reviewScope && isWithin(requestDirectory, real)))) throw new Error("REVIEW_PROGRESS_SOURCE_NOT_AUTHORIZED");
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
    const partial = { status:"PARTIAL", finalClassification:null, reviewId, requirementVersion, evidenceVersion, scopeFingerprint,
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
        const exact = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(text.trim());
        const matches = exact ? [exact, ...text.matchAll(patterns)] : text.matchAll(patterns);
        for (const match of matches) {
          const file = path.resolve(root,match[1]), known = taskSources.get(file);
          let citation;
          try {
            if (known) {
              // A task-wide cache locates durable business snapshots; it does
              // not transfer another review session's private evidence rights.
              const relative = path.relative(root, known.path);
              const owned = ownSources.get(known.path) === known;
              if ((!owned && (isWithin(path.join(root, ".runtime-correction"), known.path)
                || !isWithin(root, known.path) || relative.split(/[\\/]/u).some(part => blocked.test(part))))
                || (role === "implementation-reviewer" && !implementationSources.has(known.path))) continue;
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
    const result=[...selections.values(), ...await conditionalCitations(report)];
    await outsideDecision(() => atomicWriteJson(path.join(directory,"citations.json"),result)); return result;
  }
  await persist(state());
  const skillCare = isSkillCareRequest(role, request) && evidence?.skillSource
    && (request.watcher?.skillId || request.skill?.skillId) ? await createSkillCare({ projectRoot, taskId, request, evidence,
    active: () => { if (!canSave()) throw new Error("SKILL_CARE_CLOSED"); } }) : null;
  return owner = { hasObjects:objects.size>0, sessionId, role, save, get:() => clone(state()), recover, getSourceCitations, skillCare,
    issueSkillRead, acceptSkillReceipt };
}

export function registerReviewerProgress(api) {
  api.on?.('tool_result_persist', (event, ctx) => {
    const progress = currentReviewerProgress(ctx);
    progress?.acceptSkillReceipt?.(event, ctx);
  });
  api.on?.("before_compaction", async (_event, ctx) => {
    await currentReviewerProgress(ctx)?.skillCare?.checkpoint("before_compaction");
  }, { timeoutMs: 5000 });
  api.registerTool(ctx => {
    const progress = currentReviewerProgress(ctx);
    if (!progress?.skillCare || ctx.sandboxed) return null;
    return { name: "rc_skill_care", label: "Skill care", parameters: SKILL_CARE_PARAMETERS,
      description: "Private Skill evidence navigation and durable keyed notes. Resume after compaction; search literally; read bounded original pages. Notes never prove compliance.",
      async execute(_id, args) {
        if (currentReviewerProgress(ctx) !== progress) throw new Error("SKILL_CARE_NOT_OWNED");
        const value = await progress.skillCare.execute(args);
        const result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        progress.issueSkillRead(_id, args, value, result, ctx);
        return result;
      } };
  }, { names: ["rc_skill_care"] });
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
