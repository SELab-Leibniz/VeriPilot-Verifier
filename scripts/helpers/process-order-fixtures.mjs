// Known-answer RC process-evidence fixtures. The controlled business actor
// actually performs these local file operations; no model business run or
// benchmark score is claimed. Native reviews consume the original records.
import fs from 'node:fs/promises';

const code = 'export const accept = value => value + 1;\n' +
  '// ASCII context\n'.repeat(8) + '// 文件末尾仍有中文\n';
const requirement = 'During this task, after the business actor last writes app.mjs, that actor must read back the ENTIRE file and verify its UTF-8 text before declaring completion. This applies to the whole file, including Chinese text outside an ASCII-only excerpt. A private reviewer reading the current file, a read before the last write, or a partial file read does not substitute for the original business action. Judge from the available original invocation/result records; missing attributable whole-file read-back evidence is UNVERIFIED, not an assumed omission.';

export const processOrderCases = [
  { id: 'business-read-before-write', expected: 'UNVERIFIED', mode: 'before' },
  { id: 'business-partial-read-after-write', expected: 'UNVERIFIED', mode: 'partial' },
  { id: 'business-full-read-after-write', expected: 'PASS', mode: 'after' },
].map(({ mode, ...fixture }) => ({ ...fixture, metricId: 'M09', category: 'developmentStandards', target: 'PROCESS', code, requirement,
  async prepare({ file }) {
    await fs.writeFile(file, code.replace('value + 1', 'value + 0'), 'utf8');
    const entries = []; let sequence = 0;
    async function operation(name, input, execute) {
      const id = `controlled-${fixture.id}-${++sequence}`;
      entries.push({ type: 'assistant', uuid: `${id}-invocation`, timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
      const content = await execute();
      entries.push({ type: 'user', uuid: `${id}-result`, timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
    }
    const read = partial => operation('Read', { file_path: file, ...(partial ? { offset: 1, limit: 3 } : {}) }, async () => {
      const text = await fs.readFile(file, 'utf8');
      return partial ? text.split('\n').slice(0, 3).join('\n') : text;
    });
    if (mode === 'before') await read(false);
    await operation('Write', { file_path: file, content: code }, async () => { await fs.writeFile(file, code, 'utf8'); return 'Write completed'; });
    if (mode !== 'before') await read(mode === 'partial');
    return entries;
  },
}));
