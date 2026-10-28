import { readJson } from '../runtime-v2/utils.mjs';
import { durableTaskJson } from './task-evidence.mjs';

// Small task-local working memory. Notes can guide recovery, never grant reads,
// source authority, acceptance, or permission to mutate the formal baseline.
export async function createBaselineNotes({ file, identity, active }) {
  let saved = await readJson(file);
  if (!saved || saved.taskId !== identity.taskId) saved = { taskId: identity.taskId, notes: [] };
  const view = note => ({ ...note, stale: note.requestId !== identity.requestId });
  const tool = {
    name: 'baseline_notes', label: 'Baseline working notes', executionMode: 'sequential',
    description: 'Small task-local navigation notes, retained across refreshes and compact. list/search recovers pointers; put records outcome groups, unresolved work and original source refs. stale notes need revalidation. Notes never supply evidence, reading coverage or permission.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'search', 'put', 'remove'] }, key: { type: 'string', maxLength: 80 },
      text: { type: 'string', maxLength: 1200 }, query: { type: 'string', maxLength: 200 },
      sourceRefs: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', maxLength: 1000 } },
      offset: { type: 'integer', minimum: 0 },
    } },
    async execute(_id, args) {
      active();
      if (['put', 'remove'].includes(args.action)) {
        if (typeof args.key !== 'string' || !/^[\p{L}\p{N}_.:-]{1,80}$/u.test(args.key)) throw new Error('A short stable note key is required');
        const next = saved.notes.filter(note => note.key !== args.key);
        if (args.action === 'put') {
          if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 1200
            || Buffer.byteLength(args.text) > 2400) throw new Error('Note text exceeds the small note boundary');
          const refs = args.sourceRefs ?? [];
          if (!Array.isArray(refs) || refs.length > 12 || refs.some(ref => !identity.sources.some(source => source.ref === ref)))
            throw new Error('Note references must use the current original source catalog');
          next.push({ key: args.key, text: args.text, sourceRefs: refs, requestId: identity.requestId });
        }
        if (next.length > 64 || Buffer.byteLength(JSON.stringify(next)) > 65536) throw new Error('Notes full: consolidate existing notes');
        await durableTaskJson(file, { taskId: identity.taskId, notes: next }, active);
        saved = { taskId: identity.taskId, notes: next };
        return { content: [{ type: 'text', text: JSON.stringify({ saved: true, key: args.key, navigationOnly: true }) }] };
      }
      if (!['list', 'search'].includes(args.action)) throw new Error('Unknown note action');
      if (args.action === 'search' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200)) throw new Error('A short literal note query is required');
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid note cursor');
      const matches = saved.notes.filter(note => args.action === 'list' || `${note.key}\n${note.text}`.includes(args.query));
      const notes = []; let bytes = 0;
      for (const note of matches.slice(offset, offset + 5)) {
        const item = view(note), size = Buffer.byteLength(JSON.stringify(item));
        if (notes.length && bytes + size > 6000) break;
        notes.push(item); bytes += size;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ notes, total: matches.length,
        nextOffset: offset + notes.length < matches.length ? offset + notes.length : null, navigationOnly: true }) }] };
    },
  };
  return { tool, pointer: () => ({ tool: 'baseline_notes', notes: saved.notes.length, stale: saved.notes.filter(note => view(note).stale).length }) };
}
