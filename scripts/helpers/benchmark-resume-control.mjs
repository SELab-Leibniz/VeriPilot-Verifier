import fs from 'node:fs/promises';
import path from 'node:path';

// Only a stopped, interrupted ORIGINAL run with no Stop work can discard its
// abandoned scheduler owner. Actual repair ledgers and model history stay.
export async function isolateInterruptedBenchmarkOwner(previous, restored) {
  const read = async name => JSON.parse(await fs.readFile(path.join(previous, name), 'utf8'));
  const [exit, closure, result] = await Promise.all(['process-exit.json', 'closure.json', 'result.json'].map(read));
  if (exit.relayClosed !== true || closure.gatewayClosed !== true) throw new Error('Prior benchmark is not confirmed closed');
  if (result.complete || (result.sessionCorrections ?? result.ledger?.used ?? result.corrections) !== 0
    || !Array.isArray(result.privateRuns) || result.privateRuns.length) return false;
  const control = path.join(restored, 'native-host/state/runtime-corrector-stop-sessions/post-run');
  const archive = path.join(restored, 'prior-interrupted-post-run-control');
  try { await fs.rename(control, archive); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await fs.writeFile(path.join(restored, 'resume-control-isolation.json'), JSON.stringify({
    reason: 'Prior original owner closed; no Stop worker or correction was admitted',
    previous, archive, modelHistoryPreserved: true, repairLedgerPreserved: true,
  }, null, 2));
  return true;
}
