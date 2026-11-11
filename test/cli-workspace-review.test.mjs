import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRoleReviewer, STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import * as claude from '../lib/hosts/claude.mjs';
import * as codeagent from '../lib/hosts/codeagent.mjs';
import { stopProtocolFixture } from './helpers/stop-protocol.mjs';
import { createCliReceiptObserver } from '../lib/review-task/cli-task-session.mjs';
import { loadReviewCheckpoint } from '../lib/review-task/history-memory.mjs';
import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';
import { handleRuntimeV2Event } from '../lib/runtime-v2/orchestrator.mjs';
import { withTaskState } from '../lib/runtime-v2/task-store.mjs';

const executable = fileURLToPath(new URL('./helpers/workspace-cli-host.mjs', import.meta.url));
async function fixture(t) {
  const f = await stopProtocolFixture(t, 'findings');
  f.input.request.reviewScope = { kind: 'workspace-stop' }; delete f.input.request.fixedStopClassification;
  const external = path.join(path.dirname(f.root), `external-${path.basename(f.root)}.md`); await fs.writeFile(external, 'The original external reference.\n');
  t.after(() => fs.rm(external, { force: true }));
  const capture = path.join(f.root, 'cli-calls.jsonl');
  const input = { ...f.input, sessionCwd: f.root, schema: STOP_REVIEW_SCHEMA, hostAdapter: claude,
    reviewerRuntime: { executable: process.execPath, argsPrefix: [executable] },
    env: { ...process.env, RUNTIME_CORRECTOR_AGENT_EXECUTABLE: undefined, RC_TEST_CLI_ARTIFACT: f.file,
      RC_TEST_CLI_EXTERNAL: external, RC_TEST_CLI_CAPTURE: capture } };
  return { ...f, external, capture, input };
}

test('CLI Stop rejects legacy scopes before launching or copying any evidence', async t => {
  const f = await fixture(t);
  const before = (await fs.readdir(path.join(f.root, '.runtime-correction'))).sort();
  for (const kind of [undefined, 'classification', 'stop-group', 'metric', 'file-quality', 'findings']) {
    await assert.rejects(startRoleReviewer({ ...f.input, request: { ...f.input.request, reviewScope: { kind } },
      reviewerRuntime: { executable: path.join(f.root, 'must-not-launch.exe') } }), { code: 'STOP_TASK_SCOPE_UNSUPPORTED' });
  }
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(f.root, '.runtime-correction'))).sort(), before);
});

