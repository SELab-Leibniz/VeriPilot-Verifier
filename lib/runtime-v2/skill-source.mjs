import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as activeHost from "../active-host.mjs";
import { isPathInside } from "../path-utils.mjs";
import { sha256 } from "./utils.mjs";
import { validateJsonSchema } from '../json-schema-validator.mjs';
import { parseSimpleYaml } from '../simple-yaml.mjs';


const TEXT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".css", ".html", ".js", ".json", ".jsx",
  ".md", ".mjs", ".ps1", ".py", ".sh", ".toml", ".ts", ".tsx",
  ".txt", ".yaml", ".yml",
]);
const SENSITIVE_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", "credentials", "credentials.json",
  "id_rsa", "id_ed25519", "secrets.json",
]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".runtime-correction", "__pycache__", ".cache"]);
const scanCache = new Map();

export const SKILL_SOURCE_CONTRACT_VERSION = 'original-skill-units-v3-quotes';
const graphError = message => Object.assign(new Error(`SKILL_GRAPH_SOURCE_INVALID: ${message}`), { code: 'SKILL_GRAPH_SOURCE_INVALID' });

const spanSchema = { type: 'object', additionalProperties: false, required: ['start', 'end'],
  properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } };
export const SKILL_SOURCE_INTERPRETATION_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['normativity', 'scope', 'reason', 'currentDutySpans', 'externalConditions', 'contextSpans', 'remainderDisposition', 'remainderReason'], properties: {
    normativity: { type: 'string', enum: ['MANDATORY', 'PROHIBITED', 'ADVISORY', 'PERMISSION', 'DESCRIPTION', 'MIXED', 'UNCERTAIN'] },
    scope: { type: 'string', enum: ['CURRENT_TASK', 'INTERNAL_BRANCH', 'EXTERNAL_TRIGGER', 'COMPOUND', 'UNCERTAIN'] },
    reason: { type: 'string', minLength: 1 },
    remainderDisposition: { type: 'string', enum: ['CONTEXT_ONLY', 'UNCERTAIN'] },
    remainderReason: { type: 'string', minLength: 1 },
    sourceOwnership: { type: 'object', additionalProperties: false, required: ['kind', 'ownedSpans'], properties: {
      kind: { type: 'string', enum: ['BODY', 'HEADING_SCOPE'] }, ownedSpans: { type: 'array', minItems: 1, items: spanSchema } } },
    currentDutySpans: { type: 'array', maxItems: 100, items: spanSchema },
    contextSpans: { type: 'array', maxItems: 200, items: spanSchema },
    externalConditions: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
      required: ['condition', 'duty', 'verificationTarget'], properties: { condition: spanSchema, duty: spanSchema,
        verificationTarget: { type: 'string', enum: ['PROCESS', 'IMPLEMENTATION', 'ARTIFACT'] } } } },
  } };

const quoteSchema = { type: 'object', additionalProperties: false, required: ['quote'],
  properties: { quote: { type: 'string', minLength: 1 } } };
// Model wire input is separate from canonical spans used by storage/reviewers.
export const SKILL_SOURCE_QUOTE_INTERPRETATION_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['normativity', 'scope', 'reason', 'currentDuties', 'externalConditions', 'remainderDisposition', 'remainderReason'], properties: {
    ...Object.fromEntries(['normativity', 'scope', 'reason', 'remainderDisposition', 'remainderReason']
      .map(key => [key, SKILL_SOURCE_INTERPRETATION_SCHEMA.properties[key]])),
    currentDuties: { type: 'array', maxItems: 100, items: quoteSchema },
    externalConditions: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
      required: ['condition', 'duty', 'verificationTarget'], properties: { condition: quoteSchema, duty: quoteSchema,
        verificationTarget: SKILL_SOURCE_INTERPRETATION_SCHEMA.properties.externalConditions.items.properties.verificationTarget } } },
  } };

