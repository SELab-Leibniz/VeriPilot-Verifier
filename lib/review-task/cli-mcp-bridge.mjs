// Stdio transport for one private CLI review. The parent owns tool execution,
// source receipts and lifetime; this process only forwards MCP messages.
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export function bridgeRequest(endpoint, token, payload) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const request = http.request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'content-length': bytes.length }, timeout: 15000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(new Error('Review response too large')); else chunks.push(chunk); });
      response.on('end', () => {
        try { if (response.statusCode !== 200) throw new Error('Private review bridge unavailable'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Private review bridge timed out')));
    request.end(bytes);
  });
}

export async function runMcpBridge({ endpoint = process.env.RC_STOP_BRIDGE_URL, token = process.env.RC_STOP_BRIDGE_TOKEN,
  input = process.stdin, output = process.stdout } = {}) {
  if (!endpoint || !token || new URL(endpoint).hostname !== '127.0.0.1') throw new Error('A private local review bridge is required');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  const send = value => output.write(JSON.stringify(value) + '\n');
  async function dispatch(line) {
    let request;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('MCP request too large');
      request = JSON.parse(line);
      if (!Object.hasOwn(request, 'id')) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'runtime-corrector-stop', version: '1.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = await bridgeRequest(endpoint, token, { method: 'list' });
      else if (request.method === 'tools/call') {
        const response = await bridgeRequest(endpoint, token, { method: 'call', name: request.params?.name, arguments: request.params?.arguments ?? {} });
        result = { content: response.content, ...(response.isError ? { isError: true } : {}) };
      } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported private review method' } }); return; }
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: 'Private review bridge request failed' } });
    }
  }
  for await (const line of lines) {
    if (!line.trim()) continue;
    const work = dispatch(line); pending.add(work); void work.finally(() => pending.delete(work));
  }
  await Promise.allSettled(pending);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runMcpBridge().catch(() => { process.exitCode = 1; });
