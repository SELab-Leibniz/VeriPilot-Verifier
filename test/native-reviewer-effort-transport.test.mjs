import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createNativeStopEvaluation } from '../scripts/helpers/native-stop-evaluation.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { refreshRuntimeRequirements } from '../lib/runtime-v2/orchestrator.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';

async function capture(root, hostRoot, effort) {
  assert(path.isAbsolute(root) && path.isAbsolute(hostRoot) && ['off', 'low'].includes(effort));
  await fs.mkdir(root);
  const projectRoot = path.join(root, 'workspace'); await fs.mkdir(projectRoot);
  const transcript = path.join(projectRoot, 'conversation.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'U1', message: { role: 'user', content: 'Implement a local numeric validator.' } }) + '\n');
  await ensureTask({ projectRoot, sessionId: 'wire-contract' });
  const controller = new AbortController(), requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ thinking: payload.thinking, reasoningEffort: payload.reasoning_effort,
      maxTokens: payload.max_completion_tokens ?? payload.max_tokens });
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Local transport contract complete.' } }));
    controller.abort(Object.assign(new Error('Local transport controls captured'), { code: 'RC_WIRE_CAPTURED' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.RC_LOCAL_EFFORT_CONTRACT_KEY = 'local-contract-placeholder';
  let native;
  try {
    native = await createNativeStopEvaluation({ hostRoot, sourceRoot: process.cwd(), projectRoot,
      outputRoot: root, stateRoot: path.join(root, 'profile'), fixtureFence: { projectRoot }, standaloneBaseline: true,
      providerTimeoutMs: 10000, baselineLimits: { timeoutMs: 60000, maxSteps: 20, maxRepairs: 3 },
      provider: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'deepseek-v4.1-flash',
        credentialEnv: 'RC_LOCAL_EFFORT_CONTRACT_KEY', modelSettings: { id: 'deepseek-v4.1-flash', reasoning: true, contextWindow: 204800, maxTokens: 65536,
          compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportedReasoningEfforts: ['low', 'medium', 'high'] } } },
      providerCredential: process.env.RC_LOCAL_EFFORT_CONTRACT_KEY });
    const reviewer = { session: 'detached', model: native.modelRef, effort, timeoutMs: 60000, formatRepairAttempts: 3, maxOutputTokens: 32768 };
    const failure = await refreshRuntimeRequirements({ projectRoot,
      input: { cwd: projectRoot, session_id: 'wire-contract', transcript_path: transcript, hook_event_id: `wire-${effort}` },
      plan: { runtimeV2: compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: true, materialRoots: [] },
        reviewers: { groundTruthExtractor: reviewer }, skillCorrection: { enabled: false }, artifactCorrection: { groundTruthReviewEnabled: false }, stopCorrection: { enabled: false } }),
        artifacts: [], configuredArtifacts: [] }, reviewerFactory: native.run,
      assessmentContext: { deadlineAt: Date.now() + 60000, abortSignal: controller.signal } }).then(() => null, error => error);
    if (requests.length !== 1) throw failure ?? new Error('Expected one local native request');
    assert(failure, 'The local control-only response must not publish a baseline');
    const result = JSON.stringify({ effort, requests: requests.length, businessInvocations: native.metrics().businessInvocations, ...requests[0] });
    await new Promise((resolve, reject) => process.stdout.write(`${result}\n`, error => error ? reject(error) : resolve()));
  } finally {
    await native?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[2] === '--wire-fixture') {
  await capture(...process.argv.slice(3));
  // Only a loopback transport probe: shut down its private host after the
  // captured controls are flushed, without waiting for unrelated host timers.
  process.exit(0);
}
else test('pinned native baseline transport preserves declared DeepSeek low/off controls',
  { skip: !process.env.RC_OPENCLAW_HOST_ROOT && 'Set RC_OPENCLAW_HOST_ROOT to run the pinned host transport contract.' }, async t => {
    const temporary = await fs.realpath(os.tmpdir());
    const root = await fs.realpath(await fs.mkdtemp(path.join(temporary, 'rc-reviewer-wire-')));
    t.after(async () => {
      assert(root.startsWith(path.join(temporary, 'rc-reviewer-wire-')));
      await fs.rm(root, { recursive: true, force: true });
    });
    for (const effort of ['off', 'low']) {
      // The native SDK owns its SQLite and transcript handles until process exit.
      const { stdout } = await promisify(execFile)(process.execPath,
        [fileURLToPath(import.meta.url), '--wire-fixture', path.join(root, effort), process.env.RC_OPENCLAW_HOST_ROOT, effort],
        { cwd: process.cwd(), timeout: 90000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const observed = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(observed.effort, effort); assert.equal(observed.requests, 1); assert.equal(observed.businessInvocations, 0);
      assert.equal(observed.thinking?.type, effort === 'off' ? 'disabled' : 'enabled');
      if (effort === 'low') assert.equal(observed.reasoningEffort, 'low');
      assert.equal(observed.maxTokens, 32768);
    }
  });
