import path from "node:path";
import { atomicWrite, atomicWriteJson, uniqueId } from "./utils.mjs";
import { taskDirectory } from "./task-store.mjs";
import { outsideDecision } from "./decision-scope.mjs";

export const HOST_FEEDBACK_MAX_BYTES = 8192;
export const HOST_FEEDBACK_ITEM_BYTES = 768;
const PAGE_ITEMS = 12;
const DETAILS_MARKER = "[RC_DETAILS] ";
const ITEM_MARKER = "[RC_ITEM] ";
const bytes = value => Buffer.byteLength(String(value), "utf8");
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))];
const singleLine = value => String(value ?? "").replace(/\s+/gu, " ").trim();
const localized = (locale, zh, en) => String(locale).startsWith("zh") ? zh : en;

function clip(value, maximum, suffix = "…") {
  const text = String(value ?? "");
  if (bytes(text) <= maximum) return text;
  const room = Math.max(0, maximum - bytes(suffix));
  let result = "", used = 0;
  for (const character of text) {
    const size = bytes(character);
    if (used + size > room) break;
    result += character; used += size;
  }
  return result + (maximum >= bytes(suffix) ? suffix : "");
}

function fitPublishedItems(body, prefix, footer, maximum) {
  const blocks = body.split(/\n{2,}/u);
  const items = blocks.filter(block => /^(?:DEVIATION|FINDING|CHECKER_ERROR|FILE_QUALITY_(?:DEVIATION|UNVERIFIED))\s/u.test(block)
    && (block.includes(`\n  ${DETAILS_MARKER}`) || block.includes(`\n  ${ITEM_MARKER}`)));
  if (!items.length) return null;
  const previousNotice = blocks.find(block => /^(?:\d+ item details omitted|本消息省略 \d+ 项详情)/u.test(block)) ?? "";
  const previousOmitted = Number(/\d+/u.exec(previousNotice)?.[0] ?? 0);
  const chinese = previousNotice.startsWith("本消息");
  const prefixPart = clip(prefix.trim(), Math.min(2048, Math.floor(maximum / 3)));
  const header = blocks[0];
  const render = selected => [prefixPart, header,
    ...[...selected].sort((a, b) => a - b).map(index => items[index]),
    chinese ? `本消息省略 ${previousOmitted + items.length - selected.size} 项详情；全部逐项记录见上述已发布索引。`
      : `${previousOmitted + items.length - selected.size} item details omitted from this message; every item remains in the published index.`,
    footer].filter(Boolean).join("\n\n");
  const selected = new Set();
  if (bytes(render(selected)) > maximum) return null;
  const order = [];
  for (const matcher of [/^(?:DEVIATION|FINDING|FILE_QUALITY_(?:DEVIATION|UNVERIFIED))\s/u, /^CHECKER_ERROR\s/u]) {
    const positions = items.map((item, index) => matcher.test(item) ? index : -1).filter(index => index >= 0);
    for (let left = 0, right = positions.length - 1; left <= right; left++, right--) {
      order.push(positions[left]); if (left !== right) order.push(positions[right]);
    }
  }
  for (const index of order) {
    const trial = new Set(selected); trial.add(index);
    if (bytes(render(trial)) <= maximum) selected.add(index);
  }
  return render(selected);
}

