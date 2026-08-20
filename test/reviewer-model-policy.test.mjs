import assert from "node:assert/strict";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import {
  CRITICAL_GATE_REVIEWER_ROLES,
  compileRuntimeV2Config,
  expandReviewerModelPolicy,
} from "../lib/runtime-v2/config.mjs";
import { resolveReviewerSession } from "../lib/runtime-v2/reviewer.mjs";


const ALL_ROLES = [
  "groundTruthExtractor",
  "onboardingAdjudicator",
  "skillReviewer",
  "artifactReviewer",
  "stopReviewer",
  "implementationReviewer",
];

const PROVIDER = Object.freeze({
  baseUrl: "https://reviewer.example/anthropic",
  apiKeyEnv: "INDEPENDENT_REVIEWER_KEY",
  model: "independent-reviewer-model",
});

function compile(reviewers) {
  return compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true },
    reviewers,
  });
}


test("modelPolicy preset off (or absent) keeps every role on the parent fork", () => {
  for (const reviewers of [undefined, {}, { modelPolicy: { preset: "off", provider: PROVIDER } }]) {
    const compiled = compile(reviewers);
    for (const role of ALL_ROLES) {
      assert.equal(compiled.reviewers[role].session, "fork", `${role} must fork`);
      assert.equal(compiled.reviewers[role].provider, null, `${role} must have no provider`);
    }
  }
});


test("critical-gates applies independent + provider to exactly the two critical gates", () => {
  const compiled = compile({ modelPolicy: { preset: "critical-gates", provider: PROVIDER } });
  assert.deepEqual([...CRITICAL_GATE_REVIEWER_ROLES], ["onboardingAdjudicator", "stopReviewer"]);
  for (const role of ALL_ROLES) {
    const reviewer = compiled.reviewers[role];
    if (CRITICAL_GATE_REVIEWER_ROLES.includes(role)) {
      assert.equal(reviewer.session, "independent", `${role} must be independent`);
      assert.deepEqual({ ...reviewer.provider }, { ...PROVIDER }, `${role} must carry the preset provider`);
    } else {
      assert.equal(reviewer.session, "fork", `${role} must stay on the fork`);
      assert.equal(reviewer.provider, null, `${role} must have no provider`);
    }
  }
});


test("preset all applies independent + provider to every reviewer role", () => {
  const compiled = compile({ modelPolicy: { preset: "all", provider: PROVIDER } });
  for (const role of ALL_ROLES) {
    assert.equal(compiled.reviewers[role].session, "independent", `${role} must be independent`);
    assert.deepEqual({ ...compiled.reviewers[role].provider }, { ...PROVIDER });
  }
});


test("an explicit per-role session or provider always overrides the preset", () => {
  const compiled = compile({
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
    stopReviewer: { session: "fork" },
  });
  assert.equal(compiled.reviewers.stopReviewer.session, "fork");
  assert.equal(compiled.reviewers.stopReviewer.provider, null);
  // The other covered role still receives the preset.
  assert.equal(compiled.reviewers.onboardingAdjudicator.session, "independent");
  assert.deepEqual({ ...compiled.reviewers.onboardingAdjudicator.provider }, { ...PROVIDER });

  // An explicit provider alone also detaches the role from the preset:
  // session was not declared, so the role keeps the fork default.
  const explicitProvider = compile({
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
    stopReviewer: { provider: { baseUrl: "https://other.example", apiKeyEnv: "OTHER_KEY" } },
  });
  assert.equal(explicitProvider.reviewers.stopReviewer.session, "fork");
  assert.equal(explicitProvider.reviewers.stopReviewer.provider.baseUrl, "https://other.example");
  assert.equal(explicitProvider.reviewers.stopReviewer.provider.apiKeyEnv, "OTHER_KEY");
  assert.equal(explicitProvider.reviewers.stopReviewer.provider.model, null);
});


test("preset roles keep their other explicit reviewer limits", () => {
  const compiled = compile({
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
    stopReviewer: { effort: "high", timeoutMs: 1200000 },
  });
  const stop = compiled.reviewers.stopReviewer;
  assert.equal(stop.session, "independent");
  assert.equal(stop.effort, "high");
  assert.equal(stop.timeoutMs, 1200000);
  assert.deepEqual({ ...stop.provider }, { ...PROVIDER });
});


