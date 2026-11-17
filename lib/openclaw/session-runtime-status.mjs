import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateJson } from "./controller-store.mjs";
import { sha256 } from "../runtime-v2/utils.mjs";
import { withTaskResourceLock } from "../runtime-v2/task-store.mjs";

export const SESSION_RUNTIME_SCHEMA = "runtime-corrector.session-runtime.v1";
export const SESSION_RUNTIME_HEARTBEAT_MS = 5000;
export const SESSION_RUNTIME_STALE_MS = 20000;
const activeStatuses = new Set(["WAITING", "RUNNING", "STOPPING"]);
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
const userStopped = reason => reason === "USER_CONFIRMED_CANCEL" || reason === "RC_ROUND_TERMINATED";

export function sessionRuntimeIdentity(input) {
  const agentId = /^agent:([a-zA-Z0-9_-]+):/u.exec(input?.sessionKey ?? "")?.[1];
  if (!agentId || input.agentId !== undefined && input.agentId !== agentId
    || /:runtime-corrector:|:rc-worker:/u.test(input.sessionKey)
    || typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 512
    || input.sessionId.includes("\0") || input.sessionKey.length > 1024
    || typeof input.projectRoot !== "string" || !path.isAbsolute(input.projectRoot) || input.projectRoot.includes("\0")) {
    throw fail("INVALID_REQUEST", "An absolute projectRoot and exact business sessionKey/sessionId are required.");
  }
  return { projectRoot: path.resolve(input.projectRoot), agentId, sessionKey: input.sessionKey, sessionId: input.sessionId };
}
export const sessionRuntimeKey = input => {
  const i = sessionRuntimeIdentity(input);
  return sha256([i.agentId, i.sessionKey, i.sessionId]);
};
export const sessionRuntimeStatusPath = projectRoot => path.join(path.resolve(projectRoot), ".runtime-correction", "session-runtime-status.json");
export const sessionRuntimeRoundId = (identity, runId, revision = 0) => runId
  ? sha256([sessionRuntimeKey(identity), identity.scopeFingerprint ?? identity.projectScope?.fingerprint ?? null, revision, runId]) : null;

