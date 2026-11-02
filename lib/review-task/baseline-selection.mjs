import { validateJsonSchema } from '../json-schema-validator.mjs';
import { createHash } from 'node:crypto';

const sharedFields = ['operation', 'category', 'authority', 'severity', 'applicabilityKind', 'verificationTarget', 'implementationRole'];
const sourceFromSchema = { type: 'object', additionalProperties: false, required: ['unitId'], properties: {
  unitId: { type: 'string', pattern: '^S[0-9]+L[1-9][0-9]*$' } },
  description: 'Select one complete current original sourceUnit as synthesis proof. Supply scoped text and explicit semantic metadata; the program binds source/current receipts. No source/textFrom/bindings.' };
export function baselineScopeFailure(message, validation) {
  return Object.assign(new Error(`${message} ${validation.repair}`), {
    code: 'BASELINE_SCOPE_INVALID', baselineValidation: { ...validation, message },
  });
}
function assertBaselineProofOwner(value, unitId, sourceFrom = false) {
  if (!value.verificationTarget || sourceFrom && !Object.hasOwn(value, 'verificationTarget')
    || value.verificationTarget === 'IMPLEMENTATION' && (!value.implementationRole || sourceFrom && !Object.hasOwn(value, 'implementationRole')))
    throw baselineScopeFailure(`${unitId}: choose explicit verificationTarget and implementationRole for IMPLEMENTATION.`, {
      reason: 'PROOF_OWNER_REQUIRED', unitId,
      fields: !value.verificationTarget || sourceFrom && !Object.hasOwn(value, 'verificationTarget') ? ['verificationTarget'] : ['implementationRole'],
      repair: sourceFrom
        ? 'For sourceFrom, choose verificationTarget on EACH actual operation before defaults merge; IMPLEMENTATION also needs its own PRODUCTION, TEST or SUPPORT role. Keep batch defaults owner-free. Resubmit this unsaved batchId without changing the obligation.'
        : 'Choose the actual target from the original obligation; IMPLEMENTATION also needs PRODUCTION, TEST or SUPPORT. Set defaults or the affected unit/group/operation metadata, then resubmit this unsaved batchId. Do not change the requirement to satisfy metadata validation.',
    });
  if (value.verificationTarget !== 'IMPLEMENTATION' && Object.hasOwn(value, 'implementationRole'))
    throw baselineScopeFailure(`${unitId}: ${value.verificationTarget} must omit implementationRole.`, {
      reason: 'NON_IMPLEMENTATION_ROLE', unitId, fields: ['implementationRole'],
      repair: sourceFrom
        ? 'For sourceFrom, PROCESS/ARTIFACT must omit implementationRole on that operation. Choose each real owner explicitly, keep defaults owner-free and preserve the obligation; never change its target just to pass validation.'
        : 'Remove implementationRole from shared defaults and from PROCESS/ARTIFACT metadata. Put the chosen role only on the IMPLEMENTATION operation, per-unit override or split-group metadata, or use separate batches. Resubmit this unsaved batchId; do not change the actual verificationTarget to pass validation.',
    });
}
export function sourceUnits(identity) {
  if (!identity.sources.length || identity.sources.some(source => source.parts.length !== 1 || source.clauseIndexPartial)) return [];
  const units = identity.sources.flatMap(source => Object.entries(source.clauseCounts ?? {}).filter(([, count]) => count !== 0)
    .map(([line, clauses]) => ({ id: `S${identity.sourceCatalog.findIndex(item => item.ref === source.ref)}L${line}`,
      sourceIndex: identity.sourceCatalog.findIndex(item => item.ref === source.ref), line: Number(line), clauses })));
  return units.length <= 200 ? units : [];
}

