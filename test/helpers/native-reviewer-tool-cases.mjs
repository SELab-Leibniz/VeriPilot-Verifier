import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scriptedCoverageReport, scriptedSourceInventory } from './baseline-coverage-native.mjs';

export const readMessages = async file => (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/u)
  .map(line => JSON.parse(line).message).filter(Boolean);
export const toolText = message => message.content.map(block => block.text).join('');

const wrapperNames = new Set(['tool_call', 'tool_search', 'tool_describe', 'tool_search_code', 'exec', 'wait']);

// Drive the declared provider tools through the real host. The only scripted
// component is the model's next message, using the tool text it actually saw.
function scripted(script) {
  let pending = false;
  return (payload, names) => {
    const last = pending ? payload.messages.findLast(message => message.role === 'tool') : undefined;
    if (pending) assert.equal(typeof last?.content, 'string', 'Expected the previous native tool result');
    const step = script.next(last?.content);
    if (step.done) return step.value;
    const [name, args] = step.value;
    assert(names.includes(name), `${name} is missing from the actual provider tool list: ${names.join(', ')}`);
    assert(!names.some(tool => wrapperNames.has(tool)), 'A private reviewer exposed a wrapper');
    pending = true;
    return [name, args];
  };
}

function persistedTools(runs, expected) {
  const found = [];
  for (const { messages } of runs) {
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      assert(!wrapperNames.has(message.toolName));
      found.push(message);
    }
  }
  for (const name of expected) assert(found.some(message => message.toolName === name && message.isError === false),
    `No successful ${name} result was persisted`);
  return found;
}

function* readOriginals(requiredFiles, files = new Map(), citations = []) {
  for (const file of requiredFiles) {
    if (files.has(file)) continue;
    const text = yield ['source_read', { path: file, numbered: false }];
    const header = /^\[citeId="([^"]+)" \| range [^\n]*\]\n/u.exec(text);
    assert(header, `Missing native citeId for ${file}`);
    const footer = text.lastIndexOf('\n[RC page ');
    assert(footer > header[0].length - 1 && text.endsWith(']'));
    const page = JSON.parse(text.slice(footer + '\n[RC page '.length, -1));
    assert.equal(page.nextOffset, null, `Small test source unexpectedly needs more pages: ${file}`);
    const original = text.slice(header[0].length, footer);
    assert.equal(createHash('sha256').update(original).digest('hex'), page.fileFacts.sha256,
      `The provider did not receive the original bytes for ${file}`);
    files.set(file, original);
    citations.push({ path: file, citeId: header[1] });
  }
  return { files, citations };
}

