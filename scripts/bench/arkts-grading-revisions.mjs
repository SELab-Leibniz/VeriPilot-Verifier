import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });

// Repaired capture is the same real business run, not a new model attempt.
// Preserve every grading revision and select by chronology, never by score.
export async function arktsGradingRevisions(directory, identity, native) {
  const revisions = [];
  async function gradeAt(root, candidateFile, metadata) {
    const graded = await read(path.join(root, 'results.json'));
    if (graded) {
      if (!native || graded.instanceId !== identity.id || graded.environment?.datasetDigest !== identity.datasetDigest
        || !graded.candidateSha256 || sha(await fs.readFile(candidateFile)) !== graded.candidateSha256)
        throw new Error(`Mismatched candidate grading evidence: ${root}`);
    }
    revisions.push({ ...metadata, directory: root, grade: graded?.results?.find(row => row.phase === 'candidate') ?? null });
  }
  await gradeAt(`${directory}-grade`, path.join(directory, 'candidate.patch'), { source: 'original-capture' });
  const exportsRoot = path.join(directory, 'candidate-exports');
  const exports = await fs.readdir(exportsRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of exports.filter(row => row.isDirectory() && /^export-\d+$/u.test(row.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const root = path.join(exportsRoot, entry.name), proof = await read(path.join(root, 'proof.json'));
    if (!proof || proof.kind !== 'reconstructed-business-candidate' || !native
      || await fs.realpath(proof.sourceRun) !== await fs.realpath(directory)
      || proof.instanceId !== identity.id || proof.datasetDigest !== identity.datasetDigest
      || proof.sessionId !== native.sessionId || proof.preparedHead !== native.preparedHead)
      throw new Error(`Reexport original identity changed: ${root}`);
    const sources = ['manifest.json', 'result.json', 'workspace.patch', 'candidate.patch', 'inherited-business-scope.json', `native-host/${native.sessionId}.jsonl`];
    if (!proof.sourceSha256 || Object.keys(proof.sourceSha256).length !== sources.length)
      throw new Error(`Reexport source hashes missing: ${root}`);
    for (const file of sources) if (sha(await fs.readFile(path.join(directory, file))) !== proof.sourceSha256[file])
      throw new Error(`Reexport frozen source changed: ${file}`);
    const candidate = path.join(root, 'candidate.patch');
    if (sha(await fs.readFile(candidate)) !== proof.candidateSha256) throw new Error(`Reexport candidate changed: ${root}`);
    await gradeAt(path.join(root, 'grade'), candidate, { source: 'reconstructed-capture', proof: path.join(root, 'proof.json'),
      candidateSha256: proof.candidateSha256, mutationPaths: proof.mutationPaths });
  }
  return revisions;
}
