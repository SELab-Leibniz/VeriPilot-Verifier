import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRequirementBindings } from '../../lib/runtime-v2/stop-correction-config.mjs';
import { digest } from './arkts-dataset.mjs';

const { routeEnvironment: arktsRegressionRoute, collateralProtocol: arktsCollateralProtocol } =
  createRequire(import.meta.url)('../../config/arkts-openspec-correction.json').stopCorrection.regressionCheck;
const diagonalDigitRule = 'In Sudoku-X, both the main diagonal and the anti-diagonal must contain the\n'
  + 'digits 1-9 exactly once, in addition to the usual row/column/box rules.';
const diagonalPuzzleRule = 'Diagonal puzzles should come out with empty cells and a unique solution,\njust like standard ones.';

const probes = new Map([
  ['security_tool_3', {
    publicInputSha256: '61483832dd3e2f0d2c5b2641ff564c75ea5290428368cef44b57861f7ae6bcb5',
    file: 'security-tool-log-initialization.test.ets',
    suite: 'PublicSecurityToolLogInitializationAcceptance',
    cases: ['retries_failed_storage_initialization_and_loads_one_snapshot'],
  }],
  ['security_tool_4', {
    publicInputSha256: '16dcf287979e60c7874e8562de778341f405f07aa5b3842bfd42d97b8c884f4e',
    file: 'security-tool-danger-label.test.ets',
    suite: 'PublicSecurityToolDangerLabelAcceptance',
    cases: ['uses_the_danger_color_for_the_light_theme_label', 'keeps_the_dark_theme_label_white'],
    requirementQuotes: {
      uses_the_danger_color_for_the_light_theme_label:
        'The danger label in light theme should use `AppColors.DANGER` like the danger\nicon does.',
      keeps_the_dark_theme_label_white: 'Dark theme keeps the white label.',
    },
  }],
  ['soduku-harmony_11', {
    publicInputSha256: 'e0ad86418321f93986f2b32aa62f1044625782627f008563921cf91082aabc57',
    file: 'sudoku-diagonal.test.ets',
    suite: 'PublicSudokuVariantAcceptance',
    cases: ['generates_valid_sudoku_x_diagonals_through_configured_mode', 'generates_valid_sudoku_x_diagonals_through_normal_generation',
      'generates_sudoku_x_with_empty_cells_and_unique_solution_through_configured_mode',
      'generates_sudoku_x_with_empty_cells_and_unique_solution_through_normal_generation',
      'preserves_playable_standard_sudoku', 'preserves_existing_standard_seed_links'],
    requirementQuotes: {
      generates_valid_sudoku_x_diagonals_through_configured_mode: diagonalDigitRule,
      generates_valid_sudoku_x_diagonals_through_normal_generation: diagonalDigitRule,
      generates_sudoku_x_with_empty_cells_and_unique_solution_through_configured_mode: diagonalPuzzleRule,
      generates_sudoku_x_with_empty_cells_and_unique_solution_through_normal_generation: diagonalPuzzleRule,
    },
  }],
  ['happyword_12', {
    publicInputSha256: '2e4d351bb4fd6e48d2fa556b75bb92f6333cf4c0fac81cd678eec0e487f4bab1',
    file: 'happyword-letter-gaps.test.ets',
    suite: 'PublicHappyWordLetterGapAcceptance',
    cases: ['uses_compact_gaps_for_each_word_length_bucket', 'preserves_letter_cell_and_font_sizes',
      'fits_eleven_letter_word_within_question_width'],
    // The viewport calculation depends on both properties and cannot identify a failed clause on its own.
    requirementQuotes: {
      uses_compact_gaps_for_each_word_length_bucket:
        'Only the inter-cell gap should change: words up to 6 letters use a 4vp gap,\n'
        + 'each longer bucket steps the gap down by 1vp, and the gap never drops below\n2vp.',
      preserves_letter_cell_and_font_sizes: 'Cell sizes and font sizes stay unchanged',
    },
  }],
  ['happyword_13', {
    publicInputSha256: '95412129e6737354c6738b3b3cef044022b0d0228a2b26a18ca28b3cdd2991c2',
    file: 'happyword-word-pack-origin.test.ets',
    suite: 'PublicHappyWordPackOriginAcceptance',
    cases: ['routes_staging_and_latest_pack_to_happyword_cool', 'uses_fixed_happyword_cool_preview_manifest',
      'preserves_explicit_local_and_preview_routes'],
    requirementQuotes: {
      routes_staging_and_latest_pack_to_happyword_cool:
        'the\nstaging base URL should be `https://happyword.cool`, the latest-pack URL\n'
        + 'should resolve to `https://happyword.cool/api/v1/packs/latest.json`',
      uses_fixed_happyword_cool_preview_manifest:
        'the\npreview manifest should always be fetched from\n'
        + '`https://happyword.cool/api/v1/preview-urls.json` regardless of the backend\nenvironment.',
    },
  }],
]);

