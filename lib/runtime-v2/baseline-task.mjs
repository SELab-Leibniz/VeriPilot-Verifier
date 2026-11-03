// Bounded global extraction adapter. Source identity and ledger authority remain in
// the existing Ground Truth chain; the worker never writes the formal ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskDirectory } from './task-store.mjs';
import { generationReviewSchema } from './reviewer.mjs';
import { readJson, sha256 } from './utils.mjs';
import { scopedDecision } from './decision-scope.mjs';
import { prepareSourceInputs, bindSourceSelections, validateSourceBindings } from '../openclaw/sources.mjs';
import { excerpt } from '../review-task/evidence-utils.mjs';
import { createBaselineWorker, BASELINE_EXTRACTION_PROTOCOL } from '../review-task/baseline-task.mjs';
import { sourceClauses, baselineScopeFailure } from '../review-task/baseline-selection.mjs';
import { createNativeTaskSession } from '../openclaw/task-session.mjs';
import { acknowledgedSharedProof, loadAcceptedSourceRetention } from './baseline-shared-basis.mjs';
import { groundTruthAdmissionContext, groundTruthAdmissionFailure } from './ground-truth-provenance.mjs';
import { acceptBaselineCoverageAudit } from './baseline-coverage-audit.mjs';
import { groundTruthPlanDigest } from './ground-truth-ledger.mjs';
import { listNativeRuns } from '../openclaw/native-runs.mjs';
import { loadPublicToolArgumentsValidator } from '../openclaw/compat-2026.7.1-2.mjs';
import { hasLinkedPath, isSameFile } from '../path-utils.mjs';