export function bindSkillGraphFromQuotes(candidate, source) {
  const original = skillSourceUnits(source), byId = new Map(original.units.map(unit => [unit.id, unit]));
  if (!Array.isArray(candidate?.constraints)) throw graphError('A source-unit graph is required.');
  const constraints = candidate.constraints.map(node => {
    const unit = node.sourceUnitIds?.length === 1 && byId.get(node.sourceUnitIds[0]), input = node.interpretation;
    if (!unit) throw graphError('Exactly one known complete original unit is required.');
    const invalid = validateJsonSchema(input, SKILL_SOURCE_QUOTE_INTERPRETATION_SCHEMA);
    if (invalid.length) throw graphError(`SKILL_SOURCE_INTERPRETATION_REQUIRED: ${invalid[0].pointer}: ${invalid[0].message}`);
    const locate = ({ quote }) => {
      const start = unit.text.indexOf(quote);
      if (start < 0 || unit.text.indexOf(quote, start + 1) >= 0
        || Buffer.from(quote, 'utf8').toString('utf8') !== quote)
        throw graphError('Each quote must identify unique exact original UTF8 text within this source unit; ambiguous matches stay unresolved.');
      return { start, end: start + quote.length };
    };
    const currentDutySpans = input.currentDuties.map(locate), externalConditions = input.externalConditions.map(branch => ({
      condition: locate(branch.condition), duty: locate(branch.duty), verificationTarget: branch.verificationTarget }));
    const selected = [...currentDutySpans, ...externalConditions.flatMap(branch => [branch.condition, branch.duty])].sort((a, b) => a.start - b.start);
    const contextSpans = []; let through = 0;
    for (const span of selected) {
      if (through < span.start) contextSpans.push({ start: through, end: span.start });
      through = Math.max(through, span.end);
    }
    if (through < unit.text.length) contextSpans.push({ start: through, end: unit.text.length });
    return { ...node, interpretation: { normativity: input.normativity, scope: input.scope, reason: input.reason,
      currentDutySpans, externalConditions, contextSpans,
      remainderDisposition: input.remainderDisposition, remainderReason: input.remainderReason } };
  });
  // The same canonical binder still checks identity, full partition, semantic
  // consistency, surrogate boundaries and every original unit. A complement
  // supplies positions, never evidence that the remaining text is nonnormative.
  return bindSkillGraph({ ...candidate, constraints }, source);
}

export const skillConditionKey = item => item.conditionId == null ? item.constraintId
  : JSON.stringify([item.constraintId, item.conditionId]);

export function skillConditionalTargets(graph) {
  return (graph?.constraints ?? []).flatMap(node => {
    if (!node.sourceInterpretation) {
      if (graph?.sourceContract?.version === SKILL_SOURCE_CONTRACT_VERSION) throw graphError('A bound unit lacks its explicit source interpretation.');
      return node.applicabilityKind === 'CONDITIONAL' ? [node] : [];
    }
    return node.sourceInterpretation.externalConditions.map(branch => ({ ...node,
      conditionId: branch.conditionId, condition: node.sourceText.slice(branch.condition.start, branch.condition.end),
      statement: node.sourceText.slice(branch.duty.start, branch.duty.end), verificationTarget: branch.verificationTarget,
      applicabilityKind: 'CONDITIONAL' }));
  });
}