const qualifiedProbeKind = 'arkts-qualified-acceptance-probe-v1';
const descriptorMaxBytes = 512 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const validTestIds = ids => Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length
  && ids.every(id => typeof id === 'string' && /^[^:\r\n\0]+::[^:\r\n\0]+::[^\r\n\0]+$/u.test(id));

export function arktsPublicAcceptanceIdentity(publicInputSha256, { sha256, testIds, requirementBindings }) {
  return digest(JSON.stringify({ publicInputSha256, sha256, testIds,
    ...(requirementBindings ? { requirementBindings } : {}) }));
}

export function qualifiedProbeBindings(task, testIds, bindings) {
  const normalized = normalizeRequirementBindings(bindings, testIds);
  for (const { testId, quote } of normalized)
    assert(typeof task.problem_statement === 'string' && task.problem_statement.includes(quote),
      `Qualified public probe ${testId} requires an exact quote from ${task.instance_id}`);
  return normalized;
}

export async function loadArktsPublicAcceptance(task, publicInputSha256) {
  const definition = probes.get(task.instance_id);
  if (!definition) return null;
  assert.equal(publicInputSha256, definition.publicInputSha256, `Acceptance requires the original public input for ${task.instance_id}`);
  const probe = fileURLToPath(new URL(`../../config/arkts-public-acceptance/${definition.file}`, import.meta.url));
  const sha256 = digest(await fs.readFile(probe));
  const testIdFor = name => `entry::${definition.suite}::${name}`;
  const testIds = definition.cases.map(testIdFor);
  const requirementBindings = definition.requirementQuotes && Object.entries(definition.requirementQuotes).map(([name, quote]) => {
    assert(definition.cases.includes(name), `Acceptance requirement binding names an unknown check for ${task.instance_id}: ${name}`);
    assert(typeof task.problem_statement === 'string' && task.problem_statement.includes(quote),
      `Acceptance requires the exact original requirement for ${task.instance_id}: ${name}`);
    return { testId: testIdFor(name), quote };
  });
  const bindings = requirementBindings ? { requirementBindings } : {};
  const identitySha256 = arktsPublicAcceptanceIdentity(publicInputSha256, { sha256, testIds, ...bindings });
  return { probe, sha256, testIds, ...bindings, identitySha256 };
}

async function readPublicManifest(file, sha256, planSha256, kind, label) {
  const manifestPath = await fs.realpath(file);
  const bytes = await fs.readFile(manifestPath);
  assert.equal(digest(bytes), sha256, `${label} manifest differs from its trusted digest`);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest?.kind, kind, `Invalid ${label} manifest`);
  assert.equal(manifest.planSha256, planSha256, `${label} manifest names a different plan`);
  return { directory:path.dirname(manifestPath), manifest };
}

