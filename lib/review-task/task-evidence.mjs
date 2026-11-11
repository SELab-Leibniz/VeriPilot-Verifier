// Source protocol shared by extraction tasks and acceptance workers. Only a
// genuine host persistence receipt grants coverage; telemetry cannot do so.
import fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSourceTools, toolText, textBlocks } from './source-tools.mjs';
import { captureFiles, covers, disclosedRange, newEvidenceLabel, registerCitation } from './evidence-utils.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';
import { validateJsonSchema } from '../json-schema-validator.mjs';
import { createLiveSourceTools } from './live-source-tools.mjs';

export const BASELINE_PROPOSAL_PROTOCOL = 'owned-baseline-explicit-submit-v7-exact-parent-digest';
const proposalFailure = (message, code = 'BASELINE_PROPOSAL_UNVERIFIED') => Object.assign(new Error(message), { code });
const unsafeProposalKeys = new Set(['__proto__', 'prototype', 'constructor']);

// Inspect descriptors before cloning, hashing or calling the host validator.
// In particular, JSON.stringify must never be used to inspect an accessor.
export function assertBaselineProposalJson(value, { maxDepth = 64, maxNodes = 100000 } = {}) {
  const visiting = new Set(); let nodes = 0;
  function visit(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) throw proposalFailure('Proposal JSON exceeds structural bounds', 'BASELINE_PROPOSAL_UNSAFE_JSON');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (!item || typeof item !== 'object' || visiting.has(item)) throw proposalFailure('Proposal requires finite acyclic JSON values', 'BASELINE_PROPOSAL_UNSAFE_JSON');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
      throw proposalFailure('Proposal has a non-JSON prototype', 'BASELINE_PROPOSAL_UNSAFE_JSON');
    visiting.add(item);
    const keys = Reflect.ownKeys(item);
    for (const key of keys) {
      if (typeof key !== 'string' || unsafeProposalKeys.has(key)) throw proposalFailure('Proposal contains a forbidden own key', 'BASELINE_PROPOSAL_UNSAFE_JSON');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw proposalFailure('Proposal accessors are forbidden', 'BASELINE_PROPOSAL_UNSAFE_JSON');
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))
        throw proposalFailure('Proposal contains a non-JSON property', 'BASELINE_PROPOSAL_UNSAFE_JSON');
      visit(descriptor.value, depth + 1);
    }
    if (array && keys.length !== item.length + 1) throw proposalFailure('Proposal arrays cannot contain holes', 'BASELINE_PROPOSAL_UNSAFE_JSON');
    visiting.delete(item);
  }
  visit(value, 0); return value;
}

export function isBaselineProposalCall(value) {
  if (!value || typeof value !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'action');
  return descriptor && Object.hasOwn(descriptor, 'value') && ['submit', 'correct_and_submit', 'inspect'].includes(descriptor.value);
}

export function baselineProposalToolSchema(legacy) {
  const digest = { type: 'string', minLength: 1, maxLength: 128 };
  const pathSchema = { type: 'array', maxItems: 64, items: { type: ['string', 'integer'], maxLength: 1024, minimum: 0 } };
  const submitFields = Object.fromEntries(Object.keys(legacy.properties ?? {}).filter(key => key !== 'fullTextReason').map(key => [key, {}]));
  const submitRequired = (legacy.required ?? []).filter(key => ['batchId', 'report'].includes(key));
  const branches = [legacy,
    { type: 'object', additionalProperties: false, required: ['action', ...submitRequired], properties: {
      action: { type: 'string', enum: ['submit'] }, ...submitFields } },
    { type: 'object', additionalProperties: false, required: ['action', 'value'], properties: {
      action: { type: 'string', enum: ['submit'] }, value: { type: 'object', required: submitRequired, description: 'Compatibility wrapper for the complete tool argument object. Use either this object or direct top-level submission fields, never both. Mode switches remain unwrapped batchId + fullTextReason controls.', properties: submitFields },
    } },
    { type: 'object', additionalProperties: false, required: ['action', 'parentRevisionDigest', 'changes'], properties: {
      action: { type: 'string', enum: ['correct_and_submit'] }, proposalId: digest, parentRevisionDigest: digest,
      ...(legacy.properties?.batchId ? { batchId: legacy.properties.batchId } : {}),
      changes: { type: 'array', minItems: 1, maxItems: 64, items: { anyOf: [
        { type: 'object', additionalProperties: false, required: ['op', 'path', 'value'], properties: { op: { type: 'string', enum: ['set'] }, path: pathSchema, value: {} } },
        { type: 'object', additionalProperties: false, required: ['op', 'path'], properties: { op: { type: 'string', enum: ['remove'] }, path: pathSchema } },
      ] } },
    } },
    { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['inspect'] }, proposalId: digest, revisionDigest: digest, path: pathSchema,
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2048 },
    } },
  ];
  // Repeat the existing field contracts at the root for hosts that render only
  // root properties. Report details remain in the strict legacy branch, but
  // direct owned submissions reach the worker before strict report validation
  // so a mistyped field can be repaired without resending the whole report.
  return { type: 'object', properties: { ...Object.assign({}, ...branches.map(branch => branch.properties)), ...legacy.properties,
    ...(legacy.properties?.report ? { report: { type: 'object', description: 'Complete independent report; see the exact report fields in the schema branches.' } } : {}),
    action: { type: 'string', enum: ['submit', 'correct_and_submit', 'inspect'] } }, anyOf: branches };
}

const proposalText = value => {
  if (!Array.isArray(value?.content) || !value.content.length || value.content.some(block => block.type !== 'text' || typeof block.text !== 'string'))
    throw proposalFailure('Proposal requires an exact pure-text receipt');
  return value.content.map(block => block.text).join('\n');
};
const proposalResponse = (receipt, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(receipt) }], isError });
export function programPromptedBaselineRetry(receipt, args, parent) {
  if (!receipt || receipt.accepted !== false || receipt.code !== 'BASELINE_SCOPE_INVALID'
    || !['PROOF_OWNER_REQUIRED', 'NON_IMPLEMENTATION_ROLE'].includes(receipt.validation?.reason)
    || args?.action !== 'submit' || !Number.isSafeInteger(parent?.batchId)
    || initialProposalValue(args)?.batchId !== parent.batchId) return false;
  return typeof receipt.validation.repair === 'string' && /resubmit this unsaved batchId/iu.test(receipt.validation.repair);
}
function proposalValidationFeedback(error) {
  const source = error.auditValidation ?? error.baselineValidation;
  if (!source) return {};
  // RC diagnostic metadata may have optional own undefined fields. Omit only
  // those optional object fields; this projection is never used on model args.
  function navigation(item, depth = 0) {
    if (depth > 64) throw proposalFailure('Diagnostic navigation is too deep');
    if (item === null || typeof item !== 'object') return item;
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw proposalFailure('Unsafe diagnostic navigation');
    const result = Array.isArray(item) ? [] : {};
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || unsafeProposalKeys.has(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) throw proposalFailure('Unsafe diagnostic field');
      if (descriptor.value === undefined && !Array.isArray(item)) continue;
      Object.defineProperty(result, key, { value: navigation(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  let value;
  try { value = navigation(source); assertBaselineProposalJson(value); }
  catch { return { validation: { reason: 'DIAGNOSTIC_NAVIGATION_UNAVAILABLE', message: 'Original validation rejected the submission; unsafe diagnostic metadata was withheld.' } }; }
  if (Buffer.byteLength(JSON.stringify(value)) <= 4096) return { validation: proposalCopy(value) };
  const projected = {};
  for (const key of ['code', 'reason', 'fields', 'operationIndex', 'sourceRef', 'claimId', 'path', 'issueCount', 'gaps']) {
    if (!Object.hasOwn(value, key)) continue;
    const item = key === 'gaps' && Array.isArray(value[key]) ? value[key].slice(0, 8) : value[key];
    if (Buffer.byteLength(JSON.stringify({ ...projected, [key]: item })) <= 3072) projected[key] = proposalCopy(item);
  }
  return { validation: { ...projected, navigationTruncated: true, validationDigest: sha256(value),
    recoverWith: 'Inspect the owned draft and reread the original/candidate with existing tools. No semantic value is supplied.' } };
}
const proposalCopy = value => { assertBaselineProposalJson(value); return structuredClone(value); };
const exactProposalKeys = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.includes(key));
function initialProposalValue(wire) {
  if (Object.hasOwn(wire, 'value')) return exactProposalKeys(wire, ['action', 'value']) ? wire.value : null;
  const { action: _action, ...value } = wire;
  return value;
}

export function materializeBaselineProposal(parent, changes) {
  assertBaselineProposalJson(parent); assertBaselineProposalJson(changes);
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw proposalFailure('Explicit nonempty changes are required');
  const paths = [];
  for (const change of changes) {
    if (!exactProposalKeys(change, change.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'])
      || !['set', 'remove'].includes(change.op) || !Array.isArray(change.path) || !change.path.length || change.path.length > 64)
      throw proposalFailure('Correction must explicitly set or remove an existing-parent leaf');
    for (const token of change.path) if (!(typeof token === 'string' && !unsafeProposalKeys.has(token)
      || Number.isSafeInteger(token) && token >= 0)) throw proposalFailure('Unsafe correction path');
    const conflict = paths.find(previous => previous.slice(0, Math.min(previous.length, change.path.length)).every((token, i) => token === change.path[i]));
    if (conflict) throw proposalFailure(`Overlapping or repeated correction paths: ${JSON.stringify(conflict)} and ${JSON.stringify(change.path)}. Set the leaf or replace the entire row once; do not remove a row and edit its fields in the same correction.`);
    paths.push(change.path);
  }
  const result = proposalCopy(parent);
  for (const change of changes) {
    let owner = result;
    for (const token of change.path.slice(0, -1)) {
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) && !Number.isSafeInteger(token)
        || !Array.isArray(owner) && typeof token !== 'string' || !Object.hasOwn(owner, token))
        throw proposalFailure('Correction cannot create an intermediate parent or coerce a path token');
      owner = owner[token];
    }
    const leaf = change.path.at(-1);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) && (!Number.isSafeInteger(leaf) || leaf < 0
      || (change.op === 'set' ? leaf > owner.length : leaf >= owner.length))
      || !Array.isArray(owner) && typeof leaf !== 'string')
      throw proposalFailure(`Correction path ${JSON.stringify(change.path)} must use an object key or numeric array index. set may append exactly at the current array length; it cannot skip indices. remove needs an existing entry.`);
    if (change.op === 'remove') {
      if (!Object.hasOwn(owner, leaf)) throw proposalFailure('Removed leaf does not exist');
      if (Array.isArray(owner)) owner.splice(leaf, 1);
      else delete owner[leaf];
    } else Object.defineProperty(owner, leaf, { value: proposalCopy(change.value), enumerable: true, configurable: true, writable: true });
  }
  assertBaselineProposalJson(result); return result;
}