export const isStopBaselineTask = input => input.role === 'ground-truth-extractor'
  && input.request?.reviewScope?.kind === 'baseline' && input.request.reviewScope.boundedBasis === true;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function frozenSourceParts(bytes) {
  const parts = []; let line = 1;
  for (let start = 0; start < bytes.length || !parts.length;) {
    let end = Math.min(start + 16384, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const newline = bytes.lastIndexOf(10, end - 1);
    if (end < bytes.length && newline >= start && newline < end) end = newline + 1;
    const startLine = line;
    for (let cursor = start; cursor < end; cursor++) if (bytes[cursor] === 10) line++;
    const endsMidLine = end < bytes.length && bytes[end - 1] !== 10;
    parts.push({ startByte: start, endByte: end, startLine,
      endLine: line - (bytes[end - 1] === 10 || endsMidLine ? 1 : 0),
      startsMidLine: start > 0 && bytes[start - 1] !== 10, endsMidLine });
    start = end; if (end === bytes.length) break;
  }
  return parts;
}

export function frozenLineSelection(bytes, start, end, part = null) {
  const local = part ? excerpt(bytes.subarray(part.startByte, part.endByte), start, end) : null;
  if (part) { start += part.startLine - 1; end += part.startLine - 1; }
  const selected = excerpt(bytes, start, end);
  if (part && (selected.byteStart !== part.startByte + local.byteStart || selected.byteEnd !== part.startByte + local.byteEnd))
    throw fail('BASELINE_SOURCE_INVALID', `Selection includes a partial original line at a part boundary; use sourceIndex and ORIGINAL lines ${start}-${end}, with receipts for every intersecting part`);
  return { ...selected, start, end };
}

export async function runStopBaselineTask(input, dependencies) {
  if (!isStopBaselineTask(input)) throw fail('BASELINE_SCOPE_INVALID', 'Not a Stop baseline refresh');
  const session = await createNativeTaskSession(input, dependencies);
  const directory = path.join(taskDirectory(input.projectRoot, input.taskId), 'baseline-task-runs', randomUUID());
  const root = path.join(directory, 'frozen-source'), requestDirectory = path.join(directory, 'request');
  let worker, acceptedAudit = null, closedCleanly = false;
  try {
    session.active();
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(requestDirectory);
    const original = structuredClone(input.request), catalog = original.sourceCatalog ?? [];
    if (!Array.isArray(catalog) || !catalog.some(source => source.kind === 'USER_MESSAGE'))
      throw fail('BASELINE_SOURCE_INVALID', 'Stop baseline requires an original user source catalog');
    const truth = structuredClone(input.evidence?.groundTruth ?? await readJson(original.currentGroundTruth?.path));
    if (!truth || truth.taskId && truth.taskId !== input.taskId) throw fail('BASELINE_INPUT_CHANGED', 'Original baseline identity is unavailable');
    const admission = groundTruthAdmissionContext(truth, catalog);
    const originalTask = await readJson(path.join(taskDirectory(input.projectRoot, input.taskId), 'task.json'));
    const truthPath = original.currentGroundTruth?.path ?? path.join(taskDirectory(input.projectRoot, input.taskId), 'ground-truth/current.json');
    const originalDecision = scopedDecision(truthPath);
    // The extractor's role cap ends model work. A completed, source-bound
    // candidate remains publishable until its enclosing assessment deadline.
    // Publication still rechecks the original inputs, ownership and cancel.
    const parentDeadlineAt = Math.min(input.publicationDeadlineAt ?? Infinity, originalDecision?.context.deadlineAt ?? Infinity);
    const publicationDeadlineAt = Number.isFinite(parentDeadlineAt) ? parentDeadlineAt : session.deadlineAt;
    const persistedTruth = await fs.readFile(truthPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const delivery = await prepareSourceInputs({ snapshot: input.evidence?.snapshot, sourceCatalog: catalog,
      requestDirectory, projectRoot: input.projectRoot, assertActive: session.active, readOriginalMaterial: input.readOriginalMaterial });
    const files = [], sources = [], origins = new Map(), texts = new Map(), live = [];
    async function freeze(name, bytes, source = null) {
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0)) throw fail('BASELINE_SOURCE_INVALID', 'Required source is not UTF-8 text');
      const parts = [];
      for (const [index, range] of frozenSourceParts(bytes).entries()) {
        session.active();
        const { startByte: start, endByte: end } = range;
        const file = `${name}-${String(index).padStart(4, '0')}.txt`;
        await fs.writeFile(path.join(root, file), bytes.subarray(start, end), { flag: 'wx' });
        const part = { file, startByte: start, endByte: end, sha256: sha256(bytes.subarray(start, end)) };
        if (source) {
          Object.assign(part, range);
        }
        parts.push(part); files.push(file);
        if (source) origins.set(file, { ...source, startByte: start, endByte: end });
      }
      return parts;
    }
    await freeze('baseline', Buffer.from(JSON.stringify(truth)));
    for (const [index, source] of catalog.entries()) {
      session.active();
      if (!['USER_MESSAGE', 'MATERIAL', 'PROJECT_FILE'].includes(source.kind)) continue;
      let bytes;
      if (source.kind === 'USER_MESSAGE') {
        const matched = delivery.userSources.filter(user => user.ref === source.ref);
        if (matched.length !== 1) throw fail('BASELINE_SOURCE_INVALID', 'User source has no unambiguous original');
        bytes = await fs.readFile(matched[0].path);
      } else {
        const file = path.resolve(input.projectRoot, source.ref), real = await fs.realpath(file);
        const relative = path.relative(input.projectRoot, file);
        const checkedPath = !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
        if (!await isSameFile(file, real) || await hasLinkedPath(file) || /(?:^|[/\\])(?:\.runtime-correction|\.git|\.aws|\.ssh|\.env)(?:[/\\.]|$)/u.test(checkedPath))
          throw fail('BASELINE_SOURCE_INVALID', 'Unsafe or linked source');
        bytes = await input.readOriginalMaterial?.(file) ?? await fs.readFile(file); live.push({ file, sha256: sha256(bytes) });
      }
      delivery.sourceTexts.set(source.ref, bytes.toString('utf8')); texts.set(source.ref, bytes);
      const item = { ref: source.ref, kind: source.kind, sha256: sha256(bytes), bytes: bytes.length };
      item.parts = await freeze(`source-${String(index).padStart(4, '0')}`, bytes, item);
      const lines = bytes.toString('utf8').split('\n');
      item.lineCount = lines.length;
      if (item.parts.length === 1) {
        item.clauseCounts = {};
        item.clauseIndexPartial = lines.length > 128;
        for (const [line, text] of lines.slice(0, 128).entries()) {
          let count; try { count = text.trim() ? sourceClauses(text).length : 0; } catch { count = null; }
          item.clauseCounts[line + 1] = count;
        }
      }
      sources.push(item);
    }
    let requestId = sha256({ protocol: BASELINE_EXTRACTION_PROTOCOL, taskId: input.taskId, request: original,
      baseline: [truth.version, truth.digest], sources });
    const identity = { requestId, protocol: BASELINE_EXTRACTION_PROTOCOL, taskId: input.taskId, hookEventId: original.hookEventId,
      baselineVersion: truth.version, baselineDigest: truth.digest, sourceCatalog: catalog, sources,
      sourceRetentionPolicy: original.sourceRetentionPolicy,
      deadlineAt: session.deadlineAt, publicationDeadlineAt };
    const retainedSourceUnits = await loadAcceptedSourceRetention({ projectRoot: input.projectRoot, task: originalTask,
      truth, identity, active: session.active });
    if (retainedSourceUnits.length) {
      identity.retainedSourcesDigest = sha256(retainedSourceUnits);
      identity.requestId = requestId = sha256({ requestId, retainedSourcesDigest: identity.retainedSourcesDigest });
    }
    // Deliver navigation coordinates through the actual required read, not
    // merely the sidecar request record outside the worker's evidence root.
    const sourceNavigation = { navigationOnly: true, sources: sources.map(source => ({
      sourceIndex: catalog.findIndex(item => item.ref === source.ref), lineCount: source.lineCount,
      parts: source.parts.map(({ file, startLine, endLine, startsMidLine, endsMidLine }) => ({ file, startLine, endLine, startsMidLine, endsMidLine })),
    })) };
    await freeze('request', Buffer.from(JSON.stringify({ ...original, sourceNavigation })));
    const rank = file => file.startsWith('request-') ? 0 : file.startsWith('baseline-') ? 1 : 2;
    files.sort((a, b) => rank(a) - rank(b));
    await fs.writeFile(path.join(requestDirectory, 'request.json'), JSON.stringify({ ...original, identity, requiredFiles: files }));
    // No restoration implementation exists: never turn an interrupted same-stage
    // journal into a fresh zero-counter worker. Ordinary new hook identities differ.
    for (const previous of await fs.readdir(path.dirname(directory), { withFileTypes: true })) {
      if (!previous.isDirectory() || previous.name === path.basename(directory)) continue;
      const prior = path.join(path.dirname(directory), previous.name);
      const priorRequest = await readJson(path.join(prior, 'request/request.json'));
      const hasJournal = await fs.stat(path.join(prior, 'observations.jsonl')).then(() => true, error => {
        if (error.code === 'ENOENT') return false; throw error;
      });
      if (hasJournal && (!priorRequest?.identity?.requestId || priorRequest.identity.requestId === requestId))
        throw fail('BASELINE_BUDGET_UNVERIFIED', 'Prior same-stage or unidentified budget exists; exact restoration is unsupported');
    }
    async function assertCurrent() {
      input.abortSignal?.throwIfAborted();
      if (Date.now() >= publicationDeadlineAt) throw fail('REVIEWER_DEADLINE', 'Baseline publication deadline expired');
      const publishing = originalDecision && scopedDecision(truthPath) !== originalDecision;
      const current = await readJson(truthPath), expected = publishing ? persistedTruth : truth;
      // Successful no-op alignment may advance program-owned input cursors in
      // the same transaction. Those are not authoritative requirement bytes;
      // every other field, including version, claims and digest, stays guarded.
      const basis = value => { if (!value) return value; const { userSourceRefs, userSourceHashes, ...rest } = value; return rest; };
      if (sha256(basis(current)) !== sha256(basis(expected)) && !(current === null && expected?.version === 0)
        || current?.taskId && current.taskId !== input.taskId)
        throw fail('BASELINE_INPUT_CHANGED', 'Original baseline version changed');
      const state = await readJson(path.join(taskDirectory(input.projectRoot, input.taskId), 'task.json'));
      if (state?.control?.cancelled || state?.control?.cancelEpoch !== originalTask?.control?.cancelEpoch
        || state?.rootSessionId !== originalTask?.rootSessionId) throw fail('BASELINE_INPUT_CHANGED', 'Task ownership or cancellation changed');
      for (const item of live) {
        if (await hasLinkedPath(item.file) || !await isSameFile(await fs.realpath(item.file), item.file) || sha256(await fs.readFile(item.file)) !== item.sha256)
          throw fail('BASELINE_INPUT_CHANGED', 'Original source changed');
      }
      input.abortSignal?.throwIfAborted();
    }
    function bindOperations(operations, bindings, registry) {
      const value = structuredClone(operations);
      for (const operation of value) {
        const ref = operation.source?.ref;
        if (typeof ref !== 'string') continue;
        const parsed = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(ref);
        const file = parsed?.[1] ?? ref, origin = origins.get(file);
        if (catalog.some(item => [item.ref, ...(item.aliases ?? [])].includes(file))) continue;
        const source = origin && sources.find(item => item.ref === origin.ref);
        if (source?.parts.length === 1)
          operation.source.ref = origin.ref + (parsed ? `#L${parsed[2]}-L${parsed[3] ?? parsed[2]}` : '');
      }
      bindSourceSelections(value, delivery, catalog); validateSourceBindings(value, catalog);
      for (const [index, operation] of value.entries()) {
        const selected = operation.source.ref.replaceAll('\\', '/');
        const direct = catalog.filter(source => [source.ref, ...(source.aliases ?? [])].includes(selected));
        const range = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(selected);
        const matches = direct.length ? direct : catalog.filter(source => [source.ref, ...(source.aliases ?? [])].includes(range?.[1]));
        if (!matches.length && ['AGENT_INFERRED', 'BASIS_PENDING'].includes(operation.authority)) continue;
        if (new Set(matches.map(source => source.ref)).size !== 1) throw fail('BASELINE_SOURCE_INVALID', 'Select one exact sourceCatalog ref, optionally #L1-L2. Do not combine a catalog ref with a frozen filename; use the canonical ref from the request.');
        const source = matches[0], bytes = texts.get(source.ref);
        if (!bytes) throw fail('BASELINE_SOURCE_INVALID', 'Operation source has not been frozen');
        const target = !direct.length && range ? excerpt(bytes, Number(range[2]), Number(range[3] ?? range[2])) : { byteStart: 0, byteEnd: bytes.length };
        const cited = bindings.filter(binding => binding.operationIndex === index);
        const receiptHint = () => {
          const parts = sources.find(item => item.ref === source.ref)?.parts.map(part => part.file) ?? [];
          const available = [...registry.values()].filter(citation => origins.get(citation.path)?.ref === source.ref)
            .slice(0, 6).map(citation => ({ citeId: citation.citeId, file: citation.path, start: citation.start, end: citation.end }));
          return ` Source ${source.ref}; original files ${JSON.stringify(parts)}; current issued receipts ${JSON.stringify(available)}. Reuse applicable current receipts, or source_read missing original pages; history state pages further receipts. Hints grant no coverage.`;
        };
        if (cited.length !== 1 || !cited[0].citeIds?.length) throw fail('BASELINE_SOURCE_INVALID', 'Each operation needs an original-source binding.' + receiptHint());
        const intervals = cited[0].citeIds.map(id => {
          const citation = registry.get(id), origin = origins.get(citation?.path);
          if (!origin || origin.ref !== source.ref) throw fail('BASELINE_SOURCE_INVALID', 'Unacknowledged or foreign source citation');
          return { start: origin.startByte + citation.byteStart, end: origin.startByte + citation.byteEnd };
        }).sort((a, b) => a.start - b.start);
        let next = target.byteStart;
        for (const interval of intervals) { if (interval.start > next) break; next = Math.max(next, interval.end); }
        if (next < target.byteEnd) throw fail('BASELINE_SOURCE_INVALID', 'Selected original range was not fully disclosed. Bind the entire selected range, or explicitly select the supported #L range.' + receiptHint());
        // Canonical source identity plus program-captured original excerpt.
        operation.source.ref = source.ref + (!direct.length && range ? `#L${range[2]}-L${range[3] ?? range[2]}` : '');
      }
      return value;
    }
    function compileSelection(selection, registry) {
      if ((selection.file !== undefined) === (selection.sourceIndex !== undefined))
        throw fail('BASELINE_SOURCE_INVALID', 'Select exactly one frozen file or sourceIndex, never both');
      let source = catalog[selection.sourceIndex], start = selection.start, end = selection.end;
      if (selection.file !== undefined) {
        const origin = origins.get(selection.file);
        source = catalog.find(item => item.ref === origin?.ref);
        const part = sources.find(item => item.ref === source?.ref)?.parts.find(part => part.file === selection.file);
        if (!part) throw fail('BASELINE_SOURCE_INVALID', 'file must name one current frozen original source part');
        const bytes = texts.get(source.ref);
        let selected;
        try {
          selected = frozenLineSelection(bytes, start, end, part);
        } catch (error) { if (error.code === 'BASELINE_SOURCE_INVALID') throw error; throw fail('BASELINE_SOURCE_INVALID', 'Invalid part-local line selection'); }
        ({ start, end } = selected);
      }
      const bytes = texts.get(source?.ref);
      const frozen = sources.find(item => item.ref === source?.ref);
      if (!source || !bytes || !frozen)
        throw fail('BASELINE_SOURCE_INVALID', 'textFrom needs an exact frozen original sourceCatalog entry');
      let range;
      try { range = frozenLineSelection(bytes, start, end); }
      catch { throw fail('BASELINE_SOURCE_INVALID', 'Invalid original line selection'); }
      let text = range.text;
      if (selection.clauses !== undefined) {
        if (start !== end) throw fail('BASELINE_SOURCE_INVALID', 'Clause selection requires exactly one original line');
        let clauses;
        try { clauses = sourceClauses(text); } catch (error) { throw fail('BASELINE_SOURCE_INVALID', error.message); }
        if (!selection.clauses.length || selection.clauses.some((index, position, indices) => !Number.isInteger(index) || index < 0 || index >= clauses.length || position > 0 && index <= indices[position - 1]))
          throw fail('BASELINE_SOURCE_INVALID', `sourceIndex ${catalog.indexOf(source)}, line ${start}: valid clause indices are 0..${clauses.length - 1}, distinct and in original order; use full text for finer semantic spans`);
        text = selection.clauses.map(index => clauses[index]).join('');
      }
      if (!text.trim()) throw fail('BASELINE_SOURCE_INVALID', 'An empty range is not an obligation');
      const citeIds = [...registry.values()].filter(citation => {
        const origin = origins.get(citation.path);
        return origin?.ref === source.ref && origin.startByte + citation.byteStart <= range.byteEnd
          && origin.startByte + citation.byteEnd >= range.byteStart;
      }).map(citation => citation.citeId);
      // bindOperations performs the exact contiguous-coverage check. The model
      // cannot supply text, alternate sources or old citations for this path.
      return { text, source: { ref: `${source.ref}#L${start}-L${end}`,
        kind: source.kind, subject: 'MAIN_TASK' }, citeIds };
    }
    function validateExclusion(unit, decision, registry) {
      if (catalog[unit.sourceIndex]?.kind !== 'USER_MESSAGE') return;
      const text = compileSelection({ sourceIndex: unit.sourceIndex, start: unit.line, end: unit.line }, registry).text.trim();
      const claims = (decision.claimIds ?? []).map(id => truth.claims?.find(claim => claim.claimId === id));
      if (!claims.length || claims.some(claim => !claim) || !claims.some(claim => claim.authority === 'USER_EXPLICIT'
        && claim.source?.kind === 'USER_MESSAGE' && claim.text.trim() === text))
        throw baselineScopeFailure(`${unit.id}: a user paragraph can only be excluded when its entire original is already present in exact current claimIds. Keep new constraints, including denials of authorization.`, {
          reason: 'WHOLE_ORIGINAL_NOT_PRESENT', unitId: unit.id,
          repair: 'Semantic overlap is insufficient: every claimId must exist, and at least one USER_EXPLICIT USER_MESSAGE claim must exactly contain this whole original after trimming outer whitespace. Do not retry partial claims as exclusion proof. Preserve supported new duties with keep/merge/split or scoped text+sourceFrom for known units. For actual existing-claim revisions or unsupported selections request ONLY batchId + fullTextReason; legacy source+bindings stays available. Non-ADD needs the real current claimId. Retain all requirements; do not invent IDs or reread acknowledged originals solely for citations.',
        });
    }
    const validateAdmission = (delta, options) => {
      const failure = groundTruthAdmissionFailure(delta, truth, catalog, options);
      if (!failure) return;
      const classification = failure.reason === 'NEW_TASK_WITHOUT_PENDING_USER_OPERATION';
      const code = classification ? 'BASELINE_CLASSIFICATION_INVALID' : 'BASELINE_ADMISSION_INVALID';
      const message = `${classification ? '/taskClassification: ' : ''}${failure.message}`;
      const validation = { reason: failure.reason, message, operationIndex: failure.operationIndex,
        sourceRef: failure.sourceRef, admission: failure.admission, repair: failure.admission.repair };
      // Native hosts may serialize only Error.message, not custom properties.
      // Include bounded program navigation in the actual tool feedback too.
      throw Object.assign(fail(code, `${message}\n${JSON.stringify({ code, validation })}`),
        { baselineValidation: validation });
    };
    const validationCapability = await (dependencies.options?.loadPublicToolArgumentsValidator ?? loadPublicToolArgumentsValidator)();
    session.active();
    worker = await createBaselineWorker({ root, outputDir: directory, identity, requiredFiles: files, sourceTexts: texts,
      validationCapability,
      schema: input.schema, signal: session.signal, deadlineAt: session.deadlineAt,
      maxRepairs: input.baselineLimits?.maxRepairs ?? input.reviewer?.formatRepairAttempts ?? 3,
      maxAuditCalls: input.baselineLimits?.maxAuditCalls ?? 2, maxExternalRepairs: input.baselineLimits?.maxExternalRepairs ?? 1,
      active: session.active, assertCurrent, bindOperations, compileSelection, validateExclusion,
      validateOperations: operations => validateAdmission({ operations }, { classificationKnown: false }),
      validateCompletion: delta => validateAdmission(delta), admissionNavigation: admission,
      initialWireMode: dependencies.options?.baselineWireMode,
      retainedSourceUnits,
      maxTokens: input.taskLimits?.maxTokens ?? input.reviewer?.maxOutputTokens, maxTurns: input.taskLimits?.maxTurns ?? 100,
      nativeRun: session.run, notesFile: path.join(taskDirectory(input.projectRoot, input.taskId), 'baseline-notes.json'),
      faults: dependencies.options?.baselineFaults });
    await input.onPrepared?.({ requestDirectory, requestPath: path.join(requestDirectory, 'request.json'), request: { ...original, identity, requiredFiles: files } });
    await worker.execute();
    const coverage = async () => {
      await worker.checkpoint('shared_basis_ready');
      return acknowledgedSharedProof({ directory, identity, requiredFiles: files, result: worker.result, retainedSourceUnits });
    };
    const readCoverage = await coverage();
    const budgetIdentity = value => { const { journal, ...identity } = value; return sha256(identity); };
    async function captureOwned(auditInput, budget) {
      const actor = auditInput.extractorSettlement;
      if (actor?.status !== 'SETTLED' || actor.taskId !== input.taskId || !actor.runIds?.length
        || new Set(actor.runIds).size !== actor.runIds.length) throw fail('OWNED_SETTLEMENT_UNVERIFIED', 'No complete trusted actor manifest');
      const journal = await fs.readFile(budget.journal.path);
      if (journal.length !== budget.journal.bytes || sha256(journal) !== budget.journal.sha256)
        throw fail('BASELINE_BUDGET_UNVERIFIED', 'Original budget changed while capturing owned dispatches');
      const audits = journal.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.type === 'baseline_budget' && row.event === 'AUDIT_DISPATCH');
      if (!audits.length || audits.length !== budget.auditCalls || new Set(audits.map(row => row.runId)).size !== audits.length
        || audits.some(row => row.requestId !== requestId || !row.sessionId || actor.runIds.includes(row.runId)))
        throw fail('OWNED_SETTLEMENT_UNVERIFIED', 'Independent audit dispatch manifest is incomplete');
      const records = await listNativeRuns(input.projectRoot, input.taskId);
      return [...actor.runIds.map(runId => ({ runId, sessionId: actor.sessionId, ownerPid: actor.ownerPid })),
        ...audits.map(row => ({ runId: row.runId, sessionId: row.sessionId, ownerPid: actor.ownerPid }))].map(expected => {
        const matches = records.filter(record => record.runId === expected.runId), actual = matches[0];
        if (matches.length !== 1 || actual.status !== 'SETTLED' || !Number.isFinite(actual.settledAt)
          || actual.taskId !== input.taskId || actual.role !== 'ground-truth-extractor'
          || Object.entries(expected).some(([key, value]) => actual[key] !== value)
          || !Number.isFinite(actual.startedAt) || typeof actual.sessionFile !== 'string')
          throw fail('OWNED_SETTLEMENT_UNVERIFIED', 'Actor or auditor has no exact physical SETTLED record');
        return Object.fromEntries(['taskId', 'sessionId', 'runId', 'role', 'ownerPid', 'startedAt', 'sessionFile', 'status', 'settledAt']
          .map(key => [key, actual[key]]));
      });
    }
    async function verifyCompleted() {
      if (!closedCleanly || !acceptedAudit) throw fail('BASELINE_BUDGET_UNVERIFIED', 'No cleanly closed independently accepted candidate');
      const budget = worker.budget.verifyClosed();
      if (budgetIdentity(budget) !== acceptedAudit.budgetIdentity || sha256(worker.result) !== sha256(acceptedAudit.input.delta))
        throw fail('BASELINE_BUDGET_UNVERIFIED', 'Closed candidate generation or original allowance changed');
      const records = await listNativeRuns(input.projectRoot, input.taskId);
      for (const expected of acceptedAudit.owned) {
        const actual = records.filter(record => record.runId === expected.runId);
        if (actual.length !== 1 || Object.entries(expected).some(([key, value]) => actual[0][key] !== value))
          throw fail('OWNED_SETTLEMENT_UNVERIFIED', 'Closed actor or auditor physical settlement changed');
      }
      return { generation: budget.generation, turns: budget.turns, repairs: budget.repairs, auditCalls: budget.auditCalls };
    }
    return { result: worker.result, requestDirectory, sessionId: session.sessionId, extractorReused: session.extractorReused, lease: session.lease,
      baselineTask: { requestId, expectedVersion: truth.version, expectedDigest: truth.digest, assertCurrent,
        deadlineAt: publicationDeadlineAt, extractionDeadlineAt: session.deadlineAt, signal: input.abortSignal, readCoverage,
        awaitOwnedSettlement: session.awaitOwnedSettlement, budget: worker.budget,
        async getAuditInput(plan, scopeDigest) {
          const extractorSettlement = await session.awaitOwnedSettlement();
          const budget = worker.budget.snapshot(), checked = await coverage(), snapshot = checked.auditSnapshot();
          this.readCoverage = checked;
          const state = snapshot.checkpoint.taskState;
          if (!snapshot.finish || !Array.isArray(state.retainedSourceUnits))
            throw fail('BASELINE_COVERAGE_UNVERIFIED', 'Durable finish or retained decisions are unavailable');
          return { projectRoot: input.projectRoot, directory, auditDirectory: path.join(directory, 'coverage-audits'),
            identity: structuredClone(identity), generation: state.generation, scopeDigest, extractorSettlement,
            ...(input.baselineLimits?.auditUnitBytes ? { unitLayout: { protocol: 'neutral-contiguous-utf8-crlf-v1', maxBytes: input.baselineLimits.auditUnitBytes } } : {}),
            delta: structuredClone(worker.result), plan: structuredClone(plan),
            finish: structuredClone(snapshot.finish), retainedSourceUnits: structuredClone(state.retainedSourceUnits),
            batches: structuredClone(snapshot.batches), requiredFiles: [...files],
            fileHashes: Object.fromEntries(snapshot.checkpoint.files.map(([name, metadata]) => [name, metadata.sha256])),
            maxTokens: state.maxTokens, budgetLimits: { maxTurns: budget.maxTurns, maxRepairs: budget.maxRepairs,
              maxAuditCalls: budget.maxAuditCalls, maxExternalRepairs: budget.maxExternalRepairs, deadlineAt: budget.deadlineAt },
            modelIdentity: sha256({ provider: dependencies.selection.provider, model: dependencies.selection.model, effort: input.reviewer?.effort ?? 'low' }) };
        },
        async acceptAudit(audit, auditInput, publicationGuard = assertCurrent) {
          worker.budget.verifyClosed();
          if (sha256(auditInput.delta) !== sha256(worker.result)) throw fail('BASELINE_COVERAGE_UNVERIFIED', 'Candidate changed after audit');
          const cap = await acceptBaselineCoverageAudit({ audit, input: auditInput, budget: worker.budget, assertCurrent: publicationGuard, validationCapability });
          const budget = worker.budget.verifyClosed();
          acceptedAudit = { audit: structuredClone(audit), input: structuredClone(auditInput),
            snapshot: this.readCoverage.auditSnapshot(), budgetIdentity: budgetIdentity(budget), owned: await captureOwned(auditInput, budget) };
          this.readCoverage.attachAudit(cap); this.coverageAudit = cap;
          return cap;
        }, verifyCompleted,
        async reuseCompleted({ plan, scopeDigest, assertCurrent: freshGuard }) {
          await verifyCompleted();
          if (scopeDigest !== acceptedAudit.input.scopeDigest || groundTruthPlanDigest(plan) !== acceptedAudit.input.plan.digest)
            throw fail('BASELINE_INPUT_CHANGED', 'Read-only candidate scope or effective plan changed');
          const snapshot = structuredClone(acceptedAudit.snapshot);
          const checked = await acknowledgedSharedProof({ directory, identity, requiredFiles: files,
            result: acceptedAudit.input.delta, immutableSnapshot: snapshot, retainedSourceUnits: acceptedAudit.input.retainedSourceUnits });
          // Rebind the same actual audit/input and closed budget to this attempt's fresh guard.
          const cap = await acceptBaselineCoverageAudit({ audit: acceptedAudit.audit, input: acceptedAudit.input,
            budget: worker.budget, assertCurrent: freshGuard, validationCapability });
          checked.attachAudit(cap);
          return { requestId, expectedVersion: truth.version, expectedDigest: truth.digest, assertCurrent: freshGuard,
            deadlineAt: publicationDeadlineAt, extractionDeadlineAt: session.deadlineAt, signal: input.abortSignal,
            budget: worker.budget, readCoverage: checked, coverageAudit: cap };
        } }, sourceBindingsValidated: true,
      async followUp({ prompt, nextSchema }) {
        acceptedAudit = null;
        this.baselineTask.coverageAudit = null;
        // The old caller writes its repair request outside the read-only
        // snapshot. Deliver that program diagnostic as control, not a newly
        // authorized source or an instruction to read outside the snapshot.
        const repair = await readJson(path.join(requestDirectory, 'ground-truth-repair-request.json'));
        await worker.repair(repair ? JSON.stringify({ validationError: repair.validationError,
          instructions: repair.instructions, recoverCandidateFrom: 'review_history search candidateBatch; originals remain in the frozen source tree' }) : prompt,
        nextSchema ? generationReviewSchema(nextSchema) : undefined);
        this.result = worker.result; this.baselineTask.readCoverage = await coverage(); return this.result;
      },
      close: async () => { try { await worker.close(); } finally { await session.close(); } closedCleanly = true; }, artifacts: directory };
  } catch (error) { try { await worker?.close(); } finally { await session.close(); } throw error; }
}
