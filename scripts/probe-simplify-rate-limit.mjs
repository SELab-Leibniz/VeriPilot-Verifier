import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSimplifyProvider } from './helpers/simplify-native-evaluation.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, 'limited-at': { type: 'string' }, 'openclaw-profile': { type: 'string' } } });
const interval = 30 * 60_000, stopAfter = 6 * 60 * 60_000;
const first = Date.parse(values['limited-at'] ?? '');
if (!values.output || !values['openclaw-profile'] || !Number.isFinite(first) || first >= Date.now())
  throw new Error('Supply a probe directory, profile, and first rate-limited timestamp.');
const directory = path.resolve(values.output);
await fs.mkdir(directory, { recursive: true });
const start = Date.now(), slot = Math.floor((start - first) / interval);
if (start >= first + stopAfter) throw new Error('Six hours elapsed without observed provider recovery.');
const previous = (await fs.readdir(directory)).filter(file => /^probe-\d+\.started$/u.test(file));
const latest = Math.max(first, ...await Promise.all(previous.map(async file =>
  Number(await fs.readFile(path.join(directory, file), 'utf8')))));
if (!Number.isFinite(latest) || start - latest < interval) throw new Error('A new probe must be at least 30 minutes after the previous request.');
const { provider, credential } = await resolveSimplifyProvider('host-profile', 'deepseek-v4-flash', values['openclaw-profile']);
const record = path.join(directory, `probe-${slot}`);
await fs.writeFile(`${record}.started`, String(start), { flag: 'wx' });
let status = null, usage = null;
try {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential()}` },
    body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'Respond with OK.' }], max_tokens: 16 }),
  });
  status = response.status;
  if (response.ok) {
    const value = (await response.json()).usage?.total_tokens;
    if (Number.isSafeInteger(value) && value > 0) usage = value;
  } else await response.body?.cancel();
} catch { /* A transport failure does not establish recovery. */ }
const result = { startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString(), status, modelRequests: 1, tokens: usage };
await fs.writeFile(`${record}.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status }));
process.exitCode = status >= 200 && status < 300 ? 0 : 1;
