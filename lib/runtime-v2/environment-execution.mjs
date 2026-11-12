import { sha256 } from './utils.mjs';

// These pinned native implementations read/write files and cannot launch a
// command. Custom tools, fixed build tools, delegation and unknown revisions
// remain execution-capable/unknown; their names alone never grant an exception.
const nonExecutingSchemas = new Map([
  ['read', '134f19bcabe3e29d63c5cebb38f1d2556759fd08adad6bc90a4b4d3cd1fb8441'],
  ['edit', '457e8bb9f800b21be76c4fd8c0e3078bf07ee9bf93ac82f39944c171bd8f6d84'],
  ['write', 'e98a2484f667cf7c22d76ca103bf2022bf9113dc63fe38b899e71c328cb1e833'],
  ['apply_patch', '05521268363ff4f191472c90d69ef08a503ba9acf1d2febc50b3ee68db32ab65'],
]);

export function proveCommandUnavailable({ object, row, command, originalText, policy }) {
  if (!policy || policy.source !== 'HOST_EFFECTIVE_TOOL_CATALOG' || policy.hostVersion !== '2026.7.1-2'
    || policy.current !== true || !policy.sessionId || !policy.policyDigest || !policy.catalogDigest
    || !Array.isArray(policy.tools) || !policy.tools.length
    || policy.tools.some(tool => !nonExecutingSchemas.has(tool.name) || nonExecutingSchemas.get(tool.name) !== tool.schemaHash)
    || object?.verificationTarget !== 'PROCESS' || !object.originalSource
    || row?.judgement !== 'UNVERIFIED' || row.citationFailure
    || typeof command !== 'string' || !command.trim() || command.includes('\n')
    || !originalText?.includes(command)) return null;
  return { kind: 'ENVIRONMENT_UNEXECUTABLE', objectId: object.objectId, command,
    originalSource: object.originalSource, policyDigest: policy.policyDigest,
    catalogDigest: policy.catalogDigest, sessionId: policy.sessionId,
    proofDigest: sha256([object.objectId, object.originalSource, command, policy.catalogDigest, policy.policyDigest]),
    reason: 'The current host catalog contains only verified file operations; no tool can launch the required command.' };
}

export const ENVIRONMENT_COMMANDS_SCHEMA = { type: 'array', maxItems: 100, items: {
  type: 'object', additionalProperties: false, required: ['objectId', 'command'], properties: {
    objectId: { type: 'string' }, command: { type: 'string', minLength: 1, maxLength: 4000 },
  },
} };
