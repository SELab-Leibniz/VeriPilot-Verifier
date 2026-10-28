// Controlled component ablation using recorded original sources. This is not
// a business replay, a correction-loop score, or an ArkTS F2P/P2P evaluation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createNativeGatewayEvaluation } from './helpers/native-gateway-evaluation.mjs';
import { validateArtifactSkills } from './bench/validate-artifact-skills.mjs';
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
for (const name of ['--source-run', '--artifact', '--host-root', '--output']) if (!arg(name)) throw new Error(`${name}= required`);
const artifact = await fs.realpath(arg('--artifact')), outputRoot = path.resolve(arg('--output'));
await fs.mkdir(path.dirname(outputRoot), { recursive: true }); await fs.mkdir(outputRoot);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = relative => import(pathToFileURL(path.join(artifact, relative)).href);
const [{ ensureTask, taskDirectory, withTaskState }, { loadCurrentGroundTruth }, { GROUND_TRUTH_REVIEW_SCHEMA }] = await Promise.all([
  load('lib/runtime-v2/task-store.mjs'), load('lib/runtime-v2/ground-truth-ledger.mjs'), load('lib/runtime-v2/reviewer.mjs'),
]);
const sourceRun = JSON.parse(await fs.readFile(path.join(arg('--source-run'), 'result.json'), 'utf8'));
if (sourceRun.state !== 'SETTLED' || !sourceRun.infrastructureComplete) throw new Error('A settled source run is required');
const requestsRoot = path.join(taskDirectory(sourceRun.projectRoot, sourceRun.taskId), 'baseline-task-runs');
const requests = [];
for (const id of await fs.readdir(requestsRoot)) {
  const file = path.join(requestsRoot, id, 'request/request.json');
  if (await fs.stat(file).catch(() => null)) requests.push(file);
}
if (requests.length !== 1) throw new Error('Exactly one recorded baseline input required; select a different source run');
const saved = JSON.parse(await fs.readFile(requests[0], 'utf8'));
const frozenRoot = path.join(path.dirname(path.dirname(requests[0])), 'frozen-source');
const frozenBaseline = Buffer.concat(await Promise.all(saved.requiredFiles.filter(file => file.startsWith('baseline-')).sort()
  .map(file => fs.readFile(path.join(frozenRoot, file)))));
const oldTruth = JSON.parse(frozenBaseline);
if (oldTruth.version !== 0 || oldTruth.claims.length) throw new Error('This component protocol requires an initial empty baseline; never silently discard prior claims');
const projectRoot = path.resolve('.runtime-correction/b', `cmp-${hash(outputRoot).slice(0, 12)}`);
await fs.mkdir(path.dirname(projectRoot), { recursive: true });
const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
execFileSync(git, ['-c', 'core.longpaths=true', '-C', sourceRun.projectRoot, 'worktree', 'add', '--detach', projectRoot, 'HEAD'], { windowsHide: true, stdio: 'pipe' });
const entries = [], sourceSnapshots = [];
for (const source of saved.identity.sources) {
  const chunks = [];
  for (const part of source.parts) {
    if (!/^source-\d{4}-\d{4}\.txt$/u.test(part.file)) throw new Error('Invalid frozen source part identity');
    const bytes = await fs.readFile(path.join(frozenRoot, part.file));
    if (hash(bytes) !== part.sha256) throw new Error('Frozen part hash mismatch'); chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error('Original source hash mismatch');
  sourceSnapshots.push({ ref: source.ref, kind: source.kind, sha256: source.sha256, bytes: bytes.length });
  if (source.kind === 'USER_MESSAGE') {
    if (!source.ref.startsWith('transcript:')) throw new Error('Unsupported original user identity');
    entries.push({ type: 'user', uuid: source.ref.slice('transcript:'.length), message: { role: 'user', content: bytes.toString('utf8') } });
  } else {
    const relative = path.relative(sourceRun.projectRoot, path.resolve(sourceRun.projectRoot, source.ref));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('External material requires a separately declared component protocol');
    const target = path.join(projectRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
}
const parentSessionId = `baseline-component-${randomUUID()}`;
const task = await ensureTask({ projectRoot, sessionId: parentSessionId });
await withTaskState({ projectRoot, taskId: task.taskId }, state => { state.control ??= {}; });
const truth = await loadCurrentGroundTruth(projectRoot, task.taskId);
const truthPath = path.join(taskDirectory(projectRoot, task.taskId), 'ground-truth/current.json');
await fs.mkdir(path.dirname(truthPath), { recursive: true }); await fs.writeFile(truthPath, JSON.stringify(truth));
const remap = value => typeof value === 'string'
  ? value.replaceAll(sourceRun.projectRoot, projectRoot).replaceAll(sourceRun.projectRoot.replaceAll('\\', '/'), projectRoot.replaceAll('\\', '/'))
  : Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)])) : value;
