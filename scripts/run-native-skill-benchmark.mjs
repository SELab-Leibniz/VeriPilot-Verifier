// Host controller for the cached DeepSWE task. The model key stays on the host;
// the task container receives a disposable token for this single local relay.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { unifiedSkillFeedbackReceipts } from './helpers/skill-e2e-feedback.mjs';

const args = process.argv.slice(2), value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const root = path.resolve(value('--prepared-root'));
const attempt = value('--attempt') ?? 'live-relay-001';
if (!/^[a-z0-9-]+$/u.test(attempt)) throw new Error('Invalid attempt name');
const key = process.env.RC_EVAL_API_KEY;
delete process.env.RC_EVAL_API_KEY;
if (!key?.trim()) throw new Error('Provide RC_EVAL_API_KEY only in the host process environment');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json')));
if (!/^[a-z0-9-]+$/u.test(manifest.task) || manifest.benchmark !== 'DeepSWE 1.1') throw new Error('Unexpected prepared task');
if (execFileSync('docker', ['image', 'inspect', manifest.image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim() !== manifest.imageId)
  throw new Error('Prepared benchmark image identity changed');
const model = manifest.model;
const resumeFrom = args.includes('--resume-from') ? path.resolve(value('--resume-from')) : null;
const runtimeMs = args.includes('--timeout-ms') ? Number(value('--timeout-ms')) : manifest.maxRuntimeMs;
if (!Number.isSafeInteger(runtimeMs) || runtimeMs < 2000 || runtimeMs > manifest.maxRuntimeMs || runtimeMs % 1000)
  throw new Error('Invalid remaining benchmark window');
const relayDeadlineAt = Date.now() + runtimeMs;
const retryBaseMs = Number(process.env.RC_EVAL_RETRY_BASE_MS ?? 30000);
const retryMaxMs = Number(process.env.RC_EVAL_RETRY_MAX_MS ?? 120000);
if (![retryBaseMs, retryMaxMs].every(n => Number.isSafeInteger(n) && n >= 1) || retryMaxMs < retryBaseMs)
  throw new Error('Invalid configurable relay retry delays');
const image = args.includes('--checkpoint-image')
  ? execFileSync('docker', ['image', 'inspect', value('--checkpoint-image'), '--format', '{{.Id}}'], { encoding: 'utf8' }).trim()
  : manifest.imageId;
const run = path.join(root, attempt); await fs.mkdir(run);
if (resumeFrom) {
  const exit = JSON.parse(await fs.readFile(path.join(resumeFrom, 'process-exit.json')));
  if (!exit.relayClosed || !Number.isInteger(exit.exitCode)) throw new Error('Resume requires a closed source controller');
  await fs.cp(path.join(resumeFrom, 'native-host'), path.join(run, 'native-host'), { recursive: true });
  await fs.copyFile(path.join(resumeFrom, 'target.json'), path.join(run, 'resume-source-target.json'));
  await fs.copyFile(path.join(resumeFrom, 'result.json'), path.join(run, 'resume-source-result.json'));
  await fs.copyFile(path.join(resumeFrom, 'working-tree.patch'), path.join(run, 'resume-source-working-tree.patch'));
  // The prior container has stopped. Ephemeral write-lock ownership cannot be
  // copied into a new process; actual session history and all old evidence stay.
  for (const file of await fs.readdir(path.join(run, 'native-host'))) if (file.endsWith('.lock'))
    await fs.rm(path.join(run, 'native-host', file), { recursive: true, force: true });
}

const hostRequests = path.join(root, `host-requests-${attempt}`); await fs.mkdir(hostRequests);
const token = `local-only-${randomBytes(32).toString('hex')}`;
const controller = new AbortController(), records = [], sockets = new Set(), jobs = new Set();
let upstreamSteps = 0;
const saveRelay = () => fs.writeFile(path.join(run, 'relay.json'), JSON.stringify({ configuredWallMs: runtimeMs, maxSteps: manifest.maxSteps,
  upstreamSteps, retryBaseMs, retryMaxMs,
  actualModel: model, upstream: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  credentialsSaved: false, requests: records }, null, 2));
const server = http.createServer(async (request, response) => {
  if (request.url === '/health' && request.method === 'GET') { response.end('ok'); return; }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
  const job = (async () => {
    const id = records.length + 1, record = { id, startedAt: Date.now() }; records.push(record);
    const abort = new AbortController();
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    response.once('close', disconnected);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Relay payload too large'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), payload = JSON.parse(body);
      if (payload.model !== model) throw new Error('Unexpected model');
      const thinking = (payload.messages ?? []).filter(message => typeof message.reasoning_content === 'string' && message.reasoning_content.length);
      record.historyReasoningBlocks = thinking.length;
      record.historyReasoningChars = thinking.reduce((sum, message) => sum + message.reasoning_content.length, 0);
      record.reasoningEffort = payload.reasoning_effort ?? null;
      await fs.writeFile(path.join(hostRequests, `request-${id}.json`), body);
      record.requestBytes = size; record.requestSha256 = createHash('sha256').update(body).digest('hex');
      record.attempts = [];
      let upstream;
      while (true) {
        if (upstreamSteps >= manifest.maxSteps) { record.denied = 'CONFIGURED_STEP_LIMIT'; throw new Error('Configured Skill model-step budget exhausted'); }
        if (Date.now() >= relayDeadlineAt) throw new Error('Configured Skill wall budget exhausted');
        const transport = { step: ++upstreamSteps, startedAt: Date.now() }; record.attempts.push(transport);
        upstream = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body,
          signal: AbortSignal.any([controller.signal, abort.signal, AbortSignal.timeout(Math.max(1, relayDeadlineAt - Date.now()))]), redirect: 'error' });
        transport.status = upstream.status; transport.endedAt = Date.now();
        record.status = upstream.status;
        if (![408, 429, 500, 502, 503, 504].includes(upstream.status) || upstreamSteps >= manifest.maxSteps) break;
        const retryAfter = upstream.headers.get('retry-after');
        const advertisedMs = /^\d+(\.\d+)?$/u.test(retryAfter ?? '') ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter ?? '') - Date.now()) || 0;
        const waitMs = Math.min(retryMaxMs, Math.max(advertisedMs, retryBaseMs * 2 ** Math.min(record.attempts.length - 1, 20)));
        if (Date.now() + waitMs >= relayDeadlineAt) break;
        await upstream.arrayBuffer();
        transport.retryDelayMs = waitMs; await saveRelay();
        console.log(JSON.stringify({ state: 'MODEL_RELAY_RETRY', request: id, step: transport.step, status: transport.status, waitMs }));
        await delay(waitMs, undefined, { signal: AbortSignal.any([controller.signal, abort.signal]) });
      }
      record.status = upstream.status; response.statusCode = upstream.status;
      response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      response.setHeader('cache-control', 'no-store');
      const returned = []; let bytes = 0;
      for await (const chunk of upstream.body ?? []) {
        bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error('Relay response too large');
        returned.push(Buffer.from(chunk)); if (!response.destroyed) response.write(chunk);
      }
      record.responseBytes = bytes;
      const text = Buffer.concat(returned).toString('utf8');
      const events = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]');
      for (const line of events) try { const data = JSON.parse(line.slice(6)); if (data.usage) record.usage = data.usage; } catch {}
      if (!response.destroyed) response.end();
    } catch (error) {
      record.error = error.name;
      if (!response.headersSent) { response.writeHead(502); response.end('{"error":{"message":"Local model relay failed"}}'); }
      else response.destroy();
    } finally { response.removeListener('close', disconnected); record.endedAt = Date.now(); await saveRelay(); }
  })();
  jobs.add(job); try { await job; } finally { jobs.delete(job); }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