export function validateBaselineProposalArguments(capability, toolName, parameters, args) {
  assertBaselineProposalJson(args);
  if (typeof capability?.validateToolArguments !== 'function' || !capability.identity) throw proposalFailure('Trusted public validation capability is unavailable');
  const untouched = proposalCopy(args), candidate = proposalCopy(args);
  let checked;
  try { checked = capability.validateToolArguments({ name: toolName, parameters }, { name: toolName, arguments: candidate }); }
  catch (error) {
    // Preserve exact native rejection. The local validator is used only to
    // explain common report-shape faults that TypeBox names at the parent.
    if (toolName !== 'finish_baseline_audit' || Object.hasOwn(untouched, 'action')) throw error;
    const issues = validateJsonSchema(untouched, parameters).map(({ pointer, message }) => ({ pointer, message }));
    if (!issues.length) throw error;
    const visible = issues.slice(0, 6).map(({ pointer, message }) => ({ pointer: pointer.slice(0, 256), message: message.slice(0, 160) }));
    const repair = 'Correct only the reported fields in the owned report. Remove an unsupported field without changing the obligation, or explicitly supply each required field with its exact JSON type.';
    throw Object.assign(proposalFailure(`Audit report shape is invalid. ${JSON.stringify(visible)}. ${repair}`, 'BASELINE_PROPOSAL_SCHEMA_INVALID'),
      { baselineValidation: { reason: 'REPORT_SCHEMA_INVALID', issues: visible, issueCount: issues.length, repair } });
  }
  if (!isDeepStrictEqual(candidate, untouched) || !isDeepStrictEqual(checked, untouched)) {
    const changes = [];
    const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const locate = (before, after, path = []) => {
      if (changes.length === 4 || isDeepStrictEqual(before, after)) return;
      if (before && after && typeof before === 'object' && type(before) === type(after)) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (unsafeProposalKeys.has(key)) continue;
          const token = Array.isArray(before) ? Number(key) : key;
          if (Array.isArray(before) && !Number.isSafeInteger(token)) continue;
          locate(Object.getOwnPropertyDescriptor(before, key)?.value, Object.getOwnPropertyDescriptor(after, key)?.value, [...path, token]);
          if (changes.length === 4) break;
        }
      } else if (Buffer.byteLength(JSON.stringify(path)) <= 256)
        changes.push({ path, submittedType: type(before), normalizedType: type(after) });
    };
    locate(untouched, isDeepStrictEqual(candidate, untouched) ? checked : candidate);
    const repair = 'Explicitly supply the correct JSON type or remove an unsupported field. Use numeric coordinates and array indices. No converted value was used.';
    throw Object.assign(proposalFailure(`Full native validation requires an explicit correction; coercion is forbidden. ${JSON.stringify(changes)}. ${repair}`,
      'BASELINE_PROPOSAL_COERCION_REQUIRED'), { baselineValidation: { reason: 'NATIVE_ARGUMENT_COERCION', changes, repair } });
  }
  return { schemaDigest: sha256(parameters), argsDigest: sha256(untouched), validatorIdentity: proposalCopy(capability.identity) };
}

function proposalNativeSnapshot(native, anchor = null, { allowMissing = false } = {}) {
  let bytes;
  try {
    if (realpathSync(native.sessionFile) !== path.resolve(native.sessionFile)) throw proposalFailure('Foreign native proposal transcript');
    bytes = readFileSync(native.sessionFile);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { bytes: Buffer.alloc(0), records: [], absent: true };
    throw error;
  }
  if (!bytes.length || bytes.at(-1) !== 10) throw proposalFailure('Native proposal transcript is not a complete append');
  if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw proposalFailure('Native proposal transcript is not exact UTF8');
  if (anchor && (bytes.length < anchor.length || !bytes.subarray(0, anchor.length).equals(anchor)))
    throw proposalFailure('Native proposal window changed; compaction rebasing is unsupported');
  let offset = 0;
  const records = bytes.toString('utf8').split('\n').slice(0, -1).map(line => {
    const start = offset; offset += Buffer.byteLength(line) + 1;
    return { value: JSON.parse(line), start, end: offset };
  });
  const headers = records.filter(row => row.value.type === 'session');
  if (headers.length !== 1 || headers[0].value.id !== native.sessionId) throw proposalFailure('Foreign native proposal session header');
  return { bytes, records, absent: false };
}

// A rejected unsafe value must not be stringified. Descriptor-only projection
// permits attribution of an actual native error without invoking accessors.
function rejectedProposalFingerprint(value, seen = new Map(), bounds = { nodes: 0, bytes: 0 }, depth = 0) {
  if (++bounds.nodes > 100000 || depth > 64) throw proposalFailure('Rejected input exceeds attribution structural bounds');
  if (typeof value === 'string') bounds.bytes += Buffer.byteLength(value);
  if (bounds.bytes > 1024 * 1024) throw proposalFailure('Rejected input exceeds attribution byte bounds');
  if (value === null) return ['null'];
  if (typeof value !== 'object') return [typeof value, typeof value === 'number' && Object.is(value, -0) ? '-0'
    : ['string', 'boolean', 'number'].includes(typeof value) ? String(value) : 'non-json'];
  if (seen.has(value)) return ['cycle', seen.get(value)];
  if (seen.size >= 100000) throw proposalFailure('Unsafe input cannot be attributed within structural bounds');
  seen.set(value, seen.size);
  return [Array.isArray(value) ? 'array' : 'object', Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key === 'string') bounds.bytes += Buffer.byteLength(key);
    return [typeof key === 'string' ? key : 'symbol-key', descriptor && Object.hasOwn(descriptor, 'value')
      ? rejectedProposalFingerprint(descriptor.value, seen, bounds, depth + 1) : ['accessor']];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)];
}

