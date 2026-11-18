import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activeNativeTranscriptRecords, nativeTranscriptObservation } from '../../lib/openclaw/native-transcript.mjs';
import { transcriptUserMessages } from '../../lib/runtime-v2/original-requirements.mjs';
import { excerpt } from '../../lib/review-task/evidence-utils.mjs';
import { sha256 } from '../../lib/runtime-v2/utils.mjs';

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/u.test(value);
const fields = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const validText = value => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')
  && Buffer.from(value).toString('utf8') === value;
const validRequirement = value => fields(value, ['start', 'end', 'requirement'])
  && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 1
  && value.end >= value.start && value.end - value.start < 200
  && validText(value.requirement) && value.requirement === value.requirement.trim() && value.requirement.length <= 600;

function validRequirements(requirements) {
  return Array.isArray(requirements) && requirements.length > 0 && requirements.length <= 48
    && requirements.every(validRequirement) && new Set(requirements.map(({ start, end, requirement }) =>
      JSON.stringify([start, end, requirement]))).size === requirements.length;
}

export async function loadOpenSpecRequirementInventory(file, expectedSha256) {
  assert(isHash(expectedSha256), 'The OpenSpec requirement inventory needs a pinned SHA-256.');
  const bytes = await readFile(file);
  assert(bytes.length <= 2 * 1024 * 1024 && sha256(bytes) === expectedSha256,
    'The OpenSpec requirement inventory bytes do not match their pin or exceed the read limit.');
  const text = bytes.toString('utf8');
  assert(Buffer.from(text).equals(bytes), 'The OpenSpec requirement inventory is not valid UTF-8.');
  let inventory;
  try { inventory = JSON.parse(text); }
  catch { assert.fail('The OpenSpec requirement inventory is not valid JSON.'); }
  assert(fields(inventory, ['kind', 'cases']) && inventory.kind === 'openspec-requirement-inventory-v1'
    && Array.isArray(inventory.cases) && inventory.cases.length > 0 && inventory.cases.length <= 1024,
  'Invalid OpenSpec requirement inventory.');
  const cases = new Map();
  for (const entry of inventory.cases) {
    assert(fields(entry, ['id', 'publicInputSha256', 'problemStatementSha256', 'requirements'])
      && isId(entry.id) && !cases.has(entry.id) && isHash(entry.publicInputSha256) && isHash(entry.problemStatementSha256)
      && validRequirements(entry.requirements), 'Invalid or duplicate OpenSpec requirement inventory case.');
    const { id, publicInputSha256, problemStatementSha256, requirements } = entry;
    cases.set(id, { publicInputSha256, problemStatementSha256, requirements });
  }
  return { sha256: expectedSha256, cases };
}

export function validateOpenSpecRequirementInventoryCase(inventoryCase, { publicInputSha256, problemStatement }) {
  assert(inventoryCase && isHash(publicInputSha256) && inventoryCase.publicInputSha256 === publicInputSha256
    && validText(problemStatement) && inventoryCase.problemStatementSha256 === sha256(problemStatement)
    && validRequirements(inventoryCase.requirements), 'OpenSpec inventory does not match the selected public input.');
  const bytes = Buffer.from(problemStatement), lineCount = problemStatement.split('\n').length;
  assert(inventoryCase.requirements.every(({ start, end }) => end <= lineCount && excerpt(bytes, start, end).text.trim()),
    'An OpenSpec requirement span does not name nonempty public source lines.');
}

export function prepareOpenSpecRequirementInventory(inventoryCase, { publicInputSha256, problemStatement, proposalMessage }) {
  validateOpenSpecRequirementInventoryCase(inventoryCase, { publicInputSha256, problemStatement });
  assert(validText(proposalMessage), 'The dispatched Proposal must have exact UTF-8 text.');
  const problemIndex = proposalMessage.indexOf(problemStatement);
  assert(problemIndex >= 0 && proposalMessage.indexOf(problemStatement, problemIndex + 1) === -1,
    'The public problem statement is missing or ambiguous in the native Proposal.');
  const prefix = proposalMessage.slice(0, problemIndex).split('\n');
  const suffix = proposalMessage.slice(problemIndex + problemStatement.length).split('\n', 1)[0];
  const precedingLines = prefix.length - 1;
  const problemLineCount = problemStatement.split('\n').length;
  const problemBytes = Buffer.from(problemStatement), proposalBytes = Buffer.from(proposalMessage);
  const requirements = inventoryCase.requirements.map(({ start, end, requirement }) => {
    const liveStart = start + precedingLines, liveEnd = end + precedingLines;
    const publicExcerpt = excerpt(problemBytes, start, end), liveExcerpt = excerpt(proposalBytes, liveStart, liveEnd);
    // OpenSpec's runner may attach workflow or hint text to a boundary line.
    // The approved anchor still names the whole retained line; only this
    // exact wrapper outside the one pinned public statement may be included.
    const wrapped = (start === 1 ? prefix.at(-1) : '') + publicExcerpt.text + (end === problemLineCount ? suffix : '');
    assert(publicExcerpt.text.trim() && wrapped === liveExcerpt.text,
      'An OpenSpec requirement span does not match exact public lines in the native Proposal.');
    return { start: liveStart, end: liveEnd, requirement };
  });
  return { sourceSha256: sha256(proposalBytes), requirements };
}

export function bindOpenSpecRequirementInventory(inventoryCase, { publicInputSha256, problemStatement, proposalMessage,
  proposalRunId, sessionId, records }) {
  assert(validText(proposalRunId) && validText(sessionId) && Array.isArray(records)
    && records[0]?.type === 'session' && records[0].id === sessionId && records.filter(row => row?.type === 'session').length === 1,
  'The native Proposal transcript has the wrong session identity.');
  const userKey = `${proposalRunId}:user`;
  const matches = records.filter(record => record?.message?.idempotencyKey === userKey);
  const active = activeNativeTranscriptRecords(records);
  const [match] = matches;
  assert(matches.length === 1 && match.type === 'message' && match.message.role === 'user' && validText(match.id)
    && Object.hasOwn(match, 'parentId') && Object.hasOwn(active.at(-1) ?? {}, 'parentId') && active.includes(match),
  'The unique Proposal dispatch is not on the active native transcript branch.');
  const original = transcriptUserMessages(nativeTranscriptObservation(active)).at(-1);
  const ref = `transcript:${match.id}`;
  assert(original?.ref === ref && original.text === proposalMessage,
    'The current native original user message does not match the dispatched Proposal.');
  const { sourceSha256, requirements } = prepareOpenSpecRequirementInventory(inventoryCase, { publicInputSha256, problemStatement, proposalMessage });
  return requirements.map(({ start, end, requirement }) => ({ source: { ref, sha256: sourceSha256, start, end }, requirement }));
}
