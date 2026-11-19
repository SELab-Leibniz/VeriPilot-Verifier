// Shared setup only; importing this module registers no tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sharedBasisFixture as createSharedBasisFixture, operation, user } from './runtime-v2-shared-basis-fixture.mjs';
import { scriptedCoverageReport } from './baseline-coverage-native.mjs';
import { withTaskState, ensureTask } from '../../lib/runtime-v2/task-store.mjs';
import { refreshRuntimeRequirements } from '../../lib/runtime-v2/orchestrator.mjs';

export async function sharedBasisFixture(t, options) {
  const fixture = await createSharedBasisFixture(t, options);
  const task = await ensureTask({ projectRoot: fixture.root, sessionId: 'basis-session' });
  await withTaskState({ projectRoot: fixture.root, taskId: task.taskId }, state => { state.control ??= {}; });
  return fixture;
}

export async function scratch(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rc-coverage-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

export async function refreshCapturingAuditFailure(fixture, errors, id) {
  const delegate = fixture.factory;
  const factory = async options => {
    try { return await delegate(options); }
    catch (error) {
      if (options.request.reviewScope?.kind === 'baseline-coverage-audit') errors.push(error);
      throw error;
    }
  };
  Object.assign(factory, delegate);
  return refreshRuntimeRequirements({ projectRoot: fixture.root, input: { cwd: fixture.root, session_id: 'basis-session',
    transcript_path: fixture.transcript, hook_event_name: 'Stop', hook_event_id: id }, plan: fixture.plan, reviewerFactory: factory });
}

export async function twoClaimFixture(t, mixed = false) {
  const f = await sharedBasisFixture(t), second = { ...operation(), text: mixed ? 'Write the usage guide.' : 'Provide the second requested behavior.' };
  if (mixed) { second.verificationTarget = 'ARTIFACT'; delete second.implementationRole; }
  await fs.writeFile(f.transcript, JSON.stringify({ ...user(), message: { role: 'user',
    content: `Preserve the requested feature. ${second.text}` } }) + '\n');
  f.state.sourceFrom = true; f.state.deltaOperations = [operation(), second];
  return f;
}

export function missingReadReport(context) {
  const report = scriptedCoverageReport(context), row = report.sources.find(row => row.ref === 'transcript:U1');
  report.verdict = 'REPAIR'; row.disposition = 'REPAIR';
  row.issues = [{ rangeMode: 'QUOTE', supportMode: 'DIRECT', dependencyUnitIds: [],
    obligationIds: context.inventory.sources.find(source => source.ref === 'transcript:U1').units.flatMap(unit => unit.obligations.filter(duty => duty.owner === 'PROCESS').map(duty => duty.obligationId)),
    issueKind: 'CANDIDATE', expectedDuty: 'Read and follow skills/demo/SKILL.md.',
    unitId: row.mappings[0].unitId, citeIds: row.mappings[0].citeIds, quote: 'Read and follow skills/demo/SKILL.md.',
    claimIds: [], owner: 'PROCESS', condition: '', reason: 'The original read/follow duty is absent from the effective ledger.' }];
  return report;
}

export async function nativeAuditAttempt(params, tools, name, args, id) {
  params.onAssistantMessageStart();
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }] } }) + '\n');
  const result = await tools.find(tool => tool.name === name).execute(id, args);
  await fs.appendFile(params.sessionFile, JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id,
    toolName: name, content: result.content, isError: Boolean(result.isError) } }) + '\n');
  return result;
}
