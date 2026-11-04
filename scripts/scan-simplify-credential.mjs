import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { countProfileCredentialMatches, resolveSimplifyProvider } from './helpers/simplify-native-evaluation.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'openclaw-profile': { type: 'string' }, output: { type: 'string' } } });
if (!values['openclaw-profile'] || !positionals.length) throw new Error('Supply the DeepSeek profile and explicit evidence paths.');
const { credential } = await resolveSimplifyProvider('host-profile', 'deepseek-v4-flash', values['openclaw-profile']);
const key = credential();
let matches = 0;
for (const file of positionals) {
  if ((await fs.stat(file)).isDirectory()) matches += await countProfileCredentialMatches(file, credential);
  else {
    const bytes = await fs.readFile(file);
    if (bytes.includes(Buffer.from(key)) || bytes.includes(Buffer.from(key, 'utf16le'))) matches++;
  }
}
if (values.output) await fs.writeFile(values.output, `${JSON.stringify({ matches })}\n`, { flag: 'wx' });
console.log(JSON.stringify({ matches }));
process.exitCode = matches ? 1 : 0;
