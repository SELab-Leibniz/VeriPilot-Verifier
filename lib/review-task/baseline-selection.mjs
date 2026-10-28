import { validateJsonSchema } from '../json-schema-validator.mjs';

const sharedFields = ['operation', 'category', 'authority', 'severity', 'applicabilityKind', 'verificationTarget', 'implementationRole'];
export function sourceUnits(identity) {
  if (!identity.sources.length || identity.sources.some(source => source.parts.length !== 1 || source.clauseIndexPartial)) return [];
  const units = identity.sources.flatMap(source => Object.entries(source.clauseCounts ?? {}).filter(([, count]) => count !== 0)
    .map(([line, clauses]) => ({ id: `S${identity.sourceCatalog.findIndex(item => item.ref === source.ref)}L${line}`,
      sourceIndex: identity.sourceCatalog.findIndex(item => item.ref === source.ref), line: Number(line), clauses })));
  return units.length <= 200 ? units : [];
}

export function draftBaselineSchema(schema) {
  const properties = structuredClone(schema.properties.operations.items.properties);
  delete properties.applicabilityKind.description;
  const metadata = { type: 'object', additionalProperties: false, properties: Object.fromEntries([...sharedFields.filter(name => name !== 'operation'), 'applicability']
    .map(name => [name, properties[name]])) };
  const ids = { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: { type: 'string', pattern: '^S[0-9]+L[1-9][0-9]*$' } };
  return { type: 'object', additionalProperties: false, required: ['batchId'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    fullTextReason: { type: 'string', minLength: 1, maxLength: 500, description: 'MODE SWITCH ONLY. Omit for a normal draft batch. A mode request contains ONLY batchId and fullTextReason; it is NOT an explanation field.' },
    defaults: { type: 'object', additionalProperties: false, required: ['category', 'authority', 'severity', 'applicabilityKind', 'verificationTarget'],
      properties: Object.fromEntries(sharedFields.filter(name => name !== 'operation').map(name => [name, properties[name]])) },
    overrides: { type: 'array', maxItems: 200, description: 'Per-unit metadata overriding defaults. A unit listed only here is kept whole. IMPLEMENTATION needs implementationRole. Group metadata overrides this for split workflows.', items: {
      type: 'object', additionalProperties: false, required: ['unit', 'metadata'], properties: { unit: { type: 'string' }, metadata },
    } },
    keep: { ...ids, minItems: 0, description: 'Keep each unit as ONE claim, ALL its clauses together. Omit or use [] when all decisions use other collections. An empty collection makes no source decision.' },
    split: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['unit', 'groups'], properties: {
      unit: { type: 'string' }, groups: { type: 'array', minItems: 2, maxItems: 32, description: 'Only independent workflows on the same line; partition ALL clause indices exactly once. Conditions and exceptions stay with their workflow.', items: {
        type: 'object', additionalProperties: false, required: ['name', 'clauses'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 },
          clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 } }, metadata },
      } } } } },
    merge: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['name', 'units'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 }, units: { ...ids, minItems: 2, description: 'Consecutive original lines describing the same workflow.' }, metadata,
    } } },
    exclude: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['units', 'reason'], properties: {
      units: ids, reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Only unadopted MATERIAL/PROJECT_FILE context or an original already fully present in current claimIds. New user constraints, including quoted examples being unauthorized, must stay. Other semantic exclusions need fullTextReason.' },
      claimIds: { type: 'array', minItems: 1, uniqueItems: true, maxItems: 200, items: { type: 'string', minLength: 1 } },
    } } },
  } };
}

