#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { digest, validateArktsAgentInput } from './bench/arkts-dataset.mjs';
import { loadArktsPublicAcceptance } from './bench/arkts-public-acceptance.mjs';

const serviceDirectory = 'entry/src/main/ets/services';
const defaultBackend = 'https://happyword.cool';
const manifestPath = '/api/v1/preview-urls.json';
const latestPackPath = '/api/v1/packs/latest.json';
const routes = {
  manifest: ['RemoteWordPackConfig', 'PreviewManifestService'],
  pack: ['RemoteWordPackConfig', 'BackendEnv', 'BackendHeaders', 'RemoteWordPackService', 'WordPackCache', 'WordPackSyncService'],
};
const configurations = [
  { mode: 'debug', environment: 'local' },
  { mode: 'debug', environment: 'preview', previewUrl: 'https://preview.example.invalid' },
  { mode: 'debug', environment: 'staging' },
  { mode: 'debug', environment: 'prod' },
  { mode: 'release', environment: 'preview', previewUrl: 'https://preview.example.invalid' },
  { mode: 'debug', environment: 'staging', override: 'https://override.example.invalid' },
];

async function readSource(root, relative, expectedSha256) {
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/u, `Supply the approved SHA-256 for ${relative}`);
  const file = path.join(root, relative);
  const stat = await fs.lstat(file);
  assert(stat.isFile() && stat.size <= 1024 * 1024 && await fs.realpath(file) === file, `Invalid source path ${relative}`);
  const bytes = await fs.readFile(file);
  assert.equal(digest(bytes), expectedSha256, `Source digest changed for ${relative}`);
  const source = bytes.toString('utf8');
  assert(Buffer.from(source).equals(bytes), `Expected UTF-8 source for ${relative}`);
  return source;
}

