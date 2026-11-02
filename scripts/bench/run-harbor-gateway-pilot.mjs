// RC-owned launcher. The upstream credential stays in this process; Harbor and
// Docker receive only phase-scoped disposable capabilities. No grader edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarborProviderRelay, codingPlanRelayUpstream } from '../helpers/harbor-provider-relay.mjs';
import { createHarborSetupProxy } from '../helpers/harbor-setup-proxy.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const same = (left, right) => Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const write = async (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
};

async function checkSelectedOnBinding(manifest) {
  const invalid = () => { throw failure('PILOT_SELECTED_ON_BINDING_INVALID'); };
  const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const isId = value => typeof value === 'string' && value.trim().length > 0;
  const readPinnedJson = async file => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !Object.hasOwn(manifest.sourceHashes, file)
      || !isSha(manifest.sourceHashes[file])) invalid();
    const bytes = await fs.readFile(file), sha256 = digest(bytes);
    if (sha256 !== manifest.sourceHashes[file]) throw failure('PILOT_FROZEN_INPUT_CHANGED');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    return { value, sha256 };
  };
  const instanceId = manifest.instanceId, marker = manifest.diagnosticExecution;
  if (!isId(instanceId) || manifest.agentKwargs?.rc_instance_id !== instanceId) invalid();
  const { value: binding } = await readPinnedJson(marker.rootBindingPath);
  const { value: bank, sha256: bankSha256 } = await readPinnedJson(marker.bankFreezePath);
  if (binding.kind !== 'rc-selected-on-binding-v1' || binding.onAuthorized !== true
    || binding.instanceId !== instanceId || bank.kind !== 'rc-stage-comparison-bank-v1'
    || bank.comparisonBindingsFrozen !== true || !Array.isArray(bank.members) || !bank.members.length
    || !isSha(binding.bankFreezeSha256) || binding.bankFreezeSha256 !== bankSha256
    || !isSha(binding.effectiveBusinessConditionsSha256) || !isSha(binding.offOfficialAcceptanceSha256)) invalid();
  const ids = new Set(); let member;
  for (const candidate of bank.members) {
    if (!candidate || typeof candidate !== 'object' || !isId(candidate.instanceId) || ids.has(candidate.instanceId)
      || !isSha(candidate.effectiveBusinessConditionsSha256) || !isSha(candidate.offOfficialAcceptanceSha256)) invalid();
    ids.add(candidate.instanceId);
    if (candidate.instanceId === instanceId) member = candidate;
  }
  if (!member || member.effectiveBusinessConditionsSha256 !== binding.effectiveBusinessConditionsSha256
    || member.offOfficialAcceptanceSha256 !== binding.offOfficialAcceptanceSha256) invalid();
  const { value: off, sha256: offSha256 } = await readPinnedJson(binding.offOfficialAcceptancePath);
  if (offSha256 !== binding.offOfficialAcceptanceSha256 || off.instanceId !== instanceId
    || !['VALID_OFF_RESOLVED', 'VALID_OFF_UNRESOLVED'].includes(off.rootOfficialEligibility)) invalid();
  // Root adjudicates cohort completeness and effective conditions. This guard
  // checks the pinned declarations, not model/host/scorer equivalence.
}

export function pilotAgentImport(manifest) {
  const selected = manifest.agentImportPath ?? 'scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw';
  if (!['scripts.bench.harbor_rc_gateway:RcGatewayOpenClaw',
    'scripts.bench.swebench_lite_gateway:SweBenchLiteGatewayOpenClaw'].includes(selected))
    throw failure('PILOT_AGENT_IMPORT_INVALID');
  if (selected.includes('swebench_lite_gateway')) {
    const options = manifest.agentKwargs ?? {};
    if (!/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-[0-9]+$/u.test(options.rc_instance_id ?? '')
      || !/^[a-f0-9]{40}$/u.test(options.rc_base_commit ?? '')
      || !/^[a-f0-9]{64}$/u.test(options.rc_problem_statement_sha256 ?? '')
      || options.rc_conda_environment !== 'testbed') throw failure('PILOT_LITE_IDENTITY_INVALID');
  }
  return selected;
}

