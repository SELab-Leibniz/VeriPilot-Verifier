#!/usr/bin/env node
// Read-only verification of the exact plugin bytes used by live acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv.find(arg => arg.startsWith('--root='))?.slice(7)
  ?? path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'artifact-manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
  throw new Error('Invalid delivery manifest.');
const prefix = 'runtime-corrector-openclaw/';
const expected = new Map();
for (const record of manifest.files) {
  if (typeof record.path !== 'string' || !record.path.startsWith(prefix) || record.path.includes('\\')
    || record.path.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{64}$/u.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0
    || expected.has(record.path)) throw new Error('Invalid or duplicate artifact file record.');
  expected.set(record.path, record);
}
let checked = 0;
async function visit(relative) {
  const directory = path.join(root, relative);
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`Not a regular directory: ${relative}`);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await visit(name);
    else {
      if (!entry.isFile()) throw new Error(`Unsupported artifact entry: ${name}`);
      const record = expected.get(name);
      if (!record) throw new Error(`Unexpected artifact file: ${name}`);
      const content = await fs.readFile(path.join(root, name));
      if (content.length !== record.bytes || createHash('sha256').update(content).digest('hex') !== record.sha256)
        throw new Error(`Artifact checksum mismatch: ${name}`);
      checked++;
    }
  }
}
await visit('runtime-corrector-openclaw');
if (checked !== expected.size) throw new Error(`Missing artifact files: expected ${expected.size}, found ${checked}`);
console.log(JSON.stringify({ verification: 'PASS', checkedFiles: checked, runtimeSource: manifest.runtimeSource,
  note: 'File integrity only; live acceptance is recorded separately in acceptance-summary.json.' }));
