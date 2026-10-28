import path from 'node:path';

// This benchmark exposes no shell or general execution to the business model.
// Its only source mutators are native write/edit; fixed build/test tools and
// host bootstrap can also produce files, which must not become candidate edits.
export function businessMutationPaths(records, projectRoot) {
  const calls = new Map(), paths = new Set();
  for (const record of records) {
    const message = record.message ?? record;
    if (message.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'toolCall' && ['write', 'edit'].includes(block.name)) calls.set(block.id, block);
    }
    if (message.role !== 'toolResult' || message.isError === true) continue;
    const call = calls.get(message.toolCallId);
    if (!call || message.toolName !== call.name) continue;
    const file = call.arguments?.path ?? call.arguments?.file_path;
    if (typeof file !== 'string' || !file) throw new Error('Successful source mutation has no attributable path');
    const relative = path.relative(projectRoot, path.resolve(projectRoot, file));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Business mutation outside project');
    if (relative.split(path.sep).some(part => ['.git', '.runtime-correction', '.runtime-corrector'].includes(part))) throw new Error('Business mutation targets benchmark control state');
    paths.add(relative.replaceAll('\\', '/'));
  }
  return [...paths].sort();
}
