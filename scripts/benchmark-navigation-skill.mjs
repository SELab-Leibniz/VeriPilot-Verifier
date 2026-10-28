// Mechanism measurements only. These do not establish end-to-end model savings
// or native benchmark correctness. Fixed baseline source is loaded as code;
// no user content is evaluated.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createLiveSourceTools } from '../lib/review-task/live-source-tools.mjs';
import { toolText } from '../lib/review-task/source-tools.mjs';
import { adaptSkillsForOpenClaw } from '../lib/openclaw/skills.mjs';
import { pluginBootstrapCommand } from '../lib/plugin-bootstrap.mjs';
import * as claude from '../lib/hosts/claude.mjs';
import * as codeagent from '../lib/hosts/codeagent.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-navigation-benchmark-'));
const report = { baselineRef: 'c33bae6', interpretation: 'Mechanism bytes and actual file-read callbacks, not model tokens or F2P/P2P.', navigation: [], skills: [] };
const before = file => execFileSync('git', ['show', `c33bae6:${file}`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
try {
  const oldSource = before('lib/review-task/live-source-tools.mjs').replace("'./source-tools.mjs'", JSON.stringify(new URL('../lib/review-task/source-tools.mjs', import.meta.url).href));
  const old = (await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString('base64')}`)).createLiveSourceTools;
  for (const [domain, source, cache] of [['arkts', 'entry/src/main.ets', 'oh_modules'], ['python', 'app/main.py', '.venv'], ['node', 'src/main.js', 'node_modules']]) {
    const fixture = path.join(root, domain);
    await fs.mkdir(path.dirname(path.join(fixture, source)), { recursive: true });
    await fs.writeFile(path.join(fixture, source), 'export const useful = "needle";\n');
    await fs.mkdir(path.join(fixture, cache), { recursive: true });
    for (let i = 0; i < 120; i++) await fs.writeFile(path.join(fixture, cache, `${i}.txt`), 'generated dependency data\n'.repeat(160));
    const samples = [];
    for (let round = 0; round < 6; round++) {
      for (const mode of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        let files = 0, bytes = 0;
        const tool = (mode === 'before' ? old : createLiveSourceTools)(fixture, { onSearchFile(_file, content) { files++; bytes += content.length; } }).find(tool => tool.name === 'grep');
        const start = performance.now();
        const result = JSON.parse(toolText(await tool.execute('measurement', { pattern: 'needle' })));
        assert.equal(result.hits.length, 1); assert(result.hits[0].includes(source.replaceAll('/', path.sep)));
        samples.push({ mode, elapsedMs: performance.now() - start, filesRead: files, bytesRead: bytes });
      }
    }
    report.navigation.push({ domain, dependencyFiles: 120, samples });
  }
  const file = 'skills/runtime-corrector-control/SKILL.md';
  const versions = { before: before(file), after: await fs.readFile(file, 'utf8') };
  for (const host of ['claude', 'codeagent', 'openclaw']) {
    const measured = {};
    for (const [mode, text] of Object.entries(versions)) {
      let adapted;
      if (host === 'openclaw') {
        const directory = path.join(root, `${host}-${mode}`); await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, 'SKILL.md'), text); await adaptSkillsForOpenClaw(directory);
        adapted = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8');
        // Every operation must remain an actual structured tool call after adaptation.
        const commands = [...adapted.matchAll(/\{"command":"([a-z]+)"[^\n]+/gu)].map(match => match[1]);
        for (const command of ['help', 'validate', 'stages', 'stage', 'explain', 'spec']) assert(commands.includes(command), `${mode} missing ${command}`);
      } else adapted = text.replace(/node -e "[^"\r\n]*" "(scripts\/[a-z0-9-]+\.mjs)"/gu,
        (_match, entry) => pluginBootstrapCommand(entry, host === 'claude' ? claude : codeagent, { inlineRoot: true }));
      measured[`${mode}Bytes`] = Buffer.byteLength(adapted);
    }
    report.skills.push({ host, ...measured });
  }
  const output = path.resolve('.runtime-correction/system-optimization/navigation-skill-benchmark.json');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, skills: report.skills, navigation: report.navigation.map(row => ({ domain: row.domain,
    before: row.samples.find(sample => sample.mode === 'before'), after: row.samples.find(sample => sample.mode === 'after') })) }));
} finally { await fs.rm(root, { recursive: true, force: true }); }
