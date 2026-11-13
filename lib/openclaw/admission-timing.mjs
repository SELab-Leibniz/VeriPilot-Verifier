import { performance } from 'node:perf_hooks';

// Only program-owned stage names and durations reach the host log. Never log
// prompts, file names, run identities, credentials, or error messages here.
export function admissionTiming(logger, now = () => performance.now()) {
  const started = now(), active = new Map(), completed = []; let sequence = 0, flushed = false;
  const emit = value => {
    try { (logger?.info ?? logger?.debug)?.call(logger,
      '[runtime-corrector] Input admission timing: ' + JSON.stringify(value)); } catch {}
  };
  const measure = async (stage, operation) => {
    if (!/^[a-z][a-z.-]+$/.test(stage)) throw new Error('Program-owned timing stage required.');
    const id = ++sequence, at = now(); active.set(id, { stage, at }); let ok = false;
    try { const value = await operation(); ok = true; return value; }
    finally { active.delete(id); const record = { stage, sequence: id, elapsedMs: Math.round((now()-at)*1000)/1000, outcome: ok ? 'ok' : 'error' };
      if (flushed) emit(record); else completed.push(record); }
  };
  measure.snapshot = () => emit({ stage: 'budget', elapsedMs: Math.round((now()-started)*1000)/1000,
    pending: [...active.values()].map(({stage,at}) => ({stage, elapsedMs: Math.round((now()-at)*1000)/1000})) });
  measure.flush = () => { if (!flushed) { flushed = true; emit({stage:'completed', awaits:completed}); } };
  return measure;
}
