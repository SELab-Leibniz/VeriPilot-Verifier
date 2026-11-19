import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { copyArktsPublicTestSnapshot } from './arkts-public-test-snapshot.mjs';
import { runBoundedProcess } from './bounded-process.mjs';

const configName = 'code-linter.json5';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const relativeTo = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : relative;
};

async function readRegular(file, { limit, notBefore = 0, signal } = {}) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && stat.size > 0 && stat.size <= limit && stat.mtimeMs >= notBefore);
  const bytes = await fs.readFile(file, { signal });
  assert.equal(bytes.length, stat.size);
  return bytes;
}

async function verifyProjectScope(snapshot, tools, signal) {
  const plugin = path.join(tools, 'hvigor/hvigor-ohos-plugin');
  const require = createRequire(path.join(plugin, 'package.json'));
  const parser = await fs.realpath(require.resolve('json5'));
  assert(relativeTo(path.join(plugin, 'node_modules/json5'), parser) !== null);
  const { parse } = require(parser);
  const readProfile = async root => parse((await readRegular(path.join(root, 'build-profile.json5'), { limit: 1024 * 1024, signal })).toString('utf8'));
  const resolve = (root, declared) => {
    assert(typeof declared === 'string' && declared && !path.isAbsolute(declared) && !/[\\\0]/u.test(declared));
    const resolved = path.resolve(root, declared);
    assert(relativeTo(snapshot, resolved) !== null);
    return resolved;
  };
  const { modules } = await readProfile(snapshot);
  assert(Array.isArray(modules) && modules.length);
  for (const { srcPath } of modules) {
    const module = resolve(snapshot, srcPath);
    const { targets = [] } = await readProfile(module);
    assert(Array.isArray(targets));
    for (const { resource } of targets) if (resource?.directories !== undefined) {
      assert(Array.isArray(resource.directories));
      for (const entry of resource.directories) resolve(module, entry);
    }
  }
}

async function readReport(bytes, snapshot) {
  const files = JSON.parse(bytes);
  assert(Array.isArray(files), 'Expected the CodeLinter JSON report array');
  const counts = { error: 0, warn: 0, suggestion: 0 }, issues = [];
  const text = value => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, 240);
  for (const item of files) {
    assert(typeof item?.filePath === 'string' && item.filePath && Array.isArray(item.messages));
    const absolute = path.resolve(snapshot, item.filePath), file = relativeTo(snapshot, absolute);
    assert(file && (await fs.lstat(absolute)).isFile() && await fs.realpath(absolute) === absolute);
    for (const entry of item.messages) {
      assert(entry && Object.hasOwn(counts, entry.severity) && typeof entry.message === 'string' && typeof entry.rule === 'string'
        && Number.isSafeInteger(entry.line) && entry.line >= 0 && Number.isSafeInteger(entry.column) && entry.column >= 0);
      counts[entry.severity]++;
      if (issues.length < 10) issues.push({ file: text(file.replaceAll('\\', '/')), line: entry.line, column: entry.column,
        severity: entry.severity, rule: text(entry.rule), message: text(entry.message) });
    }
  }
  return { diagnosticCount: counts.error + counts.warn + counts.suggestion, errorCount: counts.error,
    warningCount: counts.warn, suggestionCount: counts.suggestion, issues };
}

function readAuditorSummary(bytes, snapshot) {
  const log = bytes.toString('utf8');
  const counts = [...log.matchAll(/-Defects:(\d+);Errors:(\d+) Warns:(\d+);Infos:(\d+);/gu)];
  assert.equal(counts.length, 1, 'Expected one fresh native auditor summary');
  const [, total, error, warn, info] = counts[0].map(Number);
  assert([total, error, warn, info].every(Number.isSafeInteger) && total === error + warn + info);
  assert(log.includes(`Executing on: ${snapshot}${path.sep}`) && log.includes('hpauditor completed, exitCode:0'));
  return { auditorErrorCount: error, auditorWarningCount: warn, auditorSuggestionCount: info };
}

