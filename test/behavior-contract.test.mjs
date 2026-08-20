import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "../lib/json-schema-validator.mjs";
import { DEFAULT_RULE_TYPE_REGISTRY } from "../lib/default-runtime.mjs";
import { RuleTypeRegistry } from "../lib/rules/registry.mjs";
import {
  createArtifactDiagnoser,
  matchArtifact,
  mergeSemanticReview,
} from "../lib/runtime-corrector.mjs";
import * as runtimeFacade from "../lib/runtime-corrector.mjs";
import { compileRuntimePolicy } from "../lib/policy/compiler.mjs";
import {
  loadProjectPolicySource,
} from "../lib/policy/project-policy.mjs";
import { loadRuntimePlan } from "../lib/runtime-plan.mjs";
import {
  loadReviewer,
  loadSimpleProjectConfig,
  loadSimpleRules,
} from "../lib/simple-mode.mjs";
import * as simpleModeFacade from "../lib/simple-mode.mjs";
import { loadProjectRules } from "../lib/policy/project-policy.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";
import {
  DEFAULT_STAGE_CATALOG,
  StageCatalog,
  loadStageCatalog,
} from "../lib/stages/catalog.mjs";


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


test("the controlled YAML subset keeps scalar and inline-list semantics", () => {
  assert.deepEqual(parseSimpleYaml(`version: 1
enabled: true
disabled: false
empty: null
word: no
number: 12
values: [one, "two", 3]
`), {
    version: 1,
    enabled: true,
    disabled: false,
    empty: null,
    word: "no",
    number: 12,
    values: ["one", "two", 3],
  });
  assert.throws(
    () => parseSimpleYaml("version:\t1\n", { source: "policy.yaml" }),
    /policy\.yaml:1 不支持 Tab 缩进/,
  );
});


test("JSON Schema diagnostics preserve traversal order and escaped pointers", () => {
  const errors = validateJsonSchema(
    { "a/b": "", extra: true },
    {
      type: "object",
      required: ["missing"],
      properties: {
        "a/b": { type: "string", minLength: 2 },
      },
      additionalProperties: false,
    },
  );
  assert.deepEqual(
    errors.map(({ pointer, keyword }) => [pointer, keyword]),
    [
      ["/missing", "required"],
      ["/a~1b", "minLength"],
      ["/extra", "additionalProperties"],
    ],
  );
});


test("project policies use explicit enabled switches and reject ambiguous empty values", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: requirements
    patterns:
      - requirements.md
    rules:
      enabled: false
      file: rules.yaml
    review:
      enabled: false
      criteria: reviewer.md
`);
  const rulesPath = await writeFile(
    cwd,
    ".runtime-corrector/rules.yaml",
    "version: 1\nrules: []\n",
  );
  const reviewerPath = await writeFile(cwd, ".runtime-corrector/reviewer.md", " \n");

  const config = await loadSimpleProjectConfig(cwd);
  assert.equal(config.artifacts[0].simpleRulesFile, null);
  assert.equal(config.artifacts[0].reviewerFile, null);
  assert.equal(config.artifacts[0].rulesPolicy.enabled, false);
  assert.equal(config.artifacts[0].reviewEnabled, false);
  assert.equal(config.simpleMode.configuredArtifacts, config.configuredArtifacts);
  assert.equal(config.simpleMode.reviewGraph, config.reviewGraph);
  assert.deepEqual(await loadSimpleRules(rulesPath), {
    ids: ["project:rules.yaml"],
    ruleSummaries: [],
    rules: [],
  });
  await assert.rejects(loadReviewer(reviewerPath), /审阅标准.*为空.*review\.enabled: false/);

  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: requirements
    patterns:
      - requirements.md
    rules: null
`);
  await assert.rejects(loadSimpleProjectConfig(cwd), /rules 必须显式配置 enabled/);

  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: requirements
    patterns:
      - requirements.md
    rules: rules.yaml
`);
  await assert.rejects(loadSimpleProjectConfig(cwd), /rules 必须是包含 enabled 的对象/);

  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: requirements
    patterns:
      - requirements.md
    reviewer: reviewer.md
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /reviewer 已停用.*review\.enabled.*review\.criteria/,
  );

  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
artifacts:
  - name: requirements
    patterns:
      - requirements.md
    rules:
      enabled: false
      unexpected: true
`);
  await assert.rejects(
    loadSimpleProjectConfig(cwd),
    /rules\.unexpected.*不允许字段 unexpected/,
  );
});


