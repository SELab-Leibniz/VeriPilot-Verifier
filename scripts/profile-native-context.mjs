// Bounded, content-free context cost inventory from persisted native sessions.
// Print sizes and tool names, never original source text or conversation bodies.
import fs from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv.find(arg => arg.startsWith('--run='))?.slice(6);
if (!directory) throw new Error('--run=<accounted settled run> required');
const usage = JSON.parse(await fs.readFile(path.join(directory, 'usage-summary.json'), 'utf8'));
const sessions = [];
for (const session of usage.sessions) {
  if (session.missing) { sessions.push({ file: session.file, missing: true }); continue; }
  const rows = (await fs.readFile(session.file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const byTool = {}, results = [], inputs = [];
  for (const row of rows) {
    const message = row.message;
    if (message?.role === 'assistant' && message.usage) inputs.push({ input: message.usage.input, cacheRead: message.usage.cacheRead, output: message.usage.output });
    if (message?.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type !== 'toolCall') continue;
      byTool[block.name] ??= { requestedCalls: 0, resultRecords: 0, bytes: 0, errorRecords: 0 };
      byTool[block.name].requestedCalls++;
    }
    if (message?.role !== 'toolResult') continue;
    const bytes = Buffer.byteLength(JSON.stringify(message.content)), name = message.toolName;
    byTool[name] ??= { requestedCalls: 0, resultRecords: 0, bytes: 0, errorRecords: 0 };
    byTool[name].resultRecords++; byTool[name].bytes += bytes; if (message.isError) byTool[name].errorRecords++;
    results.push({ name, bytes, isError: message.isError === true, toolCallId: message.toolCallId });
  }
  sessions.push({ file: session.file, owner: session.owner, byTool, largestResults: results.sort((a, b) => b.bytes - a.bytes).slice(0, 8),
    actualUsageByResponse: inputs, note: 'Requested calls come from assistant toolCall blocks. Result records may include synthetic transcript repair and are not additional tool calls. Tool bytes are not tokenizer counts. Input/cache/output values come directly from the provider.' });
}
await fs.writeFile(path.join(directory, 'context-profile.json'), JSON.stringify({ sessions }, null, 2));
console.log(JSON.stringify(sessions.map(({ owner, byTool }) => ({ owner, byTool }))));
