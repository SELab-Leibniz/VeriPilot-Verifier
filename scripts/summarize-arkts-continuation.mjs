import fs from 'node:fs/promises';
import path from 'node:path';
import { continuationUsage } from './bench/continuation-usage.mjs';
import { businessCompleted } from './bench/business-completion.mjs';
const value = process.argv.find(arg => arg.startsWith('--run='))?.slice(6);
if (!value) throw new Error('--run=<captured continuation directory> required');
const directory = path.resolve(value);
const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
if (!['SETTLED', 'INCOMPLETE'].includes(result.state)) throw new Error('Only captured terminal runs can be summarized');
const evidence = JSON.parse(await fs.readFile(path.join(directory, 'resume-evidence.json'), 'utf8'));
if (result.sessionId !== evidence.sessionId || result.sessionKey !== evidence.sessionKey) throw new Error('Continuation session identity mismatch');
const report = { instanceId: result.instanceId, runId: result.originalRunId,
  infrastructureComplete: result.infrastructureComplete,
  businessCompleted: result.officialBusinessTerminal ? businessCompleted(result.officialBusinessTerminal, result.finalBusinessRunId ?? result.originalRunId) : null,
  completionAuthority: result.officialBusinessTerminal ? 'agent.wait' : 'Legacy capture lacks an authoritative terminal; diagnostic success is insufficient.',
  ...continuationUsage({ transcript: await fs.readFile(evidence.restored),
    restoredSource: await fs.readFile(evidence.source), sourceSha256: evidence.sourceSha256 }) };
await fs.writeFile(path.join(directory, 'continuation-usage.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
