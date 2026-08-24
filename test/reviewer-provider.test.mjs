import assert from "node:assert/strict";
import test from "node:test";

import { validateProjectConfig } from "../lib/policy/config-loader.mjs";
import {
  compileRuntimeV2Config,
  CRITICAL_GATE_REVIEWER_ROLES,
  expandReviewerModelPolicy,
} from "../lib/runtime-v2/config.mjs";
import {
  independentReviewerEnvironment,
  resolveReviewerSession,
} from "../lib/runtime-v2/reviewer.mjs";


const PROVIDER = Object.freeze({
  baseUrl: "https://reviewer.example.com",
  apiKeyEnv: "REVIEWER_API_KEY",
  model: "example-reviewer-model",
});


test("schema accepts per-role session/provider and the modelPolicy preset", () => {
  const document = {
    version: 2,
    artifacts: [],
    dynamicGroundTruth: { enabled: true },
    reviewers: {
      stopReviewer: { session: "independent", provider: PROVIDER },
      onboardingAdjudicator: { session: "fork" },
      modelPolicy: { preset: "critical-gates", provider: PROVIDER },
    },
  };
  assert.equal(validateProjectConfig(document, "config.yaml"), document);
  // Provider entries store env-var NAMES only: a raw key field is rejected.
  assert.throws(() => validateProjectConfig({
    ...document,
    reviewers: {
      stopReviewer: {
        session: "independent",
        provider: { baseUrl: "https://x", apiKeyEnv: "K", apiKey: "sk-secret" },
      },
    },
  }, "config.yaml"));
  // detached is a supported mode: a fresh session with ambient credentials,
  // for roles that work from the request payload and need no parent fork.
  assert.doesNotThrow(() => validateProjectConfig({
    ...document,
    reviewers: { stopReviewer: { session: "detached" } },
  }, "config.yaml"));
  assert.throws(() => validateProjectConfig({
    ...document,
    reviewers: { stopReviewer: { session: "sidecar" } },
  }, "config.yaml"));
  assert.throws(() => validateProjectConfig({
    ...document,
    reviewers: { modelPolicy: { preset: "everything", provider: PROVIDER } },
  }, "config.yaml"));
});


test("modelPolicy presets expand to explicit blocks and explicit roles win", () => {
  const expanded = expandReviewerModelPolicy({
    defaults: { effort: "low" },
    stopReviewer: { model: "role-model" },
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
  });
  assert.equal(expanded.modelPolicy, undefined, "the preset never survives expansion");
  for (const role of CRITICAL_GATE_REVIEWER_ROLES) {
    assert.equal(expanded[role].session, "independent");
    assert.equal(expanded[role].provider.apiKeyEnv, "REVIEWER_API_KEY");
  }
  assert.equal(expanded.stopReviewer.model, "role-model", "role keys are merged, not replaced");
  assert.equal(expanded.skillReviewer, undefined, "critical-gates touches only its roles");

  // A role that explicitly declares session or provider is left untouched.
  const explicit = expandReviewerModelPolicy({
    stopReviewer: { session: "fork" },
    modelPolicy: { preset: "critical-gates", provider: PROVIDER },
  });
  assert.equal(explicit.stopReviewer.session, "fork");
  assert.equal(explicit.stopReviewer.provider, undefined);

  // off (default), a missing provider, and unknown presets apply no overlay.
  assert.deepEqual(expandReviewerModelPolicy({ modelPolicy: { preset: "off", provider: PROVIDER } }), {});
  assert.deepEqual(expandReviewerModelPolicy({ modelPolicy: { preset: "critical-gates" } }), {});
  assert.deepEqual(expandReviewerModelPolicy(undefined), {});

  // all covers every reviewer role.
  const all = expandReviewerModelPolicy({ modelPolicy: { preset: "all", provider: PROVIDER } });
  assert.equal(all.groundTruthExtractor.session, "independent");
  assert.equal(all.implementationReviewer.session, "independent");
});


