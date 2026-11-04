#!/usr/bin/env node
// Score a blind human assessment against the preregistered kitchen criteria.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const COMPACTION_RUBRIC = Object.freeze({
  C01: '每道菜谱有稳定且唯一的内部编号。',
  C02: '菜谱名称可以重复，不能用名称代替编号。',
  C03: '首版固定八个单位：克、千克、毫升、升、个、勺、杯、适量。',
  C04: '普通单位的数量必须为正数，允许小数，拒绝自由文本。',
  C05: '适量的数量留空，不能用零代替。',
  C06: '本版本不做单位转换。',
  C07: '删除菜谱级联删除食材、步骤、收藏关联和相关计划项，保留历史做菜记录和已生成的购物清单。',
  C08: '菜谱 JSON 导出包含格式版本、基本信息、分类、标签、食材和步骤，不包含做菜记录，也不修改原数据。',
  C09: '菜谱 JSON 导入先校验整批，任一非法时不部分写入，合法时生成新编号且不覆盖同名菜谱。',
  C10: '数据库损坏时说明原因和文件位置，保留原文件，不自动覆盖或重建。',
});

export function scoreCompaction({ answer, criteria }) {
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Provide the verbatim checkpoint answer.');
  if (!criteria || Object.keys(criteria).length !== Object.keys(COMPACTION_RUBRIC).length)
    throw new Error('Assess each of C01–C10 exactly once.');
  const items = Object.entries(COMPACTION_RUBRIC).map(([id, rule]) => {
    const { met, quotes, rationale } = criteria[id] ?? {};
    if (typeof met !== 'boolean' || typeof rationale !== 'string' || !rationale.trim()
      || !Array.isArray(quotes) || met && !quotes.length
      || quotes.some(quote => typeof quote !== 'string' || !quote.trim() || !answer.includes(quote)))
      throw new Error(`${id} needs a boolean met, a rationale, and verbatim quotes from the answer for credit.`);
    return { id, rule, points: Number(met), quotes, rationale };
  });
  return { answer, score: items.reduce((sum, item) => sum + item.points, 0), maxScore: items.length, items };
}

async function main() {
  const { values } = parseArgs({ options: {
    rubric: { type: 'boolean' }, assessment: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/score-simplify-compaction.mjs --rubric | --assessment <json> [--output <json>]');
    console.log('Assessment: { answer: string, criteria: { C01: { met: boolean, quotes: string[], rationale: string }, ... C10 } }.');
    console.log('Grade the answer blind to the arm. Award one point only when all parts of the criterion are correct. Accept equivalent wording.');
    return;
  }
  if (Boolean(values.rubric) === Boolean(values.assessment)) throw new Error('Choose --rubric or --assessment.');
  const result = values.rubric ? COMPACTION_RUBRIC : scoreCompaction(JSON.parse(await fs.readFile(values.assessment, 'utf8')));
  const output = JSON.stringify(result, null, 2) + '\n';
  if (values.output) await fs.writeFile(values.output, output, { flag: 'wx' });
  else process.stdout.write(output);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
