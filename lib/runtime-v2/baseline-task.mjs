// Stop-only extraction adapter. Source identity and ledger authority remain in
// the existing Ground Truth chain; the worker never writes the formal ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskDirectory } from './task-store.mjs';
import { generationReviewSchema } from './reviewer.mjs';
import { readJson, sha256 } from './utils.mjs';
import { scopedDecision } from './decision-scope.mjs';
import { prepareSourceInputs, bindSourceSelections, validateSourceBindings } from '../openclaw/sources.mjs';
import { excerpt } from '../review-task/review-task.mjs';
import { createBaselineWorker } from '../review-task/baseline-task.mjs';
import { createNativeTaskSession } from '../openclaw/task-session.mjs';

export const isStopBaselineTask = input => input.role === 'ground-truth-extractor'
  && input.request?.reviewScope?.kind === 'baseline' && input.request.reviewScope.boundedBasis === true;
const fail = (code, message) => Object.assign(new Error(message), { code });

export async function runStopBaselineTask(input, dependencies) {
  if (!isStopBaselineTask(input)) throw fail('BASELINE_SCOPE_INVALID', 'Not a Stop baseline refresh');
  const session = await createNativeTaskSession(input, dependencies);
  const directory = path.join(taskDirectory(input.projectRoot, input.taskId), 'baseline-task-runs', randomUUID());
  const root = path.join(directory, 'frozen-source'), requestDirectory = path.join(directory, 'request');
  let worker;
  try {
    session.active();
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(requestDirectory);
    const original = structuredClone(input.request), catalog = original.sourceCatalog ?? [];
    if (!Array.isArray(catalog) || !catalog.some(source => source.kind === 'USER_MESSAGE'))
      throw fail('BASELINE_SOURCE_INVALID', 'Stop baseline requires an original user source catalog');
    const truth = structuredClone(input.evidence?.groundTruth ?? await readJson(original.currentGroundTruth?.path));
    if (!truth || truth.taskId && truth.taskId !== input.taskId) throw fail('BASELINE_INPUT_CHANGED', 'Original baseline identity is unavailable');
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
      requestDirectory, projectRoot: input.projectRoot, assertActive: session.active });
    const files = [], sources = [], origins = new Map(), texts = new Map(), live = [];
    async function freeze(name, bytes, source = null) {
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0)) throw fail('BASELINE_SOURCE_INVALID', 'Required source is not UTF-8 text');
      const parts = [];
      for (let start = 0, index = 0; start < bytes.length || index === 0; index++) {
        session.active();
        let end = Math.min(start + 16384, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        const file = `${name}-${String(index).padStart(4, '0')}.txt`;
        await fs.writeFile(path.join(root, file), bytes.subarray(start, end), { flag: 'wx' });
        const part = { file, startByte: start, endByte: end, sha256: sha256(bytes.subarray(start, end)) };
        parts.push(part); files.push(file);
        if (source) origins.set(file, { ...source, startByte: start, endByte: end });
        start = end; if (end === bytes.length) break;
      }
      return parts;
    }
    await freeze('request', Buffer.from(JSON.stringify(original)));
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
        if (file !== real || /(?:^|[/\\])(?:\.runtime-correction|\.git|\.aws|\.ssh|\.env)(?:[/\\.]|$)/u.test(checkedPath))
          throw fail('BASELINE_SOURCE_INVALID', 'Unsafe or linked source');
        bytes = await fs.readFile(file); live.push({ file, sha256: sha256(bytes) });
      }
      delivery.sourceTexts.set(source.ref, bytes.toString('utf8')); texts.set(source.ref, bytes);
      const item = { ref: source.ref, kind: source.kind, sha256: sha256(bytes), bytes: bytes.length };
      item.parts = await freeze(`source-${String(index).padStart(4, '0')}`, bytes, item);
      sources.push(item);
    }
    const requestId = sha256({ protocol: 'stop-baseline-task-v1', taskId: input.taskId, request: original,
      baseline: [truth.version, truth.digest], sources });
    const identity = { requestId, taskId: input.taskId, hookEventId: original.hookEventId,
      baselineVersion: truth.version, baselineDigest: truth.digest, sourceCatalog: catalog, sources,
      deadlineAt: session.deadlineAt, publicationDeadlineAt };
    await fs.writeFile(path.join(requestDirectory, 'request.json'), JSON.stringify({ ...original, identity, requiredFiles: files }));
    async function assertCurrent() {
      input.abortSignal?.throwIfAborted();
      if (Date.now() >= publicationDeadlineAt) throw fail('REVIEWER_DEADLINE', 'Baseline publication deadline expired');
      const publishing = originalDecision && scopedDecision(truthPath) !== originalDecision;
      const current = await readJson(truthPath), expected = publishing ? persistedTruth : truth;
      if (sha256(current) !== sha256(expected) && !(current === null && expected?.version === 0)
        || current?.taskId && current.taskId !== input.taskId)
        throw fail('BASELINE_INPUT_CHANGED', 'Original baseline version changed');
      const state = await readJson(path.join(taskDirectory(input.projectRoot, input.taskId), 'task.json'));
      if (state?.control?.cancelled || state?.control?.cancelEpoch !== originalTask?.control?.cancelEpoch
        || state?.rootSessionId !== originalTask?.rootSessionId) throw fail('BASELINE_INPUT_CHANGED', 'Task ownership or cancellation changed');
      for (const item of live) {
        if (await fs.realpath(item.file) !== item.file || sha256(await fs.readFile(item.file)) !== item.sha256)
          throw fail('BASELINE_INPUT_CHANGED', 'Original source changed');
      }
      input.abortSignal?.throwIfAborted();
    }
    function bindOperations(operations, bindings, registry) {
      const value = structuredClone(operations);
      bindSourceSelections(value, delivery, catalog); validateSourceBindings(value, catalog);
      for (const [index, operation] of value.entries()) {
        const selected = operation.source.ref.replaceAll('\\', '/');
        const direct = catalog.filter(source => [source.ref, ...(source.aliases ?? [])].includes(selected));
        const range = /^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(selected);
        const matches = direct.length ? direct : catalog.filter(source => [source.ref, ...(source.aliases ?? [])].includes(range?.[1]));
        if (!matches.length && ['AGENT_INFERRED', 'BASIS_PENDING'].includes(operation.authority)) continue;
        if (new Set(matches.map(source => source.ref)).size !== 1) throw fail('BASELINE_SOURCE_INVALID', 'Ambiguous operation source');
        const source = matches[0], bytes = texts.get(source.ref);
        if (!bytes) throw fail('BASELINE_SOURCE_INVALID', 'Operation source has not been frozen');
        const target = !direct.length && range ? excerpt(bytes, Number(range[2]), Number(range[3] ?? range[2])) : { byteStart: 0, byteEnd: bytes.length };
        const cited = bindings.filter(binding => binding.operationIndex === index);
        if (cited.length !== 1 || !cited[0].citeIds?.length) throw fail('BASELINE_SOURCE_INVALID', 'Each operation needs an original-source binding');
        const intervals = cited[0].citeIds.map(id => {
          const citation = registry.get(id), origin = origins.get(citation?.path);
          if (!origin || origin.ref !== source.ref) throw fail('BASELINE_SOURCE_INVALID', 'Unacknowledged or foreign source citation');
          return { start: origin.startByte + citation.byteStart, end: origin.startByte + citation.byteEnd };
        }).sort((a, b) => a.start - b.start);
        let next = target.byteStart;
        for (const interval of intervals) { if (interval.start > next) break; next = Math.max(next, interval.end); }
        if (next < target.byteEnd) throw fail('BASELINE_SOURCE_INVALID', 'Selected original range was not fully disclosed');
        // Canonical source identity plus program-captured original excerpt.
        operation.source.ref = source.ref + (!direct.length && range ? `#L${range[2]}-L${range[3] ?? range[2]}` : '');
      }
      return value;
    }
    worker = await createBaselineWorker({ root, outputDir: directory, identity, requiredFiles: files,
      schema: input.schema, signal: session.signal, deadlineAt: session.deadlineAt,
      maxRepairs: input.reviewer?.formatRepairAttempts ?? 3, active: session.active, assertCurrent, bindOperations,
      maxTokens: input.reviewer?.maxOutputTokens,
      nativeRun: session.run, faults: dependencies.options?.baselineFaults });
    await input.onPrepared?.({ requestDirectory, requestPath: path.join(requestDirectory, 'request.json'), request: { ...original, identity, requiredFiles: files } });
    await worker.execute();
    return { result: worker.result, requestDirectory, sessionId: session.sessionId, lease: session.lease,
      baselineTask: { requestId, expectedVersion: truth.version, expectedDigest: truth.digest, assertCurrent,
        deadlineAt: publicationDeadlineAt, extractionDeadlineAt: session.deadlineAt, signal: input.abortSignal }, sourceBindingsValidated: true,
      async followUp({ prompt, nextSchema }) {
        // The old caller writes its repair request outside the read-only
        // snapshot. Deliver that program diagnostic as control, not a newly
        // authorized source or an instruction to read outside the snapshot.
        const repair = await readJson(path.join(requestDirectory, 'ground-truth-repair-request.json'));
        await worker.repair(repair ? JSON.stringify({ validationError: repair.validationError,
          instructions: repair.instructions, recoverCandidateFrom: 'review_history search candidateBatch; originals remain in the frozen source tree' }) : prompt,
        nextSchema ? generationReviewSchema(nextSchema) : undefined);
        this.result = worker.result; return this.result;
      },
      close: async () => { await worker.close(); await session.close(); }, artifacts: directory };
  } catch (error) { await worker?.close(); await session.close(); throw error; }
}