async function readPublicControlFile(directory, file, sha256, extension, byteLimit, label) {
  assert(typeof file === 'string' && file.endsWith(extension) && !path.isAbsolute(file), `Invalid ${label} path`);
  const resolved = await fs.realpath(path.resolve(directory, file));
  const relative = path.relative(directory, resolved);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), `${label} escaped its manifest directory`);
  assert.match(sha256 ?? '', /^[a-f0-9]{64}$/u);
  const stat = await fs.stat(resolved);
  assert(stat.isFile() && stat.size > 0 && stat.size <= byteLimit, `${label} must be a bounded regular file`);
  const bytes = await fs.readFile(resolved);
  assert(bytes.length <= byteLimit && digest(bytes) === sha256, `${label} differs from its trusted digest`);
  return bytes;
}

/** Candidate probes are opt-in public controls. Loading them cannot register a Stop policy. */
export async function loadArktsPublicProbeManifest(file, sha256, planSha256, planIds) {
  const { directory, manifest } = await readPublicManifest(file, sha256, planSha256, 'arkts-public-probe-qualification-v1', 'Public probe');
  assert.match(manifest.sourceCommit ?? '', /^[a-f0-9]{40}$/u, 'Public probe manifest must name its authoring commit');
  assert(manifest.probes && typeof manifest.probes === 'object' && !Array.isArray(manifest.probes), 'Invalid public probe definitions');
  const entries = Object.entries(manifest.probes);
  assert(entries.length && entries.every(([id]) => planIds.includes(id)), 'Public probe manifest names an unknown task');
  const probes = await Promise.all(entries.map(async ([id, definition]) => {
    const { file, sha256, testIds, expectedBase, requirementBindings = [] } = definition ?? {};
    const probeBytes = await readPublicControlFile(directory, file, sha256, '.ets', 128 * 1024, 'Public probe');
    assert(validTestIds(testIds), 'Invalid public probe test IDs');
    assert(Array.isArray(expectedBase) && expectedBase.length === testIds.length
      && expectedBase.every(status => ['PASS', 'FAIL'].includes(status)), 'Invalid public probe base outcomes');
    return [id, { probeBytes, sha256, testIds, expectedBase, requirementBindings: normalizeRequirementBindings(requirementBindings, testIds) }];
  }));
  return { sha256, authoredAgainstCommit: manifest.sourceCommit, probes: new Map(probes) };
}

export async function loadArktsPublicPositiveManifest(file, sha256, planSha256, baseCommits) {
  const { directory, manifest } = await readPublicManifest(file, sha256, planSha256, 'arkts-public-positive-controls-v1', 'Public positive control');
  assert(manifest.controls && typeof manifest.controls === 'object' && !Array.isArray(manifest.controls), 'Invalid public positive controls');
  const entries = Object.entries(manifest.controls);
  assert(entries.length && entries.every(([id]) => baseCommits.has(id)), 'Public positive control manifest names an unknown task');
  return new Map(await Promise.all(entries.map(async ([id, control]) => {
    const { file, baseCommit, patchSha256 } = control ?? {};
    assert.equal(baseCommit, baseCommits.get(id), `Public positive control names a different base for ${id}`);
    const patchBytes = await readPublicControlFile(directory, file, patchSha256, '.patch', 1024 * 1024, 'Public positive patch');
    return [id, { patchBytes, patchSha256 }];
  })));
}