function proposalNativeCall(snapshot, nativeId, toolName, wire, startByte, rejectedUnsafe = false) {
  const matches = snapshot.records.flatMap((row, index) => row.value.message?.role === 'assistant'
    && Array.isArray(row.value.message.content) ? row.value.message.content
      .filter(block => ['toolCall', 'tool_use'].includes(block.type) && block.id === nativeId)
      .map(block => ({ row, index, block })) : []);
  if (matches.length !== 1 || matches[0].row.start < startByte || matches[0].block.name !== toolName)
    throw proposalFailure('No unique current-window native call; ID aliases cannot be guessed');
  const call = matches[0], args = call.block.arguments ?? call.block.input;
  if (!rejectedUnsafe) assertBaselineProposalJson(args);
  const equal = rejectedUnsafe ? isDeepStrictEqual(rejectedProposalFingerprint(args), rejectedProposalFingerprint(wire)) : isDeepStrictEqual(args, wire);
  if (typeof args === 'string' || !equal) throw proposalFailure('Native typed proposal arguments differ from the actual tool arguments');
  return { index: call.index, start: call.row.start, end: call.row.end, bytesDigest: sha256(snapshot.bytes.subarray(call.row.start, call.row.end)) };
}

// One local helper for the two existing baseline tools. It never grants reads,
// chooses semantic values, opens a model run, or changes the original budget.
export async function createOwnedBaselineProposal({ directory, toolName, identity, active, validationCapability, bindBudgetConsumer, maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw proposalFailure('Original tool byte limit is required');
  await fs.mkdir(directory, { recursive: true }); active();
  let owner = null, binding = null, bindingActive = null, current = null, uncertain = false, terminalBudgetError = null, serial = Promise.resolve();
  const attempts = new Map(), slots = new Map(), boundaryRejections = new Map(), closedWindows = [];
  const assertActive = () => {
    if (terminalBudgetError) throw terminalBudgetError;
    active();
    if (uncertain || !owner || owner.closed || !binding || !bindingActive?.()) throw proposalFailure('Owned proposal binding is unavailable or uncertain');
    if (binding.sessionId !== owner.native.sessionId || binding.runId !== owner.native.runId) throw proposalFailure('Foreign native proposal binding');
  };
  function stopAfterRejectionFailure(error) {
    if (error.code === 'BASELINE_REPAIR_LIMIT') terminalBudgetError = error;
    else uncertain = true;
    throw error;
  }
  const exclusive = callback => { const next = serial.then(callback); serial = next.catch(() => {}); return next; };
  async function write(name, value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n'), file = path.join(directory, name);
    const handle = await fs.open(file, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (!bytes.equals(await fs.readFile(file))) throw proposalFailure('Immutable proposal write mismatch');
    return { path: file, bytesDigest: sha256(bytes) };
  }
  function snapshot() {
    assertActive();
    try { return proposalNativeSnapshot(owner.native, owner.anchor); }
    catch (error) { uncertain = true; throw error; }
  }
  async function confirmAck(attempt) {
    assertActive();
    if (attempt.ack) {
      try {
        const bytes = await fs.readFile(attempt.ack.path); assertActive();
        if (sha256(bytes) !== attempt.ack.bytesDigest) throw proposalFailure('Cached ACK witness bytes changed');
        const ack = JSON.parse(bytes.toString('utf8')), data = snapshot();
        const call = proposalNativeCall(data, attempt.callId, toolName, attempt.wire, owner.anchor.length);
        const result = data.records[ack.result.index];
        if (!isDeepStrictEqual(call, attempt.call) || !isDeepStrictEqual(ack.call, attempt.call)
          || !result || result.start !== ack.result.start || result.end !== ack.result.end
          || result.value.message?.toolCallId !== attempt.callId || result.value.message.toolName !== toolName
          || result.value.message.isError !== false || proposalText(result.value.message) !== attempt.receiptText
          || !data.bytes.subarray(0, Buffer.byteLength(ack.transcript)).equals(Buffer.from(ack.transcript)))
          throw proposalFailure('Cached ACK original native intervals changed');
        return attempt.ack;
      } catch (error) { uncertain = true; throw error; }
    }
    if (!attempt.seen || attempt.seen.binding !== binding || attempt.seen.owner !== owner) throw proposalFailure('Original negative receipt has not genuinely persisted');
    const seen = attempt.seen, data = snapshot();
    const call = proposalNativeCall(data, attempt.callId, toolName, attempt.wire, owner.anchor.length);
    if (!isDeepStrictEqual(call, attempt.call)) { uncertain = true; throw proposalFailure('Original native call bytes or position changed after execution'); }
    const matches = data.records.map((row, index) => ({ row, index })).filter(({ row }) => row.value.message?.role === 'toolResult'
      && row.value.message.toolCallId === attempt.callId);
    if (matches.length !== 1 || matches[0].index <= call.index || matches[0].row.start < seen.frontier
      || matches[0].row.value.message.toolName !== toolName || matches[0].row.value.message.isError !== false
      || proposalText(matches[0].row.value.message) !== attempt.receiptText) throw proposalFailure('Original negative receipt has no unique exact actual native append');
    const pointer = await write(`ack-${attempt.nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, revision: attempt.pointer,
      outcome: attempt.outcome, native: owner.native, ownerRunNonce: owner.nonce, attemptNonce: attempt.nonce,
      call, result: { index: matches[0].index, start: matches[0].row.start, end: matches[0].row.end },
      observed: seen.event, hookFrontier: seen.frontier, transcript: data.bytes.toString('utf8') });
    assertActive(); snapshot(); attempt.ack = pointer; attempt.ackPosition = matches[0].index; return pointer;
  }
  async function rejectBoundary(error, id, args) {
    assertActive();
    // inspect never rechecks a full report. Ordinary navigation denials spend
    // the original turn/time only; unsafe JSON still enters the failed debit.
    const action = args && typeof args === 'object' ? Object.getOwnPropertyDescriptor(args, 'action') : null;
    if (action && Object.hasOwn(action, 'value') && action.value === 'inspect' && error.code !== 'BASELINE_PROPOSAL_UNSAFE_JSON') throw error;
    let data, call, fingerprint, scope;
    try {
      data = snapshot(); call = proposalNativeCall(data, id, toolName, args, owner.anchor.length, true);
      fingerprint = rejectedProposalFingerprint(args); scope = proposalCopy(identity());
    } catch (failure) { uncertain = true; throw failure; }
    const key = sha256({ native: owner.native, scope, toolName, rejectedWire: fingerprint });
    const prior = boundaryRejections.get(key);
    if (prior) {
      if (!isDeepStrictEqual(prior.fingerprint, fingerprint) || !prior.response) throw proposalFailure('Uncertain rejected-attempt replay');
      return proposalCopy(prior.response);
    }
    const nonce = randomBytes(32).toString('hex'), originalOwner = owner, originalBinding = binding;
    const pending = { fingerprint, call, callId: id, response: null }; boundaryRejections.set(key, pending);
    try {
      const revision = await write(`rejected-${nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, phase: 'BOUNDARY_REJECTED',
        native: owner.native, ownerRunNonce: owner.nonce, windowStart: owner.anchorPointer, scope, attemptId: key, attemptNonce: nonce,
        callId: id, call, rawCall: data.bytes.subarray(call.start, call.end).toString('utf8'), code: error.code ?? 'BASELINE_PROPOSAL_UNVERIFIED' });
      assertActive();
      if (owner !== originalOwner || binding !== originalBinding) throw proposalFailure('Rejected proposal owner changed while awaiting');
      const prompted = error.baselinePromptConflict === true && current && isDeepStrictEqual(current.scope, scope)
        && programPromptedBaselineRetry(JSON.parse(current.receiptText), args, current.materialized);
      const programPromptFailure = prompted ? { code: 'RETIRED_UNSAVED_BATCH_PROMPT', outcome: current.outcome,
        receiptDigest: sha256(current.receiptText), parentRevisionDigest: current.pointer.bytesDigest } : null;
      const debit = await owner.budget.rejectAttempt({ attemptId: key, revision, nativeCallId: id, wireDigest: sha256(fingerprint),
        ...(programPromptFailure ? { programPromptFailure } : {}) }, {
        message: String(error.message ?? 'Invalid proposal').split('\n\nReceived arguments:')[0].slice(0, 512),
        ...proposalValidationFeedback(error),
      });
      assertActive();
      if (owner !== originalOwner || binding !== originalBinding) throw proposalFailure('Rejected proposal owner changed while awaiting');
      const receipt = { accepted: false, complete: false, code: error.code ?? 'BASELINE_PROPOSAL_UNVERIFIED',
        message: String(error.message ?? 'Invalid proposal').split('\n\nReceived arguments:')[0].slice(0, 3072),
        ...proposalValidationFeedback(error),
        attemptNonce: nonce, rejectedAttemptDigest: revision.bytesDigest, navigationOnly: true,
        ...(current ? { proposalId: current.proposalId, parentRevisionDigest: current.pointer.bytesDigest } : {}),
        repairCharged: !prompted,
        repair: `${prompted ? 'This retry followed a retired RC instruction; the shared repair counter was not charged.' : 'This failed boundary attempt consumed the original shared repair counter.'} No draft field was changed. ${current
          ? `Use action:"correct_and_submit", parentRevisionDigest:"${current.pointer.bytesDigest}" and explicit changes. Omit the redundant proposalId; do not submit a new draft.`
          : 'Submit a complete initial JSON object; no owned proposal exists.'}` };
      await write(`rejected-outcome-${nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, revision, accepted: false, debit, receipt });
      assertActive(); snapshot(); pending.response = proposalResponse(receipt, true); return proposalCopy(pending.response);
    } catch (failure) { stopAfterRejectionFailure(failure); }
  }
  const api = {
    assertHealthy() {
      if (terminalBudgetError) throw terminalBudgetError;
      if (uncertain) throw proposalFailure('Proposal transaction is uncertain; no further acceptance is permitted');
    },
    closedWindows() { return proposalCopy(closedWindows); },
    async bindNative(native) {
      if (owner && !owner.windowClosed) throw proposalFailure('Prior native proposal window has not closed');
      active(); assertBaselineProposalJson(native);
      const first = proposalNativeSnapshot(native, null, { allowMissing: true });
      const nonce = randomBytes(32).toString('hex');
      const anchor = await write(`window-start-${nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, native,
        ownerRunNonce: nonce, absent: first.absent, startByte: first.bytes.length, prefix: first.bytes.toString('utf8'), prefixBytesDigest: sha256(first.bytes) });
      active();
      owner = { native: proposalCopy(native), nonce, anchor: first.bytes, anchorPointer: anchor, closed: false, windowClosed: false,
        budget: bindBudgetConsumer(native) };
      current = null; attempts.clear(); slots.clear(); boundaryRejections.clear(); return api;
    },
    bindToolBinding(value, isCurrent) {
      if (!owner || owner.closed || binding || value.runId !== owner.native.runId || value.sessionId !== owner.native.sessionId)
        throw proposalFailure('Native proposal tools cannot rebind their owner');
      binding = value; bindingActive = isCurrent;
    },
    unbindToolBinding(value) {
      if (binding === value) { owner.closed = true; owner.budget.close(); binding = null; bindingActive = null; slots.clear(); }
    },
    async closeNativeWindow(native) {
      if (!owner || owner.native.runId !== native.runId) throw proposalFailure('Foreign proposal window close');
      if (owner.windowClosed) return;
      owner.closed = true; owner.budget.close(); binding = null; bindingActive = null; slots.clear();
      await serial;
      if (terminalBudgetError) throw terminalBudgetError;
      if (uncertain) throw proposalFailure('Uncertain proposal transaction cannot close a certified native window');
      const last = proposalNativeSnapshot(owner.native, owner.anchor);
      for (const attempt of attempts.values()) {
        if (!isDeepStrictEqual(proposalNativeCall(last, attempt.callId, toolName, attempt.wire, owner.anchor.length), attempt.call))
          throw proposalFailure('Proposal native call changed before window closure');
        const results = last.records.map((row, index) => ({ row, index })).filter(({ row }) => row.value.message?.role === 'toolResult'
          && row.value.message.toolCallId === attempt.callId);
        if (!attempt.receiptText || results.length !== 1 || results[0].index <= attempt.call.index
          || results[0].row.value.message.toolName !== toolName || results[0].row.value.message.isError !== false
          || proposalText(results[0].row.value.message) !== attempt.receiptText) throw proposalFailure('Original proposal result changed before window closure');
        if (attempt.ack) {
          const bytes = await fs.readFile(attempt.ack.path);
          if (sha256(bytes) !== attempt.ack.bytesDigest) throw proposalFailure('Original negative ACK witness changed before window closure');
          const ack = JSON.parse(bytes.toString('utf8'));
          if (!last.bytes.subarray(0, Buffer.byteLength(ack.transcript)).equals(Buffer.from(ack.transcript)))
            throw proposalFailure('Acknowledged native prefix changed before window closure');
        }
      }
      for (const rejected of boundaryRejections.values()) {
        if (sha256(last.bytes.subarray(rejected.call.start, rejected.call.end)) !== rejected.call.bytesDigest)
          throw proposalFailure('Rejected boundary call bytes changed before window closure');
        const results = last.records.filter(row => row.value.message?.role === 'toolResult' && row.value.message.toolCallId === rejected.callId);
        if (!rejected.response || results.length !== 1 || proposalText(results[0].value.message) !== proposalText(rejected.response))
          throw proposalFailure('Rejected boundary attempt has no original returned result');
      }
      owner.endPointer = await write(`window-end-${owner.nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL,
        native: owner.native, start: owner.anchorPointer, endByte: last.bytes.length, transcript: last.bytes.toString('utf8'), transcriptBytesDigest: sha256(last.bytes) });
      owner.windowClosed = true;
      closedWindows.push({ native: owner.native, start: owner.anchorPointer, end: owner.endPointer });
    },
    observeReceipt(event, context) {
      if (!owner || owner.closed || terminalBudgetError || uncertain || context?.binding !== binding || !bindingActive?.()
        || context.sessionKey !== binding.sessionKey || event.isSynthetic !== false || event.toolName !== toolName
        || context.toolName && context.toolName !== toolName || context.toolCallId && context.toolCallId !== event.toolCallId) return false;
      const slot = slots.get(event.toolCallId), message = event.message;
      if (!slot || slot.replay || slot.owner !== owner || slot.binding !== binding || !slot.receiptText
        || message?.role !== 'toolResult' || message.toolName !== toolName || message.toolCallId !== slot.callId || message.isError !== false) return false;
      try {
        assertActive();
        if (proposalText(message) !== slot.receiptText) return false;
        const data = snapshot(); proposalNativeCall(data, slot.callId, toolName, slot.wire, owner.anchor.length);
        if (data.records.some(row => row.value.message?.role === 'toolResult' && row.value.message.toolCallId === slot.callId)) return false;
        slot.seen ??= { owner, binding, frontier: data.bytes.length,
          event: { toolName: event.toolName, toolCallId: event.toolCallId, isSynthetic: false,
            message: { role: message.role, toolName: message.toolName, toolCallId: message.toolCallId,
              isError: false, content: [{ type: 'text', text: proposalText(message) }] } } };
        return true;
      } catch { return false; }
    },
    checkpoint(reason) {
      if (owner && !owner.closed && binding && ['before_compaction', 'after_compaction'].includes(reason)) snapshot();
    },
    execute({ id, args, parameters, prepare, abort, gate = async () => {} }) {
      return exclusive(async () => {
        let revisionStarted = false;
        try {
        assertActive(); abort?.throwIfAborted(); assertBaselineProposalJson(args);
        const initialOwner = owner, initialBinding = binding, data = snapshot();
        const call = proposalNativeCall(data, id, toolName, args, owner.anchor.length);
        const check = () => { assertActive(); if (owner !== initialOwner || binding !== initialBinding) throw proposalFailure('Proposal owner changed while awaiting'); abort?.throwIfAborted(); };
        await gate(args, call.index); check();
        if (Buffer.byteLength(JSON.stringify(args)) > maxBytes) throw proposalFailure('Proposal wire exceeds the unchanged original tool limit');
        const envelope = baselineProposalToolSchema({ ...parameters, not: {} });
        validateBaselineProposalArguments(validationCapability, toolName, envelope, args); check();
        if (args.action === 'inspect') {
          if (!current) return proposalResponse({ navigationOnly: true, pending: null });
          if (args.proposalId !== undefined && args.proposalId !== current.proposalId
            || args.revisionDigest !== undefined && args.revisionDigest !== current.pointer.bytesDigest)
            throw proposalFailure('Foreign or stale proposal navigation');
          if (args.proposalId === undefined && args.revisionDigest === undefined && args.path === undefined)
            return proposalResponse({ navigationOnly: true, proposalId: current.proposalId, revisionDigest: current.pointer.bytesDigest });
          const ack = await confirmAck(current); check();
          if (call.index <= current.ackPosition) throw proposalFailure('Proposal navigation requires a later assistant response');
          let value = current.materialized;
          for (const token of args.path ?? []) {
            if (unsafeProposalKeys.has(token) || !value || typeof value !== 'object'
              || Array.isArray(value) && !Number.isSafeInteger(token) || !Array.isArray(value) && typeof token !== 'string'
              || !Object.hasOwn(value, token)) throw proposalFailure('Unknown proposal navigation path');
            value = value[token];
          }
          const bytes = Buffer.from(JSON.stringify(value)), start = args.offset ?? 0, limit = args.limit ?? 2048;
          if (start > bytes.length || start < bytes.length && (bytes[start] & 0xc0) === 0x80) throw proposalFailure('Navigation offset is not a UTF8 boundary');
          let end = Math.min(bytes.length, start + limit); while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
          return proposalResponse({ navigationOnly: true, proposalId: current.proposalId, revisionDigest: current.pointer.bytesDigest,
            path: args.path ?? [], offset: start, totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null,
            text: bytes.subarray(start, end).toString('utf8'), acknowledgement: ack.bytesDigest });
        }
        const scope = proposalCopy(identity()), wire = proposalCopy(args), key = sha256({ protocol: BASELINE_PROPOSAL_PROTOCOL,
          native: owner.native, scope, wire, schemaDigest: sha256(parameters) });
        const previous = attempts.get(key);
        if (previous) {
          if (!isDeepStrictEqual(previous.wire, wire) || !previous.response) throw proposalFailure('Incomplete or conflicting proposal replay');
          if (id === previous.callId && !isDeepStrictEqual(previous.wire, wire)) throw proposalFailure('Conflicting native call replay');
          return proposalCopy(previous.response); // Never register a new ACK slot.
        }
        let parent = null, materialized, proposalId;
        if (args.action === 'submit') {
          if (current) throw Object.assign(proposalFailure('Correct the current owned draft explicitly; a new submit cannot abandon it'), { baselinePromptConflict: true });
          materialized = proposalCopy(initialProposalValue(args)); proposalId = newEvidenceLabel('rcproposal_');
        } else {
          if (!current || current.accepted || args.proposalId !== undefined && args.proposalId !== current.proposalId
            || args.parentRevisionDigest !== current.pointer.bytesDigest)
            throw proposalFailure('Correction has a foreign or stale parent');
          if (args.batchId !== undefined && args.batchId !== current.materialized.batchId)
            throw proposalFailure('Correction batchId must match the existing owned draft');
          if (!isDeepStrictEqual(current.scope, scope)) throw proposalFailure('Proposal source, generation, mode or expected batch changed');
          const ack = await confirmAck(current); check();
          const ackBytes = JSON.parse((await fs.readFile(ack.path)).toString('utf8')); check();
          if (call.index <= ackBytes.result.index) throw proposalFailure('Correction must be in a later assistant response after the original ACK');
          parent = { revision: current.pointer, outcome: current.outcome, acknowledgement: ack };
          materialized = materializeBaselineProposal(current.materialized, args.changes); proposalId = current.proposalId;
        }
        const nonce = randomBytes(32).toString('hex');
        const record = { protocol: BASELINE_PROPOSAL_PROTOCOL, toolName, proposalId, attemptId: key, attemptNonce: nonce,
          ownerRunNonce: owner.nonce, native: owner.native, windowStart: owner.anchorPointer, scope, parent,
          callId: id, call, wire, materialized, materializedDigest: sha256(materialized), schemaDigest: sha256(parameters),
          validatorIdentity: proposalCopy(validationCapability.identity) };
        revisionStarted = true;
        const pointer = await write(`revision-${nonce}.json`, record); check();
        const attempt = { owner, binding, callId: id, call, wire, scope, materialized, proposalId, nonce, pointer, parent, response: null, accepted: false };
        attempts.set(key, attempt);
        let prepared;
        try {
          validateBaselineProposalArguments(validationCapability, toolName, parameters, materialized); check();
          if (Buffer.byteLength(JSON.stringify(materialized)) > maxBytes) throw proposalFailure('Materialized arguments exceed the unchanged original limit');
          prepared = await prepare(proposalCopy(materialized)); check(); snapshot();
          if (!prepared || typeof prepared.commit !== 'function' || !prepared.receipt) throw proposalFailure('Submission did not prepare an atomic acceptance');
        } catch (error) {
          check();
          const rejection = { accepted: false, complete: false, code: error.code ?? 'BASELINE_PROPOSAL_REJECTED',
            message: String(error.message ?? error).split('\n\nReceived arguments:')[0].slice(0, 3072),
            ...proposalValidationFeedback(error),
            proposalId, attemptNonce: nonce, revisionDigest: pointer.bytesDigest, parentRevisionDigest: pointer.bytesDigest,
            repair: `Use action:"correct_and_submit", parentRevisionDigest:"${pointer.bytesDigest}" and explicit changes for only the reported fields. Omit the redundant proposalId; do not submit a new draft. This is not approval, a read grant, or extra budget.` };
          try {
            const debit = await owner.budget.rejectAttempt({ attemptId: key, revision: pointer, nativeCallId: id, wireDigest: sha256(wire) },
              { message: rejection.message.slice(0, 512), validation: rejection.validation }); check();
            attempt.outcome = await write(`outcome-${nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, revision: pointer, accepted: false, debit, receipt: rejection }); check();
          } catch (failure) { stopAfterRejectionFailure(failure); }
          attempt.receiptText = JSON.stringify(rejection); attempt.response = proposalResponse(rejection, true);
          current = attempt; slots.set(id, attempt); return proposalCopy(attempt.response);
        }
        const receipt = { ...proposalCopy(prepared.receipt), proposal: { protocol: BASELINE_PROPOSAL_PROTOCOL,
          proposalId, attemptNonce: nonce, materializedDigest: sha256(materialized), revision: pointer } };
        try {
          attempt.outcome = await write(`outcome-${nonce}.json`, { protocol: BASELINE_PROPOSAL_PROTOCOL, revision: pointer, accepted: true, receipt }); check();
          await prepared.commit(receipt, { protocol: BASELINE_PROPOSAL_PROTOCOL, revision: pointer, outcome: attempt.outcome }); check();
        } catch (error) { uncertain = true; throw error; }
        attempt.accepted = true; attempt.receiptText = JSON.stringify(receipt); attempt.response = proposalResponse(receipt);
        current = null; return proposalCopy(attempt.response);
        } catch (error) {
          if (revisionStarted || terminalBudgetError || uncertain || abort?.aborted) throw error;
          return rejectBoundary(error, id, args);
        }
      });
    },
  };
  return Object.freeze(api);
}

