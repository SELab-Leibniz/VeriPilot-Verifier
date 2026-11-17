#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = (runnerRoot, file) => import(pathToFileURL(path.join(runnerRoot, file)));
export async function collectSecurityTool2Result({ runDir, outDir, runnerRoot = path.join(root, 'runner') }) {
  runDir = path.resolve(runDir); outDir = path.resolve(outDir);
  const { json, optionalJson, writeJson, filesUnder, within, hash } = await load(runnerRoot, 'lib/files.mjs');
  const { queryExperimentStatus } = await load(runnerRoot, 'lib/experiment-status.mjs');
  const { privateState } = await load(runnerRoot, 'lib/settlement.mjs');
  if (within(runDir, outDir) || within(outDir, runDir)) throw new Error('Keep shared results outside the private run directory');
  const record = await json(path.join(runDir, 'run.json')), status = await queryExperimentStatus(runDir);
  if (!status.resultFinalized || !status.terminal || status.canScheduleNext !== true) throw new Error('Wait for a finalized result and confirmed cleanup before exporting');
  const result = await json(path.join(runDir, 'result.json'));
  const project = path.resolve(runDir, result.artifacts ?? result.partialProject ?? record.identity?.projectRoot ?? 'artifacts/project');
  if (!within(runDir, project)) throw new Error('Project is outside the private run');
  const projectAvailable = await fs.stat(project).then(stat => stat.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; });
  const portable = value => typeof value === 'string' ? value.replaceAll(runDir, '<RUN_DIR>') : Array.isArray(value)
    ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,portable(v)])) : value;
  await fs.mkdir(path.dirname(outDir), { recursive: true }); await fs.mkdir(outDir);
  const publicChecks = [];
  for (const phase of ['install', 'test', 'build', 'docs']) {
    const receipt = await optionalJson(path.join(project, 'demo-output', phase + '.json'));
    if (!receipt) continue;
    const item = Object.fromEntries(['phase','startedAt','finishedAt','exitCode'].map(key => [key,receipt[key] ?? null]));
    if (phase === 'test' && receipt.localTests) item.localTests = Object.fromEntries(['freshReport','finished','reportedTotal','reportedPassed','reportedFailures','reportedErrors'].map(key => [key,receipt.localTests[key] ?? null]));
    publicChecks.push(item);
  }
  const changedFiles = [], deletedFiles = [], allowed = /^(entry\/src\/(main\/ets|test)\/.*\.ets|docs\/03-模块设计\/.*\.md)$/;
  const baseline = record.input?.fingerprint?.project ?? {}, present = new Set();
  for (const folder of ['entry/src/main/ets', 'entry/src/test', 'docs/03-模块设计']) for (const file of await filesUnder(path.join(project, folder))) {
    const relative = path.relative(project, file).split(path.sep).join('/'); present.add(relative);
    if (!allowed.test(relative)) continue;
    const bytes = await fs.readFile(file);
    if (hash(bytes) === baseline[relative]) continue;
    const target = path.join(outDir, 'project-changes', relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, portable(bytes.toString('utf8'))); changedFiles.push(relative);
  }
  if (projectAvailable) for (const file of Object.keys(baseline)) if (allowed.test(file) && !present.has(file)) deletedFiles.push(file);
  const patch = path.join(runDir, 'artifacts/changes.patch');
  try { await fs.writeFile(path.join(outDir, 'changes.patch'), portable(await fs.readFile(patch, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const work = record.identity ? await privateState(record) : { reviews: [] };
  const summary = { schemaVersion: 'rc-security-tool-2-demo-result.v1', sourceRunId: record.id, startedAt: record.createdAt, finishedAt: record.finishedAt,
    status: status.status, nativeResultStatus: result.status, workflowCompleted: status.status === 'COMPLETED', models: record.input?.models,
    maxRuntimeMs: record.input?.execution?.maxRuntimeMs, sessionId: record.identity?.sessionId, firstRunId: record.firstRunId, projectAvailable,
    rc: status.rc, hosts: status.host, publicChecks, cleanup: status.cleanup, changedFiles, deletedFiles,
    reviews: work.reviews.map(v => ({ runId: v.runId, status: v.status, reviewStatus: v.reviewStatus })),
    independentEvaluation: null, note: 'Historical workflow snapshot and observed public checks only. Failure and UNVERIFIED remain unchanged. No independent evaluation or score; no private Profile or raw transcripts.' };
  await writeJson(path.join(outDir, 'summary.json'), portable(summary));
  await writeJson(path.join(outDir, 'experiment-status.json'), portable(status));
  const timeline = []; let last;
  try {
    for await (const line of createInterface({ input: createReadStream(path.join(runDir, 'rc-status/history.jsonl'), { encoding: 'utf8' }), crlfDelay: Infinity })) {
      if (!line.trim()) continue; const { at, rc } = JSON.parse(line);
      const key = JSON.stringify([rc.status, rc.phase, rc.stage, rc.runId, rc.outcome]); if (key === last) continue; last = key;
      timeline.push({ at, status: rc.status, phase: rc.phase, stage: rc.stage, runId: rc.runId, outcome: rc.outcome });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJson(path.join(outDir, 'timeline.json'), timeline);
  await fs.writeFile(path.join(outDir, 'README.md'), '# 本次实验精选结果\n\n这是历史快照，当前状态请查询自己的运行目录。\n\nsummary.json 分别记录实验状态、宿主原生终态、RC 结果和实际公开检查回执；FAILED、TIMED_OUT、UNVERIFIED 原样保留。\n公开检查不是独立评分。project-changes/ 是变更过的业务源码、公开测试与模块设计文档的精选副本；deletedFiles 记录删除。完整候选保留在原私有运行目录。\n未导出宿主 Profile、鉴权、原始会话或全部运行日志。\n');
  return { outDir, summary: portable(summary) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--out'), outDir = at >= 0 ? args[at + 1] : null;
    if (at >= 0) args.splice(at, 2);
    if (args.length !== 1 || !outDir) throw new Error('node collect-result.mjs <run-directory> --out <new-output-folder>');
    console.log(`Exported: ${(await collectSecurityTool2Result({ runDir: args[0], outDir })).outDir}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
