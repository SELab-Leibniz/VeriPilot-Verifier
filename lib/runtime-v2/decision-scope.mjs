import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from 'node:util';
import { FileTransactionJournal, journalDigest } from "./transaction-journal.mjs";

// A decision stages existing core writes without holding a lock across a model
// request. The task head later publishes their immutable manifest atomically.
export const decisionScope = new AsyncLocalStorage();
export const outsideDecision = (callback) => decisionScope.run(null, callback);
const attempts = new WeakMap();
const failure = (code, message) => Object.assign(new Error(message), { code });
const jsonCopy = value => JSON.parse(JSON.stringify(value));
function copyContext(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return value;
  if (seen.has(value)) return seen.get(value);
  const copied = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value)); seen.set(value, copied);
  for (const [key, item] of Object.entries(value)) Object.defineProperty(copied, key,
    { value: copyContext(item, seen), writable: true, enumerable: true, configurable: true });
  return copied;
}
function seal(scope, status, reason = null) {
  const owner = attempts.get(scope);
  if (owner.status !== 'OPEN') return;
  owner.status = status; owner.reason = reason; owner.events = jsonCopy(scope.events);
  clearTimeout(owner.timer); owner.signal?.removeEventListener('abort', owner.abort);
  for (const child of owner.children) seal(child, 'DISCARDED', reason);
  owner.children.clear(); attempts.get(owner.parent)?.children.delete(scope);
  Object.freeze(scope.files); Object.freeze(scope.events); Object.freeze(scope.outputs); Object.freeze(scope);
}
function assertOpen(scope) {
  for (let current = scope; current && attempts.has(current); current = attempts.get(current).parent) {
    const owner = attempts.get(current);
    if (owner.status === 'OPEN' && owner.signal?.aborted) seal(current, 'CANCELLED', owner.signal.reason);
    if (owner.status === 'OPEN' && Date.now() >= owner.deadlineAt)
      seal(current, 'EXPIRED', failure('REVIEWER_DEADLINE', 'The original alignment deadline expired'));
    if (owner.status !== 'OPEN') throw failure('DECISION_ATTEMPT_CLOSED', `Attempt is sealed: ${owner.status}`);
  }
}

