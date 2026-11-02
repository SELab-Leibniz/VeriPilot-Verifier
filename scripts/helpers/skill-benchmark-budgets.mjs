import { resolveReviewTimeoutMs } from '../../lib/review-timeout.mjs';

export function skillBenchmarkBudgets(wallMs = 86400000, maxSteps = 2000) {
  wallMs = resolveReviewTimeoutMs(Number(wallMs), '--timeout-ms');
  if (wallMs < 2000 || wallMs % 1000) throw new Error('Use a whole number of seconds, at least 2000 ms.');
  maxSteps = Number(maxSteps);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps must be a positive safe integer.');
  return Object.freeze({ wallMs, maxSteps, phaseTimeoutMs: wallMs, assessmentTimeoutMs: wallMs,
    feedbackReserveMs: Math.min(30000, Math.floor(wallMs / 10)), reviewerTimeoutMs: wallMs });
}

export function skillBenchmarkPolicy({ wallMs = 86400000, maxSteps = 2000, model = 'glm-5.3-flash' } = {}) {
  const b = skillBenchmarkBudgets(wallMs, maxSteps);
  return `version: 2
enabled: true
sessionDefaults:
  enabled: true
locale: en
artifacts: []
dynamicGroundTruth:
  enabled: false
skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [bench-task-contract]
  skillRoots: [.rc-bench/skills]
  completionCheckIntervalTurns: ${b.maxSteps}
  maxWatchTurns: ${b.maxSteps}
  maxFeedbacksPerSkill: ${b.maxSteps}
artifactCorrection:
  groundTruthReviewEnabled: false
  stageMetricsEnabled: false
implementationCorrection:
  enabled: false
stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: ${b.maxSteps}
  maxCorrectionsPerFlow: ${b.maxSteps}
  assessmentTimeoutMs: ${b.assessmentTimeoutMs}
  feedbackReserveMs: ${b.feedbackReserveMs}
  fileQualityReviewEnabled: false
  metrics:
${Array.from({ length: 16 }, (_, i) => `    M${String(i + 1).padStart(2, '0')}: ${i === 7}`).join('\n')}
reviewers:
  defaults:
    model: openai/${model}
    effort: low
    timeoutMs: ${b.reviewerTimeoutMs}
    maxSteps: ${b.maxSteps}
    maxAttempts: ${b.maxSteps}
    formatRepairAttempts: ${b.maxSteps}
    maxOutputTokens: 32768
`;
}