// The caller supplies its own current schema factory and public capability.
// Neither module paths nor schemas are selected from the serialized proof.
export async function verifyOwnedBaselineProposal({ directory, proof, toolName, parameters, validationCapability,
  materialized, receipt, windows, projectRoot, taskId, assertScope = () => {} }) {
  if (proof?.protocol !== BASELINE_PROPOSAL_PROTOCOL || !projectRoot || !taskId) throw proposalFailure('Missing owned proposal verification context');
  const root = await fs.realpath(directory);
  async function read(pointer) {
    if (!pointer?.path || path.dirname(path.resolve(pointer.path)) !== root || await fs.realpath(pointer.path) !== path.resolve(pointer.path))
      throw proposalFailure('Foreign immutable proposal pointer');
    const bytes = await fs.readFile(pointer.path);
    if (sha256(bytes) !== pointer.bytesDigest || bytes.at(-1) !== 10) throw proposalFailure('Immutable proposal bytes changed');
    const value = JSON.parse(bytes.toString('utf8')); assertBaselineProposalJson(value); return value;
  }
  const rows = []; let next = proof.revision, outcomePointer = proof.outcome;
  while (next) {
    if (rows.length >= 22 || rows.some(row => row.pointer.path === next.path)) throw proposalFailure('Cyclic or oversized proposal revision chain');
    const record = await read(next), outcome = await read(outcomePointer);
    if (record.protocol !== BASELINE_PROPOSAL_PROTOCOL || record.toolName !== toolName
      || outcome.protocol !== BASELINE_PROPOSAL_PROTOCOL || !isDeepStrictEqual(outcome.revision, next)
      || record.materializedDigest !== sha256(record.materialized)
      || path.basename(next.path) !== `revision-${record.attemptNonce}.json`)
      throw proposalFailure('Unbound proposal revision or outcome');
    assertScope(record.scope);
    const strictSchema = typeof parameters === 'function' ? parameters(record.scope) : parameters;
    if (record.schemaDigest !== sha256(strictSchema) || !isDeepStrictEqual(record.validatorIdentity, validationCapability?.identity))
      throw proposalFailure('Proposal validator or complete old schema identity changed');
    let validationError;
    try { validateBaselineProposalArguments(validationCapability, toolName, strictSchema, record.materialized); }
    catch (error) { validationError = error; }
    if (rows.length === 0 && (validationError || outcome.accepted !== true)) throw validationError ?? proposalFailure('Final proposal was not fully accepted');
    if (rows.length && outcome.accepted !== false) throw proposalFailure('Correction parent was not a rejected owned revision');
    rows.push({ pointer: next, record, outcome, outcomePointer });
    if (!record.parent) break;
    next = record.parent.revision; outcomePointer = record.parent.outcome;
  }
  rows.reverse();
  let previous = null;
  const final = rows.at(-1);
  if (!final || !isDeepStrictEqual(final.record.materialized, materialized) || !isDeepStrictEqual(final.outcome.receipt, receipt)
    || receipt.proposal?.materializedDigest !== sha256(materialized)
    || !isDeepStrictEqual(receipt.proposal.revision, proof.revision)) throw proposalFailure('Accepted arguments or receipt differ from explicit submission');
  const native = final.record.native;
  if (native.taskId !== taskId) throw proposalFailure('Foreign proposal task');
  const physicalPath = path.join(projectRoot, '.runtime-correction/openclaw/native-runs', sha256(taskId), `${native.runId}.json`);
  const physical = JSON.parse(await fs.readFile(physicalPath, 'utf8'));
  if (physical.status !== 'SETTLED' || !Number.isFinite(physical.settledAt)
    || ['taskId', 'runId', 'sessionId', 'role', 'ownerPid', 'startedAt', 'sessionFile'].some(key => physical[key] !== native[key]))
    throw proposalFailure('Proposal native owner has no actual physical settlement');
  const candidates = (windows ?? []).filter(window => isDeepStrictEqual(window.native, native));
  if (candidates.length !== 1) throw proposalFailure('Proposal has no unique closed native window');
  const start = await read(candidates[0].start), end = await read(candidates[0].end);
  const transcript = Buffer.from(end.transcript), prefix = Buffer.from(start.prefix);
  if (start.prefixBytesDigest !== sha256(prefix) || start.startByte !== prefix.length
    || end.transcriptBytesDigest !== sha256(transcript) || end.endByte !== transcript.length
    || !isDeepStrictEqual(end.start, candidates[0].start) || !transcript.subarray(0, prefix.length).equals(prefix)
    || !isDeepStrictEqual(start.native, native) || !isDeepStrictEqual(end.native, native)) throw proposalFailure('Closed native proposal window changed');
  const actual = proposalNativeSnapshot(native, transcript);
  // Parse only the immutable closed window, never later runs in the same file.
  let offset = 0;
  const data = { bytes: transcript, records: transcript.toString('utf8').split('\n').slice(0, -1).map(line => {
    const from = offset; offset += Buffer.byteLength(line) + 1; return { value: JSON.parse(line), start: from, end: offset };
  }) };
  if (actual.bytes.length < transcript.length) throw proposalFailure('Closed native proposal transcript was truncated');
  for (const row of rows) {
    const { record, outcome } = row;
    if (!isDeepStrictEqual(record.native, native) || record.ownerRunNonce !== start.ownerRunNonce
      || !isDeepStrictEqual(record.windowStart, candidates[0].start)) throw proposalFailure('Cross-run proposal chain');
    const call = proposalNativeCall(data, record.callId, toolName, record.wire, prefix.length);
    if (!isDeepStrictEqual(call, record.call)) throw proposalFailure('Original proposal native call bytes or position changed');
    const results = data.records.map((item, index) => ({ item, index })).filter(({ item }) => item.value.message?.role === 'toolResult'
      && item.value.message.toolCallId === record.callId);
    if (results.length !== 1 || results[0].index <= call.index || results[0].item.value.message.toolName !== toolName
      || results[0].item.value.message.isError !== false || proposalText(results[0].item.value.message) !== JSON.stringify(outcome.receipt))
      throw proposalFailure('Proposal has no exact original native result');
    if (!previous) {
      if (record.parent || record.wire.action !== 'submit' || !isDeepStrictEqual(initialProposalValue(record.wire), record.materialized))
        throw proposalFailure('Initial explicit submit does not equal its full materialization');
    } else {
      if (record.wire.action !== 'correct_and_submit'
        || record.wire.proposalId !== undefined && record.wire.proposalId !== previous.record.proposalId
        || record.wire.batchId !== undefined && record.wire.batchId !== previous.record.materialized.batchId
        || record.proposalId !== previous.record.proposalId || record.wire.parentRevisionDigest !== previous.pointer.bytesDigest
        || !isDeepStrictEqual(record.parent.revision, previous.pointer) || !isDeepStrictEqual(record.parent.outcome, previous.outcomePointer)
        || !isDeepStrictEqual(materializeBaselineProposal(previous.record.materialized, record.wire.changes), record.materialized))
        throw proposalFailure('Explicit correction does not uniquely determine the submitted full arguments');
      const ack = await read(record.parent.acknowledgement);
      if (!isDeepStrictEqual(ack.revision, previous.pointer) || !isDeepStrictEqual(ack.outcome, previous.outcomePointer)
        || ack.attemptNonce !== previous.record.attemptNonce || ack.ownerRunNonce !== previous.record.ownerRunNonce
        || !isDeepStrictEqual(ack.call, previous.record.call) || ack.result.index >= call.index
        || ack.result.start < ack.hookFrontier || ack.observed?.isSynthetic !== false
        || ack.observed.toolCallId !== previous.record.callId || ack.observed.toolName !== toolName
        || proposalText(ack.observed.message) !== JSON.stringify(previous.outcome.receipt)
        || ack.observed.message.isError !== false || !transcript.subarray(0, Buffer.byteLength(ack.transcript)).equals(Buffer.from(ack.transcript)))
        throw proposalFailure('Parent negative ACK lacks genuine persist, actual append or later-call causality');
      const originalResult = data.records[ack.result.index];
      if (!originalResult || originalResult.start !== ack.result.start || originalResult.end !== ack.result.end
        || originalResult.value.message?.toolCallId !== previous.record.callId
        || proposalText(originalResult.value.message) !== JSON.stringify(previous.outcome.receipt)) throw proposalFailure('Negative ACK native interval changed');
    }
    if (outcome.accepted === false) {
      const debit = outcome.debit, journal = debit?.journal;
      if (!journal?.path || !Number.isSafeInteger(journal.bytes)) throw proposalFailure('Rejected proposal has no original repair debit');
      const bytes = (await fs.readFile(journal.path)).subarray(0, journal.bytes);
      if (bytes.length !== journal.bytes || bytes.at(-1) !== 10 || sha256(bytes) !== journal.sha256) throw proposalFailure('Original proposal repair debit journal changed');
      const events = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const matching = events.filter(event => event.id === debit.entryId);
      if (matching.length !== 1 || matching[0].event !== 'REPAIR' || matching[0].reason !== 'proposal_validation'
        || matching[0].attemptId !== record.attemptId || matching[0].ordinal !== debit.ordinal
        || matching[0].runId !== native.runId || matching[0].sessionId !== native.sessionId
        || matching[0].nativeCallId !== record.callId || matching[0].wireDigest !== sha256(record.wire)
        || !isDeepStrictEqual(matching[0].revision, row.pointer)) throw proposalFailure('Rejected revision repair debit is not unique and attributable');
    }
    previous = row;
  }
  return { record: final.record, outcome: final.outcome, window: candidates[0] };
}

