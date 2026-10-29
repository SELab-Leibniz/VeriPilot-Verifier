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

const refreshHeader = "let state = { busy: false, view: 'stale' };\nexport const read = () => ({ ...state });\n";
const refreshAfterReturn = refreshHeader + 'export async function change(next, apply, refresh) {\n  state.busy = true;\n  try {\n    const result = await apply(next);\n    state.view = await refresh();\n    return result;\n  } finally { state.busy = false; }\n}\n';
const refreshContract = 'Implement change(next, apply, refresh) and read() in app.mjs. The callbacks do not mutate state; refresh resolves to a string and never throws. apply may resolve to {ok:true}, resolve to {ok:false}, or throw. After each of those outcomes, call refresh exactly once and store its confirmed value before change settles. Return the apply result or propagate its original exception after refreshing. busy must remain true while apply and refresh run, and must be false after change settles.';

export const exceptionalFlowCases = [
  { id: 'required-refresh-skipped-on-throw', expected: 'DEVIATION', metricId: 'M16',
    code: refreshAfterReturn, requirement: refreshContract },
  { id: 'required-refresh-in-finally', expected: 'PASS', metricId: 'M16',
    code: refreshHeader + 'export async function change(next, apply, refresh) {\n  state.busy = true;\n  try { return await apply(next); }\n  finally {\n    try { state.view = await refresh(); }\n    finally { state.busy = false; }\n  }\n}\n', requirement: refreshContract },
  { id: 'refresh-return-only-scope', expected: 'PASS', metricId: 'M16', code: refreshAfterReturn,
    requirement: 'Implement change(next, apply, refresh) and read() in app.mjs. The callbacks do not mutate state; refresh resolves to a string and never throws. After apply resolves to {ok:true} or {ok:false}, call refresh exactly once, store its confirmed value and return the apply result. If apply throws, simply propagate that exception; no refresh is required in this case. busy must remain true while the callbacks run, and must be false after change settles.' },
];
