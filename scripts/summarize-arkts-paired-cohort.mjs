#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { targetVersion as hostVersion } from '../lib/hosts/openclaw.mjs';
import { readArktsCorrectionEvidence, readArktsVerifiedRepairStarts } from './bench/arkts-correction-evidence.mjs';
import { digest } from './bench/arkts-dataset.mjs';
import { arktsPublicAcceptanceIdentity, loadArktsQualifiedProbeDescriptor } from './bench/arkts-public-acceptance.mjs';
import { attributeArktsProviderRequests, hasArktsChecklistRecovery } from './bench/arkts-request-attribution.mjs';
import { compareOpenSpecApplyProgress } from './bench/original-basis-workflow.mjs';
import { archivedPairedCandidateScore, checkWorkerGrade, pairedBusinessTokens, pairedCampaignComparison, pairedCampaignSummary, pairedGradeInput, validPairedScore, verifyPairedGradeRetry,
  verifyPublicPairedPlan } from './run-arkts-paired-campaign.mjs';

const sha256 = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const terminalStates = new Set(['COMPLETE', 'COMPLETE_WITH_UNMATCHED_TRIALS', 'INSUFFICIENT_PAIR_WINDOW', 'PAIR_LIMIT_REACHED', 'NEEDS_ATTENTION', 'ERROR', 'CANCELLED']);
const keys = ['master', 'master-plan-sha256', 'pc', 'pc-plan-sha256', 'phones', 'phones-plan-sha256', 'release'];
const usage = 'node scripts/summarize-arkts-paired-cohort.mjs ' + keys.map(key => `--${key}=VALUE`).join(' ');
const slotName = ({ id, repetition, arm }) => `${id}-r${repetition}-${arm}`;
const slotOf = ({ id, repetition, arm }) => ({ id, repetition, arm });
const scoreOf = score => ({ f2p: { passed: score.f2p.passed, total: score.f2p.total },
  p2p: { passed: score.p2p.passed, total: score.p2p.total }, resolved: score.resolved });
const measurement = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const unchangedNames = (before, after) => isDeepStrictEqual([...before].sort(), [...after].sort());
const present = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function archiveFile(root, relative) {
  const file = path.join(root, relative);
  const real = await fs.realpath(file);
  const resolvedRelative = path.relative(root, real);
  assert(resolvedRelative && !path.isAbsolute(resolvedRelative) && resolvedRelative.split(path.sep)[0] !== '..'
    && (await fs.lstat(file)).isFile(), `Expected a regular file inside the shard archive: ${relative}`);
  return real;
}

const bytes = async (root, relative) => fs.readFile(await archiveFile(root, relative));

function checkCohortPlans(master, pc, phones) {
  assert.equal(master.kind, 'arkts-openclaw-openspec-pairs-v1', 'Use the full standard benchmark plan');
  for (const [first, last, shard] of [[0, 10, pc], [10, 13, phones]]) {
    const tasks = master.tasks.slice(first, last);
    const ids = new Set(tasks.map(task => task.id));
    assert(shard.kind === 'arkts-openclaw-openspec-subset-v1' && isDeepStrictEqual(shard.tasks, tasks)
      && isDeepStrictEqual(shard.schedule, master.schedule.filter(slot => ids.has(slot.id))),
    'Shard task pins, repetitions or arm order differ from the full plan');
  }
}

function shardBinding(execution, plan, release) {
  const releaseArgs = execution.releaseArgs, profile = execution.modelProfile;
  const sourceCommit = releaseArgs?.['source-commit'], packageSha256 = releaseArgs?.['package-sha256'];
  assert(sourceCommit === release.sourceCommit && packageSha256 === release.packageSha256, 'Shard release differs from the expected candidate');
  const endpoint = profile?.endpointSha256, policySha256 = execution.policySha256;
  const modelRef = `custom/${plan.model}`;
  assert(profile?.state === 'PROFILE_CONFIGURED' && profile.modelRef === modelRef && profile.api === 'openai-completions'
    && sha256.test(endpoint) && sha256.test(policySha256) && sha256.test(execution.providerProfilePin), 'Shard lacks its pinned provider or policy');
  const workflow = execution.workflow;
  const fileKeys = workflow?.mode === 'official-openspec' ? ['workflow', 'cli', 'cliManifest']
    : ['workflow', 'cli', 'archive', 'install', 'pluginManifest', 'pluginEntry'];
  assert(['official-openspec', 'matrixassistant'].includes(workflow?.mode) && /^\d+\.\d+\.\d+$/u.test(workflow.cliVersion)
    && unchangedNames(Object.keys(workflow.files ?? {}), fileKeys) && fileKeys.every(key => sha256.test(workflow.files[key])),
    'Shard lacks its measured OpenSpec workflow');
  const reviewerModel = execution.reviewerOptions?.['reviewer-model'] ?? plan.model;
  assert(typeof reviewerModel === 'string' && /^[\w.:-]+$/u.test(reviewerModel), 'Shard lacks its reviewer model');
  const nativeApproval = execution.reviewerOptions?.['native-openspec-approval'];
  const inventorySha256 = execution.reviewerOptions?.['openspec-requirement-inventory-sha256'];
  assert(inventorySha256 === undefined || nativeApproval === true && sha256.test(inventorySha256), 'Invalid shard OpenSpec inventory pin');
  return { sourceCommit, packageSha256, modelRef, endpoint, api: profile.api, hostVersion, reviewerModel, policySha256,
    workflow: { mode: workflow.mode, cliVersion: workflow.cliVersion, files: workflow.files },
    publicAcceptanceEnabled: execution.publicAcceptance !== undefined,
    ...(nativeApproval === true ? { nativeOpenSpecApproval: true } : {}),
    ...(inventorySha256 !== undefined ? { openSpecRequirementInventorySha256: inventorySha256 } : {}) };
}

