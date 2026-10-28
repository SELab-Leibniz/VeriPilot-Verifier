#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { acquireDocumentSession, releaseDocumentSessions } from '../lib/document-session.mjs';
import { createDocumentTools } from '../lib/document-tools.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.argv[2] ?? path.join(sourceRoot, '.runtime-correction/document-experiment'));
await fs.mkdir(directory, { recursive: true });
const projectRoot = path.join(directory, 'fixture'); await fs.mkdir(projectRoot, { recursive: true });
const target = path.join(projectRoot, 'design.md'), source = path.join(projectRoot, 'requirements.md');
const requirement = '# Requirements\nREQ-1: Import documents locally. Network access is prohibited.\n';
await fs.writeFile(source, requirement);
const semantic = { projectRoot, stage: 'design', artifactFiles: ['design.md'],
  reviewer: { criteria: 'Check that the design preserves REQ-1, including its network prohibition.' },
  workflow: { targetFiles: ['design.md'], editableArtifactFiles: ['design.md'], incomingEdges: [{ from: 'requirements', to: 'design', sourceFiles: ['requirements.md'], status: 'ready' }] } };
const requestPath = path.join(projectRoot, 'request.json'); await fs.writeFile(requestPath, JSON.stringify(semantic));
const rows = [];
const live = process.argv.includes('--live');
const batched = process.argv.includes('--batched');
const executable = process.env.RC_DOCUMENT_CLAUDE ?? 'C:/Users/user/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const protocol = await fs.readFile(path.join(sourceRoot, 'skills/document-corrector/SKILL.md'), 'utf8');
const schema = { type: 'object', additionalProperties: false, required: ['verdict', 'reason'], properties: {
  verdict: { type: 'string', enum: ['PASS', 'DEVIATION', 'UNVERIFIED'] }, reason: { type: 'string' } } };
const cases = [
  { body: '# Design\nREQ-1: Upload documents to a cloud API for import.\n', expected: 'DEVIATION' },
  { body: '# Design\nREQ-1: Import locally without network access.\n', expected: 'PASS' },
  { body: '# Design\nREQ-1: Import locally; contact a remote telemetry server after import.\n', expected: 'DEVIATION' },
];
function invoke(args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 180000);
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.slice(-2000) || `Claude exited ${code}`)); else resolve(JSON.parse(stdout)); });
  });
}
for (const mode of ['cold', 'reused']) {
  let resume;
  for (const [index, scenario] of cases.entries()) {
    await fs.writeFile(target, scenario.body);
    const started = performance.now();
    const session = await acquireDocumentSession({ projectRoot, identity: 'experiment', maxRounds: mode === 'cold' ? 1 : 32 });
    const tools = await createDocumentTools({ projectRoot, semantic });
    const manifest = tools.manifest(), prior = await tools.recall();
    const read = await tools.execute({ action: 'read', path: 'design.md' });
    await tools.execute({ action: 'remember', key: 'trace', note: 'REQ-1 requires local import and prohibits all network calls.', paths: ['design.md'] });
    // Reconstruct tools as after context loss, then verify notes and originals.
    const restored = await createDocumentTools({ projectRoot, semantic });
    const recovery = await restored.recall(); await tools.verify();
    let result = null;
    if (live) {
      const config = { mcpServers: { doc: { command: process.execPath, args: [path.join(sourceRoot, 'scripts/document-tools.mjs'), requestPath, '--stdio'] } } };
      const configPath = path.join(projectRoot, 'mcp.json'); await fs.writeFile(configPath, JSON.stringify(config));
      const prompt = `Review only the current documents in ${requestPath}. ${batched && mode === 'reused'
        ? 'Use rc_document open to load BOTH current documents and notes in one call; continue any incomplete pages. Remember a useful note only if there is a new unresolved decision. Return verdict and concise reason.'
        : 'Use rc_document manifest, recall, and read BOTH complete documents this round. Remember one useful navigation note keyed req-1 with both paths, then return verdict and concise reason.'} Prior findings are stale. Do not edit files. ${index === 2 ? 'Context recovery drill: prior summaries are unavailable; restore from current request and private notes.' : ''}`;
      const args = ['--print', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--effort', 'low',
        '--system-prompt', protocol, '--mcp-config', configPath, '--strict-mcp-config', '--tools', '',
        '--allowedTools', 'mcp__doc__rc_document', '--permission-mode', 'dontAsk'];
      if (mode === 'reused' && resume) args.push('--resume', resume);
      const envelope = await invoke(args, projectRoot); resume = envelope.session_id;
      result = { result: envelope.structured_output, usage: envelope.usage, costUsd: envelope.total_cost_usd,
        durationMs: envelope.duration_ms, sessionId: envelope.session_id };
      await fs.writeFile(path.join(directory, `${mode}-${index}.json`), JSON.stringify(envelope, null, 2));
    }
    rows.push({ mode, round: index + 1, expected: scenario.expected, sessionId: session.sessionId, reused: session.reused,
      copiedRepositoryBytes: 0, declaredFiles: manifest.length, disclosureBytes: Buffer.byteLength(JSON.stringify(read)),
      staleNotes: prior.stale.length, recoveredNotes: recovery.current.length, elapsedMs: performance.now() - started,
      ...(result ? { model: result, correct: result.result?.verdict === scenario.expected } : {}) });
    await session.release();
  }
  await releaseDocumentSessions(projectRoot);
}
const report = { kind: live ? 'real-model-mcp-and-session-experiment' : 'deterministic-tool-and-lifecycle-experiment',
  createdAt: new Date().toISOString(), live, batched, rows,
  caveats: ['The fixture is generated; no repository is copied.', 'Elapsed time includes local tool/IO overhead.',
    'Only --live measures model tokens and correctness; deterministic mode makes no semantic accuracy claim.',
    'Native host integration and UI behavior are covered separately by contract tests; this is not a live MatrixAssistant UI test.'] };
await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