export const CONDITIONAL_REVIEW_POLICY_VERSION = 'current-boundary-v1';
export const CONDITION_ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['activation', 'reason', 'evidenceKind'],
  properties: {
    activation: { type: 'string', enum: ['ACTIVE', 'INACTIVE_AT_CURRENT_BOUNDARY', 'PENDING_REQUIRED_TRIGGER', 'UNKNOWN'] },
    reason: { type: 'string', minLength: 1, maxLength: 4000 },
    evidenceKind: { type: 'string', enum: ['TARGET_FACTS', 'PROCESS_EVENT', 'PROCESS_WINDOW'] },
    afterCallId: { type: 'string', minLength: 1, maxLength: 256 },
  },
};
export const CONDITIONAL_REVIEW_INSTRUCTIONS = 'For a CONDITIONAL item supply conditionAssessment with activation and original-condition reason, plus evidenceKind. ACTIVE is judged P/D/U with the original owner. INACTIVE_AT_CURRENT_BOUNDARY requires actual current facts and NOT_APPLICABLE; it is not a permanent exemption. PENDING_REQUIRED_TRIGGER means a required later stage/event remains due: use NOT_YET_APPLICABLE and do not claim completion. UNKNOWN/missing activation proof is UNVERIFIED. For absence of later actions use PROCESS_WINDOW with afterCallId naming an attributable original invocation/result; read the complete window through the current completion cursor. Current hashes, labels, quotations and missing logs cannot alone establish inactivity. Internal conditional branches cannot exclude other unconditional clauses of a compound original.';
const conditionError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// This chooses a conservative evidence requirement, never a verdict or a
// source's meaning. Target-only exemptions remain possible for target facts.
export function requiresConditionWindow(object = {}) {
  return /(?:later|subsequent|since|after.{0,60}(?:edit|chang|correct|action|operation)|re-?run|again after|后续|此后|修改后|纠正后|再次)/iu
    .test([object.condition, object.applicability, object.description, object.text].filter(Boolean).join('\n'));
}