export function sourceUnitNavigation(identity, texts, units = sourceUnits(identity)) {
  const sourceUnits = units.map(({ id, clauses }) => ({ id, clauses }));
  const unavailable = reason => ({ sourceUnits, sourceUnitNavigation: { navigationOnly: true, complete: false, reason } });
  if (!units.length || !(texts instanceof Map)) return unavailable('frozen_text_unavailable');
  const mapped = [], lines = new Map();
  for (const unit of units) {
    const catalog = identity.sourceCatalog[unit.sourceIndex];
    const source = identity.sources.find(item => item.ref === catalog?.ref);
    const bytes = texts.get(catalog?.ref);
    if (!source || source.kind !== catalog.kind || !Buffer.isBuffer(bytes)) return unavailable('frozen_text_unavailable');
    if (!Number.isInteger(unit.clauses)) return unavailable('ambiguous_clauses');
    if (!lines.has(source.ref)) {
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) return unavailable('frozen_text_mismatch');
      lines.set(source.ref, bytes.toString('utf8').split('\n'));
    }
    const text = lines.get(source.ref)[unit.line - 1];
    if (text === undefined) return unavailable('clause_index_mismatch');
    let clauses;
    try { clauses = sourceClauses(text); } catch { return unavailable('ambiguous_clauses'); }
    if (clauses.length !== unit.clauses) return unavailable('clause_index_mismatch');
    mapped.push({ id: unit.id, clauses: unit.clauses, kind: catalog.kind,
      clauseMap: clauses.map((text, index) => ({ index, text })) });
    if (Buffer.byteLength(JSON.stringify({ sourceUnits: mapped, sourceUnitNavigation: { navigationOnly: true, complete: true } })) > 2048)
      return unavailable('budget');
  }
  return { sourceUnits: mapped, sourceUnitNavigation: { navigationOnly: true, complete: true } };
}

export function draftBaselineSchema(schema) {
  const properties = structuredClone(schema.properties.operations.items.properties);
  properties.applicabilityKind.description = 'sourceFrom requires a choice on EACH raw operation before defaults merge. This selects a review route, never proves activation or fulfillment. Preserve original conditions and internal implementation branches.';
  properties.verificationTarget.description = 'Choose the actual proof owner before saving; never inferred.';
  properties.implementationRole.description = 'IMPLEMENTATION requires explicit PRODUCTION, TEST or SUPPORT. Omit for PROCESS/ARTIFACT.';
  const metadata = { type: 'object', additionalProperties: false, properties: Object.fromEntries([...sharedFields.filter(name => name !== 'operation'), 'applicability', 'expectedFiles']
    .map(name => [name, properties[name]])) };
  const ids = { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: { type: 'string', pattern: '^S[0-9]+L[1-9][0-9]*$' } };
  const synthesis = structuredClone(schema.properties.operations.items);
  delete synthesis.properties.source; delete synthesis.properties.claimId;
  synthesis.properties.operation = { type: 'string', enum: ['ADD'] };
  synthesis.properties.sourceFrom = sourceFromSchema;
  synthesis.required = ['text', 'sourceFrom', 'verificationTarget', 'applicabilityKind'];
  return { type: 'object', additionalProperties: false, required: ['batchId'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    fullTextReason: { type: 'string', minLength: 1, maxLength: 500, description: 'MODE SWITCH ONLY for existing-claim revisions or unsupported selections. Mixed owners can use operations+sourceFrom in this draft batch. Supply ONLY batchId and fullTextReason; same session/deadline/receipts, not an explanation field.' },
    defaults: { type: 'object', additionalProperties: false, required: ['category', 'authority', 'severity'],
      description: 'A sourceFrom batch must omit applicabilityKind, verificationTarget and implementationRole here. Legacy-only draft defaults still require applicabilityKind; actual effective metadata remains validated.',
      properties: Object.fromEntries(sharedFields.filter(name => name !== 'operation').map(name => [name, properties[name]])) },
    overrides: { type: 'array', maxItems: 200, description: 'Per-unit metadata overriding defaults. A unit listed only here is kept whole. IMPLEMENTATION needs implementationRole. Group metadata overrides this for split workflows.', items: {
      type: 'object', additionalProperties: false, required: ['unit', 'metadata'], properties: { unit: { type: 'string' }, metadata },
    } },
    keep: { ...ids, minItems: 0, description: 'ADD an original unit as ONE claim only with ONE evidence owner. This is not retention of existing claims. Mixed owners use scoped operations+sourceFrom, not keep. Program-preserved units already have decisions. Empty/defaults make no decision.' },
    operations: { type: 'array', maxItems: schema.properties.operations.maxItems ?? 200, items: synthesis,
      description: 'Scoped ADD synthesis: text + sourceFrom:{unitId}. EACH operation chooses applicabilityKind and verificationTarget; IMPLEMENTATION also chooses its own role, PROCESS/ARTIFACT omit role. Defaults omit all three fields. Multiple obligations may share a complete original. No source/textFrom/bindings; program binds originals, not semantic correctness or activation.' },
    split: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['unit', 'groups'], properties: {
      unit: { type: 'string' }, groups: { type: 'array', minItems: 2, maxItems: 32, description: 'Distinct workflows or owners at faithful existing clause boundaries; partition ALL indices exactly once. Preserve conditions/exceptions. If owners share ONE clause, use operations+sourceFrom in this same batch; never alter punctuation.', items: {
        type: 'object', additionalProperties: false, required: ['name', 'clauses'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 },
          clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 } }, metadata },
      } } } } },
    merge: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['name', 'units'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 }, units: { ...ids, minItems: 2, description: 'Consecutive nonblank units with the same workflow AND evidence owner. Intervening blanks remain; never skip a nonblank unit or merge heterogeneous owners.' }, metadata,
    } } },
    exclude: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['units', 'reason'], properties: {
      units: ids, reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Only unadopted MATERIAL/PROJECT_FILE context or a whole user original exactly matching one current USER_EXPLICIT USER_MESSAGE claim after trimming outer whitespace. Partial/semantic overlap is insufficient. Keep new duties with sourceFrom; use full mode for true existing-claim revisions, never broaden exclusions.' },
      claimIds: { type: 'array', minItems: 1, uniqueItems: true, maxItems: 200, items: { type: 'string', minLength: 1 }, description: 'Actual current ledger IDs, all must exist. At least ONE referenced USER_EXPLICIT USER_MESSAGE claim must contain the exact whole original unit text (outer whitespace ignored); a paraphrase, partial coverage or a reason is not proof.' },
    } } },
  } };
}