function checkShardCalibration(execution, plan) {
  assert(execution.gradingEvidenceVersion === undefined || execution.gradingEvidenceVersion === 1, 'Unsupported shard grading evidence version');
  const ids = plan.tasks.map(task => task.id);
  const toolchainSha256 = execution.toolchain?.sha256;
  assert(sha256.test(toolchainSha256) && unchangedNames(Object.keys(execution.calibration ?? {}), ids), 'Shard calibration or toolchain is missing');
  for (const id of ids) {
    const calibration = execution.calibration[id];
    assert([calibration?.sha256, calibration?.logs?.base, calibration?.logs?.gold].every(value => sha256.test(value)), `Unbound calibration for ${id}`);
  }
  if (execution.gradingExchange) {
    assert(sha256.test(execution.buildToolchain?.sha256) && execution.common?.['public-test-toolchain-sha256'] === toolchainSha256
      && unchangedNames(Object.keys(execution.gradeTotals ?? {}), ids), 'Shard public and private worker pins differ');
  }
  if (execution.common?.['instrument-config']) assert(execution.common['instrument-toolchain-sha256'] === toolchainSha256,
    'Shard instrument toolchain pin differs from the measured one');
  if (execution.publicAcceptance !== undefined) {
    const pins = Object.entries(execution.publicAcceptance ?? {});
    assert(pins.length && pins.every(([id, hash]) => ids.includes(id) && sha256.test(hash)), 'Invalid shard public acceptance pins');
  }
  const qualified = execution.qualifiedPublicAcceptance;
  if (qualified !== undefined) {
    assert(qualified && ['reportSha256', 'probeManifestSha256', 'positiveManifestSha256'].every(key => sha256.test(qualified[key]))
      && qualified.toolchainSha256 === toolchainSha256 && qualified.runtime === execution.toolchain.runtime
      && qualified.cases && typeof qualified.cases === 'object' && !Array.isArray(qualified.cases), 'Invalid shard public probe qualification');
    const selections = Object.entries(qualified.cases);
    assert(selections.length && selections.every(([id, hash]) =>
      ids.includes(id) && sha256.test(hash) && execution.publicAcceptance?.[id] === hash), 'Invalid qualified public acceptance pins');
  }
}

function nativeAcceptanceCheck(result, pin, { runId, occurrenceId, evaluationId, reviewStatus } = {}) {
  if (!runId || !occurrenceId || !evaluationId || !reviewStatus) return null;
  const carriers = result.nativeStopRecords?.filter(row => row.runId === runId && row.occurrenceId === occurrenceId
    && row.evaluationId === evaluationId && row.status === 'SETTLED' && row.reviewStatus === reviewStatus) ?? [];
  const reviews = result.stopReviews?.filter(row => row.runId === occurrenceId && row.evaluationId === evaluationId
    && row.status === reviewStatus && row.lifecycle === 'SETTLED') ?? [];
  if (carriers.length !== 1 || reviews.length !== 1) return null;
  const check = reviews[0].publicAcceptanceCheck;
  if (!check || check.sha256 !== pin.sha256 || !Array.isArray(check.checks)) return null;
  const identity = { runId, occurrenceId, evaluationId, reviewStatus };
  if (check.status === 'INCOMPLETE' && check.checks.length === 0) return { ...identity, status: 'INCOMPLETE', checks: [] };
  if (!sha256.test(check.workspaceDigest) || (check.snapshotSha256 !== undefined && !sha256.test(check.snapshotSha256))
    || check.checks.length !== pin.testIds.length
    || check.checks.some((item, index) => item?.id !== pin.testIds[index] || !['FAIL', 'PASS'].includes(item.status))) return null;
  const status = check.checks.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS';
  if (status !== check.status) return null;
  return { ...identity, status, checks: check.checks.map(({ id, status }) => ({ id, status })), workspaceDigest: check.workspaceDigest,
    ...(check.snapshotSha256 ? { snapshotSha256: check.snapshotSha256 } : {}) };
}

async function summarizePublicAcceptance(result, row, business, expected, qualified) {
  if (!expected) return { status: 'NOT_CONFIGURED' };
  if (row.arm === 'off' && !qualified) return { status: 'CORRECTOR_DISABLED' };
  if (qualified) assert(Array.isArray(result.publicAcceptancePin?.requirementBindings), `Missing qualified public probe: ${slotName(row)}`);
  if (!result.publicAcceptancePin) return { status: 'NOT_RECORDED' };
  const pin = result.publicAcceptancePin;
  assert(sha256.test(pin.sha256) && Array.isArray(pin.testIds) && pin.testIds.length > 0
    && pin.testIds.every(id => typeof id === 'string' && id) && new Set(pin.testIds).size === pin.testIds.length
    && arktsPublicAcceptanceIdentity(result.publicInputSha256, pin) === expected, `Public acceptance descriptor differs from its campaign pin: ${slotName(row)}`);
  if (row.arm === 'off') return { status: 'CORRECTOR_DISABLED' };
  if (!result.frozen) return { status: 'NOT_RECORDED', probeSha256: pin.sha256 };
  const coding = result.turns?.at(-1);
  const carrier = result.nativeStopVerification;
  const finalStop = result.nativeStopSettled === true && coding?.stage === 'codeing' && carrier?.status === 'SETTLED'
    && carrier.runId === coding.finalRunId
    ? nativeAcceptanceCheck(result, pin, carrier) : null;
  const correction = await readArktsCorrectionEvidence(business, {
    expectedResultSha256: row.businessResultSha256, includeIncompleteWorkflow: row.score === null,
  });
  let beforeFirstCorrection = null;
  if (['eligible', 'diagnostic'].includes(correction.status) && correction.after.sha256 === (row.patchSha256 ?? result.frozen?.patchSha256)) {
    const first = correction.corrections[0];
    beforeFirstCorrection = nativeAcceptanceCheck(result, pin, { runId: first.sourceRunId, occurrenceId: first.stopId,
      evaluationId: first.evaluationId, reviewStatus: 'DEVIATION' });
  }
  return { status: finalStop || beforeFirstCorrection ? 'RECORDED' : 'NOT_RECORDED', probeSha256: pin.sha256,
    finalStop, beforeFirstCorrection };
}