export async function createPilotPhaseController({ officialWallMs, rcEnabled, limits, upstream,
  onRecord = async () => {}, onPhaseStart = async () => {}, now = Date.now, setupWaitMs = 2400000, model = 'glm-5.3' }) {
  if (!Number.isSafeInteger(officialWallMs) || officialWallMs < 1000 || typeof rcEnabled !== 'boolean'
    || !Number.isSafeInteger(setupWaitMs) || setupWaitMs < 1000) throw failure('PILOT_PHASE_ARGUMENTS_INVALID');
  const capability = `rc-control-${randomBytes(32).toString('hex')}`;
  let relay, start, state = 'PREPARED', deadlineTimer, closed = false, relayClosing, controllerClosing;
  let reports = Promise.resolve();
  const requests = new Set();
  const receipt = () => {
    const value = relay?.snapshot();
    return value ? { ...value, relayInternalDeadlineAt: value.deadlineAt, deadlineAt: start.deadlineAt,
      phaseStartedAt: start.phaseStartedAt, officialWallMs, rcEnabled, controllerState: state }
      : { controllerState: state, providerStarted: false, rcEnabled };
  };
  const report = () => {
    const snapshot = receipt();
    reports = reports.then(() => onRecord(snapshot)); return reports;
  };
  const closeRelay = () => relayClosing ??= relay?.close();
  const expire = async () => {
    if (state === 'ACTIVE') state = 'DEADLINE_EXPIRED';
    await closeRelay(); await report();
  };
  const setupTimer = setTimeout(() => { if (state === 'PREPARED') state = 'SETUP_EXPIRED'; }, setupWaitMs);
  setupTimer.unref?.();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/start'
      || !same(request.headers.authorization ?? '', `Bearer ${capability}`)) {
      response.writeHead(403); response.end(); return;
    }
    if (state !== 'PREPARED' || closed) { response.writeHead(409); response.end(); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw failure('PILOT_START_BODY_LIMIT'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const receivedAt = now();
      if (!Number.isSafeInteger(value.phaseStartedAt) || value.phaseStartedAt > receivedAt
        || receivedAt - value.phaseStartedAt > 10000 || value.officialWallMs !== officialWallMs
        || value.rcEnabled !== rcEnabled) throw failure('PILOT_PHASE_IDENTITY_MISMATCH');
      // Lock before awaiting relay creation: concurrent starts cannot renew it.
      if (state !== 'PREPARED') { response.writeHead(409); response.end(); return; }
      state = 'STARTING'; clearTimeout(setupTimer);
      start = { phaseStartedAt: value.phaseStartedAt, deadlineAt: value.phaseStartedAt + officialWallMs };
      await onPhaseStart();
      const remaining = start.deadlineAt - now();
      if (remaining <= 0) throw failure('PILOT_PHASE_ALREADY_EXPIRED');
      relay = await createHarborProviderRelay({ limits: { ...limits, wallMs: remaining },
        model,
        payloadBytes: limits.payloadBytes ?? 524288, bind: '0.0.0.0', advertisedHost: 'host.docker.internal',
        upstream: args => {
          if (state !== 'ACTIVE' || now() >= start.deadlineAt) throw failure('PILOT_OFFICIAL_DEADLINE');
          return upstream(args);
        }, onRecord: async () => report() });
      if (closed || state !== 'STARTING') { await relay.close(); throw failure('PILOT_START_CANCELLED'); }
      state = 'ACTIVE';
      deadlineTimer = setTimeout(() => { expire().catch(() => {}); }, Math.max(0, start.deadlineAt - now()));
      deadlineTimer.unref?.();
      await report();
      const ticket = { ...relay.ticket(), deadlineAt: start.deadlineAt, officialWallMs };
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(ticket));
    } catch (error) {
      if (state === 'STARTING' || state === 'ACTIVE') { state = 'START_FAILED'; await closeRelay(); }
      if (!response.headersSent) { response.writeHead(400); response.end(JSON.stringify({ error: typeof error.code === 'string' ? error.code : 'PILOT_START_INVALID' })); }
      else response.destroy();
    }
  });
  server.on('connection', socket => { requests.add(socket); socket.once('close', () => requests.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    descriptor: () => ({ kind: 'rc-harbor-controller-v1', startUrl: `http://127.0.0.1:${server.address().port}/start`, controlToken: capability }),
    receipt,
    close() {
      return controllerClosing ??= (async () => {
        closed = true; clearTimeout(setupTimer); clearTimeout(deadlineTimer);
        for (const socket of requests) socket.destroy();
        await new Promise(resolve => server.close(resolve)); await closeRelay();
        if (!['DEADLINE_EXPIRED', 'START_FAILED', 'SETUP_EXPIRED'].includes(state)) state = 'CLOSED';
        await report();
      })();
    },
  };
}

export function recordingUpstream(credential, output, { fetchImpl } = {}) {
  const upstream = codingPlanRelayUpstream(credential, { fetchImpl }), secret = Buffer.from(credential); let sequence = 0;
  return async args => {
    const n = ++sequence;
    if (args.body.includes(Buffer.from(credential))) throw failure('PILOT_AUTH_IN_BODY');
    await fs.writeFile(path.join(output, `request-${n}.json`), args.body, { flag: 'wx', mode: 0o600 });
    const response = await upstream(args);
    if (!response.body) return response;
    const reader = response.body.getReader(), chunks = []; let bytes = 0, finished = false, pending = Buffer.alloc(0);
    const save = async complete => {
      if (finished) return; finished = true;
      const raw = Buffer.concat(chunks), stored = Buffer.from(raw.toString('utf8').split(credential).join('[REDACTED_UPSTREAM_AUTH]'));
      await fs.writeFile(path.join(output, `response-${n}.${complete ? 'body' : 'partial'}`), stored, { flag: 'wx', mode: 0o600 });
      await write(path.join(output, `response-${n}.metadata.json`), { request: n, httpStatus: response.status,
        sourceSha256: digest(raw), storedSha256: digest(stored), credentialRedacted: !raw.equals(stored), complete });
    };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              await save(true); if (pending.length) controller.enqueue(pending); controller.close(); return;
            }
            bytes += next.value.length;
            if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw failure('PILOT_RESPONSE_CAPTURE_LIMIT'); }
            chunks.push(Buffer.from(next.value));
            const joined = Buffer.concat([pending, next.value]);
            if (joined.includes(secret)) { await reader.cancel(); throw failure('PILOT_UPSTREAM_AUTH_REFLECTION'); }
            // Retain enough bytes to detect a key split across any stream boundary
            // before its complete plaintext could reach the task container.
            const ready = Math.max(0, joined.length - secret.length + 1);
            pending = Buffer.from(joined.subarray(ready));
            if (ready) { controller.enqueue(joined.subarray(0, ready)); return; }
          }
        } catch (error) { await save(false); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await save(false); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function command(executable, args, { cwd, env, log, timeoutMs, signal }) {
  signal?.throwIfAborted();
  const handle = await fs.open(log, 'wx', 0o600);
  try {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', handle.fd, handle.fd], detached: true });
    let timedOut = false, force;
    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      force ??= setTimeout(() => { if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 15000);
      force.unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); timer.unref?.();
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    const cleanup = () => { clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', kill); };
    return await new Promise((resolve, reject) => {
      child.once('error', error => { cleanup(); reject(error); });
      child.once('exit', (code, exitSignal) => { cleanup(); resolve({ code, signal: exitSignal, timedOut, interrupted: signal?.aborted ?? false }); });
    });
  } finally { await handle.close(); }
}

export async function runHarborGatewayPilot({ manifestPath, output, credential, signal }) {
  signal?.throwIfAborted();
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const agentImportPath = pilotAgentImport(manifest);
  const marked = Object.hasOwn(manifest, 'diagnosticExecution');
  const baselineExperiment = manifest.baselineExperiment?.kind === 'baseline-e2e-v1'
    && manifest.agentKwargs?.rc_policy_profile === 'baseline';
  const validArms = baselineExperiment ? JSON.stringify(manifest.arms) === JSON.stringify(['on']) : marked
    ? (manifest.diagnosticExecution?.kind === 'selected-arm-v1' && JSON.stringify(manifest.arms) === JSON.stringify(['off']))
      || (manifest.diagnosticExecution?.kind === 'selected-on-v1' && JSON.stringify(manifest.arms) === JSON.stringify(['on']))
    : JSON.stringify(manifest.arms) === JSON.stringify(['off', 'on']);
  if (manifest.kind !== 'rc-harbor-development-pilot-v1' || manifest.qualificationAccepted !== true
    || !['openai/glm-5.3', ...(baselineExperiment ? ['openai/glm-5.3-flash'] : [])].includes(manifest.model)
    || Object.hasOwn(manifest, 'baselineExperiment') && !baselineExperiment
    || manifest.frameworkCommit !== '58789aad577f432a4590209a8fd901f8c894f382'
    || !validArms
    || !Number.isSafeInteger(manifest.officialWallMs) || manifest.officialWallMs < 1000
    || !Number.isSafeInteger(manifest.armOuterWallMs) || manifest.armOuterWallMs < manifest.officialWallMs
    || !path.isAbsolute(manifest.sourceRoot ?? '') || !path.isAbsolute(manifest.taskPath ?? '')
    || !path.isAbsolute(manifest.harborExecutable ?? '') || !manifest.sourceHashes || !Object.keys(manifest.sourceHashes).length
    || typeof credential !== 'string' || !credential.trim()
    || !Number.isSafeInteger(manifest.priorRequests) || manifest.priorRequests < 0
    || !Number.isFinite(manifest.priorConservativeReferenceUsd) || manifest.priorConservativeReferenceUsd < 0
    || !/^sha256:[a-f0-9]{64}$/u.test(manifest.image?.id ?? '') || typeof manifest.image?.ref !== 'string')
    throw failure('PILOT_FROZEN_MANIFEST_INVALID');
  for (const target of ['/root/.nvm', '/root/.npm']) {
    const off = manifest.armInstallCacheMounts?.off?.filter(mount => mount.target === target);
    const on = manifest.armInstallCacheMounts?.on?.filter(mount => mount.target === target);
    if ((!baselineExperiment && (off?.length !== 1 || off[0].type !== 'volume' || typeof off[0].source !== 'string' || off[0].source === on?.[0]?.source))
      || on?.length !== 1 || on[0].type !== 'volume' || typeof on[0].source !== 'string'
      || manifest.environment?.mounts?.some(mount => mount.target === target)) throw failure('PILOT_INDEPENDENT_INSTALL_CACHES_REQUIRED');
  }
  const checkPins = async () => {
    for (const [file, expected] of Object.entries(manifest.sourceHashes))
      if (!path.isAbsolute(file) || digest(await fs.readFile(file)) !== expected) throw failure('PILOT_FROZEN_INPUT_CHANGED');
  };
  const checkImage = async () => {
    const { stdout } = await promisify(execFile)('docker', ['image', 'inspect', manifest.image.ref, '--format', '{{.Id}}'], { timeout: 10000 });
    if (stdout.trim() !== manifest.image.id) throw failure('PILOT_OFFICIAL_IMAGE_CHANGED');
  };
  await checkPins();
  if (manifest.diagnosticExecution?.kind === 'selected-on-v1') await checkSelectedOnBinding(manifest);
  await checkImage(); await fs.mkdir(output);
  await write(path.join(output, 'launch.json'), { manifestSha256: digest(await fs.readFile(manifestPath)), launchedAt: Date.now(),
    priorRequests: manifest.priorRequests, priorConservativeReferenceUsd: manifest.priorConservativeReferenceUsd,
    credentialPersisted: false, officialScoreModified: false });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL/u.test(key)));
  env.PYTHONDONTWRITEBYTECODE = '1'; env.PYTHONPATH = manifest.sourceRoot; env.TMPDIR = '/private/tmp';
  const results = [];
  for (const arm of manifest.arms) {
    signal?.throwIfAborted();
    await checkPins(); await checkImage();
    const root = path.join(output, arm); await fs.mkdir(root);
    // This directory is a sibling of jobs/, so Harbor's /logs/agent mount
    // cannot reveal the controller descriptor to the task container.
    const control = path.join(root, 'external-controller'); await fs.mkdir(control, { mode: 0o700 });
    const descriptor = path.join(control, 'descriptor.json'), receipt = path.join(control, 'receipt.json');
    const setupProxy = manifest.setupProxy === true ? await createHarborSetupProxy({
      onRecord: value => write(path.join(control, 'setup-proxy.json'), value) }) : null;
    let phase;
    try {
      phase = await createPilotPhaseController({ officialWallMs: manifest.officialWallMs, rcEnabled: arm === 'on',
        model: manifest.model.slice('openai/'.length),
        limits: manifest.limits, upstream: recordingUpstream(credential, control), onRecord: value => write(receipt, value),
        onPhaseStart: async () => { await setupProxy?.close(); } });
    } catch (error) { await setupProxy?.close(); throw error; }
    const cancelPhase = () => { phase.close().catch(() => {}); setupProxy?.close().catch(() => {}); };
    signal?.addEventListener('abort', cancelPhase, { once: true });
    let execution;
    try {
      await write(descriptor, { ...phase.descriptor(), ...(setupProxy ? { setupProxyUrl: setupProxy.url } : {}) });
      const job = { job_name: `rc-development-${arm}`, jobs_dir: path.join(root, 'jobs'), n_attempts: 1,
        n_concurrent_trials: 1, retry: { max_retries: 0 }, timeout_multiplier: 1, quiet: true,
        // Lite receives its score only from the separate official SWE-bench
        // harness after prediction collection; no Harbor surrogate verifier.
        ...(agentImportPath.includes('swebench_lite_gateway') ? { verifier: { disable: true } } : {}),
        environment: { type: 'docker', delete: true, ...manifest.environment,
          mounts: [...(manifest.environment?.mounts ?? []), ...manifest.armInstallCacheMounts[arm]] },
        agents: [{ import_path: agentImportPath, model_name: manifest.model,
          extra_allowed_hosts: ['host.docker.internal'], kwargs: { ...manifest.agentKwargs,
            rc_enabled: arm === 'on', rc_official_wall_ms: manifest.officialWallMs,
            rc_controller_descriptor: descriptor, rc_metering_receipt: receipt } }],
        tasks: [{ path: manifest.taskPath }] };
      const config = path.join(root, 'job.json'); await write(config, job);
      await write(receipt, phase.receipt());
      execution = await command(manifest.harborExecutable, ['run', '--config', config], {
        cwd: manifest.sourceRoot, env, log: path.join(root, 'harbor.log'), timeoutMs: manifest.armOuterWallMs, signal });
    } finally { signal?.removeEventListener('abort', cancelPhase); try { await phase.close(); } finally { await setupProxy?.close(); } }
    await checkPins(); await checkImage();
    const value = { arm, execution, receipt: phase.receipt(), officialScore: agentImportPath.includes('swebench_lite_gateway')
      ? 'Unavailable here; score the frozen prediction with the separate unchanged official SWE-bench harness.'
      : 'Read unchanged official job/trial outputs; this launcher does not assign scores.' };
    results.push(value); await write(path.join(output, 'checkpoint.json'), { arms: results, overallGoalComplete: false });
    console.log(JSON.stringify({ arm, execution, wireDispatchAttempts: value.receipt.wireDispatchAttempts ?? 0,
      requests: value.receipt.budget?.requests ?? 0, halted: value.receipt.budget?.halted ?? null }));
    if (signal?.aborted) break;
    if (!value.receipt.budget || value.receipt.budget.halted || value.receipt.budget.inFlightRequests !== 0
      || value.receipt.wireDispatchAttempts !== value.receipt.budget.requests) break;
  }
  const result = { state: 'PILOT_FINISHED_REQUIRES_INDEPENDENT_OFFICIAL_OUTPUT_AUDIT', arms: results,
    totalWireAttempts: results.reduce((n, arm) => n + (arm.receipt.wireDispatchAttempts ?? 0), 0),
    priorRequests: manifest.priorRequests, actualAccountBill: 'unknown', benchmarkWinClaimed: false, overallGoalComplete: false };
  await write(path.join(output, 'result.json'), result); return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), arg = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  if (!args.includes('--live') || !arg('--manifest') || !arg('--output')) throw failure('Explicit --live --manifest --output required');
  const credential = process.env.RC_HARBOR_UPSTREAM_CREDENTIAL; delete process.env.RC_HARBOR_UPSTREAM_CREDENTIAL;
  if (!credential) throw failure('Transient RC_HARBOR_UPSTREAM_CREDENTIAL required');
  const controller = new AbortController(), interrupt = () => controller.abort(failure('PILOT_INTERRUPTED'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { await runHarborGatewayPilot({ manifestPath: path.resolve(arg('--manifest')), output: path.resolve(arg('--output')), credential, signal: controller.signal }); }
  catch (error) { console.error(JSON.stringify({ code: typeof error.code === 'string' ? error.code : 'PILOT_FAILED' })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
