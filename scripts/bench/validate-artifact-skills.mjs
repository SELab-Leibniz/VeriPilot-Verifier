import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
// Use the read-only installed host's actual YAML dependency, not the RC policy
// subset parser: a syntactically invalid Skill must fail before any model call.
export async function validateArtifactSkills(artifact, hostRoot) {
  const { parse } = createRequire(path.join(hostRoot, 'package.json'))('yaml');
  const records = [];
  async function visit(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name === 'SKILL.md') {
        const text = await fs.readFile(file, 'utf8'), match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
        if (!match) throw new Error(`Skill frontmatter missing: ${file}`);
        let metadata;
        try { metadata = parse(match[1]); } catch (error) { throw new Error(`Invalid Skill YAML: ${file}: ${error.message}`); }
        if (typeof metadata?.name !== 'string' || typeof metadata?.description !== 'string') throw new Error(`Skill identity missing: ${file}`);
        records.push({ file: path.relative(artifact, file).replaceAll('\\', '/'), name: metadata.name });
      }
    }
  }
  await visit(path.join(artifact, 'skills'));
  return records;
}
