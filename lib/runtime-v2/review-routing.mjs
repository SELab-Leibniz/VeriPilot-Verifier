// Evidence ownership is per obligation, not just per metric number. M11 is
// always a process check; the production source cannot prove tool history.
import { requiresFreshCliSession } from "./process-checks.mjs";
import { rejectedGroundTruthSource } from "./ground-truth-provenance.mjs";
import { METRIC_CATALOG } from "./metrics.mjs";
import { sha256 } from "./utils.mjs";

export const VERIFICATION_TARGETS = ["ARTIFACT", "PROCESS", "IMPLEMENTATION"];

const stagePhase = stage => ({ REQUIREMENT: 'REQUIREMENTS', PROPOSAL: 'REQUIREMENTS', 需求: 'REQUIREMENTS',
  DESIGN: 'PLANNING', TASKS: 'PLANNING', 设计: 'PLANNING', 规划: 'PLANNING',
  CODING: 'IMPLEMENTATION', CODE: 'IMPLEMENTATION', DEVELOPMENT: 'IMPLEMENTATION', 实现: 'IMPLEMENTATION',
  ACCEPTANCE: 'VERIFICATION', 验证: 'VERIFICATION' }[String(stage).toUpperCase()] ?? String(stage).toUpperCase());

// A stage owns its declared metrics, not the whole task denominator. Original
// claim dependencies are still included separately by reviewScopeClaims.
export function selectStopPopulation(population, classification, artifacts = []) {
  const selection = (metrics, reasonCode) => ({ ...population, metrics,
    scopeSelection: { classification: classification.stopClassification, stage: classification.stage ?? null, reasonCode,
      groundTruthVersion: population.groundTruthVersion,
      fullObjectCount: Object.values(population.metrics).flat().length, selectedObjectCount: Object.values(metrics).flat().length,
      metrics: Object.fromEntries(Object.entries(population.metrics).map(([id, objects]) => [id, {
        enabled: population.reviewPolicy?.metrics?.[id] !== false, available: objects.length, selected: metrics[id]?.length ?? 0,
        objects: objects.map(object => ({ objectId: object.objectId, sourceId: object.sourceId, description: object.description,
          ...(object.verificationTarget !== undefined ? { verificationTarget: object.verificationTarget } : {}),
          selected: metrics[id]?.some(row => row.objectId === object.objectId) ?? false })),
      }])) } });
  if (classification.stopClassification === 'TASK_COMPLETE') return selection(population.metrics,
    Object.values(population.metrics).flat().length ? 'TASK_SCOPE' : 'NO_APPLICABLE_METRIC_OBJECTS');
  if (classification.stopClassification !== 'STAGE_COMPLETE') return selection(
    Object.fromEntries(Object.keys(population.metrics).map(id => [id, []])), 'FINDINGS_ONLY_SCOPE');
  if (!classification.stage?.trim()) throw Object.assign(new Error('A stage review requires a frozen stage'), { code: 'STOP_STAGE_SCOPE_INVALID' });
  const declarations = artifacts.filter(artifact => artifact.stage === classification.stage);
  const phase = stagePhase(classification.stage);
  const metricIds = new Set(declarations.length ? declarations.flatMap(artifact => artifact.metrics ?? [])
    : Object.entries(METRIC_CATALOG).filter(([, metric]) => metric.earliestPhase === phase).map(([id]) => id));
  if (!metricIds.size && !declarations.length) throw Object.assign(new Error('No frozen metric scope is defined for this stage'), { code: 'STOP_STAGE_SCOPE_INVALID' });
  const metrics = Object.fromEntries(Object.entries(population.metrics).map(([id, objects]) => [id,
    metricIds.has(id) ? objects.filter(object => !object.stage || object.stage === classification.stage) : []]));
  return { ...selection(metrics, !metricIds.size ? 'STOP_STAGE_METRICS_UNDECLARED'
    : Object.values(metrics).flat().length ? 'STAGE_SCOPE' : 'NO_APPLICABLE_STAGE_OBJECTS'),
    digest: sha256({ population: population.digest, stage: classification.stage, metricIds: [...metricIds] }) };
}

