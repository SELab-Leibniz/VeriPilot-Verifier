// Controlled CLI that uses the real stdio MCP bridge and emits host frames.
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), brief = JSON.parse(args[0]);
const prior = args.indexOf('--resume') >= 0 ? args[args.indexOf('--resume') + 1]
  : args.indexOf('--sessions') >= 0 ? args[args.indexOf('--sessions') + 1] : null;
const sessionId = prior ?? randomUUID(), mode = process.env.RC_TEST_CLI_MODE;
const frame = value => process.stdout.write(JSON.stringify({ ...value, session_id: sessionId }) + '\n');
frame({ type: 'system', subtype: 'init' });
const config = JSON.parse(await fs.readFile(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.rc_stop;
const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
if (process.env.RC_TEST_CLI_CAPTURE) await fs.appendFile(process.env.RC_TEST_CLI_CAPTURE,
  JSON.stringify({ sessionId, prior, pid: process.pid, bridgePid: child.pid, args: args.filter(arg => !arg.includes('RC_STOP_BRIDGE_TOKEN')) }) + '\n');
const waiting = new Map(); let sequence = 0;
readline.createInterface({ input: child.stdout }).on('line', line => {
  const response = JSON.parse(line), item = waiting.get(response.id); waiting.delete(response.id);
  if (response.error) item.reject(new Error(response.error.message)); else item.resolve(response.result);
});
child.on('error', error => { for (const item of waiting.values()) item.reject(error); });
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; waiting.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
async function invoke(name, arguments_) {
  const id = randomUUID(); frame({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id, name: `mcp__rc_stop__${name}`, input: arguments_ }] } });
  const result = await rpc('tools/call', { name, arguments: arguments_ });
  let content = result.content;
  if (mode === 'truncate' && name === 'source_read' && arguments_.path === process.env.RC_TEST_CLI_ARTIFACT)
    content = [{ type: 'text', text: content[0].text.split('\n')[0] }];
  if (!(mode === 'unobserved' && name === 'source_read' && arguments_.path === process.env.RC_TEST_CLI_ARTIFACT))
    frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: result.isError === true }] } });
  return result;
}
const text = result => result.content.map(block => block.text).join('');
const call = async (name, value) => {
  const result = await invoke(name, value); if (result.isError) throw new Error(text(result)); return JSON.parse(text(result));
};
async function read(file) {
  let offset = 1, citeId;
  do {
    const result = await invoke('source_read', { path: file, offset });
    if (result.isError) throw new Error(text(result));
    citeId = /^\[citeId="([a-z_]+)"/u.exec(text(result))[1];
    offset = JSON.parse(/\[RC page (\{[^\n]+\})\]$/u.exec(text(result))[1]).nextOffset;
  } while (offset !== null);
  return citeId;
}
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'controlled-cli', version: '1' }, capabilities: {} });
  await rpc('tools/list');
  if (mode === 'hang') await new Promise(resolve => setTimeout(resolve, 30000));
  if (brief.attempt === 1) {
    for (const file of brief.task.basisFiles) await read(file);
    if (mode !== 'compact') {
      await call('review_scope', { stopClassification: 'TASK_COMPLETE', completionClaim: true, summary: 'The original output claims completion.' });
      await call('review_plan', { steps: [{ text: 'Inspect the actual delivery and its external reference.', status: 'active' }] });
      await call('review_notes', { note: 'The original checklist remains authoritative.' });
    }
  } else {
    await call('review_history', { mode: 'state' }); await call('review_notes', {});
  }
  if (process.env.RC_TEST_CLI_EXTERNAL) await read(process.env.RC_TEST_CLI_EXTERNAL);
  const checklist = await call('review_checklist', { limit: 20, ...(mode === 'compact' ? { stopClassification: 'TASK_COMPLETE', completionClaim: true } : {}) });
  let saved = 0;
  for (const item of checklist.items.filter(item => !item.savedResult)) {
    const citeId = await read(process.env.RC_TEST_CLI_ARTIFACT);
    const result = await invoke('submit_review', { taskId: item.taskId, verdict: 'PASS', reason: 'The actual delivery supports this original obligation.', citeIds: [citeId], ...(mode === 'compact' ? { finish: true } : {}) });
    if (result.isError) await call('submit_review', { taskId: item.taskId, verdict: 'UNVERIFIED', reason: 'The original read was not demonstrably disclosed.', citeIds: [] });
    if (mode === 'resume' && brief.attempt === 1 && ++saved === 1) break;
  }
  if (mode !== 'compact' && !(mode === 'resume' && brief.attempt === 1)) await call('finish_stop_review', { summary: 'Every assigned item has a saved independent result.' });
  frame({ type: 'result', usage: { input_tokens: 100, output_tokens: 30 }, total_cost_usd: 0 });
} finally { child.stdin.end(); }
