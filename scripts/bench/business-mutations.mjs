import path from 'node:path';
import fs from 'node:fs/promises';

function mutationPath(file, projectRoot) {
  if (typeof file !== 'string' || !file) throw new Error('Successful source mutation has no attributable path');
  const relative = path.relative(projectRoot, path.resolve(projectRoot, file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Business mutation outside project');
  if (relative.split(path.sep).some(part => ['.git', '.runtime-correction', '.runtime-corrector'].includes(part))) throw new Error('Business mutation targets benchmark control state');
  return relative.replaceAll('\\', '/');
}

export function validateBusinessMutationPaths(files, projectRoot) {
  if (!Array.isArray(files)) throw new Error('Missing captured business mutation scope');
  return [...new Set(files.map(file => mutationPath(file, projectRoot)))].sort();
}

// Follow explicit continuation ancestry only. A maintenance-only attempt must
// preserve earlier business progress without adding its memory writes to it.
export async function inheritedBusinessMutationScope(directory, projectRoot) {
  const seen = new Set(), skippedStartupRuns = []; let identity;
  for (let hop = 0; hop < 64; hop++) {
    directory = await fs.realpath(directory);
    if (seen.has(directory)) throw new Error('Cyclic continuation ancestry');
    seen.add(directory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (path.relative(path.resolve(projectRoot), path.resolve(manifest.projectRoot)) !== '') throw new Error('Inherited business project changed');
    const currentIdentity = JSON.stringify([manifest.instanceId, manifest.datasetDigest, manifest.preparedHead]);
    identity ??= currentIdentity;
    if (identity !== currentIdentity) throw new Error('Inherited business task or prepared HEAD changed');
    const result = await fs.readFile(path.join(directory, 'result.json'), 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (result?.actualBusinessStart === true) {
      const scope = JSON.parse(await fs.readFile(path.join(directory, 'candidate-scope.json'), 'utf8'));
      if (!Array.isArray(scope.mutationPaths)) throw new Error('Missing captured business mutation scope');
      return { mutationPaths: validateBusinessMutationPaths(scope.mutationPaths, projectRoot),
        sourceRun: directory, skippedStartupRuns };
    }
    if (!manifest.resumedFrom) {
      if (result?.actualBusinessStart === false) return { mutationPaths: [], sourceRun: null, skippedStartupRuns: [...skippedStartupRuns, directory] };
      throw new Error('Cannot establish inherited business mutation authority');
    }
    skippedStartupRuns.push(directory); directory = manifest.resumedFrom;
  }
  throw new Error('Continuation ancestry limit exceeded');
}

// This benchmark exposes no shell or general execution to the business model.
// Its source mutators are native write/edit/apply_patch; fixed build/test tools and
// host bootstrap can also produce files, which must not become candidate edits.
export function businessMutationPaths(records, projectRoot) {
  const calls = new Map(), paths = new Set();
  for (const record of records) {
    const message = record.message ?? record;
    if (message.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'toolCall' && ['write', 'edit', 'apply_patch'].includes(block.name)) calls.set(block.id, block);
    }
    if (message.role !== 'toolResult' || message.isError === true) continue;
    const call = calls.get(message.toolCallId);
    if (!call || message.toolName !== call.name) continue;
    if (call.name === 'apply_patch') {
      // The native receipt lists actual changes, including both sides of a
      // move. Do not infer success from requested patch text or console prose.
      const summary = message.details?.summary;
        if (!summary || !['added', 'modified', 'deleted'].every(key => Array.isArray(summary[key])))
        throw new Error('Successful apply_patch has no structured mutation receipt');
      for (const key of ['added', 'modified', 'deleted']) for (const file of summary[key]) paths.add(mutationPath(file, projectRoot));
    } else {
      const file = call.arguments?.path ?? call.arguments?.file_path;
      paths.add(mutationPath(file, projectRoot));
    }
  }
  return [...paths].sort();
}
