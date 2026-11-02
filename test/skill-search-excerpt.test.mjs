import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSkillDirectory } from '../lib/runtime-v2/skill-source.mjs';
import { createSkillCare } from '../lib/runtime-v2/skill-care.mjs';

const cases = [
  { name: 'short line with omitted prefix', line: 'p'.repeat(250) + 'NEEDLE' + 'z'.repeat(5), excerptOnly: true },
  { name: 'suffix omitted', line: 'NEEDLE' + 's'.repeat(500), excerptOnly: true },
  { name: 'both sides omitted', line: 'p'.repeat(500) + 'NEEDLE' + 's'.repeat(500), excerptOnly: true },
  { name: 'complete short line', line: 'before NEEDLE after', excerptOnly: false },
  { name: 'exactly 400 characters without omission', line: 'NEEDLE' + 'f'.repeat(394), excerptOnly: false },
];
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-skill-excerpt-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = '# Captured Skill\n' + cases.map(c => c.line).join('\n') + '\n';
  await fs.writeFile(path.join(root, 'SKILL.md'), content);
  const skillSource = await scanSkillDirectory(root, { cache: false });
  const care = await createSkillCare({ projectRoot: root, taskId: 'excerpt-control', request: { watcher: { skillId: 'captured' } }, evidence: { skillSource } });
  return { care, content };
}

for (const [index, fixtureCase] of cases.entries()) test(`Skill search labels actual omission: ${fixtureCase.name}`, async t => {
  const { care } = await fixture(t);
  const page = await care.execute({ action: 'search', prefix: 'skill/', query: 'needle', offset: index, limit: 1 });
  const item = page.items[0];
  assert.equal(item.line, index + 2);
  assert.equal(item.excerptOnly, fixtureCase.excerptOnly);
  assert.equal(item.excerpt === fixtureCase.line, !fixtureCase.excerptOnly);
  assert(item.excerpt.length <= 400);
  assert(fixtureCase.line.includes(item.excerpt)); assert.match(item.excerpt, /NEEDLE/u);
});

test('Skill excerpt flags survive pagination and explicit read restores the captured original', async t => {
  const { care, content } = await fixture(t), items = [];
  let offset = 0;
  do {
    const page = await care.execute({ action: 'search', prefix: 'skill/', query: 'needle', offset, limit: 2 });
    items.push(...page.items); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(items.map(item => item.excerptOnly), cases.map(item => item.excerptOnly));
  assert.deepEqual(items.map(item => item.line), [2, 3, 4, 5, 6]);
  let restored = ''; offset = 0;
  do {
    const page = await care.execute({ action: 'read', id: 'skill/SKILL.md', offset, limit: 130 });
    restored += page.content; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(restored, content);
});
