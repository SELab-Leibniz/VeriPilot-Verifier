import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStopCorrectionStore } from '../../lib/runtime-v2/stop-correction-store.mjs';

/** Relocate an authentic, quiescent ledger; never synthesize a zero counter or
 * replace a different target. Resume ancestry is explicit, not a folder scan. */
export async function restoreStopSessionLedger({ sourceRun, targetStateDirectory, sessionId, projectRoot }) {
  const seen = new Set(); let identity, selected;
  for (let hop = 0; sourceRun && hop < 64; hop++) {
    sourceRun = await fs.realpath(sourceRun);
    if (seen.has(sourceRun)) throw new Error('Cyclic session ledger ancestry');
    seen.add(sourceRun);
    const manifest = JSON.parse(await fs.readFile(path.join(sourceRun, 'manifest.json'), 'utf8'));
    if (path.relative(path.resolve(projectRoot), path.resolve(manifest.projectRoot)) !== '') throw new Error('Session ledger project changed');
    const current = JSON.stringify([manifest.instanceId, manifest.datasetDigest, manifest.preparedHead]);
    identity ??= current;
    if (identity !== current) throw new Error('Session ledger task identity changed');
    const store = createStopCorrectionStore({ directory: path.join(sourceRun, 'native-host/state/runtime-corrector-stop-sessions') });
    const source = store.fileFor(sessionId);
    const bytes = await fs.readFile(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (bytes) {
      const state = JSON.parse(bytes);
      if (state.schemaVersion !== 'runtime-corrector.stop-correction-session.v1' || state.sessionId !== sessionId
        || !Number.isSafeInteger(state.used) || state.used < 0 || !state.initialization?.evidence
        || !state.admissions || !state.stops) throw new Error('Invalid authentic session ledger');
      if (Object.values(state.admissions).some(value => value.accounting === 'RESERVED')
        || Object.values(state.stops).some(value => value.releasedAt === undefined))
        throw new Error('Pending session admissions require reconciliation before profile relocation');
      selected = { source, sourceRun, bytes, used: state.used }; break;
    }
    sourceRun = manifest.resumedFrom;
  }
  if (sourceRun && !selected) throw new Error('Session ledger ancestry limit exceeded');
  if (!selected) return { status: 'NO_AUTHENTIC_LEDGER_FOUND', sessionId, budgetReset: false };
  const target = createStopCorrectionStore({ directory: path.join(targetStateDirectory, 'runtime-corrector-stop-sessions') }).fileFor(sessionId);
  const existing = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.equals(selected.bytes)) throw new Error('Refuse to overwrite a different session ledger');
  if (!existing) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, selected.bytes, { flag: 'wx' }); }
  return { status: existing ? 'ALREADY_IDENTICAL' : 'RESTORED_AUTHENTIC_BYTES', sessionId, source: selected.source,
    sourceRun: selected.sourceRun, target, sha256: createHash('sha256').update(selected.bytes).digest('hex'),
    used: selected.used, budgetReset: false };
}
