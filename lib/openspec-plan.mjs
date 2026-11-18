import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const isOpenSpecChangeName = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const maxFileBytes = 1024 * 1024;
const maxPlanBytes = 8 * maxFileBytes;
const maxSpecEntries = 256;
const maxSpecDepth = 8;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseChecklist(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return null;
  const completion = [];
  const lines = text.split('\n').map(line => {
    // Match the OpenSpec Apply parser and preserve every byte except its checkbox marker.
    const match = /^([-*]\s*\[)([ xX])(\]\s*.+\s*)$/u.exec(line);
    if (!match) return line;
    const [, before, marker, after] = match;
    completion.push(marker !== ' ');
    return before + ' ' + after;
  });
  return { hash: sha256(lines.join('\n')), completion };
}

// Use the same lexical task boundary as Apply. Headings, prose and a word such
// as UNVERIFIED never turn a parsed checkbox into a nonblocking note.
export function openSpecReadinessSyntaxIssue(bytes) {
  return /^[ \t]+[-*][ \t]*\[[ xX]\]/mu.test(Buffer.from(bytes).toString('utf8'))
    ? 'UNSUPPORTED_TASK_SYNTAX' : null;
}

export function openSpecChecklistInventory(bytes, relativePath) {
  if (typeof relativePath !== 'string' || !/^openspec\/changes\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/tasks\.md$/u.test(relativePath)) return null;
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text).equals(Buffer.from(bytes)) || openSpecReadinessSyntaxIssue(bytes)) return null;
  const tasks = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = /^([-*]\s*\[)([ xX])(\]\s*.+\s*)$/u.exec(line);
    if (!match) continue;
    const taskText = match[1] + ' ' + match[3];
    if (tasks.length >= 128 || Buffer.byteLength(taskText) > 4096) return null;
    const location = { path: relativePath, line: index + 1, text: taskText, sha256: sha256(taskText) };
    tasks.push({ id: sha256(JSON.stringify(location)), ...location });
  }
  return tasks.length ? { sha256: sha256(JSON.stringify(tasks)), tasks } : null;
}

export function openSpecTaskTextSha256(bytes) {
  return parseChecklist(bytes)?.hash ?? null;
}

function planError(code, message) {
  return Object.assign(new Error(message), { code });
}

const unsafe = relative => planError('OPENSPEC_PLAN_UNSAFE', `Unsafe OpenSpec artifact: ${relative}`);
const changed = relative => planError('OPENSPEC_PLAN_UNAVAILABLE', `OpenSpec artifact changed during capture: ${relative}`);
const limit = () => planError('OPENSPEC_PLAN_LIMIT', 'OpenSpec artifact snapshot exceeds its bounds');

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs;
}

async function inspect(root, relative, { optional = false, directory = false } = {}) {
  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute).catch(error => {
    if (error.code === 'ENOENT' && optional) return null;
    throw error;
  });
  if (!stat) return null;
  if (!(directory ? stat.isDirectory() : stat.isFile())
    || path.relative(absolute, await fs.realpath(absolute)) !== '') throw unsafe(relative);
  return stat;
}