export function validateConditionalAssessment({ assessment, verdict, context = {} }) {
  if (!assessment && verdict === 'UNVERIFIED') return null;
  if (!assessment || Object.keys(assessment).some(key => !['activation', 'reason', 'evidenceKind', 'afterCallId'].includes(key))
    || !CONDITION_ASSESSMENT_SCHEMA.properties.activation.enum.includes(assessment.activation)
    || typeof assessment.reason !== 'string' || !assessment.reason.trim() || assessment.reason.length > 4000
    || !CONDITION_ASSESSMENT_SCHEMA.properties.evidenceKind.enum.includes(assessment.evidenceKind))
    throw conditionError('REVIEW_CONDITION_ASSESSMENT_REQUIRED', 'Supply the original condition activation, reason and evidence kind; unknown proof must remain UNVERIFIED.');
  const allowed = { ACTIVE: ['PASS', 'DEVIATION', 'UNVERIFIED'], INACTIVE_AT_CURRENT_BOUNDARY: ['NOT_APPLICABLE'],
    PENDING_REQUIRED_TRIGGER: ['NOT_YET_APPLICABLE'], UNKNOWN: ['UNVERIFIED'] }[assessment.activation];
  if (!allowed.includes(verdict)) throw conditionError('REVIEW_CONDITION_VERDICT_CONFLICT',
    `${assessment.activation} permits ${allowed.join('/')}. Reassess original evidence; no verdict is automatically converted.`);
  if (verdict !== 'UNVERIFIED') {
    if (context.policy !== CONDITIONAL_REVIEW_POLICY_VERSION || context.basisComplete !== true || !context.currentCursor
      || !context.targetEvidence && !context.processEvidence)
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'Complete original basis and observed current target/process evidence are required.');
    const windowRequired = assessment.evidenceKind === 'PROCESS_WINDOW'
      || assessment.activation === 'INACTIVE_AT_CURRENT_BOUNDARY' && context.requiresProcessWindow;
    if (windowRequired && (assessment.evidenceKind !== 'PROCESS_WINDOW' || !context.processEvidence
      || !context.processWindow?.complete || !assessment.afterCallId
      || context.processWindow.afterCallId !== assessment.afterCallId || context.processWindow.cursor !== context.currentCursor))
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'Read an attributable invocation/result and the complete relevant original window through the current completion cursor; hashes alone cannot prove event absence.');
    if (assessment.evidenceKind === 'TARGET_FACTS' && !context.targetEvidence
      || assessment.evidenceKind === 'PROCESS_EVENT' && !context.processEvidence)
      throw conditionError('REVIEW_CONDITION_EVIDENCE_UNAVAILABLE', 'The selected evidence kind has no observed original witness.');
  }
  return { ...assessment, policy: CONDITIONAL_REVIEW_POLICY_VERSION, cursor: context.currentCursor ?? null,
    objectId: context.objectId ?? null, ...(context.objectRevision != null ? { objectRevision: context.objectRevision } : {}),
    ...(context.objectDigest ? { objectDigest: context.objectDigest } : {}),
    ...(context.processWindow ? { window: context.processWindow } : {}) };
}

