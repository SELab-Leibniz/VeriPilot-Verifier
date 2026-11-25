import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = name => typeof name === 'string' && name.toLowerCase() === 'read';

export async function createOwnedReadLoopSources({ projectRoot, requestDirectory, requestPath, prepared, trustedHostSources = [],
  signal, deadlineAt, now = Date.now }) {
  const root = await fs.realpath(projectRoot), privateRoot = await fs.realpath(requestDirectory);
  const subjects = new Map(), aliases = new Map();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const within = file => { const rel = path.relative(privateRoot, file); return rel !== '..'
    && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const version = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
  let bytesRead = 0;
  const refresh = async file => {
    signal?.throwIfAborted();
    if (now() >= deadlineAt || await fs.realpath(file) !== file) return null;
    const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await fd.stat();
      if (!before.isFile() || uid !== null && before.uid !== uid || before.nlink !== 1
        || before.size > 8 * 1024 * 1024) return null;
      const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
      let lines = 1, total = 0;
      while (true) {
        signal?.throwIfAborted();
        if (now() >= deadlineAt || bytesRead >= 64 * 1024 * 1024) return null;
        const { bytesRead: count } = await fd.read(buffer, 0, buffer.length, null);
        if (!count) break;
        total += count; bytesRead += count;
        if (total > 8 * 1024 * 1024) return null;
        digest.update(buffer.subarray(0, count));
        for (let i = 0; i < count; i++) if (buffer[i] === 10) lines++;
      }
      if (version(before) !== version(await fd.stat()) || await fs.realpath(file) !== file
        || version(before) !== version(await fs.lstat(file))) return null;
      return { subjectId: hash(file), sha256: digest.digest('hex'), lineCount: lines, version: version(before) };
    } finally { await fd.close(); }
  };
  // These are current host-generated descriptors, not user-supplied pathname
  // patterns. Unknown files retain ordinary permissions and are not observed.
  const files = [requestPath, prepared.transcript?.path, prepared.transcriptNavigation?.path,
    prepared.groundTruthPath, prepared.skillGroundTruthPath, prepared.skillSourcePath];
  const declared = new Set(trustedHostSources.filter(row => typeof row?.path === 'string').map(row => path.resolve(root, row.path)));
  const withinProject = file => { const rel = path.relative(root, file); return rel !== '..'
    && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  for (const value of new Set([...files, ...declared].filter(file => typeof file === 'string'))) {
    if (subjects.size >= 64) break;
    const address = path.resolve(root, value);
    try {
      const file = await fs.realpath(address);
      if (!within(file) && !(declared.has(address) && withinProject(file))) continue;
      const subject = await refresh(file);
      if (subject) { subjects.set(file, subject); aliases.set(address, file); aliases.set(file, file); }
    }
    catch { /* Missing metadata grants no loop intervention or source proof. */ }
  }
  return async args => {
    const value = args?.path ?? args?.file_path;
    // The native generic read base is its runtime cwd, which can differ from
    // projectRoot. Without an authenticated read base, observe absolute exact
    // host-declared aliases only; relative reads keep their ordinary behavior.
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null;
    const address = path.resolve(root, value), file = aliases.get(address), prior = subjects.get(file);
    if (!prior || now() >= deadlineAt || signal?.aborted) return null;
    try {
      if (await fs.realpath(address) !== file) return null;
      const current = await fs.lstat(file);
      if (version(current) === prior.version) return prior;
      const updated = await refresh(file);
      if (updated) subjects.set(file, updated);
      return updated;
    } catch { return null; }
  };
}

// Executable private integration seam for the existing ALS-owned observer.
// sourceFor must be a HOST catalog lookup, not raw model/tool JSON. A caller can
// supply any declared frozen evidence subject; no filename/task rule is used.
export function createOwnedReadLoopObserver({ guard, runId, sessionId, sessionKey, agentId,
  sourceFor, turnFor, abortOwnedReviewer, onDecision = () => {} }) {
  guard.activateRun(runId);
  let issuedNotice = null;
  const owned = metadata => !Object.entries({ runId, sessionId, sessionKey, agentId }).some(([key, expected]) =>
    expected !== undefined && metadata?.[key] != null && metadata[key] !== expected);
  const observation = async (callId, args) => {
    if (typeof callId !== 'string' || !callId || !args || typeof sourceFor !== 'function') return null;
    const assistantTurn = turnFor?.();
    if (!Number.isSafeInteger(assistantTurn) || assistantTurn < 1) return null;
    let source;
    try { source = await sourceFor(args); } catch { return null; }
    if (!source) return null;
    const start = args.offset ?? 1, count = args.limit ?? null;
    if (!Number.isSafeInteger(start) || start < 1 || count !== null && (!Number.isSafeInteger(count) || count < 1)) return null;
    return { callId, runId, assistantTurn, subjectId: source.subjectId, sourceSha256: source.sha256,
      start, count, readIdentity: hash([source.subjectId, start, count]),
      // Empty/closing-only text is not called EOF. EOF requires the owning
      // source's current SDK-compatible end bound, supplied by the host catalog.
      eof: Number.isSafeInteger(source.lineCount) && start > source.lineCount };
  };
  const handle = decision => {
    if (decision.kind === 'COACH_ONCE') issuedNotice = {
      callId: guard.snapshot().coaching.callId, text: decision.blockReason };
    onDecision(decision, guard.snapshot());
    if (decision.kind === 'TERMINATE_UNVERIFIED') {
      const error = Object.assign(new Error(`${decision.code}: Reviewer repeated unchanged read outcomes after one completion/UNVERIFIED notice.`),
        { code: decision.code, reviewerRuntimeFailure: true });
      // This is the already owning controller. No followUp/new worker, process
      // kill, correction proposal or deadline is allocated by this adapter.
      abortOwnedReviewer(error);
    }
    return decision.kind === 'COACH_ONCE'
      ? { block: true, blockReason: decision.blockReason } : undefined;
  };
  const isCoachingResult = (name, value, metadata = {}) => {
    // Only an exact host-issued veto result is excluded from read proof.
    // Retain this identity even after abort/run transition: a late coaching
    // result must never consume a genuine earlier same-range pending read.
    const result = value?.result, details = result?.details;
    return name === 'read:result' && issuedNotice !== null && read(value?.toolName)
      && owned(value) && owned(metadata) && value.toolCallId === issuedNotice.callId
      && Array.isArray(result?.content) && result.content.length === 1
      && result.content[0]?.type === 'text' && result.content[0].text === issuedNotice.text
      && details?.status === 'blocked' && details.deniedReason === 'plugin-before-tool-call'
      && details.reason === issuedNotice.text;
  };
  const observe = async (name, value, metadata = {}) => {
    if (name === 'read:result') {
      if (isCoachingResult(name, value, metadata)) return;
      if (!read(value?.toolName) || !owned(value) || !owned(metadata)) return;
      const content = value?.result?.content;
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
        || typeof content[0].text !== 'string' || Buffer.byteLength(content[0].text) > 65536) return;
      const event = await observation(value.toolCallId, value.args);
      if (!event) return;
      handle(guard.result({ ...event, payloadSha256: hash(content),
        isError: value.isError === true || value.result.isError === true }));
      return;
    }
    if (!read(name) || !owned(metadata)) return;
    const event = await observation(metadata.toolCallId, value);
    return event ? handle(guard.before(event)) : undefined;
  };
  Object.defineProperty(observe, 'isCoachingResult', { value: isCoachingResult });
  return observe;
}
