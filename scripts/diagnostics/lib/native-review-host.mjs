// Real installed public host APIs, with all writable state under this RC run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlugin } from '../../../lib/plugin-builder.mjs';
import { createNativeReviewerRunner } from '../../../lib/openclaw/compat-2026.10.3.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function installArtifactDependencies(pluginRoot) {
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await fs.access(npmCli);
  await promisify(execFile)(process.execPath, [npmCli, 'ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.resolve('.runtime-correction/npm-cache')], { cwd: pluginRoot, windowsHide: true });
}

export async function isolatedNativeReviewHost({ config, directory, hostRoot = process.env.RC_OPENCLAW_HOST_ROOT }) {
  if (!hostRoot) throw new Error('RC_OPENCLAW_HOST_ROOT must name the read-only installed host');
  const root = path.resolve(directory), repository = path.resolve('.');
  if (!root.startsWith(repository + path.sep)) throw new Error('Native diagnostic state must stay inside RC');
  await fs.mkdir(root, { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(hostRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || pkg.version !== '2026.10.3') throw new Error('This diagnostic verifies OpenClaw 2026.10.3 only');
  const saved = {}, set = (name, value) => { saved[name] = process.env[name]; process.env[name] = value; };
  for (const name of ['home', 'state', 'temp', 'workspace']) await fs.mkdir(path.join(root, name), { recursive: true });
  set('OPENCLAW_HOME', path.join(root, 'home')); set('OPENCLAW_STATE_DIR', path.join(root, 'state'));
  set('OPENCLAW_CONFIG_PATH', path.join(root, 'openclaw.json')); set('TEMP', path.join(root, 'temp')); set('TMP', path.join(root, 'temp'));
  const close = () => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  try {
    const pluginRoot = await buildPlugin({ host: 'openclaw', sourceRoot: repository, outputRoot: path.join(root, 'plugin') });
    await installArtifactDependencies(pluginRoot);
    config = structuredClone(config);
    config.agents = { ...config.agents, defaults: { ...config.agents?.defaults, workspace: path.join(root, 'workspace'), skipBootstrap: true } };
    config.logging = { ...config.logging, level: 'error', consoleLevel: 'error', file: path.join(root, 'host.log') };
    config.plugins = { enabled: true, allow: ['runtime-corrector'], load: { paths: [pluginRoot] }, entries: {
      'runtime-corrector': { enabled: true, hooks: { allowPromptInjection: true, allowConversationAccess: true } } } };
    // Credentials remain in memory; the disk configuration only locates the plugin.
    const publicConfig = { agents: { defaults: { workspace: path.join(root, 'workspace'), skipBootstrap: true } }, plugins: config.plugins, logging: config.logging };
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(publicConfig));
    const load = name => import(pathToFileURL(path.join(hostRoot, 'dist/plugin-sdk', `${name}.js`)));
    const [{ createPluginRuntime }, sessions, diagnostics, agent] = await Promise.all([
      import(pathToFileURL(path.join(hostRoot, 'dist/plugins/runtime/index.js'))), load('session-store-runtime'), load('diagnostic-runtime'), load('agent-harness-runtime')]);
    const runtime = createPluginRuntime();
    const compatibility = async () => ({ formatSessionMarker: sessions.formatSqliteSessionFileMarker,
      deleteSessionEntry: sessions.deleteSessionEntry, onRunActivity: diagnostics.onInternalDiagnosticEvent,
      onAgentEvent: agent.onAgentEvent, emitAgentEvent: agent.emitAgentEvent,
      reportProgress: (parent, reason) => diagnostics.emitTrustedDiagnosticEvent({ type: 'run.progress', reason, ...parent }) });
    const api = { rootDir: pluginRoot, config, runtime: { ...runtime, version: pkg.version, config: { current: () => config } } };
    return { api, runEmbeddedAgent: createNativeReviewerRunner(api, compatibility), compatibility, close, hostVersion: pkg.version };
  } catch (error) { close(); throw error; }
}
