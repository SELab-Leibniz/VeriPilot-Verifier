import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] ?? 'dist/runtime-corrector-openclaw');
const forbidden = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'];
let manifests = 0, modules = 0;
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Artifact must not borrow an external installation: ${file}`);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name === 'package.json' || entry.name === 'package-lock.json') {
      const document = JSON.parse(await fs.readFile(file, 'utf8')); manifests++;
      assert(!forbidden.includes(document.name), `Forbidden installed package: ${file}`);
      for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'])
        for (const name of forbidden) assert(!Object.hasOwn(document[kind] ?? {}, name), `Forbidden dependency in ${file}`);
      for (const name of Object.keys(document.packages ?? {}))
        for (const dependency of forbidden) assert(!name.endsWith(`node_modules/${dependency}`), `Forbidden locked package in ${file}`);
    } else if (/\.[cm]?js$/u.test(entry.name) && !file.includes(`${path.sep}node_modules${path.sep}`)) {
      const source = await fs.readFile(file, 'utf8'); modules++;
      const imports = [...source.matchAll(/\b(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu)].map(match => match[1]);
      assert(!imports.some(name => forbidden.some(dependency => name === dependency || name.startsWith(dependency + '/'))), `Forbidden runtime import in ${file}`);
    }
  }
}
await walk(root);
await assert.rejects(fs.stat(path.join(root, 'lib/review-task/sdk.mjs')), { code: 'ENOENT' });
process.stdout.write(JSON.stringify({ status: 'PASS', artifact: root, manifests, modules, forbiddenPackages: [] }, null, 2) + '\n');
