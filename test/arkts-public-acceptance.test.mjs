import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { arktsAcceptancePolicy, arktsPublicAcceptanceIdentity, loadArktsPublicAcceptance, loadArktsQualifiedProbeDescriptor,
  writeArktsQualifiedProbeDescriptor } from '../scripts/bench/arkts-public-acceptance.mjs';
import { applyRcConfigOverrides, regressionCheckPolicy } from '../scripts/bench/rc-config-overrides.mjs';
import { normalizeRegressionCheck } from '../lib/runtime-v2/stop-correction-config.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const routeEnvironment = ['RC_ARKTS_INSTRUMENT', 'RC_ARKTS_TEST_EXCHANGE', 'RC_ARKTS_TEST_TOOLCHAIN_SHA256',
  'RC_ARKTS_TEST_RELEASE_COMMIT', 'RC_ARKTS_TEST_RUNTIME', 'RC_ARKTS_TEST_CASE'];
const overrides = {
  value: { stopCorrection: { regressionCheck: {
    enabled: true,
    command: ['node', '${harnessRoot}/scripts/bench/arkts-regression-check.mjs', '--original-tests',
      '--baseline=${outputRoot}/baseline-local-tests.json'],
  } } },
};

test('the stock regression policy declares task-start tests and all ArkTS routes', async () => {
  const file = new URL('../config/arkts-openspec-correction.json', import.meta.url);
  const config = JSON.parse(await fs.readFile(file)).stopCorrection.regressionCheck;
  const { applied } = applyRcConfigOverrides('version: 2\n', { value: { stopCorrection: { regressionCheck: config } } }, {
    node: 'node', harnessRoot: '/harness', projectRoot: '/project', toolRoot: '/tools', javaHome: '/java', outputRoot: '/output',
  });
  const check = applied.value.stopCorrection.regressionCheck;
  const effective = normalizeRegressionCheck(check);
  assert.equal(effective.testSource, 'task-start');
  assert.equal(effective.collateralProtocol, 'exclude-cases-v1');
  assert.deepEqual(effective.routeEnvironment, routeEnvironment);
  assert.equal(effective.verifierProtocol, undefined);
  assert(check.command.includes('--original-tests'));
  assert.equal(regressionCheckPolicy(check, effective).honoredByProduct, true);
});

test('a qualified probe materializes identically for both arms and carries exact bindings', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rc-qualified-descriptor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = { instance_id:'security_tool_2', base_commit:'a'.repeat(40), problem_statement:'Refresh only the selected account.' };
  const inputSha = hash(JSON.stringify(task)), probeBytes = Buffer.from('export default function qualifiedProbe(): void {}\n');
  const testIds = ['entry::Public::target', 'entry::Public::preserves_other_accounts'];
  const bindings = [{ testId:testIds[0], quote:task.problem_statement }];
  const check = { probeBytes, sha256:hash(probeBytes), testIds, requirementBindings:bindings };
  const identity = arktsPublicAcceptanceIdentity(inputSha, check);
  const descriptors = [];
  for (const arm of ['off', 'on']) {
    const trialRoot = path.join(root, arm);
    await fs.mkdir(trialRoot);
    const file = await writeArktsQualifiedProbeDescriptor(trialRoot, task, inputSha, { ...check, identitySha256:identity });
    descriptors.push(file);
    const loaded = await loadArktsQualifiedProbeDescriptor(file, task, inputSha, identity);
    assert.equal(loaded.identitySha256, identity);
    assert.deepEqual(await fs.readFile(loaded.probe), probeBytes);
    assert.deepEqual(loaded.requirementBindings, bindings);
    const withExtraRoute = structuredClone(overrides);
    withExtraRoute.value.stopCorrection.regressionCheck.routeEnvironment = ['RC_EXTRA_TEST_ROUTE'];
    const policy = arktsAcceptancePolicy(withExtraRoute, loaded);
    const { applied } = applyRcConfigOverrides('version: 2\n', policy, { ...Object.fromEntries(['outputRoot', 'harnessRoot'].map(key => [key, root])) });
    const config = applied.value.stopCorrection.regressionCheck;
    const effective = normalizeRegressionCheck(config);
    assert.deepEqual(effective.requirementBindings, bindings);
    assert.equal(effective.testSource, 'task-start');
    assert.equal(effective.verifierProtocol, 'split-requirement-v1');
    assert.equal(effective.collateralProtocol, 'exclude-cases-v1');
    assert.deepEqual(effective.routeEnvironment, [...routeEnvironment, 'RC_EXTRA_TEST_ROUTE']);
    assert.equal(config.command[1], `${root}/scripts/bench/arkts-stop-contract-check.mjs`);
    assert(!config.command.includes('--original-tests'));
    assert.equal(regressionCheckPolicy(config, effective).honoredByProduct, true);
  }
  assert.deepEqual(await fs.readFile(descriptors[0]), await fs.readFile(descriptors[1]));
  await assert.rejects(loadArktsQualifiedProbeDescriptor(descriptors[0], { ...task, instance_id:'security_tool_3' }, inputSha, identity), /cannot replace/u);
  await assert.rejects(loadArktsQualifiedProbeDescriptor(descriptors[0], task, hash('another input'), identity), /different task/u);
  await assert.rejects(loadArktsQualifiedProbeDescriptor(descriptors[0], { ...task, problem_statement:'Different authority.' }, inputSha, identity), /exact quote/u);
  await fs.appendFile(path.join(path.dirname(descriptors[0]), 'probe.ets'), '\n// edit');
  await assert.rejects(loadArktsQualifiedProbeDescriptor(descriptors[0], task, inputSha, identity), /differs from its trusted digest/u);
});