for (const host of [claude, codeagent]) test(`${host.host}: shared Stop uses real MCP tools, original external files and one private CLI session`, async t => {
  const f = await fixture(t); f.input.hostAdapter = host;
  const handle = await startRoleReviewer(f.input);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(handle.sourceCitations[0].path, f.file);
  assert(handle.reviewEvidence.files.includes(f.external));
  const calls = (await fs.readFile(f.capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(calls[0].prior, null);
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
  assert(calls[0].args.includes('--strict-mcp-config'));
  assert(calls[0].args.includes('--system-prompt'));
  assert(!calls[0].args.includes('--fork-session'));
  const checkpoint = await loadReviewCheckpoint(path.join(handle.artifacts, 'review-checkpoint.json'));
  assert(checkpoint.citations.length > 0);
  assert.equal((await fs.readdir(handle.artifacts)).some(name => name.startsWith('cli-mcp-')), false);
  await handle.close();
});

test('CLI compact flow selects scope with its checklist and settles the last item without extra model round trips', async t => {
  const f = await fixture(t); f.input.env.RC_TEST_CLI_MODE = 'compact';
  const handle = await startRoleReviewer(f.input);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'PASS');
  assert.equal(handle.collection, undefined);
  const stream = await fs.readFile(path.join(handle.artifacts, 'cli-stream-1.jsonl'), 'utf8');
  const tools = stream.trim().split('\n').map(JSON.parse).filter(frame => frame.type === 'assistant')
    .flatMap(frame => frame.message.content.filter(block => block.type === 'tool_use').map(block => block.name));
  assert(tools.includes('mcp__rc_stop__review_checklist')); assert(tools.includes('mcp__rc_stop__submit_review'));
  assert(!tools.includes('mcp__rc_stop__review_scope')); assert(!tools.includes('mcp__rc_stop__finish_stop_review'));
  assert.equal((await fs.readFile(f.capture, 'utf8')).trim().split('\n').length, 1);
  await handle.close();
});

for (const mode of ['truncate', 'unobserved']) test(`CLI ${mode} tool output cannot certify PASS even after MCP execution`, async t => {
  const f = await fixture(t); f.input.env.RC_TEST_CLI_MODE = mode;
  const handle = await startRoleReviewer(f.input);
  assert.equal(handle.result.metricObjectJudgements[0].judgement, 'UNVERIFIED');
  assert.equal(handle.sourceCitations.length, 0); await handle.close();
});

test('CLI continuation resumes the same private session, checklist and notes without rereading unchanged basis', async t => {
  const f = await fixture(t); f.input.env.RC_TEST_CLI_MODE = 'resume';
  f.input.request.population.metrics.M01.push({ ...f.input.request.population.metrics.M01[0], objectId: 'M01:R2' });
  const handle = await startRoleReviewer(f.input);
  const calls = (await fs.readFile(f.capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2); assert.equal(calls[1].prior, calls[0].sessionId); assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.equal(handle.result.metricObjectJudgements.length, 2);
  assert(handle.result.metricObjectJudgements.every(row => row.judgement === 'PASS'));
});

test('CLI cancellation terminates the owned process and rejects late review results', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.input.env.RC_TEST_CLI_MODE = 'hang'; f.input.abortSignal = controller.signal;
  const rejected = assert.rejects(startRoleReviewer(f.input), /closed|complete|replaced|cancel/i); void rejected.catch(() => {});
  try {
    let call; const readyDeadline = Date.now() + 5000;
    while (!call && Date.now() < readyDeadline) {
      try { call = JSON.parse((await fs.readFile(f.capture, 'utf8')).trim()); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!call) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(call && Number.isInteger(call.pid) && Number.isInteger(call.bridgePid), 'The owned CLI and MCP bridge must actually start.');
    controller.abort(new Error('Input replaced')); await rejected;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const stopDeadline = Date.now() + 2000;
    while ((alive(call.pid) || alive(call.bridgePid)) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(call.pid), false, 'The actual owned CLI process must have exited.');
    assert.equal(alive(call.bridgePid), false, 'The actual owned MCP bridge must have exited.');
  } finally { controller.abort(new Error('Input replaced')); await rejected.catch(() => {}); }
});

for (const citeId of ['rccite_abcd', 'C1']) test(`CLI observer rejects replayed, foreign-session and altered source receipts for ${citeId}`, async () => {
  let observations = 0;
  const worker = { isComplete: () => false, onAssistantMessageStart() {}, observeReceipt() { observations++; } };
  const result = { content: [{ type: 'text', text: `[citeId="${citeId}"]\nOriginal exact page` }], details: { citation: { citeId } } };
  const observer = createCliReceiptObserver(worker); observer.expect('internal', { path: 'file' }, result);
  observer.frame({ type: 'system', subtype: 'init', session_id: 'owned' });
  observer.frame({ type: 'assistant', session_id: 'owned', message: { id: 'A', content: [{ type: 'tool_use', id: 'read', name: 'mcp__rc_stop__source_read', input: { path: 'file' } }] } });
  const receipt = { type: 'user', session_id: 'foreign', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: result.content }] } };
  observer.frame(receipt); assert.equal(observations, 0);
  observer.frame({ ...receipt, session_id: 'owned' }); assert.equal(observations, 1);
  observer.frame({ ...receipt, session_id: 'owned' }); assert.equal(observations, 1);
  const altered = createCliReceiptObserver(worker);
  altered.expect('internal-2', { path: 'file' }, result);
  altered.frame({ type: 'system', subtype: 'init', session_id: 'owned' });
  altered.frame({ type: 'assistant', session_id: 'owned', message: { id: 'A', content: [{ type: 'tool_use', id: 'read', name: 'mcp__rc_stop__source_read', input: { path: 'file' } }] } });
  altered.frame({ ...receipt, session_id: 'owned', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: result.content[0].text.split('\n')[0] }] }] } });
  assert.equal(observations, 1);
});

test('automatic CLI Stop selects the shared default engine and settles one session through the production entry', async t => {
  const f = await fixture(t), transcript = path.join(f.root, 'host.jsonl');
  f.input.evidence.snapshot.entries.push({ type: 'assistant', uuid: 'complete', message: { content: 'The task is complete.' } });
  await fs.writeFile(transcript, f.input.evidence.snapshot.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await withTaskState({ projectRoot: f.root, taskId: f.task.taskId }, state => { state.groundTruth.version = 1; state.groundTruth.digest = f.input.evidence.groundTruth.digest; });
  const metrics = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`M${String(index + 1).padStart(2, '0')}`, index === 0]));
  const runtimeV2 = compileRuntimeV2Config({ version: 2, dynamicGroundTruth: { enabled: false }, skillCorrection: { enabled: false },
    artifactCorrection: { groundTruthReviewEnabled: false }, implementationCorrection: { enabled: false, platform: null }, stopCorrection: { enabled: true, metrics } });
  const artifacts = [{ nodeId: 'spec', stage: 'design', patterns: ['spec.md'], metrics: ['M01'] }];
  const options = { projectRoot: f.root, plan: { runtimeV2, artifacts, configuredArtifacts: artifacts, reviewerRuntime: f.input.reviewerRuntime },
    env: f.input.env, stopHost: { directory: path.join(f.root, 'host-state') } };
  await handleRuntimeV2Event({ ...options, input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: 'SessionStart', source: 'startup' } });
  const outcome = await handleRuntimeV2Event({ ...options, input: { session_id: 'protocol-host', cwd: f.root, transcript_path: transcript, hook_event_name: 'Stop', last_assistant_message: 'The task is complete.' } });
  assert.equal(outcome.stop.status, 'PASS', JSON.stringify(outcome.stop));
  const calls = (await fs.readFile(f.capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].args[0]).task.scope, 'workspace-stop');
});
