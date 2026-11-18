import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { openSpecTaskTextSha256 } from '../../lib/openspec-plan.mjs';

export { openSpecTaskTextSha256 };

const run = promisify(execFile);
const excluded = ['.runtime-corrector', '.runtime-correction', '.openclaw', '.hvigor', '.test', 'oh_modules', 'node_modules', 'build'];
export const arktsBusinessDiffScope = Object.freeze(['.', ':(exclude,glob)openspec/**', ':(exclude,glob).opencode/**']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function isArktsCheckpointPath(file) {
  return !file.split('/').slice(0, -1).some(part => excluded.includes(part));
}

async function captureProposalPolicy(projectRoot, requirePolicy) {
  const root = path.join(projectRoot, '.runtime-corrector');
  try { await fs.lstat(root); }
  catch (error) { return { status: error.code === 'ENOENT' ? 'ABSENT' : 'UNVERIFIED', sha256: null }; }
  const files = [];
  async function collect(relative) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await collect(relative ? `${relative}/${name}` : name);
    } else if (relative && stat.isFile()) files.push([relative, sha256(await fs.readFile(absolute))]);
    else throw new Error('Policy scope includes a non-regular entry');
  }
  try { await collect(''); }
  catch { return { status: 'UNVERIFIED', sha256: null }; }
  if (requirePolicy && !files.some(([file]) => file === 'config.yaml')) return { status: 'UNVERIFIED', sha256: null };
  return { status: 'CAPTURED', sha256: sha256(JSON.stringify(files)) };
}

