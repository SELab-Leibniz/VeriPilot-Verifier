// Parse actual runtime events, not the known-noisy SDK summary names. Missing,
// ambiguous, ignored and unfinished cases stay distinct from genuine failures.
export function parseHypium(text, module = 'entry') {
  const statuses = new Map(), errors = [], recovered = [], conflicts = [], confirmedClasses = new Set();
  let current = null, klass = null, outcomePending = null, terminal = {};
  const commit = (id, status) => {
    if (statuses.has(id)) { statuses.set(id, 'AMBIGUOUS'); errors.push({ code: 'DUPLICATE_CASE', id }); }
    else statuses.set(id, { pass: 'PASS', fail: 'FAIL', error: 'ERROR', ignore: 'IGNORED' }[status]);
  };
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const start = /\[Hypium\]start running case '(.*)'\s*$/u.exec(line);
    if (start) {
      if (current && !outcomePending) errors.push({ code: 'UNFINISHED_CASE', name: current, class: klass });
      if (outcomePending && !outcomePending.committed) errors.push({ code: 'UNBOUND_OUTCOME', name: outcomePending.name });
      outcomePending = null;
      current = start[1]; klass = null;
    }
    const name = /OHOS_REPORT_STATUS: class=([^\r\n]+)/u.exec(line);
    if (name && current && !klass) klass = name[1].trim();
    if (name && outcomePending) terminal.class = name[1].trim();
    const testName = /OHOS_REPORT_STATUS: test=([^\r\n]+)/u.exec(line);
    if (testName && outcomePending) terminal.name = testName[1].trim();
    const code = /OHOS_REPORT_STATUS_CODE: (-?\d+)\s*$/u.exec(line);
    if (code && outcomePending && Number(code[1]) !== 1) {
      const event = outcomePending;
      const agrees = event.status === 'pass' ? code[1] === '0' : event.status === 'fail' ? code[1] === '-2' : event.status === 'error' ? code[1] === '-1' : true;
      if (!event.committed && (!terminal.class || terminal.name !== event.name || !agrees)) errors.push({ code: 'UNBOUND_OUTCOME', name: event.name });
      else if (!event.committed) {
        const id = `${module}::${terminal.class}::${event.name}`;
        commit(id, event.status);
        recovered.push({ id, source: 'matching Hypium outcome and terminal class/test/status code', corruptedStart: true });
      }
      if (event.committed && terminal.name === event.name && terminal.class && agrees) {
        if (terminal.class === klass) confirmedClasses.add(klass);
        else conflicts.push({ initialClass: klass, terminalClass: terminal.class, name: event.name, status: event.status });
      }
      current = null; klass = null; outcomePending = null; terminal = {};
    }
    const outcome = /\[Hypium\]\[(pass|fail|error|ignore)\](.*?)\s*;/u.exec(line);
    if (!outcome) continue;
    if (outcomePending && !outcomePending.committed) errors.push({ code: 'UNBOUND_OUTCOME', name: outcomePending.name });
    const caseName = outcome[2].trim(), bound = current === caseName && Boolean(klass);
    if (bound) commit(`${module}::${klass}::${caseName}`, outcome[1]);
    outcomePending = { name: caseName, status: outcome[1], committed: bound }; terminal = {};
  }
  if (outcomePending && !outcomePending.committed) errors.push({ code: 'UNBOUND_OUTCOME', name: outcomePending.name });
  else if (outcomePending?.committed) { /* original start/class/outcome already bound */ }
  else if (current) errors.push({ code: 'UNFINISHED_CASE', name: current, class: klass });
  // GC logging can corrupt either copy of class metadata. Resolve a conflict
  // only when exactly one complete class string was independently confirmed
  // by matching start and terminal metadata elsewhere in this same runtime.
  // Never trim to an expected test ID or consult the dataset to invent a name.
  for (const conflict of conflicts) {
    const initialKnown = confirmedClasses.has(conflict.initialClass), terminalKnown = confirmedClasses.has(conflict.terminalClass);
    const originalId = `${module}::${conflict.initialClass}::${conflict.name}`;
    if (initialKnown === terminalKnown) { statuses.set(originalId, 'AMBIGUOUS'); errors.push({ code: 'CONFLICTING_CLASS', ...conflict }); }
    else if (terminalKnown) {
      const id = `${module}::${conflict.terminalClass}::${conflict.name}`;
      statuses.delete(originalId); commit(id, conflict.status);
      recovered.push({ id, source: 'terminal metadata with independent same-run class confirmation', corruptedInitialClass: conflict.initialClass });
    }
  }
  return { statuses: Object.fromEntries(statuses), errors, recovered, finished: /\[Hypium\]\[end\] run suites end/u.test(text) };
}
export function gradeArkts(task, parsed, execution) {
  const group = ids => {
    const values = { expected: ids.length, passed: [], failed: [], testErrors: [], ignored: [], missing: [], ambiguous: [] };
    for (const id of ids) values[({ PASS: 'passed', FAIL: 'failed', ERROR: 'testErrors', IGNORED: 'ignored', AMBIGUOUS: 'ambiguous' })[parsed.statuses[id]] ?? 'missing'].push(id);
    return { ...values, passRate: ids.length ? values.passed.length / ids.length : null };
  };
  const f2p = group(task.FAIL_TO_PASS), p2p = group(task.PASS_TO_PASS);
  const complete = [f2p, p2p].every(g => !g.missing.length && !g.ignored.length && !g.ambiguous.length) && !parsed.errors.length;
  // A nonzero hvigor exit is normal for a real failing baseline suite. It
  // cannot make a missing runtime report count as a test result.
  const executed = !execution.timedOut && execution.compileSucceeded && execution.freshReport === true && parsed.finished === true && complete;
  return { instanceId: task.instance_id, execution, runtimeErrors: parsed.errors, complete, executed, f2p, p2p,
    resolved: executed && f2p.failed.length + f2p.testErrors.length + p2p.failed.length + p2p.testErrors.length === 0,
    validFailToPassBase: executed && f2p.failed.length + f2p.testErrors.length === f2p.expected && p2p.passed.length === p2p.expected };
}