const port = server.address().port;
const probe = spawn('docker', ['run', '--rm', 'python:3.11-slim', 'python3', '-c',
  `import urllib.request; assert urllib.request.urlopen('http://host.docker.internal:${port}/health',timeout=10).read()==b'ok'`],
  { stdio: 'inherit' });
const probeExit = await new Promise((resolve, reject) => { probe.once('error', reject); probe.once('exit', resolve); });
if (probeExit !== 0) { await new Promise(resolve => server.close(resolve)); throw new Error('Container cannot reach the local model relay'); }
console.log(JSON.stringify({ state: 'MODEL_RELAY_REACHABLE', paidRequests: 0 }));
const name = `rc-skill-${manifest.task}-${attempt}`;
const command = ['run', '-i', '--platform', 'linux/amd64', '--name', name, '--cpus', '2', '--memory', '8g',
  '--mount', 'type=volume,source=rc-harbor-pilot-20261031-d9e5e15a04-nvm,target=/root/.nvm,readonly',
  '--mount', `type=bind,source=${root}/runner-source,target=/opt/rc-source,readonly`,
  '--mount', `type=bind,source=${root}/artifact,target=/opt/rc-artifact,readonly`,
  '--mount', `type=bind,source=${root}/public,target=/input,readonly`,
  '--mount', `type=bind,source=${root}/skill,target=/app/.rc-bench,readonly`,
  '--mount', `type=bind,source=${root}/public/config.yaml,target=/app/.runtime-corrector/config.yaml,readonly`, '--mount', `type=bind,source=${run},target=/run`,
  '-e', `RC_EVAL_NATIVE_MODEL=${model}`, '-e', `RC_EVAL_BASE_URL=http://host.docker.internal:${port}/v1`,
  '-e', `RC_EVAL_FORMAT_REPAIRS=${manifest.formatRepairAttempts ?? 20}`,
  '--entrypoint', '/root/.nvm/versions/node/v22.23.4/bin/node', image,
  '/opt/rc-source/scripts/evaluate-native-skill-benchmark.mjs', '--host-root', '/root/.nvm/versions/node/v22.23.4/lib/node_modules/openclaw',
  '--artifact', '/opt/rc-artifact', '--base-commit', manifest.baseCommit, '--instruction', '/input/instruction.md',
  '--timeout-ms', String(runtimeMs), '--max-steps', String(manifest.maxSteps), ...(resumeFrom ? ['--resume'] : [])];
