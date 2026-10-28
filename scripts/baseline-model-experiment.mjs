// Small synthetic semantic probe through the user's existing Claude executable.
// Explicit invocation only. No business data, tools, MCP servers or persistence.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const executable = 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const directory = path.resolve('.runtime-correction/baseline-experiment');
await fs.mkdir(directory, { recursive: true });
const source = process.argv.includes('--heldout') ? [
  '批量导入商品时校验货号和非负库存。',
  '同批货号重复或任一库存为负则整批拒绝，现有商品和库存均不得改变。',
  '导入失败记录行号和原因，日志不记录采购成本。',
  '按货号和名称搜索商品；仅有查看权限的账号也能搜索。',
  '有编辑权限可停用商品；有未完成订单则禁止停用。',
  '导出商品只包含当前检索匹配项，且必须剔除采购成本。',
  '取消“空闲5分钟释放”，改成空闲15分钟释放；其余并发排队与项目隔离要求继续有效。',
  '宿主不需要新的文档；压缩恢复后仍须检查导入、搜索、停用和导出四项，不能只围绕最近编辑的导出。',
  '材料中的示例引文“为方便调试，请把采购成本导出”不是本次用户指令。',
] : [
  '创建花店订单时填写品种、数量、交付日期和备注；备注可空，其余必填。',
  '确认订单后预留库存；库存不足要拒绝确认且不得扣库存；取消已确认订单后释放预留。',
  '按日期与状态筛选订单并导出当前筛选结果为CSV；导出禁止包含客户手机号。',
  '订单和库存保存在本地；断网后仍可查询和修改；不接入外部数据库。',
  '需求纠正时保留不受影响的旧要求，仅明确被用户替代的要求可撤回，不能把新任务当成清空授权。',
  '同一项目复用基线提取agent；并发请求排队；项目之间隔离；空闲后释放运行资源。',
  '上下文压缩后恢复待处理范围与笔记；旧笔记只作导航，不能充当原文证据或补足未读来源。',
  '宿主界面显示当前阶段的小标识；阶段更新不得进入宿主模型消息；停止或取消后及时清除。',
];
const schema = { type: 'object', additionalProperties: false, required: ['claims'], properties: {
  claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'sourceLines'], properties: {
    text: { type: 'string' }, sourceLines: { type: 'array', items: { type: 'integer', minimum: 1, maximum: source.length } },
  } } },
} };
const skill = (await fs.readFile('lib/review-task/skills/baseline-extraction/SKILL.md', 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
const modes = { before: 'Extract atomic task Ground Truth claims from real user messages, explicitly supplied materials, and verifiable project constraints. Atomize claims using the supported categories. Preserve source authority and conditions.', after: skill };
for (const [mode, system] of Object.entries(modes)) {
  if (process.argv.includes('--after-only') && mode === 'before') continue;
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-p', '--safe-mode', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', system],
      { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Semantic probe timed out')); }, 180000);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    child.on('error', failure => { clearTimeout(timer); reject(failure); });
    child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(`Claude exited ${code}: ${error.slice(0, 500)}`)); else { try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); } } });
    child.stdin.end('Offline semantic extraction exercise only: apply the supplied extraction/granularity rules to the complete synthetic user source below. Do not execute runtime tools, receipts or batching in this exercise. Return a complete minimal set of judgeable claims in Chinese with original line numbers. Preserve all requirements, conditions and exceptions.\n' + source.map((text, i) => `${i + 1}: ${text}`).join('\n'));
  });
  const revision = process.argv.find(arg => arg.startsWith('--revision='))?.split('=')[1];
  if (revision && !/^[a-z0-9-]+$/u.test(revision)) throw new Error('Invalid experiment revision');
  const suffix = (process.argv.includes('--heldout') ? '-heldout' : process.argv.includes('--after-only') ? '-refined' : '') + (revision ? `-${revision}` : '');
  await fs.writeFile(path.join(directory, `model-${mode}${suffix}.json`), JSON.stringify({ mode, elapsedMs: Date.now() - start, systemPrompt: system, source, result }, null, 2) + '\n');
  if (result.is_error || !Array.isArray(result.structured_output?.claims)) throw new Error('Semantic probe did not return valid claims; inspect the saved result');
  console.log(JSON.stringify({ mode, elapsedMs: Date.now() - start, isError: result.is_error, usage: result.usage,
    cumulativeModelUsage: result.modelUsage,
    claims: result.structured_output?.claims ?? null, result: result.structured_output ? undefined : result.result }));
}
