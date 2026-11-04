import fs from 'node:fs/promises';
import path from 'node:path';
import { globToRegExp } from '../artifact-pipeline.mjs';
import { compilePathTemplate } from '../path-template.mjs';
import { hasLinkedPath, isPathInside } from '../path-utils.mjs';

const ignored = new Set(['.git', 'node_modules', '.runtime-correction', '.runtime-corrector']);

// Enumerate only the static roots of declared patterns. The result is complete
// for this snapshot only; a new command must enumerate again to see creations.
export async function inventoryDocumentPatterns(root, declarations, { active, add, unverified }) {
  const rules = [];
  for (const { value, template } of declarations) {
    try {
      const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
      if (path.isAbsolute(value) || normalized.split('/').includes('..')) throw new Error('outside scope');
      const regexp = template ? compilePathTemplate(normalized).regexp : globToRegExp(normalized);
      const magic = normalized.search(/[*?{]/u), prefix = magic < 0 ? normalized : normalized.slice(0, magic);
      const directory = prefix.slice(0, Math.max(0, prefix.lastIndexOf('/')));
      const base = path.resolve(root, directory);
      if (!isPathInside(root, base)) throw new Error('outside scope');
      if (path.relative(root, base).split(path.sep).some(part => ignored.has(part.toLowerCase()))) throw new Error('excluded scope');
      rules.push({ base, matches: relative => regexp.test(relative),
        maxDepth: normalized.includes('**') ? Infinity : normalized.split('/').length });
    } catch { unverified.push('DOCUMENT_DECLARATION_UNRESOLVED'); }
  }
  const roots = [...new Set(rules.map(rule => rule.base))].filter(candidate =>
    !rules.some(rule => rule.base !== candidate && isPathInside(rule.base, candidate)));
  let visited = 0;
  const descend = directory => {
    const depth = path.relative(root, directory).split(path.sep).filter(Boolean).length;
    return rules.some(rule => (isPathInside(rule.base, directory) || isPathInside(directory, rule.base)) && depth < rule.maxDepth);
  };
  async function walk(directory) {
    active();
    let handle, before;
    try {
      if (await hasLinkedPath(directory)) { unverified.push('DOCUMENT_LINKED_SOURCE'); return; }
      before = await fs.lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) { unverified.push('DOCUMENT_LINKED_SOURCE'); return; }
      handle = await fs.opendir(directory);
      for await (const entry of handle) {
        active();
        if (++visited > 4096) throw Object.assign(new Error('Document inventory limit'), { code: 'DOCUMENT_INVENTORY_LIMIT' });
        if (ignored.has(entry.name.toLowerCase())) continue;
        const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll('\\', '/');
        const matched = rules.some(rule => rule.matches(relative));
        if (entry.isSymbolicLink()) {
          if (matched || descend(file)) unverified.push('DOCUMENT_LINKED_SOURCE');
        } else if (entry.isDirectory()) {
          if (descend(file)) await walk(file);
        } else if (entry.isFile() && matched) add(file);
      }
      handle = null; active();
      const after = await fs.lstat(directory, { bigint: true });
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        unverified.push('DOCUMENT_INVENTORY_UNSTABLE');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      if (before) unverified.push('DOCUMENT_INVENTORY_UNSTABLE');
    } finally { if (handle) await handle.close().catch(() => {}); }
  }
  try { for (const directory of roots) await walk(directory); }
  catch (error) {
    try { active(); } catch (interrupted) { if (interrupted.code !== 'DOCUMENT_SNAPSHOT_TIMEOUT') throw interrupted; }
    unverified.push(error.code ?? 'DOCUMENT_INVENTORY_FAILED');
  }
  return file => rules.some(rule => rule.matches(path.relative(root, file).replaceAll('\\', '/')));
}