export async function validateNativeBaselineAndAudit({ plugin, factoryFor, projectRoot, model }) {
  const { refreshRuntimeRequirements } = await plugin('lib/runtime-v2/orchestrator.mjs');
  const { compileRuntimeV2Config } = await plugin('lib/runtime-v2/config.mjs');
  const { decodeBaselineAuditView } = await plugin('lib/runtime-v2/baseline-coverage-audit.mjs');
  const { loadCurrentGroundTruth } = await plugin('lib/runtime-v2/ground-truth-ledger.mjs');
  const { ensureTask } = await plugin('lib/runtime-v2/task-store.mjs');
  const sessionId = 'native-baseline-tool-search', requirement = 'Preserve the requested feature.';
  const task = await ensureTask({ projectRoot, sessionId });
  const transcript = path.join(projectRoot, 'baseline-input.jsonl');
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'U1', message: { content: requirement } }) + '\n');
  const plan = { artifacts: [], runtimeV2: compileRuntimeV2Config({ version: 2,
    dynamicGroundTruth: { enabled: true, materialRoots: [], panel: { size: 0 } },
    artifactCorrection: { groundTruthReviewEnabled: true }, skillCorrection: { enabled: false },
    stopCorrection: { enabled: true }, reviewers: { defaults: { model, timeoutMs: 40000 } },
  }, { policyRoot: path.join(projectRoot, '.runtime-corrector') }) };

  function* extract(params) {
    const request = JSON.parse(params.prompt);
    const { citations } = yield* readOriginals(request.requiredFiles);
    const note = JSON.parse(yield ['baseline_notes', { action: 'put', key: 'fixture-note', text: 'Originals read.' }]);
    assert.deepEqual(note, { saved: true, key: 'fixture-note', navigationOnly: true });
    const readIds = citations.filter(cite => cite.path.startsWith('source-')).map(cite => cite.citeId);
    assert(readIds.length);
    const operation = { operation: 'ADD', category: 'requirements', text: requirement, authority: 'USER_EXPLICIT',
      severity: 'HARD', applicabilityKind: 'CURRENT_TASK', verificationTarget: 'IMPLEMENTATION', implementationRole: 'PRODUCTION',
      source: { kind: 'USER_MESSAGE', ref: 'transcript:U1#L1-L1', subject: 'MAIN_TASK' } };
    const saved = JSON.parse(yield ['save_baseline_batch', { action: 'submit', batchId: 1, operations: [operation],
      bindings: [{ operationIndex: 0, citeIds: readIds }] }]);
    assert.equal(saved.saved, true, JSON.stringify(saved));
    yield ['finish_baseline', { batchIds: [1], taskClassification: 'CONTINUATION', summary: requirement }];
  }
  let phaseTwoManifestBytes;
  function* audit(params) {
    const request = JSON.parse(params.prompt);
    const { files, citations } = yield* readOriginals(request.requiredFiles);
    const inventory = scriptedSourceInventory({ request, files, citations });
    const acknowledgement = JSON.parse(yield ['commit_baseline_inventory', { inventory }]);
    assert.equal(acknowledgement.accepted, true, JSON.stringify(acknowledgement));
    yield* readOriginals([request.phaseTwoManifest], files, citations);
    const manifest = files.get(request.phaseTwoManifest);
    phaseTwoManifestBytes = Buffer.byteLength(manifest);
    assert(phaseTwoManifestBytes > 6000, 'The fixture must exercise text that used to span multiple blocks');
    const phaseTwo = JSON.parse(manifest);
    yield* readOriginals(phaseTwo.requiredFiles, files, citations);
    const view = decodeBaselineAuditView(JSON.parse([...files].filter(([file]) => file.startsWith('candidate-'))
      .sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('')));
    const report = scriptedCoverageReport({ view, files, citations, identityDigest: request.identityDigest, inventory });
    yield ['finish_baseline_audit', { report }];
  }
  const runs = [];
  const factory = factoryFor(params => scripted(params.toolsAllow.includes('finish_baseline') ? extract(params) : audit(params)),
    runs, { baselineWireMode: 'full' });
  const result = await refreshRuntimeRequirements({ projectRoot, plan, reviewerFactory: factory,
    input: { cwd: projectRoot, session_id: sessionId, transcript_path: transcript, hook_event_name: 'Stop',
      hook_event_id: 'native-baseline-tool-search' } });
  assert.equal(result.baselineCommitted, true, JSON.stringify(result));
  const truth = await loadCurrentGroundTruth(projectRoot, task.taskId);
  assert.deepEqual(truth.claims.map(claim => claim.text), [requirement]);
  // The committed ledger proves finish_baseline. Its host toolResult can
  // still be in flight when the extractor stops after committing its delta.
  const nativeSubmissions = ['save_baseline_batch', 'commit_baseline_inventory', 'finish_baseline_audit'];
  const messages = persistedTools(runs, ['source_read', 'baseline_notes', ...nativeSubmissions]);
  return { version: truth.version, nativeRuns: runs.length, readResults: messages.filter(m => m.toolName === 'source_read').length,
    phaseTwoManifestBytes, nativeSubmissions };
}