async function safeFile(projectRoot, create = false) {
  const root = await fs.realpath(projectRoot);
  const canonical = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (canonical(root) !== canonical(projectRoot)) {
    throw fail("RC_STATUS_PROJECT_ALIAS", "Use the project's canonical filesystem path.");
  }
  const directory = path.join(root, ".runtime-correction");
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [file, directoryOnly] of [[directory, true], [sessionRuntimeStatusPath(root), false]]) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !(directoryOnly ? stat.isDirectory() : stat.isFile()))
        throw fail("RC_STATUS_PATH_UNSAFE", "The runtime status path must contain regular directories/files.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return sessionRuntimeStatusPath(root);
}
async function document(projectRoot) {
  const file = await safeFile(projectRoot);
  let data;
  try { data = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (data.schemaVersion !== SESSION_RUNTIME_SCHEMA || data.projectRoot !== path.resolve(projectRoot)
    || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) {
    throw fail("RC_STATUS_FILE_INVALID", "Invalid session runtime status file; it was not overwritten.");
  }
  return data;
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}
export function runtimeStatusHealth(record, now = Date.now()) {
  if (!record || !activeStatuses.has(record.status) && record.status !== "UNKNOWN") return "SETTLED";
  if (processAlive(record.owner?.pid) === false) return "OWNER_EXITED";
  if (!Number.isFinite(record.heartbeatExpiresAt) || now > record.heartbeatExpiresAt) return "STALE";
  return record.status === "UNKNOWN" ? "UNKNOWN" : "FRESH";
}
export async function readSessionRuntimeStatus(input) {
  const identity = sessionRuntimeIdentity(input);
  identity.projectRoot = await fs.realpath(identity.projectRoot);
  const data = await document(identity.projectRoot);
  const record = data?.sessions[sessionRuntimeKey(identity)];
  if (!record) return { schemaVersion: SESSION_RUNTIME_SCHEMA, ...identity, registered: false, status: "NOT_REGISTERED",
    phase: null, roundId: null, runId: null, active: false, running: false, ended: null, canTerminate: false,
    health: "UNKNOWN", statusFile: sessionRuntimeStatusPath(identity.projectRoot) };
  if (["agentId", "sessionKey", "sessionId", "projectRoot"].some(key => record[key] !== identity[key]))
    throw fail("RC_STATUS_FILE_INVALID", "Runtime status identity does not match its index.");
  const health = runtimeStatusHealth(record);
  return { ...copy(record), registered: true, health, statusFile: sessionRuntimeStatusPath(identity.projectRoot),
    ...(health === "STALE" || health === "OWNER_EXITED" ? {
      lastObservedStatus: record.lastObservedStatus ?? record.status, status: "UNKNOWN", active: null, running: null, ended: null, canTerminate: false,
    } : {}) };
}
async function mutateDocument(identity, mutate) {
  await safeFile(identity.projectRoot, true);
  return withTaskResourceLock({ projectRoot: identity.projectRoot, taskId: "rc-session-runtime-status",
    resource: "status", reclaimDeadOwner: true, timeoutMs: 3000 }, async () => {
    const file = await safeFile(identity.projectRoot);
    const data = await document(identity.projectRoot) ?? { schemaVersion: SESSION_RUNTIME_SCHEMA,
      projectRoot: identity.projectRoot, revision: 0, sessions: {} };
    const result = await mutate(data, sessionRuntimeKey(identity));
    if (result !== false) { data.revision++; data.updatedAt = Date.now(); await privateJson(file, data); }
    return result;
  });
}
const terminalSummary = r => ({ roundId: r.roundId, runId: r.runId, status: r.status, ended: r.ended,
  reasonCode: r.reasonCode, outcome: r.outcome, startedAt: r.startedAt, endedAt: r.endedAt });

/** Offline self-check only changes an expired snapshot, never a live execution. */
export async function reconcileStoredSessionRuntimeStatus(input) {
  const identity = sessionRuntimeIdentity(input);
  identity.projectRoot = await fs.realpath(identity.projectRoot);
  const previous = await readSessionRuntimeStatus(identity);
  if (!previous.registered || !["OWNER_EXITED", "STALE"].includes(previous.health)) return previous;
  await mutateDocument(identity, (data, key) => {
    const r = data.sessions[key];
    if (!r || r.version !== previous.version || r.owner?.token !== previous.owner?.token) return false;
    const health = runtimeStatusHealth(r);
    if (!["OWNER_EXITED", "STALE"].includes(health)) return false;
    r.version++; r.checkedAt = Date.now();
    if (health === "OWNER_EXITED") {
      Object.assign(r, { status: "INTERRUPTED", phase: "ENDED", active: false, running: false, ended: true,
        canTerminate: false, endedAt: Date.now(), reasonCode: "RC_OWNER_EXITED", outcome: "UNVERIFIED" });
      r.lastEndedRound = terminalSummary(r);
    } else Object.assign(r, { lastObservedStatus: r.lastObservedStatus ?? r.status, status: "UNKNOWN", active: null, running: null,
      ended: null, canTerminate: false, reasonCode: "RC_OWNER_UNRESPONSIVE" });
  });
  return readSessionRuntimeStatus(identity);
}

export function createSessionRuntimeStatus({ states, pausedScopes, dispatcher, stopJobs, resolveScope,
  terminate, logger, heartbeatMs = SESSION_RUNTIME_HEARTBEAT_MS }) {
  const owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  const known = new Map(), activities = new Map(), terminals = new Map(), writes = new Map(), cancellations = new Map();
  let closed = false, closing = false, disposal;
  const identityOf = state => ({ projectRoot: state.projectRoot, agentId: state.agentId ?? "main",
    sessionKey: state.sessionKey, sessionId: state.sessionId });
  const stateFor = identity => [...states.values(), ...pausedScopes.values()].find(s => s.projectRoot === identity.projectRoot
    && s.sessionKey === identity.sessionKey && s.sessionId === identity.sessionId && (s.agentId ?? "main") === identity.agentId);
  const rawRecord = (identity, state) => {
    const manager = dispatcher();
    if (!manager) return;
    const direct = state && manager.get({ ...identity, scopeFingerprint: state.projectScope?.fingerprint,
      scopeTaskId: state.scopeTaskId, controlRevision: state.enabledRevision ?? 0 });
    if (direct) return direct;
    for (let offset = 0; ; offset += 100) {
      const page = manager.list({ search: identity.sessionKey, offset, limit: 100 });
      const found = page.sessions.find(r => r.projectRoot === identity.projectRoot && r.sessionKey === identity.sessionKey
        && r.sessionId === identity.sessionId && r.agentId === identity.agentId);
      if (found) return manager.byId(found.id);
      if (offset + 100 >= page.total) return;
    }
  };
  function snapshot(identity, suppliedRecord) {
    const state = stateFor(identity), record = suppliedRecord ?? rawRecord(identity, state);
    const runId = suppliedRecord ? suppliedRecord.runId ?? null : record?.runId
      && (!state?.nativeRunId || record.phase !== "IDLE" || record.runId === state.nativeRunId)
      ? record.runId : state?.nativeRunId ?? record?.runId ?? null;
    const revision = (suppliedRecord ? record?.controlRevision : state?.enabledRevision) ?? record?.controlRevision ?? 0;
    const scopeFingerprint = (suppliedRecord ? record?.scopeFingerprint : state?.projectScope?.fingerprint) ?? record?.scopeFingerprint ?? null;
    const roundId = sessionRuntimeRoundId({ ...identity, scopeFingerprint }, runId, revision);
    const work = [...activities.values()].filter(a => a.roundId === roundId);
    const terminal = terminals.get(roundId);
    const frame = state?.nativeRunId === runId && state.requirementFrameWork && !state.requirementFrameWork.controller.signal.aborted;
    const hot = state?.nativeRunId === runId && state.hotReviewWork && !state.hotReviewWork.controller.signal.aborted;
    const jobs = state ? stopJobs?.(state) ?? [] : [];
    let phase = record?.phase ?? (runId ? "RUNNING" : "IDLE"), status, reasonCode = record?.terminalRelease?.reason ?? record?.reason ?? null;
    if (["USER_DISPATCHING", "RUNNING"].includes(phase) && record?.lastTerminal?.runId !== runId && userStopped(reasonCode)) reasonCode = null;
    if (!record || record.phase === "IDLE" && record.runId !== runId) {
      if (terminal) { phase = "ENDED"; reasonCode = terminal.reasonCode; }
      else if (jobs.length) phase = "REVIEWING";
      else if (state?.nativeEndedRun === runId && !state.nativePostRunReview && !hot && !frame && !work.length) {
        phase = "ENDED"; reasonCode = state.reviewController?.signal.reason?.code ?? "HOST_RUN_ENDED";
      }
    }
    if (state?.scopeClosed || state?.controlPaused) { phase = "ENDED"; reasonCode = state.controlPaused ? "RC_SESSION_DISABLED" : "RC_SCOPE_CLOSED"; }
    if (phase === "RELEASING") status = "STOPPING";
    else if (["IDLE", "ENDED", "CLOSED"].includes(phase)) status = runId ? userStopped(reasonCode) ? "TERMINATED"
      : phase === "CLOSED" ? "INTERRUPTED" : "ENDED" : "IDLE";
    else if (["REVIEWING", "CORRECTING"].includes(phase) || work.length || frame || hot) status = "RUNNING";
    else status = "WAITING";
    const detail = work.at(-1)?.role ?? (frame ? "requirement-frame" : hot ? "background-review" : null);
    const active = activeStatuses.has(status), ended = runId ? !active : null;
    // The dispatcher retains its last reviewStatus when a new run starts.
    // Expose it only after that exact run has actually settled.
    const recordOutcome = record?.runId === runId && record?.completedRuns?.includes(runId) ? record.reviewStatus : null;
    return { schemaVersion: SESSION_RUNTIME_SCHEMA, ...identity, scopeFingerprint, controlRevision: revision,
      taskId: state?.scopeTaskId ?? record?.scopeTaskId ?? null, roundId, runId, phase,
      stage: detail ?? phase, status, active, running: status === "RUNNING", ended,
      canTerminate: active && status !== "STOPPING" && phase !== "USER_DISPATCHING",
      reasonCode, outcome: userStopped(reasonCode) ? "UNVERIFIED" : terminal?.outcome ?? recordOutcome,
      projectEnabled: state?.projectScope?.projectEnabled ?? null, sessionEnabled: state?.projectScope?.sessionEnabled ?? null,
      effectiveEnabled: state ? !state.scopeClosed && !state.controlPaused : null,
      pendingUserTasks: record?.pending?.length ?? 0, hostReconciliation: record?.reconciliation?.status ?? null,
      activities: work.map(({ id, role, startedAt }) => ({ id, role, startedAt })),
      owner, checkedAt: Date.now(), heartbeatAt: Date.now(), heartbeatExpiresAt: Date.now() + SESSION_RUNTIME_STALE_MS };
  }
  async function publish(identity, record, override) {
    if (closed) return;
    const key = sessionRuntimeKey(identity);
    known.set(key, { identity, ...(record ? { record: copy(record) } : known.get(key)) });
    const captured = { ...snapshot(identity, record), ...override };
    const previousWrite = writes.get(key) ?? Promise.resolve();
    const writing = previousWrite.catch(() => {}).then(async () => {
      const next = captured;
      await mutateDocument(identity, (data, index) => {
        const previous = data.sessions[index];
        if (previous?.owner?.token !== owner.token && previous?.owner && !previous.ended
          && (previous.owner.pid !== owner.pid ? processAlive(previous.owner.pid) !== false : previous.owner.createdAt > owner.createdAt))
          throw fail("RC_STATUS_OWNER_CONFLICT", "Another live RC instance owns this Session status.");
        const history = [...previous?.history ?? []];
        if (previous?.roundId && previous.roundId !== next.roundId && previous.ended) {
          if (!history.some(r => r.roundId === previous.roundId)) history.push(terminalSummary(previous));
        }
        next.history = history.slice(-20);
        next.startedAt = previous?.roundId === next.roundId ? previous.startedAt : next.runId ? Date.now() : null;
        next.endedAt = next.ended ? previous?.roundId === next.roundId && previous.ended ? previous.endedAt : Date.now() : null;
        next.lastEndedRound = next.ended ? terminalSummary(next) : previous?.lastEndedRound ?? history.at(-1) ?? null;
        next.version = (previous?.version ?? 0) + 1;
        data.sessions[index] = next;
      });
    });
    writes.set(key, writing);
    void writing.catch(error => logger?.warn?.(`[runtime-corrector] Session status: ${error.code ?? error.name}`));
    try { await writing; } finally { if (writes.get(key) === writing) writes.delete(key); }
  }
  const notify = (identity, record) => { if (!closed && !closing) void publish(identity, record).catch(() => {}); };
  const timer = setInterval(() => {
    for (const { identity } of known.values()) if (snapshot(identity).active) notify(identity);
  }, heartbeatMs); timer.unref?.();
  async function target(input) {
    const identity = sessionRuntimeIdentity(input);
    try { identity.projectRoot = await fs.realpath(identity.projectRoot); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) throw fail("CONFLICT", "The target project no longer exists."); throw error; }
    const scope = await resolveScope(identity);
    if (scope.identity?.sessionId !== identity.sessionId || scope.projectRoot !== identity.projectRoot
      || scope.identity?.sessionKey !== identity.sessionKey) throw fail("CONFLICT", "Session or project changed; refresh the target.");
    return { identity, scope, state: stateFor(identity), record: rawRecord(identity, stateFor(identity)) };
  }
  const service = {
    track(state) { if (state?.projectRoot && state.sessionKey) notify(identityOf(state)); },
    onPostRun(record) {
      const identity = sessionRuntimeIdentity(record), state = stateFor(identity);
      if (state && (state.projectScope?.fingerprint !== record.scopeFingerprint
        || (state.enabledRevision ?? 0) !== (record.controlRevision ?? 0))) return;
      notify(identity, record);
    },
    reviewStarted(state, id, info) {
      const identity = identityOf(state);
      activities.set(id, { id, role: info.role, startedAt: info.startedAt ?? Date.now(),
        roundId: sessionRuntimeRoundId({ ...identity, scopeFingerprint: state.projectScope?.fingerprint }, state.nativeRunId, state.enabledRevision ?? 0) });
      notify(identity);
    },
    reviewEnded(state, id) { activities.delete(id); if (state.sessionKey) notify(identityOf(state)); },
    settled(state, runId, record) {
      const identity = identityOf(state), roundId = sessionRuntimeRoundId({ ...identity, scopeFingerprint: state.projectScope?.fingerprint }, runId, state.enabledRevision ?? 0);
      if (!userStopped(terminals.get(roundId)?.reasonCode))
        terminals.set(roundId, { reasonCode: record.reasonCode ?? null, outcome: record.reviewStatus ?? "UNVERIFIED" });
      notify(identity);
    },
    async isTerminated(state, runId) {
      const identity = identityOf(state);
      const roundId = sessionRuntimeRoundId({ ...identity, scopeFingerprint: state.projectScope?.fingerprint }, runId, state.enabledRevision ?? 0);
      const saved = await readSessionRuntimeStatus(identity);
      return [saved, ...saved.history ?? []].some(r => r.roundId === roundId && userStopped(r.reasonCode)
        && (r.ended === true || r.status === "STOPPING" || r.lastObservedStatus === "STOPPING"));
    },
    async get(input) {
      const { identity, scope } = await target(input);
      await writes.get(sessionRuntimeKey(identity))?.catch(() => {});
      return { ...await readSessionRuntimeStatus(identity), projectEnabled: scope.projectEnabled ?? null,
        sessionEnabled: scope.sessionEnabled ?? null, effectiveEnabled: scope.enabled === true };
    },
    async refresh(input) {
      const { identity, record, scope } = await target(input);
      if (record?.reconciliation || record?.phase === "RELEASING") {
        const work = dispatcher().recheck(record, { actor: input.actor, runId: record.runId, version: record.version });
        let timeout;
        try { await Promise.race([work, new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]); }
        finally { clearTimeout(timeout); void work.catch(() => {}); }
      }
      await publish(identity, undefined, { projectEnabled: scope.projectEnabled ?? null,
        sessionEnabled: scope.sessionEnabled ?? null, effectiveEnabled: scope.enabled === true });
      return readSessionRuntimeStatus(identity);
    },
    async terminate(input) {
      const { identity, state, record } = await target(input);
      await publish(identity);
      const current = await readSessionRuntimeStatus(identity);
      if (typeof input.roundId !== "string" || !/^[a-f0-9]{64}$/u.test(input.roundId)) throw fail("INVALID_REQUEST", "The queried roundId is required for termination.");
      const ended = (current.roundId === input.roundId ? [current] : [...current.history ?? [], current.lastEndedRound])
        .find(r => r?.roundId === input.roundId && r.ended);
      if (ended) return { accepted: true, alreadyEnded: true, target: terminalSummary(ended), current };
      if (snapshot(identity).roundId !== input.roundId || current.roundId !== input.roundId)
        throw fail("CONFLICT", "The correction round changed; the new round was not terminated.");
      if (cancellations.has(input.roundId)) return cancellations.get(input.roundId);
      const live = snapshot(identity);
      if (live.status === "STOPPING") return { accepted: true, alreadyRequested: true, target: terminalSummary(current), current };
      if (!live.canTerminate) throw fail("CONFLICT", "No active RC-owned correction round can be terminated.");
      const work = (async () => {
        await terminate({ identity, state, record, roundId: input.roundId, actor: input.actor });
        // Dispatch may already have started the next queued user task. Never
        // overwrite that new round with the old round's termination receipt.
        terminals.set(input.roundId, { reasonCode: "USER_CONFIRMED_CANCEL", outcome: "UNVERIFIED" });
        await publish(identity);
        const after = await readSessionRuntimeStatus(identity);
        return { accepted: true, target: { roundId: input.roundId, runId: current.runId,
          ended: after.roundId === input.roundId ? after.ended : true,
          status: after.roundId === input.roundId ? after.status : "TERMINATED", reasonCode: "USER_CONFIRMED_CANCEL" }, current: after };
      })();
      cancellations.set(input.roundId, work);
      try { return await work; } finally { cancellations.delete(input.roundId); }
    },
    dispose() { return disposal ??= (async () => {
      closing = true;
      clearInterval(timer);
      await Promise.allSettled([...writes.values()]);
      for (const { identity } of known.values()) {
        const status = snapshot(identity);
        if (status.active) await publish(identity, undefined, { status: "INTERRUPTED", phase: "ENDED", active: false,
          running: false, ended: true, canTerminate: false, reasonCode: "RC_PLUGIN_STOPPED", outcome: "UNVERIFIED" }).catch(() => {});
      }
      closed = true;
    })(); },
    flush: () => Promise.allSettled([...writes.values()]),
    get closed() { return closed || closing; },
  };
  return service;
}