/** Bound the final prefix and feedback together, retaining a published index. */
export function boundHostFeedback(text, { detailsPath = null, maxBytes = HOST_FEEDBACK_MAX_BYTES, prefix = "" } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a nonnegative integer.");
  const original = String(text ?? "");
  const discovered = original.split(/\r?\n/u).find(line => line.startsWith(DETAILS_MARKER));
  const details = detailsPath ?? discovered?.slice(DETAILS_MARKER.length);
  const footer = details ? `${DETAILS_MARKER}${details}` : "";
  const body = original.split(/\r?\n/u).filter(line => !line.startsWith(DETAILS_MARKER)).join("\n").trim();
  const complete = [String(prefix ?? "").trim(), body, footer].filter(Boolean).join("\n\n");
  if (bytes(complete) <= maxBytes) return complete;
  if (bytes(footer) > maxBytes) {
    // A full real path cannot be replaced by a clipped, nonexistent path.
    return clip("[runtime-corrector] Feedback limit cannot contain the published details path.", maxBytes);
  }
  if (footer) {
    const structured = fitPublishedItems(body, String(prefix ?? ""), footer, maxBytes);
    if (structured !== null) return structured;
  }
  const notice = "[runtime-corrector] Feedback shortened; remaining original details are in the published index.";
  const fallbackNotice = "[runtime-corrector] Feedback shortened; no published detail index is available.";
  const tail = [...originalControlLines(body), details ? notice : fallbackNotice, footer].filter(Boolean).join("\n");
  if (bytes(tail) > maxBytes) return footer || clip(fallbackNotice, maxBytes);
  const available = Math.max(0, maxBytes - bytes(tail) - 4);
  const prefixPart = clip(String(prefix ?? "").trim(), Math.min(2048, Math.floor(available / 3)));
  const bodyPart = clip(body, Math.max(0, available - bytes(prefixPart) - (prefixPart ? 2 : 0)));
  return [prefixPart, bodyPart, tail].filter(Boolean).join("\n\n");
}

function sourceId(value) {
  return String(value ?? "").replace(/^M\d+:/u, "").replace(/@\d+$/u, "");
}

function firstReason(value) {
  const line = singleLine(value);
  const sentence = /^(.*?[。！？!?]|.*?\.(?:\s|$))/u.exec(line);
  return sentence ? sentence[1].trim() : line;
}