export async function validateNativeSkillAndDocument({ plugin, pluginRoot, factoryFor, projectRoot, taskId, model }) {
  const { SKILL_REVIEW_SCHEMA } = await plugin('lib/runtime-v2/reviewer.mjs');
  const { sha256 } = await plugin('lib/runtime-v2/utils.mjs');
  const skillRoot = path.join(projectRoot, 'skills', 'fixture'), skillPath = path.join(skillRoot, 'SKILL.md');
  const text = '# Fixture\nRead the document before reviewing it.\n';
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(skillPath, text);
  const runs = [], reviewer = { model, timeoutMs: 30000, formatRepairAttempts: 0 };

  function* skillReview() {
    const progress = JSON.parse(yield ['rc_progress', { action: 'get' }]);
    assert.deepEqual(progress.objects, ['M08:fixture']);
    const saved = JSON.parse(yield ['rc_progress', { action: 'save', item: { objectId: 'M08:fixture', state: 'IN_PROGRESS',
      reason: 'Checking original Skill.', refs: [] } }]);
    assert.deepEqual(saved, { saved: true, objectId: 'M08:fixture', state: 'IN_PROGRESS' });
    const original = JSON.parse(yield ['rc_skill_care', { action: 'read', id: 'skill/SKILL.md' }]);
    assert.equal(original.content, text);
    return JSON.stringify({ summary: 'Controlled Skill review.', completionStatus: 'COMPLETED', findings: [],
      sourceInterpretationReviews: [{ constraintId: 'read-document', disposition: 'CONFIRMED', reason: 'The original Skill names the read.',
        actualEvidence: ['skill/SKILL.md'] }] });
  }
  const skill = await factoryFor(() => scripted(skillReview()), runs)({ projectRoot, taskId, pluginRoot, reviewer,
    role: 'skill-reviewer', schema: SKILL_REVIEW_SCHEMA, request: { watcher: { skillId: 'fixture' },
      population: { metrics: { M08: [{ objectId: 'M08:fixture', description: 'Review the controlled skill.' }] } } },
    evidence: { skillSource: { root: skillRoot, digest: sha256(text), files: [{ path: 'SKILL.md', content: text, sha256: sha256(text) }] },
      skillGroundTruth: { constraints: [{ constraintId: 'read-document', sourceRef: 'SKILL.md', statement: 'Read the document.' }] } } });
  const skillMessages = persistedTools(runs, ['rc_progress', 'rc_skill_care']);
  try {
    const citation = skill.sourceCitations.find(item => item.path === skillPath);
    assert.equal(citation?.readProof?.basisComplete, true);
    assert.deepEqual(citation.readProof.nativePersistence.map(item => item.callId),
      skillMessages.filter(item => item.toolName === 'rc_skill_care').map(item => item.toolCallId));
  } finally { await skill.close(); }

  function* documentReview() {
    const original = JSON.parse(yield ['rc_document', { action: 'read', path: 'deliverable.md' }]);
    assert.equal(original.lines[0], '1: Ready');
    const saved = JSON.parse(yield ['rc_document', { action: 'remember', key: 'fixture-note',
      note: 'The original contains Ready.', paths: ['deliverable.md'] }]);
    assert.equal(saved.saved, 'fixture-note');
    const recalled = JSON.parse(yield ['rc_document', { action: 'recall' }]);
    assert.equal(recalled.current[0].key, 'fixture-note');
    return JSON.stringify({ summary: 'Controlled document review.' });
  }
  const documentRequest = path.join(projectRoot, 'document-request.json'), documentRuns = [];
  await fs.writeFile(documentRequest, JSON.stringify({ projectRoot, artifactFiles: ['deliverable.md'] }));
  const document = await factoryFor(() => scripted(documentReview()), documentRuns)({ projectRoot, taskId, pluginRoot, reviewer,
    role: 'artifact-reviewer', request: { semanticReviewRequestPath: documentRequest },
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } });
  try {
    assert.equal(document.result.summary, 'Controlled document review.');
    assert.equal(persistedTools(documentRuns, ['rc_document']).length, 3);
  } finally {
    await document.close();
    await (await plugin('lib/document-session.mjs')).releaseDocumentSessions(projectRoot);
  }
  return { skillReadAcknowledged: true, progress: true, documentCalls: 3 };
}