const { identity: _identity, requiredFiles: _files, ...originalRequest } = saved;
const request = { ...remap(originalRequest), taskId: task.taskId,
  currentGroundTruth: { ...originalRequest.currentGroundTruth, path: truthPath, version: truth.version, digest: truth.digest } };
const input = { projectRoot, taskId: task.taskId, parentSessionId, role: 'ground-truth-extractor', request,
  reviewer: { timeoutMs: 180000, effort: 'low', formatRepairAttempts: 3 }, schema: GROUND_TRUTH_REVIEW_SCHEMA,
  evidence: { groundTruth: truth, snapshot: { entries } } };
const skills = await validateArtifactSkills(artifact, arg('--host-root'));
const manifest = { kind: 'recorded-source-baseline-component', ownerPid: process.pid, createdAt: new Date().toISOString(),
  sourceRun: path.resolve(arg('--source-run')), artifact, projectRoot,
  taskId: task.taskId, sourceSnapshots, sourceInputId: hash(JSON.stringify({ sourceSnapshots,
    instructions: originalRequest.instructions, baseline: oldTruth.digest })),
  reviewer: input.reviewer, model: process.env.RC_EVAL_NATIVE_MODEL ?? process.env.ANTHROPIC_MODEL, validatedSkills: skills.length,
  limitations: ['Fresh initial task in a shared Git worktree, with byte-verified recorded original sources.',
    'Direct real private-role invocation; no original business run, host completion event, corrective feedback, or F2P/P2P score is replayed.'] };
await fs.writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(outputRoot, 'input.json'), JSON.stringify(input, null, 2));
if (!process.argv.includes('--live')) { console.log(JSON.stringify({ state: 'PREPARED_NO_MODEL', outputRoot, sourceInputId: manifest.sourceInputId })); process.exit(0); }
let gateway, handle, failure; const startedAt = Date.now();
try {
  gateway = await createNativeGatewayEvaluation({ hostRoot: arg('--host-root'), sourceRoot: process.cwd(), projectRoot, outputRoot,
    prebuiltPluginRoot: artifact, businessToolNames: [] });
  const [{ createOpenClawReviewerFactory }, hostAdapter] = await Promise.all([load('lib/openclaw/reviewer.mjs'), load('lib/hosts/openclaw.mjs')]);
  const factory = createOpenClawReviewerFactory({ runtime: gateway.runtime, config: gateway.config, logger: { warn() {} } }, { pluginRoot: artifact });
  handle = await factory({ ...input, hostAdapter, pluginRoot: artifact });
  await fs.writeFile(path.join(outputRoot, 'candidate-delta.json'), JSON.stringify(handle.result, null, 2));
} catch (error) { failure = { code: error.code ?? 'ERROR', message: error.message }; }
finally { await handle?.close(); await gateway?.drain(); }
const { listNativeRuns } = await load('lib/openclaw/native-runs.mjs');
let nativeRuns = await listNativeRuns(projectRoot, task.taskId);
const settleDeadline = Date.now() + 3000;
while (nativeRuns.some(run => run.status !== 'SETTLED') && Date.now() < settleDeadline) {
  await new Promise(resolve => setTimeout(resolve, 50)); nativeRuns = await listNativeRuns(projectRoot, task.taskId);
}
const usage = [];
for (const file of new Set(nativeRuns.map(run => run.sessionFile).filter(Boolean))) {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) { usage.push({ file, missing: true }); continue; }
  const rows = text.split('\n').filter(Boolean).map(line => JSON.parse(line)), stats = { file, turns: 0, usageRecords: 0, missingUsage: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, missingUsageFields: 0, tools: {} };
  for (const { message } of rows) if (message?.role === 'assistant') {
    stats.turns++;
    for (const block of message.content ?? []) if (block.type === 'toolCall') stats.tools[block.name] = (stats.tools[block.name] ?? 0) + 1;
    if (!message.usage) { stats.missingUsage++; continue; } stats.usageRecords++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'])
      if (typeof message.usage[key] === 'number') stats[key] += message.usage[key]; else stats.missingUsageFields++;
  }
  usage.push(stats);
}
const result = { ...manifest, state: nativeRuns.every(run => run.status === 'SETTLED') ? 'SETTLED' : 'UNSETTLED',
  completed: Boolean(handle && !failure), failure, elapsedMs: Date.now() - startedAt, nativeRuns, usage,
  summedPrivateRunMs: nativeRuns.length && nativeRuns.every(run => Number.isFinite(run.startedAt) && Number.isFinite(run.settledAt) && run.settledAt >= run.startedAt)
    ? nativeRuns.reduce((sum, run) => sum + run.settledAt - run.startedAt, 0) : null,
  operations: handle?.result?.operations?.length ?? null, metrics: gateway?.metrics() };
await fs.writeFile(path.join(outputRoot, 'result.json'), JSON.stringify(result, null, 2));
await gateway?.close();
console.log(JSON.stringify({ state: result.state, completed: result.completed, failure, elapsedMs: result.elapsedMs, outputRoot }));
process.exit(result.state === 'SETTLED' ? 0 : 1);
