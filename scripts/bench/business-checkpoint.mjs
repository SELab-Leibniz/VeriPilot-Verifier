import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';

const run = promisify(execFile);
const excluded = ['.runtime-corrector', '.runtime-correction', '.openclaw', '.hvigor', '.test', 'oh_modules', 'node_modules', 'build'];

// A separate index captures tracked and new business files without committing
// or changing the index under the live Stop reviewer.
export async function captureBusinessCheckpoint({ outputRoot, projectRoot, preparedHead, runId, sessionId, stopReason, success }) {
  if (!/^[a-f0-9]{40}$/u.test(preparedHead)) throw new Error('Exact prepared commit required');
  const directory = path.join(outputRoot, 'checkpoints', randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const index = path.join(directory, 'index');
  const git = async (...args) => (await run('git', ['-c', 'core.longpaths=true', ...args], {
    cwd: projectRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'buffer',
  })).stdout;
  await git('read-tree', preparedHead);
  await git('add', '--all', '--', '.', ...excluded.map(name => `:(exclude,glob)**/${name}/**`));
  const patch = await git('diff', '--cached', '--binary', preparedHead);
  const paths = (await git('diff', '--cached', '--name-only', '-z', preparedHead)).toString().split('\0').filter(Boolean);
  await fs.writeFile(path.join(directory, 'candidate.patch'), patch);
  const receipt = { runId, sessionId, stopReason, success, capturedAt: new Date().toISOString(), preparedHead,
    paths, patchSha256: createHash('sha256').update(patch).digest('hex') };
  await fs.writeFile(path.join(directory, 'checkpoint.json'), JSON.stringify(receipt, null, 2));
  const coverage = path.join(projectRoot, 'entry/.test/default/intermediates/test/coverage_data/coverage.log');
  await fs.copyFile(coverage, path.join(directory, 'public-tests.log')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { directory, ...receipt };
}

export async function createBusinessCheckpointObserver(options) {
  const root = path.join(options.outputRoot, 'checkpoint-observer');
  await fs.mkdir(root);
  const id = 'rc-business-checkpoints';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(root, 'openclaw.plugin.json'), JSON.stringify({ id, name: id, main: './index.mjs',
    activation: { onStartup: true }, configSchema: { type: 'object', properties: {} } }));
  await fs.writeFile(path.join(root, 'index.mjs'), `import path from 'node:path';
import { captureBusinessCheckpoint } from ${JSON.stringify(import.meta.url)};
const checkpoints = new Map();
export default { id: ${JSON.stringify(id)}, register(api) {
  api.on('before_agent_finalize', async (event, ctx) => {
    if (!ctx.sessionKey?.startsWith('agent:main:arkts-') || path.resolve(ctx.workspaceDir ?? '') !== path.resolve(${JSON.stringify(options.projectRoot)})) return;
    const captured = await captureBusinessCheckpoint({ ...${JSON.stringify(options)}, runId: event.runId ?? ctx.runId,
      sessionId: event.sessionId ?? ctx.sessionId, stopReason: 'before_agent_finalize' });
    checkpoints.set(captured.runId, captured);
  }, { priority: 1000 });
  api.on('agent_end', async (event, ctx) => {
    const captured = checkpoints.get(event.runId ?? ctx.runId);
    if (!captured || !ctx.sessionKey?.startsWith('agent:main:arkts-')) return;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(captured.directory, 'checkpoint.json'), JSON.stringify({ ...captured,
      event: 'agent_end', success: event.success === true && !event.error && !event.aborted,
      completedAt: new Date().toISOString() }, null, 2));
  });
} };
`);
  return { id, path: root, hooks: { allowConversationAccess: true, allowPromptInjection: true } };
}