export function expandDraftBatch(value, units, classified = new Set(), validateExclusion) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'BASELINE_SCOPE_INVALID' }); };
  const index = new Map(units.map(unit => [unit.id, unit])), positions = new Map(units.map((unit, order) => [unit.id, order]));
  const decisions = [], seen = new Set(), operations = [], overrides = new Map();
  for (const item of value.overrides ?? []) {
    if (!index.has(item.unit) || overrides.has(item.unit)) fail('Metadata overrides need distinct known unit IDs');
    overrides.set(item.unit, item.metadata);
  }
  function take(ids, action, reason) {
    if (!ids?.length) fail('An explicit source-unit decision is required');
    const selected = ids.map(id => {
      if (!index.has(id)) fail(`Unknown source unit ${id}`);
      if (seen.has(id) || classified.has(id)) fail(`Source unit ${id} already classified; retry identical batch or use a new unclassified unit`);
      seen.add(id); return index.get(id);
    });
    decisions.push({ action, units: ids, ...(reason ? { reason } : {}) }); return selected;
  }
  function add(unit, name, end = unit.line, clauses, metadata) {
    const fields = { ...overrides.get(unit.id), ...metadata };
    const effective = { ...value.defaults, ...fields };
    assertBaselineProofOwner(effective, unit.id);
    (decisions.at(-1).operationIndices ??= []).push(operations.length);
    operations.push({ ...fields, outcome: name, textFrom: { sourceIndex: unit.sourceIndex, start: unit.line, end, ...(clauses ? { clauses } : {}) } });
  }
  for (const id of value.keep ?? []) { const [unit] = take([id], 'KEEP'); add(unit, id); }
  const explicitlyClassified = new Set([...(value.keep ?? []), ...(value.split ?? []).map(item => item.unit),
    ...(value.merge ?? []).flatMap(item => item.units), ...(value.exclude ?? []).flatMap(item => item.units)]);
  for (const id of overrides.keys()) if (!explicitlyClassified.has(id)) { const [unit] = take([id], 'KEEP'); add(unit, id); }
  for (const item of value.split ?? []) {
    const [unit] = take([item.unit], 'SPLIT');
    if (!Number.isInteger(unit.clauses)) fail(`${unit.id} has ambiguous punctuation; keep the entire line or request full text`);
    const indices = item.groups.flatMap(group => group.clauses).sort((a, b) => a - b);
    if (indices.length !== unit.clauses || indices.some((n, i) => n !== i)) fail(`Split ${unit.id} must partition ALL clauses 0..${unit.clauses - 1} exactly once`);
    for (const group of item.groups) add(unit, group.name, unit.line, group.clauses, group.metadata);
  }
  for (const item of value.merge ?? []) {
    const selected = take(item.units, 'MERGE');
    if (selected.some((unit, i) => unit.sourceIndex !== selected[0].sourceIndex || i && positions.get(unit.id) !== positions.get(selected[i - 1].id) + 1))
      fail('Merge requires consecutive nonblank source units in source order within one source');
    const effective = selected.map(unit => ({ ...value.defaults, ...overrides.get(unit.id), ...item.metadata }));
    if (effective.some(fields => Object.keys({ ...fields, ...effective[0] }).some(key => fields[key] !== effective[0][key]))) fail('Merged units need identical effective metadata; split different proof owners');
    add(selected[0], item.name, selected.at(-1).line, undefined, item.metadata);
  }
  for (const item of value.exclude ?? []) {
    const selected = take(item.units, 'EXCLUDE', item.reason);
    if (!validateExclusion) fail('Exclusion requires current baseline/source validation');
    for (const unit of selected) validateExclusion(unit, item);
    if (item.claimIds) decisions.at(-1).claimIds = item.claimIds;
  }
  const inline = value.operations ?? [], grouped = new Map();
  for (const [index, operation] of inline.entries()) {
    if (!operation.sourceFrom?.unitId || Object.hasOwn(operation, 'textFrom') || Object.hasOwn(operation, 'source')
      || operation.operation != null && operation.operation !== 'ADD') fail('Draft synthesis requires text + sourceFrom:{unitId}; use full mode for existing-claim revisions.');
    const id = operation.sourceFrom.unitId;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(operations.length + index);
  }
  for (const [id, operationIndices] of grouped) {
    take([id], 'SYNTHESIZE'); decisions.at(-1).operationIndices = operationIndices;
  }
  operations.push(...inline);
  if (!decisions.length) fail('Classify source units with keep/split/merge/exclude or scoped operations+sourceFrom; fullTextReason is only a fallback mode switch');
  if ([...overrides.keys()].some(id => !seen.has(id) || decisions.some(item => item.action === 'EXCLUDE' && item.units.includes(id)))) fail('Metadata override has no candidate operation in this batch');
  if (operations.length > inline.length && !value.defaults) fail('Explicit metadata defaults are required for claims');
  return { batchId: value.batchId, defaults: { ...value.defaults, operation: 'ADD' }, operations, decisions };
}
export function compactBaselineSchema(schema) {
  const properties = structuredClone(schema.properties.operations.items.properties);
  delete properties.applicabilityKind.description;
  const metadata = Object.fromEntries(Object.entries(properties).filter(([name]) => !['text', 'source'].includes(name)));
  return { type: 'object', additionalProperties: false, required: ['batchId'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    fullTextReason: { type: 'string', minLength: 1, maxLength: 500, description: 'Compact wire has exact outcomes only. Request full mode for unsupported synthesis/revisions, then prefer sourceFrom for known units. Supply only batchId and this reason; same session/deadline/read receipts.' },
    defaults: { type: 'object', additionalProperties: false, required: ['operation', 'category', 'authority', 'severity', 'applicabilityKind'],
      properties: { sourceIndex: { type: 'integer', minimum: 0 }, ...Object.fromEntries(sharedFields.map(name => [name, properties[name]])) } },
    outcomes: { type: 'array', minItems: 1, maxItems: 200, description: 'One owner per exact original outcome, preserving all conditions/prohibitions. Finer mixed-owner synthesis is unsupported by compact outcomes: switch to full and use sourceFrom for a known unit.', items: {
      type: 'object', additionalProperties: false, required: ['name', 'lines'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        lines: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 }, description: '[start,end], inclusive. Part-local when file is given, otherwise ORIGINAL sourceIndex lines.' },
        clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 }, description: 'Optional existing top-level semicolon indices on ONE line, 0..count-1; distinct workflows or proof owners only when these boundaries preserve the actual obligations.' },
        sourceIndex: { type: 'integer', minimum: 0 },
        file: { type: 'string', minLength: 1, maxLength: 256, description: 'Current frozen source part; use its tool-visible local lines. Overrides defaults.sourceIndex; never combine with an outcome sourceIndex.' },
        metadata: { type: 'object', additionalProperties: false, properties: metadata, description: 'Override shared metadata only when this outcome differs; non-ADD requires its existing claimId.' },
      },
    } },
  } };
}

