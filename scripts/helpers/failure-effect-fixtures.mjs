// Small source-review counterexamples, independent of benchmark instances and
// hidden tests. The callback never mutates its argument; values are strings.
const header = "let records = ['initial'];\nexport const read = () => records.slice();\n";
const persistenceRequirement = 'Implement update(value, persist) and read() in app.mjs. Values are strings and persist does not mutate its argument. When persist returns false or throws, update must return false and read() must equal the cache contents immediately before that update. A successful persist returns true and retains the appended value.';

export const failureEffectCases = [
  { id: 'failure-after-memory-write', expected: 'DEVIATION', metricId: 'M16',
    code: header + 'export async function update(value, persist) {\n  records.push(value);\n  try { return await persist(records); } catch { return false; }\n}\n',
    requirement: persistenceRequirement },
  { id: 'failure-compensated', expected: 'PASS', metricId: 'M16',
    code: header + 'export async function update(value, persist) {\n  const before = records.slice();\n  records.push(value);\n  try {\n    if (await persist(records)) return true;\n  } catch {}\n  records = before;\n  return false;\n}\n',
    requirement: persistenceRequirement },
  { id: 'failure-aliased-compensation', expected: 'DEVIATION', metricId: 'M16',
    code: header + 'export async function update(value, persist) {\n  const before = records;\n  records.push(value);\n  try {\n    if (await persist(records)) return true;\n  } catch {}\n  records = before;\n  return false;\n}\n',
    requirement: persistenceRequirement },
  { id: 'failure-condition-scope', expected: 'PASS', metricId: 'M16',
    code: header + 'export async function update(value, dispatch, persist) {\n  if (!await dispatch(value)) return false;\n  records.push(value);\n  try { return await persist(records); } catch { return false; }\n}\n',
    requirement: 'Implement update(value, dispatch, persist) and read() in app.mjs. Values are strings and callbacks do not mutate their arguments. If dispatch returns false, update must return false, leave the cache unchanged and never call persist. When dispatch succeeds, append the value and return the persistence result, or false on a persistence exception. No persistence-failure cache rollback is required.' },
];
