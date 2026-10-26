// Source protocol shared by extraction tasks and acceptance workers. Only a
// genuine host persistence receipt grants coverage; telemetry cannot do so.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSourceTools, toolText, textBlocks } from './source-tools.mjs';
import { captureFiles, covers, disclosedRange, registerCitation } from './review-task.mjs';
import { sha256 } from '../runtime-v2/utils.mjs';

export async function durableTaskJson(file, value, active = () => {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { active(); await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function createTaskEvidence({ root, signal, active, journal, onTool = () => {} }) {
  const snapshot = await captureFiles(root, { signal }), reads = [], registry = new Map(), pending = new Map();
  const metrics = { toolCalls: 0, readBytes: 0, totalToolBytes: 0, repeatedLines: 0 };
  const tools = createSourceTools(root, snapshot).map(tool => ({ ...tool, name: `source_${tool.name}`,
    async execute(id, args, abort) {
      active(); abort?.throwIfAborted();
      if (typeof id !== 'string' || !id.trim() || pending.has(id)) throw new Error('A unique real tool call id is required');
      const result = await tool.execute(id, args, abort && signal ? AbortSignal.any([abort, signal]) : abort ?? signal);
      active();
      let returned = result, text = toolText(result);
      if (tool.name === 'read' && !result.isError) {
        const absolute = await fs.realpath(path.resolve(root, args.path));
        const file = path.relative(root, absolute).replaceAll('\\', '/'), bytes = await fs.readFile(absolute);
        if (sha256(bytes) !== snapshot.get(file)?.sha256) throw new Error('BASELINE_INPUT_CHANGED');
        const range = disclosedRange(bytes, args, result);
        if (range) {
          const citation = registerCitation({ registry: new Map(), bytes, file, sha256: snapshot.get(file).sha256, range });
          text = `[citeId="${citation.citeId}" | range ${file}:${range.start}-${range.end}]\n${text}`;
          returned = { ...result, content: textBlocks(text), details: { ...result.details, citation } };
          pending.set(id, { citation, text });
        }
      }
      metrics.toolCalls++; metrics.totalToolBytes += Buffer.byteLength(text);
      if (tool.name === 'read') metrics.readBytes += Buffer.byteLength(text);
      journal.appendMessage({ role: 'historical_observation', content: JSON.stringify({ tool: tool.name, args, bytes: Buffer.byteLength(text) }) });
      onTool({ name: tool.name, args });
      return returned;
    },
  }));
  function observeReceipt(event) {
    if (signal?.aborted || event.isSynthetic !== false || event.toolName !== 'source_read') return;
    const expected = pending.get(event.toolCallId), message = event.message;
    if (!expected) return;
    pending.delete(event.toolCallId);
    if (message?.role !== 'toolResult' || message.toolName !== 'source_read' || message.toolCallId !== event.toolCallId
      || message.isError !== false || !message.content?.length || message.content.some(block => block.type !== 'text')
      || toolText(message) !== expected.text) return;
    active();
    const { citation, text } = expected;
    journal.appendMessage({ role: 'toolResult', toolName: 'source_read', toolCallId: event.toolCallId,
      content: [{ type: 'text', text }], isError: false,
      details: { citation, receiptBoundary: 'openclaw.tool_result_persist.v1' } });
    for (let line = citation.start; line <= citation.end; line++) if (covers(reads, citation.path, line, line)) metrics.repeatedLines++;
    reads.push({ path: citation.path, start: citation.start, end: citation.end }); registry.set(citation.citeId, citation);
  }
  async function assertFrozen() {
    active();
    const current = await captureFiles(root, { signal });
    if (sha256([...current]) !== sha256([...snapshot])) throw Object.assign(new Error('Frozen baseline inputs changed'), { code: 'BASELINE_INPUT_CHANGED' });
    active();
  }
  return { tools, snapshot, reads, registry, metrics, observeReceipt, assertFrozen };
}
