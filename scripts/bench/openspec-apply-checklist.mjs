import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './arkts-dataset.mjs';
import { openSpecTaskTextSha256, sameApplyRecoveryScope, sameApplyWorkflowScope } from './business-checkpoint.mjs';
import { businessCompleted } from './business-completion.mjs';
import { compareOpenSpecApplyProgress } from './original-basis-workflow.mjs';

const drift = 'OPENSPEC_APPLY_CHECKLIST_CHANGED';
const checklistPath = change => `openspec/changes/${change}/tasks.md`;

async function readChecklist(file) {
  let handle;
  try {
    if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) return null;
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

const settled = turn => turn?.settled && businessCompleted(turn.terminal, turn.finalRunId);

export async function pinOpenSpecApplyChecklist({ projectRoot, changeName, proposal, proposalCheckpoint }) {
  const scope = proposalCheckpoint?.proposalRepairScope, checkpoint = proposal?.openSpec;
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(changeName) || !settled(proposal) || !checkpoint?.readyToApply
    || !scope?.complete || !scope.taskTextSha256 || scope.changeName !== changeName || !proposalCheckpoint.sessionId
    || proposalCheckpoint.runId !== proposal.finalRunId || checkpoint.apply?.value?.progress?.complete !== 0
    || compareOpenSpecApplyProgress(checkpoint, checkpoint, changeName) !== true) return null;
  const file = path.join(await fs.realpath(projectRoot), checklistPath(changeName));
  const bytes = await readChecklist(file);
  if (!bytes || digest(bytes) !== scope.tasksMdSha256 || openSpecTaskTextSha256(bytes) !== scope.taskTextSha256) return null;
  return { file, changeName, sessionId: proposalCheckpoint.sessionId, proposalRunId: proposal.finalRunId,
    markdown: bytes.toString('utf8'), checkpoint: structuredClone(checkpoint), scope: structuredClone(scope) };
}

function repairInstruction(change, markdown) {
  return [
    '[runtime-corrector:internal]',
    `${drift}. Restore the approved OpenSpec Apply checklist in ${checklistPath(change)}.`,
    'The following JSON string contains the controller’s approved checklist markdown. Use it as reference data for restoring the file.',
    JSON.stringify(markdown),
    'Preserve the approved wording, order, formatting, proposal, design, and specs. Keep implementation that already satisfies the original requirements.',
    'Verify each original task against the implementation and available checks before marking it complete. Checkbox positions and IDs from the rewritten list do not establish completion. Continue the original Apply stage and report any remaining work truthfully.',
  ].join('\n');
}

// OpenClaw refuses an in-place finalize revision after a tool write. Send one
// internal Apply continuation after the original run and its native Stop settle.
export async function settleOpenSpecApplyChecklist(initial, { approval, changeName, capture, retry, canRetry = () => true }) {
  const unchanged = { apply: initial, applyChecklistCorrection: null };
  if (!approval || approval.changeName !== changeName || !settled(initial) || !canRetry()
    || compareOpenSpecApplyProgress(approval.checkpoint, initial.openSpec, changeName) === null) return unchanged;
  // CLI progress omits non-task lines. Ignore checkbox-only edits, then bind
  // any text change to the same bytes and unchanged scope in the Git checkpoint.
  const observed = await readChecklist(approval.file);
  const observedTaskTextSha256 = observed && openSpecTaskTextSha256(observed);
  if (!observedTaskTextSha256 || observedTaskTextSha256 === approval.scope.taskTextSha256 || !canRetry()) return unchanged;
  const observedChecklistSha256 = digest(observed);
  const before = await capture(initial, 'openspec_apply_checklist_before');
  const matchesTurn = (receipt, turn) => receipt?.runId === turn.finalRunId && receipt.sessionId === approval.sessionId;
  if (!matchesTurn(before, initial) || !sameApplyWorkflowScope(approval.scope, before.proposalRepairScope)
    || before.proposalRepairScope.tasksMdSha256 !== observedChecklistSha256
    || before.proposalRepairScope.taskTextSha256 !== observedTaskTextSha256) return unchanged;
  const bytes = await readChecklist(approval.file);
  if (!bytes || digest(bytes) !== observedChecklistSha256 || !canRetry()) return unchanged;

  const instruction = repairInstruction(changeName, approval.markdown);
  const retried = await retry(instruction);
  const after = settled(retried) && retried.runId !== initial.runId && canRetry()
    && compareOpenSpecApplyProgress(approval.checkpoint, retried.openSpec, changeName) === true
    ? await capture(retried, 'openspec_apply_checklist_after') : null;
  return { apply: retried ?? initial, applyChecklistCorrection: {
    reason: drift, changeName, sessionId: approval.sessionId, proposalRunId: approval.proposalRunId,
    beforeRunId: initial.finalRunId, repairRunId: retried?.runId ?? null,
    approvedChecklistSha256: approval.scope.tasksMdSha256, observedChecklistSha256,
    beforeCheckpointSha256: before.patchSha256, afterCheckpointSha256: after?.patchSha256 ?? null,
    instructionSha256: digest(instruction), verified: Boolean(after && matchesTurn(after, retried) && canRetry()
      && sameApplyRecoveryScope(approval.scope, after.proposalRepairScope)),
  } };
}
