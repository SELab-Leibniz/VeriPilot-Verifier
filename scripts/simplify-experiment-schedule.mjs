#!/usr/bin/env node
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

const benchmarkSamples = ['etree-deepequal-injected', 'httpx-frozen', 'etree-frozen', 'narwhals-frozen'];

export function simplifySchedule(round, promoted = []) {
  if (round !== '2' && promoted.length) throw new Error('Promotions are only used for round 2.');
  if (round === 'C') return [1, 2, 3].flatMap(repeat => ['C-off', 'C-on'].map(arm => ({
    id: `${arm.toLowerCase()}-${repeat}`, round, sample: 'kitchen-compaction', repeat, arm,
    timeoutMs: 30 * 60_000, config: { originalRequirementsEnabled: true, compactionRestore: arm === 'C-on', stop: false, skill: false, document: false },
  })));
  if (round !== '1' && round !== '2') throw new Error('Choose round 1, 2 or C.');
  if (round === '2' && (!promoted.length || promoted.length > 2 || new Set(promoted).size !== promoted.length
    || promoted.some(arm => !['B1', 'B2', 'B12'].includes(arm)))) throw new Error('Round 2 requires one or two distinct promoted candidate arms.');
  const screening = round === '1';
  const samples = screening ? Object.keys(SCREENING_SAMPLES) : benchmarkSamples;
  const arms = screening ? Object.keys(STOP_ARMS) : ['A', ...promoted];
  return (screening ? [1, 2, 3] : [1, 2]).flatMap(repeat => samples.flatMap(sample => [
    ...arms.slice(repeat - 1), ...arms.slice(0, repeat - 1),
  ].map(arm => {
    const config = STOP_ARMS[arm];
    return { id: `r${round}-${sample}-${repeat}-${arm.toLowerCase()}`, round, sample, repeat, arm, config,
      entrypoints: screening ? ['scripts/evaluate-stop-workspace.mjs'] : [
        'scripts/run-native-stop-benchmark.mjs', 'scripts/evaluate-native-stop-benchmark.mjs',
      ],
      mode: screening ? 'native-workspace-stop' : sample === 'etree-deepequal-injected' ? 'native-repair-loop' : 'native-frozen-stop',
      requirements: config.baseline ? (screening ? 'fixed-baseline-fixture' : 'live-baseline') : 'original-user-message',
    };
  })));
}

async function main() {
  const { values } = parseArgs({ options: { round: { type: 'string' }, promoted: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/simplify-experiment-schedule.mjs --round <1|2|C> [--promoted <B1,B2,B12 subset>]');
    console.log('Prints the proposed run order as JSON. Round 2 requires the approved round 1 promotions. No evaluator is launched.');
    return;
  }
  console.log(JSON.stringify(simplifySchedule(values.round, values.promoted?.split(',') ?? []), null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