async function readFile(root, relative, expected) {
  if (expected.size > maxFileBytes) throw limit();
  const absolute = path.join(root, relative);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await fs.open(absolute, flags);
  try {
    const opened = await file.stat();
    const current = await inspect(root, relative);
    if (!opened.isFile() || !sameStat(expected, opened) || !sameStat(opened, current)) throw changed(relative);
    const bytes = Buffer.alloc(expected.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== expected.size || !sameStat(opened, await file.stat())
      || !sameStat(opened, await inspect(root, relative))) throw changed(relative);
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function capturePlan(projectRoot, changeName, includeContents, { includeChecklist = false } = {}) {
  if (!isOpenSpecChangeName(changeName)) {
    throw planError('OPENSPEC_PLAN_INVALID', 'An OpenSpec change slug is required');
  }
  const root = await fs.realpath(projectRoot);
  const prefix = `openspec/changes/${changeName}`;
  const directories = new Map();
  const addDirectory = async (relative, optional = false) => {
    const stat = await inspect(root, relative, { optional, directory: true });
    directories.set(relative, stat);
    return stat;
  };
  for (const relative of ['openspec', 'openspec/changes', prefix]) await addDirectory(relative);

  const documents = [], contents = [];
  const files = new Map();
  let checklist, checklistInventory, checklistInventoryIssue, totalBytes = 0, specEntries = 0;
  const addDocument = async (relative, optional = false) => {
    const stat = await inspect(root, relative, { optional });
    files.set(relative, stat);
    if (!stat) return null;
    totalBytes += stat.size;
    if (totalBytes > maxPlanBytes) throw limit();
    const bytes = await readFile(root, relative, stat);
    documents.push({ path: relative, sha256: sha256(bytes) });
    if (includeContents) {
      const text = bytes.toString('utf8');
      contents.push({ path: relative, text: Buffer.from(text).equals(bytes) ? text : null });
    }
    if (relative === `${prefix}/tasks.md`) {
      checklist = parseChecklist(bytes);
      if (includeChecklist) {
        checklistInventory = openSpecChecklistInventory(bytes, relative);
        checklistInventoryIssue = openSpecReadinessSyntaxIssue(bytes);
      }
    }
  };
  await addDocument(`${prefix}/proposal.md`);
  await addDocument(`${prefix}/tasks.md`);
  if (!checklist) throw planError('OPENSPEC_PLAN_INVALID', 'OpenSpec task checklist must be UTF-8');
  await addDocument(`${prefix}/design.md`, true);

  const walkSpecs = async (relative, depth) => {
    if (depth > maxSpecDepth) throw limit();
    const directory = await fs.opendir(path.join(root, relative));
    for await (const entry of directory) {
      if (++specEntries > maxSpecEntries) throw limit();
      if (/[\\\u0000-\u001f\u007f]/u.test(entry.name)) throw unsafe(relative);
      const child = `${relative}/${entry.name}`;
      if (entry.name === 'spec.md') await addDocument(child);
      else if (entry.isDirectory()) {
        await addDirectory(child);
        await walkSpecs(child, depth + 1);
      } else if (!entry.isFile()) throw unsafe(child);
    }
  };
  const specs = `${prefix}/specs`;
  if (await addDirectory(specs, true)) await walkSpecs(specs, 0);

  for (const [relative, previous] of [...directories, ...files]) {
    const current = await inspect(root, relative, { optional: true, directory: directories.has(relative) });
    if (previous && current ? !sameStat(previous, current) : previous !== current) throw changed(relative);
  }
  documents.sort((left, right) => left.path < right.path ? -1 : Number(left.path > right.path));
  const taskCompletion = checklist.completion;
  const plan = { changeName, revision: sha256(JSON.stringify({ changeName, documents })), documents,
    taskTextSha256: checklist.hash, taskCount: taskCompletion.length,
    completedTaskCount: taskCompletion.filter(Boolean).length, taskCompletion,
    ...(includeChecklist ? { checklistInventory,
      ...(checklistInventoryIssue ? { checklistInventoryIssue } : {}) } : {}) };
  return includeContents ? { plan, contents: contents.sort((a, b) => a.path.localeCompare(b.path)) } : plan;
}

export const readOpenSpecPlan = (projectRoot, changeName, options) => capturePlan(projectRoot, changeName, false, options);

// Contents are retained only by the host's authenticated approval state. The
// ordinary plan/preview API never includes original document bytes.
export const captureOpenSpecPlan = (projectRoot, changeName, options) => capturePlan(projectRoot, changeName, true, options);

export function compareOpenSpecPlans(approved, current) {
  const before = new Map(approved.documents.map(({ path: relative, sha256: digest }) => [relative, digest]));
  const after = new Map(current.documents.map(({ path: relative, sha256: digest }) => [relative, digest]));
  const checklist = `openspec/changes/${approved.changeName}/tasks.md`;
  const checklistPreserved = before.has(checklist) && after.has(checklist)
    && approved.taskTextSha256 === current.taskTextSha256
    && approved.taskCompletion.length === current.taskCompletion.length
    && !approved.taskCompletion.some((done, index) => done && !current.taskCompletion[index]);
  const paths = new Set([...before.keys(), ...after.keys()]);
  if (approved.changeName === current.changeName && !checklistPreserved) paths.add(checklist);
  const differences = [...paths].sort().filter(relative => relative === checklist && approved.changeName === current.changeName
    ? !checklistPreserved : before.get(relative) !== after.get(relative));
  return { status: differences.length ? 'CHANGED' : 'PRESERVED', differences };
}
