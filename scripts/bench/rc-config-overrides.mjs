import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseSimpleYaml } from '../../lib/simple-yaml.mjs';
import { digest } from './arkts-dataset.mjs';
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Objects merge by key; arrays, scalars and null replace the base value.
export function deepMerge(base, override) {
  if (!plain(base) || !plain(override)) return structuredClone(override);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) merged[key] = plain(value) && plain(base[key]) ? deepMerge(base[key], value) : structuredClone(value);
  return merged;
}
export function substitutePlaceholders(value, variables) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z]+)\}/gu, (_match, name) => {
    if (typeof variables[name] !== 'string') throw new Error(`Unknown or unset override placeholder \${${name}}`);
    return variables[name];
  });
  if (Array.isArray(value)) return value.map(item => substitutePlaceholders(item, variables));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePlaceholders(item, variables)]));
  return value;
}
// Emits only the subset lib/simple-yaml.mjs reads back: block mappings and
// sequences, JSON strings, plain numbers, an object item led by a scalar key.
export function emitSimpleYaml(document) {
  const lines = [], pad = indent => ' '.repeat(indent);
  const key = name => { if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) throw new Error(`Unsupported YAML key: ${name}`); return name; };
  const inline = value => !plain(value) && !(Array.isArray(value) && value.length);
  const scalar = value => {
    if (Array.isArray(value)) return '[]';
    if (value === null || typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && /^-?\d+(?:\.\d+)?$/u.test(String(value))) return String(value);
    throw new Error(`Unsupported YAML value: ${String(value)}`);
  };
  const entry = (name, value, indent, prefix = '') => {
    if (inline(value)) return void lines.push(`${pad(indent)}${prefix}${key(name)}: ${scalar(value)}`);
    lines.push(`${pad(indent)}${prefix}${key(name)}:`); block(value, indent + 2);
  };
  const block = (value, indent) => {
    if (!Array.isArray(value)) {
      if (!Object.keys(value).length) throw new Error('Empty YAML mappings are not representable');
      for (const [name, item] of Object.entries(value)) entry(name, item, indent);
      return;
    }
    for (const item of value) {
      if (Array.isArray(item)) throw new Error('Nested YAML sequences are not representable');
      if (!plain(item)) { lines.push(`${pad(indent)}- ${scalar(item)}`); continue; }
      const entries = Object.entries(item), lead = entries.findIndex(([, field]) => inline(field));
      if (lead < 0) throw new Error('A YAML sequence object needs a scalar first field');
      entry(...entries[lead], indent, '- ');
      for (const [name, field] of entries.filter((_, index) => index !== lead)) entry(name, field, indent + 2);
    }
  };
  if (!plain(document)) throw new Error('A YAML document must be a mapping');
  block(document, 0);
  const text = `${lines.join('\n')}\n`;
  assert.deepStrictEqual(parseSimpleYaml(text, { source: 'rc-config-overrides' }), document);
  return text;
}
// stopCorrection.regressionCheck = {enabled, command: argv, cwd, timeoutMs, maxOutputBytes};
// only an enabled check needs a command. effective is null while the loaded product drops the field.
export function regressionCheckPolicy(configured, effective) {
  if (configured === undefined || configured === null) return effective ? { configured: null, effective, honoredByProduct: true } : null;
  const { enabled, command, cwd, timeoutMs, maxOutputBytes, ...extra } = configured;
  const positive = value => value === undefined || Number.isSafeInteger(value) && value >= 1;
  if (typeof enabled !== 'boolean' || (enabled || command !== undefined) && (!Array.isArray(command) || !command.length
    || !command.every(value => typeof value === 'string' && value)) || cwd !== undefined && (typeof cwd !== 'string' || !cwd)
    || !positive(timeoutMs) || !positive(maxOutputBytes) || Object.keys(extra).length)
    throw new Error('stopCorrection.regressionCheck must be {enabled:boolean, command:[argv...] when enabled, cwd?:string, timeoutMs?:positive integer, maxOutputBytes?:positive integer}');
  return { configured, effective: effective ?? null, honoredByProduct: Boolean(effective) };
}
export async function loadRcConfigOverrides(file) {
  if (!file) return null;
  const bytes = await fs.readFile(file), value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
  if (!plain(value) || !Object.keys(value).length) throw new Error('--rc-config-overrides must contain a non-empty JSON object');
  return { file, sha256: digest(bytes), value };
}
// Returns the YAML that the business workspace receives. Without overrides
// the original text, comments included, is kept byte for byte.
export function applyRcConfigOverrides(text, overrides, variables = {}) {
  if (!overrides) return { text, applied: null };
  const value = substitutePlaceholders(overrides.value, variables);
  const merged = deepMerge(parseSimpleYaml(text, { source: 'base config' }), value);
  return { text: emitSimpleYaml(merged), applied: { file: overrides.file, sha256: overrides.sha256, value } };
}