function compile(ts, source, file) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: file.replace(/\.ets$/u, '.ts'),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  const error = diagnostics.find(item => item.category === ts.DiagnosticCategory.Error);
  assert(!error, `Unable to transpile ${file}: ${error && ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return outputText;
}

// Run evaluator-approved public sources with detached process state and no
// real application modules. All app inputs and stubs are created inside the VM.
function expectedUrl(route, scenario) {
  if (route === 'manifest') return defaultBackend + manifestPath;
  const backend = scenario.override || (scenario.mode === 'debug' && scenario.environment === 'local' ? 'http://10.0.2.2:8000'
    : scenario.mode === 'debug' && scenario.environment === 'preview' ? scenario.previewUrl : defaultBackend);
  return backend + latestPackPath;
}

function exercise(route, modules, scenario) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  const program = new vm.Script(`
    const scenario = ${JSON.stringify(scenario)};
    const route = ${JSON.stringify(route)};
    const factories = {
      ${modules.map(({ name, javascript }) => `'./${name}': function(require, module, exports) {\n${javascript}\n}`).join(',\n')}
    };
    const requests = [];
    let closed = 0;
    const appStorage = {
      backend_env_cache: scenario.environment,
      backend_preview_url_cache: scenario.previewUrl,
      serverBaseUrlOverride: scenario.override,
    };
    const AppStorage = { get: key => appStorage[key] };
    const console = { error() {} };
    const buildProfile = { BUILD_MODE_NAME: scenario.mode };
    const http = {
      RequestMethod: { GET: 'GET' },
      createHttp() {
        return {
          async request(url, { method }) {
            requests.push({ url, method });
            const result = route === 'manifest' ? '{"schema_version":1,"updated_at":"fixture","previews":[]}'
              : '{"schema_version":1,"version":7,"words":[{"word":"one"},{"word":"two"},{"word":"three"}]}';
            return { responseCode: 200, result };
          },
          destroy() { closed++; },
        };
      },
    };
    const loaded = { BuildProfile: buildProfile, '@ohos.net.http': http, '@kit.NetworkKit': { http }, '@ohos.data.preferences': {} };
    function load(id) {
      if (Object.hasOwn(loaded, id)) return loaded[id];
      if (!Object.hasOwn(factories, id)) throw new Error('Unexpected application dependency ' + id);
      const module = { exports: {} };
      loaded[id] = module.exports;
      factories[id](load, module, module.exports);
      loaded[id] = module.exports;
      return module.exports;
    }
    const config = load('./RemoteWordPackConfig');
    async function runConsumer() {
      if (route === 'manifest') {
        const manifest = await load('./PreviewManifestService').fetchManifest(true);
        return { parsedFixture: manifest?.updated_at === 'fixture', helperUrl: config.PREVIEW_MANIFEST_JSON_URL };
      }
      const { WordPackCache } = load('./WordPackCache');
      const { RemoteWordPackService } = load('./RemoteWordPackService');
      const { WordPackSyncService, SyncStatus } = load('./WordPackSyncService');
      const cached = new Map();
      const cache = new WordPackCache();
      cache.injectPreferencesForTest({
        async getString(key) { return cached.get(key) ?? ''; },
        async putString(key, value) { cached.set(key, value); },
        async flush() {},
      });
      const result = await new WordPackSyncService(new RemoteWordPackService(), cache).syncOnce();
      const record = await cache.readRecord();
      return { parsedFixture: result.status === SyncStatus.Updated && result.cachedVersion === 7
        && JSON.parse(record?.body ?? '{}').words?.length === 3,
        helperUrl: typeof config.latestPackUrl === 'function' ? config.latestPackUrl() : null };
    }
    runConsumer().then(
      result => { globalThis.observation = JSON.stringify({ ...result, requests, closed }); },
      error => { globalThis.replayError = String(error); },
    );
  `, { filename: 'happyword-manifest-route.js' });
  program.runInContext(context, { timeout: 2000 });
  assert(!context.replayError, context.replayError);
  assert.equal(typeof context.observation, 'string', 'The request did not complete in the offline harness');
  return JSON.parse(context.observation);
}

async function main() {
  const names = ['project', 'tool-root', 'public-input', 'route', 'source-manifest'];
  const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
  for (const name of names) assert(values[name], `--${name} is required`);
  const root = await fs.realpath(values.project);
  const publicBytes = await fs.readFile(values['public-input']);
  const publicInputSha256 = digest(publicBytes);
  const task = validateArktsAgentInput(JSON.parse(publicBytes.toString('utf8')), 'happyword_13');
  const original = await loadArktsPublicAcceptance(task, publicInputSha256);
  assert(Object.hasOwn(routes, values.route), '--route must be manifest or pack');
  const sourceManifest = JSON.parse(await fs.readFile(values['source-manifest'], 'utf8'));
  const selectedFiles = routes[values.route];
  assert(sourceManifest && Object.keys(sourceManifest).length === selectedFiles.length
    && selectedFiles.every(file => Object.hasOwn(sourceManifest, `${file}.ets`)), 'Source manifest does not match the selected route');
  const compilerPath = path.join(await fs.realpath(values['tool-root']), 'hvigor/hvigor/node_modules/typescript/lib/typescript.js');
  const ts = createRequire(import.meta.url)(compilerPath);
  const modules = await Promise.all(selectedFiles.map(async name => {
    const file = `${serviceDirectory}/${name}.ets`;
    const sha256 = sourceManifest[`${name}.ets`];
    return { name, path: file, sha256, javascript: compile(ts, await readSource(root, file, sha256), file) };
  }));
  const cases = configurations.map(scenario => {
    const observed = exercise(values.route, modules, scenario);
    assert(observed.parsedFixture && observed.closed === 1 && observed.requests.length === 1
      && observed.requests[0].method === 'GET', 'The stubbed HTTP consumer did not complete exactly one GET');
    const requestUrl = observed.requests[0].url;
    const expected = expectedUrl(values.route, scenario);
    return { ...scenario, requestUrl, helperUrl: observed.helperUrl, expectedUrl: expected, passed: requestUrl === expected };
  });
  const passed = cases.filter(result => result.passed).length;
  console.log(JSON.stringify({
    kind: 'happyword-request-route-replay', route: values.route,
    scope: 'Offline replay of the selected public source modules with recording HTTP and in-memory preferences.',
    status: passed === cases.length ? 'PASS' : 'FAIL', passed, total: cases.length,
    publicInputSha256, standingProbeIdentity: original.identitySha256,
    compiler: { version: ts.version, sha256: digest(await fs.readFile(compilerPath)) },
    sources: modules.map(({ path: file, sha256 }) => ({ path: file, sha256 })),
    cases,
  }, null, 2));
  process.exitCode = passed === cases.length ? 0 : 1;
}

await main().catch(error => {
  console.error(JSON.stringify({ kind: 'happyword-request-route-replay', status: 'UNVERIFIED', reason: error.message }));
  process.exitCode = 2;
});
