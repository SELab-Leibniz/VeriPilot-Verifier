// A scripted independent model, using production source tools and native evidence.
// It is deliberately not a semantic oracle. Tests may supply concrete REPAIR/UNKNOWN reports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BASELINE_COVERAGE_SCHEMA, decodeBaselineAuditReport, decodeBaselineAuditView } from '../../lib/runtime-v2/baseline-coverage-audit.mjs';
import { planGroundTruthDelta } from '../../lib/runtime-v2/ground-truth-ledger.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';
import { outsideDecision } from '../../lib/runtime-v2/decision-scope.mjs';

const catalogUnits = files => JSON.parse([...files].filter(([name]) => /^unit-catalog-\d+\.txt$/u.test(name))
  .sort(([a], [b]) => Number(a.slice(13, -4)) - Number(b.slice(13, -4))).map(([, text]) => text).join(''));

// Pure source-only builder. The caller must author semantic expectations from
// originals; neither candidate objects nor their old source-linked labels are inputs.
export function scriptedSourceInventory({ request, files, citations }, interpret = ({ source, unit, fullText }) => {
  if (source.kind === 'USER_MESSAGE' && fullText === 'Preserve the requested feature.')
    return [{ statement: unit.text, owner: 'IMPLEMENTATION', condition: 'During the requested task.' }];
  if (source.kind === 'MATERIAL' && fullText === 'Original material condition.') return [];
  throw new Error(`Missing independently authored source-only fixture interpretation for ${source.kind}:${source.ref}`);
}) {
  const units = catalogUnits(files), originals = request.sources.map(source => ({ kind: source.kind, ref: source.ref,
    fullText: source.originalParts.map(part => files.get(part.path)).join('') }));
  return { identityDigest: request.identityDigest, sources: request.sources.map(source => {
    const fullText = source.originalParts.map(part => files.get(part.path)).join('');
    const own = citations.filter(cite => source.originalParts.some(part => part.path === cite.path));
    return { kind: source.kind, ref: source.ref, units: units.filter(unit => unit.kind === source.kind && unit.ref === source.ref).map(unit => {
      const duties = interpret({ source, unit, fullText, originals });
      assert(Array.isArray(duties), 'Each original unit needs an explicit fixture interpretation; no candidate-based fallback');
      return { rangeMode: 'UNIT', unitId: unit.unitId, citeIds: own.map(cite => cite.citeId),
        disposition: duties.length ? 'DUTIES' : 'CONTEXT', reason: 'Explicit offline source interpretation; fallible and not a semantic oracle.',
        obligations: duties.map((duty, index) => ({ obligationId: `${unit.unitId}-duty-${index}`, ...duty,
          reason: duty.reason ?? 'Independently authored controlled original expectation before candidate disclosure.' })) };
    }) };
  }) };
}