test("compile carries session/provider per role with fork/null defaults", () => {
  const compiled = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true },
    stopCorrection: { enabled: true },
    reviewers: {
      stopReviewer: { session: "independent", provider: PROVIDER },
      // An incomplete provider normalizes to null instead of half-configured.
      skillReviewer: { session: "independent", provider: { baseUrl: " ", apiKeyEnv: "" } },
    },
  });
  assert.equal(compiled.reviewers.stopReviewer.session, "independent");
  assert.deepEqual(compiled.reviewers.stopReviewer.provider, PROVIDER);
  assert.equal(compiled.reviewers.skillReviewer.provider, null);
  assert.equal(compiled.reviewers.groundTruthExtractor.session, "fork");
  assert.equal(compiled.reviewers.groundTruthExtractor.provider, null);

  const preset = compileRuntimeV2Config({
    version: 2,
    dynamicGroundTruth: { enabled: true },
    reviewers: { modelPolicy: { preset: "critical-gates", provider: PROVIDER } },
  });
  assert.equal(preset.reviewers.onboardingAdjudicator.session, "independent");
  assert.equal(preset.reviewers.stopReviewer.session, "independent");
  assert.equal(preset.reviewers.stopReviewer.provider.baseUrl, PROVIDER.baseUrl);
  assert.equal(preset.reviewers.artifactReviewer.session, "fork");
});


test("resolveReviewerSession keys the independent session off the NAMED env var", () => {
  const reviewer = { session: "independent", provider: PROVIDER };

  const active = resolveReviewerSession({
    reviewer,
    env: { REVIEWER_API_KEY: "secret-value" },
  });
  assert.equal(active.session, "independent");
  assert.equal(active.degraded, null);
  assert.deepEqual(active.envOverrides, {
    ANTHROPIC_BASE_URL: "https://reviewer.example.com",
    ANTHROPIC_AUTH_TOKEN: "secret-value",
  });

  // Unset or empty key env var: degrade to fork, reporting the NAME only.
  for (const env of [{}, { REVIEWER_API_KEY: "  " }]) {
    const degraded = resolveReviewerSession({ reviewer, env });
    assert.equal(degraded.session, "fork");
    assert.equal(degraded.envOverrides, null);
    assert.equal(degraded.degraded.reason, "PROVIDER_API_KEY_UNSET");
    assert.equal(degraded.degraded.apiKeyEnv, "REVIEWER_API_KEY");
    assert.ok(!JSON.stringify(degraded).includes("secret"), "no key material in the record");
  }

  // Independent without a usable provider also degrades.
  const unconfigured = resolveReviewerSession({
    reviewer: { session: "independent", provider: null },
    env: { REVIEWER_API_KEY: "secret-value" },
  });
  assert.equal(unconfigured.session, "fork");
  assert.equal(unconfigured.degraded.reason, "PROVIDER_NOT_CONFIGURED");

  // The default fork session never consults the environment.
  const fork = resolveReviewerSession({ reviewer: { session: "fork" }, env: {} });
  assert.deepEqual(fork, { session: "fork", envOverrides: null, degraded: null });
});


test("independent reviewer environment strips every parent credential", () => {
  const spawnEnv = independentReviewerEnvironment({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "parent-key",
    ANTHROPIC_AUTH_TOKEN: "parent-token",
    ANTHROPIC_BASE_URL: "https://parent.example.com",
    CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth",
  }, {
    ANTHROPIC_BASE_URL: "https://reviewer.example.com",
    ANTHROPIC_AUTH_TOKEN: "provider-key",
  });
  assert.equal(spawnEnv.PATH, "/usr/bin");
  assert.equal(spawnEnv.ANTHROPIC_BASE_URL, "https://reviewer.example.com");
  assert.equal(spawnEnv.ANTHROPIC_AUTH_TOKEN, "provider-key");
  assert.equal(spawnEnv.ANTHROPIC_API_KEY, undefined, "the parent API key never travels");
  assert.equal(spawnEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the parent OAuth token never travels");
  assert.ok(!JSON.stringify(spawnEnv).includes("parent-"), "no parent credential survives");
});

test("detached sessions start fresh without a provider, and explicit config still wins", () => {
  // The whole point: freshness without provider credentials. A role that only
  // needs its request payload must not pay to fork a large parent session.
  assert.deepEqual(resolveReviewerSession({ reviewer: { session: "detached" }, env: {} }), {
    session: "detached",
    envOverrides: null,
    degraded: null,
  });
  // independent still requires a provider and degrades to fork without one.
  assert.equal(resolveReviewerSession({ reviewer: { session: "independent" }, env: {} }).session, "fork");
  // Unset stays fork: forking remains the default for parent-context roles.
  assert.equal(resolveReviewerSession({ reviewer: {}, env: {} }).session, "fork");
});
