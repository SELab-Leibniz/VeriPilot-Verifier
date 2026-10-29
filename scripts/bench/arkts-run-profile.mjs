// Experiment limits are explicit; a short outer watchdog must not truncate
// later review, repair, or re-review phases.
export function arktsRunProfile(value, { hostNoTimeout = false } = {}) {
  if (hostNoTimeout && value === undefined) throw new Error('--host-no-timeout requires explicit RC phase limits.');
  if (value === undefined) return { explicit: false, mainTimeoutMs: 600000, totalTimeoutMs: 960000,
    privateTimeoutMs: 180000, assessmentTimeoutMs: 210000, feedbackReserveMs: 30000,
    setupTimeoutMs: 240000, checkTimeoutMs: 180000 };
  const phaseTimeoutMs = Number(value);
  if (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs < 1000 || phaseTimeoutMs > 3600000
    || phaseTimeoutMs % 1000 !== 0) throw new Error('--phase-timeout-ms must be whole seconds between 1000 and 3600000 milliseconds.');
  return { explicit: true, hostNoTimeout, phaseTimeoutMs, mainTimeoutMs: hostNoTimeout ? 0 : phaseTimeoutMs, privateTimeoutMs: phaseTimeoutMs,
    assessmentTimeoutMs: phaseTimeoutMs, feedbackReserveMs: Math.min(30000, Math.floor(phaseTimeoutMs / 10)),
    setupTimeoutMs: phaseTimeoutMs, checkTimeoutMs: phaseTimeoutMs,
    // Original + correction: each gets its own business, terminal, and Stop
    // window. This is an emergency whole-flow watchdog, not a phase cutoff.
    totalTimeoutMs: hostNoTimeout ? null : phaseTimeoutMs * 6 + 60000 };
}

export function renderArktsRunConfig(model, profile) {
  if (!/^[a-zA-Z0-9._/-]+$/u.test(model)) throw new Error('Invalid benchmark model identity.');
  return `version: 2
artifacts: []
dynamicGroundTruth:
  enabled: true
  materialRoots: []
  panel:
    size: 0
skillCorrection:
  enabled: false
artifactCorrection:
  groundTruthReviewEnabled: false
implementationCorrection:
  enabled: false
${profile.explicit ? `  deviceBudgetMs: ${profile.phaseTimeoutMs}\n` : ''}stopCorrection:
  enabled: true
  waitMode: until_pass
  maxCorrectionsPerSession: 1
  maxCorrectionsPerFlow: 1
  assessmentTimeoutMs: ${profile.assessmentTimeoutMs}
  feedbackReserveMs: ${profile.feedbackReserveMs}
reviewers:
  defaults:
    model: anthropic/${model}
    effort: low
    timeoutMs: ${profile.privateTimeoutMs}
    maxOutputTokens: 32768
${profile.explicit ? `limits:\n  semanticReviewTimeoutMs: ${profile.phaseTimeoutMs}\n` : ''}`;
}
