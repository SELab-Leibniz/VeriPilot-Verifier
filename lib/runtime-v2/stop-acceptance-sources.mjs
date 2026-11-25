import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hasLinkedPath, isPathInside } from '../path-utils.mjs';
import { excludedOriginalFile } from './original-requirements.mjs';
import { ORIGINAL_PART_BYTES, sddHeading } from './stop-source-coverage.mjs';

const extension = /\.(?:adoc|csv|docx?|json5?|markdown|mdx?|odt|pdf|rst|toml|tsv|txt|xlsx?|xml|ya?ml)$/iu;
const documentPath = /\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*)?\)|[`"'“《]([^`"'”》\n]+)[`"'”》]|([^\s`'"“”《》<>()[\]{}，。；：、！？|*,;]+\.[a-z0-9]{1,8})(?=[\s#),.;:!?，。；：、！？|*]|$)/giu;
const normative = /\b(?:mandatory|required|normative|binding|governing|incorporated by reference|(?:integral )?part of (?:this|the) (?:sdd|specification|contract)|(?:must|shall) (?:follow|implement|comply with|conform to))\b|强制|必读|必选|规范性|必须(?:遵循|遵守|执行|满足|符合)|纳入(?:验收|需求)|(?:组成部分|同等效力)|作为.{0,8}(?:依据|要求)/iu;
const whole = /\b(?:all|each|every|entire|whole|full)\b.{0,45}\b(?:requirements?|rules?|specification|contract|document|files?|annexes)\b|整份|全文|完整(?:规范|版本|要求)|全部(?:规则|要求|条款)/iu;
const directInput = /(?:\b(?:follow|implement|apply|use|conform to|comply with|review against)\s+(?:the\s+)?|\b(?:rules?|requirements?|specification|contract|sdd)\s+(?:(?:defined|listed|described|documented)\s+)?(?:in|from|at)\s+|依照|遵循|按照|依据|根据|需求文档为)\s*$/iu;
const referenceOnly = /\b(?:illustrative|informative|optional|non[- ]?normative|not (?:mandatory|required|binding)|example only|for (?:reference|illustration) only)\b|仅(?:供|作)?(?:参考|示例)|资料性|非(?:强制|规范性)|可选|无需(?:遵循|执行)/iu;
const output = /\b(?:create[ds]?|write|written|generate[ds]?|produce[ds]?|deliver|output|edit|revise|update)\b|创建|新建|生成|产出|编写|撰写|修改|更新|输出到/iu;
const referenceHeading = /^(?:#{1,6}\s*)?(?:examples?|further reading|references|示例|参考(?:资料|文献|附录))\s*[:：]?\s*$/iu;
const appendix = /(?:\bannex(?:es)?|\bappend(?:ix|ices)|附录|附件)/iu;
const specificationName = /(?:^|[/\\_. -])(?:sdd|spec|specification|requirements|workflow|contract)(?:[/\\_. -]|$)|需求规格|设计规范/iu;
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
const annexLabel = /\b(?:Annex|Appendix)\s+(?:[A-Z](?![a-z])[\d.]*|\d+(?:\.\d+)*)(?!\w)|附[录件]\s*[A-Z\d甲乙丙丁戊己庚辛壬癸一二三四五六七八九十]+/gu;
const normalized = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();
function linkTarget(value) {
  const name = value.split('#')[0].trim();
  try { return decodeURIComponent(name); } catch { return name; }
}

function references(clause, annexContext) {
  return [...clause.matchAll(documentPath)].flatMap(match => {
    let name = (match[1] ?? match[2] ?? match[3] ?? match[4]).split('#')[0].trim();
    if (match[1] || match[2]) name = linkTarget(name);
    if (match[4]) name = name.replace(/^(?:请)?(?:依照|按照|依据|根据|遵循|参照|按|见)/u, '');
    const annexTarget = annexContext && name && (match[1] || match[2] || /\.[a-z][a-z0-9]*$/iu.test(name));
    return extension.test(name) || annexTarget ? [{ name, at: match.index }] : [];
  });
}

// Only an explicit normative declaration changes authority. Resolve Markdown
// targets relative to the declaring file, including lists below a required heading.
function declarationReader(fromUser) {
  const headings = [];
  const definitions = new Map(), localAnnexes = new Set(), deferred = [];
  let list = false, fence = null;
  function read(raw, lineNumber) {
    const entries = [];
    const line = raw.trim();
    const marker = /^(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return entries;
    }
    if (fence) return entries;
    const definition = /^\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/u.exec(line);
    if (definition) {
      const label = normalized(definition[1]);
      if (!definitions.has(label)) definitions.set(label, definition[2] ?? definition[3]);
      return entries;
    }
    const heading = /^(#{1,6})\s+/u.exec(line);
    if (heading) {
      for (const match of line.matchAll(annexLabel)) localAnnexes.add(normalized(match[0]));
      const depth = heading[1].length;
      headings.length = depth - 1;
      const inherited = headings.findLast(value => value !== undefined);
      headings.push(referenceOnly.test(line) || referenceHeading.test(line) ? 'reference'
        : normative.test(line) || inherited === 'required' ? 'required' : appendix.test(line) ? 'annex' : inherited);
    }
    if (line && !/^(?:[-*+|]|\d+[.)])\s*/u.test(line)) list = false;
    // Preserve dots within paths. Independent sentences may assign different roles.
    const sentences = line.split(/(?:[。;；!?！？]|\.(?=\s|$))/u);
    for (const sentence of sentences) {
      // A comma or conjunction may separate a binding annex from an example.
      // Keep multi-file declarations together when one predicate governs the list.
      const clauses = referenceOnly.test(sentence) && normative.test(sentence)
        ? sentence.split(/[,，]|\b(?:and|but|whereas|while)\b|而/u) : [sentence];
      for (const clause of clauses) {
        if (referenceOnly.test(clause)) continue;
        const headingRole = headings.at(-1);
        if (headingRole === 'reference') continue;
        const explicit = normative.test(clause) || headingRole === 'required' || list;
        const annex = headingRole !== 'reference' && (headingRole === 'annex' || appendix.test(clause));
        if (!explicit && !fromUser && !annex) continue;
        const targets = references(clause, annex || list);
        for (const match of clause.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/gu))
          targets.push({ name: match[1], label: match[2] || match[1], at: match.index });
        if (!targets.length && explicit && !heading)
          for (const match of clause.matchAll(annexLabel)) targets.push({ name: match[0], annexName: true, at: match.index });
        for (const { name, label, annexName, at } of targets) {
          const prefix = clause.slice(0, at);
          if (output.test(prefix) && !/(?:following|according to|in accordance with|from|using|按照|依据|根据)/iu.test(prefix.slice(prefix.search(output)))) continue;
          if (/(?:\bis (?:an? |the )?(?:required )?(?:output|deliverable)\b|(?:是|作为|为).{0,4}(?:交付物|产出物))/iu.test(clause.slice(at))) continue;
          const authorityPointer = /(?:需求|规范|规程|规格|约定|标准|依据)(?:文档|文件|原文)?\s*(?:详?见|参见|列于|载于|位于|为)\s*$/u.test(prefix)
            || /\b(?:requirements?|specification|rules?|policy|contract)\s*[:=]\s*$/iu.test(prefix);
          const binding = explicit || fromUser && (whole.test(clause) || directInput.test(prefix) || authorityPointer || specificationName.test(name));
          if (!binding && (!annex || /\bsee also\b|另见/iu.test(clause))) continue;
          const entry = { name, line: lineNumber, ...(!binding ? { uncertain: true } : {}) };
          if (label || annexName) deferred.push({ entry, label, annexName });
          else entries.push(entry);
        }
      }
    }
    if (normative.test(line) && !referenceOnly.test(line)
      && (/[:：]$/u.test(line) || !line.includes('.md') && /annexes|appendices|附录|附件/iu.test(line))) list = true;
    return entries;
  }
  // Reference definitions and an in-document annex heading may follow their use.
  read.finish = () => deferred.flatMap(({ entry, label, annexName }) => {
    if (annexName && localAnnexes.has(normalized(entry.name))) return [];
    const target = definitions.get(normalized(label ?? entry.name));
    if (target?.startsWith('#')) return [];
    return target ? [{ ...entry, name: linkTarget(target) }] : [{ ...entry, unresolved: true }];
  });
  return read;
}

// Hash and inspect the same byte stream. Keep only the unfinished line and the
// declarations when scanning a large on-disk SDD.
async function inspectOriginal(file, frozenBytes) {
  const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const declarations = [], read = declarationReader(false);
  let bytes = 0, lines = 0, carry = [], identifiedSdd = false;
  const visit = line => {
    if (!identifiedSdd) identifiedSdd = sddHeading.test(line);
    for (const entry of read(line, ++lines)) declarations.push(entry);
  };
  try {
    for await (const chunk of frozenBytes ? [frozenBytes] : createReadStream(file)) {
      if (chunk.includes(0)) return { issue: 'SOURCE_UNREADABLE' };
      digest.update(chunk);
      bytes += chunk.length;
      const fragments = decoder.decode(chunk, { stream: true }).split('\n');
      carry.push(fragments[0]);
      if (fragments.length === 1) continue;
      visit(carry.join(''));
      for (let i = 1; i < fragments.length - 1; i++) visit(fragments[i]);
      carry = [fragments.at(-1)];
    }
    visit(carry.join('') + decoder.decode());
  } catch (error) {
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return { issue: 'SOURCE_UNREADABLE' };
    throw error;
  }
  for (const entry of read.finish()) declarations.push(entry);
  return { sha256: digest.digest('hex'), bytes, lines, declarations, identifiedSdd };
}

export async function collectStopAcceptanceSources({ projectRoot, userMessages, projectFiles, materials, named, captures = [], plan, largeStrictSources = [] }) {
  const root = path.resolve(projectRoot), sources = new Map(), queued = [], inspected = new Set();
  const known = new Map([...materials, ...projectFiles, ...named].map(file => [key(path.resolve(root, file.path)), file]));
  const capturedFiles = new Map(captures.map(entry => [key(path.resolve(entry.root ?? root, entry.path)), entry]));
  function enqueue({ name, line, uncertain, unresolved }, parent, boundary) {
    const declaredBy = { ref: parent.ref, line };
    if (unresolved) {
      const ref = parent.ref + ' [' + name + ']';
      if (!sources.has(ref)) sources.set(ref, { path: ref, declaredBy, issue: 'SOURCE_LINK_UNRESOLVED' });
      return;
    }
    const remote = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\\\\)/iu.test(name);
    let absolute = path.resolve(parent.file ? path.dirname(parent.file) : root, name);
    if (parent.file && !remote && !path.isAbsolute(name) && !name.startsWith('.') && !existsSync(absolute)) {
      const fromRoot = path.resolve(root, name);
      if (isPathInside(root, fromRoot) && existsSync(fromRoot)) absolute = fromRoot;
    }
    const id = remote ? name : key(absolute);
    const previous = sources.get(id);
    if (previous && (previous.issue !== 'SOURCE_ROLE_UNRESOLVED' || uncertain)) return;
    const inProject = isPathInside(root, absolute);
    const externalInput = !parent.file && path.isAbsolute(name) && !remote;
    const allowed = !remote && (inProject || externalInput || boundary && isPathInside(boundary, absolute));
    const display = remote ? name : known.get(id)?.path ?? (inProject ? path.relative(root, absolute) : absolute).replaceAll('\\', '/');
    const row = { path: display, declaredBy };
    sources.set(id, row);
    if (!allowed || excludedOriginalFile(root, absolute, plan)) { row.issue = 'SOURCE_NOT_ADMISSIBLE'; return; }
    if (uncertain) { row.issue = 'SOURCE_ROLE_UNRESOLVED'; return; }
    queued.push({ file: absolute, ref: display, boundary: inProject ? root : boundary ?? path.dirname(absolute), row });
  }
  for (const message of userMessages) {
    const read = declarationReader(true);
    for (const [index, line] of message.text.split('\n').entries())
      for (const entry of read(line, index + 1)) enqueue(entry, { ref: message.ref }, null);
    for (const entry of read.finish()) enqueue(entry, { ref: message.ref }, null);
  }

  // Project instructions and declared strict materials can themselves adopt an
  // annex even when the user did not repeat the parent document's filename.
  const strictSources = [...projectFiles.map(file => ({ ...file, origin: 'project:instructions' })),
    ...materials.map(file => ({ ...file, origin: 'project:materials' })), ...largeStrictSources];
  for (const file of strictSources) {
    const absolute = path.resolve(root, file.path);
    if (sources.has(key(absolute))) continue;
    const declaredBy = { ref: file.origin };
    let row;
    if (file.bytes > ORIGINAL_PART_BYTES || specificationName.test(path.basename(file.path))) {
      row = { path: file.path, declaredBy };
      sources.set(key(absolute), row);
    }
    queued.push({ file: absolute, ref: file.path, declaredBy, row, boundary: isPathInside(root, absolute) ? root : path.dirname(absolute) });
  }
  for (const task of queued) {
    const { file, ref, boundary } = task, id = key(file);
    let row = task.row ?? sources.get(id);
    const original = known.get(id), captured = capturedFiles.get(id);
    if (captured?.status === 'ADDED' || ['MODIFIED', 'DELETED'].includes(captured?.status) && !captured.original) {
      if (row) row.issue = 'SOURCE_ORIGINAL_UNAVAILABLE';
      continue;
    }
    let inspectedFile;
    try {
      if (!captured?.original && (await hasLinkedPath(file) || !(await fs.stat(file)).isFile())) {
        if (row) row.issue = 'SOURCE_NOT_ADMISSIBLE';
        continue;
      }
      inspectedFile = await inspectOriginal(file, captured?.original && Buffer.from(captured.original));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG', 'EACCES', 'EPERM', 'EISDIR', 'ERR_FS_FILE_TOO_LARGE'].includes(error.code)) throw error;
      if (row) row.issue = 'SOURCE_UNAVAILABLE';
      continue;
    }
    if (inspectedFile.issue) { if (row) row.issue = inspectedFile.issue; continue; }
    const { sha256: hash, bytes, lines, declarations } = inspectedFile;
    if (!row && (inspectedFile.identifiedSdd || declarations.length)) {
      row = { path: ref, declaredBy: task.declaredBy };
      sources.set(id, row);
    }
    const expectedHash = captured?.sha256 ?? original?.sha256;
    if (expectedHash && expectedHash !== hash) {
      if (row) row.issue = 'SOURCE_VERSION_CHANGED';
      continue;
    }
    if (row) Object.assign(row, { sha256: hash, bytes, lines,
      ...(captured?.original ? { originalBase64: Buffer.from(captured.original).toString('base64') } : {}) });
    if (inspected.has(id)) continue;
    inspected.add(id);
    for (const entry of declarations) enqueue(entry, { file, ref }, boundary);
  }
  return [...sources.values()];
}
