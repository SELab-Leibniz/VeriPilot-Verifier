#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = (runnerRoot, file) => import(pathToFileURL(path.join(runnerRoot, file)));
export async function collectDemoResult({ runDir, outDir, runnerRoot = path.join(root, 'runner') }) {
  runDir = path.resolve(runDir); outDir = path.resolve(outDir);
  const { json, writeJson, within, hash, filesUnder } = await load(runnerRoot, 'lib/files.mjs');
  const { queryExperimentStatus } = await load(runnerRoot, 'lib/experiment-status.mjs');
  const { privateState } = await load(runnerRoot, 'lib/settlement.mjs');
  if (within(runDir, outDir) || within(outDir, runDir)) throw new Error('Keep shared results outside the private run directory');
  const record = await json(path.join(runDir, 'run.json')), status = await queryExperimentStatus(runDir);
  const result = await json(path.join(runDir, 'result.json'));
  if (status.status !== 'COMPLETED' || !status.canScheduleNext || status.rc.outcome !== 'NO_DEVIATION_FOUND')
    throw new Error('Demo is not a completed, cleaned-up correction cycle; keep the original failure/attention record');
  let injected;
  try { injected = await json(path.join(runDir, 'rc-status/fault-injection.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('No controlled defect receipt; this run did not demonstrate correction');
    throw error;
  }
  const hosts = Object.values(result.host ?? {}), work = await privateState(record);
  if (injected.runId !== record.firstRunId || hosts.length < 2 || hosts.some(v => v.status !== 'ok')
    || !hosts.some(v => v.runId !== record.firstRunId && v.runId.startsWith('rc-stop-'))
    || !work.reviews.some(v => v.runId === record.firstRunId && v.status === 'SETTLED' && v.reviewStatus === 'DEVIATION')
    || !work.reviews.some(v => v.status === 'SETTLED' && v.reviewStatus === 'NO_DEVIATION_FOUND'))
    throw new Error('Missing genuine defect/review/automatic-repair evidence; no success package was exported');
  await fs.mkdir(path.dirname(outDir), { recursive: true }); await fs.mkdir(outDir);
  const project = path.join(outDir, 'project'); await fs.mkdir(project);
  const source = path.join(runDir, 'artifacts/project');
  for (const file of ['quicksort.py', 'test_quicksort.py', 'run_tests.py', 'test-output.txt', 'requirements.md', 'AGENTS.md']) {
    const from = path.join(source, file), stat = await fs.lstat(from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular artifact: ${file}`);
    await fs.copyFile(from, path.join(project, file));
  }
  await fs.copyFile(path.join(runDir, 'rc-status/quicksort.injected.py'), path.join(outDir, 'quicksort.injected.py'));
  await fs.copyFile(path.join(runDir, 'rc-status/quicksort.before-injection.py'), path.join(outDir, 'quicksort.before-injection.py'));
  const { stdout, stderr } = await promisify(execFile)(record.input.paths.python, ['-B', '-m', 'unittest', 'discover', '-v'],
    { cwd: project, windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const testOutput = stdout + stderr;
  const testsRun = Number(testOutput.match(/\bRan (\d+) tests?\b/)?.[1] ?? 0);
  if (!testsRun) throw new Error('No unittest cases executed; no verified demo summary was exported');
  await fs.writeFile(path.join(outDir, 'verification.txt'), testOutput + '\nEXIT_CODE=0\n');
  const timeline = []; let last;
  for await (const line of createInterface({ input: createReadStream(path.join(runDir, 'rc-status/history.jsonl'), { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line), rc = row.rc;
    const key = JSON.stringify([rc.status, rc.phase, rc.stage, rc.runId]);
    if (key === last) continue; last = key;
    timeline.push({ at: row.at, status: rc.status, phase: rc.phase, stage: rc.stage, runId: rc.runId, outcome: rc.outcome });
  }
  const portable = value => typeof value === 'string' ? value.replaceAll(runDir, '<RUN_DIR>') : Array.isArray(value)
    ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,portable(v)])) : value;
  const reviewResults = [];
  for (const file of await filesUnder(path.join(record.identity.projectRoot, '.runtime-correction/tasks'))) {
    if (!file.includes(`${path.sep}evaluations${path.sep}`) || !file.endsWith('.json')) continue;
    const value = await json(file);
    if (!work.reviews.some(review => review.evaluationId === value.evaluationId)) continue;
    const counts = {};
    for (const item of value.reviewCoverage?.items ?? []) counts[item.disposition] = (counts[item.disposition] ?? 0) + 1;
    reviewResults.push({ evaluationId: value.evaluationId, status: value.outcome?.status,
      total: value.reviewCoverage?.total, unverified: value.reviewCoverage?.unverified, judgements: counts });
  }
  const summary = { schemaVersion: 'rc-quicksort-demo-result.v1', verified: true, sourceRunId: record.id,
    startedAt: record.createdAt, finishedAt: record.finishedAt, elapsedMs: Date.parse(record.finishedAt) - Date.parse(record.createdAt),
    models: record.input.models, sessionId: record.identity.sessionId, firstRunId: record.firstRunId,
    experimentStatus: status.status, nativeResultStatus: result.status, rc: { status: status.rc.status, outcome: status.rc.outcome },
    hosts: hosts.map(v => ({ runId: v.runId, status: v.status })),
    reviews: work.reviews.map(v => ({ runId: v.runId, status: v.status, reviewStatus: v.reviewStatus, createdAt: v.createdAt, settledAt: v.settledAt })),
    reviewResults,
    injection: { runId: injected.runId, at: injected.at, beforeSha256: injected.beforeSha256, injectedSha256: injected.injectedSha256 },
    cleanup: status.cleanup, localTests: { testsRun, exitCode: 0, output: 'verification.txt' },
    finalCodeSha256: hash(await fs.readFile(path.join(project, 'quicksort.py'))),
    note: 'Historical demo snapshot. Sample self-tests only, no independent evaluation. Private profiles/logs/transcripts were not exported.' };
  await writeJson(path.join(outDir, 'summary.json'), summary);
  await writeJson(path.join(outDir, 'experiment-status.json'), portable(status));
  await writeJson(path.join(outDir, 'timeline.json'), timeline);
  await fs.writeFile(path.join(outDir, 'README.md'), '# 本次真实演示结果\n\n这是已结束实验的精选快照，不是你这台机器的当前状态。\n\n'
    + '先看 summary.json 的注入、DEVIATION 审查、自动修复原生运行和 NO_DEVIATION_FOUND 复验，再看 timeline.json。\n'
    + 'quicksort.injected.py 是受控错误；project/quicksort.py 是模型最后修复的代码，未人工修改。\n'
    + 'verification.txt 是在精选代码副本上再次执行其自身 unittest 的输出，不是独立评分；原始业务测试输出保留在 project/test-output.txt。\n'
    + 'summary.json 的 reviewResults 保留审查对象判定与未验证数量，这些计数不是业务完成率或独立评分。\n'
    + '未导出个人 Profile、凭据、完整日志或原始私有轨迹。真实状态请使用 run-demo.mjs --status 查询自己的新运行目录。\n');
  return { outDir, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--out');
    const outDir = at >= 0 ? args[at + 1] : null;
    if (at >= 0) args.splice(at, 2);
    if (args.length !== 1 || !outDir) throw new Error('node collect-result.mjs <run-directory> --out <new-output-folder>');
    const result = await collectDemoResult({ runDir: args[0], outDir }); console.log(`Exported: ${result.outDir}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
