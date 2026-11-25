// Exercise Stop's authority gate independently of host/model context capacity.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MANDATORY_REFERENCE_BYTES } from '../lib/runtime-v2/original-requirements.mjs';
import { loadStopOriginalRequirements } from '../lib/runtime-v2/production-stop.mjs';
import { STOP_REVIEW_SCHEMA } from '../lib/runtime-v2/reviewer.mjs';
import { ensureTask } from '../lib/runtime-v2/task-store.mjs';
import { sha256 } from '../lib/runtime-v2/utils.mjs';
import { scriptedWorkspaceReview } from '../test/helpers/scripted-workspace-review.mjs';

const hostRoot = process.argv[2] ?? process.env.RC_OPENCLAW_HOST_ROOT;
if (!hostRoot) throw new Error('Pass the bundled OpenClaw installation directory as the first argument.');
const hostPackage = path.join(path.resolve(hostRoot), 'package.json');
const { name: hostName, version: hostVersion } = JSON.parse(await fs.readFile(hostPackage, 'utf8'));
assert.equal(hostName, 'openclaw');
const validationModule = createRequire(hostPackage).resolve('@openclaw/ai/validation');
const { validateToolArguments } = await import(pathToFileURL(validationModule).href);
const outputParent = fileURLToPath(new URL('../.runtime-correction/', import.meta.url));
await fs.mkdir(outputParent, { recursive: true });
const output = await fs.mkdtemp(path.join(outputParent, 'sdd-authority-'));
const coverBytes = 64;
const requirement = 'Sealed mode must return zero retries.';
const authorityBytes = MANDATORY_REFERENCE_BYTES - coverBytes;
const head = 'Release contract. Ordinary mode returns three retries.\n';
const tail = '\n' + requirement + '\n';
const example = '<!-- Illustrative release record. This line carries no new requirements. -->\n';
const padding = authorityBytes - Buffer.byteLength(head + tail);
const contract = head + example.repeat(Math.floor(padding / example.length)) + ' '.repeat(padding % example.length) + tail;
const ruleLine = contract.slice(0, contract.indexOf(requirement)).split('\n').length;
assert.equal(Buffer.byteLength(contract), authorityBytes);
const snapshot = { entries: [{ type: 'user', uuid: 'contract-source', message: { content:
  'Preserve ordinary retry behavior. Implement every release requirement in cover.md and workflow.md.' } }] };
const source = 'export function retryLimit(mode) { return 3; }\n';

function stopInput(root, task, originalRequirements, snapshot, onPrepared) {
  return { projectRoot: root, taskId: task.taskId, role: 'stop-reviewer', schema: STOP_REVIEW_SCHEMA,
    reviewer: { timeoutMs: 60000 }, evidence: { originalRequirements, snapshot,
      groundTruth: { taskId: task.taskId, version: 0, digest: null, claims: [] } },
    request: { reviewScope: { kind: 'workspace-stop', objectIds: [], sourceIds: [] },
      fixedStopClassification: { stopClassification: 'TASK_COMPLETE', stage: null }, workflowStages: [],
      hook: { last_assistant_message: 'Release work complete.' },
      population: { metrics: {}, reviewPolicy: { deviationOnly: true, metrics: { M16: true } } } }, onPrepared };
}
const originalRow = (text, file, line) => ({ metricId: 'M16', verificationTarget: 'IMPLEMENTATION',
  implementationRole: 'PRODUCTION', text, path: file, lineStart: line, lineEnd: line });

