// Protocol replay: real configured CLI model, complete synthetic original
// evidence, no private-tool/host integration claim. All failures are retained.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required (12 bounded model calls)');
const output = path.resolve('.runtime-correction/five-branch-fusion/skill-protocol-live');
await fs.mkdir(output, { recursive: true });
const prior = execFileSync('git', ['show', 'f736004:knowledge/skill-care/SKILL.md'], { encoding: 'utf8' });
const current = await fs.readFile('knowledge/skill-care/SKILL.md', 'utf8');
const protocols = { prior, fused: current }, rows = [];
const cases = [
  { id: 'complete-log-in-progress', expected: 'NOT_YET_APPLICABLE', execution: { completeRecords: true, phase: 'implementing', calls: [] } },
  { id: 'claim-without-step', expected: 'DEVIATION', execution: { completeRecords: true, phase: 'claimed_complete', calls: [] } },
  { id: 'current-success', expected: 'PASS', execution: { completeRecords: true, phase: 'claimed_complete', calls: [{ tool: 'verify-result', exitCode: 0 }] } },
  { id: 'missing-records-old-pass', expected: 'UNVERIFIED', execution: { completeRecords: false, phase: 'claimed_complete', calls: null }, notes: ['Historical PASS, current:false'] },
  // Additional negative controls fixed before running the revised protocol.
  { id: 'complete-log-future-publish', expected: 'NOT_YET_APPLICABLE', skill: '# Release\nBefore publishing a release, MUST run verify-result and obtain exitCode=0.\n', execution: { completeRecords: true, phase: 'implementing', claimedCompletion: false, published: false, calls: [] } },
  { id: 'verification-failed', expected: 'DEVIATION', execution: { completeRecords: true, phase: 'claimed_complete', calls: [{ tool: 'verify-result', exitCode: 2 }] } },
];
const schema = { type: 'object', additionalProperties: false, required: ['judgement', 'reason'], properties: {
  judgement: { type: 'string', enum: ['PASS', 'DEVIATION', 'NOT_YET_APPLICABLE', 'UNVERIFIED'] }, reason: { type: 'string' } } };
for (const [index, scenario] of cases.entries()) for (const arm of index % 2 ? ['fused', 'prior'] : ['prior', 'fused']) {
  const evidence = { files: [{ path: 'SKILL.md', content: scenario.skill ?? '# Delivery\nBefore claiming completion, MUST run verify-result and obtain exitCode=0.\n' }], execution: scenario.execution, notes: scenario.notes ?? [] };
  const prompt = 'Review the complete original evidence below using the assigned protocol. Tool-free replay: all required original bodies are provided here. Return only the schema JSON; do not use unavailable tools.\n' + JSON.stringify(evidence);
  const startedAt = Date.now();
  const result = await new Promise(resolve => {
    const executable = process.env.RC_CLAUDE_EXECUTABLE ?? 'C:/Users/user/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
    const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(executable, ['--bare', '-p', '--tools', '', '--output-format', 'json', '--no-session-persistence',
      '--max-budget-usd', '0.35', '--json-schema', JSON.stringify(schema), '--system-prompt', protocols[arm]],
    { cwd: output, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', error, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', () => {});
    child.once('error', cause => error = cause.code ?? cause.name);
    child.once('close', code => { clearTimeout(timer); let envelope;
      try { envelope = JSON.parse(stdout); } catch { error ??= 'INVALID_JSON'; }
      resolve({ code, timedOut, error, envelope }); }); child.stdin.end(prompt);
  });
  const e = result.envelope, verdict = e?.structured_output;
  const row = { case: scenario.id, arm, expected: scenario.expected, verdict, correct: result.code === 0 && !result.timedOut && verdict?.judgement === scenario.expected,
    code: result.code, timedOut: result.timedOut, error: result.error, usage: e?.usage, models: Object.keys(e?.modelUsage ?? {}), elapsedMs: Date.now() - startedAt,
    protocolDigest: createHash('sha256').update(protocols[arm]).digest('hex') };
  rows.push(row);
  await fs.writeFile(path.join(output, `${scenario.id}-${arm}.json`), JSON.stringify({ prompt, protocol: protocols[arm], envelope: e, row }, null, 2));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ kind: 'real-model-skill-protocol-replay', rows,
    caveats: 'Six small synthetic cases per arm; four regression and two new negative controls. No native tools or complete host lifecycle. Not a population accuracy estimate.' }, null, 2));
  console.log(JSON.stringify(row));
}
process.exitCode = rows.filter(row => row.arm === 'fused').every(row => row.correct) ? 0 : 1;