export function expandCompactBatch(value) {
  if (!value.defaults || !Array.isArray(value.outcomes) || !value.outcomes.length)
    throw Object.assign(new Error('Provide explicit defaults and a nonempty outcomes array, or request fullTextReason'), { code: 'BASELINE_SCHEMA_INVALID' });
  const { sourceIndex, ...defaults } = value.defaults;
  return { batchId: value.batchId, defaults, operations: value.outcomes.map(item => {
    if (!Array.isArray(item.lines) || item.lines.length !== 2)
      throw Object.assign(new Error('Each outcome needs lines:[start,end]'), { code: 'BASELINE_SCHEMA_INVALID' });
    if (item.file !== undefined && item.sourceIndex !== undefined)
      throw Object.assign(new Error('Choose an outcome file or sourceIndex, never both'), { code: 'BASELINE_SOURCE_INVALID' });
    return { ...item.metadata, outcome: item.name, textFrom: { ...(item.file !== undefined ? { file: item.file } : { sourceIndex: item.sourceIndex ?? sourceIndex }),
      start: item.lines[0], end: item.lines[1], ...(item.clauses ? { clauses: item.clauses } : {}) } };
  }) };
}
export function sourceClauses(text) {
  if (text.includes("'")) throw new Error('Ambiguous apostrophe/quote; use full-text mode');
  const pairs = new Map([['“', '”'], ['‘', '’'], ['"', '"'], ['(', ')'], ['（', '）'], ['[', ']'], ['【', '】']]);
  const quotes = new Set(['“', '‘', '"']), stack = [], clauses = [];
  const closers = new Set(['”', '’', ')', '）', ']', '】']);
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], top = stack.at(-1);
    if (top && char === top.end && text[index - 1] !== '\\') { stack.pop(); continue; }
    if (top?.quote) continue;
    if (closers.has(char)) throw new Error('Unbalanced quoted/nested punctuation; use full-text mode');
    if (pairs.has(char)) { stack.push({ end: pairs.get(char), quote: quotes.has(char) }); continue; }
    if (!stack.length && /[;；]/u.test(char)) { clauses.push(text.slice(start, index + 1)); start = index + 1; }
  }
  if (stack.length) throw new Error('Unbalanced quoted/nested punctuation; use full-text mode');
  clauses.push(text.slice(start)); return clauses;
}
export function baselineBatchSchema(schema) {
  const item = structuredClone(schema.properties.operations.items);
  item.required = [];
  item.description = 'Choose ONE of three encodings. Prefer scoped text+sourceFrom:{unitId} for known originals; program binds source/receipts, no source/textFrom/bindings. Legacy text+source+bindings is for unsupported selections. Exact copying uses short outcome+textFrom and no source. Semantic metadata remains explicit.';
  item.properties.text = { ...item.properties.text, description: 'Synthesis: accurate scoped obligation with sourceFrom, or legacy explicit source+bindings, NO textFrom. Exact textFrom copies need no text; any supplied text equals the captured original, not a semantic subset.' };
  item.properties.source = { ...item.properties.source, description: 'Legacy synthesis fallback ONLY: exact current catalog ref/range, kind and MAIN_TASK subject plus current bindings. For a known unit prefer sourceFrom and OMIT this field. Never mix with sourceFrom/textFrom.' };
  item.properties.claimId = { ...item.properties.claimId, description: 'For non-ADD only: exact claimId already present in current Ground Truth. Old notes or quoted descriptions are not ledger claim IDs. Do not invent IDs.' };
  if (item.properties.implementationRole) item.properties.implementationRole = { ...item.properties.implementationRole,
    description: 'sourceFrom: choose verificationTarget on each operation, and its own PRODUCTION/TEST/SUPPORT role only for IMPLEMENTATION; batch defaults must omit both owner fields. Legacy synthesis/exact selections retain effective metadata rules. No semantic owner is inferred or corrected.' };
  item.properties.outcome = { type: 'string', minLength: 1, maxLength: 100, description: 'Only textFrom needs this SHORT label, at most 100 characters. Synthesis with text/source/bindings does NOT need outcome. A label cannot separate mixed duties still combined in selected text; use synthesis for finer separation.' };
  item.properties.textFrom = { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: {
    file: { type: 'string', minLength: 1, maxLength: 256 },
    sourceIndex: { type: 'integer', minimum: 0 }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 },
    clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
  }, description: 'Exact-copy encoding: select WHOLE original lines by file+local start/end OR sourceIndex+original coordinates including crossing parts. Never both. Optional clauses are existing top-level semicolon indices on ONE line in original order. Finer mixed-owner synthesis uses text+sourceFrom for known units, legacy source+bindings only when unavailable. Preserve conditions/exceptions, never edit punctuation or paraphrase copied text. All selected bytes need genuine current reads.' };
  item.properties.sourceFrom = sourceFromSchema;
  item.properties.applicabilityKind = { ...item.properties.applicabilityKind,
    description: 'sourceFrom requires this field on EACH actual operation, never inherited. Choose the route from its complete original obligation and retain natural conditions; explicit choice does not prove semantic correctness, activation or fulfillment. Legacy-only encodings retain effective metadata rules.' };
  return { type: 'object', additionalProperties: false, required: ['batchId', 'operations'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    defaults: { type: 'object', additionalProperties: false, properties: Object.fromEntries(sharedFields.filter(key => item.properties[key]).map(key => [key, item.properties[key]])),
      description: 'Shared explicit metadata. If ANY operation uses sourceFrom, omit verificationTarget, implementationRole AND applicabilityKind here; each sourceFrom operation chooses its own owner and scope. Legacy-only batches retain effective metadata rules. No semantic choice or activation is inferred.' },
    operations: { ...structuredClone(schema.properties.operations), items: item },
    bindings: { type: 'array', description: 'Legacy text+source synthesis ONLY: each operation needs {operationIndex,citeIds} with current receipts covering its exact source/range. sourceFrom and textFrom capture their own bindings; omit explicit entries for them. Never invent IDs or reread acknowledged sources solely for citations.', items: { type: 'object', additionalProperties: false, required: ['operationIndex', 'citeIds'], properties: {
      operationIndex: { type: 'integer', minimum: 0 }, citeIds: { type: 'array', uniqueItems: true, maxItems: 256, items: { type: 'string' } },
    } } },
  } };
}