export function eligibleStopStages(groundTruth, stages) {
  const targets = (groundTruth.claims ?? []).filter(claim => claim.status === 'ACTIVE' && claim.severity === 'HARD')
    .map(claim => claim.verificationTarget);
  const implementationOnly = targets.includes('IMPLEMENTATION') && targets.every(target => ['IMPLEMENTATION', 'PROCESS'].includes(target));
  return implementationOnly ? stages.filter(stage => !['REQUIREMENTS', 'PLANNING', 'TEST_DESIGN'].includes(stagePhase(stage))) : stages;
}

export const VERIFICATION_ROUTING_INSTRUCTIONS = [
  'Record expectedFiles on the corresponding claim for every exact file path explicitly required as an output of THIS task, even when it does not yet exist. Keep the path in the claim text and preserve original conditions. Use requirements for explicit file-delivery duties so M12 retains them. Inputs, referenced existing code, example filenames, prohibited outputs, directories, globs, and outputs of future application runs are not task delivery paths. Do not invent paths for unspecified deliverables.',
  "Set verificationTarget on every claim: ARTIFACT for document contents/deliverables, PROCESS for tool usage/session IDs/authoring order, IMPLEMENTATION for application code or runtime behavior. Classify what this task must deliver, not the subject described inside a document.",
  "Each claim must have one kind of evidence owner. When a source statement mixes application/document behavior with actions performed during this task (including preserving other files or running verification), split its supported obligations before assigning targets; a paragraph number or requirements heading does not make all its clauses IMPLEMENTATION. Preserve each obligation's original meaning, scope and mandatory force; do not add rules or turn advice about what is unnecessary into prohibitions.",
  "A docs-only task has ARTIFACT requirements even when its documents describe future application features. Workflow/tool-history claims are PROCESS, never production-source obligations.",
  "For IMPLEMENTATION obligations, set implementationRole=PRODUCTION for shipped application logic, TEST for writing test code, or SUPPORT for supporting non-test implementation. Split writing a test file (IMPLEMENTATION, TEST) from actually running tests (PROCESS) when the original user requires both. Test execution is not proved by the presence of test source. Do not invent acceptance criteria, tests or business journeys absent from the authoritative request.",
  "An explicitly requested execution action, such as running the requested tests, belongs to category requirements with verificationTarget=PROCESS so M12 preserves its execution duty. Use workflowSteps for separately prescribed process or tool procedures, not to hide required execution under an unrelated disabled process metric.",
];

function activeAuthoritative(claim) {
  return claim.status === "ACTIVE" && claim.severity === "HARD"
    && !rejectedGroundTruthSource(claim)
    && ["USER_EXPLICIT", "MATERIAL_DERIVED", "PROJECT_CONSTRAINT"].includes(claim.authority);
}

// Compatibility for ledgers frozen before verificationTarget existed. Only
// an authoritative task-scope exclusion can disable implementation review;
// an assistant's completion report or the absence of source is not enough.
export function artifactOnlyTask(groundTruth) {
  return (groundTruth?.claims ?? []).some((claim) => activeAuthoritative(claim)
    && ["goals", "inScope", "outOfScope", "constraints"].includes(claim.category)
    && /(?:docs?|documents?|artifacts?)[ -]only|(?:no|without|not)\s+(?:implementing\s+)?(?:any\s+)?application\s+code|application\s+code\s+(?:is\s+)?(?:not\s+implemented|out\s+of\s+scope)|不(?:需要|要求)?(?:实现|编写|修改)应用代码|仅(?:验证|审阅|编写|检查).{0,40}(?:文档|OpenSpec)/iu.test(claim.text));
}

export function implementationPopulation(population, { groundTruth = null, stage = null } = {}) {
  const preImplementation = /^(?:requirements?|proposal|design|tasks|planning|test_design|需求|设计|规划)$/iu.test(String(stage ?? ""));
  const docsOnly = artifactOnlyTask(groundTruth);
  const claims = new Map((groundTruth?.claims ?? []).map((claim) => [claim.claimId, claim]));
  const metrics = Object.fromEntries(["M09", "M12", "M16"].map((metricId) => [metricId,
    preImplementation || docsOnly ? [] : (population?.metrics?.[metricId] ?? []).filter((object) => {
      const target = object.verificationTarget ?? claims.get(object.sourceId)?.verificationTarget;
      return target ? target === "IMPLEMENTATION" : !requiresFreshCliSession(object.description ?? "");
    }),
  ]));
  return {
    population: { ...population, metrics },
    skipReason: docsOnly ? "ARTIFACT_ONLY_TASK" : preImplementation ? "PRE_IMPLEMENTATION_STAGE" : null,
  };
}