test("artifact matching remains first-match-wins", async () => {
  const filePath = path.resolve("docs/requirements.md");
  const outcome = await matchArtifact({
    filePath,
    cwd: path.resolve("."),
    config: {
      ignorePatterns: [],
      extensions: {},
      artifacts: [
        {
          stage: "first",
          type: "first",
          format: "markdown",
          patterns: ["docs/*.md"],
        },
        {
          stage: "second",
          type: "second",
          format: "markdown",
          patterns: ["**/requirements.md"],
        },
      ],
    },
  });
  assert.equal(outcome.stage, "first");
  assert.equal(outcome.artifactType, "first");
});


test("semantic review merge keeps result identity and diagnostic precedence", () => {
  const result = {
    status: "passed",
    diagnostics: [],
    diffs: [],
    metadata: {
      triggerFile: "requirements.md",
    },
  };
  const merged = mergeSemanticReview(result, {
    status: "completed",
    parentSessionId: "parent",
    forkSessionId: "fork",
    summary: "reviewed",
    findings: [{
      ruleId: "AGENT-SEMANTIC",
      severity: "warning",
      path: "requirements.md",
      message: "warning",
      evidence: ["evidence"],
    }],
    edits: [],
    diffs: [],
  });
  assert.equal(merged, result);
  assert.equal(result.status, "warning");
  assert.equal(result.agentReview.status, "completed");
});


test("rule providers are selected through the registry contract", async () => {
  const calls = [];
  const registry = new RuleTypeRegistry([{
    type: "example",
    compile: async (rule, context) => calls.push(["compile", rule.id, context.source]),
    evaluate: (rule) => [{ ruleId: rule.id }],
    proposeFixes: (rule) => [{ path: `${rule.id}.md` }],
  }]);

  assert.equal(await registry.compile({ type: "example", id: "R1" }, { source: "rules.yaml" }), true);
  assert.equal(await registry.compile({ type: "unknown" }, {}), false);
  assert.deepEqual(registry.evaluate({ type: "example", id: "R1" }, {}), [{ ruleId: "R1" }]);
  assert.deepEqual(registry.evaluate({ type: "unknown" }, {}), []);
  assert.deepEqual(registry.proposeFixes({ type: "example", id: "R1" }, {}), [{ path: "R1.md" }]);
  assert.deepEqual(registry.proposeFixes({ type: "unknown" }, {}), []);
  assert.deepEqual(calls, [["compile", "R1", "rules.yaml"]]);
  assert.throws(
    () => registry.register({ type: "example" }),
    /规则类型“example”重复注册/,
  );
});


test("project rule compilation depends only on an injected registry", async (t) => {
  const cwd = await workspace(t);
  const rulesPath = await writeFile(cwd, "rules.yaml", `version: 1
rules:
  - id: CUSTOM-RULE
    type: custom-rule
`);
  const calls = [];
  const registry = new RuleTypeRegistry([{
    type: "custom-rule",
    compile(rule, context) {
      calls.push(rule.id);
      context.addRule({
        ...context.base,
        type: rule.type,
        scope: "bundle",
        phase: 100,
      });
    },
  }]);

  const knowledge = await loadProjectRules(rulesPath, registry);

  assert.deepEqual(calls, ["CUSTOM-RULE"]);
  assert.deepEqual(knowledge.rules, [{
    id: "CUSTOM-RULE",
    severity: "error",
    type: "custom-rule",
    scope: "bundle",
    phase: 100,
  }]);
});


test("stage-specific diagnostic IDs remain validated YAML data", async (t) => {
  const cwd = await workspace(t);
  const rulesPath = await writeFile(cwd, "rules.yaml", `version: 1
rules:
  - id: DOCUMENT-OVERVIEW
    type: require-heading
    heading: Overview
    emptyRuleId: 42
`);

  await assert.rejects(
    loadProjectRules(rulesPath, DEFAULT_RULE_TYPE_REGISTRY),
    /emptyRuleId.*非空字符串/,
  );
});