export function baselineBatchFailure(value, schema, wireIssues = [], { draft = false } = {}) {
  const failures = [], seen = new Set(); let first;
  const add = (error, pointer, message = error.baselineValidation?.message ?? error.message) => {
    first ??= error;
    const key = `${pointer}:${error.code}`;
    if (!seen.has(key)) { seen.add(key); failures.push({ pointer, code: error.code, message }); }
  };
  const invalid = message => Object.assign(new Error(message), { code: 'BASELINE_SCHEMA_INVALID' });
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const defaults = object(value?.defaults) ? value.defaults : {};
  const rawOperations = Array.isArray(value?.operations) ? value.operations : [];
  if (rawOperations.some(raw => object(raw) && Object.hasOwn(raw, 'sourceFrom'))) {
    for (const field of ['verificationTarget', 'implementationRole', 'applicabilityKind']) if (Object.hasOwn(defaults, field))
      add(baselineScopeFailure(field === 'applicabilityKind'
        ? 'A sourceFrom batch must choose applicabilityKind on each actual operation, not in defaults.'
        : 'A sourceFrom batch must choose each owner on its actual operation, not in defaults.', {
        reason: field === 'applicabilityKind' ? 'SOURCEFROM_APPLICABILITY_DEFAULT' : 'SOURCEFROM_OWNER_DEFAULT', fields: [field],
        repair: 'Keep applicable category/authority/severity defaults, but remove verificationTarget, implementationRole and applicabilityKind. On EACH sourceFrom operation choose owner and applicabilityKind; only IMPLEMENTATION needs its own role. Preserve original conditions; no filename/text classifier or automatic choice is provided.',
      }), `/defaults/${field}`);
    for (const [index, raw] of rawOperations.entries()) if (object(raw) && Object.hasOwn(raw, 'sourceFrom')) {
      try { assertBaselineProofOwner(raw, `sourceFrom operations[${index}]`, true); }
      catch (error) { add(error, `/operations/${index}/${error.baselineValidation.fields[0]}`); }
      if (!Object.hasOwn(raw, 'applicabilityKind') || validateJsonSchema(raw.applicabilityKind, schema.properties.operations.items.properties.applicabilityKind).length)
        add(baselineScopeFailure(`sourceFrom operations[${index}]: choose explicit applicabilityKind on this operation before defaults merge.`, {
          reason: 'SOURCEFROM_APPLICABILITY_REQUIRED', fields: ['applicabilityKind'],
          repair: 'Choose CURRENT_TASK, CONDITIONAL, FUTURE or UNKNOWN from the complete original obligation, preserving natural conditions/limits. A tag is only a review route; it proves neither activation nor fulfillment. Do not change the obligation, infer from keywords, or inherit from defaults.',
        }), `/operations/${index}/applicabilityKind`);
    }
  }
  for (const issue of wireIssues) add(invalid(`${issue.pointer}: ${issue.message}`), issue.pointer, issue.message);
  for (const [index, raw] of rawOperations.entries()) {
    if (!object(raw)) continue;
    const { textFrom, sourceFrom, outcome, ...fields } = raw, operation = { ...defaults, ...(draft ? { operation: 'ADD' } : {}), ...fields };
    const at = field => `/operations/${index}${field}`;
    if (typeof operation.operation !== 'string')
      add(invalid(`operations[${index}]: supply operation explicitly here or in defaults.operation. Use ADD for a supported new obligation; a non-ADD also needs an exact existing claimId. No operation is inferred.`), at('/operation'));
    else if (operation.operation !== 'ADD' && (typeof operation.claimId !== 'string' || !operation.claimId.trim()))
      add(invalid(`operations[${index}]: non-ADD requires an exact existing claimId. An old note is not a ledger claim; use ADD for a supported active obligation when no prior claim exists. Never invent IDs.`), at('/claimId'));
    const item = schema.properties.operations.items;
    const effectiveSchema = textFrom === undefined && sourceFrom === undefined ? item
      : { ...item, required: (item.required ?? []).filter(name => textFrom !== undefined ? !['text', 'source'].includes(name) : name !== 'source') };
    for (const issue of validateJsonSchema(operation, effectiveSchema)) add(invalid(issue.message), at(issue.pointer), issue.message);
    if (!Object.hasOwn(operation, 'verificationTarget') || ['IMPLEMENTATION', 'PROCESS', 'ARTIFACT'].includes(operation.verificationTarget)) {
      try { assertBaselineProofOwner(operation, `operations[${index}]`); }
      catch (error) { add(error, at(`/${error.baselineValidation.fields[0]}`)); }
    }
  }
  if (!first) return null;
  const bounded = (text, bytes) => {
    let result = '';
    for (const char of text) { if (Buffer.byteLength(result + char) > bytes) break; result += char; }
    return result;
  };
  const header = bounded(first.message, 1024), visible = [];
  const render = items => {
    const truncated = header !== first.message || items.length !== failures.length;
    return `${header}\nBatch issues:\n${items.map(item => `${item.pointer} [${item.code}]: ${item.message}`).join('\n')}\nReported ${items.length}/${failures.length}; truncated=${truncated}. No batch was saved. Fix fields from the original obligations and reuse the unsaved batchId. IMPLEMENTATION needs its chosen role; PROCESS/ARTIFACT must omit it. Never change the real target merely to pass validation.`;
  };
  for (const failure of failures) {
    if (Buffer.byteLength(render([...visible, failure])) > 3072) break;
    visible.push(failure);
  }
  const message = render(visible), truncated = header !== first.message || visible.length !== failures.length;
  return Object.assign(new Error(message), { code: first.code,
    baselineValidation: { ...(first.baselineValidation ?? { reason: 'BATCH_VALIDATION_FAILED', message: header,
      repair: 'Fix the reported effective metadata and encoding fields without changing the original obligation.' }),
    issues: visible, issueCount: failures.length, truncated, feedback: message },
  });
}

