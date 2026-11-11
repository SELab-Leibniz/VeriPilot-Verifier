import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';

const generated = new Set(['.git', '.hvigor', '.test', 'oh_modules', 'node_modules', '.runtime-correction', '.runtime-corrector']);
const run = promisify(execFile);
const suiteRoot = /(?:^|\/)src\/test(?=\/|$)/u;

// Alter only the disposable generated runner, keeping original test modules
// byte-identical. Hypium's suite/itName filters accept exact titles with spaces.
export async function installRegressionCaseFilter(workspace, { module, suite, itName }) {
  if (!/^[\w.-]+$/u.test(module) || !suite || !itName || /[\r\n,]/u.test(suite + itName))
    throw new Error('Invalid native test selector.');
  // This Hypium release's nested-suite scheduler ignores suite/itName when
  // class is empty, and its CLI class validator disallows spaces. Configure
  // the exported Core service after CLI parsing, before original registration.
  const selector = suite + '#' + itName;
  const hook = [
    "import { hvigor as rcHvigor } from '@ohos/hvigor';",
    "import * as rcFs from 'fs';",
    "import * as rcPath from 'path';",
    'rcHvigor.nodesEvaluated(() => {',
    '  const moduleNode = rcHvigor.getRootNode().getSubNodeByName(' + JSON.stringify(module) + ');',
    "  const generation = moduleNode?.getTaskByName('default@GenerateUnitTestTemplate');",
    "  if (!generation) throw new Error('Native test-template task is unavailable.');",
    '  generation.afterRun(() => {',
    '    const file = rcPath.join(' + JSON.stringify(workspace) + ', ' + JSON.stringify(module) + ", '.test/testability/pages/Index.ets');",
    "    const original = rcFs.readFileSync(file, 'utf8');",
    '    const pattern = /Hypium\\.hypiumTest\\(([^\\n]+),\\s*testsuite\\)/;',
    "    if (!pattern.test(original)) throw new Error('Native test-template filter slot is unavailable.');",
    '    const selected = original.replace(pattern, (_match, args) => "Hypium.hypiumTest(" + args + ", () => { Core.getInstance().getDefaultService(\\\"config\\\").class = " + ' + JSON.stringify(JSON.stringify(selector)) + ' + "; testsuite(); })");',
    '    rcFs.writeFileSync(file, selected.replace("import {Hypium}", "import {Hypium, Core}"));',
    '  });',
    '});',
  ].join('\n');
  await fs.appendFile(path.join(workspace, 'hvigorfile.ts'), '\n' + hook + '\n');
}

// Run the public contract case in a fresh native process: an earlier suite's
// static mocks must not pollute its before/after comparison.
export async function installRegressionContractProbe(workspace, source) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > 128 * 1024)
    throw new Error('Contract probe must be a nonempty ArkTS module below 128 KiB.');
  const root = path.join(workspace, 'entry/src/test');
  await fs.copyFile(path.join(root, 'List.test.ets'), path.join(root, '__rc_original_list.test.ets'), constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, '__rc_contract_probe.test.ets'), source, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'List.test.ets'), `import contractProbe from './__rc_contract_probe.test'
export default function testsuite(): void { contractProbe() }
`);
}

// A Stop may already have observed the source tree, including build caches.
// Run the mutating toolchain in a sibling snapshot, outside that observed tree.
export async function prepareRegressionWorkspace(project, { originalTestCommit, signal } = {}) {
  const source = await fs.realpath(project);
  const options = { cwd: source, windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 };
  let testRoots = [];
  if (originalTestCommit !== undefined) {
    if (!/^[a-f0-9]{40}$/u.test(originalTestCommit)) throw new Error('Original tests require the exact baseline commit.');
    const { stdout } = await run('git', ['ls-tree', '-r', '--full-tree', '--name-only', '-z', originalTestCommit], options);
    testRoots = [...new Set(stdout.split('\0').flatMap(file => {
      const match = suiteRoot.exec(file);
      return match ? [file.slice(0, match.index + match[0].length)] : [];
    }))];
    if (!testRoots.length) throw new Error('The original commit has no public ArkTS unit test directories.');
  }
  const workspace = await fs.mkdtemp(path.join(path.dirname(source), 'rc-regression-'));
  await fs.cp(source, workspace, { recursive: true, dereference: true,
    filter(file) {
      if (file === source) return true;
      return !generated.has(path.basename(file)) && (!originalTestCommit || !suiteRoot.test(path.relative(source, file).replaceAll('\\', '/')));
    } });
  if (originalTestCommit) {
    const archive = `${workspace}.tar`;
    try {
      await run('git', ['--literal-pathspecs', 'archive', '--format=tar', `--output=${archive}`, originalTestCommit, '--', ...testRoots], options);
      await run('tar', ['-xf', archive, '-C', workspace], options);
    } finally { await fs.rm(archive, { force: true }); }
  }
  await fs.writeFile(workspace + '.json', JSON.stringify({ source, workspace, createdAt: new Date().toISOString(),
    ...(originalTestCommit ? { originalTestCommit, testRoots } : {}),
    purpose: 'Public local tests; toolchain outputs are isolated from the Stop evidence tree.' }, null, 2));
  return workspace;
}
