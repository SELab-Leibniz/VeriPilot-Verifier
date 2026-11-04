import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { documentRunOptions, invokeDocumentCli } from '../scripts/helpers/document-cli.mjs';
import { runDocumentE2E } from '../scripts/evaluate-document-e2e.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'document-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('document budgets accept wider explicit settings and reject invalid or misspelled settings', () => {
  const config = documentRunOptions({ reviewTimeoutMs: 1200000, repairTimeoutMs: 900000, totalTimeoutMs: 3600000 });
  assert.equal(config.reviewTimeoutMs, 1200000); assert.equal(config.repairTimeoutMs, 900000);
  assert.equal(config.totalTimeoutMs, 3600000);
  for (const value of [0, -1, 999, 86400001, '600000', NaN])
    assert.throws(() => documentRunOptions({ reviewTimeoutMs: value }), /reviewTimeoutMs/);
  assert.throws(() => documentRunOptions({ reviewTimoutMs: 600000 }), /Unknown/);
});

test('a timed-out CLI is terminated, records output, and never becomes a passing result', async t => {
  const root = await directory(t), outputPath = path.join(root, 'timeout.jsonl');
  await assert.rejects(invokeDocumentCli({ executable: process.execPath,
    argsPrefix: ['-e', 'process.stdout.write("starting\\n"); setInterval(() => {}, 1000)'], args: [], cwd: root,
    // Leave time for a real Windows child to start under suite load; the
    // fixture then runs indefinitely, so this still exercises forced timeout.
    deadlineAt: Date.now() + (process.platform === 'win32' ? 1000 : 150), outputPath, killGraceMs: 25 }), { code: 'DOCUMENT_CLI_TIMEOUT' });
  assert.match(await fs.readFile(outputPath, 'utf8'), /starting/);
});

test('a missing executable preserves its launch error instead of failing during cleanup', async t => {
  const root = await directory(t);
  await assert.rejects(invokeDocumentCli({ executable: path.join(root, 'missing-executable'), args: [], cwd: root,
    deadlineAt: Date.now() + 1000, outputPath: path.join(root, 'missing.jsonl') }), { code: 'ENOENT' });
});

// Deterministic protocol tests only. Live model results are saved separately.
function fixtureInvocation({ wrongFirstLocation = false, skipEdit = false } = {}) {
  let reviews = 0; const deadlines = [];
  const invoke = async ({ args, cwd, deadlineAt, outputPath }) => {
    const isReview = args.includes('--json-schema');
    const calls = [], results = []; let structured_output;
    if (isReview) {
      deadlines.push(deadlineAt); reviews++;
      const mcp = JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
      const semantic = JSON.parse(await fs.readFile(mcp.mcpServers.doc.args[1], 'utf8'));
      const tools = await createDocumentTools({ projectRoot: cwd, semantic });
      calls.push({ id: 'open', name: 'mcp__doc__rc_document', input: { action: 'open' } });
      results.push({ tool_use_id: 'open', content: (await tools.tool.execute('open', { action: 'open' })).content });
      const bad = (await fs.readFile(path.join(cwd, 'design.md'), 'utf8')).includes('https://telemetry.example.invalid/collect');
      const line = wrongFirstLocation && reviews === 1 ? 3 : 2;
      structured_output = { summary: 'Deterministic test double, not a model verdict.', edits: [], findings: bad ? [{
        ruleId: 'AGENT-LOCAL', severity: 'error', path: 'design.md', line,
        message: 'Remote telemetry violates local-only requirement.',
        evidence: [`design.md:${line}: 'After import, send import metadata to https://telemetry.example.invalid/collect.'`],
      }] : [] };
    } else {
      for (const name of ['requirements.md', 'design.md', 'correction-feedback.json']) {
        calls.push({ id: name, name: 'Read', input: { file_path: path.join(cwd, name) } });
        results.push({ tool_use_id: name, content: await fs.readFile(path.join(cwd, name), 'utf8') });
      }
      if (!skipEdit) {
        const target = path.join(cwd, 'design.md');
        await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('After import, send import metadata to https://telemetry.example.invalid/collect.',
          'No network calls are made.'));
        calls.push({ id: 'edit', name: 'Edit', input: { file_path: target } });
        results.push({ tool_use_id: 'edit', content: 'Updated.' });
      }
    }
    await fs.writeFile(outputPath, 'Deterministic test double; no real model invocation.\n');
    return { envelope: { session_id: `fixture-${reviews}-${isReview}`, structured_output, permission_denials: [] },
      calls, results, exitCode: 0 };
  };
  return { invoke, deadlines };
}

test('the production document pipeline requires a successful model edit and current re-review', async t => {
  const root = await directory(t), fixture = fixtureInvocation({ wrongFirstLocation: true });
  const report = await runDocumentE2E({ outputRoot: path.join(root, 'run'), invoke: fixture.invoke,
    options: { reviewTimeoutMs: 1200000, totalTimeoutMs: 1800000 } });
  assert.equal(report.state, 'PASSED', report.failure?.message);
  assert.equal(report.rounds.length, 2); assert.equal(report.repairs.length, 1);
  assert.equal(report.rounds[0].review.findings[0].line, 2);
  assert.deepEqual(report.rounds[1].review.findings, []);
  assert.equal(fixture.deadlines[0], fixture.deadlines[1], 'Location repair cannot reset the role deadline');
  assert(report.invocations.every(item => item.deadlineAt <= Date.parse(report.startedAt) + report.options.totalTimeoutMs));
  assert(report.invocations[0].deadlineAt - Date.parse(report.startedAt) > 1100000, 'Configured budget was clamped to an old three-minute limit');
  assert.equal(report.repairs[0].hostFeedbackDelivered, true);
});

test('a repair response without a real edit cannot be accepted as end-to-end success', async t => {
  const root = await directory(t), fixture = fixtureInvocation({ skipEdit: true });
  const report = await runDocumentE2E({ outputRoot: path.join(root, 'run'), invoke: fixture.invoke });
  assert.equal(report.state, 'FAILED'); assert.match(report.failure.message, /actual edits/);
  assert.equal(report.repairs.length, 0);
});

test('known colon quote formats reject wrong current lines and accept the actual current location', async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'design.md'), '# Design\nSend metadata remotely.\nNo login.\n');
  const tools = await createDocumentTools({ projectRoot: root, semantic: { artifactFiles: ['design.md'] } });
  for (const quote of ["'", '"']) {
    await assert.rejects(tools.validateFindings([{ path: 'design.md', line: 3,
      evidence: [`design.md:3: ${quote}Send metadata remotely.${quote}`] }]), /DOCUMENT_FINDING_LOCATION_INVALID/);
    await tools.validateFindings([{ path: 'design.md', line: 2,
      evidence: [`design.md:2: ${quote}Send metadata remotely.${quote}`] }]);
  }
});
