// Native observations establish facts at a receipt, not the meaning of a duty.
const id = { type: 'string', minLength: 1, maxLength: 2048 };
export const PROCESS_CLAIMS_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 16,
  items: { type: 'object', additionalProperties: false,
    required: ['invocationToolCallId', 'resultMessageId', 'resultToolCallId', 'observedState'],
    properties: { invocationToolCallId: id, resultMessageId: id, resultToolCallId: id,
      observedState: { type: 'string', enum: ['STARTED_RUNNING', 'TERMINATED'] },
      processSessionId: id, exitCode: { type: ['integer', 'null'] },
      exitSignal: { type: ['string', 'null'], anyOf: [id, { const: null }] } } },
};

const required = ['invocationToolCallId', 'resultMessageId', 'resultToolCallId', 'observedState'];
const optional = ['processSessionId', 'exitCode', 'exitSignal'];
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const blocks = entry => Array.isArray(entry?.message?.content) ? entry.message.content : [];
const entryId = entry => entry?.uuid ?? entry?.message?.id;
const append = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};
const native = value => record(value) && ['version', 'host', 'toolName'].every(key => own(value, key))
  && value.version === 1 && value.host === 'openclaw'
  && identifier(value.toolName) && (!own(value, 'invalidFields')
    || Array.isArray(value.invalidFields) && value.invalidFields.length === 0);

function state(details) {
  if (!record(details) || !own(details, 'status')) return null;
  const value = {};
  if (own(details, 'sessionId')) {
    if (!identifier(details.sessionId)) return null;
    value.processSessionId = details.sessionId;
  }
  if (own(details, 'exitCode')) {
    if (details.exitCode !== null && !Number.isSafeInteger(details.exitCode)) return null;
    value.exitCode = details.exitCode;
  }
  if (own(details, 'exitSignal')) {
    if (details.exitSignal !== null && !identifier(details.exitSignal)) return null;
    value.exitSignal = details.exitSignal;
  }
  if (details.status === 'running') {
    if (!value.processSessionId || value.exitCode != null || value.exitSignal != null) return null;
    return { observedState: 'STARTED_RUNNING', ...value };
  }
  if (!['completed', 'failed'].includes(details.status)
    || !Number.isSafeInteger(value.exitCode) && !identifier(value.exitSignal)
    || details.status === 'completed' && identifier(value.exitSignal)) return null;
  // A normal exec can be 'completed' with a nonzero exit code. Preserve it.
  return { observedState: 'TERMINATED', ...value };
}

/** Only already-owned native transcript entries may be supplied by the host. */
export function nativeProcessFacts(entries) {
  if (!Array.isArray(entries)) return [];
  const calls = new Map(), results = new Map(), messageIds = new Map();
  entries.forEach((entry, index) => {
    if (identifier(entryId(entry))) append(messageIds, entryId(entry), index);
    for (const block of blocks(entry)) {
      if (block?.type === 'tool_use' && identifier(block.id)) append(calls, block.id, { entry, index, block });
      if (block?.type === 'tool_result' && identifier(block.tool_use_id)) append(results, block.tool_use_id, { entry, index, block });
    }
  });
  const pairs = [];
  for (const [callId, invocations] of calls) {
    const returned = results.get(callId);
    if (invocations.length !== 1 || returned?.length !== 1) continue;
    const call = invocations[0], result = returned[0];
    const callHost = call.block.hostToolCall, resultHost = result.block.hostToolResult;
    if (call.entry?.type !== 'assistant' || call.entry.isMeta === true || result.entry?.type !== 'user' || result.entry.isMeta !== true
      || result.index <= call.index || !identifier(entryId(result.entry)) || messageIds.get(entryId(result.entry))?.length !== 1
      || !native(callHost) || !native(resultHost) || callHost.toolName !== resultHost.toolName) continue;
    const observed = state(resultHost.details);
    if (!observed) continue;
    pairs.push({ call, result, toolName: callHost.toolName, observed,
      identity: { invocationToolCallId: callId, resultMessageId: entryId(result.entry), resultToolCallId: result.block.tool_use_id } });
  }
  const origins = pairs.filter(pair => pair.toolName === 'exec' && pair.observed.observedState === 'STARTED_RUNNING');
  const facts = [];
  for (const pair of pairs) {
    let indices = [pair.call.index, pair.result.index];
    let invocationToolCallId = pair.identity.invocationToolCallId;
    if (pair.toolName === 'process') {
      const args = pair.call.block.input;
      if (!record(args) || args.action !== 'poll' || !identifier(args.sessionId)
        || args.sessionId !== pair.observed.processSessionId) continue;
      const candidates = origins.filter(origin => origin.observed.processSessionId === args.sessionId
        && origin.result.index < pair.call.index);
      const possible = [...results.values()].flat().filter(result => result.index < pair.call.index
        && native(result.block.hostToolResult) && result.block.hostToolResult.toolName === 'exec'
        && result.block.hostToolResult.details?.status === 'running'
        && result.block.hostToolResult.details?.sessionId === args.sessionId);
      if (candidates.length !== 1 || possible.length !== 1) continue;
      indices = [candidates[0].call.index, candidates[0].result.index, ...indices];
      invocationToolCallId = candidates[0].identity.invocationToolCallId;
    } else if (pair.toolName !== 'exec') continue;
    facts.push({ ...pair.identity, invocationToolCallId, ...pair.observed, requiredEntryIndices: indices });
  }
  return facts;
}