export async function validateNativeRequirementFrame({ plugin, factoryFor, projectRoot, taskId, model }) {
  const { startRequirementFrame } = await plugin('lib/runtime-v2/requirement-frame.mjs');
  const { compileRuntimeV2Config } = await plugin('lib/runtime-v2/config.mjs');
  const { sha256 } = await plugin('lib/runtime-v2/utils.mjs');
  await fs.writeFile(path.join(projectRoot, 'app.js'), 'export const fallback = 1;\n');
  const git = (...args) => execFileSync('git', ['-C', projectRoot, '-c', 'core.autocrlf=false', ...args], { windowsHide: true });
  git('init', '-q');
  git('add', 'app.js');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'initial fixture');
  const runs = [];
  function* frameTurns(params) {
    if (params.prompt.startsWith('[REQUIREMENT_FRAME_SELECTOR]')) {
      const items = JSON.parse(params.prompt.split('Candidates:\n')[1].split('\n\n')[0]);
      yield ['submit_frame_selection', { finish: true, reviews: items.map(item => ({ id: item.id, decision: 'select', reason: 'Checked.' })) }];
    } else if (params.prompt.startsWith('[REQUIREMENT_FRAME_COUNTEREXAMPLE]')) {
      yield ['submit_frame_proposal', { guidance: [], scenarios: [] }];
    } else {
      const graph = JSON.parse(yield ['semantic_graph', { operation: 'definition', symbol: 'fallback' }]);
      assert(graph.hits.some(hit => hit.path === 'app.js'));
      const source = yield ['source_read', { path: 'app.js' }];
      assert.match(source, /fallback = 1/u);
      yield ['submit_frame_proposal', { guidance: [{ statement: 'Keep the existing default.', contractCell: 'values_defaults',
        confidence: 0.9, evidence: [{ path: 'app.js', startLine: 1, endLine: 1 }] }], scenarios: [] }];
    }
  }
  const factory = factoryFor(params => scripted(frameTurns(params)), runs);
  const plan = { runtimeV2: compileRuntimeV2Config({ version: 2, artifactCorrection: { originalRequirementsEnabled: true },
    requirementFrame: { enabled: true, inject: false, checks: false, proposers: 1, timeoutMs: 40000 },
    reviewers: { defaults: { model, timeoutMs: 40000 } } }) };
  const state = { projectRoot, sessionId: 'tool-search-parent', scopeTaskId: taskId,
    entries: [{ type: 'user', uuid: 'F1', message: { content: 'Keep the existing default.' } }] };
  startRequirementFrame(state, plan, factory.requirementFrame, new Set(), 'frame-run');
  const frame = await state.requirementFrameWork.promise;
  assert.equal(frame?.status, 'ready', JSON.stringify(frame));
  assert.equal(frame.counts.selected, 1);
  assert.equal(frame.guidance[0].statement, 'Keep the existing default.');
  persistedTools(runs, ['semantic_graph', 'source_read']);
  // The frame saves its own decision before the host is asked to stop. The
  // final toolResult can be absent from the host transcript after that abort.
  const frameDir = path.join(projectRoot, '.runtime-correction', 'requirement-frame', sha256(state.sessionId).slice(0, 24));
  const selection = (await fs.readFile(path.join(frameDir, 'selection-receipts.jsonl'), 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(selection.length, 1);
  assert.deepEqual(selection[0].batch.reviews, [{ id: frame.guidance[0].candidateId, decision: 'select', reason: 'Checked.' }]);
  return { status: frame.status, nativeRuns: runs.length, selected: frame.counts.selected };
}