const businessPath = row => path.join('trials', row.id, `r${row.repetition}`, row.arm, 'business');

function checkBusinessResult(result, row, task, binding) {
  assert(result.rcEnabled === (row.arm === 'on') && result.state === row.business
    && result.businessNatural === row.businessCompleted && result.gateway?.hostVersion === binding.hostVersion
    && result.providerIdentity?.modelRef === binding.modelRef && result.providerIdentity?.endpointSha256 === binding.endpoint
    && result.packageSha256 === binding.packageSha256 && result.instance?.id === row.id
    && result.instance.baseCommit === task.baseCommit && result.instance.datasetDigest === task.datasetSha256
    && result.publicInputSha256 === task.publicSha256 && commit.test(result.preparedTree),
  `Business receipt identity differs from the campaign: ${slotName(row)}`);
}

function checkBusinessManifest(result, manifest, workflow, expected, row, binding) {
  assert(manifest.sourceCommit === binding.sourceCommit && manifest.packageSha256 === binding.packageSha256
    && manifest.publicAcceptanceSha256 === expected && manifest.rcEnabled === result.rcEnabled
    && manifest.projectRoot === result.projectRoot && manifest.preparedTree === result.preparedTree
    && manifest.publicInputSha256 === result.publicInputSha256 && isDeepStrictEqual(workflow.workflow, binding.workflow),
  `Business manifest or workflow differs from the campaign: ${slotName(row)}`);
}

async function checkQualifiedProbeFiles(root, business, result, expected) {
  const directory = path.join(path.dirname(business), 'public-acceptance');
  const [descriptor, , publicInput] = await Promise.all([
    archiveFile(root, path.join(directory, 'descriptor.json')),
    archiveFile(root, path.join(directory, 'probe.ets')),
    bytes(root, path.join('public', `${result.instance.id}.json`)),
  ]);
  assert.equal(digest(publicInput), result.publicInputSha256, 'Public input differs from the qualified trial');
  await loadArktsQualifiedProbeDescriptor(descriptor, JSON.parse(publicInput), result.publicInputSha256, expected);
}

function readBusinessResult(resultBytes, row) {
  const result = JSON.parse(resultBytes);
  if (row.businessResultSha256 !== undefined || result.publicAcceptancePin !== undefined
    || Object.hasOwn(result.openSpec ?? {}, 'applyChecklistPreserved'))
    assert.equal(row.businessResultSha256, digest(resultBytes), `Business receipt bytes differ from the durable result: ${slotName(row)}`);
  return result;
}