function unavailable(reason) {
  throw Object.assign(new Error('Process claim is not established by current native evidence: ' + reason),
    { code: 'REVIEW_ITEM_EVIDENCE_UNAVAILABLE' });
}
function validClaim(value) {
  return record(value) && Object.keys(value).every(key => [...required, ...optional].includes(key))
    && required.every(key => own(value, key)) && required.slice(0, 3).every(key => identifier(value[key]))
    && ['STARTED_RUNNING', 'TERMINATED'].includes(value.observedState)
    && (!own(value, 'processSessionId') || identifier(value.processSessionId))
    && (!own(value, 'exitCode') || value.exitCode === null || Number.isSafeInteger(value.exitCode))
    && (!own(value, 'exitSignal') || value.exitSignal === null || identifier(value.exitSignal));
}
const identity = value => JSON.stringify(required.slice(0, 3).map(key => value[key]));
const fingerprint = value => JSON.stringify([...required, ...optional].map(key => [own(value, key), value[key]])
  .concat([value.requiredEntryIndices]));

/** processFacts is host-only metadata, attached only after all required ACKs. */
export function validateProcessClaims({ claims, citations = [] } = {}) {
  if (claims === undefined) return undefined;
  if (!Array.isArray(claims) || claims.length < 1 || claims.length > 16) unavailable('supply one to sixteen factual claims.');
  const facts = new Map();
  for (const citation of citations) {
    const suppliedFacts = citation?.readProof?.processFacts;
    if (suppliedFacts === undefined) continue;
    if (!Array.isArray(suppliedFacts)) unavailable('malformed host fact list.');
    for (const supplied of suppliedFacts) {
      if (!record(supplied)) unavailable('malformed host fact.');
      const { requiredEntryIndices, ...fact } = supplied;
      if (!validClaim(fact) || !Array.isArray(requiredEntryIndices) || ![2, 4].includes(requiredEntryIndices.length)
        || requiredEntryIndices.some((index, at) => !Number.isSafeInteger(index) || index < 0
          || at > 0 && index <= requiredEntryIndices[at - 1])
        || fact.observedState === 'STARTED_RUNNING' && (!fact.processSessionId || fact.exitCode != null || fact.exitSignal != null)
        || fact.observedState === 'TERMINATED' && !Number.isSafeInteger(fact.exitCode) && !identifier(fact.exitSignal))
        unavailable('malformed host fact.');
      const key = identity(fact), versions = facts.get(key) ?? new Map();
      versions.set(fingerprint(supplied), fact); facts.set(key, versions);
    }
  }
  const seen = new Set();
  for (const claim of claims) {
    if (!validClaim(claim)) unavailable('malformed or foreign claim fields.');
    const key = identity(claim);
    if (seen.has(key)) unavailable('duplicate or conflicting claim identity.');
    seen.add(key);
    const versions = facts.get(key);
    if (versions?.size !== 1) unavailable('missing or ambiguous native identity.');
    const fact = versions.values().next().value;
    if (claim.observedState !== fact.observedState
      || optional.some(field => own(claim, field) && (!own(fact, field) || claim[field] !== fact[field])))
      unavailable('the claimed state or outcome contradicts the native receipt.');
  }
  return claims;
}