export function expandDraftBatch(value, units, classified = new Set(), validateExclusion) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'BASELINE_SCOPE_INVALID' }); };
  const index = new Map(units.map(unit => [unit.id, unit])), decisions = [], seen = new Set(), operations = [], overrides = new Map();
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
    if (!effective.verificationTarget || effective.verificationTarget === 'IMPLEMENTATION' && !effective.implementationRole)
      fail(`${unit.id}: choose explicit verificationTarget and implementationRole for IMPLEMENTATION`);
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
    if (selected.some((unit, i) => unit.sourceIndex !== selected[0].sourceIndex || i && unit.line !== selected[i - 1].line + 1))
      fail('Merge requires consecutive original lines in source order within one source');
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
  if (!decisions.length) fail('Classify source units with keep/split/merge/exclude, or request fullTextReason');
  if ([...overrides.keys()].some(id => !seen.has(id) || decisions.some(item => item.action === 'EXCLUDE' && item.units.includes(id)))) fail('Metadata override has no candidate operation in this batch');
  if (operations.length && !value.defaults) fail('Explicit metadata defaults are required for claims');
  return { batchId: value.batchId, defaults: { ...value.defaults, operation: 'ADD' }, operations, decisions };
}
export function compactBaselineSchema(schema) {
  const properties = structuredClone(schema.properties.operations.items.properties);
  delete properties.applicabilityKind.description;
  const metadata = Object.fromEntries(Object.entries(properties).filter(([name]) => !['text', 'source'].includes(name)));
  return { type: 'object', additionalProperties: false, required: ['batchId'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    fullTextReason: { type: 'string', minLength: 1, maxLength: 500, description: 'Request full-text tools for synthesis/split sources. Supply only batchId and this reason; same session/deadline continue.' },
    defaults: { type: 'object', additionalProperties: false, required: ['sourceIndex', 'operation', 'category', 'authority', 'severity', 'applicabilityKind'],
      properties: { sourceIndex: { type: 'integer', minimum: 0 }, ...Object.fromEntries(sharedFields.map(name => [name, properties[name]])) } },
    outcomes: { type: 'array', minItems: 1, maxItems: 200, description: 'One item per cohesive user result, with its conditions and prohibitions. Not one item per sentence. Distinct feature workflows stay separate.', items: {
      type: 'object', additionalProperties: false, required: ['name', 'lines'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        lines: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 }, description: '[start,end] original lines, inclusive.' },
        clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 }, description: 'Optional top-level semicolon indices on ONE line, 0..count-1; only for independent workflows sharing a line.' },
        sourceIndex: { type: 'integer', minimum: 0 },
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
    return { ...item.metadata, outcome: item.name, textFrom: { sourceIndex: item.sourceIndex ?? sourceIndex,
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
  item.properties.claimId = { ...item.properties.claimId, description: 'For non-ADD only: exact claimId already present in current Ground Truth. Old notes or quoted descriptions are not ledger claim IDs. Do not invent IDs.' };
  item.properties.outcome = { type: 'string', minLength: 1, maxLength: 100, description: 'Required with textFrom: concise name of ONE independently useful user operation/result. Its fields, exceptions and restrictions stay together. Do not combine different feature workflows under one label.' };
  item.properties.textFrom = { type: 'object', additionalProperties: false, required: ['sourceIndex', 'start', 'end'], properties: {
    sourceIndex: { type: 'integer', minimum: 0 }, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 },
    clauses: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
  }, description: 'Select complete original lines from a single-part sourceCatalog entry. Optional clauses selects zero-based TOP-LEVEL semicolon clauses on ONE line, in original order, for distinct feature workflows only. Paired quotes/brackets stay intact; unbalanced punctuation needs full text. Keep conditions/exceptions together. Program captures text/source/current receipts; omit repeated text/source/bindings.' };
  return { type: 'object', additionalProperties: false, required: ['batchId', 'operations'], properties: {
    batchId: { type: 'integer', minimum: 1 },
    defaults: { type: 'object', additionalProperties: false, properties: Object.fromEntries(sharedFields.filter(key => item.properties[key]).map(key => [key, item.properties[key]])),
      description: 'Explicit metadata shared by this batch. Each operation may override it. No authority or severity is inferred by the program.' },
    operations: { ...structuredClone(schema.properties.operations), items: item },
    bindings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['operationIndex', 'citeIds'], properties: {
      operationIndex: { type: 'integer', minimum: 0 }, citeIds: { type: 'array', uniqueItems: true, maxItems: 256, items: { type: 'string' } },
    } } },
  } };
}

export function resolveBaselineBatch(value, { schema, compileSelection, registry }) {
  const operations = []; let bindings = structuredClone(value.bindings ?? []);
  for (const [index, raw] of value.operations.entries()) {
    const { textFrom, outcome, ...fields } = raw, operation = { ...structuredClone(value.defaults ?? {}), ...structuredClone(fields) };
    if (operation.operation !== 'ADD' && (typeof operation.claimId !== 'string' || !operation.claimId.trim()))
      throw Object.assign(new Error(`operations[${index}]: non-ADD requires an exact existing claimId. An old note is not a ledger claim; use ADD for a supported active obligation when no prior claim exists. Never invent IDs.`), { code: 'BASELINE_SCHEMA_INVALID' });
    if (textFrom !== undefined) {
      if (typeof outcome !== 'string' || !outcome.trim() || outcome.length > 100)
        throw Object.assign(new Error(`operations[${index}] needs outcome: name one user operation/result, keep its conditions together and split independent workflows`), { code: 'BASELINE_SCHEMA_INVALID' });
      if (!compileSelection || Object.hasOwn(raw, 'source'))
        throw Object.assign(new Error('Selection source is program captured; omit source'), { code: 'BASELINE_SOURCE_INVALID' });
      let selected;
      try { selected = compileSelection(textFrom, registry); }
      catch (error) { error.message = `operations[${index}]: ${error.message}`; throw error; }
      const supplied = bindings.filter(item => item.operationIndex === index);
      if (supplied.length > 1 || supplied.some(item => item.citeIds.some(id => !selected.citeIds.includes(id))))
        throw Object.assign(new Error('Selection bindings must belong to its current original read receipts'), { code: 'BASELINE_SOURCE_INVALID' });
      if (Object.hasOwn(raw, 'text') && raw.text !== selected.text)
        throw Object.assign(new Error('Selection text must equal the captured original; omit redundant text'), { code: 'BASELINE_SOURCE_INVALID' });
      operation.text = selected.text; operation.source = selected.source;
      bindings = bindings.filter(item => item.operationIndex !== index);
      bindings.push({ operationIndex: index, citeIds: selected.citeIds });
    }
    const issues = validateJsonSchema(operation, schema.properties.operations.items);
    if (issues.length) throw Object.assign(new Error(issues[0].message), { code: 'BASELINE_SCHEMA_INVALID' });
    operations.push(operation);
  }
  return { operations, bindings };
}
