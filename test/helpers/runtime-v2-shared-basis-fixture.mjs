// Shared fixture only; every invocation retains its own original task and tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createOpenClawReviewerFactory } from '../../lib/openclaw/reviewer.mjs';
import { registerTaskTools } from '../../lib/openclaw/task-tools.mjs';
import { registerReviewerProgress } from '../../lib/openclaw/reviewer-progress.mjs';
import { skillGraphQuoteCandidate as skillGraphCandidate, interpretSkillUnit } from './skill-source-interpretation.mjs';
import { compileRuntimeV2Config } from '../../lib/runtime-v2/config.mjs';
import { refreshRuntimeRequirements } from '../../lib/runtime-v2/orchestrator.mjs';
import { loadCurrentGroundTruth } from '../../lib/runtime-v2/ground-truth-ledger.mjs';
import { findTask, taskDirectory } from '../../lib/runtime-v2/task-store.mjs';
import { outsideDecision } from '../../lib/runtime-v2/decision-scope.mjs';
import { readJson } from '../../lib/runtime-v2/utils.mjs';
import { runStartedHostEvent } from './started-host.mjs';
import { observedLegacyStop } from './legacy-review.mjs';
import { runNativeCoverageFixture, scriptedCoverageReport, scriptedSourceInventory } from './baseline-coverage-native.mjs';