test("artifact diagnosis evaluates validators through an injected registry", () => {
  const registry = new RuleTypeRegistry([{
    type: "custom-rule",
    evaluate(rule, { artifacts }) {
      return [{
        ruleId: rule.id,
        severity: "warning",
        path: artifacts[0].relativePath,
        message: "custom diagnostic",
      }];
    },
  }]);
  const diagnose = createArtifactDiagnoser(registry);
  const result = diagnose({
    artifacts: [{
      path: "/project/target.md",
      relativePath: "target.md",
      content: "# Target\n",
      isTrigger: true,
    }],
    knowledge: {
      ids: ["custom"],
      requiredSections: [{
        id: "LEGACY-HEADING",
        heading: "Required",
        level: 2,
        severity: "warning",
        message: "missing required heading",
      }],
      sectionOrder: [],
      requiredPatterns: [],
      conditionalRequirements: [],
      forbiddenPatterns: [],
      idDeclarationPatterns: [],
      validators: [{ id: "CUSTOM", type: "custom-rule" }],
    },
    stage: "custom",
    artifactType: "document",
    triggerFile: "target.md",
  });

  assert.equal(result.status, "warning");
  assert.deepEqual(result.diagnostics, [
    {
      ruleId: "LEGACY-HEADING",
      severity: "warning",
      path: "target.md",
      message: "missing required heading",
      suggestion: "增加 ## Required 并补充内容。",
    },
    {
      ruleId: "CUSTOM",
      severity: "warning",
      path: "target.md",
      message: "custom diagnostic",
    },
  ]);
});


test("default stage catalog stays business-neutral and preserves generic fallbacks", () => {
  assert.deepEqual(DEFAULT_STAGE_CATALOG.ids(), []);
  assert.equal(DEFAULT_STAGE_CATALOG.outputKeyForArtifactType("planning-bundle"), null);
  assert.equal(DEFAULT_STAGE_CATALOG.outputKeyForArtifactType("custom"), null);
  assert.equal(DEFAULT_STAGE_CATALOG.specificationName("custom"), "custom-stage");
  assert.equal(DEFAULT_STAGE_CATALOG.templateName("custom"), "custom");
  assert.equal(
    DEFAULT_STAGE_CATALOG.initializationMessage("ir"),
    "可以直接加载插件并让 Agent 生成 ir 产物；确定性规则与 Agent reviewer 均位于项目内 .runtime-corrector。",
  );

  const catalog = new StageCatalog([{ id: "custom", template: "custom" }]);
  assert.equal(catalog.get("missing"), null);
  assert.equal(
    catalog.initializationMessage("custom"),
    "可以直接加载插件并让 Agent 生成 custom 产物；确定性规则与 Agent reviewer 均位于项目内 .runtime-corrector。",
  );
});


test("stage metadata is loaded from YAML and compiled into a stage-neutral policy", async (t) => {
  const cwd = await workspace(t);
  const catalogPath = await writeFile(cwd, "stages.yaml", `version: 1
stages:
  - id: custom
    template: custom-template
    specification: custom-spec
artifactOutputKeys:
  custom-bundle: stable-output
`);
  const catalog = await loadStageCatalog({ catalogPath });
  const policy = compileRuntimePolicy({
    artifacts: [{
      name: "custom-node",
      stage: "custom",
      type: "custom-bundle",
      patterns: ["docs/*.md"],
    }],
  }, { stageCatalog: catalog });

  assert.deepEqual(catalog.ids(), ["custom"]);
  assert.equal(catalog.templateName("custom"), "custom-template");
  assert.deepEqual(policy.artifacts[0], {
    name: "custom-node",
    nodeId: "custom-node",
    stage: "custom",
    type: "custom-bundle",
    format: "markdown",
    editable: true,
    patterns: ["docs/*.md"],
    pathMatcher: {
      kind: "glob",
      patterns: ["docs/*.md"],
      scanPatterns: ["docs/*.md"],
    },
    scanPatterns: ["docs/*.md"],
    relatedPatterns: [],
    knowledge: [],
    rulesPolicy: null,
    simpleRulesFile: null,
    reviewEnabled: true,
    reviewerFile: null,
    relatedRoot: "artifact-directory",
    outputKey: "stable-output",
  });
});


