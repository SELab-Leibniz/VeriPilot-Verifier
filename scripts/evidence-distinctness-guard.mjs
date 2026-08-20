#!/usr/bin/env node
// PostToolUse evidence-distinctness guard.
//
// Integrity control over developer-captured evidence. It never reads review
// results and emits no review feedback of its own; its only job is to stop a
// developer proving two different states with one capture: if two
// DIFFERENTLY-NAMED evidence files are byte-identical (same SHA-256), a later
// PASS could rest on reused evidence. Catching the duplicate at capture time
// forces a real re-capture instead of a failed downstream validation.
//
// Evidence is typically captured via Bash (device/UI dump tooling), so this is
// registered as a PostToolUse hook on Bash/Write/Edit. The guard is inactive
// until the project config declares top-level `evidenceRoots` (directories,
// relative to the project root, whose files are treated as named evidence).
// Its counter state lives under the configured output tree and it never throws
// into the run: any internal error exits 0 (allow).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { loadConfig } from '../lib/runtime-corrector.mjs';
import { outputTreeDirectory } from '../lib/runtime-v2/paths.mjs';

// Evidence types where byte-identity between two names is a fabrication signal
// rather than a coincidence.
const CONTENT_EXTENSIONS = new Set(['.xml', '.png', '.jpg', '.jpeg', '.webp', '.json', '.log', '.txt', '.har']);
// After this many blocks on the SAME duplicate pair, stop hard-blocking and fall
// back to a soft note, so a developer who genuinely cannot differentiate a state
// is never deadlocked — downstream validation still records any persistent reuse.
const MAX_BLOCKS_PER_GROUP = 3;

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

function walk(directory, accumulator = []) {
  if (!existsSync(directory)) return accumulator;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, accumulator);
    else if (entry.isFile()) accumulator.push(full);
  }
  return accumulator;
}

function allow() {
  process.exit(0);
}

async function main() {
  const input = await readStdin();
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') allow();

  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let plan = null;
  try {
    plan = await loadConfig({ cwd: projectRoot, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT });
  } catch {
    plan = null; // An unreadable config must never block the run.
  }
  // Inactive by default: the guard only watches roots the project declares.
  const configuredRoots = Array.isArray(plan?.evidenceRoots) ? plan.evidenceRoots : [];
  if (configuredRoots.length === 0) allow();
  const evidenceRoots = configuredRoots.map((root) => (
    isAbsolute(root) ? root : join(projectRoot, root)
  ));

  const byHash = new Map();
  for (const root of evidenceRoots) {
    for (const file of walk(root)) {
      if (!CONTENT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      let size;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size === 0) continue; // an empty file proves nothing and hashes alike
      let hash;
      try {
        hash = createHash('sha256').update(readFileSync(file)).digest('hex');
      } catch {
        continue;
      }
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(file);
    }
  }

  const duplicateGroups = [...byHash.entries()].filter(([, files]) => files.length > 1);
  if (!duplicateGroups.length) allow();

  // Anti-deadlock: remember how many times each duplicate SHA was flagged so a
  // truly unfixable state degrades to a soft note instead of blocking forever.
  const stateDirectory = resolve(projectRoot, outputTreeDirectory(plan?.output));
  const statePath = join(stateDirectory, 'evidence-guard-state.json');
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    state = {};
  }

  const blocking = [];
  for (const [hash, files] of duplicateGroups) {
    const names = files.map((file) => basename(file)).sort();
    const priorBlocks = state[hash]?.blocks ?? 0;
    if (priorBlocks < MAX_BLOCKS_PER_GROUP) blocking.push(names);
    state[hash] = { blocks: priorBlocks + 1, files: names };
  }
  try {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Persisting the counter is best-effort; never fail the run over it.
  }

  if (!blocking.length) allow(); // already flagged MAX_BLOCKS_PER_GROUP times

  const groupLines = blocking.map((names) => `  - ${names.join('  ≡  ')}`);
  const reason = [
    '证据完整性拦截（evidence distinctness）：以下证据文件内容逐字节完全相同（SHA-256 一致），却以不同文件名分别引用——等于用同一次采集去“证明”不同的界面状态：',
    ...groupLines,
    '',
    '同一张截图 / 同一份 UI dump 不能同时证明两个不同状态。请二选一处理，然后再继续：',
    '  1) 真正执行对应操作切换到目标状态，再重新采集该状态的真实界面（先完成状态切换再采集），覆盖其中一个文件；或',
    '  2) 若两者确属同一状态，删除多余文件，只保留并引用一个。',
    '',
    '在每个具名证据文件彼此内容不同之前，不要推进交付验证或据此声明该状态通过——任何依赖重复证据的 PASS 都会在后续校验中被拒绝。'
  ].join('\n');

  // Emit both the PostToolUse block decision and additionalContext so the
  // message reaches the developer whichever form this CLI version honors.
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason }
  }));
  process.exit(0);
}

main().catch((error) => {
  // A guard that crashes must never take the run down with it.
  if (process.env.EVIDENCE_GUARD_DEBUG) console.error('EVIDENCE_GUARD ERROR:', error);
  process.exit(0);
});