async function readWorkflowFile(root, relative) {
  const absolute = path.join(root, relative);
  try {
    return (await fs.lstat(absolute)).isFile() && await fs.realpath(absolute) === absolute ? await fs.readFile(absolute) : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

async function captureProposalRepairScope({ git, projectRoot, changeName, requirePolicy }) {
  const root = await fs.realpath(projectRoot);
  const prefix = `openspec/changes/${changeName}/`;
  const checklistPath = `${prefix}tasks.md`;
  const draftFiles = [], fixedEntries = createHash('sha256'), workflowEntries = createHash('sha256');
  let regularChecklist = false;
  const entries = await git('ls-files', '--stage', '-z');
  for (let start = 0; start < entries.length;) {
    const end = entries.indexOf(0, start);
    if (end < 0) throw new Error('Invalid proposal repair Git index entry');
    const entry = entries.subarray(start, end + 1);
    start = end + 1;
    const headerEnd = entry.indexOf(9);
    const [mode, blob, stage] = entry.subarray(0, headerEnd).toString('ascii').split(' ');
    if (stage !== '0') throw new Error('Unmerged entry in proposal repair Git index');
    const file = entry.subarray(headerEnd + 1, -1).toString('utf8');
    const relative = file.startsWith(prefix) ? file.slice(prefix.length) : '';
    const regular = mode === '100644' || mode === '100755';
    if (file === checklistPath) {
      regularChecklist = regular;
      workflowEntries.update(JSON.stringify([file, mode]) + '\0');
    } else if (/^(?:openspec|\.opencode)\//u.test(file)) workflowEntries.update(entry);
    if (regular && (relative === 'proposal.md' || relative === 'design.md' || /^specs\/.+\/spec\.md$/u.test(relative))) {
      draftFiles.push({ path: file, mode, blob });
    } else fixedEntries.update(entry);
  }
  const checklist = regularChecklist ? await readWorkflowFile(root, checklistPath) : null;
  const tasksMdSha256 = checklist && sha256(checklist);
  const taskTextSha256 = checklist && openSpecTaskTextSha256(checklist);
  const documentHashes = await Promise.all(draftFiles.map(async ({ path: file }) => {
    const bytes = await readWorkflowFile(root, file);
    return [file, bytes && sha256(bytes)];
  }));
  const approvedDocumentsSha256 = documentHashes.every(([, hash]) => hash !== null) ? sha256(JSON.stringify(documentHashes)) : null;
  const policy = await captureProposalPolicy(root, requirePolicy);
  const policyComplete = policy.status === 'CAPTURED' || !requirePolicy && policy.status === 'ABSENT';
  const draftPaths = new Set(draftFiles.map(file => file.path));
  const complete = policyComplete && taskTextSha256 !== null && approvedDocumentsSha256 !== null
    && draftPaths.has(`${prefix}proposal.md`) && draftPaths.has(`${prefix}design.md`)
    && draftFiles.some(file => file.path.startsWith(`${prefix}specs/`));
  return { changeName, complete, tasksMdSha256, draftFiles, policy, taskTextSha256, approvedDocumentsSha256, workflowFilesSha256: workflowEntries.digest('hex'),
    fixedEntriesSha256: fixedEntries.digest('hex'), draftInventorySha256: sha256(JSON.stringify(draftFiles.map(({ path, mode }) => [path, mode]))) };
}

export function sameApplyWorkflowScope(before, after) {
  return Boolean(before?.complete && after?.complete && before.changeName === after.changeName
    && before.workflowFilesSha256 && before.workflowFilesSha256 === after.workflowFilesSha256
    && before.approvedDocumentsSha256 === after.approvedDocumentsSha256
    && before.policy?.status === after.policy?.status && before.policy?.sha256 === after.policy?.sha256);
}

export function sameApplyRecoveryScope(before, after) {
  return sameApplyWorkflowScope(before, after) && Boolean(before.taskTextSha256 && before.taskTextSha256 === after.taskTextSha256);
}

export function compareOpenSpecApplyScope(proposal, apply, { changeName, sessionId, proposalRunId, applyRunId, preparedHead }) {
  const valid = (receipt, runId) => {
    const scope = receipt?.proposalRepairScope, policy = scope?.policy;
    return receipt?.success === true && receipt.runId === runId && receipt.sessionId === sessionId
      && receipt.preparedHead === preparedHead && isSha256(receipt.patchSha256)
      && scope?.changeName === changeName && scope.complete === true
      && [scope.workflowFilesSha256, scope.approvedDocumentsSha256, scope.taskTextSha256].every(isSha256)
      && (policy?.status === 'CAPTURED' && isSha256(policy.sha256) || policy?.status === 'ABSENT' && policy.sha256 === null);
  };
  if (!changeName || !sessionId || !proposalRunId || !applyRunId || proposalRunId === applyRunId
    || !/^[a-f0-9]{40}$/u.test(preparedHead ?? '') || !valid(proposal, proposalRunId) || !valid(apply, applyRunId))
    return { status: 'UNVERIFIED' };
  const before = proposal.proposalRepairScope, after = apply.proposalRepairScope;
  const differences = [];
  if (before.workflowFilesSha256 !== after.workflowFilesSha256 || before.approvedDocumentsSha256 !== after.approvedDocumentsSha256)
    differences.push('workflowFiles');
  if (before.taskTextSha256 !== after.taskTextSha256) differences.push('taskText');
  if (before.policy.status !== after.policy.status || before.policy.sha256 !== after.policy.sha256) differences.push('policy');
  return { status: differences.length ? 'CHANGED' : 'PRESERVED', differences, proposalRunId, applyRunId,
    proposalCheckpointSha256: proposal.patchSha256, applyCheckpointSha256: apply.patchSha256 };
}

export function sameProposalRepairScope(before, after) {
  return Boolean(before?.complete && after?.complete && before.changeName === after.changeName
    && before.fixedEntriesSha256 === after.fixedEntriesSha256 && before.draftInventorySha256 === after.draftInventorySha256
    && before.tasksMdSha256 === after.tasksMdSha256 && before.policy?.status === after.policy?.status
    && before.policy?.sha256 === after.policy?.sha256);
}

// A separate index captures tracked and new business files without committing
// or changing the index under the live Stop reviewer.
export async function captureBusinessCheckpoint({ outputRoot, projectRoot, preparedHead, runId, sessionId, stopReason, success,
  includeBusinessPatch, proposalRepairChange, requireProposalPolicy }) {
  if (!/^[a-f0-9]{40}$/u.test(preparedHead)) throw new Error('Exact prepared commit required');
  if (proposalRepairChange !== undefined && (typeof proposalRepairChange !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(proposalRepairChange))) {
    throw new Error('Invalid proposal repair change name');
  }
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
    paths, patchSha256: sha256(patch) };
  if (includeBusinessPatch) {
    const businessPatch = await git('diff', '--cached', '--binary', preparedHead, '--', ...arktsBusinessDiffScope);
    await fs.writeFile(path.join(directory, 'business-candidate.patch'), businessPatch);
    receipt.businessPatchSha256 = sha256(businessPatch);
  }
  if (proposalRepairChange !== undefined) {
    // Include tracked entries under generated directories without staging new private or generated state.
    await git('add', '--update', '--', '.', ':(exclude,glob).runtime-corrector/**');
    receipt.proposalRepairScope = await captureProposalRepairScope({ git, projectRoot, changeName: proposalRepairChange,
      requirePolicy: requireProposalPolicy });
  }
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