async function review({ name, extraByte = false, readPolicy, includeException = false }) {
  const root = path.join(output, name);
  const workflow = path.join(root, 'workflow.md');
  const candidate = path.join(root, 'retry.mjs');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'cover.md'), ' '.repeat(coverBytes + Number(extraByte) - 1) + '\n');
  await fs.writeFile(workflow, contract);
  await fs.writeFile(candidate, source);
  const { retryLimit } = await import(pathToFileURL(candidate).href);
  const oracle = { ordinary: retryLimit('ordinary'), sealed: retryLimit('sealed'), expectedSealed: 0 };
  assert.equal(oracle.ordinary, 3);
  assert.notEqual(oracle.sealed, oracle.expectedSealed);
  const original = await loadStopOriginalRequirements({ projectRoot: root, snapshot, referenceTier: true });
  const named = original.referencedFiles.find(entry => entry.path === 'workflow.md');
  assert.equal(named.sha256, sha256(Buffer.from(contract)));
  const task = await ensureTask({ projectRoot: root, sessionId: 'release' });
  let directory, handle, blocked;
  const checklist = [];
  const input = stopInput(root, task, original, snapshot, ({ requestDirectory }) => { directory = requestDirectory; });

  try {
    handle = await scriptedWorkspaceReview(input, { script: async ({ task: brief, call, read }) => {
      for (const file of brief.basisFiles) {
        if (path.resolve(file) !== workflow || readPolicy === 'all') await read(file);
      }
      const originalUser = brief.basisFiles.find(file => path.basename(file).startsWith('user-original-'));
      checklist.push(originalRow('Preserve ordinary retry behavior.', originalUser, 1));
      if (includeException) {
        const page = await call('source_read', { path: workflow, offset: ruleLine, limit: 1 });
        assert(page.content[0].text.includes(requirement));
        checklist.push(originalRow(requirement, workflow, ruleLine));
      }
      await call('set_original_checklist', { items: checklist });
      const page = await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
      const candidateId = await read(candidate);
      if (includeException) {
        const assigned = JSON.parse(page.content[0].text).items.find(item => item.description === requirement);
        assert(assigned);
        await call('submit_review', { taskId: assigned.taskId, verdict: 'DEVIATION', citeIds: [candidateId],
          reason: 'retryLimit returns three in sealed mode, contradicting the release contract.' });
      }
      await call('finish_stop_review', { summary: 'Scripted Stop authority probe.' });
    } });
  } catch (err) {
    if (err.code !== 'TASK_BASIS_UNREAD') throw err;
    blocked = err.code;
  }
  const entries = (await fs.readFile(path.join(directory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const workflowReceipts = entries.map(entry => entry.message?.details?.citation)
    .filter(citation => citation && path.resolve(citation.path) === workflow);
  const result = { name, authoritySha256: named.sha256, combinedNamedBytes: authorityBytes + coverBytes + Number(extraByte),
    mandatory: named.mandatory !== false, workflowReceipts: workflowReceipts.length,
    tailReceipted: workflowReceipts.some(page => page.start <= ruleLine && page.end >= ruleLine),
    attemptedChecklistSize: checklist.length, completed: handle?.reviewCompleted ?? false, blocked: blocked ?? null,
    dispositions: (handle?.result.reviewCoverage?.items ?? []).map(item => item.disposition),
    oracle, reviewDirectory: path.relative(output, directory).replaceAll('\\', '/') };
  await handle?.close();
  return result;
}

async function checkUnboundManifest() {
  const root = path.join(output, 'large-unbound');
  await fs.mkdir(root);
  const file = path.join(root, 'workflow.md');
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
  const versions = [];
  for (const lastByte of ['3', '0']) {
    bytes[bytes.length - 1] = lastByte.charCodeAt(0);
    await fs.writeFile(file, bytes);
    const manifest = await loadStopOriginalRequirements({ projectRoot: root, snapshot, referenceTier: true });
    const named = manifest.referencedFiles.find(entry => entry.path === 'workflow.md');
    versions.push({ trueSha256: sha256(bytes), manifestSha256: named.sha256, bytes: named.bytes, digest: manifest.digest });
  }
  assert.notEqual(versions[0].trueSha256, versions[1].trueSha256);
  assert.equal(versions[0].digest, versions[1].digest);
  assert(versions.every(version => version.manifestSha256 === null));
  return versions;
}

async function checkChecklistCapacity() {
  const root = path.join(output, 'many-obligations');
  const file = path.join(root, 'codes.md');
  await fs.mkdir(root);
  const rules = Array.from({ length: 257 }, (_, i) => 'For input ' + i + ', return status S' + i + '.');
  await fs.writeFile(file, rules.join('\n') + '\n');
  const snap = { entries: [{ type: 'user', uuid: 'codes', message: { content: 'Implement each requirement in codes.md.' } }] };
  const original = await loadStopOriginalRequirements({ projectRoot: root, snapshot: snap });
  const task = await ensureTask({ projectRoot: root, sessionId: 'capacity' });
  const attempts = [];
  const handle = await scriptedWorkspaceReview(stopInput(root, task, original, snap), { script: async ({ worker, task: brief, call, read }) => {
    for (const basis of brief.basisFiles) await read(basis);
    const rows = rules.map((rule, i) => originalRow(rule, file, i + 1));
    const tool = worker.tools.find(entry => entry.name === 'set_original_checklist');
    for (const items of [rows, rows.slice(0, 256), rows.slice(256)]) {
      let args;
      try {
        args = validateToolArguments(tool, { name: tool.name, arguments: { items } });
      } catch (err) {
        if (!err.message.includes('Validation failed for tool')) throw err;
        attempts.push({ count: items.length, code: 'HOST_ARGUMENT_VALIDATION', reason: err.message.split('\n\n')[0] });
        continue;
      }
      try {
        const result = JSON.parse((await call(tool.name, args)).content[0].text);
        attempts.push({ count: items.length, saved: result.saved, accepted: result.items });
      } catch (err) {
        if (!['TASK_SUBMISSION_INVALID', 'TASK_SUBMISSION_CONFLICT'].includes(err.code)) throw err;
        attempts.push({ count: items.length, code: err.code, reason: err.message });
      }
    }
    await call('review_checklist', { stopClassification: 'TASK_COMPLETE', completionClaim: true });
    await call('finish_stop_review', { summary: 'List-capacity control.' });
  } });
  assert.equal(attempts[0].code, 'HOST_ARGUMENT_VALIDATION');
  assert.equal(attempts[1].accepted, 256);
  assert.equal(attempts[2].code, 'TASK_SUBMISSION_CONFLICT');
  assert.equal(handle.result.reviewCoverage.total, 256);
  await handle.close();
  return { hostVersion, requirements: rules.length, sourceBytes: (await fs.stat(file)).size, attempts };
}

const runs = [];
for (const spec of [
  { name: 'at-budget-skip', readPolicy: 'skip' },
  { name: 'above-budget-skip', extraByte: true, readPolicy: 'skip' },
  { name: 'at-budget-all-omit-rule', readPolicy: 'all' },
  { name: 'above-budget-cite-tail', extraByte: true, readPolicy: 'tail', includeException: true },
]) runs.push(await review(spec));
const [at, above, full, targeted] = runs;
assert(runs.every(run => run.authoritySha256 === at.authoritySha256));
assert(at.mandatory && !at.completed && at.blocked === 'TASK_BASIS_UNREAD');
assert(!above.mandatory && above.completed && above.workflowReceipts === 0);
assert.deepEqual(above.dispositions, ['NO_CONFIRMED_DEVIATION']);
assert(full.mandatory && full.completed && full.tailReceipted);
assert.deepEqual(full.dispositions, above.dispositions);
assert(!targeted.mandatory && targeted.completed && targeted.workflowReceipts === 1 && targeted.tailReceipted);
assert(targeted.dispositions.includes('DEVIATION'));
const report = { layer: 'Production Stop tools and receipt validation with a scripted in-process reviewer.', ruleLine,
  runs, unboundVersions: await checkUnboundManifest(), checklistCapacity: await checkChecklistCapacity() };
const target = path.join(output, 'result.json');
await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: target, runs: runs.map(({name, completed, blocked, dispositions}) =>
  ({name, completed, blocked, dispositions})) }, null, 2));
