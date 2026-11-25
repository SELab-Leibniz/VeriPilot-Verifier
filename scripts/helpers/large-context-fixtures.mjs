import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const sourceName = index => 'src/stage-' + index + '.mjs';
const windowsPath = String.raw`C:\workspace\specflow\apps\inventory\openspec\changes`;
const rowId = (stage, row) => 'SDD-' + stage + '-' + String(row).padStart(4, '0');
const workflowRules = [
  '只有审批记录匹配当前版本时才允许发布变更，其他情况下保留草稿并说明待确认项。',
  '校验失败后保留原来的清单与状态，重新执行前先核对输入版本和关联的验收记录。',
  '当多个模块同时更新时，按依赖顺序运行检查，最后报告各阶段的完成状态和具体原因。',
  '关闭变更之前核对原始提案、设计、规范、任务和测试结果，确认每条已激活的验收条件。',
  '生成的交付记录需要保存阶段、责任角色、输入版本和验收结果，供下一次恢复使用。',
  '读取上一次运行的结果时，确认它属于当前提案，补齐缺失步骤后再更新验收状态。',
  '同时保留第一次运行和重试的记录。查阅日志时按阶段索引定位对应的文件及实际输出。',
  '遇到可选验证条件时，先记录适用理由。暂时缺少依赖时，报告当前影响范围和待验证内容。',
  '当审批撤销或者输入变更时，重新建立受影响的验收记录，并把旧结果保留在历史视图中。',
  '输出文件使用约定的命名规范。对现有调用者保留旧的读取接口和错误状态映射。',
  '审核阶段逐条核对约束条件，确认失败后的恢复动作能够保留现存数据并停止后续步骤。',
  '变更完成后按已有工程约定存放报告，保留命令退出码与整理过的执行记录。',
];
const entities = ['入库规则', '库存预警', '履约计划', '批次记录', '调度时间', '配送窗口', '归档模板', '退货凭据'];

export function chineseText(lines, stage = 1) {
  return Array.from({ length: lines }, (_, row) =>
    '关于' + entities[(row + stage * 3) % entities.length] + '的第' + rowId(stage, row) + '项说明，'
      + workflowRules[(row * 5 + stage) % workflowRules.length]).join('\n');
}

function requirements(lines, stage = 0) {
  return '逐阶段执行 SDD 工作流并保持变更状态可恢复。\n实际运行对应的验收检查并保留输出与退出码。\n'
    + Array.from({ length: lines }, (_, row) => {
      const id = rowId(stage, row);
      return '### ' + id + ' ' + workflowRules[row % workflowRules.length] + ' Input contract: '
        + windowsPath + String.raw`\fulfillment\specs` + '\\' + id + '.json. Complete proposal, design, specs, tasks and verification.';
    }).join('\n') + '\n';
}

export function sourceText(stage, lines) {
  return Array.from({ length: lines }, (_, row) => {
    const id = rowId(stage, row);
    return 'export const stage_' + stage + '_case_' + row + ' = Object.freeze({id:"' + id
      + '",check:(record)=>record?.revision===record?.expected && record?.status==="approved",next:"verify",trace:'
      + JSON.stringify(windowsPath + '\\' + id + String.raw`\artifacts\verification.jsonl`) + '});';
  }).join('\n') + '\n';
}

export function executionText(stage, lines) {
  return Array.from({ length: lines }, (_, row) => {
    const id = rowId(stage, row);
    const root = windowsPath + '\\' + id;
    return JSON.stringify({ test: id, actual: { stage: 'openspec-verify', exitCode: 0, resolved: root + String.raw`\tasks.md` },
      expected: { ordered: true, revision: row }, argv: ['node', '--test', root + String.raw`\test\workflow.test.mjs`] });
  }).join('\n') + '\n';
}

// Boundary case: synthetic console paths with single-digit components and
// compact machine identifiers. Ordinary source and logs are measured separately.
export function denseText(lines, stage = 0) {
  return Array.from({ length: lines }, (_, row) => {
    const seed = createHash('sha256').update(stage + ':' + row).digest();
    const file = 'C:' + [...seed].map(value => '\\' + (value % 10)).join('');
    return file + '\t' + JSON.stringify({ i: row, s: stage, state: 'ok', job: seed.subarray(0, 12).toString('base64url') });
  }).join('\n') + '\n';
}

export async function createRepository(root) {
  const repo = path.join(root, 'repo');
  const unrelated = path.join(repo, 'packages', 'legacy');
  await fs.mkdir(unrelated, { recursive: true });
  await fs.mkdir(path.join(repo, 'src'));
  await fs.mkdir(path.join(repo, 'contracts'));
  const tracked = [];
  const write = async (file, text) => {
    await fs.writeFile(path.join(repo, file), text);
    tracked.push({ file, bytes: Buffer.byteLength(text) });
  };
  const packageCount = 32, perPackage = 48;
  for (let group = 0; group < packageCount; group++) {
    const dir = 'packages/legacy/pkg-' + group;
    await fs.mkdir(path.join(repo, dir));
    await Promise.all(Array.from({ length: perPackage }, (_, file) => write(dir + '/module-' + file + '.ts',
      '// UNRELATED_SDD_BENCHMARK_MODULE\n' + sourceText(group * perPackage + file, 42))));
  }
  await write('src/small.mjs', sourceText(0, 3));
  for (let stage = 1; stage <= 18; stage++) await write(sourceName(stage), sourceText(stage, 154));
  for (let stage = 1; stage <= 7; stage++) await write('src/dense-' + stage + '.log', denseText(stage === 7 ? 185 : 297, stage));
  await write('contracts/short.md', requirements(3));
  await write('contracts/workflow.md', requirements(220));
  await write('contracts/page-probe.md', ('All lines remain in the original delivery contract.\n' + sourceText(9, 180)));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--template=');
  git('-c', 'core.autocrlf=false', 'add', '.');
  git('-c', 'user.name=Local SDD Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=nonexistent',
    'commit', '--quiet', '-m', 'Synthetic SDD workspace');
  return { repo, trackedFiles: tracked.length, trackedBytes: tracked.reduce((sum, file) => sum + file.bytes, 0),
    unrelatedModules: packageCount * perPackage };
}

export function businessSnapshot(specFile, executions) {
  const entries = [{ type: 'user', uuid: 'original-user', message: { content:
    '按 SDD 依次完成提案、设计、规范、任务和验证。保持工作流状态可恢复，并保留每次验收的执行结果。完整原始约束见 ' + specFile + '。' } }];
  for (let stage = 1; stage <= executions; stage++) {
    const id = 'workflow-stage-' + stage;
    entries.push(
      { type: 'assistant', uuid: 'invocation-' + stage, message: { content: [
        { type: 'tool_use', name: 'exec', id, input: { command: 'node --test test/workflow-' + stage + '.mjs' } },
      ] } },
      { type: 'user', uuid: 'result-' + stage, message: { content: [
        { type: 'tool_result', tool_use_id: id, is_error: false, content: executionText(stage, 92) + '\nProcess exited with code 0.' },
      ] } },
    );
  }
  entries.push({ type: 'assistant', uuid: 'final-assistant', message: { content: 'SDD 产物已经提交，验证记录已保留。' } });
  return { entries };
}
