import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDocumentTools } from '../lib/document-tools.mjs';
import { releaseDocumentSessions } from '../lib/document-session.mjs';
import { createOpenClawReviewerFactory } from '../lib/openclaw/reviewer.mjs';
import { REVIEW_SCHEMA } from '../lib/semantic-review.mjs';

const telemetry = 'After import, send import metadata to https://telemetry.example.invalid/collect.';
const design = `# Design\nSelect and validate a local document. Parse it on the device and show validation or parse errors locally. ${telemetry}\nThis design does not include login, cloud synchronization, or server deployment.\n`;
const requirements = '# Requirements\nKeep the imported document and metadata local. No network access, remote API, or telemetry is allowed.\nReport invalid input and parse failures locally.\n';
const finding = (line = 3, quoteLine = line) => ({ ruleId: 'AGENT-TELEMETRY', severity: 'error', path: 'design.md', line,
  message: 'Remote metadata telemetry contradicts the original local-only requirement.',
  evidence: [`design.md:${quoteLine} "${telemetry}"`, 'requirements.md:2 "No network access, remote API, or telemetry is allowed."'] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-finding-location-'));
  t.after(async () => { await releaseDocumentSessions(root); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'design.md'), design); await fs.writeFile(path.join(root, 'requirements.md'), requirements);
  const semantic = { artifactFiles: ['design.md'], workflow: { targetFiles: ['design.md'], editableArtifactFiles: ['design.md'],
    groundTruthInputs: [{ status: 'ready', files: ['requirements.md'] }] } };
  return { root, semantic, tools: await createDocumentTools({ projectRoot: root, semantic }) };
}

test('actual telemetry quotation on the wrong declared line is rejected without relocating or mutating the finding', async t => {
  const f = await fixture(t), wrong = finding(), original = JSON.stringify(wrong);
  await assert.rejects(f.tools.validateFindings([wrong]), error => {
    assert.equal(error.code, 'DOCUMENT_FINDING_LOCATION_INVALID');
    assert.match(error.message, /literal quotation is absent/u); assert.match(error.message, /3: This design does not include/u);
    return true;
  });
  assert.equal(JSON.stringify(wrong), original);
  await f.tools.validateFindings([finding(2)]);
  await assert.rejects(f.tools.execute({ action: 'remember', key: 'validator-only', note: 'A validator is not a disclosed read.', paths: ['design.md'] }), /DOCUMENT_NOTE_REQUIRES_CURRENT_READS/u);
});

test('normal punctuation after a closed literal citation cannot bypass wrong-line validation', async t => {
  const f = await fixture(t);
  for (const punctuation of ['.', ';', '。', '；']) {
    const wrong = { ...finding(3), evidence: [`design.md:3 "${telemetry}"${punctuation}`] };
    await assert.rejects(f.tools.validateFindings([wrong]), /literal quotation is absent/u);
    await f.tools.validateFindings([{ ...finding(2), evidence: [`design.md:2 "${telemetry}"${punctuation}`] }]);
  }
});

test('actual path:line: quote syntax and explicit ranges validate the declared current line without relocating findings', async t => {
  const f = await fixture(t);
  for (const [before, after] of [["'", "'"], ['"', '"'], ['“', '”'], ['‘', '’']]) {
    for (const citation of [line => `design.md:${line}: `, line => `design.md#L${line}-L${line}: `,
      line => `\`design.md:${line}\`: `]) {
      const wrong = { ...finding(3), evidence: [citation(3) + before + telemetry + after] }, original = JSON.stringify(wrong);
      await assert.rejects(f.tools.validateFindings([wrong]), /literal quotation is absent/u);
      assert.equal(JSON.stringify(wrong), original);
      await f.tools.validateFindings([{ ...finding(2), evidence: [citation(2) + before + telemetry + after] }]);
    }
  }
  await assert.rejects(f.tools.validateFindings([{ ...finding(3), evidence: [`design.md:2: '${telemetry}'`] }]), /anchor disagrees/u);
  await assert.rejects(f.tools.validateFindings([{ ...finding(2), evidence: ["requirements.md:3: 'No network access, remote API, or telemetry is allowed.'"] }]), /literal quotation is absent/u);
});

test('finding anchor, quoted source ranges and current bytes retain their independent checks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tools.validateFindings([finding(3, 2)]), /anchor disagrees/u);
  await assert.rejects(f.tools.validateFindings([{ ...finding(2), line: 99 }]), /outside the current original/u);
  await assert.rejects(f.tools.validateFindings([{ ...finding(2), evidence: ['requirements.md:3 "No network access, remote API, or telemetry is allowed."'] }]), /literal quotation is absent/u);
  await f.tools.validateFindings([{ ...finding(2), evidence: [`design.md#L2-L2 “${telemetry}”`] }]);
  await fs.writeFile(path.join(f.root, 'design.md'), '# Replaced current document\n');
  await assert.rejects(f.tools.validateFindings([finding(2)]), /DOCUMENT_EVIDENCE_CHANGED/u);
});