// Caller-owned captured originals and actual acknowledged read coverage. A
// selected anchor is not proof until both matching events and every later
// record have been disclosed in the same frozen assessment.
export function bindConditionProcessWindow({ entries = [], afterCallId, readComplete, complete = false, cursor = sha256(entries), source = null }) {
  const blocks = entry => Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const calls = entries.flatMap((entry, index) => blocks(entry).filter(block => block.type === 'tool_use' && block.id === afterCallId).map(() => index));
  const results = entries.flatMap((entry, index) => blocks(entry).filter(block => block.type === 'tool_result' && block.tool_use_id === afterCallId).map(() => index));
  const call = calls[0] ?? -1, result = results[0] ?? -1;
  const valid = complete === true && typeof afterCallId === 'string' && calls.length === 1 && results.length === 1
    && result > call && entries[call]?.type === 'assistant' && entries[result]?.type === 'user'
    && typeof readComplete === 'function' && entries.slice(call).every((_, index) => readComplete(call + index));
  return { afterCallId: afterCallId ?? null, cursor, complete: Boolean(valid), from: call, result, through: entries.length - 1,
    ...(source?.path ? { sourcePath: source.path, sourceHash: source.hash } : {}) };
}

// readTranscriptSnapshot intentionally tolerates a partial append. That is
// useful for hooks, but insufficient for proving that an event did not occur.
export async function captureConditionSnapshot(snapshot, transcriptPath) {
  const entries = snapshot?.entries ?? [], cursor = sha256(entries);
  if (snapshot?.missing || snapshot?.truncated) return { complete: false, cursor };
  if (!transcriptPath) return { complete: snapshot?.conditionWindowComplete === true, cursor };
  try {
    const text = await fs.readFile(transcriptPath, 'utf8');
    const original = text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
    return { complete: Boolean(snapshot.digest) && sha256(text) === snapshot.digest && sha256(original) === cursor,
      cursor, path: path.resolve(transcriptPath), hash: sha256(text) };
  } catch { return { complete: false, cursor }; }
}
export async function conditionWindowCurrent(binding) {
  if (!binding?.sourcePath) return binding?.complete === true;
  try { return sha256(await fs.readFile(binding.sourcePath, 'utf8')) === binding.sourceHash; }
  catch { return false; }
}

