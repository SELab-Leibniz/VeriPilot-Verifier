// Controlled original business operations for RC semantic verification.
// These fixtures run no benchmark business model and carry no hidden tests.
import fs from 'node:fs/promises';

const requirement = 'If the current app.mjs contains any Han characters anywhere in its ENTIRE original file, the business actor must read back the entire file after its last write before declaring completion. Han characters beyond an ASCII page still trigger this condition. Reviewer source reads or character facts establish current content only, not the business action. Missing attributable post-write read-back evidence is UNVERIFIED, not an assumed omission. If the entire current file is ASCII, the original condition is NOT_APPLICABLE; no read-back action is required.';

export const characterApplicabilityCases = [
  { id: 'conditional-character-han-missing-readback', han: true, readBack: false, expected: 'UNVERIFIED' },
  { id: 'conditional-character-ascii-no-readback', han: false, readBack: false, expected: 'NOT_APPLICABLE' },
  { id: 'conditional-character-han-full-readback', han: true, readBack: true, expected: 'PASS' },
].map(({ han, readBack, ...fixture }) => {
  const code = 'export const accept = value => value + 1;\n' + '// ASCII context\n'.repeat(420)
    + (han ? '// 设备\n' : '// ASCII tail\n');
  return { ...fixture, metricId: 'M09', category: 'developmentStandards', target: 'PROCESS',
    applicabilityKind: 'CONDITIONAL', applicability: 'When app.mjs contains Han characters anywhere in its entire current file.',
    code, requirement,
    async prepare({ file }) {
      const entries = []; let sequence = 0;
      async function operation(name, input, execute) {
        const id = `${fixture.id}-${++sequence}`;
        entries.push({ type: 'assistant', uuid: `${id}-invocation`, timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
        const content = await execute();
        entries.push({ type: 'user', uuid: `${id}-result`, timestamp: new Date().toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
      }
      await operation('Write', { file_path: file, content: code }, async () => {
        await fs.writeFile(file, code, 'utf8'); return 'Write completed';
      });
      if (readBack) await operation('Read', { file_path: file }, () => fs.readFile(file, 'utf8'));
      return entries;
    },
  };
});
