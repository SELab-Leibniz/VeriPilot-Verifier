import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './utils.mjs';

const invalid = message => Object.assign(new Error(message), { code: 'GROUND_TRUTH_EXPECTED_FILES_INVALID' });

export const EXPECTED_FILE_BINDING_VERSION = 'source-directory-v1';

export const EXPECTED_FILES_SCHEMA = {
  type: 'array', maxItems: 100, uniqueItems: true,
  description: 'Exact output file paths explicitly required to be delivered during THIS task. Preserve named paths, including absent files. Omit when none are explicit; never infer filenames from inputs, examples, code references, prohibited outputs, or future runtime outputs. No globs or placeholders.',
  items: { type: 'string', minLength: 1, maxLength: 4096 },
};

export function normalizeExpectedFiles(value, text) {
  if (!Array.isArray(value) || value.length > 100) throw invalid('expectedFiles must be an array of at most 100 exact output paths.');
  return [...new Set(value.map(file => {
    if (typeof file !== 'string' || !file.trim() || file.length > 4096
      || /[\0\r\n*?\[\]{}<>]/u.test(file) || /[\\/]$/u.test(file))
      throw invalid('expectedFiles requires exact file paths, without globs, placeholders or directory paths.');
    const named = file.trim().replaceAll('\\', '/');
    if (['.', '..'].includes(path.posix.basename(named)) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(named)
      || /^~(?:\/|$)/u.test(named) || /^[a-z]:(?!\/)/iu.test(named))
      throw invalid('expectedFiles requires resolved file paths, not URLs, home shorthand or drive-relative paths.');
    if (!String(text).replaceAll('\\', '/').includes(named))
      throw invalid(`Expected output path is not named in its original obligation: ${file}`);
    return named;
  }))];
}

export function resolveExpectedFilePath(requiredPath, sourceText) {
  if (requiredPath.includes('/')) return { status: 'RESOLVED', path: requiredPath, basis: 'EXPLICIT_PATH' };
  const source = String(sourceText).replaceAll('\\', '/');
  const quoted = [...source.matchAll(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'/gu)]
    .map(match => match[1] ?? match[2] ?? match[3]);
  const bare = source.match(/[^\s`"'<>\[\]{}()，。；,;]+\/[^\s`"'<>\[\]{}()，。；,;]*/gu) ?? [];
  const usable = value => value && !/[\0\r\n*?<>\[\]{}]/u.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) && !/^~(?:\/|$)/u.test(value)
    && (!value.includes(':') || /^[a-z]:\//iu.test(value));
  const candidates = new Set(), directories = new Set();
  for (const token of [...quoted, ...bare]) {
    if (!usable(token)) continue;
    if (token.endsWith('/')) directories.add(token);
    else if (token.includes('/') && path.posix.basename(token) === requiredPath) candidates.add(token);
  }
  for (const match of source.matchAll(/(?:\b(?:directory|folder)\b|目录)\s*(?:(?:is|为|是|[:=：])\s*)?[`"']([^`"'\r\n]+)[`"']/giu))
    if (usable(match[1])) directories.add(match[1]);
  for (const match of source.matchAll(/(?:\b(?:under|inside|within)\b|目录(?:为|是|[:：]))\s+([^\s`"'<>\[\]{}()，。；,;]+\/[^\s`"'<>\[\]{}()，。；,;]+)/giu))
    if (usable(match[1])) directories.add(match[1]);
  for (const directory of directories) candidates.add(directory.replace(/\/+$/u, '') + '/' + requiredPath);
  const paths = [...new Set([...candidates].map(value => {
    const normalized = path.posix.normalize(value);
    return value.startsWith('//') && !normalized.startsWith('//') ? '/' + normalized : normalized;
  }))];
  return paths.length === 1 ? { status: 'RESOLVED', path: paths[0], basis: 'ORIGINAL_DIRECTORY' }
    : { status: 'UNVERIFIED', candidates: paths.slice(0, 20), reason: paths.length ? 'Multiple original paths are possible.' : 'The original does not uniquely locate this filename.' };
}

// This observes a named output, never a search result. Only ENOENT/ENOTDIR
// establish absence. Permission, I/O and link-loop errors stay unavailable.
export async function observeExpectedFile(projectRoot, file) {
  const absolute = path.resolve(projectRoot, file);
  let observation;
  try {
    const stat = await fs.stat(absolute);
    observation = { path: absolute, status: stat.isFile() ? 'FILE' : 'NOT_FILE', resolvedPath: await fs.realpath(absolute) };
  } catch (error) {
    observation = { path: absolute, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'MISSING' : 'UNAVAILABLE', errorCode: error.code ?? 'IO_ERROR' };
  }
  return { ...observation, fingerprint: sha256(observation) };
}

export async function expectedFilesCurrent(observations = []) {
  if (!Array.isArray(observations)) return false;
  const checked = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') return false;
    if (checked.has(observation.path)) {
      if (checked.get(observation.path) !== observation.fingerprint) return false;
      continue;
    }
    if (!path.isAbsolute(observation.path ?? '')
      || (await observeExpectedFile(path.dirname(observation.path), observation.path)).fingerprint !== observation.fingerprint) return false;
    checked.set(observation.path, observation.fingerprint);
  }
  return true;
}

export function missingFileProof(object, citation) {
  const proof = citation?.readProof;
  return object?.hard === true && object.applicabilityKind === 'CURRENT_TASK'
    && ['M12', 'M16'].includes(object.metricId)
    && proof?.version === 1 && proof.observed === true && proof.basisComplete === true
    && proof.protocol === 'expected-file-v1' && proof.owner === 'EXPECTED_FILE'
    && proof.claimId === object.sourceId && proof.revisionId === object.sourceRevisionId
    && object.expectedFiles?.includes(proof.requiredPath)
    && ['MISSING', 'NOT_FILE'].includes(proof.status);
}
