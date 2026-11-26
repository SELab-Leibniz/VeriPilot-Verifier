// Business execution receipts may carry their own build identity. A frozen
// transcript alone cannot connect such a receipt to today's delivery.
const revisionFields = ['revision', 'commit', 'commitSha', 'buildId'];
function identity(value) {
  for (const field of revisionFields) {
    const version = value?.[field];
    if ((typeof version === 'string' && version.trim()) || Number.isSafeInteger(version))
      return { field, version };
  }
  return null;
}
export function outputIdentity(block) {
  if (block.type !== 'tool_result' || block.is_error) return null;
  const content = typeof block.content === 'string' ? block.content :
    (Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join('\n') : '');
  if (!revisionFields.some(field => content.includes(JSON.stringify(field)))) return null;
  for (const line of content.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    try { const result = identity(JSON.parse(line)); if (result) return result; } catch {}
  }
  return null;
}
export function matchesCurrentIdentity({field, version}, quote) {
  // A citation can point at a single JSON property in a multiline manifest.
  try { return JSON.parse(quote)?.[field] === version; } catch {}
  for (const line of quote.split('\n')) {
    try { if (JSON.parse('{' + line.trim().replace(/,$/u,'') + '}')[field] === version) return true; } catch {}
  }
  return false;
}
