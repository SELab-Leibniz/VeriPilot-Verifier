import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { businessMutationPaths, validateBusinessMutationPaths } from './business-mutations.mjs';
const read = file => fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });

function completeRecords(text) {
  const lines = text.split(/\r?\n/u), records = [];
  let partialTail = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); }
    catch (error) {
      // An active append may be incomplete. Corruption inside the persisted
      // prefix is a real diagnostic failure and must not be silently skipped.
      if (i === lines.length - 1 && !text.endsWith('\n')) { partialTail = true; break; }
      throw error;
    }
  }
  return { records, partialTail };
}

export async function inspectArktsProgress(directory, { gitExecutable = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git' } = {}) {
  directory = await fs.realpath(directory);
  const manifest = await read(path.join(directory, 'manifest.json'));
  const progress = await read(path.join(directory, 'progress.json'));
  if (!manifest || !progress) return { directory, preparing: true, manifestAvailable: Boolean(manifest), progress };
  if (manifest.ownerPid !== progress.ownerPid) throw new Error('Progress owner identity changed');
  let ownerAlive = null;
  if (Number.isSafeInteger(progress.ownerPid) && progress.ownerPid > 0) {
    try { process.kill(progress.ownerPid, 0); ownerAlive = true; }
    catch (error) { if (error.code === 'ESRCH') ownerAlive = false; else throw error; }
  }
  const sessionId = progress.sessionId;
  if (!sessionId) return { directory, progress, ownerAlive, sourceScopeAvailable: false };
  const transcript = await fs.readFile(path.join(directory, 'native-host', `${sessionId}.jsonl`), 'utf8');
  const { records, partialTail } = completeRecords(transcript);
  const inherited = await read(path.join(directory, 'inherited-business-scope.json'));
  const captured = await read(path.join(directory, 'candidate-scope.json'));
  const resumed = await read(path.join(directory, 'resume-evidence.json'));
  const offset = captured?.restoredRecordCount ?? resumed?.restoredRecordCount ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length) throw new Error('Invalid restored transcript boundary');
  const sourceScopeAvailable = Array.isArray(inherited?.mutationPaths)
    && (!manifest.resumedFrom || captured?.restoredRecordCount !== undefined || resumed?.restoredRecordCount !== undefined);
  const mutationPaths = sourceScopeAvailable ? [...new Set([
    ...validateBusinessMutationPaths(inherited.mutationPaths, manifest.projectRoot),
    ...businessMutationPaths(records.slice(offset), manifest.projectRoot)
  ])].sort() : null;
  const git = args => execFileSync(gitExecutable, ['--no-optional-locks', '--literal-pathspecs', '-C', manifest.projectRoot, ...args], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  const untrackedMutationPaths = mutationPaths?.length
    ? git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...mutationPaths]).split('\0').filter(Boolean) : [];
  const trackedDiffStat = mutationPaths?.length ? git(['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD', '--', ...mutationPaths]).trim() : '';
  const assistant = records.filter(row => row.message?.role === 'assistant').at(-1);
  const timingText = await fs.readFile(path.join(directory, 'native-host/provider-fetch-timing.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const timing = completeRecords(timingText);
  return { directory, progress, ownerAlive,
    ownerEvidence: 'PID presence only; verify the command or original terminal separately. A stale progress file is not a terminal.',
    projectRoot: manifest.projectRoot, sourceScopeAvailable, transcriptPartialTail: partialTail,
    mutationPaths, untrackedMutationPaths, trackedDiffStat,
    sourceScopeQualification: 'Successful native mutation receipts and genuine inherited scope only. New untracked source files are listed separately; bootstrap/control files are excluded. This observer never stages files or exports a candidate.',
    lastAssistant: assistant ? { time: assistant.timestamp, stopReason: assistant.message.stopReason,
      error: assistant.message.errorMessage,
      text: assistant.message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 900),
      calls: assistant.message.content?.filter(block => block.type === 'toolCall').map(block => ({ name: block.name, path: block.arguments?.path, action: block.arguments?.action })) } : null,
    providerObservation: timing.records.at(-1) ?? null, providerPartialTail: timing.partialTail,
    result: await read(path.join(directory, 'result.json')) ? { captured: true } : null };
}