async function readSealedBusinessResult(root, row, task, binding) {
  if (!sha256.test(row.businessResultSha256)) return null;
  const resultBytes = await bytes(root, path.join(businessPath(row), 'result.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!resultBytes) return null;
  const result = readBusinessResult(resultBytes, row);
  checkBusinessResult(result, row, task, binding);
  return result;
}

function sealedBusinessMeasurements(row, result) {
  const fields = { providerRequests:'modelRequests', elapsedMs:'elapsedMs', usage:'tokenSplit', completionReason:'reason' };
  const measurements = Object.fromEntries(Object.entries(fields).map(([target, source]) => {
    const value = result?.[source] ?? null;
    if (result && Object.hasOwn(result, source)) assert(isDeepStrictEqual(row[target] ?? null, value),
      `Observed ${target} differs from the sealed business result: ${slotName(row)}`);
    return [target, value];
  }));
  const tokens = pairedBusinessTokens(result);
  if (result && Object.hasOwn(row, 'tokens')) assert(isDeepStrictEqual(row.tokens, tokens),
    `Observed tokens differ from the sealed business result: ${slotName(row)}`);
  return { ...measurements, tokens, businessCompleted:result?.businessNatural ?? null };
}

async function checkGradeEvidence(root, trial, row, task, execution, binding) {
  if (execution.gradingEvidenceVersion === undefined && row.gradingEvidenceSha256 === undefined)
    return { status: 'LEGACY_UNSEALED_GRADE' };
  const mismatch = `Independent grading evidence differs from ${slotName(row)}`;
  assert(execution.gradingEvidenceVersion === 1 && sha256.test(row.gradingEvidenceSha256) && sha256.test(row.businessResultSha256),
    `Missing independent grading evidence for ${slotName(row)}`);
  const evidenceBytes = await bytes(root, path.join(trial, 'grading-evidence.json'));
  assert.equal(digest(evidenceBytes), row.gradingEvidenceSha256, mismatch);
  const evidence = JSON.parse(evidenceBytes);
  const attempt = row.gradingRetry ? 2 : 1;
  const calibration = execution.calibration[row.id];
  const input = pairedGradeInput(task, row.patchSha256, calibration.sha256, execution.toolchain.sha256, binding.sourceCommit);
  assert(evidence.version === 1 && isDeepStrictEqual(evidence.slot, slotOf(row)) && evidence.attempt === attempt
    && evidence.businessResultSha256 === row.businessResultSha256 && isDeepStrictEqual(evidence.input, input)
    && isDeepStrictEqual(evidence.execution, row.gradingExecution) && isDeepStrictEqual(evidence.score, row.score)
    && [evidence.gradeSha256, evidence.coverageSha256].every(hash => sha256.test(hash)), mismatch);
  if (execution.gradingExchange) {
    checkWorkerGrade(evidence, input, execution.gradeTotals[row.id]);
  } else {
    const grading = path.join(trial, attempt === 2 ? 'grading-retry' : 'grading');
    const [grade, coverage, patch] = await Promise.all(['results.json', 'candidate-coverage.log', 'candidate.patch']
      .map(file => bytes(root, path.join(grading, file))));
    assert(digest(grade) === evidence.gradeSha256 && digest(coverage) === evidence.coverageSha256 && digest(patch) === row.patchSha256,
      `Archived evaluator files differ from the grading evidence for ${slotName(row)}`);
    assert.deepEqual(archivedPairedCandidateScore(JSON.parse(grade), input, calibration.root), row.score, mismatch);
  }
  return { status: 'VERIFIED', route: execution.gradingExchange ? 'worker' : 'local', sha256: row.gradingEvidenceSha256 };
}

async function checkScoredObservation(root, row, task, execution, binding, sealed) {
  const identity = row.comparisonIdentity;
  assert(validPairedScore(row.score) && row.business === 'finished' && row.businessCompleted === true && row.execution?.exitCode === 0
    && row.execution.interrupted === false && row.execution.outputComplete === true && !row.gradingFailure
    && row.gradingExecution?.interrupted === false && row.gradingExecution.outputComplete === true
    && row.gradingExecution.exitCode === (row.score.resolved ? 0 : 1),
  `Unsettled business or grading result for ${slotName(row)}`);
  assert(identity && commit.test(identity.preparedTree) && sha256.test(row.patchSha256) && identity.publicInputSha256 === task.publicSha256
    && ['sourceCommit', 'packageSha256', 'modelRef', 'endpoint', 'hostVersion', 'workflow'].every(key => isDeepStrictEqual(identity[key], binding[key]))
    && identity.toolchainSha256 === execution.toolchain.sha256 && identity.buildToolchainSha256 === execution.buildToolchain?.sha256
    && identity.publicAcceptanceSha256 === execution.publicAcceptance?.[row.id], `Scored slot identity differs from the campaign: ${slotName(row)}`);
  const expected = execution.gradeTotals?.[row.id];
  if (execution.gradingExchange) assert(expected && ['f2p', 'p2p'].every(key => row.score[key].total === expected[key]),
    `Scored slot test counts differ from the worker calibration: ${slotName(row)}`);
  const business = businessPath(row);
  const [result, patch] = await Promise.all([sealed ?? bytes(root, path.join(business, 'result.json')).then(value => readBusinessResult(value, row)),
    bytes(root, path.join(business, 'freeze', 'candidate.patch'))]);
  if (!sealed) checkBusinessResult(result, row, task, binding);
  assert(result.frameworkError === false && digest(patch) === row.patchSha256 && result.frozen?.patchSha256 === row.patchSha256
    && result.openSpec?.codeing?.applyComplete === true && result.preparedTree === identity.preparedTree,
  `Scored slot differs from its frozen business output: ${slotName(row)}`);
  const { openSpec } = result;
  if (Object.hasOwn(openSpec, 'applyChecklistPreserved')) {
    assert(openSpec.applyChecklistPreserved === true
      && compareOpenSpecApplyProgress(openSpec.proposal, openSpec.codeing, openSpec.proposal?.changeName) === true,
    `Scored slot changed its approved OpenSpec checklist: ${slotName(row)}`);
  }
  const expectedAcceptance = execution.publicAcceptance?.[row.id];
  const qualified = Boolean(execution.qualifiedPublicAcceptance?.cases[row.id]);
  if (qualified) {
    const [manifest, messages] = await Promise.all(['manifest.json', 'workflow-messages.json']
      .map(file => bytes(root, path.join(business, file)).then(JSON.parse)));
    checkBusinessManifest(result, manifest, messages, expectedAcceptance, row, binding);
    await checkQualifiedProbeFiles(root, business, result, expectedAcceptance);
  }
  const [publicAcceptance, gradingEvidence] = await Promise.all([
    summarizePublicAcceptance(result, row, path.join(root, business), expectedAcceptance, qualified),
    checkGradeEvidence(root, path.dirname(business), row, task, execution, binding),
  ]);
  return { publicAcceptance, gradingEvidence };
}

async function checkUngradedPublicAcceptance(root, row, execution, binding, result) {
  const expected = execution.publicAcceptance?.[row.id];
  if (!expected || !result || row.business !== 'finished'
    || row.execution?.exitCode !== 0 || row.execution.interrupted !== false || row.execution.outputComplete !== true) return null;
  const business = businessPath(row);
  const [manifestBytes, workflowBytes] = await Promise.all(['manifest.json', 'workflow-messages.json']
    .map(file => bytes(root, path.join(business, file))));
  assert(result.frameworkError === false, `Unsettled business result for ${slotName(row)}`);
  checkBusinessManifest(result, JSON.parse(manifestBytes), JSON.parse(workflowBytes), expected, row, binding);
  const qualified = Boolean(execution.qualifiedPublicAcceptance?.cases[row.id]);
  if (qualified) await checkQualifiedProbeFiles(root, business, result, expected);
  if (row.arm === 'on' && result.publicAcceptancePin && result.frozen) {
    const [freeze, patch] = await Promise.all(['freeze/freeze.json', 'freeze/candidate.patch'].map(file => bytes(root, path.join(business, file))));
    assert(isDeepStrictEqual(JSON.parse(freeze), result.frozen) && sha256.test(result.frozen?.patchSha256)
      && digest(patch) === result.frozen.patchSha256 && (row.patchSha256 === undefined || row.patchSha256 === result.frozen.patchSha256),
    `Ungraded public acceptance differs from its frozen candidate: ${slotName(row)}`);
  }
  return summarizePublicAcceptance(result, row, path.join(root, business), expected, qualified);
}

async function checkObservedRepairStarts(root, row, execution, binding, result) {
  if (row.arm !== 'on' || !result) return [];
  const business = businessPath(row);
  const starts = await readArktsVerifiedRepairStarts(path.join(root, business), { expectedResultSha256: row.businessResultSha256 });
  if (!starts.length) return [];
  const [manifestBytes, workflowBytes] = await Promise.all(['manifest.json', 'workflow-messages.json']
    .map(file => bytes(root, path.join(business, file))));
  checkBusinessManifest(result, JSON.parse(manifestBytes), JSON.parse(workflowBytes), execution.publicAcceptance?.[row.id], row, binding);
  return starts;
}

function metrics(schedule, observations) {
  const arms = pairedCampaignSummary(schedule, observations);
  const comparison = pairedCampaignComparison(schedule, observations);
  if (comparison.matchedScoredPairs !== comparison.plannedPairs) for (const arm of Object.values(arms)) arm.passAt1 = null;
  return { arms, comparison };
}

async function readChecklistRecoveryEvidence(root, business, result, sourceCommit) {
  const receipt = result?.openSpec?.applyChecklistCorrection;
  if (!hasArktsChecklistRecovery(result) || !receipt || !Array.isArray(result.turns)) return null;
  const checkpointRoot = path.join(business, 'checkpoints');
  const manifest = await bytes(root, path.join(business, 'manifest.json')).then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  });
  if (!manifest || manifest.sourceCommit !== sourceCommit || manifest.preparedTree !== result.preparedTree
    || manifest.packageSha256 !== result.packageSha256) return null;
  const eligibleRuns = new Set([receipt.proposalRunId, receipt.beforeRunId,
    ...result.turns.filter(turn => turn?.checklistRepair === true).map(turn => turn.finalRunId)].filter(Boolean));
  const reasons = new Set(['openspec_proposal_boundary', 'openspec_proposal_transport_after', 'openspec_validation_repair_after',
    'openspec_apply_checklist_before', 'openspec_apply_checklist_after']);
  const entries = await fs.readdir(path.join(root, checkpointRoot), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const checkpoints = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue;
    const directory = path.join(checkpointRoot, entry.name);
    try {
      const checkpoint = JSON.parse(await bytes(root, path.join(directory, 'checkpoint.json')));
      if (!eligibleRuns.has(checkpoint?.runId) || !reasons.has(checkpoint.stopReason) || !sha256.test(checkpoint.patchSha256)) continue;
      if (digest(await bytes(root, path.join(directory, 'candidate.patch'))) === checkpoint.patchSha256)
        checkpoints.push(checkpoint);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return { manifest, checkpoints };
}

async function readRequestAttribution(root, row, result, sourceCommit) {
  if (result && Object.hasOwn(result, 'modelRequests') && row.providerRequests !== undefined)
    assert.equal(row.providerRequests, result.modelRequests, `Observed provider requests differ from the sealed business result: ${slotName(row)}`);
  const timing = result && await bytes(root, path.join(businessPath(row), 'native-host', 'provider-fetch-timing.jsonl'))
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let timings = null;
  try {
    if (timing) timings = timing.toString().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const checklistEvidence = await readChecklistRecoveryEvidence(root, businessPath(row), result, sourceCommit);
  return { ...slotOf(row), businessResultSha256: result ? row.businessResultSha256 : null,
    timingSha256: timing ? digest(timing) : null, ...attributeArktsProviderRequests(result, timings, checklistEvidence) };
}

async function readShard(root, { plan, planSha256 }, release, { requestRoles = false } = {}) {
  const lock = path.join(root, '.campaign-lock');
  const executionFile = path.join(root, 'execution.json');
  assert(!await present(lock), 'The shard is running or has an unsettled campaign lock');
  if (!await present(executionFile)) {
    for (const name of ['summary.json', 'invocations', 'observations'])
      assert(!await present(path.join(root, name)), 'Shard activity exists without a frozen execution receipt');
    assert(!await present(lock) && !await present(executionFile), 'Shard started during reporting');
    return { planSha256, status: 'PLAN_ONLY', binding: null, observations: [], ...metrics(plan.schedule, []) };
  }
  const [executionBytes, summaryBytes] = await Promise.all([bytes(root, 'execution.json'), bytes(root, 'summary.json')]);
  const execution = JSON.parse(executionBytes), summary = JSON.parse(summaryBytes);
  assert(execution.planSha256 === planSha256 && summary.planSha256 === planSha256 && terminalStates.has(summary.status), 'Shard has no terminal summary for this plan');
  const invocations = await fs.readdir(path.join(root, 'invocations'));
  assert(Number.isSafeInteger(summary.invocation) && invocations.length === summary.invocation
    && invocations.every(name => /^[1-9]\d*$/u.test(name) && Number(name) <= summary.invocation), 'Shard invocation prefix is incomplete');
  const finalInvocation = path.join('invocations', String(summary.invocation));
  assert(isDeepStrictEqual(JSON.parse(await bytes(root, path.join(finalInvocation, 'summary.json'))), summary), 'Shard summary differs from its terminal invocation');
  const start = JSON.parse(await bytes(root, path.join(finalInvocation, 'start.json')));
  assert(Array.isArray(summary.observations) && summary.observations.length <= plan.schedule.length
    && Number.isSafeInteger(start.startSlot) && start.startSlot >= 0 && start.startSlot % 2 === 0 && start.startSlot <= summary.observations.length,
  'Shard terminal invocation has an invalid observation prefix');
  if (summary.status.startsWith('COMPLETE')) assert.equal(summary.observations.length, plan.schedule.length, 'Complete shard lacks terminal trial slots');
  if (summary.status === 'INSUFFICIENT_PAIR_WINDOW') assert.equal(summary.observations.length % 2, 0, 'Window-paused shard ends inside a pair');
  if (summary.status === 'PAIR_LIMIT_REACHED') assert(Number.isSafeInteger(start.maxPairs) && start.maxPairs > 0
    && summary.observations.length - start.startSlot === 2 * start.maxPairs && summary.observations.length < plan.schedule.length,
  'Pair-limited shard differs from its settled whole-pair prefix');

  const binding = shardBinding(execution, plan, release);
  checkShardCalibration(execution, plan);
  const observationRoot = path.join(root, 'observations');
  const initialNames = await fs.readdir(observationRoot);
  const remaining = new Set(initialNames);
  const evidence = new Map();
  const measurements = new Map();
  const requestAttribution = [];
  for (const [index, row] of summary.observations.entries()) {
    const planned = plan.schedule[index], stem = slotName(planned);
    assert(isDeepStrictEqual(slotOf(row), planned), `Unexpected slot in shard observation prefix: ${stem}`);
    if (row.score && planned.arm === 'on' && binding.openSpecRequirementInventorySha256 !== undefined)
      assert(row.openSpecRequirementInventorySha256 === binding.openSpecRequirementInventorySha256
        && row.nativeApplyVerdict?.inventory?.status === 'OBSERVED'
        && row.nativeApplyVerdict.inventory.inventorySha256 === row.nativeApplyApproval?.inventorySha256,
      `Scored strict OpenSpec arm lacks its bound inventory review: ${stem}`);
    const started = `${stem}.started.json`, finished = `${stem}.result.json`;
    assert(remaining.delete(started) && isDeepStrictEqual(JSON.parse(await bytes(root, path.join('observations', started))), planned),
      `Missing or unexpected shard slot claim: ${stem}`);
    if (!remaining.delete(finished)) {
      assert.equal(summary.status, 'ERROR', `Missing durable result for ${stem}`);
      assert(index === summary.observations.length - 1 && isDeepStrictEqual(row, { ...planned, score: null, business: 'campaign-error' }),
        `Unexpected unsealed result for ${stem}`);
      if (requestRoles) requestAttribution.push(await readRequestAttribution(root, row, null));
      continue;
    }
    assert(isDeepStrictEqual(JSON.parse(await bytes(root, path.join('observations', finished))), row), `Shard summary differs from durable result: ${stem}`);
    const task = plan.tasks.find(task => task.id === row.id);
    const sealed = await readSealedBusinessResult(root, row, task, binding);
    if (requestRoles) {
      requestAttribution.push(await readRequestAttribution(root, row, sealed, binding.sourceCommit));
      continue;
    }
    measurements.set(stem, sealedBusinessMeasurements(row, sealed));
    const [verified, repairStarts] = await Promise.all([
      row.score === null ? checkUngradedPublicAcceptance(root, row, execution, binding, sealed).then(publicAcceptance => ({ publicAcceptance }))
        : checkScoredObservation(root, row, task, execution, binding, sealed),
      checkObservedRepairStarts(root, row, execution, binding, sealed),
      verifyPairedGradeRetry(row, execution.calibration?.[row.id]?.sha256,
        name => bytes(root, path.join(path.dirname(businessPath(row)), name))),
    ]);
    const { publicAcceptance, gradingEvidence } = verified;
    evidence.set(stem, { ...(publicAcceptance ? { publicAcceptance } : {}), ...(gradingEvidence ? { gradingEvidence } : {}),
      ...(repairStarts.length ? { verifiedRepairStarts: repairStarts } : {}),
      ...(row.gradingRetry ? { gradingRetried: true } : {}) });
  }
  assert.equal(remaining.size, 0, 'Unexpected slot receipts in the shard');
  assert(!await present(lock) && (await bytes(root, 'summary.json')).equals(summaryBytes) && (await bytes(root, 'execution.json')).equals(executionBytes)
    && unchangedNames(await fs.readdir(observationRoot), initialNames), 'Shard changed during reporting');
  if (requestRoles) return { status: summary.status, planSha256, executionSha256: digest(executionBytes),
    terminalSummarySha256: digest(summaryBytes), requestAttribution };
  const observations = summary.observations.map(row => {
    const stem = slotName(row);
    const legacyGrade = evidence.get(stem)?.gradingEvidence?.status === 'LEGACY_UNSEALED_GRADE';
    return { ...row, ...measurements.get(stem), ...(legacyGrade ? { score:null, gradingFailure:'LEGACY_UNSEALED_GRADE' } : {}) };
  });
  const hasLegacyGrades = observations.some(row => row.gradingFailure === 'LEGACY_UNSEALED_GRADE');
  const calculated = metrics(plan.schedule, observations);
  if (summary.status === 'COMPLETE' && !hasLegacyGrades) assert.equal(calculated.comparison.matchedScoredPairs, plan.schedule.length / 2,
    'Complete shard lacks matching independent grades');
  const status = hasLegacyGrades && summary.status.startsWith('COMPLETE') ? 'COMPLETE_WITH_UNVERIFIED_GRADES' : summary.status;
  return { planSha256, status, binding, executionSha256: digest(executionBytes), terminalSummarySha256: digest(summaryBytes),
    gradingToolchainSha256: execution.toolchain.sha256,
    ...(execution.qualifiedPublicAcceptance ? { qualifiedPublicAcceptance: execution.qualifiedPublicAcceptance } : {}),
    observations, evidence, ...calculated };
}

export async function reportArktsReviewRequests({ directory, planSha256, release }) {
  assert(commit.test(release?.sourceCommit) && sha256.test(release?.packageSha256), 'Provide the expected immutable release');
  const root = await fs.realpath(directory);
  const verified = await verifyPublicPairedPlan(root, planSha256);
  const shard = await readShard(root, verified, release, { requestRoles: true });
  const trials = shard.requestAttribution ?? [];
  const arms = Object.fromEntries(['off', 'on'].map(arm => {
    const rows = trials.filter(row => row.arm === arm);
    const measured = rows.filter(row => row.providerRequests !== null);
    const attributed = measured.filter(row => row.status !== 'UNAVAILABLE');
    return [arm, { attemptedTrials: rows.length, measuredTrials: measured.length,
      completeAttributionTrials: measured.filter(row => row.status === 'COMPLETE').length,
      providerRequests: measured.length ? measured.reduce((total, row) => total + row.providerRequests, 0) : null,
      unknownRequests: measured.length ? measured.reduce((total, row) => total + row.unknownRequests, 0) : null,
      attributedByRole: attributed.length ? Object.fromEntries(['business', 'document', 'stop'].map(role => [role,
        attributed.reduce((total, row) => total + Object.values(row.byStage).reduce((sum, stage) => sum + stage[role], 0), 0)])) : null }];
  }));
  return { kind: 'arkts-review-request-attribution-v1', status: shard.status, planSha256: shard.planSha256,
    release: { sourceCommit: release.sourceCommit, packageSha256: release.packageSha256 },
    executionSha256: shard.executionSha256 ?? null, terminalSummarySha256: shard.terminalSummarySha256 ?? null,
    plannedTrials: verified.plan.schedule.length, arms, trials };
}

export async function readArktsCorrectionGradingPlan({ directory, planSha256, release }) {
  assert(commit.test(release?.sourceCommit) && sha256.test(release?.packageSha256), 'Provide the expected immutable release');
  const root = await fs.realpath(directory);
  const verified = await verifyPublicPairedPlan(root, planSha256);
  const shard = await readShard(root, verified, release);
  assert(shard.terminalSummarySha256, 'Correction grading requires a fully scheduled terminal shard');

  const readTerminalFiles = async () => {
    const [executionBytes, summaryBytes] = await Promise.all([bytes(root, 'execution.json'), bytes(root, 'summary.json')]);
    assert(digest(executionBytes) === shard.executionSha256 && digest(summaryBytes) === shard.terminalSummarySha256
      && !await present(path.join(root, '.campaign-lock')), 'Shard changed during correction grading selection');
    return { executionBytes, summaryBytes };
  };
  const { executionBytes, summaryBytes } = await readTerminalFiles();
  const { status } = JSON.parse(summaryBytes);
  assert(status === 'COMPLETE' || status === 'COMPLETE_WITH_UNMATCHED_TRIALS', 'Correction grading requires a fully scheduled terminal shard');
  const { calibration: calibrations } = JSON.parse(executionBytes);
  const tasks = new Map(verified.plan.tasks.map(task => [task.id, task]));
  const candidates = [], skipped = [];

  for (const row of shard.observations) {
    if (row.arm !== 'on') continue;
    const { verifiedRepairStarts: starts, gradingEvidence } = shard.evidence.get(slotName(row)) ?? {};
    if (!starts?.length) continue;
    const slot = slotOf(row);
    if (!row.score || gradingEvidence?.status !== 'VERIFIED') {
      skipped.push({ slot, reason: 'FINAL_GRADE_UNVERIFIED' });
      continue;
    }
    const correction = await readArktsCorrectionEvidence(path.join(root, businessPath(row)), { expectedResultSha256: row.businessResultSha256 });
    if (correction.status !== 'eligible') {
      skipped.push({ slot, reason: correction.reason ?? 'CORRECTION_EVIDENCE_UNVERIFIED' });
      continue;
    }
    if (correction.after.sha256 !== row.patchSha256) {
      skipped.push({ slot, reason: 'FINAL_PATCH_MISMATCH' });
      continue;
    }
    const [first] = correction.corrections;
    const { sourceRunId, runId, occurrenceId, evaluationId, startedAt } = starts[0];
    const firstRepair = { sourceRunId, runId, stopId: occurrenceId, evaluationId, startedAt };
    if (!first || !Object.entries(firstRepair).every(([key, value]) => first[key] === value)) {
      skipped.push({ slot, reason: 'FIRST_REPAIR_IDENTITY_MISMATCH' });
      continue;
    }
    const { sha256: calibrationSha256, logs: { base, gold } } = calibrations[row.id];
    const beforeInput = pairedGradeInput(tasks.get(row.id), correction.before.sha256, calibrationSha256,
      shard.gradingToolchainSha256, release.sourceCommit);
    const score = scoreOf(row.score);
    candidates.push({ slot, businessResultSha256: row.businessResultSha256, before: correction.before, beforeInput,
      after: { patchSha256: row.patchSha256, score, gradingEvidenceSha256: gradingEvidence.sha256 },
      calibration: { sha256: calibrationSha256, logs: { base, gold } }, totals: { f2p: score.f2p.total, p2p: score.p2p.total },
      firstRepair, repairCount: correction.corrections.length });
  }
  await readTerminalFiles();
  return { root, planSha256: verified.planSha256, executionSha256: shard.executionSha256,
    terminalSummarySha256: shard.terminalSummarySha256, gradeWallMs: verified.plan.gradeWallMs, candidates, skipped };
}

export async function readArktsPairedGradeTransitionPlan({ directory, planSha256, release }) {
  assert(commit.test(release?.sourceCommit) && sha256.test(release?.packageSha256), 'Provide the expected immutable release');
  const root = await fs.realpath(directory);
  const verified = await verifyPublicPairedPlan(root, planSha256);
  const shard = await readShard(root, verified, release);
  const { executionSha256, terminalSummarySha256, status: shardStatus } = shard;
  const settledPairs = shard.observations.length / 2;
  const plannedPairs = shard.comparison.plannedPairs;
  const paused = ['PAIR_LIMIT_REACHED', 'INSUFFICIENT_PAIR_WINDOW'].includes(shardStatus);
  assert(shardStatus.startsWith('COMPLETE') && settledPairs === plannedPairs
    || paused && Number.isInteger(settledPairs) && settledPairs > 0 && settledPairs < plannedPairs,
  'Grade transitions require a complete shard or a nonempty whole-pair pause');

  if (paused) for (const row of shard.observations) {
    const grading = shard.evidence.get(slotName(row))?.gradingEvidence;
    const gradeSettled = row.businessCompleted === true ? grading?.status === 'VERIFIED'
      : row.businessCompleted === false && !row.gradingExecution && !row.gradingFailure;
    assert(row.business === 'finished' && row.execution?.exitCode === 0 && row.execution.interrupted === false
      && row.execution.outputComplete === true && gradeSettled, `Unsealed or unsettled trial in paused shard: ${slotName(row)}`);
  }

  const observations = new Map(shard.observations.map(row => [slotName(row), row]));
  async function readArm(slot) {
    const key = slotName(slot);
    const row = observations.get(key);
    const grading = shard.evidence.get(key)?.gradingEvidence;
    assert(row?.score && grading?.status === 'VERIFIED', `Missing verified grade for ${key}`);
    const trial = path.dirname(businessPath(row));
    const receipt = await bytes(root, path.join(trial, 'grading-evidence.json'));
    assert.equal(digest(receipt), grading.sha256, `Grading evidence changed during grade transition selection: ${key}`);
    const { input, gradeSha256, coverageSha256 } = JSON.parse(receipt);
    return { input, gradeSha256, coverageSha256, score: scoreOf(row.score), gradingEvidenceSha256: grading.sha256,
      localGradeDirectory: grading.route === 'worker' ? null : path.join(trial, row.gradingRetry ? 'grading-retry' : 'grading'),
      providerRequests: measurement(row.providerRequests), elapsedMs: measurement(row.elapsedMs), tokens: row.tokens ?? null };
  }

  const pairs = await Promise.all(shard.comparison.scoreChanges.pairs.map(async ({ id, repetition }) => {
    const [off, on] = await Promise.all(['off', 'on'].map(arm => readArm({ id, repetition, arm })));
    return { id, repetition, off, on };
  }));
  const [execution, summary] = await Promise.all([bytes(root, 'execution.json'), bytes(root, 'summary.json')]);
  assert(digest(execution) === executionSha256 && digest(summary) === terminalSummarySha256
    && !await present(path.join(root, '.campaign-lock')), 'Shard changed during grade transition selection');
  const taskPairs = Object.fromEntries(verified.plan.tasks.map(({ id }) => [id, verified.plan.repetitions]));
  const settledTaskPairs = Object.fromEntries(verified.plan.tasks.map(({ id }) => [id, 0]));
  for (const row of shard.observations) if (row.arm === 'off') settledTaskPairs[row.id]++;
  return { root, planSha256: verified.planSha256, executionSha256, terminalSummarySha256,
    shardStatus, plannedPairs, settledPairs, taskPairs, settledTaskPairs, pairs };
}

export async function summarizeArktsPairedCohort({ master, pc, phones, release }) {
  assert(commit.test(release?.sourceCommit) && sha256.test(release?.packageSha256), 'Provide the expected immutable release');
  const [masterRoot, pcRoot, phonesRoot] = await Promise.all([master, pc, phones].map(shard => fs.realpath(shard.directory)));
  assert(new Set([masterRoot, pcRoot, phonesRoot]).size === 3, 'Use distinct full plan and shard directories');
  const [full, pcPlan, phonePlan] = await Promise.all([[masterRoot, master], [pcRoot, pc], [phonesRoot, phones]]
    .map(([root, entry]) => verifyPublicPairedPlan(root, entry.planSha256)));
  checkCohortPlans(full.plan, pcPlan.plan, phonePlan.plan);
  const [pcReport, phoneReport] = await Promise.all([readShard(pcRoot, pcPlan, release), readShard(phonesRoot, phonePlan, release)]);
  const binding = pcReport.binding ?? phoneReport.binding;
  if (pcReport.binding && phoneReport.binding) assert(isDeepStrictEqual(pcReport.binding, phoneReport.binding),
    'Shard workflow, provider, reviewer or policy differs');
  const observations = new Map([...pcReport.observations, ...phoneReport.observations].map(row => [slotName(row), row]));
  const ordered = full.plan.schedule.map(slot => observations.get(slotName(slot))).filter(Boolean);
  const calculated = metrics(full.plan.schedule, ordered);
  const status = !binding ? 'PLAN_ONLY' : pcReport.status === 'COMPLETE' && phoneReport.status === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL';
  const evidence = new Map([...(pcReport.evidence ?? []), ...(phoneReport.evidence ?? [])]);
  const project = ({ observations: _observations, binding: _binding, evidence: _evidence, ...report }) => report;
  const trials = full.plan.schedule.map(slot => {
    const row = observations.get(slotName(slot));
    if (!row) return { ...slot, status: 'NOT_STARTED' };
    const status = row.score ? 'SCORED' : row.business === 'campaign-error' ? 'UNSEALED' : 'UNSCORED';
    const score = row.score ? scoreOf(row.score) : null;
    return { ...slot, status, score,
      ...(status !== 'UNSEALED' ? { providerRequests: measurement(row.providerRequests), elapsedMs: measurement(row.elapsedMs),
        ...(row.tokens ? { tokens:row.tokens } : {}) } : {}),
      ...(status === 'UNSCORED' ? { businessCompleted: row.business === 'no-result' ? null : row.businessCompleted ?? null,
        completionReason: row.completionReason ?? null, ...(row.gradingFailure ? { gradingFailure: row.gradingFailure } : {}) } : {}),
      ...evidence.get(slotName(slot)) };
  });
  return { kind: 'arkts-paired-cohort-report-v1', status, masterPlanSha256: full.planSha256,
    release: { sourceCommit: release.sourceCommit, packageSha256: release.packageSha256 }, taskCount: full.plan.tasks.length,
    plannedTrials: full.plan.schedule.length, binding, integrity: 'local-durable-receipts',
    shards: { pc: project(pcReport), phones: project(phoneReport) }, trials, ...calculated };
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, ...Object.fromEntries(keys.map(key => [key, { type: 'string' }])) } });
  if (values.help) { console.log(usage); return; }
  assert(keys.every(key => values[key]), usage);
  const options = Object.fromEntries(['master', 'pc', 'phones'].map(key => [key, { directory: values[key], planSha256: values[`${key}-plan-sha256`] }]));
  const release = JSON.parse(await fs.readFile(values.release));
  console.log(JSON.stringify(await summarizeArktsPairedCohort({ ...options, release }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