test("plugin defaults, stage catalog, and rule baseline share one YAML definition", async () => {
  const runtimePath = new URL("../config/runtime.yaml", import.meta.url);
  const runtimeDefinition = parseSimpleYaml(
    await fs.readFile(runtimePath, "utf8"),
    { source: fileURLToPath(runtimePath) },
  );

  assert.equal(runtimeDefinition.version, 1);
  assert.ok(runtimeDefinition.defaults);
  assert.deepEqual(runtimeDefinition.defaults.artifacts, []);
  assert.deepEqual(runtimeDefinition.stages, []);
  assert.ok(Array.isArray(runtimeDefinition.baselineRules));
  await assert.rejects(
    fs.access(new URL("../config/default.json", import.meta.url)),
    { code: "ENOENT" },
  );
  await assert.rejects(
    fs.access(new URL("../config/stages.yaml", import.meta.url)),
    { code: "ENOENT" },
  );
});


test("runtime plan is the single compiled configuration boundary", async (t) => {
  const cwd = await workspace(t);
  const config = {
    artifacts: [{
      name: "release-notes",
      stage: "release",
      type: "release-notes",
      patterns: ["docs/release.md"],
      outputKey: "release",
    }],
    ignorePatterns: ["**/.generated/**"],
    output: {
      persist: false,
      mode: "centralized",
      directory: ".runtime-correction",
    },
  };

  const direct = await loadRuntimePlan({ cwd, config });
  const compatibleFacade = await runtimeFacade.loadConfig({ cwd, config });

  assert.deepEqual(compatibleFacade, direct);
  assert.equal(direct.configSource, "provided");
  assert.equal(direct.artifacts[0].stage, "release");
  assert.equal(direct.artifacts[0].outputKey, "release");
  assert.deepEqual(direct.configuredArtifacts, direct.artifacts);
  assert.deepEqual(direct.installedStages, ["release"]);
  assert.deepEqual(direct.enabledStages, ["release"]);
  assert.equal(direct.reviewGraph, null);
  assert.equal(direct.configPath, null);
  assert.equal(direct.policyRoot, null);
  assert.deepEqual(direct.ignorePatterns, ["**/.generated/**"]);
});