test("expansion materializes explicit per-role blocks and never a bare preset", () => {
  const expanded = expandReviewerModelPolicy({
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
    stopReviewer: { effort: "high" },
    groundTruthExtractor: { effort: "low" },
  });
  // The shorthand itself must not survive materialization.
  assert.equal(Object.hasOwn(expanded, "modelPolicy"), false);
  assert.equal(expanded.onboardingAdjudicator.session, "independent");
  assert.deepEqual({ ...expanded.onboardingAdjudicator.provider }, { ...PROVIDER });
  assert.deepEqual(
    { ...expanded.stopReviewer, provider: { ...expanded.stopReviewer.provider } },
    { effort: "high", session: "independent", provider: { ...PROVIDER } },
  );
  // Roles outside the preset are copied through untouched.
  assert.deepEqual(expanded.groundTruthExtractor, { effort: "low" });
  assert.equal(Object.hasOwn(expanded, "skillReviewer"), false);
});


test("config loading rejects an active preset without a usable provider", () => {
  const base = { version: 2, artifacts: [], dynamicGroundTruth: { enabled: true } };
  assert.throws(
    () => validateProjectConfig({ ...base, reviewers: { modelPolicy: { preset: "critical-gates" } } }, "config.yaml"),
    /modelPolicy\.provider/,
  );
  assert.throws(
    () => validateProjectConfig({
      ...base,
      reviewers: { modelPolicy: { preset: "all", provider: { baseUrl: "", apiKeyEnv: "KEY" } } },
    }, "config.yaml"),
  );
  // Unknown preset values fail the schema enum.
  assert.throws(
    () => validateProjectConfig({
      ...base,
      reviewers: { modelPolicy: { preset: "heterogeneous", provider: PROVIDER } },
    }, "config.yaml"),
  );
  // The valid shorthand and the canonical explicit form both load.
  const shorthand = { ...base, reviewers: { modelPolicy: { preset: "critical-gates", provider: { ...PROVIDER } } } };
  assert.equal(validateProjectConfig(shorthand, "config.yaml"), shorthand);
  const explicit = {
    ...base,
    reviewers: {
      onboardingAdjudicator: { session: "independent", provider: { ...PROVIDER } },
      stopReviewer: { session: "independent", provider: { ...PROVIDER } },
    },
  };
  assert.equal(validateProjectConfig(explicit, "config.yaml"), explicit);
});


test("resolveReviewerSession runs independent only when the named key variable is set", () => {
  const reviewer = { session: "independent", provider: PROVIDER };
  const live = resolveReviewerSession({
    reviewer,
    env: { INDEPENDENT_REVIEWER_KEY: "secret-value" },
  });
  assert.equal(live.session, "independent");
  assert.equal(live.degraded, null);
  assert.deepEqual(live.envOverrides, {
    ANTHROPIC_BASE_URL: PROVIDER.baseUrl,
    ANTHROPIC_AUTH_TOKEN: "secret-value",
  });

  for (const env of [{}, { INDEPENDENT_REVIEWER_KEY: "   " }]) {
    const degraded = resolveReviewerSession({ reviewer, env });
    assert.equal(degraded.session, "fork");
    assert.equal(degraded.envOverrides, null);
    assert.equal(degraded.degraded.reason, "PROVIDER_API_KEY_UNSET");
    // Journaled detail names the variable, never a key value.
    assert.equal(degraded.degraded.apiKeyEnv, "INDEPENDENT_REVIEWER_KEY");
    assert.ok(!JSON.stringify(degraded).includes("secret-value"));
  }

  const noProvider = resolveReviewerSession({ reviewer: { session: "independent" }, env: {} });
  assert.equal(noProvider.session, "fork");
  assert.equal(noProvider.degraded.reason, "PROVIDER_NOT_CONFIGURED");

  const fork = resolveReviewerSession({ reviewer: { session: "fork", provider: PROVIDER }, env: {} });
  assert.deepEqual(fork, { session: "fork", envOverrides: null, degraded: null });
});