export function resolveBaselineBatch(value, { schema, compileSelection, registry, units = [] }) {
  const failure = baselineBatchFailure(value, schema);
  if (failure) throw failure;
  const operations = []; let bindings = structuredClone(value.bindings ?? []);
  for (const [index, raw] of value.operations.entries()) {
    const { textFrom, sourceFrom, outcome, ...fields } = raw, operation = { ...structuredClone(value.defaults ?? {}), ...structuredClone(fields) };
    if (typeof operation.operation !== 'string')
      throw Object.assign(new Error(`operations[${index}]: supply operation explicitly here or in defaults.operation. Use ADD for a supported new obligation; a non-ADD also needs an exact existing claimId. No operation is inferred.`), { code: 'BASELINE_SCHEMA_INVALID' });
    if (operation.operation !== 'ADD' && (typeof operation.claimId !== 'string' || !operation.claimId.trim()))
      throw Object.assign(new Error(`operations[${index}]: non-ADD requires an exact existing claimId. An old note is not a ledger claim; use ADD for a supported active obligation when no prior claim exists. Never invent IDs.`), { code: 'BASELINE_SCHEMA_INVALID' });
    if (sourceFrom !== undefined) {
      if (textFrom !== undefined || Object.hasOwn(raw, 'source') || bindings.some(binding => binding.operationIndex === index))
        throw Object.assign(new Error(`operations[${index}]: sourceFrom cannot mix with source, textFrom or supplied bindings.`), { code: 'BASELINE_SOURCE_INVALID' });
      const unit = units.find(unit => unit.id === sourceFrom.unitId);
      if (!unit || !compileSelection) throw Object.assign(new Error('sourceFrom needs one known complete original source unit.'), { code: 'BASELINE_SOURCE_INVALID' });
      const selected = compileSelection({ sourceIndex: unit.sourceIndex, start: unit.line, end: unit.line }, registry);
      operation.source = selected.source; bindings.push({ operationIndex: index, citeIds: selected.citeIds });
    } else if (textFrom !== undefined) {
      if (Object.hasOwn(raw, 'source'))
        throw Object.assign(new Error(`operations[${index}] mixes textFrom selection with synthesis source. Choose ONE encoding. For a known unit prefer scoped text + sourceFrom and REMOVE source/textFrom/bindings. Legacy fallback for unsupported selections: KEEP text + source, REMOVE textFrom; outcome is NOT required. ADD one batch bindings entry per operation: {operationIndex, citeIds:[current original source_read IDs]}. Reuse current original receipts; history recovers IDs. Exact copying uses a short outcome + textFrom with ONE file OR sourceIndex and no source; omit text unless exact. Never merge proof owners or reset the deadline.`), { code: 'BASELINE_SOURCE_INVALID' });
      if (typeof outcome !== 'string' || !outcome.trim() || outcome.length > 100)
        throw Object.assign(new Error(`operations[${index}] textFrom selection needs a SHORT outcome label, at most 100 characters. For scoped synthesis REMOVE textFrom; prefer text + sourceFrom for a known original unit, with no source/bindings. When unavailable, use legacy text + source + batch bindings with current original citeIds. Synthesis needs no outcome and never infers an owner.`), { code: 'BASELINE_SCHEMA_INVALID' });
      if (!compileSelection)
        throw Object.assign(new Error('Original selection is unavailable in this transport; use text + source + current citation bindings'), { code: 'BASELINE_SOURCE_INVALID' });
      let selected;
      try { selected = compileSelection(textFrom, registry); }
      catch (error) { error.message = `operations[${index}]: ${error.message}`; throw error; }
      const supplied = bindings.filter(item => item.operationIndex === index);
      if (supplied.length > 1 || supplied.some(item => item.citeIds.some(id => !selected.citeIds.includes(id))))
        throw Object.assign(new Error('Selection bindings must belong to its current original read receipts'), { code: 'BASELINE_SOURCE_INVALID' });
      if (Object.hasOwn(raw, 'text') && raw.text !== selected.text)
        throw Object.assign(new Error(`operations[${index}]: Selection text must equal the captured original. For exact copying omit redundant text. Scoped synthesis must REMOVE textFrom; prefer text + sourceFrom for a known unit and omit source/bindings. Otherwise supply legacy text + source + one batch bindings entry using current original citeIds. Do NOT widen the obligation or change its target. Synthesis needs no outcome; recover issued citations without rereading.`), { code: 'BASELINE_SOURCE_INVALID' });
      operation.text = selected.text; operation.source = selected.source;
      bindings = bindings.filter(item => item.operationIndex !== index);
      bindings.push({ operationIndex: index, citeIds: selected.citeIds });
    }
    const issues = validateJsonSchema(operation, schema.properties.operations.items);
    if (issues.length) throw Object.assign(new Error(issues[0].message), { code: 'BASELINE_SCHEMA_INVALID' });
    assertBaselineProofOwner(operation, `operations[${index}]`);
    operations.push(operation);
  }
  return { operations, bindings };
}