test('Sudoku-X checks bind diagonal validity and playability separately and preserve the standard controls', async () => {
  const task = {
    instance_id: 'soduku-harmony_11',
    problem_statement: [
      'Diagonal Sudoku puzzles are generated fully-filled and invalid',
      '',
      'When the diagonal variant (Sudoku-X) is selected, the generator returns a',
      'board with all 81 cells filled -- nothing left to solve -- and digits',
      'repeating on the diagonals. Standard 9x9 puzzles generate fine.',
      '',
      'In Sudoku-X, both the main diagonal and the anti-diagonal must contain the',
      'digits 1-9 exactly once, in addition to the usual row/column/box rules.',
      'Diagonal puzzles should come out with empty cells and a unique solution,',
      'just like standard ones.',
    ].join('\n'),
  };
  const publicInputSha256 = 'e0ad86418321f93986f2b32aa62f1044625782627f008563921cf91082aabc57';
  const acceptance = await loadArktsPublicAcceptance(task, publicInputSha256);
  const prefix = 'entry::PublicSudokuVariantAcceptance::';
  const expected = ['generates_valid_sudoku_x_diagonals_through_configured_mode', 'generates_valid_sudoku_x_diagonals_through_normal_generation',
    'generates_sudoku_x_with_empty_cells_and_unique_solution_through_configured_mode',
    'generates_sudoku_x_with_empty_cells_and_unique_solution_through_normal_generation',
    'preserves_playable_standard_sudoku', 'preserves_existing_standard_seed_links'].map(name => prefix + name);
  assert.deepEqual(acceptance.testIds, expected);
  const diagonalQuote = 'In Sudoku-X, both the main diagonal and the anti-diagonal must contain the\n'
    + 'digits 1-9 exactly once, in addition to the usual row/column/box rules.';
  const playabilityQuote = 'Diagonal puzzles should come out with empty cells and a unique solution,\njust like standard ones.';
  const requirementBindings = [
    ...expected.slice(0, 2).map(testId => ({ testId, quote: diagonalQuote })),
    ...expected.slice(2, 4).map(testId => ({ testId, quote: playabilityQuote })),
  ];
  assert.deepEqual(acceptance.requirementBindings, requirementBindings);
  const source = await fs.readFile(acceptance.probe, 'utf8');
  assert.deepEqual([...source.matchAll(/\bit\('([^']+)'/gu)].map(([, name]) => prefix + name), expected);
  assert.equal(acceptance.sha256, hash(source));
  assert.equal(acceptance.identitySha256, hash(JSON.stringify({ publicInputSha256,
    sha256: acceptance.sha256, testIds: expected, requirementBindings })));
  const policy = arktsAcceptancePolicy(overrides, acceptance);
  assert.deepEqual(policy.value.stopCorrection.regressionCheck.command.filter(arg => arg.startsWith('--requirement-test=')),
    expected.map(id => `--requirement-test=${id}`));
  assert.deepEqual(policy.value.stopCorrection.regressionCheck.requirementBindings, requirementBindings);
  for (const [original, replacement, diagnostic] of [
    ['exactly once', 'at least once', /generates_valid_sudoku_x_diagonals_through_configured_mode/u],
    ['a unique solution', 'a solution', /generates_sudoku_x_with_empty_cells_and_unique_solution_through_configured_mode/u],
  ]) {
    const changed = { ...task, problem_statement: task.problem_statement.replace(original, replacement) };
    await assert.rejects(loadArktsPublicAcceptance(changed, publicInputSha256), diagnostic);
  }
});

test('the danger-label probe binds the original public task and both theme checks', async () => {
  const task = {
    instance_id: 'security_tool_4',
    problem_statement: [
      "Danger action buttons in light theme don't look like danger buttons",
      '',
      'Action button styles are centralized in `ActionButtonStyles`',
      '(entry/src/main/ets/constants/AppConstants.ets). In light theme, a danger',
      "button's icon is rendered in the app's danger color, but its label uses the",
      'same neutral text color as regular action buttons, so destructive actions',
      "don't stand out.",
      '',
      'The danger label in light theme should use `AppColors.DANGER` like the danger',
      'icon does. Dark theme keeps the white label.',
    ].join('\n'),
  };
  const publicInputSha256 = '16dcf287979e60c7874e8562de778341f405f07aa5b3842bfd42d97b8c884f4e';
  const acceptance = await loadArktsPublicAcceptance(task, publicInputSha256);
  const { probe, sha256, testIds, requirementBindings, identitySha256 } = acceptance;
  const expectedProbe = await fs.readFile(new URL('../config/arkts-public-acceptance/security-tool-danger-label.test.ets', import.meta.url));

  assert.deepEqual(await fs.readFile(probe), expectedProbe);
  assert.equal(sha256, hash(expectedProbe));
  assert.deepEqual(testIds, [
    'entry::PublicSecurityToolDangerLabelAcceptance::uses_the_danger_color_for_the_light_theme_label',
    'entry::PublicSecurityToolDangerLabelAcceptance::keeps_the_dark_theme_label_white',
  ]);
  assert.deepEqual(requirementBindings, [
    { testId: testIds[0], quote: 'The danger label in light theme should use `AppColors.DANGER` like the danger\nicon does.' },
    { testId: testIds[1], quote: 'Dark theme keeps the white label.' },
  ]);
  assert.equal(identitySha256, hash(JSON.stringify({ publicInputSha256, sha256, testIds, requirementBindings })));
  const policy = arktsAcceptancePolicy(overrides, acceptance);
  assert.deepEqual(policy.value.stopCorrection.regressionCheck.requirementBindings, requirementBindings);
  assert.equal(Object.hasOwn(overrides.value.stopCorrection.regressionCheck, 'requirementBindings'), false);

  await assert.rejects(loadArktsPublicAcceptance({ instance_id: task.instance_id }, publicInputSha256), /exact original requirement/u);
  const changed = { ...task, problem_statement: task.problem_statement.replace('white label.', 'white icon.') };
  await assert.rejects(loadArktsPublicAcceptance(changed, publicInputSha256), /keeps_the_dark_theme_label_white/u);
  await assert.rejects(loadArktsPublicAcceptance(task, '0'.repeat(64)), /requires the original public input/u);
  assert.equal(await loadArktsPublicAcceptance({ instance_id: 'security_tool_2' }, publicInputSha256), null);
});

test('HappyWord letter metrics bind the exact gap and size clauses while viewport fit stays diagnostic', async () => {
  const gapQuote = 'Only the inter-cell gap should change: words up to 6 letters use a 4vp gap,\n'
    + 'each longer bucket steps the gap down by 1vp, and the gap never drops below\n2vp.';
  const sizeQuote = 'Cell sizes and font sizes stay unchanged';
  const task = {
    instance_id: 'happyword_12',
    problem_statement: [
      'Tighten the letter gaps in the battle prompt row',
      '',
      'The prompt word in battle is rendered as a row of letter cells, with cell',
      'sizes and gaps picked per word length by `LetterMetrics`. The current gaps',
      'are generous, making long words look loose; the row should render more',
      'compactly while keeping plenty of margin inside the ~380dp question area on',
      'small screens.',
      '',
      gapQuote + ' ' + sizeQuote + ', so an 11-letter word still',
      'fits well within the viewport.',
    ].join('\n'),
  };
  const publicInputSha256 = '2e4d351bb4fd6e48d2fa556b75bb92f6333cf4c0fac81cd678eec0e487f4bab1';
  const acceptance = await loadArktsPublicAcceptance(task, publicInputSha256);
  const { probe, sha256, identitySha256 } = acceptance;
  const prefix = 'entry::PublicHappyWordLetterGapAcceptance::';
  const testIds = ['uses_compact_gaps_for_each_word_length_bucket', 'preserves_letter_cell_and_font_sizes',
    'fits_eleven_letter_word_within_question_width'].map(name => prefix + name);
  const requirementBindings = [{ testId: testIds[0], quote: gapQuote }, { testId: testIds[1], quote: sizeQuote }];
  const source = await fs.readFile(probe, 'utf8');

  assert.deepEqual(acceptance.testIds, testIds);
  assert.deepEqual([...source.matchAll(/\bit\('([^']+)'/gu)].map(([, name]) => prefix + name), testIds);
  assert.equal(sha256, hash(source));
  assert.deepEqual(acceptance.requirementBindings, requirementBindings);
  assert.equal(identitySha256, hash(JSON.stringify({ publicInputSha256, sha256, testIds, requirementBindings })));
  const { regressionCheck } = arktsAcceptancePolicy(overrides, acceptance).value.stopCorrection;
  assert(regressionCheck.command.includes('--requirement-probe-sha256=' + sha256));
  assert.deepEqual(regressionCheck.command.filter(arg => arg.startsWith('--requirement-test=')),
    testIds.map(id => '--requirement-test=' + id));
  assert.deepEqual(regressionCheck.requirementBindings, requirementBindings);

  for (const [original, replacement, diagnostic] of [
    ['a 4vp gap', 'a 5vp gap', /uses_compact_gaps_for_each_word_length_bucket/u],
    [sizeQuote, 'Cell sizes stay unchanged', /preserves_letter_cell_and_font_sizes/u],
  ]) {
    const changed = { ...task, problem_statement: task.problem_statement.replace(original, replacement) };
    await assert.rejects(loadArktsPublicAcceptance(changed, publicInputSha256), diagnostic);
  }
  await assert.rejects(loadArktsPublicAcceptance(task, '0'.repeat(64)), /requires the original public input/u);
});

test('HappyWord origin binds both URL requirements and keeps its base-derived regression check', async () => {
  const task = {
    instance_id: 'happyword_13',
    problem_statement: [
      'Remote word-pack URLs still point at the old happyword.vercel.app deployment',
      '',
      'The remote word-pack configuration (`RemoteWordPackConfig`) still builds its',
      'URLs on the deprecated `happyword.vercel.app` deployment, so pack downloads',
      'and preview lookups go to the old origin.',
      '',
      'All remote endpoints should move to the new `happyword.cool` domain: the',
      'staging base URL should be `https://happyword.cool`, the latest-pack URL',
      'should resolve to `https://happyword.cool/api/v1/packs/latest.json`, and the',
      'preview manifest should always be fetched from',
      '`https://happyword.cool/api/v1/preview-urls.json` regardless of the backend',
      'environment.',
    ].join('\n'),
  };
  const publicInputSha256 = '95412129e6737354c6738b3b3cef044022b0d0228a2b26a18ca28b3cdd2991c2';
  const { sha256, testIds, identitySha256, requirementBindings } = await loadArktsPublicAcceptance(task, publicInputSha256);

  assert.deepEqual(testIds, [
    'entry::PublicHappyWordPackOriginAcceptance::routes_staging_and_latest_pack_to_happyword_cool',
    'entry::PublicHappyWordPackOriginAcceptance::uses_fixed_happyword_cool_preview_manifest',
    'entry::PublicHappyWordPackOriginAcceptance::preserves_explicit_local_and_preview_routes',
  ]);
  assert.deepEqual(requirementBindings, [
    { testId: testIds[0], quote: 'the\nstaging base URL should be `https://happyword.cool`, the latest-pack URL\n'
        + 'should resolve to `https://happyword.cool/api/v1/packs/latest.json`' },
    { testId: testIds[1], quote: 'the\npreview manifest should always be fetched from\n'
        + '`https://happyword.cool/api/v1/preview-urls.json` regardless of the backend\nenvironment.' },
  ]);
  assert.equal(identitySha256, hash(JSON.stringify({ publicInputSha256, sha256, testIds, requirementBindings })));
  const changed = { ...task, problem_statement: task.problem_statement.replace('regardless of the backend', 'in the staging') };
  await assert.rejects(loadArktsPublicAcceptance(changed, publicInputSha256), /uses_fixed_happyword_cool_preview_manifest/u);
});

test('the log initialization probe is pinned to the exact public retry task', async () => {
  const task = { instance_id: 'security_tool_3' };
  const publicInputSha256 = '61483832dd3e2f0d2c5b2641ff564c75ea5290428368cef44b57861f7ae6bcb5';
  const acceptance = await loadArktsPublicAcceptance(task, publicInputSha256);
  const { probe, sha256, testIds, identitySha256 } = acceptance;
  const expectedProbe = await fs.readFile(new URL('../config/arkts-public-acceptance/security-tool-log-initialization.test.ets', import.meta.url));

  assert.deepEqual(await fs.readFile(probe), expectedProbe);
  assert.deepEqual(testIds, [
    'entry::PublicSecurityToolLogInitializationAcceptance::retries_failed_storage_initialization_and_loads_one_snapshot',
  ]);
  assert.deepEqual(acceptance, { probe, sha256, testIds, identitySha256 });
  assert.equal(identitySha256, hash(JSON.stringify({ publicInputSha256, sha256, testIds })));
  assert.equal(Object.hasOwn(arktsAcceptancePolicy(overrides, acceptance).value.stopCorrection.regressionCheck, 'requirementBindings'), false);
  await assert.rejects(loadArktsPublicAcceptance(task, '16dcf287979e60c7874e8562de778341f405f07aa5b3842bfd42d97b8c884f4e'),
    /requires the original public input/u);
});
