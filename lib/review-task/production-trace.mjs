export const isProductionCoverageTask = task => task?.scope === 'SOURCE_IMPLEMENTATION'
  && task.reviewType === 'production-implementation-coverage-reviewer';

export function createProductionTraceSchema(Type) {
const text = Type.String({ minLength: 1, maxLength: 2000 });
const citations = Type.Array(Type.String(), { minItems: 1, maxItems: 6, uniqueItems: true });
return Type.Object({
  version: Type.Literal(1), entryPoint: text, actualInput: text, producerToConsumer: text,
  stateful: Type.Boolean(), statelessReason: Type.String({ maxLength: 2000 }),
  stateTargets: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 2000, description: 'A unique stable ID for this resource. Pair left/right must copy this ID exactly.' }),
    expression: Type.String({ minLength: 1, maxLength: 2000, description: 'Actual resource identity expression after production resolution, including the allowed input/configuration variables.' }),
    readers: Type.Array(text, { maxItems: 24 }),
    writers: Type.Array(text, { maxItems: 24, description: 'Every relevant production write, including auxiliary writes that might address this resource. Name its call and value/shape, not just its function definition.' }),
    producerValue: text, citeIds: citations,
  }, { additionalProperties: false }), { maxItems: 12 }),
  targetRelations: Type.Array(Type.Object({
    left: Type.String({ minLength: 1, maxLength: 2000, description: 'Copy an exact stateTargets[].id value; do not put an expression or descriptive label here.' }),
    right: Type.String({ minLength: 1, maxLength: 2000, description: 'Copy a different exact stateTargets[].id value; do not put an expression or descriptive label here.' }),
    identity: Type.Union(['SAME', 'MAY_ALIAS', 'DISJOINT', 'UNKNOWN'].map(value => Type.Literal(value))),
    overlapAttempt: Type.String({ minLength: 1, maxLength: 2000, description: 'Try to make the two target expressions equal using allowed inputs/configuration. Explain the construction or actual preventing constraint. Different names or nominal purposes do not prove disjointness.' }),
    effect: Type.Union(['SAFE', 'BREAKS_REQUIRED_FLOW', 'UNKNOWN'].map(value => Type.Literal(value))),
    explanation: text, citeIds: citations,
  }, { additionalProperties: false }), { maxItems: 66 }),
}, { additionalProperties: false });
}

// This checks the witness protocol, not arbitrary program semantics. Source
// disclosure/currentness remains the engine's separate responsibility.
export function validateProductionTrace(trace, sourceCiteIds, { requireSafe = true } = {}) {
  const fail = message => { throw new Error(`M16_PRODUCTION_TRACE: ${message}`); };
  const record = (value, keys, location) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${location} must be an object.`);
    const missing = keys.filter(key => !Object.hasOwn(value, key));
    if (missing.length) fail(`${location} is missing fields: ${missing.join(', ')}.`);
    const extra = Object.keys(value).filter(key => !keys.includes(key));
    if (extra.length) fail(`${location} has unknown fields: ${extra.join(', ')}.`);
    return true;
  };
  const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
  const sources = new Set(sourceCiteIds);
  const checkedCites = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 6
    && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && sources.has(id));
  if (!record(trace, ['version', 'entryPoint', 'actualInput', 'producerToConsumer', 'stateful', 'statelessReason', 'stateTargets', 'targetRelations'], 'productionTrace')
    || trace.version !== 1 || !['entryPoint', 'actualInput', 'producerToConsumer'].every(key => nonempty(trace[key]))
    || typeof trace.stateful !== 'boolean' || typeof trace.statelessReason !== 'string' || trace.statelessReason.length > 2000
    || !Array.isArray(trace.stateTargets) || trace.stateTargets.length > 12
    || !Array.isArray(trace.targetRelations) || trace.targetRelations.length > 66)
    fail('PASS requires a complete productionTrace with actual input, producers, consumer and resource inventory.');
  if (trace.stateful ? !trace.stateTargets.length : trace.stateTargets.length || !nonempty(trace.statelessReason))
    fail('Stateful flow requires its resource targets; stateless flow requires its concrete source-based reason and no hidden state targets.');
  const ids = new Set();
  for (const [index, target] of trace.stateTargets.entries()) {
    if (!record(target, ['id', 'expression', 'readers', 'writers', 'producerValue', 'citeIds'], `stateTargets[${index}]`)
      || !['id', 'expression', 'producerValue'].every(key => nonempty(target[key]))
      || ids.has(target.id) || !checkedCites(target.citeIds)
      || !['readers', 'writers'].every(key => Array.isArray(target[key]) && target[key].length <= 24 && target[key].every(nonempty))
      || !target.readers.length && !target.writers.length)
      fail('Each distinct target needs actual read/write operations, value provenance and checked current source citations.');
    ids.add(target.id);
  }
  const pairs = new Set();
  for (const [index, relation] of trace.targetRelations.entries()) {
    record(relation, ['left', 'right', 'identity', 'overlapAttempt', 'effect', 'explanation', 'citeIds'], `targetRelations[${index}]`);
    for (const side of ['left', 'right']) if (!ids.has(relation[side]))
      fail(`targetRelations[${index}].${side} must copy an exact stateTargets[].id: ${JSON.stringify([...ids])}. Expressions and descriptive labels are not IDs.`);
    if (relation.left === relation.right
      || !['SAME', 'MAY_ALIAS', 'DISJOINT', 'UNKNOWN'].includes(relation.identity)
      || !['SAFE', 'BREAKS_REQUIRED_FLOW', 'UNKNOWN'].includes(relation.effect)
      || !nonempty(relation.overlapAttempt) || !nonempty(relation.explanation) || !checkedCites(relation.citeIds))
      fail('Every target pair requires a cited allowed-input identity analysis and downstream effect.');
    const pair = JSON.stringify([relation.left, relation.right].sort());
    if (pairs.has(pair)) fail('Duplicate resource pair.');
    pairs.add(pair);
    if (requireSafe && (relation.identity === 'UNKNOWN' || relation.effect !== 'SAFE'))
      fail('An unknown identity/effect cannot establish PASS; a broken required flow supports DEVIATION.');
  }
  if (pairs.size !== ids.size * (ids.size - 1) / 2) fail(`Compare every distinct pair of stateTargets IDs ${JSON.stringify([...ids])}, including auxiliary targets; do not add self-pairs.`);
  return structuredClone(trace);
}