const user = (uuid = 'U1') => ({ type: 'user', uuid, message: { role: 'user', content: 'Preserve the requested feature.' } });
const operation = (ref = 'transcript:U1#L1-L1') => ({ operation: 'ADD', category: 'requirements',
  text: 'Preserve the requested feature.', authority: 'USER_EXPLICIT', severity: 'HARD', applicabilityKind: 'CURRENT_TASK',
  verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION', source: { ref, kind: 'USER_MESSAGE', subject: 'MAIN_TASK' } });

// Explicit source-only expectations for these controlled originals. Unknown
// fixtures must supply state.coverageInventory; do not infer from delta/claims,
// wireMode, previous reports, graph interpretations or candidate existence.
export function sharedOriginalDuties({ source, unit, fullText }) {
  const duty = (statement, owner, condition = 'During this task.') => ({ statement, owner, condition });
  const declared = new Map([
    ['Preserve the requested feature.', [duty('Preserve the requested feature.', 'IMPLEMENTATION')]],
    ['Preserve the revised requested feature.', [duty('Preserve the revised requested feature.', 'IMPLEMENTATION')]],
    ['Also expose a status endpoint.', [duty('Expose a status endpoint.', 'IMPLEMENTATION')]],
    ['Preserve the requested feature. Provide the second requested behavior.', [duty('Preserve the requested feature.', 'IMPLEMENTATION'), duty('Provide the second requested behavior.', 'IMPLEMENTATION')]],
    ['Preserve the requested feature. Write the usage guide.', [duty('Preserve the requested feature.', 'IMPLEMENTATION'), duty('Write the usage guide.', 'ARTIFACT')]],
    ['Write the usage guide. Write the reference guide.', [duty('Write the usage guide.', 'ARTIFACT'), duty('Write the reference guide.', 'ARTIFACT')]],
    ['Read the original contract. Verify after the final edit.', [duty('Read the original contract.', 'PROCESS', 'Before relying on the contract.'), duty('Verify after the final edit.', 'PROCESS', 'After the final edit, before completion.')]],
    ['Preserve the requested feature. Read and follow skills/demo/SKILL.md.', [duty('Preserve the requested feature.', 'IMPLEMENTATION'), duty('Read and follow skills/demo/SKILL.md.', 'PROCESS', 'Read the complete original and follow it during this task.')]],
    ['Create app.mjs and a short usage guide. Follow the selected demo Skill.', [duty('Create app.mjs.', 'IMPLEMENTATION'), duty('Write a short usage guide.', 'ARTIFACT'), duty('Follow the selected demo Skill.', 'PROCESS')]],
    ['Create app.mjs and a short usage guide for a stateless numeric validation module. Follow the selected delivery-verifier Skill in this workspace.', [
      duty('Create app.mjs implementing a stateless numeric validation module.', 'IMPLEMENTATION'),
      duty('Write a short usage guide for the stateless numeric validation module.', 'ARTIFACT'),
      duty('Follow the selected delivery-verifier Skill in this workspace.', 'PROCESS')]],
    ['The result preserves the requested feature.', []],
    ['The result preserves the requested feature. Additional controlled unadopted context.', []],
    ['Changed original material.', []], ['Original project obligation.', []], ['Changed project obligation.', []],
  ]);
  if (declared.has(fullText)) return unit.unitId.endsWith('U0') ? declared.get(fullText) : [];
  // Exact known long-source fixtures: only the leading requested behavior is
  // normative; the explicitly authored padding/background units are context.
  if (fullText === 'Preserve the requested feature. ' + 'x'.repeat(7000)
    || fullText === 'Preserve the requested feature.\r\n' + '说明：该段为背景上下文。\r\n'.repeat(1500))
    return unit.unitId.endsWith('U0') ? [duty('Preserve the requested feature.', 'IMPLEMENTATION')] : [];
  const simpleSkill = ['# Demo\nVerify before completion.\n', '# Demo\nVerify before completion, including errors.\n',
    '# Demo\nVerify before completion.\n\nDescriptive edition note.\n', '# Demo\nVerify before completion.\n\nNever modify public API signatures.\n'];
  if (simpleSkill.includes(fullText)) {
    assert.equal(unit.text, fullText, 'This known short original is one neutral compound block');
    if (fullText === '# Demo\nVerify before completion, including errors.\n')
      return [duty('Verify before completion, including errors.', 'PROCESS', 'Before completion, including error cases.')];
    const duties = [duty('Verify before completion.', 'PROCESS', 'Before completion.')];
    if (fullText === '# Demo\nVerify before completion.\n\nNever modify public API signatures.\n')
      duties.push(duty('Never modify public API signatures.', 'PROCESS'));
    return duties; // Exact known heading/blank/edition text adds no duty.
  }
  if (fullText === '# Delivery\n\nCreate app.mjs. You may inspect examples if useful. If a later correction changes app.mjs, run verification again before completion.\n') {
    assert.equal(unit.text, fullText, 'Known code and conditional process duties share one compound block');
    return [duty('Create app.mjs.', 'IMPLEMENTATION'),
      duty('If a later correction changes app.mjs, run verification again before completion.', 'PROCESS', 'If a later correction changes app.mjs, run again after that change and before completion.')];
  }
  if (fullText === '# Description\n\nThis skill helps build validator libraries.\n\nYou may inspect 示例 😀 if useful.\n') return [];
  throw new Error(`Declare an independent source-only expectation for ${source.kind}:${source.ref}; unknown text cannot default to CONTEXT`);
}

async function fixture(t, { generic = false, wireMode = 'full', closedMixed = false, materialAlongside = false, baselineLimits } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-basis-hooks-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillName = closedMixed ? 'delivery-verifier' : 'demo';
  const skillRoot = path.join(root, 'skills'), skillFile = path.join(skillRoot, skillName, 'SKILL.md');
  await fs.mkdir(path.dirname(skillFile), { recursive: true }); await fs.writeFile(skillFile, closedMixed
    ? '# Delivery\n\nCreate app.mjs. You may inspect examples if useful. If a later correction changes app.mjs, run verification again before completion.\n'
    : '# Demo\nVerify before completion.\n');
  const material = path.join(root, 'contract.md'), transcript = path.join(root, 'transcript.jsonl');
  await fs.writeFile(material, 'The result preserves the requested feature.');
  await fs.writeFile(transcript, JSON.stringify(user()) + '\n');
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2,
    dynamicGroundTruth: { enabled: true, materialRoots: closedMixed && !materialAlongside ? [] : [material], panel: { size: 0 } },
    skillCorrection: { enabled: true, skillRoots: [skillRoot], selection: { mode: 'include', include: [skillName] }, completionCheckIntervalTurns: 10 },
    artifactCorrection: { groundTruthReviewEnabled: true, stageMetricsEnabled: false },
    stopCorrection: { enabled: true, fileQualityReviewEnabled: false },
    reviewers: { defaults: { model: 'fixture/model', timeoutMs: 20000 } },
  }, { policyRoot: path.join(root, '.runtime-corrector') }) };
  let registry, careRegistry, request, toolCall = 0, event = 0; const hooks = new Map(), calls = [], baselineRequests = new Map();
  const state = { beforeGraph: null, afterBaseline: null, graphError: null, classification: null, forceOperations: false,
    deltaOperation: null, useNativeGraph: false, graphInputs: [], nativeInput: null, interpret: null, semanticDisposition: 'CONFIRMED',
    sourceFrom: false, baselinePrompts: [], draftActual: false, skipCurrentUserRead: false, replayBaseline: null, overrideBaseline: null,
    skillReviewScript: null, skillReviewPrompts: [], skillReviewCandidates: [], graphNativeScript: null, beforeBaselineSave: null };
  state.coverageReport = scriptedCoverageReport; state.auditInputs = [];
  const api = { rootDir: path.resolve('.'), config: { agents: { defaults: { model: { primary: 'fixture/model' } } },
    models: { providers: { fixture: { models: [{ id: 'model', contextWindow: 200000, maxTokens: 65536 }] } } } },
    runtime: { version: '2026.7.1-2', agent: {} }, logger: { warn() {}, info() {} },
    registerTool(factory, metadata) { if (metadata?.names.includes('rc_skill_care')) careRegistry = factory;
      else if (metadata?.names.includes('source_read')) registry = factory; },
    on(name, callback) { hooks.set(name, [...(hooks.get(name) ?? []), callback]); } };
  registerTaskTools(api);
  registerReviewerProgress(api);
  const native = createOpenClawReviewerFactory(api, { stopReviewEngine: 'task', baselineWireMode: wireMode,
    ...(baselineLimits ? { baselineLimits } : {}),
    runEmbeddedAgent: async params => {
      if (params.toolsAllow?.includes('source_read') && !params.toolsAllow.includes('finish_baseline')) {
        await state.coverageLaunch?.(params);
        return runNativeCoverageFixture({ params, registry, hooks, report: state.coverageReport, mutateResult: state.coverageMutation,
          formatReport: state.formatCoverageReport ?? JSON.stringify, repairReport: state.coverageRepairReport,
          persistFinish: state.coveragePersistFinish !== false, observeFinish: state.coverageObserveFinish !== false,
          onSubmission: value => state.coverageSubmissions?.push(value),
          inventory: state.coverageInventory ?? (context => scriptedSourceInventory(context, sharedOriginalDuties)),
          persistInventory: state.coveragePersistInventory !== false, observeInventory: state.coverageObserveInventory !== false,
          beforeInventory: state.coverageBeforeInventory, onInventory: state.coverageOnInventory, afterInventory: state.coverageAfterInventory,
          returnWithoutFinish: state.coverageReturnWithoutFinish, skipRead: state.coverageSkipRead });
      }
      if (!params.toolsAllow?.includes('finish_baseline')) {
        if (params.toolsAllow) assert(params.toolsAllow.includes('rc_skill_care'));
        const ctx = { agentId: params.agentId, sessionId: params.sessionId, sessionKey: params.sessionKey };
        await fs.access(params.sessionFile).catch(() => fs.writeFile(params.sessionFile, JSON.stringify({ type: 'session', version: 3, id: params.sessionId, cwd: root }) + '\n'));
        const args = { action: 'read', id: 'skill/SKILL.md' }, id = `original-care-${++toolCall}`;
        await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'rc_skill_care', arguments: args }] } }) + '\n');
        const page = await careRegistry(ctx).execute(id, args);
        const message = { role: 'toolResult', toolCallId: id, toolName: 'rc_skill_care', content: page.content, isError: false };
        for (const hook of hooks.get('tool_result_persist') ?? []) hook({ toolName: 'rc_skill_care', toolCallId: id, isSynthetic: false, message },
          { agentId: params.agentId, sessionKey: params.sessionKey, toolName: 'rc_skill_care', toolCallId: id });
        await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
        let result = state.nativeInput.request.skillGraphOnly ? { summary: 'Independent native graph route.', skillGroundTruth: graph(state.nativeInput.evidence.skillSource) }
          : { summary: 'Scripted independent Skill check with real original-page disclosure.', completionStatus: 'COMPLETED', findings: [],
            sourceInterpretationReviews: state.nativeInput.evidence.skillGroundTruth.constraints.map(c => ({ constraintId: c.constraintId,
              disposition: state.semanticDisposition, reason: 'Controlled semantic assessment against the complete original.', actualEvidence: ['skill/SKILL.md'] })) };
        if (!state.nativeInput.request.skillGraphOnly && state.skillReviewScript) {
          const index = state.skillReviewPrompts.length;
          state.skillReviewPrompts.push({ prompt: params.prompt, timeoutMs: params.timeoutMs });
          result = state.skillReviewScript({ review: result, graph: state.nativeInput.evidence.skillGroundTruth, index });
          state.skillReviewCandidates.push(structuredClone(result));
        }
        if (state.nativeInput.request.skillGraphOnly && state.graphNativeScript)
          result = await state.graphNativeScript({ params, result });
        return { payloads: [{ text: JSON.stringify(result) }], meta: {} };
      }
      await fs.access(params.sessionFile).catch(() => fs.writeFile(params.sessionFile, JSON.stringify({ type: 'session', version: 3, id: params.sessionId, cwd: root }) + '\n'));
      const ctx = { sessionId: params.sessionId, sessionKey: params.sessionKey }, tools = registry(ctx), seen = new Map();
      const baselinePrompt = JSON.parse(params.prompt);
      state.baselinePrompts.push(baselinePrompt);
      (state.baselineTimeouts ??= []).push(params.runTimeoutOverrideMs);
      async function call(name, args) {
        const id = `actual-call-${++toolCall}`; params.onAssistantMessageStart();
        await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
        const result = await tools.find(tool => tool.name === name).execute(id, args);
        const message = { role: 'toolResult', toolName: name, toolCallId: id, content: result.content, details: result.details, isError: Boolean(result.isError) };
        for (const hook of hooks.get('tool_result_persist') ?? []) hook({ toolName: name, toolCallId: id, isSynthetic: false, message }, ctx);
        await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
        if (name === 'source_read') {
          seen.set(args.path, [...(seen.get(args.path) ?? []), result.details.citation.citeId]);
        }
        params.onAgentToolResult({ toolName: name, result, isError: false }); return result;
      }
      const readAll = async () => { for (const file of JSON.parse(params.prompt).requiredFiles) {
        if (state.skipCurrentUserRead && file.startsWith('source-0000-')) continue;
        let offset = 1;
        do { const result = await call('source_read', { path: file, offset }); offset = result.details.page.nextOffset; } while (offset);
      } };
      if (state.replayBaseline) {
        const prepared = baselineRequests.get(baselinePrompt.identity.requestId);
        assert(prepared, 'Native baseline replay requires its current prepared request identity');
        const sourceRoot = path.join(path.dirname(prepared.requestDirectory), 'frozen-source');
        try { await state.replayBaseline({ call, readAll, request, params, sourceRoot,
          requestDirectory: prepared.requestDirectory, requestIdentity: prepared.identity }); }
        catch (error) { t.diagnostic(`${error.code}: ${error.message}`); throw error; }
        return { payloads: [], meta: {} };
      }
      await readAll();
      await state.beforeBaselineSave?.({ call, params, request });
      const add = request.currentGroundTruth.version === 0 || state.forceOperations;
      const op = state.deltaOperation ?? operation();
      if (state.draftActual) {
        const prompt = JSON.parse(params.prompt), originals = add ? state.deltaOperations ?? [op] : [];
        const operations = originals.map(({ source, ...fields }) => ({ ...fields,
          sourceFrom: { unitId: `S${request.sourceCatalog.findIndex(item => item.ref === source.ref.split('#')[0])}L1` } }));
        const skillIndex = request.sourceCatalog.findIndex(source => source.ref === skillFile);
        if (skillIndex >= 0) operations.push({ operation: 'ADD', category: 'requirements', authority: 'MATERIAL_DERIVED', severity: 'HARD',
          applicabilityKind: 'CURRENT_TASK', verificationTarget: 'PROCESS', text: 'Verify before completion.', sourceFrom: { unitId: `S${skillIndex}L2` } });
        const covered = new Set([...operations.map(op => op.sourceFrom.unitId), ...(prompt.preservedSourceUnits ?? []).flatMap(row => row.units)]);
        const exclude = prompt.sourceUnits.filter(unit => !covered.has(unit.id)).map(unit => ({ units: [unit.id],
          reason: unit.kind === 'USER_MESSAGE' ? 'Unproved old coverage is deliberately rejected, not silently retained.'
            : 'Descriptive material/section label; the actual Skill verification duty is independently retained.' }));
        await call('save_baseline_batch', { batchId: 1, operations, ...(exclude.length ? { exclude } : {}) });
        await call('finish_baseline', { batchIds: [1], taskClassification: operations.length ? 'CONTINUATION' : 'NO_CHANGE', summary: 'Every original decision retained; real new Skill duty added.' });
        return { payloads: [], meta: {} };
      }
      // Script the extractor faithfully for known adopted originals too. The
      // independent inventory above does not read these operations or labels.
      const current = await readJson(request.currentGroundTruth.path), sourceOperations = [];
      for (const source of request.sourceCatalog.filter(source => source.kind === 'MATERIAL')) {
        const original = await fs.readFile(path.isAbsolute(source.ref) ? source.ref : path.join(root, source.ref), 'utf8');
        const known = ['# Demo\nVerify before completion.\n', '# Demo\nVerify before completion, including errors.\n',
          '# Demo\nVerify before completion.\n\nDescriptive edition note.\n', '# Demo\nVerify before completion.\n\nNever modify public API signatures.\n'];
        if (!known.includes(original)) continue;
        const declared = original.split('\n').flatMap((line, index) => ['Verify before completion.', 'Verify before completion, including errors.',
          'Never modify public API signatures.'].includes(line) ? [{ line, index: index + 1 }] : []);
        for (const { line, index } of declared) if (!(current?.claims ?? []).some(claim => claim.status === 'ACTIVE'
          && claim.text === line && claim.verificationTarget === 'PROCESS')) sourceOperations.push({ operation: 'ADD', category: 'requirements',
          authority: 'MATERIAL_DERIVED', severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'PROCESS', text: line,
          source: { kind: 'MATERIAL', ref: `${source.ref}#L${index}-L${index}`, subject: 'MAIN_TASK' } });
      }
      const originals = add ? state.deltaOperations ?? [op] : [], operations = [...originals, ...sourceOperations];
      if (operations.length) {
        if (state.sourceFrom) {
          await call('save_baseline_batch', { batchId: 1, operations: operations.map(({ source, ...fields }) => ({
            ...fields, sourceFrom: { unitId: `S${request.sourceCatalog.findIndex(item => item.ref === source.ref.split('#')[0])}L${Number(/#L(\d+)/u.exec(source.ref)?.[1] ?? 1)}` } })) });
        } else await call('save_baseline_batch', { batchId: 1, operations, bindings: operations.map((operation, operationIndex) => ({ operationIndex,
          citeIds: [...seen].filter(([file]) => file.startsWith(`source-${String(request.sourceCatalog.findIndex(item => item.ref === operation.source.ref.split('#')[0])).padStart(4, '0')}-`)).flatMap(([, ids]) => ids) })) });
      }
      await call('finish_baseline', { batchIds: operations.length ? [1] : [],
        taskClassification: state.classification ?? (operations.length ? 'CONTINUATION' : 'NO_CHANGE'), summary: 'Original obligations checked.' });
      return { payloads: [], meta: {} };
    } });
  const graph = source => source ? skillGraphCandidate(source, state.interpret ?? (unit => interpretSkillUnit(unit))) : ({ constraints: [{ constraintId: 'demo-verify', kind: 'STEP', modality: 'MUST',
    statement: 'Verify before completion.', applicabilityKind: 'CURRENT_TASK', condition: null, dependsOn: [],
    sourceRef: `${skillFile}#L2` }], taskOverlays: [] });
  const factory = async options => {
    const req = options.request; calls.push({ role: options.role, request: req, schema: options.schema });
    const requestDirectory = path.join(root, '.runtime-correction/fixture-reviews', String(calls.length));
    await fs.mkdir(requestDirectory, { recursive: true });
    if (req.reviewScope?.kind === 'baseline-coverage-audit') {
      state.auditInputs.push(options.baselineAuditInput);
      return native({ ...options, ...(state.coverageSessionCwd ? { sessionCwd: state.coverageSessionCwd } : {}) });
    }
    if (req.skillGraphOnly) {
      const observedNative = state.useNativeGraph && !state.graphError && typeof options.onOwnedInvocation === 'function';
      if (!observedNative) await state.beforeGraph?.(options);
      state.nativeInput = options;
      if (state.useNativeGraph && !state.graphError) return native({ ...options, onPrepared: async prepared => {
        // A controlled zero-dispatch failure uses the actual host lifecycle/capability.
        if (observedNative) await state.beforeGraph?.(options);
        await options.onPrepared?.(prepared);
        state.graphInputs.push({ supplied: options.evidence.groundTruth,
          frozen: await readJson(prepared.request.currentGroundTruth.path),
          staged: await loadCurrentGroundTruth(root, options.taskId),
          committed: await outsideDecision(() => loadCurrentGroundTruth(root, options.taskId)) });
      } });
      return { result: state.graphError ?? { summary: 'Independent original Skill graph.', skillGroundTruth: graph(options.evidence.skillSource) }, requestDirectory, async close() {} };
    }
    if (options.role === 'ground-truth-extractor') {
      if (state.overrideBaseline) return state.overrideBaseline(options, requestDirectory);
      // The retained old implementation uses generic JSON at Skill/document
      // hooks. Keep that old path executable for meaningful before/after runs.
      if (generic || !req.reviewScope?.boundedBasis) return { result: { summary: 'Legacy JSON alignment.', taskClassification: 'CONTINUATION',
        operations: req.currentGroundTruth.version === 0 ? [operation()] : [], ...(req.skill ? { skillGroundTruth: graph() } : {}) },
        requestDirectory, async close() {} };
      request = req;
      const handle = await native({ ...options, abortSignal: factory.reviewAbortSignal, onPrepared: async prepared => {
        baselineRequests.set(prepared.request.identity.requestId,
          { requestDirectory: prepared.requestDirectory, identity: prepared.request.identity });
        await options.onPrepared?.(prepared);
      } });
      try { await state.afterBaseline?.(handle); return handle; }
      catch (error) { await handle.close(); throw error; }
    }
    if (options.role === 'skill-reviewer') { state.nativeInput = options; return native(options); }
    if (options.role === 'artifact-reviewer') return { result: { summary: 'Scripted independent document check.', findings: [], edits: [], metricObjectJudgements: [] }, requestDirectory, async close() {} };
    if (options.role === 'stop-reviewer') return observedLegacyStop(options, {
      result: { summary: 'Scripted independent Stop check.', stopClassification: 'TASK_COMPLETE', stage: 'implementation', findings: [],
        metricObjectJudgements: Object.values(req.population.metrics).flat().map(object => ({ objectId: object.objectId,
          judgement: 'PASS', reason: 'Explicit offline test observation.', evidence: [] })) }, requestDirectory, async close() {} });
    throw new Error(`Unexpected offline reviewer role: ${options.role}`);
  };
  factory.reviewCacheIdentity = native.reviewCacheIdentity;
  const invoke = (hook_event_name, extra = {}, options = {}) => runStartedHostEvent({ projectRoot: root, plan, reviewerFactory: factory,
    input: { cwd: root, session_id: 'basis-session', transcript_path: transcript, hook_event_name, hook_event_id: `event-${++event}`, ...extra }, ...options });
  const select = () => invoke('PreToolUse', { tool_name: 'Skill', tool_use_id: `skill-${event}`, tool_input: { skill: skillName } });
  const task = () => findTask({ projectRoot: root, sessionId: 'basis-session' });
  const truth = async () => loadCurrentGroundTruth(root, (await task()).taskId);
  const refresh = async () => refreshRuntimeRequirements({ projectRoot: root, input: { cwd: root, session_id: 'basis-session',
    transcript_path: transcript, hook_event_name: 'Stop', hook_event_id: `requirements-${++event}` }, plan, reviewerFactory: factory });
  return { root, material, transcript, skillFile, plan, factory, state, calls, invoke, select, task, truth, refresh, api,
    globals: () => calls.filter(call => call.role === 'ground-truth-extractor' && !call.request.skillGraphOnly && call.request.reviewScope?.kind !== 'baseline-coverage-audit'),
    audits: () => calls.filter(call => call.request.reviewScope?.kind === 'baseline-coverage-audit'),
    graphs: () => calls.filter(call => call.request.skillGraphOnly),
    graphFile: async () => path.join(taskDirectory(root, (await task()).taskId), `skills/${skillName}/skill-ground-truth.json`) };
}

export { fixture as sharedBasisFixture, user, operation };
