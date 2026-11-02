import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { resolveReviewTimeoutMs } from '../../lib/review-timeout.mjs';

export const DOCUMENT_RUN_DEFAULTS = Object.freeze({
  reviewTimeoutMs: 600000,
  repairTimeoutMs: 600000,
  totalTimeoutMs: 1800000,
  maxRepairRounds: 2,
  locationRepairAttempts: 2,
  killGraceMs: 1500,
});

export function documentRunOptions(input = {}) {
  for (const key of Object.keys(input))
    if (!Object.hasOwn(DOCUMENT_RUN_DEFAULTS, key)) throw new Error(`Unknown document run option: ${key}`);
  const result = { ...DOCUMENT_RUN_DEFAULTS, ...input };
  for (const key of ['reviewTimeoutMs', 'repairTimeoutMs', 'totalTimeoutMs'])
    result[key] = resolveReviewTimeoutMs(result[key], key);
  for (const [key, max] of [['maxRepairRounds', 10], ['locationRepairAttempts', 5]]) {
    if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > max)
      throw new Error(`${key} must be an integer from 0 to ${max}`);
  }
  if (!Number.isInteger(result.killGraceMs) || result.killGraceMs < 0 || result.killGraceMs > 10000)
    throw new Error('killGraceMs must be an integer from 0 to 10000');
  return result;
}

// A single absolute deadline covers CLI startup, MCP reads and all model turns.
// Save the real stream (including tool calls/results), not just the final text.
export async function invokeDocumentCli({ executable = 'claude', argsPrefix = [], args, cwd,
  deadlineAt, outputPath, killGraceMs = 1500, env = process.env }) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw Object.assign(new Error('Document run deadline exhausted'), { code: 'DOCUMENT_CLI_TIMEOUT' });
  const childEnv = { ...env };
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']) delete childEnv[name];
  childEnv.RUNTIME_CORRECTOR_SEMANTIC_REVIEW_ACTIVE = '1';
  const grouped = process.platform !== 'win32';
  const child = spawn(executable, [...argsPrefix, ...args], {
    cwd, env: childEnv, detached: grouped, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '', bytes = 0, failure = null, killTimer;
  const stop = signal => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
  };
  const abort = error => {
    if (failure) return;
    failure = error;
    stop('SIGTERM');
    killTimer = setTimeout(() => stop('SIGKILL'), killGraceMs);
  };
  const timer = setTimeout(() => abort(Object.assign(new Error('Document CLI absolute deadline exhausted'),
    { code: 'DOCUMENT_CLI_TIMEOUT' })), remaining);
  const append = (key, chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) {
      abort(Object.assign(new Error('Document CLI output exceeded 16 MiB'), { code: 'DOCUMENT_CLI_OUTPUT_LIMIT' }));
      return;
    }
    if (key === 'stdout') stdout += chunk; else stderr += chunk;
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  let code, signal;
  try {
    ({ code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }));
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    // MCP subprocesses belong to this invocation, including failed launches.
    stop('SIGKILL');
    await fs.writeFile(outputPath, stdout);
    await fs.writeFile(`${outputPath}.stderr`, stderr);
  }
  if (failure) throw failure;
  if (code !== 0) throw new Error(`Document CLI exited ${code ?? signal}: ${stderr.slice(-2000)}`);
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const envelope = events.findLast(event => event.type === 'result');
  if (!envelope || envelope.is_error || envelope.subtype !== 'success')
    throw new Error(`Document CLI did not complete successfully: ${envelope?.result ?? envelope?.subtype ?? 'missing result'}`);
  const calls = events.filter(event => event.type === 'assistant')
    .flatMap(event => event.message?.content ?? []).filter(item => item.type === 'tool_use');
  const results = events.filter(event => event.type === 'user')
    .flatMap(event => event.message?.content ?? []).filter(item => item.type === 'tool_result');
  return { envelope, calls, results, exitCode: code, signal };
}

export const documentCliArguments = ({ prompt, system, schema, tools = '', allowedTools = '', mcpConfig }) => [
  '--print', prompt, '--output-format', 'stream-json', '--verbose', '--effort', 'low',
  '--system-prompt', system, '--permission-mode', 'dontAsk', '--no-session-persistence',
  '--tools', tools, '--strict-mcp-config',
  ...(allowedTools ? ['--allowedTools', allowedTools] : []),
  ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
  ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
];