function evidenceLocations(item, citations) {
  const owners = new Set([...item.objectIds, ...item.findings.map(finding => finding.deviationKey)].filter(Boolean));
  const selections = unique(item.objects.flatMap(object => object.evidence ?? [])
    .concat(item.findings.flatMap(finding => finding.actualEvidence ?? finding.evidence ?? []),
      (item.fileAssessments ?? []).flatMap(file => file.evidence ?? [])));
  const locations = citations.filter(citation => citation.usedBy?.some(owner => owners.has(owner))
    || selections.includes(citation.selection)).map(citation => {
    const file = citation.frozen ? citation.snapshotPath : citation.path ?? citation.source;
    return file ? `${file}${citation.start ? `#L${citation.start}-L${citation.end ?? citation.start}` : ""}` : citation.selection;
  });
  for (const selection of selections) {
    if (typeof selection !== "string") continue;
    // Only locations are projected. Arbitrary evidence text and exactQuote stay
    // in the persisted machine assessment, never in the host message.
    if (/^(?:raw:[a-f\d]{32}(?:#L\d+(?:-L?\d+)?)?|[^\r\n]+(?:#L|:)\d+(?:-L?\d+)?)$/u.test(selection)) locations.push(selection);
  }
  return unique(locations).filter(location => !String(location).includes("\n"));
}

function projectItems(objects, findings, checkerIssues, partialReview, fileAssessments = []) {
  const known = unique(objects.map(object => sourceId(object.sourceId ?? object.requirement?.sourceId ?? object.objectId)));
  const canonical = value => {
    const id = sourceId(value), matches = known.filter(candidate => candidate === id || candidate.endsWith(`-${id}`));
    return matches.length === 1 ? matches[0] : id;
  };
  const items = new Map();
  const add = (key, initial) => {
    if (!items.has(key)) items.set(key, { ...initial, objects: [], findings: [], checkerIssues: [], objectIds: [] });
    return items.get(key);
  };
  for (const [index, object] of objects.entries()) {
    const source = canonical(object.sourceId ?? object.requirement?.sourceId ?? object.objectId);
    const key = `${object.judgement}\0${source}\0${singleLine(object.reason)}`;
    const item = add(key, { sourceIds: [source], state: object.judgement, reason: object.reason ?? "", order: index });
    item.objects.push(object); item.objectIds.push(object.objectId);
  }
  for (const [index, finding] of findings.entries()) {
    const sources = unique((finding.violatedGroundTruthIds ?? []).map(canonical)).sort();
    const source = sources.join(", ") || finding.deviationKey || `finding-${index + 1}`;
    const common = `\0${source}\0${singleLine(finding.reason)}`;
    const item = items.get(`DEVIATION${common}`) ?? add(`FINDING${common}`, {
      sourceIds: sources.length ? sources : [source], state: "FINDING", reason: finding.reason ?? "", order: objects.length + index,
    });
    item.findings.push(finding);
  }
  for (const [index, issue] of checkerIssues.entries()) {
    const item = add(`CHECKER_ISSUE\0${index}`, { sourceIds: [issue.objectId ?? issue.type ?? `checker-${index + 1}`],
      state: "CHECKER_ERROR", reason: issue.message ?? issue.type ?? "", order: objects.length + findings.length + index });
    item.checkerIssues.push(issue);
  }
  // A file verdict is an independent quality check, not an invented metric,
  // GT obligation or business finding. Preserve its diagnostic and locations.
  for (const [index, file] of fileAssessments.entries()) {
    if (file.status === "PASS") continue;
    const item = add(`FILE_QUALITY\0${file.path}\0${file.status}`, { sourceIds: [file.path],
      state: `FILE_QUALITY_${file.status}`, kind: "file-quality", reason: file.reason ?? "",
      order: objects.length + findings.length + checkerIssues.length + index });
    (item.fileAssessments ??= []).push(file);
  }
  const indexedIds = new Set(objects.map(object => object.objectId));
  for (const [state, objectIds] of [["UNREVIEWED", partialReview?.unreviewedObjectIds ?? []],
    ["REJECTED_DRAFT", partialReview?.rejectedObjectIds ?? []]]) {
    for (const objectId of objectIds) {
      if (indexedIds.has(objectId)) continue;
      indexedIds.add(objectId);
      // These are supplied progress states, never synthesized metric verdicts.
      const item = add(`${state}\0${objectId}`, { sourceIds: [canonical(objectId)], state,
        reason: "", order: items.size });
      item.objectIds.push(objectId);
    }
  }
  return [...items.values()];
}

function itemLine(item, detailPath, citations, ordinal) {
  const ids = unique([...item.objectIds, ...item.sourceIds]);
  const directFooter = `  ${DETAILS_MARKER}${detailPath}`;
  // A long workspace prefix is not evidence. The already-published global
  // index resolves this exact ordinal to the full, existing per-item path.
  // Never clip an absolute path into a plausible but nonexistent location.
  const footer = bytes(directFooter) <= 320 ? directFooter : `  ${ITEM_MARKER}${ordinal} (published index)`;
  const title = clip(`${item.state} ${singleLine(ids.join(", "))}`, Math.min(180,
    Math.max(0, HOST_FEEDBACK_ITEM_BYTES - bytes(footer) - 4)));
  const room = Math.max(0, HOST_FEEDBACK_ITEM_BYTES - bytes(title) - bytes(footer) - 4);
  const reason = clip(firstReason(item.reason), Math.min(360, room));
  let line = `${title}: ${reason}`;
  for (const location of evidenceLocations(item, citations).slice(0, 2)) {
    const addition = `\n  ${location}`;
    if (bytes(line) + bytes(addition) + bytes(footer) + 1 > HOST_FEEDBACK_ITEM_BYTES) break;
    line += addition;
  }
  return `${line}\n${footer}`;
}

function originalControlLines(text) {
  const lines = String(text ?? "").split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const state = /^(?:\[runtime-corrector\]\s*)?(?:CORRECTION_BUDGET_EXHAUSTED|STOP_VERIFICATION_(?:UNAVAILABLE|INCOMPLETE))[:：]/u;
  const instruction = /^(?:This Stop is allowed; ALLOW is not an acceptance PASS\.|本次 Stop 放行；放行不等于验收 PASS。|Retry after the reviewer\/runtime recovers\.|请在评审器\/运行时恢复后重试。|Correct only current gaps that can still be changed\.|仅修复仍可改变的当前缺口。|These are the existing judgements and evidence locations;|以上为原判断与依据位置；)/u;
  const chosen = [];
  for (const line of unique([...lines.filter(line => state.test(line)), ...lines.filter(line => instruction.test(line))])) {
    const bounded = clip(line, 768);
    if (bytes([...chosen, bounded].join("\n")) <= 2048) chosen.push(bounded);
  }
  return chosen;
}

function collectionProgress(review, implementationReview, partialReview, objects) {
  const unresolved = new Set(partialReview?.unreviewedObjectIds ?? []);
  const byId = new Map(objects.map(object => [object.objectId, object]));
  const unsettled = new Set(["UNVERIFIED", "CHECKER_ERROR", "EXTERNAL_BLOCKED", "BASIS_PENDING"]);
  for (const object of objects) if (unsettled.has(object.judgement)) unresolved.add(object.objectId);
  const collections = [...new Set([review?.collection, implementationReview?.collection,
    review?.implementationReview?.collection].filter(Boolean))];
  const failures = new Map();
  let unavailableCount = 0, incompleteTasks = 0, totalTasks = 0, completedTasks = 0;
  for (const collection of collections) {
    const failedTasks = collection.items?.filter(item => item.status !== "COMPLETED") ?? [];
    totalTasks += collection.totalItems ?? collection.items?.length ?? 0;
    completedTasks += collection.completedItems ?? collection.items?.filter(item => item.status === "COMPLETED").length ?? 0;
    incompleteTasks += Math.max(failedTasks.length,
      collection.complete === false ? Math.max(0, (collection.totalItems ?? 0) - (collection.completedItems ?? 0)) : 0,
      collection.complete === false && !collection.items?.length ? collection.failures?.length ?? 0 : 0);
    const pending = collection.items?.filter(item => item.status !== "COMPLETED").flatMap(item => item.objectIds ?? []) ?? [];
    for (const objectId of [...pending, ...(collection.failures ?? []).flatMap(failure => failure.objectIds ?? [])]) {
      const row = byId.get(objectId);
      // A successful authoritative owner can supersede an earlier general
      // review failure for the same object. Never count its confirmed verdict
      // as unreviewed merely because that earlier task failed.
      if (!row || unsettled.has(row.judgement)) unresolved.add(objectId);
    }
    if (collection.complete === false && !pending.length && !(collection.failures ?? []).some(failure => failure.objectIds?.length)) {
      unavailableCount = Math.max(unavailableCount, Math.max(0, (collection.totalObjects ?? 0) - (collection.reviewedObjects ?? 0)));
    }
    for (const failure of collection.failures ?? []) {
      const key = JSON.stringify([failure.code, failure.reason, failure.objectIds ?? []]);
      failures.set(key, failure);
    }
  }
  const objectScope = objects.length > 0 || (partialReview?.totalObjects ?? 0) > 0
    || collections.some(collection => (collection.totalObjects ?? 0) > 0);
  return { incomplete: Math.max(unresolved.size, unavailableCount), incompleteTasks, totalTasks, completedTasks,
    objectScope, failures: [...failures.values()] };
}

function conciseFeedback({ text, review, report, partialReview, objects, items, detailsPath, locale, progress }) {
  if (!objects.length && !items.length && !progress.totalTasks && !progress.failures.length)
    return boundHostFeedback(text, { detailsPath });
  const counts = {};
  for (const object of objects) counts[object.judgement] = (counts[object.judgement] ?? 0) + 1;
  const incomplete = progress.incomplete;
  const lines = [clip(String(text ?? "").split(/\r?\n/u).find(line => line.trim()) ?? "[runtime-corrector]", 520),
    ...(review?.summary ? [localized(locale, "原审查摘要：", "Original review summary: ") + clip(singleLine(review.summary), 512)] : []),
    ...originalControlLines(text),
    partialReview ? localized(locale, "部分验收；最终 Stop 分类尚未确认。", "PARTIAL review; final Stop classification is unconfirmed.")
      : `Stop: ${review?.stopClassification ?? "unconfirmed"}; report: ${report?.status ?? "unconfirmed"}.`,
    ...(objects.length ? [localized(locale, "已有对象判断（非任务完成率）：", "Existing object verdicts (not task completion): ")
      + Object.entries(counts).map(([state, count]) => `${state} ${count}`).join(", ")] : []),
    ...(progress.totalTasks ? [localized(locale, `已完成审查任务 ${progress.completedTasks}/${progress.totalTasks}（非业务通过率）。`,
      `Completed review tasks ${progress.completedTasks}/${progress.totalTasks} (not a business pass rate).`)] : []),
    progress.objectScope ? localized(locale, `未审定 ${incomplete} 项；未验证或检查器故障不等于业务偏离。`,
      `Unreviewed ${incomplete}; unverified work and checker failures are not business deviations.`)
      : localized(locale, `未完成审查任务 ${progress.incompleteTasks} 个；检查器故障不等于业务偏离，未生成指标通过结论。`,
        `Unreviewed review tasks ${progress.incompleteTasks}; checker failures are not business deviations; no metric pass verdicts were generated.`)];
  for (const failure of progress.failures.slice(0, 2)) lines.push(localized(locale, "审查任务故障：", "Review task failure: ")
    + clip(`${failure.code ?? "REVIEW_ITEM_FAILED"}: ${firstReason(failure.reason)}`, 360));
  if (progress.failures.length > 2) lines.push(localized(locale,
    `另有 ${progress.failures.length - 2} 个审查任务故障，完整原因见已发布详情。`,
    `${progress.failures.length - 2} additional review task failures; full reasons are in the published details.`));
  const business = items.filter(item => item.state === "DEVIATION" || item.findings.length);
  const quality = items.filter(item => item.kind === "file-quality");
  const checker = items.filter(item => item.state === "CHECKER_ERROR" && !business.includes(item));
  if (checker.length) lines.push(localized(locale, `检查器故障：${checker.length} 项，原因及原记录见独立详情。`,
    `Checker failures: ${checker.length} items; original reasons and records are in their separate details.`));
  if (quality.length) lines.push(localized(locale,
    `逐文件质量未完成：${quality.length} 项；这些判断不自动新增硬性义务。`,
    `Incomplete file-quality checks: ${quality.length}; these verdicts do not add HARD obligations.`));
  const candidates = [...business, ...quality, ...checker];
  const footer = `${DETAILS_MARKER}${detailsPath}`;
  const omittedNotice = count => localized(locale, `本消息省略 ${count} 项详情；全部逐项记录见上述已发布索引。`,
    `${count} item details omitted from this message; every item remains in the published index.`);
  const header = lines.join("\n");
  const chosen = new Map();
  const businessOrder = [];
  for (let left = 0, right = business.length - 1; left <= right; left++, right--) {
    businessOrder.push(left); if (right !== left) businessOrder.push(right);
  }
  const order = [...businessOrder, ...quality.map((_, index) => business.length + index),
    ...checker.map((_, index) => business.length + quality.length + index)];
  for (const index of order) {
    const trial = new Map(chosen); trial.set(index, candidates[index].shortText);
    const values = [...trial].sort(([a], [b]) => a - b).map(([, value]) => value);
    const result = [header, ...values, omittedNotice(candidates.length - trial.size), footer].join("\n\n");
    if (bytes(result) <= HOST_FEEDBACK_MAX_BYTES) chosen.set(index, candidates[index].shortText);
  }
  const selected = [...chosen].sort(([a], [b]) => a - b).map(([, value]) => value);
  return boundHostFeedback([header, ...selected, omittedNotice(candidates.length - chosen.size)].join("\n\n"), { detailsPath });
}

/** Persist complete assessments before projecting bounded host-facing text. */
export async function prepareHostFeedback({ projectRoot, taskId, text, review = null, report = null,
  partialReview = null, citations = [], locale = "en", implementationReview = null }) {
  try {
    // Capture before the first filesystem await: later caller changes cannot
    // change the assessment behind an already-published feedback entry point.
    ({ review, report, partialReview, citations, implementationReview }
      = structuredClone({ review, report, partialReview, citations, implementationReview }));
    text = String(text ?? "");
    const objects = partialReview?.metricObjectJudgements ?? (report?.metrics
      ? report.metrics.flatMap(metric => metric.objects ?? []) : review?.metricObjectJudgements ?? []);
    const findings = review?.findings ?? partialReview?.findings ?? [];
    const progress = collectionProgress(review, implementationReview, partialReview, objects);
    const checkerIssues = [...(report?.checkerIssues ?? []), ...progress.failures.map(failure => ({
      type: failure.code ?? "REVIEW_ITEM_FAILED", message: failure.reason ?? failure.code ?? "", objectIds: failure.objectIds ?? [],
    }))];
    const items = projectItems(objects, findings, checkerIssues, partialReview, review?.fileAssessments ?? []);
    const directory = path.join(taskDirectory(projectRoot, taskId), "feedback-delivery", uniqueId("feedback"));
    const detailsPath = path.join(directory, "index.json");
    await outsideDecision(async () => {
      await atomicWrite(path.join(directory, "full-feedback.txt"), String(text ?? ""));
      await atomicWriteJson(path.join(directory, "assessment.json"), { schemaVersion: "runtime-corrector.feedback-delivery.v1",
        review, report, partialReview, citations, implementationReview });
      const entries = [];
      // Bound filesystem concurrency while avoiding serial per-object latency
      // in the reserved publication window. Publish navigation only afterwards.
      for (let offset = 0; offset < items.length; offset += 8) {
        entries.push(...await Promise.all(items.slice(offset, offset + 8).map(async (item, localIndex) => {
          const index = offset + localIndex;
          const name = String(index + 1).padStart(6, "0"), itemPath = path.join(directory, "items", `${name}.json`);
          const shortPath = path.join(directory, "items", `${name}.txt`);
          item.shortText = itemLine(item, itemPath, citations, index + 1);
          await atomicWriteJson(itemPath, { ordinal: index + 1, ...item, evidenceLocations: evidenceLocations(item, citations) });
          await atomicWrite(shortPath, item.shortText);
          return { ordinal: index + 1, state: item.state, title: clip(singleLine(item.sourceIds.join(", ")), 160),
            objectCount: item.objectIds.length, path: itemPath, shortPath };
        })));
      }
      const pages = [];
      for (let offset = 0; offset < entries.length; offset += PAGE_ITEMS) {
        const pagePath = path.join(directory, `index-${String(pages.length + 1).padStart(4, "0")}.json`);
        const page = entries.slice(offset, offset + PAGE_ITEMS);
        await atomicWriteJson(pagePath, { page: pages.length + 1, items: page });
        pages.push({ page: pages.length + 1, path: pagePath, count: page.length,
          firstOrdinal: page[0].ordinal, lastOrdinal: page.at(-1).ordinal });
      }
      // Publish the entry point last; a failed write never advertises a partial index.
      await atomicWriteJson(detailsPath, { schemaVersion: "runtime-corrector.feedback-delivery.v1", itemCount: items.length,
        fullFeedbackPath: path.join(directory, "full-feedback.txt"), assessmentPath: path.join(directory, "assessment.json"), pages });
    });
    return conciseFeedback({ text, review, report, partialReview, objects, items, detailsPath, locale, progress });
  } catch {
    const warning = localized(locale, "[runtime-corrector] 完整反馈保存失败；以下为有界反馈，未提供未经发布的详情路径。",
      "[runtime-corrector] Could not persist full feedback; bounded feedback follows without an unpublished detail path.");
    return boundHostFeedback(text, { prefix: warning, detailsPath: false });
  }
}