export function scriptedCoverageReport({ view, files, citations, identityDigest, inventory }) {
  const units = catalogUnits(files), active = view.effectiveLedger.claims.filter(claim => claim.status === 'ACTIVE');
  const base = ref => ref?.replace(/#L\d+(?:-L?\d+)?$/u, '');
  return { identityDigest, inventoryDigest: sha256(inventory), verdict: 'PASS', sources: view.sources.map(source => {
    const own = citations.filter(cite => source.parts.some(part => `original-${part.file}` === cite.path));
    const original = inventory.sources.find(row => row.kind === source.kind && row.ref === source.ref);
    const claims = active.filter(claim => base(claim.source?.ref) === source.ref
      || view.plan.operationDispositions.some(row => row.disposition === 'DEDUPLICATED' && row.effectiveTarget?.claimId === claim.claimId
        && base(view.delta.operations[row.operationIndex].source?.ref) === source.ref));
    const mappings = units.filter(unit => unit.ref === source.ref && unit.kind === source.kind).flatMap(unit => {
      const duties = original.units.find(row => row.unitId === unit.unitId).obligations;
      const fields = { rangeMode: 'QUOTE', unitId: unit.unitId, quote: unit.text, citeIds: own.map(cite => cite.citeId),
        supportMode: 'DIRECT', dependencyUnitIds: [] };
      if (!duties.length) return [{ ...fields, claimIds: [], obligationIds: [], owner: 'CONTEXT', condition: '',
        reason: 'Explicit fixture source-only context interpretation; no target is granted.' }];
      const targets = [...new Map([...claims, ...active.filter(claim => duties.some(duty => duty.statement === claim.text))]
        .map(claim => [claim.claimId, claim])).values()];
      const entries = targets.map(claim => {
        const duty = duties.find(duty => duty.statement === claim.text) ?? duties.find(duty => duty.owner === claim.verificationTarget) ?? duties[0];
        return { ...fields, claimIds: [claim.claimId], obligationIds: [duty.obligationId], owner: duty.owner,
          condition: claim.applicability ?? '', reason: 'Scripted phase-two matching against separately committed source expectations; not a semantic theorem.' };
      });
      for (const duty of duties) if (!entries.some(entry => entry.obligationIds.includes(duty.obligationId))) {
        const claim = targets.find(claim => claim.verificationTarget === duty.owner);
        if (claim) entries.push({ ...fields, claimIds: [claim.claimId], obligationIds: [duty.obligationId], owner: duty.owner,
          condition: claim.applicability ?? '', reason: 'Explicit source duty matched in this controlled phase-two fixture.' });
      }
      return entries;
    });
    return { ref: source.ref, kind: source.kind, unitIds: original.units.map(unit => unit.unitId),
      disposition: mappings.some(entry => entry.claimIds.length) ? 'COVERED' : 'CONTEXT',
      reason: 'Controlled independently authored source interpretation; not a semantic completeness oracle.', issues: [], mappings };
  }) };
}

export async function runNativeCoverageFixture({ params, registry, hooks, report = scriptedCoverageReport, mutateResult = null, formatReport = JSON.stringify,
  repairReport = null, onSubmission = null, persistFinish = true, observeFinish = true,
  inventory: inventoryOracle = scriptedSourceInventory, persistInventory = true, observeInventory = true,
  onInventory = null, beforeInventory = null, afterInventory = null, returnWithoutFinish = null, skipRead = null }) {
  const request = JSON.parse(params.prompt), ctx = { sessionId: params.sessionId, sessionKey: params.sessionKey, runId: params.runId };
  const tools = registry(ctx), root = path.join(path.dirname(params.sessionFile), 'coverage-source');
  const citations = [], files = new Map(); let id = 0;
  await fs.writeFile(params.sessionFile, JSON.stringify({ type: 'session', version: 3, id: params.sessionId }) + '\n');
  async function readFile(file) {
    let offset = 1;
    do {
      params.onAssistantMessageStart();
      const toolCallId = `coverage${++id}`, args = { path: file, offset };
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'source_read', arguments: args }] } }) + '\n');
      const result = await tools.find(tool => tool.name === 'source_read').execute(toolCallId, args);
      if (result.isError) throw Object.assign(new Error(JSON.parse(result.content[0].text).message), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
      const message = { role: 'toolResult', toolCallId, toolName: 'source_read', content: result.content, details: result.details, isError: false };
      await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
      const callbacks = hooks.get('tool_result_persist');
      for (const callback of Array.isArray(callbacks) ? callbacks : [callbacks]) callback?.({ toolName: 'source_read', toolCallId, isSynthetic: false, message }, ctx);
      citations.push(result.details.citation);
      const next = result.details.page.nextOffset;
      offset = next && next > args.offset + 1 ? next - 1 : next; // Real overlapping disclosure retains page-boundary LF, never fabricates it.
    } while (offset);
    files.set(file, await fs.readFile(path.join(root, file), 'utf8'));
  }
  const sourceContext = { request, files, citations };
  for (const file of request.requiredFiles) await readFile(file);
  await beforeInventory?.({ params, tools, request, files, citations });
  const inventory = await inventoryOracle(sourceContext);
  assert(!Object.hasOwn(sourceContext, 'view'), 'The inventory oracle never receives a candidate view');
  params.onAssistantMessageStart();
  const inventoryId = `coverageinventory${++id}`, inventoryArgs = { inventory };
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: inventoryId, name: 'commit_baseline_inventory', arguments: inventoryArgs }] } }) + '\n');
  const inventoryResult = await tools.find(tool => tool.name === 'commit_baseline_inventory').execute(inventoryId, inventoryArgs);
  const inventoryMessage = { role: 'toolResult', toolCallId: inventoryId, toolName: 'commit_baseline_inventory',
    content: inventoryResult.content, isError: Boolean(inventoryResult.isError) };
  if (observeInventory) {
    const callbacks = hooks.get('tool_result_persist');
    for (const callback of Array.isArray(callbacks) ? callbacks : [callbacks]) callback?.({
      toolName: inventoryMessage.toolName, toolCallId: inventoryId, isSynthetic: false, message: inventoryMessage }, ctx);
  }
  await onInventory?.({ params, tools, request, inventory, inventoryId, inventoryArgs, inventoryResult, inventoryMessage, ctx });
  if (persistInventory) await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: inventoryMessage }) + '\n');
  params.onAgentToolResult?.({ toolName: inventoryMessage.toolName, result: inventoryResult, isError: inventoryMessage.isError });
  if (inventoryResult.isError) throw Object.assign(new Error(JSON.parse(inventoryResult.content[0].text).message), { code: 'BASELINE_COVERAGE_UNVERIFIED' });
  await afterInventory?.({ params, tools, request, inventory, inventoryId, inventoryArgs, inventoryResult, inventoryMessage, ctx });
  // Candidate bytes are first loaded only after an actual later gated tool read.
  await readFile(request.phaseTwoManifest);
  const phaseTwo = JSON.parse(files.get(request.phaseTwoManifest));
  for (const file of phaseTwo.requiredFiles) if (!files.has(file) && !skipRead?.(file)) await readFile(file);
  const view = decodeBaselineAuditView(JSON.parse([...files].filter(([name]) => name.startsWith('candidate-'))
    .sort(([a], [b]) => Number(a.slice(10, -4)) - Number(b.slice(10, -4))).map(([, text]) => text).join('')));
  const context = { view, files, citations, inventory, identityDigest: request.identityDigest };
  const unfinished = await returnWithoutFinish?.(context);
  if (unfinished) return typeof unfinished === 'object' ? unfinished
    : { payloads: [{ text: 'No confirmed audit finish; this is an incomplete native return.' }], meta: {} };
  let value = await report(context);
  await mutateResult?.({ value, params, view, files, citations });
  let attempt = 0, formatted;
  while (true) {
    params.onAssistantMessageStart();
    // The legacy formatter is a scripted model-output injection, not display
    // after an already accepted finish. Invalid output means no submission.
    formatted = await formatReport(value);
    // Raw JSON, including malformed report shapes, reaches the actual typed
    // tool so fixture setup never masks its specific validation feedback.
    try { value = JSON.parse(formatted); }
    catch {
      try { value = decodeBaselineAuditReport(formatted); } // Existing valid fenced-output fixture.
      catch (error) {
        if (error.code !== 'BASELINE_COVERAGE_UNVERIFIED') throw error;
        await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
          content: [{ type: 'text', text: formatted }] } }) + '\n');
        return { payloads: [{ text: formatted }], meta: {} };
      }
    }
    const toolCallId = `coveragefinish${++id}`, args = { report: value };
    await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: 'finish_baseline_audit', arguments: args }] } }) + '\n');
    const result = await tools.find(tool => tool.name === 'finish_baseline_audit').execute(toolCallId, args);
    const message = { role: 'toolResult', toolCallId, toolName: 'finish_baseline_audit', content: result.content, isError: Boolean(result.isError) };
    // Like the real host, the synchronous hook precedes transcript append.
    if (observeFinish) {
      const callbacks = hooks.get('tool_result_persist');
      for (const callback of Array.isArray(callbacks) ? callbacks : [callbacks])
        callback?.({ toolName: message.toolName, toolCallId, isSynthetic: false, message }, ctx);
    }
    if (persistFinish) await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
    params.onAgentToolResult?.({ toolName: message.toolName, result, isError: message.isError });
    await onSubmission?.({ params, value, result, attempt: ++attempt });
    if (!result.isError) break;
    const next = await repairReport?.({ ...context, params, value, result, attempt, readFile });
    if (!next) break;
    value = next; // Explicit scripted next turn; no independent retry allowance.
  }
  return { payloads: [{ text: formatted }], meta: {} };
}

export async function auditBaselineFixture({ handle, factory, input, current, scopeDigest = 'controlled-test-scope' }) {
  const plan = planGroundTruthDelta({ current, taskId: input.taskId, delta: handle.result, sourceCatalog: input.request.sourceCatalog });
  const auditInput = await handle.baselineTask.getAuditInput(plan, scopeDigest);
  const checker = await factory({ projectRoot: input.projectRoot, taskId: input.taskId, role: 'ground-truth-extractor',
    reviewer: { ...input.reviewer, session: 'detached', maxOutputTokens: auditInput.maxTokens, formatRepairAttempts: 0 },
    deadlineAt: handle.baselineTask.extractionDeadlineAt, schema: BASELINE_COVERAGE_SCHEMA,
    request: { reviewScope: { kind: 'baseline-coverage-audit' } }, baselineAuditInput: auditInput, baselineAuditBudget: handle.baselineTask.budget });
  try { return await handle.baselineTask.acceptAudit(checker.coverageAudit, auditInput,
    () => outsideDecision(() => handle.baselineTask.assertCurrent())); }
  finally { await checker.close(); }
}
