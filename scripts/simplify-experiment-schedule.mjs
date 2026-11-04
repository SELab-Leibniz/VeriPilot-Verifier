#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const STOP_ARMS = Object.freeze({
  A: { baseline: true, originalRequirementsBasis: false, deviationOnly: false },
  B1: { baseline: false, originalRequirementsBasis: true, deviationOnly: false },
  B2: { baseline: true, originalRequirementsBasis: false, deviationOnly: true },
  B12: { baseline: false, originalRequirementsBasis: true, deviationOnly: true },
});

export const SCREENING_SAMPLES = Object.freeze({
  'internal-correct': 'correct',
  'six-functions': 'correct',
  'external-bug': 'injected',
  'hidden-dependency': 'injected',
  'alias-bug': 'injected',
  'missing-run': 'no-feedback',
  'mixed-skill': 'no-feedback',
});

export function simplifySchedule(round, promoted = [], objects = []) {
  if (round !== '2' && promoted.length) throw new Error('Promotions are only used for round 2.');
  if (round === 'validation') return ['external-bug', 'internal-correct'].map(sample => ({ id: `validation-b1-${sample}`,
    round, sample, repeat: 1, arm: 'B1', config: STOP_ARMS.B1, entrypoints: ['scripts/evaluate-stop-workspace.mjs'], scored: false }));
  if (round === 'C') return [1, 2, 3].flatMap(repeat => ['C-off', 'C-on'].map(arm => ({
    id: `${arm.toLowerCase()}-${repeat}`, round, sample: 'kitchen-compaction', repeat, arm,
    timeoutMs: 30 * 60_000, config: { originalRequirementsEnabled: true, compactionRestore: arm === 'C-on', stop: false, skill: false, document: false },
  })));
  if (round !== '1' && round !== '2') throw new Error('Choose round 1, 2 or C.');
  if (round === '2' && (!promoted.length || promoted.length > 2 || new Set(promoted).size !== promoted.length
    || promoted.some(arm => !['B1', 'B2', 'B12'].includes(arm)))) throw new Error('Round 2 requires one or two distinct promoted candidate arms.');
  const screening = round === '1';
  if (!screening && (!objects.length || new Set(objects.map(object => object.id)).size !== objects.length
    || objects.some(object => !/^security_tool_1-(natural|correct|injected)$/u.test(object.id) || !['defect', 'correct'].includes(object.kind))))
    throw new Error('Round 2 requires distinct frozen ArkTS objects.');
  const samples = screening ? Object.keys(SCREENING_SAMPLES) : objects.map(object => object.id);
  const arms = screening ? Object.keys(STOP_ARMS) : ['A', ...promoted];
  const order = screening ? [1, 2, 3].flatMap(repeat => samples.map(sample => ({ repeat, sample })))
    : samples.flatMap(sample => [1, 2].map(repeat => ({ repeat, sample })));
  return order.flatMap(({ repeat, sample }) => [...arms.slice(repeat - 1), ...arms.slice(0, repeat - 1)].map(arm => {
    const config = STOP_ARMS[arm];
    return { id: `r${round}-${sample}-${repeat}-${arm.toLowerCase()}`, round, sample, repeat, arm, config,
      entrypoints: screening ? ['scripts/evaluate-stop-workspace.mjs'] : ['scripts/run-arkts-rc-case.mjs', 'scripts/calibrate-arkts-bench.mjs'],
      mode: screening ? 'native-workspace-stop' : 'native-arkts-frozen-stop',
      requirements: config.baseline ? (screening ? 'fixed-baseline-fixture' : 'live-baseline') : 'original-user-message',
    };
  }));
}

async function main() {
  const { values } = parseArgs({ options: { round: { type: 'string' }, promoted: { type: 'string' }, inputs: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/simplify-experiment-schedule.mjs --round <1|2|C> [--promoted <B1,B2,B12 subset> --inputs <round-two-inputs.json>]');
    console.log('Prints the proposed run order as JSON. Round 2 requires the approved round 1 promotions. No evaluator is launched.');
    return;
  }
  const objects = values.inputs ? JSON.parse(await fs.readFile(values.inputs, 'utf8')).samples : [];
  console.log(JSON.stringify(simplifySchedule(values.round, values.promoted?.split(',') ?? [], objects), null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