test("project YAML compiles into the same flat runtime plan", async (t) => {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
enabledStages:
  - target
artifacts:
  - name: source
    patterns:
      - source.md
  - name: target
    patterns:
      - target.md
workflow:
  edges:
    - from: source
      to: target
      review:
        enabled: true
`);

  const plan = await loadRuntimePlan({ cwd });

  assert.equal(plan.configSource, "project-simple");
  assert.deepEqual(plan.artifacts.map(({ nodeId }) => nodeId), ["target"]);
  assert.deepEqual(
    plan.configuredArtifacts.map(({ nodeId }) => nodeId),
    ["source", "target"],
  );
  assert.deepEqual(plan.installedStages, ["source", "target"]);
  assert.deepEqual(plan.enabledStages, ["target"]);
  assert.equal(plan.configPath, path.join(cwd, ".runtime-corrector", "config.yaml"));
  assert.equal(plan.policyRoot, path.join(cwd, ".runtime-corrector"));
  assert.deepEqual(
    plan.reviewGraph.incomingEdges("target").map(({ from }) => from),
    ["source"],
  );
  assert.equal(plan.simpleMode.reviewGraph, plan.reviewGraph);
});


test("project YAML has one semantic compiler and equivalent compatibility output", async (t) => {
  const cwd = await workspace(t);
  const configPath = await writeFile(cwd, ".runtime-corrector/config.yaml", `version: 1
enabledStages:
  - target
artifacts:
  - name: source
    stage: source
    pathTemplates:
      - "spec/{date}-source-{change}.md"
    rules:
      enabled: false
  - name: target
    stage: target
    pathTemplates:
      - "spec/{date}-target-{change}.md"
    review:
      enabled: true
      criteria: reviewers/target.md
workflow:
  correlation:
    keys:
      - change
  edges:
    - from: source
      to: target
      review:
        enabled: false
`);
  await writeFile(cwd, ".runtime-corrector/reviewers/target.md", "# Target\n");

  const source = await loadProjectPolicySource(cwd);
  assert.equal(source.configPath, configPath);
  assert.deepEqual(source.artifacts[0].pathTemplates, [
    "spec/{date}-source-{change}.md",
  ]);
  assert.equal(source.artifacts[0].pathMatcher, undefined);
  assert.equal(source.artifacts[0].rulesPolicy, undefined);
  assert.equal(source.reviewGraph, undefined);
  assert.equal(source.workflowCorrelation, undefined);

  const direct = compileRuntimePolicy(source, { projectPolicy: true });
  const compatible = await loadSimpleProjectConfig(cwd);
  const { simpleMode, ...compatiblePlan } = compatible;

  assert.deepEqual(compatiblePlan, direct);
  assert.equal(simpleMode.configuredArtifacts, compatible.configuredArtifacts);
  assert.equal(simpleMode.reviewGraph, compatible.reviewGraph);
  assert.equal(simpleMode.workflowCorrelation, compatible.workflowCorrelation);
  assert.deepEqual(
    direct.artifacts.map(({ nodeId }) => nodeId),
    ["target"],
  );
  assert.equal(direct.configuredArtifacts[0].pathMatcher.kind, "template");
  assert.deepEqual(direct.workflowCorrelation.keys, ["change"]);
  assert.deepEqual(
    direct.reviewGraph.incomingEdges("target").map(({ from }) => from),
    ["source"],
  );
});


test("configuration-source compatibility is isolated from runtime consumers", async () => {
  const consumers = [
    "../lib/policy/compiler.mjs",
    "../lib/artifact-checker.mjs",
    "../lib/stage-specification.mjs",
    "../scripts/cli.mjs",
  ];
  for (const relativePath of consumers) {
    const contents = await fs.readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(contents, /\.simpleMode\b/, relativePath);
  }

  const adapter = await fs.readFile(
    new URL("../lib/runtime-plan.mjs", import.meta.url),
    "utf8",
  );
  const loader = await fs.readFile(
    new URL("../lib/policy/project-policy.mjs", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /config\.simpleMode/);
  assert.match(loader, /simpleMode:/);
  assert.doesNotMatch(
    loader,
    /compileArtifactPathMatcher|compileReviewGraph|compileWorkflowCorrelation|assertArtifactCorrelationCoverage/,
  );
  assert.match(loader, /compileRuntimePolicy\(source, \{ projectPolicy: true \}\)/);
});


test("legacy mode-shaped programmatic input is adapted at the plan boundary", async (t) => {
  const cwd = await workspace(t);
  const configuredArtifacts = [
    {
      name: "source",
      stage: "source",
      type: "source",
      patterns: ["source.md"],
    },
    {
      name: "target",
      stage: "target",
      type: "target",
      patterns: ["target.md"],
    },
  ];
  const plan = await loadRuntimePlan({
    cwd,
    config: {
      artifacts: [configuredArtifacts[1]],
      simpleMode: {
        configuredArtifacts,
        installedStages: ["source", "target"],
        enabledStages: ["target"],
        reviewGraph: null,
      },
    },
  });

  assert.deepEqual(
    plan.configuredArtifacts.map(({ nodeId }) => nodeId),
    ["source", "target"],
  );
  assert.deepEqual(plan.enabledStages, ["target"]);
  assert.deepEqual(plan.simpleMode.configuredArtifacts, plan.configuredArtifacts);
});


test("runtime service remains a thin composition boundary", async () => {
  const service = await fs.readFile(
    new URL("../lib/runtime-service.mjs", import.meta.url),
    "utf8",
  );

  assert.match(service, /createArtifactChecker/);
  assert.match(service, /createResultFinalizer/);
  assert.match(service, /createHookHandler/);
  assert.doesNotMatch(service, /loadRuntimePlan\s*\(/);
  assert.doesNotMatch(service, /persistResult\s*\(/);
  assert.doesNotMatch(service, /supportedTools/);
  assert.doesNotMatch(service, /WORKFLOW-|RULE-|IR-|PLANNING-/);
});


test("core components do not import or branch on concrete stages", async () => {
  const coreFiles = [
    "../lib/runtime-corrector.mjs",
    "../lib/runtime-service.mjs",
    "../lib/artifact-checker.mjs",
    "../lib/result-finalizer.mjs",
    "../lib/hook-handler.mjs",
    "../lib/policy/config-loader.mjs",
    "../lib/artifact-pipeline.mjs",
    "../lib/policy/compiler.mjs",
    "../lib/policy/project-policy.mjs",
    "../lib/result-processing.mjs",
    "../lib/result-store.mjs",
    "../lib/rules/engine.mjs",
    "../lib/stage-specification.mjs",
    "../lib/stages/catalog.mjs",
  ];
  const concreteProviderImport = /(?:planning-validator|stage-validators|stages\/(?:planning|selection|prd-contract)\/provider)/;
  const concreteStageBranch = /(?:stage|artifactType)\s*===\s*["'](?:ir|planning|selection|prd-contract|planning-bundle)["']/;

  for (const relativePath of coreFiles) {
    const contents = await fs.readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(contents, concreteProviderImport, relativePath);
    assert.doesNotMatch(contents, concreteStageBranch, relativePath);
    if (relativePath.endsWith("result-store.mjs")) {
      assert.doesNotMatch(contents, /stages\/catalog/, relativePath);
    }
  }

  const engine = await fs.readFile(
    new URL("../lib/rules/engine.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    engine,
    /generic-provider|graph-provider|markdown-records-provider|CORE_RULE_TYPE_REGISTRY/,
  );
  assert.doesNotMatch(
    engine,
    /\b(?:ir|planning|selection|prd-contract|planning-bundle)\b/i,
  );

  const genericProvider = await fs.readFile(
    new URL("../lib/rules/generic-provider.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    genericProvider,
    /\b(?:ir|planning|selection|prd-contract|planning-bundle)\b/i,
  );
});


test("legacy knowledge buckets are isolated behind one compatibility adapter", async () => {
  const libRoot = fileURLToPath(new URL("../lib/", import.meta.url));
  const legacyFieldNames = "requiredSections|sectionOrder|requiredPatterns|conditionalRequirements|forbiddenPatterns|idDeclarationPatterns|validators";
  const legacyFields = new RegExp(
    `^\\s*(?:${legacyFieldNames}):|(?:knowledge|merged)\\.(?:${legacyFieldNames})`,
    "m",
  );
  const owners = [];

  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        const contents = await fs.readFile(candidate, "utf8");
        if (legacyFields.test(contents)) {
          owners.push(path.relative(libRoot, candidate).replaceAll("\\", "/"));
        }
      }
    }
  }

  await visit(libRoot);
  assert.deepEqual(owners, ["rules/legacy-knowledge.mjs"]);
});


test("concrete rule providers are composed from one default runtime module", async () => {
  const libRoot = new URL("../lib/", import.meta.url);
  const candidates = [];

  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) candidates.push(candidate);
    }
  }

  await visit(fileURLToPath(libRoot));
  const importers = [];
  for (const candidate of candidates) {
    const contents = await fs.readFile(candidate, "utf8");
    if (contents.includes("rules/default-registry.mjs")) {
      importers.push(path.relative(fileURLToPath(libRoot), candidate).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(importers, ["default-runtime.mjs"]);
});


test("the default registry exposes only stage-neutral rule types", () => {
  assert.equal(DEFAULT_RULE_TYPE_REGISTRY.get("planning-bundle"), null);
  assert.equal(DEFAULT_RULE_TYPE_REGISTRY.get("relation-graph"), null);
  assert.equal(DEFAULT_RULE_TYPE_REGISTRY.get("selection-kit-map"), null);
  for (const type of [
    "pilot-plan",
    "planning-consistency",
    "prd-contract",
  ]) {
    assert.equal(DEFAULT_RULE_TYPE_REGISTRY.get(type), null, type);
  }
  for (const type of [
    "require-artifacts",
    "json-schema",
    "file-digest-manifest",
    "graph-invariants",
    "markdown-records",
  ]) {
    assert.ok(DEFAULT_RULE_TYPE_REGISTRY.get(type), type);
  }
});


test("graph invariants are stage-neutral and configured entirely by YAML", async (t) => {
  const cwd = await workspace(t);
  const rulesPath = await writeFile(cwd, "graph.rules.yaml", `version: 1
rules:
  - id: SERVICE-GRAPH
    type: graph-invariants
    artifact: topology.json
    nodes:
      pointer: /components
      idField: key
      typeField: kind
      typeRules:
        - id: TASK-TYPE
          idPattern: "^T"
          expectedType: task
    edges:
      pointer: /links
      fromField: source
      toField: target
      typeField: relation
      endpointRules:
        - id: DEPENDENCY-ENDPOINTS
          edgeType: depends
          fromType: task
          toType: service
      acyclic:
        - id: DEPENDENCY-CYCLE
          types: [depends]
`);
  const knowledge = await loadProjectRules(rulesPath, DEFAULT_RULE_TYPE_REGISTRY);
  const diagnose = createArtifactDiagnoser(DEFAULT_RULE_TYPE_REGISTRY);
  const result = diagnose({
    artifacts: [{
      path: path.join(cwd, "topology.json"),
      relativePath: "topology.json",
      content: JSON.stringify({
        components: [
          { key: "T1", kind: "service" },
          { key: "S1", kind: "service" },
          { key: "S1", kind: "service" },
        ],
        links: [
          { source: "T1", target: "S1", relation: "depends" },
          { source: "T1", target: "S1", relation: "depends" },
          { source: "S1", target: "T1", relation: "depends" },
          { source: "T2", target: "S1", relation: "depends" },
        ],
      }),
      isTrigger: true,
    }],
    knowledge,
    stage: "service-topology",
    artifactType: "topology",
    triggerFile: "topology.json",
  });

  assert.equal(result.status, "failed");
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-TASK-TYPE"));
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-RELATION-NODE-DUPLICATE"));
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-RELATION-EDGE-DUPLICATE"));
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-RELATION-EDGE-REFERENCE"));
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-DEPENDENCY-ENDPOINTS"));
  assert.ok(result.diagnostics.some((item) => item.ruleId === "SERVICE-GRAPH-DEPENDENCY-CYCLE"));
});


test("Markdown records are stage-neutral and configured entirely by YAML", async (t) => {
  const cwd = await workspace(t);
  const rulesPath = await writeFile(cwd, "release.rules.yaml", `version: 1
rules:
  - id: RELEASE-RECORDS
    type: markdown-records
    artifact: release.md
    recordLabel: change
    placeholderPattern: '\\bTBD\\b'
    bareFields:
      - id: STATUS
        labels: [Status]
    records:
      headingPattern: '^##\\s+(C[-_\\s]*\\d+)\\b'
      idPattern: '^C[-_\\s]*(\\d+)$'
      idReplacement: 'C-$1'
      emptyId: EMPTY
      missingId: MISSING
      unexpectedId: UNEXPECTED
      expected:
        - artifact: catalog.json
          pointer: /items
          idField: key
          where:
            field: kind
            equals: change
      fields:
        - id: OWNER
          labels: [Owner]
        - id: STATE
          labels: [State]
          requiredPattern: '^ready$'
          invalidId: STATE-VALUE
`);
  const knowledge = await loadProjectRules(rulesPath, DEFAULT_RULE_TYPE_REGISTRY);
  const diagnose = createArtifactDiagnoser(DEFAULT_RULE_TYPE_REGISTRY);
  const result = diagnose({
    artifacts: [{
      path: path.join(cwd, "release.md"),
      relativePath: "release.md",
      content: "- Status: ready\n\n## C_1\n\n- Owner: TBD\n- State: blocked\n\n## C-3\n\n- Owner: team\n",
      isTrigger: true,
    }, {
      path: path.join(cwd, "catalog.json"),
      relativePath: "catalog.json",
      content: JSON.stringify({
        items: [
          { key: "C-1", kind: "change" },
          { key: "C-2", kind: "change" },
        ],
      }),
      isTrigger: false,
    }],
    knowledge,
    stage: "release-notes",
    artifactType: "release-notes",
    triggerFile: "release.md",
  });

  for (const ruleId of [
    "RELEASE-RECORDS-PLACEHOLDER",
    "RELEASE-RECORDS-STATUS",
    "RELEASE-RECORDS-OWNER",
    "RELEASE-RECORDS-STATE-VALUE",
    "RELEASE-RECORDS-MISSING",
    "RELEASE-RECORDS-UNEXPECTED",
  ]) {
    assert.ok(result.diagnostics.some((item) => item.ruleId === ruleId), ruleId);
  }
  assert.equal(result.diffs.length, 1);
  assert.match(result.diffs[0].unifiedDiff, /^\+Status: ready$/m);
});


test("compatibility facades keep their existing named exports", () => {
  for (const name of [
    "checkArtifact",
    "collectArtifactPaths",
    "diagnoseArtifacts",
    "finalizeArtifactCheck",
    "findPolicyRootForFile",
    "formatAgentFeedback",
    "globToRegExp",
    "handleHook",
    "loadConfig",
    "loadKnowledge",
    "matchArtifact",
    "matchesAny",
    "mergeSemanticReview",
    "persistResult",
    "readArtifacts",
    "transcriptHasPublicCommandContext",
  ]) {
    assert.equal(typeof runtimeFacade[name], "function", name);
  }
  for (const name of [
    "assertStageName",
    "loadReviewer",
    "loadSimpleProjectConfig",
    "loadSimpleRules",
  ]) {
    assert.equal(typeof simpleModeFacade[name], "function", name);
  }
});
