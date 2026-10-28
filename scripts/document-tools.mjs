#!/usr/bin/env node
// Local CLI and MCP stdio adapter over the same production document tools.
// Transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { createDocumentTools } from '../lib/document-tools.mjs';

const args = process.argv.slice(2), requestFile = args[0];
if (!requestFile) throw new Error('Usage: document-tools.mjs <semantic-request.json> <action-json | --stdio> [deadline-epoch-ms]');
const semantic = JSON.parse(await fs.readFile(requestFile, 'utf8'));
const deadlineAt = Number(args[2] ?? Date.now() + 600000);
if (!Number.isFinite(deadlineAt) || deadlineAt > Date.now() + 3600000) throw new Error('Invalid document tool deadline');
const tools = await createDocumentTools({ projectRoot: semantic.projectRoot, semantic, requestPath: requestFile,
  scopeIdentity: semantic.runtimeV2?.taskId ?? null,
  active() { if (Date.now() >= deadlineAt) throw new Error('DOCUMENT_TOOL_DEADLINE'); } });

if (args[1] !== '--stdio') {
  process.stdout.write(JSON.stringify(await tools.execute(JSON.parse(args[1] ?? '{"action":"manifest"}'))) + '\n');
} else {
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
    if (!Object.hasOwn(request, 'id')) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rc-document', version: '1.0.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: [{ name: tools.tool.name, description: tools.tool.description, inputSchema: tools.tool.parameters }] };
    else if (request.method === 'tools/call' && request.params?.name === tools.tool.name) {
      try { result = await tools.tool.execute(String(request.id), request.params.arguments); }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else { send({ id: request.id, error: { code: -32601, message: 'Unknown method or tool' } }); continue; }
    send({ id: request.id, result });
  }
}
