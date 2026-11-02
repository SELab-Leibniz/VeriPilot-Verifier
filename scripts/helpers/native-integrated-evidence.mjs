// Read-only audit of genuine hook/middleware observations. It never creates
// transcript messages, tool receipts, claims, watcher state or checker results.
import path from 'node:path';

export function summarizeIntegratedNativeEvidence({ observations, fixture, business, currentHashes, faultAt = null }) {
  const own = observations.filter(item => item.sessionId === business.sessionId && item.sessionKey === business.sessionKey);
  const key = item => item.runId && item.event?.toolCallId ? `${item.runId}:${item.event.toolCallId}` : null;
  const results = new Map(own.filter(item => item.phase === 'result' && key(item)).map(item => [key(item), item]));
  const calls = own.filter(item => item.phase === 'before').map(before => ({ before, result: results.get(key(before)) }));
  const okay = call => !call.before.decision?.block && call.result && call.result.event.isError === false
    && call.result.event.result?.isError !== true && call.result.event.result?.details?.status !== 'blocked';
  const relative = call => {
    const args = call.before.event.params ?? {}, file = args.path ?? args.file_path;
    return typeof file === 'string' ? path.relative(fixture.projectRoot, path.resolve(fixture.projectRoot, file)).replaceAll(path.sep, '/') : null;
  };
  const writes = calls.filter(call => ['write', 'edit'].includes(call.before.event.toolName)
    && fixture.deliverables.includes(relative(call)) && !call.before.decision?.block);
  const unsettledWrites = writes.filter(call => !call.result);
  const lastWriteAt = Math.max(0, ...writes.map(call => Math.max(call.before.at, call.result?.at ?? Infinity)));
  const successfulVerifications = [];
  for (const call of calls) {
    const args = call.before.event.params ?? {}, result = call.result?.event.result;
    if (call.before.event.toolName !== 'exec' || args.command !== fixture.command || !okay(call)
      || args.workdir !== fixture.projectRoot || args.timeout !== 10 || args.background !== false
      || result.details?.status !== 'completed' || result.details.exitCode !== 0) continue;
    const text = result.details.aggregated ?? result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    for (const line of text.split('\n')) {
      let report; try { report = JSON.parse(line); } catch { continue; }
      if (report.kind !== 'public-delivery-verification-v1' || report.codePassed !== true || report.guidePassed !== true) continue;
      successfulVerifications.push({ runId: call.before.runId, toolCallId: call.before.event.toolCallId,
        startedAt: call.before.at, receivedAt: call.result.at, exitCode: result.details.exitCode, report });
    }
  }
  const freshVerification = successfulVerifications.findLast(item => item.startedAt > lastWriteAt
    && (faultAt === null || item.startedAt > faultAt)
    && item.report.appSha256 === currentHashes['app.mjs'] && item.report.guideSha256 === currentHashes['docs/guide.md']) ?? null;
  return { scope: 'Native business action and chronology evidence only; private module semantics require independent current-source audit.',
    pairedSkillRead: calls.some(call => call.before.event.toolName === 'read'
      && relative(call) === 'skills/delivery-verifier/SKILL.md' && okay(call)),
    actualDeliveryWrites: Object.fromEntries(fixture.deliverables.map(file => [file, writes.filter(call => relative(call) === file && okay(call)).length])),
    lastDeliveryWriteAt: Number.isFinite(lastWriteAt) ? lastWriteAt : null, unsettledDeliveryWrites: unsettledWrites.length,
    successfulVerifications, freshVerification, freshSuccessfulVerificationObserved: Boolean(freshVerification),
    moduleAcceptance: null };
}
