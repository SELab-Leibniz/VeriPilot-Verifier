// Run the shared Stop protocol in a fresh CLI session with private MCP tools.
// Only host stream tool-result frames acknowledge source reads. MCP execution
// and a citation header alone cannot certify that the complete page arrived.
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { buildReviewerInvocation } from '../reviewer-launcher.mjs';
import { withAgentOutputEnvironment } from '../agent-output.mjs';
import { REVIEWER_CLI_TOOL_DENY } from '../reviewer-tools.mjs';
import { validateJsonSchema } from '../json-schema-validator.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';
import { toolText } from './source-tools.mjs';

const PREFIX = 'mcp__rc_stop__';
const failure = (code, message) => Object.assign(new Error(message), { code });

export function createCliReceiptObserver(worker) {
  const pending = new Map(), calls = new Map(), results = new Map(), seenMessages = new Set();
  let sessionId = null;
  function acknowledge(id) {
    const call = calls.get(id), result = results.get(id);
    if (!call || !result || result.is_error) return;
    const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content;
    if (!content?.length || content.some(block => block.type !== 'text')) return;
    const text = toolText({ content });
    const citeId = /^\[citeId="(rccite_[a-z]+|C[1-9][0-9]*)"/u.exec(text)?.[1], expected = pending.get(citeId);
    if (!expected || expected.text !== text || sha256(call.input ?? {}) !== sha256(expected.args)) return;
    pending.delete(citeId);
    worker.observeReceipt({ toolName: 'source_read', toolCallId: expected.id, hostToolCallId: id,
      receiptBoundary: 'cli.stream_tool_result.v1', isSynthetic: false,
      message: { role: 'toolResult', toolName: 'source_read', toolCallId: expected.id, content, isError: false } });
    expected.resolve();
  }
  return {
    get sessionId() { return sessionId; },
    expect(id, args, result) {
      if (!result.details?.citation) return;
      let resolve; const done = new Promise(accept => { resolve = accept; });
      pending.set(result.details.citation.citeId, { id, args: structuredClone(args), text: toolText(result), resolve, done });
    },
    async flush() {
      const waiting = [...pending.values()].filter(item => !item.waited);
      if (!waiting.length) return;
      for (const item of waiting) item.waited = true;
      let timer;
      try { await Promise.race([Promise.all(waiting.map(item => item.done)), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); }
      finally { clearTimeout(timer); }
    },
    frame(frame) {
      if (frame.parent_tool_use_id || typeof frame.session_id !== 'string') return;
      if (frame.type === 'system' && frame.subtype === 'init' && !sessionId) sessionId = frame.session_id;
      if (!sessionId || frame.session_id !== sessionId) return;
      if (frame.type === 'assistant' && !seenMessages.has(frame.message?.id)) {
        if (frame.message?.id) seenMessages.add(frame.message.id);
        if (!worker.isComplete()) worker.onAssistantMessageStart();
      }
      for (const block of frame.message?.content ?? []) {
        if (frame.type === 'assistant' && block.type === 'tool_use' && block.name === `${PREFIX}source_read`) {
          calls.set(block.id, calls.has(block.id) ? null : block); acknowledge(block.id);
        }
        if (frame.type === 'user' && block.type === 'tool_result') {
          results.set(block.tool_use_id, results.has(block.tool_use_id) ? null : block); acknowledge(block.tool_use_id);
        }
      }
    },
  };
}

export async function createCliTaskSession({ input, launchPlan, env, hostAdapter }) {
  const controller = new AbortController(), parent = input.abortSignal;
  const cancel = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', cancel, { once: true }); if (parent?.aborted) cancel();
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + input.reviewer.timeoutMs);
  const timer = setTimeout(() => controller.abort(failure('REVIEWER_DEADLINE', 'Stop CLI deadline exhausted')), Math.max(0, deadlineAt - Date.now()));
  let closed = false, sessionId = null, child = null, server = null, attempt = 0, stopping = false, killTimer, treeStopped = Promise.resolve();
  const envelopes = [];
  const active = () => {
    controller.signal.throwIfAborted();
    if (closed) throw failure('REVIEW_TASK_CLOSED', 'Stop CLI session closed');
    if (Date.now() >= deadlineAt) throw failure('REVIEWER_DEADLINE', 'Stop CLI deadline exhausted');
  };
  function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null || stopping) return;
    stopping = true;
    if (process.platform === 'win32') {
      const owned = child;
      treeStopped = new Promise(resolve => {
        const kill = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        kill.once('error', () => { owned.kill(); resolve(); }); kill.once('close', resolve);
      });
    } else {
      const pid = child.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch { child.kill(); }
      treeStopped = new Promise(resolve => { killTimer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} resolve(); }, 500); });
    }
  }
  async function closeServer() {
    if (!server) return;
    const current = server; server = null;
    await new Promise(resolve => { current.close(resolve); current.closeAllConnections?.(); });
  }
  async function run(worker) {
    active(); if (child) throw new Error('Concurrent Stop CLI runs are forbidden');
    const observer = createCliReceiptObserver(worker), token = randomBytes(32).toString('hex');
    const toolMap = new Map(worker.tools.map(tool => [tool.name, tool]));
    server = http.createServer(async (request, response) => {
      const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
      try {
        active(); worker.active();
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Review request too large'); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let result;
        if (payload.method === 'list') result = { tools: worker.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) };
        else if (payload.method === 'call') {
          const tool = toolMap.get(payload.name);
          if (!tool || validateJsonSchema(payload.arguments, tool.parameters).length) throw failure('TASK_SUBMISSION_INVALID', 'Unknown review tool or invalid arguments');
          if (tool.name !== 'source_read') await observer.flush();
          active(); worker.active();
          const id = randomUUID();
          result = await tool.execute(id, payload.arguments, controller.signal);
          if (tool.name === 'source_read') observer.expect(id, payload.arguments, result);
        } else throw new Error('Unknown private review request');
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'REVIEW_TOOL_FAILED', message: error.message }) }] }));
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const configPath = path.join(worker.outputDir, `cli-mcp-${++attempt}.json`);
    await fsp.writeFile(configPath, JSON.stringify({ mcpServers: { rc_stop: { command: process.execPath,
      args: [fileURLToPath(new URL('./cli-mcp-bridge.mjs', import.meta.url))],
      env: { RC_STOP_BRIDGE_URL: endpoint, RC_STOP_BRIDGE_TOKEN: token } } } }), { mode: 0o600 });
    const args = [worker.prompt, ...hostAdapter.buildReviewerSessionArguments({ sessionId, fork: false }), '--print', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', `[runtime-corrector:internal]\n${worker.systemPrompt}\nUse only the rc_stop MCP tools. Their names have the prefix ${PREFIX}. Your final text is not the result.`,
      '--mcp-config', configPath, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--tools', '',
      '--allowedTools', `${PREFIX}*`, '--disallowedTools', REVIEWER_CLI_TOOL_DENY.join(','), '--disable-slash-commands', '--effort', input.reviewer.effort ?? 'low'];
    if (input.reviewer.model) args.push('--model', input.reviewer.model);
    if (input.reviewer.maxBudgetUsd != null) args.push('--max-budget-usd', String(input.reviewer.maxBudgetUsd));
    const invocation = buildReviewerInvocation(launchPlan, args, hostAdapter);
    const output = fs.createWriteStream(path.join(worker.outputDir, `cli-stream-${attempt}.jsonl`), { flags: 'wx', mode: 0o600 });
    const decoder = new StringDecoder('utf8'); let buffer = '', stderr = '', fault = null;
    const abort = () => stop(); controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise((resolve, reject) => {
        stopping = false; treeStopped = Promise.resolve();
        child = spawn(invocation.executable, invocation.args, { cwd: worker.cwd, env: withAgentOutputEnvironment(env, worker.maxTokens),
          windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        child.once('error', reject);
        const pipeError = () => { fault = failure('REVIEWER_PIPE_FAILED', 'Stop CLI output pipe failed before settlement'); stop(); };
        child.stdout?.on('error', pipeError); child.stderr?.on('error', pipeError);
        const frame = line => {
          if (!line.trim()) return;
          try {
            const value = JSON.parse(line);
            observer.frame(value);
            if (observer.sessionId) {
              if (sessionId && sessionId !== observer.sessionId) throw failure('REVIEWER_SESSION_CHANGED', 'CLI resumed a different review session');
              sessionId = observer.sessionId;
            }
            if (value.type === 'result') envelopes.push({ sessionId, usage: value.usage ?? null, costUsd: value.total_cost_usd ?? null, durationMs: value.duration_ms ?? null });
            if (worker.isComplete()) stop();
          } catch (error) { if (!(error instanceof SyntaxError)) { fault = error; stop(); } }
        };
        child.stdout?.on('data', bytes => {
          output.write(bytes); buffer += decoder.write(bytes);
          if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fault = failure('REVIEWER_STREAM_INVALID', 'A CLI stream frame exceeds the response boundary'); stop(); return; }
          for (let index; (index = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); frame(line); }
        });
        child.stderr?.on('data', bytes => { if (stderr.length < 8000) stderr += bytes.toString('utf8').slice(0, 8000 - stderr.length); });
        child.once('close', code => { buffer += decoder.end(); if (buffer.trim()) frame(buffer); resolve({ code }); });
        if (controller.signal.aborted) stop();
      });
      active(); if (fault) throw fault;
      if (!worker.isComplete() && result.code !== 0) throw failure('REVIEWER_RUN_FAILED', `Stop CLI exited before saving its checklist (code ${result.code}).`);
      if (!sessionId) throw failure('REVIEWER_SESSION_ID_MISSING', 'Stop CLI did not establish a private session');
    } finally {
      let cleanupTimer;
      try { await Promise.race([treeStopped, new Promise(resolve => { cleanupTimer = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(cleanupTimer); }
      clearTimeout(killTimer); child = null; controller.signal.removeEventListener('abort', abort);
      await new Promise(resolve => output.end(resolve));
      await closeServer(); await fsp.rm(configPath, { force: true });
    }
  }
  async function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); parent?.removeEventListener('abort', cancel);
    controller.abort(failure('REVIEW_TASK_CLOSED', 'Stop CLI session closed')); stop(); await closeServer();
  }
  return { run, active, close, deadlineAt, signal: controller.signal, get sessionId() { return sessionId; }, envelopes };
}