await fs.writeFile(path.join(run, 'launch.json'), JSON.stringify({ command: ['docker', ...command],
  disposableTokenPersisted: false, accountKeyPassedToContainer: false, startedAt: Date.now(), resumeFrom, runtimeMs, image }, null, 2));
const child = spawn('docker', command, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(JSON.stringify({ apiKey: token }));
const log = await fs.open(path.join(run, 'console.log'), 'wx');
let writes = Promise.resolve();
const print = chunk => { writes = writes.then(() => log.appendFile(chunk)); process.stdout.write(chunk); };
child.stdout.on('data', print); child.stderr.on('data', print);
const stop = () => { controller.abort(); try { execFileSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore', timeout: 20000 }); } catch {} };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const watchdog = setTimeout(stop, runtimeMs + 120000); watchdog.unref();
let exitCode;
try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
finally {
  clearTimeout(watchdog); process.off('SIGINT', stop); process.off('SIGTERM', stop); controller.abort();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...jobs]);
  await saveRelay(); await writes; await log.close();
}
try { execFileSync('docker', ['cp', `${name}:/app/.runtime-correction`, path.join(run, 'project-evidence')], { timeout: 60000, stdio: 'ignore' }); }
catch { await fs.writeFile(path.join(run, 'project-evidence-missing.json'), JSON.stringify({ container: name, missing: true })); }
const evidence = await fs.readFile(path.join(run, 'skill-evidence.json'), 'utf8').then(JSON.parse, () => null);
const nativeResult = await fs.readFile(path.join(run, 'result.json'), 'utf8').then(JSON.parse, () => null);
const admissionIds = Object.values(nativeResult?.ledger?.admissions ?? {}).filter(a => a.accounting === 'USED').map(a => a.id);
const findings = (evidence?.evaluations ?? []).flatMap(e => e.review?.findings ?? []);
const delivery = [];
for (const record of records) if (record.status === 200) {
  const payload = await fs.readFile(path.join(hostRequests, `request-${record.id}.json`), 'utf8').then(JSON.parse, () => null);
  if (payload) delivery.push(...unifiedSkillFeedbackReceipts({ payload, graph: evidence?.graph, findings, admissionIds, request: record.id }));
}
await fs.writeFile(path.join(run, 'skill-feedback-delivery.json'), JSON.stringify({ source: 'Actual outbound business-model payloads, graph findings and USED native admissions',
  admissionIds, findings: findings.length, receipts: delivery, corrections: nativeResult?.corrections ?? 0,
  authenticatedDelivery: admissionIds.length ? delivery.length > 0 : null }, null, 2));
await fs.writeFile(path.join(run, 'process-exit.json'), JSON.stringify({ exitCode, closedAt: Date.now(), relayClosed: true }, null, 2));
console.log(JSON.stringify({ state: 'BENCHMARK_CONTROLLER_CLOSED', exitCode, output: run }));
process.exit(exitCode ?? 1);
