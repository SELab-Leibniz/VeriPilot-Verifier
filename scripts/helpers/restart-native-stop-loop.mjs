// Restart only an already completed, idle profile owned by this experiment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditNativeStopLoop } from './audit-native-stop-loop.mjs';
import { createNativeGatewayEvaluation } from './native-gateway-evaluation.mjs';

export async function restartNativeStopLoop({ outputRoot, sourceRoot, hostRoot }) {
  const base = await fs.realpath(path.join(sourceRoot, '.runtime-correction/live-native-loop'));
  outputRoot = await fs.realpath(outputRoot);
  const relative = path.relative(base, outputRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Restart checks must target an owned native-loop profile.');
  const raw = JSON.parse(await fs.readFile(path.join(outputRoot, 'result.json'), 'utf8'));
  const owners = new Set(raw.ownerPid ? [raw.ownerPid] : []);
  const reviews = path.join(outputRoot, 'project/.runtime-correction/openclaw/native-stop-reviews');
  for (const directory of await fs.readdir(reviews)) for (const name of await fs.readdir(path.join(reviews, directory))) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(await fs.readFile(path.join(reviews, directory, name), 'utf8'));
    if (record.ownerPid) owners.add(record.ownerPid);
  }
  if (!owners.size) throw new Error('The prior profile owner cannot be verified.');
  for (const pid of owners) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    throw new Error('The prior profile owner is still live; its Gateway must finish before restart.');
  }
  const before = await auditNativeStopLoop(outputRoot);
  if (!before.complete) throw new Error('The prior loop is not a current, settled PASS.');
  let gateway, observed;
  try {
    gateway = await createNativeGatewayEvaluation({ hostRoot, sourceRoot, outputRoot, projectRoot: path.join(outputRoot, 'project'), reuseProfile: true });
    gateway.setPhase('restart-check');
    const session = await gateway.runtime.subagent.getSession({ sessionKey: raw.sessionKey });
    if (!session.messages?.length) throw new Error('The restarted actual Gateway cannot read the prior session.');
    await gateway.drain(); observed = gateway.metrics();
  } finally { await gateway?.close(); }
  const after = await auditNativeStopLoop(outputRoot);
  const complete = after.complete && after.taskId === before.taskId && after.finalReview.evaluationId === before.finalReview.evaluationId
    && after.used === before.used && after.admissionCount === before.admissionCount
    && after.privateRuns.length === before.privateRuns.length && observed?.providerRequests === 0 && observed.modelStarts.length === 0;
  const result = { mode: 'restart-check', complete, oldOwnersConfirmedExited: [...owners], taskId: after.taskId,
    verification: after.reportVerification, evaluationId: after.finalReview?.evaluationId, used: after.used,
    admissionsUnchanged: after.admissionCount === before.admissionCount, privateRunsUnchanged: after.privateRuns.length === before.privateRuns.length,
    providerRequests: observed?.providerRequests, modelStarts: observed?.modelStarts.length, outputRoot };
  await fs.writeFile(path.join(outputRoot, 'restart-check.json'), JSON.stringify(result, null, 2));
  return result;
}
