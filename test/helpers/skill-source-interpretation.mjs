import assert from 'node:assert/strict';
import * as skillSource from '../../lib/runtime-v2/skill-source.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReviewerProgress, registerReviewerProgress } from '../../lib/openclaw/reviewer-progress.mjs';
import { runInternalExecution } from '../../lib/openclaw/internal-context.mjs';

// These are explicit offline semantic fixtures, not an NLP classifier or a
// claim that a live model can count exact offsets reliably.
export function interpretSkillUnit(unit, { normativity = 'MANDATORY', scope = 'CURRENT_TASK', current, external = [] } = {}) {
  const locate = quote => {
    const start = unit.text.indexOf(quote);
    assert(start >= 0 && unit.text.lastIndexOf(quote) === start, 'fixture quote must identify unique original text');
    return { start, end: start + quote.length };
  };
  const currentDutySpans = (current ?? (['MANDATORY', 'PROHIBITED', 'MIXED'].includes(normativity) && !external.length ? [unit.text] : [])).map(locate);
  const externalConditions = external.map(({ condition, duty, verificationTarget = 'PROCESS' }) => ({ condition: locate(condition), duty: locate(duty), verificationTarget }));
  const spans = [...currentDutySpans, ...externalConditions.flatMap(c => [c.condition, c.duty])].sort((a, b) => a.start - b.start);
  const contextSpans = []; let through = 0;
  for (const span of spans) { if (span.start > through) contextSpans.push({ start: through, end: span.start }); through = span.end; }
  if (through < unit.text.length) contextSpans.push({ start: through, end: unit.text.length });
  return { normativity, scope, reason: 'Explicit controlled semantic interpretation of the complete original unit.',
    currentDutySpans, externalConditions, contextSpans, remainderDisposition: 'CONTEXT_ONLY',
    remainderReason: 'Explicit scripted non-duty context; this fixture is not natural-language validation.' };
}

export function skillGraphCandidate(source, interpret = unit => interpretSkillUnit(unit),
  // Existing fixtures use descriptive section labels. Normative-heading tests
  // explicitly override this scripted semantic input; production has no default.
  interpretHeading = unit => interpretSkillUnit(unit, { normativity: 'DESCRIPTION' })) {
  let bodyIndex = 0;
  return { constraints: skillSource.skillSourceUnits(source).units.map((unit, index) => ({ constraintId: `C${index}`,
    sourceUnitIds: [unit.id], interpretation: unit.kind === 'HEADING_SCOPE' ? interpretHeading(unit) : interpret(unit, bodyIndex++) })), taskOverlays: [] };
}

export function skillGraphQuoteCandidate(source, interpret = unit => interpretSkillUnit(unit)) {
  const units = skillSource.skillSourceUnits(source).units;
  const graph = skillGraphCandidate(source, interpret);
  return { ...graph, constraints: graph.constraints.map((node, index) => {
    const value = node.interpretation, text = units[index].text;
    const quote = span => ({ quote: text.slice(span.start, span.end) });
    return { ...node, interpretation: { normativity: value.normativity, scope: value.scope, reason: value.reason,
      currentDuties: value.currentDutySpans.map(quote), externalConditions: value.externalConditions.map(branch => ({
        condition: quote(branch.condition), duty: quote(branch.duty), verificationTarget: branch.verificationTarget })),
      remainderDisposition: value.remainderDisposition, remainderReason: value.remainderReason } };
  }) };
}

// Scripted semantic conclusions remain explicit test inputs. This helper
// exercises actual registered original-page tools and both host prewrite and
// private session writes, rather than fabricating observed/BASIS proof tags.
export async function observeScriptedSkillSourceReview(options, handle) {
  const sessionId = `scripted-${randomUUID()}`, sessionKey = `agent:fixture:${sessionId}`;
  const directory = handle.requestDirectory;
  await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(options.request));
  const sessionFile = path.join(directory, 'session.jsonl');
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: options.projectRoot }) + '\n');
  let open = true, register; const hooks = [];
  const progress = await createReviewerProgress({ ...options, sessionId, prepared: {}, requestDirectory: directory,
    canSave: () => open, canRecover: () => open });
  registerReviewerProgress({ on(name, fn) { if (name === 'tool_result_persist') hooks.push(fn); }, registerTool(factory, metadata) {
    if (metadata.names.includes('rc_skill_care')) register = factory;
  } });
  const ctx = { agentId: 'fixture', sessionId, sessionKey };
  await runInternalExecution(sessionId, async () => {
    for (const file of options.evidence.skillSource.files) {
      let offset = 0;
      do {
        const callId = randomUUID(), args = { action: 'read', id: `skill/${file.path}`, offset };
        await fs.appendFile(sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'rc_skill_care', arguments: args }] } }) + '\n');
        const result = await register(ctx).execute(callId, args), message = { role: 'toolResult', toolName: 'rc_skill_care', toolCallId: callId, isError: false, content: result.content };
        for (const hook of hooks) hook({ toolName: 'rc_skill_care', toolCallId: callId, isSynthetic: false, message }, { agentId: 'fixture', sessionKey, toolName: 'rc_skill_care', toolCallId: callId });
        await fs.appendFile(sessionFile, JSON.stringify({ type: 'message', message }) + '\n');
        offset = JSON.parse(result.content[0].text).nextOffset;
      } while (offset !== null);
    }
  }, null, progress);
  const extend = result => ({ ...result, sourceInterpretationReviews: result.sourceInterpretationReviews
    ?? options.evidence.skillGroundTruth.constraints.map(c => ({ constraintId: c.constraintId, disposition: 'CONFIRMED',
      reason: 'Controlled scripted interpretation of the complete original fixture.', actualEvidence: ['skill/SKILL.md'] })) });
  return { ...handle, result: extend(handle.result),
    getSourceCitations: async report => [...await handle.getSourceCitations?.(report) ?? [], ...await progress.getSourceCitations({ sourceInterpretationReviews: report.sourceInterpretationReviews })],
    ...(handle.followUp ? { followUp: async args => extend(await handle.followUp(args)) } : {}),
    close: async () => { open = false; await handle.close?.(); } };
}