// output, when provided, is a new receipt file selected by the benchmark harness.
export async function runArktsCheckedLint({ projectRoot, toolRoot, javaHome, output, configSha256, timeoutMs = 60_000, signal },
  { invoke = runBoundedProcess, platform = process.platform } = {}) {
  assert.match(configSha256 ?? '', /^[a-f0-9]{64}$/u, 'CodeLinter requires a pinned project config');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647, 'CodeLinter requires a bounded deadline');
  const deadline = performance.now() + timeoutMs;
  const limit = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, limit]) : limit;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const receipt = { status: 'INCOMPLETE', confirmed: false, sourceChanged: null, diagnosticCount: null, freshReport: false,
    reason: 'LINTER_UNSUPPORTED_HOST', configSha256, snapshotSha256: null, reportSha256: null, vendorIndexSha256: null,
    hpauditorIndexSha256: null, hpauditorBinarySha256: null, execution: null };
  const project = await fs.realpath(projectRoot).catch(() => null);
  const tools = await fs.realpath(toolRoot).catch(() => null);
  let receiptPath;
  if (output !== undefined) {
    const destination = path.resolve(output);
    receiptPath = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
    assert((!project || relativeTo(project, receiptPath) === null) && (!tools || relativeTo(tools, receiptPath) === null),
      'Lint receipts must stay outside the active project and installed vendor toolchain');
  }
  const finish = async () => {
    if (receiptPath) await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  };
  if (platform !== 'darwin') return finish();
  let root;
  try {
    receipt.reason = 'LINTER_SNAPSHOT_UNAVAILABLE';
    bounded.throwIfAborted();
    assert(project);
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rc-arkts-lint-'));
    const snapshot = path.join(root, 'source'), clone = path.join(root, 'codelinter');
    receipt.snapshotSha256 = await copyArktsPublicTestSnapshot(project, snapshot, { signal: bounded });
    receipt.reason = 'LINTER_CONFIG_UNVERIFIED';
    assert.equal(sha256(await readRegular(path.join(snapshot, configName), { limit: 1024 * 1024, signal: bounded })), configSha256);

    receipt.reason = 'LINTER_TOOLCHAIN_UNAVAILABLE';
    assert(tools);
    const vendor = path.join(tools, 'codelinter'), node = path.join(tools, 'tool/node/bin/node'), sdk = path.join(tools, 'sdk');
    const java = await fs.realpath(javaHome);
    assert((await fs.lstat(vendor)).isDirectory() && (await fs.lstat(path.join(vendor, 'linter'))).isDirectory());
    await fs.access(node, constants.X_OK);
    await fs.access(path.join(java, 'bin/java'), constants.X_OK);
    assert((await fs.stat(sdk)).isDirectory());
    const identities = {
      vendorIndexSha256: 'index.js', hpauditorIndexSha256: 'linter/performanceAgent/index.js', hpauditorBinarySha256: 'linter/performanceAgent/hpaudit',
    };
    const copiedEntry = path.join(clone, identities.vendorIndexSha256);
    const options = { limit: 8 * 1024 * 1024, signal: bounded };
    for (const [key, file] of Object.entries(identities)) {
      const absolute = path.join(vendor, file);
      assert.equal(await fs.realpath(absolute), absolute);
      receipt[key] = sha256(await readRegular(absolute, options));
    }
    receipt.reason = 'LINTER_PROJECT_SCOPE_UNVERIFIED';
    await verifyProjectScope(snapshot, tools, bounded);
    receipt.reason = 'LINTER_TOOLCHAIN_UNAVAILABLE';
    const copied = await invoke('/bin/cp', ['-cRP', vendor, clone], { cwd: root, env: { PATH: '/usr/bin:/bin' },
      signal: bounded, timeoutMs: remaining(), processGroup: true });
    assert(copied.exitCode === 0 && copied.outputComplete && !copied.interrupted);
    for (const [key, file] of Object.entries(identities)) {
      const absolute = path.join(clone, file);
      assert.equal(await fs.realpath(absolute), absolute);
      assert.equal(sha256(await readRegular(absolute, options)), receipt[key]);
    }
    assert((await fs.lstat(path.join(clone, 'linter'))).isDirectory());
    const logs = path.join(clone, 'linter/result');
    await fs.rm(logs, { recursive: true, force: true });

    receipt.reason = 'LINTER_EXECUTION_UNAVAILABLE';
    const report = path.join(root, 'lint-report.json'), startedAt = Date.now();
    const { exitCode, interrupted, outputComplete, reason, durationMs, tail } = await invoke(node,
      [copiedEntry, sdk, '-c', `./${configName}`, '.', '--fix', '--format', 'json', '--output', report, '--exit-on', 'error'],
      { cwd: snapshot, timeoutMs: remaining(), signal: bounded, processGroup: true,
        env: { TMPDIR: root, XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root, JAVA_HOME: java,
          DEVECO_NODE_HOME: path.dirname(path.dirname(node)), DEVECO_SDK_HOME: sdk,
          PATH: `${path.dirname(node)}:${path.join(java, 'bin')}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', DO_NOT_TRACK: '1' } });
    receipt.execution = { exitCode, interrupted, outputComplete, reason, durationMs };
    assert(!interrupted && outputComplete && [0, 1].includes(exitCode));

    receipt.reason = 'LINTER_SNAPSHOT_UNVERIFIED';
    receipt.sourceChanged = receipt.snapshotSha256 !== await copyArktsPublicTestSnapshot(snapshot, undefined, { signal: bounded });
    receipt.reason = 'LINTER_REPORT_UNVERIFIED';
    assert(typeof tail === 'string' && /Finished\.\.\.\[=+\]100%/u.test(tail) && tail.includes('Write finished.'));
    const evidenceOptions = { limit: 8 * 1024 * 1024, notBefore: startedAt - 1000, signal: bounded };
    const reportBytes = await readRegular(report, evidenceOptions);
    const diagnostics = await readReport(reportBytes, snapshot);
    Object.assign(receipt, diagnostics, { freshReport: true, reportSha256: sha256(reportBytes) });

    receipt.reason = 'LINTER_AUDITOR_UNVERIFIED';
    const auditor = readAuditorSummary(await readRegular(path.join(logs, 'hpauditor.log'), evidenceOptions), snapshot);
    Object.assign(receipt, auditor);
    // The vendor CLI can return [] and exit zero after losing engine findings.
    receipt.reason = 'LINTER_AGGREGATE_MISMATCH';
    assert(diagnostics.errorCount >= auditor.auditorErrorCount && diagnostics.warningCount >= auditor.auditorWarningCount
      && diagnostics.suggestionCount >= auditor.auditorSuggestionCount && (exitCode === 0) === (diagnostics.errorCount === 0));
    bounded.throwIfAborted();
    assert(performance.now() < deadline);
    receipt.confirmed = true;
    receipt.status = receipt.sourceChanged || diagnostics.errorCount ? 'FAIL' : 'PASS';
    receipt.reason = receipt.sourceChanged ? 'LINTER_FIXES_REQUIRED' : diagnostics.errorCount ? 'LINTER_ERRORS' : null;
  } catch {
    if (signal?.aborted) receipt.reason = 'LINTER_CANCELLED';
    else if (limit.aborted || performance.now() >= deadline) receipt.reason = 'LINTER_DEADLINE';
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
  return finish();
}