// A local candidate view, not another publication transaction. Parent audit
// appends are independent; parent candidate/context changes require a retry.
export function createDecisionAttempt({ parent = decisionScope.getStore(), signal,
  deadlineAt = parent?.context.deadlineAt ?? Infinity } = {}) {
  if (!parent || decisionScope.getStore() !== parent) throw failure('DECISION_ATTEMPT_OWNER_INVALID', 'An active parent decision is required');
  assertOpen(parent);
  const inheritedSignal = attempts.get(parent)?.signal ?? parent.context.abortSignal;
  signal = signal && inheritedSignal && signal !== inheritedSignal ? AbortSignal.any([signal, inheritedSignal]) : signal ?? inheritedSignal;
  if (!(Number.isFinite(deadlineAt) || deadlineAt === Infinity)) throw failure('DECISION_ATTEMPT_DEADLINE_INVALID', 'An absolute attempt deadline is required');
  const files = { ...parent.files }, context = copyContext(parent.context), events = copyContext(parent.events);
  const outputs = structuredClone(parent.outputs ?? []);
  const scope = { directory: parent.directory, files: { ...files }, events: [], outputs: [], context: copyContext(context) };
  // Child validators are a delta. The parent validators are composed by the
  // owner at acceptance, so child code cannot replace or accidentally repeat them.
  for (const key of ['evidenceMatches', 'evidenceFailure', 'beforePublish']) delete scope.context[key];
  const owner = { parent, status: 'OPEN', reason: null, deadlineAt: Math.min(deadlineAt, parent.context.deadlineAt ?? Infinity, attempts.get(parent)?.deadlineAt ?? Infinity),
    signal, children: new Set(), events: null, eventsTaken: false };
  attempts.set(scope, owner); attempts.get(parent)?.children.add(scope);
  owner.abort = () => seal(scope, 'CANCELLED', signal.reason);
  signal?.addEventListener('abort', owner.abort, { once: true });
  if (Number.isFinite(owner.deadlineAt)) {
    const arm = () => {
      owner.timer = setTimeout(() => {
        if (Date.now() >= owner.deadlineAt) seal(scope, 'EXPIRED', failure('REVIEWER_DEADLINE', 'The original alignment deadline expired'));
        else if (owner.status === 'OPEN') arm();
      }, Math.max(0, Math.min(owner.deadlineAt - Date.now(), 2 ** 31 - 1)));
      owner.timer.unref?.();
    };
    arm();
  }
  if (signal?.aborted) owner.abort();
  return {
    scope,
    get status() { return owner.status; },
    get reason() { return owner.reason; },
    discard(reason) { seal(scope, 'DISCARDED', reason); },
    takeEvents(predicate) {
      if (owner.status === 'OPEN') throw failure('DECISION_ATTEMPT_OPEN', 'Seal before transferring attempt facts');
      if (owner.eventsTaken) return [];
      owner.eventsTaken = true; return jsonCopy(owner.events.filter(predicate));
    },
    accept() {
      try { assertOpen(scope); } catch (error) { throw owner.reason ?? error; }
      if (!isDeepStrictEqual(parent.files, files) || !isDeepStrictEqual(parent.context, context)
        || !isDeepStrictEqual(parent.outputs ?? [], outputs)
        || !isDeepStrictEqual(parent.events.slice(0, events.length), events)) {
        const error = failure('DECISION_ATTEMPT_CONFLICT', 'Parent candidate or publication context changed while alignment awaited');
        seal(scope, 'CONFLICTED', error); throw error;
      }
      // Deletion is not a supported staged-write operation.
      if (Object.keys(files).some(key => !Object.hasOwn(scope.files, key))) {
        const error = failure('DECISION_ATTEMPT_CONFLICT', 'Attempt removed an unowned parent entry');
        seal(scope, 'CONFLICTED', error); throw error;
      }
      const changedContext = [...new Set([...Object.keys(scope.context), ...Object.keys(context)])]
        .filter(key => !isDeepStrictEqual(scope.context[key], context[key]));
      if (changedContext.some(key => !['evidenceMatches', 'evidenceFailure', 'beforePublish'].includes(key))) {
        const error = failure('DECISION_ATTEMPT_CONFLICT', 'Attempt changed unowned publication context');
        seal(scope, 'CONFLICTED', error); throw error;
      }
      for (const key of ['evidenceMatches', 'beforePublish']) if (scope.context[key] !== undefined && typeof scope.context[key] !== 'function') {
        const error = failure('DECISION_ATTEMPT_CONFLICT', 'Attempt publication validator is not callable');
        seal(scope, 'CONFLICTED', error); throw error;
      }
      const additions = jsonCopy(scope.events), newOutputs = structuredClone(scope.outputs);
      // All checks and delta application are synchronous. No last-writer
      // replacement or shared mutable child buffers can erase parent writes.
      for (const [key, contents] of Object.entries(scope.files)) if (contents !== files[key]) parent.files[key] = contents;
      parent.events.push(...additions); if (newOutputs.length) (parent.outputs ??= []).push(...newOutputs);
      const validateOwner = () => {
        if (owner.signal?.aborted) throw owner.signal.reason instanceof Error ? owner.signal.reason : failure('STOP_CANCELLED', 'Alignment owner was cancelled');
        if (Date.now() >= owner.deadlineAt) throw failure('REVIEWER_DEADLINE', 'The original alignment deadline expired');
      };
      const priorMatch = parent.context.evidenceMatches, match = scope.context.evidenceMatches;
      parent.context.evidenceMatches = async (...args) => {
        if (priorMatch && !await priorMatch(...args)) return false;
        try { validateOwner(); }
        catch (error) { parent.context.evidenceFailure = { code: error.code ?? 'STOP_CANCELLED', reason: error.message }; return false; }
        const before = scope.context.evidenceFailure;
        try { return match ? await match(...args) : true; }
        finally { if (scope.context.evidenceFailure !== before) parent.context.evidenceFailure = copyContext(scope.context.evidenceFailure); }
      };
      const priorPublish = parent.context.beforePublish, publish = scope.context.beforePublish;
      parent.context.beforePublish = async (...args) => {
        validateOwner(); await priorPublish?.(...args);
        const before = scope.context.evidenceFailure;
        try { await publish?.(...args); validateOwner(); }
        finally { if (scope.context.evidenceFailure !== before) parent.context.evidenceFailure = copyContext(scope.context.evidenceFailure); }
      };
      seal(scope, 'ACCEPTED'); owner.eventsTaken = true;
    },
  };
}
export function scopedDecision(file) {
  const scope = decisionScope.getStore();
  if (!scope) return null;
  const relative = path.relative(scope.directory, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  assertOpen(scope); return scope;
}
export function stageWrite(file, contents) {
  const scope = scopedDecision(file);
  if (!scope) return false;
  scope.files[path.relative(scope.directory, path.resolve(file))] = String(contents);
  return true;
}
export function stageAppend(file, value) {
  const scope = scopedDecision(file);
  if (!scope) return false;
  scope.events.push({ file: path.relative(scope.directory, path.resolve(file)), value: jsonCopy(value) });
  return true;
}
export async function decisionRead(file) {
  const scope = scopedDecision(file);
  if (scope) {
    const value = scope.files[path.relative(scope.directory, path.resolve(file))];
    if (value !== undefined) return { found: true, value: JSON.parse(value) };
  }
  // Readers use the same committed manifest even if projection materialization
  // was interrupted. Never turn a half-published evaluation into current truth.
  const normalized = path.resolve(file);
  const match = normalized.match(/^(.*[/\\]\.runtime-correction[/\\]tasks[/\\][^/\\]+)[/\\](.+)$/u);
  if (!match || match[2].startsWith("transactions" + path.sep)) return { found: false };
  try {
    const journal = new FileTransactionJournal(match[1]);
    const publication = await journal.head();
    let projected = null;
    try { projected = JSON.parse(await fs.readFile(path.join(match[1], "task.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    // The ordinary reader keeps using the full current-state projection. A
    // version mismatch falls back to the authoritative checkpoint/delta chain.
    const loaded = publication && projected?.journalSequence === publication.sequence && journalDigest(projected) === publication.stateHash
      ? { state: projected } : await journal.load();
    if (match[2] === "task.json") return loaded ? { found: true, value: loaded.state } : { found: false };
    const head = loaded?.state ?? JSON.parse(await fs.readFile(path.join(match[1], "task.json"), "utf8"));
    if (!head.decisionCommitId || !head.projectionPending) return { found: false };
    const commit = head.decisionSequence != null ? await journal.effects(head.decisionSequence)
      : JSON.parse(await fs.readFile(path.join(match[1], "transactions", `${head.decisionCommitId}.json`), "utf8"));
    const value = commit.files[match[2]];
    return value === undefined ? { found: false } : { found: true, value: JSON.parse(value) };
  } catch (error) {
    // A task with no journal can still be an older, not-yet-created directory.
    if (error.code === "ENOENT" && !await new FileTransactionJournal(match[1]).head()) return { found: false };
    throw error;
  }
}