export async function writeArktsQualifiedProbeDescriptor(directory, task, publicInputSha256, check) {
  const { probeBytes, sha256, testIds, identitySha256 } = check;
  assert(!probes.has(task.instance_id), 'A qualified probe cannot replace a registered public probe');
  assert(Buffer.isBuffer(probeBytes) && probeBytes.length > 0 && probeBytes.length <= 128 * 1024 && digest(probeBytes) === sha256,
    'The qualified probe bytes differ from their pin');
  assert(validTestIds(testIds) && sha256Pattern.test(publicInputSha256), 'Invalid qualified public acceptance check');
  const requirementBindings = qualifiedProbeBindings(task, testIds, check.requirementBindings);
  assert(arktsPublicAcceptanceIdentity(publicInputSha256, { sha256, testIds, requirementBindings }) === identitySha256,
    'Invalid qualified public acceptance check');
  const root = path.join(directory, 'public-acceptance');
  const file = path.join(root, 'descriptor.json');
  const descriptor = { kind: qualifiedProbeKind, id: task.instance_id, baseCommit: task.base_commit,
    publicInputSha256, sha256, testIds, requirementBindings };
  const serialized = JSON.stringify(descriptor, null, 2) + '\n';
  assert(Buffer.byteLength(serialized) <= descriptorMaxBytes, 'Expected a bounded public acceptance descriptor');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'probe.ets'), probeBytes, { flag: 'wx' });
  await fs.writeFile(file, serialized, { flag: 'wx' });
  return file;
}

export async function loadArktsQualifiedProbeDescriptor(file, task, publicInputSha256, identitySha256) {
  assert(!probes.has(task.instance_id), 'A qualified probe cannot replace a registered public probe');
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  assert(stat.isFile() && stat.size <= descriptorMaxBytes, 'Expected a bounded public acceptance descriptor');
  const bytes = await fs.readFile(resolved);
  assert(bytes.length <= descriptorMaxBytes, 'Expected a bounded public acceptance descriptor');
  const descriptor = JSON.parse(bytes);
  const { kind, id, baseCommit, publicInputSha256: inputSha, sha256, testIds } = descriptor;
  assert(kind === qualifiedProbeKind && id === task.instance_id && baseCommit === task.base_commit
    && sha256Pattern.test(publicInputSha256) && inputSha === publicInputSha256, 'Qualified public acceptance descriptor names a different task');
  assert(validTestIds(testIds), 'Invalid qualified public acceptance test IDs');
  const requirementBindings = qualifiedProbeBindings(task, testIds, descriptor.requirementBindings);
  assert(arktsPublicAcceptanceIdentity(publicInputSha256, { sha256, testIds, requirementBindings }) === identitySha256,
    'Qualified public acceptance descriptor differs from its campaign pin');
  const directory = path.dirname(resolved);
  await readPublicControlFile(directory, 'probe.ets', sha256, '.ets', 128 * 1024, 'Qualified public probe');
  return { probe: path.join(directory, 'probe.ets'), sha256, testIds, requirementBindings, identitySha256 };
}

export function arktsAcceptancePolicy(overrides, { probe, sha256, testIds, requirementBindings }) {
  const value = structuredClone(overrides?.value);
  const check = value?.stopCorrection?.regressionCheck;
  const suiteRunner = '${harnessRoot}/scripts/bench/arkts-regression-check.mjs';
  assert(check?.enabled && Array.isArray(check.command) && check.command[1] === suiteRunner && check.command.includes('--original-tests')
    && (check.testSource === undefined || check.testSource === 'task-start')
    && check.command.includes('--baseline=${outputRoot}/baseline-local-tests.json'),
    'Public acceptance requires the task-start ArkTS regression runner and baseline');
  check.testSource = 'task-start';
  check.verifierProtocol = 'split-requirement-v1';
  if (!Object.hasOwn(check, 'collateralProtocol')) check.collateralProtocol = arktsCollateralProtocol;
  check.routeEnvironment = [...new Set([...arktsRegressionRoute, ...(check.routeEnvironment ?? [])])];
  check.command = check.command.filter(arg => arg !== '--original-tests');
  check.command[1] = '${harnessRoot}/scripts/bench/arkts-stop-contract-check.mjs';
  check.command.push(`--requirement-probe=${probe}`, `--requirement-probe-sha256=${sha256}`,
    ...testIds.map(id => `--requirement-test=${id}`));
  if (requirementBindings) check.requirementBindings = structuredClone(requirementBindings);
  return { ...overrides, value };
}