// These units locate complete originals; their order never creates a workflow
// prerequisite. Long units stay intact and are read through existing paging.
export function skillSourceUnits(source) {
  if (!source || source.truncated || !Array.isArray(source.files)) throw graphError('Complete captured Skill sources are required.');
  const units = [];
  for (const file of source.files) {
    const text = file.content;
    if (typeof text !== 'string' || Buffer.from(text, 'utf8').toString('utf8') !== text || text.includes('\0')
      || sha256(text) !== file.sha256) throw graphError('Original source bytes/hash are unavailable.');
    // Captured helpers/examples remain readable original context. Their source
    // code is not a collection of adopted main-task workflow instructions.
    if (file.path !== 'SKILL.md') continue;
    const lines = text.split('\n'), headings = [], headingContexts = new Map(), coveredHeadings = new Set();
    const retainUnownedHeading = heading => {
      if (coveredHeadings.has(heading.line)) return;
      // Every heading has one selectable owner. Preserve its whole section as
      // qualification/context, while independent body duties retain their own
      // units. Markdown shape never determines normative force.
      let end = heading.line, fence = null;
      for (let next = heading.line; next < lines.length; next++) {
        const marker = /^\s*(`{3,}|~{3,})/u.exec(lines[next]);
        if (marker && !fence) fence = marker[1];
        else if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        const following = !fence && /^(#{1,6})\s+/u.exec(lines[next]);
        if (following && following[1].length <= heading.level) break;
        if (lines[next].trim()) end = next + 1;
      }
      const identity = { file: file.path, sha256: file.sha256, start: heading.line, end,
        headings: headingContexts.get(heading.line) ?? [], kind: 'HEADING_SCOPE',
        ownedSpans: [{ start: 0, end: heading.text.length }] };
      units.push({ id: `skill-unit-${sha256(identity).slice(0, 24)}`, ...identity, text: lines.slice(heading.line - 1, end).join('\n') });
      coveredHeadings.add(heading.line);
    };
    let index = 0;
    if (lines[0]?.trim() === '---') {
      index = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
      if (index < 0) throw graphError('Unclosed source frontmatter.');
      index++;
    }
    while (index < lines.length) {
      if (!lines[index].trim()) { index++; continue; }
      const heading = /^(#{1,6})\s+(.+)$/u.exec(lines[index]);
      if (heading) {
        for (const previous of headings.filter(h => h.level >= heading[1].length)) retainUnownedHeading(previous);
        while (headings.length && headings.at(-1).level >= heading[1].length) headings.pop();
        headingContexts.set(index + 1, headings.map(h => ({ ...h })));
        const own = { level: heading[1].length, line: index + 1, text: lines[index] };
        retainUnownedHeading(own);
        headings.push(own); index++; continue;
      }
      const start = index; let fence = null;
      do {
        const marker = /^\s*(`{3,}|~{3,})/u.exec(lines[index]);
        if (marker && !fence) fence = marker[1];
        else if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        index++;
      } while (index < lines.length && (fence || lines[index].trim() && !/^#{1,6}\s/u.test(lines[index])));
      if (fence) throw graphError('Unclosed original fenced block.');
      const body = lines.slice(start, index).join('\n'), context = headings.map(h => ({ ...h }));
      for (const heading of context) coveredHeadings.add(heading.line);
      const identity = { file: file.path, sha256: file.sha256, start: start + 1, end: index, headings: context };
      if (/^\s*(?:`{3,}|~{3,})/u.test(body)) {
        const parent = units.at(-1);
        if (parent?.file === file.path && sha256(parent.headings) === sha256(context)) {
          parent.text = lines.slice(parent.start - 1, identity.end).join('\n'); parent.end = identity.end;
          parent.id = `skill-unit-${sha256({ ...identity, start: parent.start }).slice(0, 24)}`;
          continue;
        }
        // A heading may adopt this block as a required step or mark it as an
        // example. Preserve an unmerged original block for semantic review;
        // source coverage neither drops it nor decides its normative force.
      }
      units.push({ id: `skill-unit-${sha256(identity).slice(0, 24)}`, ...identity, text: body });
    }
    for (const heading of headings) retainUnownedHeading(heading);
  }
  units.sort((a, b) => a.start - b.start);
  return { version: SKILL_SOURCE_CONTRACT_VERSION, sourceDigest: source.digest, units };
}

export function bindSkillGraph(candidate, source) {
  const original = skillSourceUnits(source), byId = new Map(original.units.map(unit => [unit.id, unit]));
  if (!Array.isArray(candidate?.constraints) || !Array.isArray(candidate.taskOverlays ?? [])) throw graphError('A source-unit graph is required.');
  if ((candidate.taskOverlays ?? []).length) throw graphError('Derived task overlays cannot add Skill authority. Retain task obligations in their original ledger.');
  const seen = new Set();
  const constraints = candidate.constraints.map((value, index) => {
    const ids = value.sourceUnitIds;
    if (Object.keys(value).some(key => !['constraintId', 'sourceUnitIds', 'label', 'interpretation'].includes(key)))
      throw graphError('Bind original units and explicit semantic interpretations; derived statements or prerequisites are not accepted.');
    if (!Array.isArray(ids) || ids.length !== 1) throw graphError('Exactly one complete original unit is required per interpretation.');
    const selected = ids.map(id => byId.get(id));
    if (selected.some(unit => !unit)) throw graphError('Unknown source unit.');
    if (selected[0] !== original.units[index]) throw graphError('Original units cannot be skipped or reordered.');
    const positions = selected.map(unit => original.units.indexOf(unit));
    if (positions.some((p, i) => i && p !== positions[i - 1] + 1)) throw graphError('Original units cannot be skipped or reordered.');
    for (const id of ids) { if (seen.has(id)) throw graphError('An original unit already has a graph owner.'); seen.add(id); }
    const first = selected[0], text = first.text;
    const headings = [...new Set(selected.flatMap(unit => unit.headings.map(h => h.text)))];
    const interpretation = value.interpretation;
    if (!interpretation || Object.keys(interpretation).some(key => !Object.hasOwn(SKILL_SOURCE_INTERPRETATION_SCHEMA.properties, key))
      || !SKILL_SOURCE_INTERPRETATION_SCHEMA.properties.normativity.enum.includes(interpretation.normativity)
      || !SKILL_SOURCE_INTERPRETATION_SCHEMA.properties.scope.enum.includes(interpretation.scope)
      || typeof interpretation.reason !== 'string' || !interpretation.reason.trim() || !Array.isArray(interpretation.currentDutySpans)
      || !Array.isArray(interpretation.externalConditions) || !Array.isArray(interpretation.contextSpans)
      || !SKILL_SOURCE_INTERPRETATION_SCHEMA.properties.remainderDisposition.enum.includes(interpretation.remainderDisposition)
      || typeof interpretation.remainderReason !== 'string' || !interpretation.remainderReason.trim())
      throw graphError('SKILL_SOURCE_INTERPRETATION_REQUIRED: every complete unit needs an explicit semantic interpretation.');
    if (interpretation.normativity === 'UNCERTAIN' || interpretation.scope === 'UNCERTAIN' || interpretation.remainderDisposition === 'UNCERTAIN')
      throw Object.assign(graphError('SKILL_SOURCE_INTERPRETATION_UNRESOLVED: preserve uncertainty instead of manufacturing or excluding a duty.'), { code: 'SKILL_SOURCE_INTERPRETATION_UNRESOLVED' });
    const checkSpan = span => {
      if (!span || Object.keys(span).some(key => !['start', 'end'].includes(key)) || !Number.isSafeInteger(span.start)
        || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length
        || Buffer.from(text.slice(span.start, span.end), 'utf8').toString('utf8') !== text.slice(span.start, span.end))
        throw graphError('Interpretation spans must address exact nonempty original UTF8 text.');
      return { start: span.start, end: span.end };
    };
    const currentDutySpans = interpretation.currentDutySpans.map(checkSpan), contextSpans = interpretation.contextSpans.map(checkSpan),
      externalConditions = interpretation.externalConditions.map(branch => {
      if (!branch || Object.keys(branch).some(key => !['condition', 'duty', 'verificationTarget'].includes(key))
        || !['PROCESS', 'IMPLEMENTATION', 'ARTIFACT'].includes(branch.verificationTarget))
        throw graphError('An external branch requires exact original condition/duty spans and an explicit proof subject.');
      const condition = checkSpan(branch.condition), duty = checkSpan(branch.duty);
      return { conditionId: `condition-${sha256([first.id, condition, duty]).slice(0, 24)}`, condition, duty, verificationTarget: branch.verificationTarget };
    });
    const sourceOwnership = { kind: first.kind ?? 'BODY', ownedSpans: first.ownedSpans ?? [{ start: 0, end: text.length }] };
    if (interpretation.sourceOwnership && sha256(interpretation.sourceOwnership) !== sha256(sourceOwnership))
      throw graphError('Original source ownership cannot be replaced by a derived proposal.');
    if (sourceOwnership.kind === 'HEADING_SCOPE' && [...currentDutySpans, ...externalConditions.map(branch => branch.duty)]
      .some(span => !sourceOwnership.ownedSpans.some(owner => owner.start <= span.start && owner.end >= span.end)))
      throw graphError('A heading scope owns only its original heading duty; independent body duties have their own original owner.');
    if (new Set(externalConditions.map(c => c.conditionId)).size !== externalConditions.length) throw graphError('Duplicate external condition.');
    const spans = [...currentDutySpans, ...contextSpans, ...externalConditions.flatMap(c => [c.condition, c.duty])].sort((a, b) => a.start - b.start);
    let through = 0;
    for (const span of spans) {
      if (span.start !== through) throw graphError('Interpretation spans overlap or leave original text uncovered (JS UTF16 offsets).');
      through = span.end;
    }
    if (through !== text.length) throw graphError('Interpretation spans must cover the complete original unit, including context.');
    const hard = ['MANDATORY', 'PROHIBITED', 'MIXED'].includes(interpretation.normativity);
    if (!hard && (currentDutySpans.length || externalConditions.length || interpretation.scope !== 'CURRENT_TASK')
      || hard && !currentDutySpans.length && !externalConditions.length
      || ['CURRENT_TASK', 'INTERNAL_BRANCH'].includes(interpretation.scope) && externalConditions.length
      || interpretation.scope === 'EXTERNAL_TRIGGER' && (currentDutySpans.length || externalConditions.length !== 1)
      || interpretation.scope === 'COMPOUND' && (!externalConditions.length || !currentDutySpans.length && externalConditions.length < 2))
      throw graphError('Normativity, current duties and external trigger coverage conflict; uncertain scopes must remain unresolved.');
    const sourceInterpretation = { normativity: interpretation.normativity, scope: interpretation.scope,
      reason: interpretation.reason, currentDutySpans, externalConditions, contextSpans,
      remainderDisposition: interpretation.remainderDisposition, remainderReason: interpretation.remainderReason, sourceOwnership };
    const modality = { MANDATORY: 'MUST', MIXED: 'MUST', PROHIBITED: 'PROHIBITED', ADVISORY: 'SHOULD', PERMISSION: 'MAY', DESCRIPTION: 'MAY' }[interpretation.normativity];
    const sourceContextFiles = source.files.filter(file => file.path !== 'SKILL.md' && (text.includes(file.path)
      || source.files.filter(other => path.basename(other.path) === path.basename(file.path)).length === 1
        && text.includes(path.basename(file.path)))).map(file => file.path);
    return { constraintId: value.constraintId ?? `source-${index}`, kind: modality === 'PROHIBITED' ? 'PROHIBITION' : 'STEP',
      modality,
      statement: [...headings, text].join('\n\n'), condition: interpretation.scope === 'CURRENT_TASK' ? null : text,
      applicabilityKind: interpretation.scope === 'EXTERNAL_TRIGGER' ? 'CONDITIONAL' : 'CURRENT_TASK', dependsOn: [], inputs: [], outputs: [],
      sourceRef: `${first.file}#L${first.start}-L${selected.at(-1).end}`,
      sourceUnitIds: ids, sourceBinding: sha256(selected), sourceContextFiles, sourceText: text, sourceInterpretation };
  });
  // No source unit is silently excluded by graph selection. Metadata/headings
  // are context, but every captured body unit retains an original owner.
  if (seen.size !== original.units.length) throw graphError('Some original body units have no graph owner.');
  if (new Set(constraints.map(c => c.constraintId)).size !== constraints.length) throw graphError('Duplicate parent constraint identity.');
  return { constraints, taskOverlays: [], sourceContract: { version: SKILL_SOURCE_CONTRACT_VERSION,
    sourceDigest: source.digest, ...(source.identity ? { sourceIdentity: source.identity } : {}),
    digest: sha256(source.identity ? { constraints: constraints.map(c => [c.sourceUnitIds, c.sourceBinding, c.sourceInterpretation]),
      sourceIdentity: source.identity } : constraints.map(c => [c.sourceUnitIds, c.sourceBinding, c.sourceInterpretation])) } };
}


function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}


export function selectedSkill(skillId, selection) {
  if (!selection) return false;
  if ((selection.exclude ?? []).some((pattern) => globToRegExp(pattern).test(skillId))) return false;
  if (selection.mode === "all") return true;
  return (selection.include ?? []).some((pattern) => globToRegExp(pattern).test(skillId));
}


export function skillIdFromInput(input) {
  const raw = input?.tool_input?.skill
    ?? input?.tool_input?.name
    ?? input?.tool_input?.command
    ?? input?.tool_input?.skill_name;
  if (typeof raw !== "string") return null;
  return raw.trim().replace(/^\//, "") || null;
}


export function retainedSkillSourceIdentity(task, skillId) {
  const watchers = Object.values(task.watchers ?? {}).filter(watcher => watcher.skillId === skillId && watcher.sourceIdentity);
  return (watchers.find(watcher => watcher.status === 'ACTIVE' || watcher.pendingSelection) ?? watchers.at(-1))?.sourceIdentity
    ?? task.groundTruth?.sharedBasis?.adoptedSkills?.find(skill => skill.skillId === skillId)?.sourceIdentity ?? null;
}


async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}


export async function* skillDirectories(root, { maxDirectories = 2000, maxDepth = 6 } = {}) {
  const visited = new Set(), pluginLinks = path.basename(root).toLowerCase() === 'plugin-skills'; let count = 0, canonicalRoot;
  async function* visit(directory, relative, depth) {
    let real;
    try { real = await fs.realpath(directory); if (!(await fs.stat(real)).isDirectory()) return; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return; throw error; }
    canonicalRoot ??= real;
    if (!pluginLinks && !isPathInside(canonicalRoot, real)) return;
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (visited.has(key) || count++ >= maxDirectories) return;
    visited.add(key);
    const file = path.join(real, 'SKILL.md');
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024) {
      const bytes = await fs.readFile(file), frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(bytes.toString('utf8'));
      const nameLine = frontmatter && /^name:\s*([^\r\n]+)$/mu.exec(frontmatter[1]);
      let name;
      try { if (nameLine) name = parseSimpleYaml(`name: ${nameLine[1]}`).name; } catch {}
      yield { skillId: typeof name === 'string' && name.trim() ? name.trim() : relative || path.basename(real),
        directory: real, sourceIdentity: { path: await fs.realpath(file), sha256: sha256(bytes) } };
      return;
    }
    if (depth >= maxDepth) return;
    const entries = await fs.readdir(real, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
      yield* visit(path.join(real, entry.name), relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
    }
  }
  yield* visit(path.resolve(root), '', 0);
}


export async function resolveSkillDirectory({
  skillId,
  projectRoot,
  pluginRoot,
  configuredRoots = [],
  hostAdapter = activeHost,
  sourceIdentity = null,
  hostOptions = {},
}) {
  if (!skillId) return null;
  if (sourceIdentity) {
    if (typeof sourceIdentity.path !== 'string' || !path.isAbsolute(sourceIdentity.path)
      || path.basename(sourceIdentity.path) !== 'SKILL.md' || !/^[a-f0-9]{64}$/u.test(sourceIdentity.sha256 ?? '')) return null;
    try {
      const file = await fs.realpath(sourceIdentity.path);
      if (path.relative(file, sourceIdentity.path) || sha256(await fs.readFile(file)) !== sourceIdentity.sha256) return null;
      return path.dirname(file);
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  }
  const shortId = skillId.split(":").at(-1);
  const local = hostAdapter.localSkillRoots({ projectRoot, pluginRoot, homeDirectory: os.homedir(), ...hostOptions });
  const roots = [
    ...(hostAdapter.host === 'openclaw' ? [...local, ...configuredRoots] : [...configuredRoots, ...local]),
  ].filter(Boolean).map((root) => path.resolve(root));
  for (const root of roots) {
    if (hostAdapter.host === 'openclaw') {
      for await (const source of skillDirectories(root)) if ([skillId, shortId].includes(source.skillId)) return source.directory;
      continue;
    }
    for (const name of [skillId, shortId]) {
      const candidate = path.resolve(root, name);
      if (!isPathInside(root, candidate)) continue;
      if (await isDirectory(candidate)) return candidate;
    }
  }
  return null;
}


function sensitive(fileName) {
  const lower = fileName.toLowerCase();
  return SENSITIVE_NAMES.has(lower)
    || lower.includes("secret")
    || lower.endsWith(".pem")
    || lower.endsWith(".key");
}

export function isSkillSourceFile(fileName) {
  return !sensitive(fileName) && (TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase()) || fileName === "SKILL.md");
}


export async function scanSkillDirectory(directory, { maxFiles = 200, maxBytes = 2 * 1024 * 1024, cache = true, sourceIdentity = null } = {}) {
  if (![maxFiles, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid Skill scan budget.");
  const root = await fs.realpath(directory);
  const cacheKey = JSON.stringify([root, maxFiles, maxBytes]);
  const previous = cache ? scanCache.get(cacheKey) : null;
  const next = new Map();
  const files = [];
  const stats = { directories: 0, filesRead: 0, cacheHits: 0, bytesRead: 0 };
  let totalBytes = 0, truncated = false;
  async function visit(current) {
    stats.directories++;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => Number(right.name === "SKILL.md") - Number(left.name === "SKILL.md") || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (sensitive(entry.name) || IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
      if (files.length >= maxFiles) { truncated = true; return; }
      const candidate = path.join(current, entry.name);
      const resolved = await fs.realpath(candidate);
      if (!isPathInside(root, resolved)) continue;
      if (entry.isDirectory()) {
        await visit(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && entry.name !== "SKILL.md") continue;
      const before = await fs.stat(resolved, { bigint: true });
      if (before.size > BigInt(maxBytes - totalBytes)) { truncated = true; continue; }
      const stamp = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
      const cached = previous?.get(resolved);
      const contents = cached?.stamp === stamp ? cached.contents : await fs.readFile(resolved);
      if (cached?.stamp === stamp) stats.cacheHits++;
      else { stats.filesRead++; stats.bytesRead += contents.length; }
      const after = await fs.stat(resolved, { bigint: true });
      if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== stamp)
        throw Object.assign(new Error("Skill source changed during scan."), { code: "SKILL_SOURCE_STALE" });
      if (contents.includes(0)) continue;
      if (totalBytes + contents.length > maxBytes) { truncated = true; continue; }
      next.set(resolved, { stamp, contents });
      totalBytes += contents.length;
      files.push({
        path: path.relative(root, resolved).replaceAll("\\", "/"),
        bytes: contents.length,
        sha256: sha256(contents),
        content: contents.toString("utf8"),
      });
    }
  }
  await visit(root);
  if (sourceIdentity && (path.relative(path.join(root, 'SKILL.md'), sourceIdentity.path)
    || files.find(file => file.path === 'SKILL.md')?.sha256 !== sourceIdentity.sha256))
    throw Object.assign(new Error('The original Skill read is no longer current.'), { code: 'SKILL_SOURCE_STALE' });
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (cache) {
    scanCache.delete(cacheKey); scanCache.set(cacheKey, next);
    while (scanCache.size > 16) scanCache.delete(scanCache.keys().next().value);
  }
  return {
    root,
    ...(sourceIdentity ? { identity: structuredClone(sourceIdentity) } : {}),
    files,
    totalBytes,
    digest: sha256(files.map(({ path: filePath, bytes, sha256: digest }) => ({
      path: filePath,
      bytes,
      sha256: digest,
    }))),
    truncated,
    stats,
  };
}
