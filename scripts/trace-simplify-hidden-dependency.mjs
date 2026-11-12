import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readProviderTiming } from './helpers/simplify-native-evaluation.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' } } });
if (!values.output || !positionals.length) throw new Error('Supply --output and one or more screening batch directories.');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const lines = async file => (await fs.readFile(file, 'utf8')).split(/\r?\n/u).filter(Boolean).map(JSON.parse);

async function transcripts(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await transcripts(file));
    else if (entry.name === 'host-session.jsonl') files.push(file);
  }
  return files;
}

const evidence = [];
for (const batch of positionals) for (const id of await fs.readdir(batch)) {
  if (!/^(?:r1-hidden-dependency-[1-3]|b15-hidden-dependency)-(?:b1|b12)$/u.test(id)) continue;
  const observed = await read(path.join(batch, id, 'observation.json'));
  if (observed.frameworkError || observed.state === 'rate-limited') continue;
  const evaluation = path.dirname(observed.evidence);
  const sample = (await fs.readdir(evaluation)).find(name => name.startsWith('sample-'));
  const native = path.join(evaluation, sample, 'native-host');
  const timing = await readProviderTiming(native);
  const origin = Date.parse(timing.find(row => row.event === 'request')?.startedAt);
  const counts = new Map(), signatures = new Map(), readCounts = new Map();
  let toolCalls = 0, toolErrors = 0, firstReadMs = null, reportCalls = 0, assistantFinals = 0;
  const firstRead = target => target.replaceAll('\\', '/').endsWith('lib/calc.mjs');
  for (const file of await transcripts(path.join(evaluation, sample, 'project'))) {
    const records = await lines(file), completed = new Map(records.filter(row => row.message?.role === 'toolResult')
      .map(row => [row.message.toolCallId, row]));
    for (const row of records.filter(row => row.message?.role === 'assistant')) {
      const calls = (row.message.content ?? []).filter(item => item.type === 'toolCall');
      if (!calls.length && row.message.stopReason === 'stop') assistantFinals++;
      for (const call of calls) {
        toolCalls++;
        counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
        const signature = JSON.stringify([call.name, Object.entries(call.arguments ?? {}).sort(([left], [right]) => left.localeCompare(right))]);
        signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
        if (/report|submit/u.test(call.name)) reportCalls++;
        const terminal = completed.get(call.id);
        if (terminal?.message?.isError === true) toolErrors++;
        const target = call.arguments?.path;
        if (call.name === 'source_read' && typeof target === 'string' && firstRead(target)) {
          readCounts.set('lib/calc.mjs', (readCounts.get('lib/calc.mjs') ?? 0) + 1);
          const time = Date.parse(terminal?.timestamp) - origin;
          if (terminal && terminal.message.isError !== true && Number.isFinite(time) && time >= 0)
            firstReadMs = firstReadMs === null ? time : Math.min(firstReadMs, time);
        }
      }
    }
  }
  evidence.push({ id, state: observed.state, rcElapsedMs: observed.rcElapsedMs, modelRequests: observed.modelRequests,
    toolCalls, toolErrors, repeatedCalls: [...signatures.values()].reduce((total, count) => total + count - 1, 0),
    callsByTool: Object.fromEntries(counts), dependencyReadCalls: readCounts.get('lib/calc.mjs') ?? 0,
    firstSuccessfulDependencyReadMs: firstReadMs, reportCalls, assistantFinals, sentFeedback: observed.repairFeedback });
}
await fs.writeFile(values.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ records: evidence.length }));