test('paraphrase, absence and document-level reasoning are not forced into fabricated literal citations', async t => {
  const f = await fixture(t);
  await f.tools.validateFindings([{ ruleId: 'AGENT-INFERENCE', path: 'design.md', severity: 'warning',
    message: 'The stated remote service conflicts with local-only intent.', evidence: ['The design proposes network transfer of metadata.'] }]);
  await f.tools.validateFindings([{ ruleId: 'AGENT-ABSENCE', path: 'design.md', severity: 'warning',
    message: 'A required explanation is absent.', evidence: ['The complete current design does not explain that required behavior.'] }]);
  await f.tools.validateFindings([{ ...finding(2), evidence: ['/unlisted/private/path.md:1 "Do not read arbitrary paths from evidence."'] }]);
});

function factoryFor(f, runner) {
  const requestPath = path.join(f.root, 'request.json');
  const api = { config: { agents: { defaults: { model: 'fixture/model' } } },
    runtime: { version: '2026.7.1-2', agent: { runEmbeddedAgent: runner } }, logger: { warn() {} } };
  const factory = createOpenClawReviewerFactory(api);
  const input = { projectRoot: f.root, taskId: 'document-location-unit', role: 'artifact-reviewer', pluginRoot: path.resolve('.'),
    reviewer: { session: 'detached', timeoutMs: 5000, formatRepairAttempts: 1 }, schema: REVIEW_SCHEMA,
    request: { semanticReviewRequestPath: requestPath }, evidence: { snapshot: { entries: [], digest: 'same-current-authority' } } };
  return { factory, input, requestPath };
}

test('native first and repair validation are awaited in one bounded session while original failed output stays intact', async t => {
  const f = await fixture(t), calls = [], raw = [];
  const { factory, input, requestPath } = factoryFor(f, async params => {
    calls.push(params);
    const binding = globalThis[Symbol.for('runtime-corrector.document-tools.v1')].get(params.sessionId);
    await binding.tools.execute({ action: 'open' });
    const value = { summary: 'Controlled native location protocol test; no real model.', findings: [finding(calls.length === 1 ? 3 : 2)], edits: [] };
    raw.push(JSON.stringify(value)); return { payloads: [{ text: raw.at(-1) }], meta: {} };
  });
  await fs.writeFile(requestPath, JSON.stringify({ ...f.semantic, projectRoot: f.root }));
  const handle = await factory(input);
  assert.equal(calls.length, 2); assert.equal(calls[0].sessionId, calls[1].sessionId);
  assert(calls[1].timeoutMs <= calls[0].timeoutMs);
  assert.match(calls[1].prompt, /DOCUMENT_FINDING_LOCATION_INVALID/u);
  assert.equal(JSON.parse(raw[0]).findings[0].line, 3); assert.equal(handle.result.findings[0].line, 2);
  await handle.close();
});

test('invalid cached precision is audited and reassessed rather than returned or silently repaired', async t => {
  const f = await fixture(t); let calls = 0;
  const { factory, input, requestPath } = factoryFor(f, async () => {
    calls++; return { payloads: [{ text: JSON.stringify({ summary: 'Current evidence.', findings: [finding(2)], edits: [] }) }], meta: {} };
  });
  await fs.writeFile(requestPath, JSON.stringify({ ...f.semantic, projectRoot: f.root }));
  const first = await factory(input); await first.close();
  const session = globalThis[Symbol.for('runtime-corrector.document-sessions.v1')].get(await fs.realpath(f.root));
  assert(session.cache?.value); session.cache.value.findings[0].line = 3;
  const second = await factory(input); await second.close();
  assert.equal(calls, 2); assert.equal(second.result.findings[0].line, 2);
});