export async function durableTaskJson(file, value, active = () => {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      active();
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function createTaskEvidence({ root, workspaceRoot, evidencePolicy = {}, numberedReadFiles = [], overlappingReadFiles = [],
  signal, active, journal, citationId, onTool = () => {} }) {
  const live = Boolean(workspaceRoot);
  if (!live) {
    signal?.throwIfAborted();
    root = await fs.realpath(root);
    signal?.throwIfAborted();
  }
  const snapshot = live ? new Map() : await captureFiles(root, { signal }), reads = [], registry = new Map(), pending = new Map();
  const numberedFiles = new Set(numberedReadFiles);
  const overlapFiles = new Set(overlappingReadFiles), specialFiles = [...numberedFiles, ...overlapFiles];
  if (specialFiles.length && (live || specialFiles.some(file => !snapshot.has(file))))
    throw new Error('Read defaults require exact files in the frozen inventory');
  const resolutions = new Map();
  const inventories = new Map();
  const versions = new Map();
  const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  const metrics = { toolCalls: 0, readBytes: 0, totalToolBytes: 0, repeatedLines: 0 };
  const trackDiscovery = scope => !scope?.navigation || evidencePolicy.trackNavigation?.(scope.root) !== false;
  const tools = (live ? createLiveSourceTools(workspaceRoot, {
    onPath(requested, real, scope) {
      if (!trackDiscovery(scope) || evidencePolicy.trackFile?.(real) === false) return;
      if (resolutions.has(requested) && resolutions.get(requested) !== real) throw Object.assign(new Error('Searched path changed'), { code: 'BASELINE_INPUT_CHANGED' });
      resolutions.set(requested, real);
    },
    onDirectory(directory, names, scope) {
      if (!trackDiscovery(scope) || evidencePolicy.trackDirectory?.(directory) === false) return;
      const hash = sha256(names);
      if (inventories.has(directory) && inventories.get(directory) !== hash) throw Object.assign(new Error('Searched inventory changed'), { code: 'BASELINE_INPUT_CHANGED' });
      inventories.set(directory, hash);
    },
    async onSearchFile(file, bytes, scope) {
      if (!trackDiscovery(scope) || evidencePolicy.trackFile?.(file) === false) return;
      const hash = sha256(bytes);
      if (snapshot.has(file) && snapshot.get(file).sha256 !== hash) throw Object.assign(new Error('Searched evidence changed'), { code: 'BASELINE_INPUT_CHANGED' });
      snapshot.set(file, { sha256: hash, lines: bytes.toString('utf8').split('\n').length });
      versions.set(file, version(await fs.stat(file, { bigint: true })));
    },
  }) : createSourceTools(root, snapshot)).map(tool => ({ ...tool, name: `source_${tool.name}`,
    async execute(id, args, abort) {
      active(); abort?.throwIfAborted();
      if (typeof id !== 'string' || !id.trim() || pending.has(id)) throw new Error('A unique real tool call id is required');
      if (!live && tool.name === 'read' && typeof args.path === 'string') {
        const relative = path.relative(root, path.resolve(root, args.path)).replaceAll('\\', '/');
        if (args.numbered === undefined && numberedFiles.has(relative)) args = { ...args, numbered: true };
        if (overlapFiles.has(relative)) args = { ...args, overlapBoundary: true };
      }
      const result = await tool.execute(id, args, abort && signal ? AbortSignal.any([abort, signal]) : abort ?? signal);
      active();
      let returned = result, text = toolText(result);
      if (tool.name === 'read' && !result.isError) {
        const requested = path.resolve(workspaceRoot ?? root, args.path), absolute = await fs.realpath(requested);
        if (evidencePolicy.trackFile?.(absolute) === false) {
          metrics.toolCalls++; metrics.readBytes += Buffer.byteLength(text); metrics.totalToolBytes += Buffer.byteLength(text);
          journal.appendMessage({ role: 'historical_observation', content: JSON.stringify({ tool: tool.name, args, contextOnly: true }) });
          return { ...result, details: { ...result.details, contextOnly: true } };
        }
        const file = live ? absolute : path.relative(root, absolute).replaceAll('\\', '/'), bytes = await fs.readFile(absolute);
        if (live) {
          const metadata = { sha256: sha256(bytes), lines: bytes.toString('utf8').split('\n').length };
          if (snapshot.has(file) && snapshot.get(file).sha256 !== metadata.sha256) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
          if (resolutions.has(requested) && resolutions.get(requested) !== absolute) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
          snapshot.set(file, metadata); resolutions.set(requested, absolute);
          versions.set(file, version(await fs.stat(absolute, { bigint: true })));
        }
        if (sha256(bytes) !== snapshot.get(file)?.sha256) throw Object.assign(new Error('BASELINE_INPUT_CHANGED'), { code: 'BASELINE_INPUT_CHANGED' });
        const range = disclosedRange(bytes, args, result);
        if (range) {
          const citation = registerCitation({ registry: new Map(), bytes, file, sha256: snapshot.get(file).sha256, range, id: citationId?.(file, range) });
          text = `[citeId="${citation.citeId}" | range ${file}:${range.start}-${range.end}]\n${text}`;
          returned = { ...result, content: textBlocks(text), details: { ...result.details, citation } };
          pending.set(id, { citation, text });
        }
      }
      metrics.toolCalls++; metrics.totalToolBytes += Buffer.byteLength(text);
      if (tool.name === 'read') metrics.readBytes += Buffer.byteLength(text);
      journal.appendMessage({ role: 'historical_observation', content: JSON.stringify({ tool: tool.name, args, bytes: Buffer.byteLength(text) }) });
      onTool({ name: tool.name, args });
      return returned;
    },
  }));
  function observeReceipt(event) {
    if (signal?.aborted || event.isSynthetic !== false || event.toolName !== 'source_read') return;
    const expected = pending.get(event.toolCallId), message = event.message;
    if (!expected) return;
    pending.delete(event.toolCallId);
    if (message?.role !== 'toolResult' || message.toolName !== 'source_read' || message.toolCallId !== event.toolCallId
      || message.isError !== false || !message.content?.length || message.content.some(block => block.type !== 'text')
      || toolText(message) !== expected.text) return;
    active();
    const { citation, text } = expected;
    journal.appendMessage({ role: 'toolResult', toolName: 'source_read', toolCallId: event.toolCallId,
      content: [{ type: 'text', text }], isError: false,
      details: { citation, receiptBoundary: event.receiptBoundary ?? 'openclaw.tool_result_persist.v1',
        ...(event.hostToolCallId ? { hostToolCallId: event.hostToolCallId } : {}) } });
    for (let line = citation.start; line <= citation.end; line++) if (covers(reads, citation.path, line, line)) metrics.repeatedLines++;
    reads.push({ path: citation.path, start: citation.start, end: citation.end }); registry.set(citation.citeId, citation);
  }
  async function assertFrozen({ force = false } = {}) {
    active();
    if (live) {
      for (const [directory, hash] of inventories) if (sha256((await fs.readdir(directory)).sort()) !== hash)
        throw Object.assign(new Error(`Searched inventory changed: ${directory}`), { code: 'BASELINE_INPUT_CHANGED' });
      for (const [requested, real] of resolutions) if (await fs.realpath(requested) !== real)
        throw Object.assign(new Error('Read path changed'), { code: 'BASELINE_INPUT_CHANGED' });
      for (const [file, metadata] of snapshot) {
        const current = version(await fs.stat(file, { bigint: true }));
        if ((force || current !== versions.get(file)) && sha256(await fs.readFile(file, { signal })) !== metadata.sha256)
          throw Object.assign(new Error('Read evidence changed'), { code: 'BASELINE_INPUT_CHANGED' });
        versions.set(file, current);
      }
      active(); return;
    }
    const current = await captureFiles(root, { signal });
    if (sha256([...current]) !== sha256([...snapshot])) throw Object.assign(new Error('Frozen baseline inputs changed'), { code: 'BASELINE_INPUT_CHANGED' });
    active();
  }
  const lookupCitation = id => registry.get(id) ?? [...pending.values()].find(entry => entry.citation.citeId === id)?.citation;
  return { tools, snapshot, reads, registry, metrics, resolutions, inventories, observeReceipt, assertFrozen, lookupCitation };
}
