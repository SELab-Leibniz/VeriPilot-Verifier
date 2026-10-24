import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

export const exec = promisify(execFile);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export async function sourceRepo(value = process.env.REVIEW_SOURCE_REPO ?? process.cwd()) {
  const root = await fs.realpath(value);
  const top = (await exec('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if ((await fs.realpath(top)).toLowerCase() !== root.toLowerCase()) throw new Error('Source repo must be its explicit Git top-level directory');
  await fs.access(path.join(root, 'examples/openclaw-offline-kitchen/app/kitchen.py'));
  return root;
}
export async function newOutput(repository, value) {
  const lab = await fs.realpath(path.join(repository, '.runtime-correction/review-module-lab-20261024-02'));
  const destination = path.resolve(value);
  const parent = await fs.realpath(path.dirname(destination));
  if (!within(lab, parent) || destination.toLowerCase() === lab.toLowerCase()) throw new Error('Output must be a new child directory in the ignored experiment lab');
  await fs.mkdir(destination, { recursive: false });
  return destination;
}
export async function copyHashed(source, destination, expected) {
  const bytes = await fs.readFile(source);
  const actual = sha256(bytes);
  if (expected && expected !== actual) throw new Error(`Frozen capture hash mismatch: ${source}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  return { source, destination, bytes: bytes.length, sha256: actual };
}
export async function confirmUnchanged(records) {
  for (const item of records) if (sha256(await fs.readFile(item.source)) !== item.sha256) throw new Error(`Read-only source changed: ${item.source}`);
  return true;
}
export async function trackedState(repository) {
  const state = await exec('git', ['--no-optional-locks', '-C', repository, 'status', '--porcelain=v1', '--untracked-files=no']);
  const files = (await exec('git', ['--no-optional-locks', '-C', repository, 'ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  const hashes = [];
  for (const name of files) {
    try { hashes.push([name, sha256(await fs.readFile(path.join(repository, name)))]); }
    catch (error) { if (error.code === 'ENOENT') hashes.push([name, null]); else throw error; }
  }
  return { head: (await exec('git', ['--no-optional-locks', '-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(), status: state.stdout, sha256: sha256(JSON.stringify(hashes)), files: hashes.length };
}
// Only explicit --live callers reach existing authorized model configuration.
// No credential, raw provider config, or environment values are persisted.
export async function authorizedRuntime(output) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const configFile = path.join(os.homedir(), '.openclaw/openclaw.json');
  const cacheFile = path.join(os.homedir(), '.openclaw/agents/main/agent/models.json');
  const configBytes = await fs.readFile(configFile), cacheBytes = await fs.readFile(cacheFile);
  const config = JSON.parse(configBytes), cache = JSON.parse(cacheBytes);
  const configured = config.agents.defaults.model;
  const primary = typeof configured === 'string' ? configured : configured.primary;
  const slash = primary.indexOf('/'), providerId = primary.slice(0, slash), modelId = primary.slice(slash + 1);
  const provider = config.models.providers[providerId], cached = cache.providers?.[providerId] ?? {};
  const resolve = value => typeof value === 'string' ? value.replace(/\$\{([^}]+)\}/gu, (_match, name) => {
    if (!process.env[name]) throw new Error('Missing configured credential environment variable');
    return process.env[name];
  }) : value;
  const key = resolve(provider.apiKey ?? cached.apiKey);
  if (!key || provider.api !== 'openai-completions') throw new Error('Expected existing authorized OpenAI-compatible provider');
  const runtime = await ModelRuntime.create({ authPath: path.join(output, 'unused-auth.json'), modelsPath: null, refreshOnCreate: false });
  const configuredModel = provider.models.find(item => item.id === modelId);
  if (!configuredModel) throw new Error('Configured model is missing');
  runtime.registerProvider('review-experiment', { api: provider.api, baseUrl: provider.baseUrl, apiKey: key,
    headers: Object.fromEntries(Object.entries(provider.headers ?? cached.headers ?? {}).map(([name, value]) => [name, resolve(value)])),
    models: [{ ...configuredModel, name: modelId, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  return { runtime, model: runtime.getModel('review-experiment', modelId), primary,
    unchanged: async () => (await fs.readFile(configFile)).equals(configBytes) && (await fs.readFile(cacheFile)).equals(cacheBytes) };
}
