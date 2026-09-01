import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "cli.mjs");
const POST_TOOL_USE = path.join(PLUGIN_ROOT, "scripts", "post-tool-use.mjs");

const STAGES = [
  {
    id: "requirements-analysis",
    file: "docs/10-requirements-analysis.md",
    content: "# Requirements analysis\n\n- REQ-001: Import a local document.\n- CONSTRAINT-001: Work offline.\n",
  },
  {
    id: "requirements-breakdown",
    file: "docs/20-requirements-breakdown.md",
    content: "# Requirements breakdown\n\n- SR-001 -> REQ-001: Implement local document import offline.\n",
  },
  {
    id: "code-understanding",
    file: "docs/30-code-understanding.md",
    content: "# Code understanding\n\n- MOD-001 -> SR-001: src/importer.mjs owns file import.\n",
  },
  {
    id: "solution-design",
    file: "docs/40-solution-design.md",
    content: "# Solution design\n\n- DESIGN-001 -> SR-001, MOD-001: Add an offline importer.\n",
  },
  {
    id: "manual-test-design",
    file: "docs/50-manual-test-design.md",
    content: "# Manual test design\n\n- TC-001 -> REQ-001, DESIGN-001: Import a valid local file.\n",
  },
  {
    id: "dt-design",
    file: "docs/60-dt-design.md",
    content: "# DT design\n\n- DT-001 -> DESIGN-001, MOD-001: Verify importer behavior offline.\n",
  },
];

const LINEAR_EDGES = [
  ["requirements-analysis", "requirements-breakdown"],
  ["requirements-breakdown", "code-understanding"],
  ["code-understanding", "solution-design"],
  ["solution-design", "manual-test-design"],
  ["manual-test-design", "dt-design"],
];

const DAG_EDGES = [
  ["requirements-analysis", "requirements-breakdown"],
  ["requirements-breakdown", "code-understanding"],
  ["requirements-breakdown", "solution-design"],
  ["code-understanding", "solution-design"],
  ["solution-design", "manual-test-design"],
  ["requirements-breakdown", "manual-test-design"],
  ["code-understanding", "dt-design"],
  ["solution-design", "dt-design"],
];


async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-corrector-document-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}


async function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}


function workflowConfig(edges, { persist = false } = {}) {
  const artifacts = STAGES.map((stage) => `  - name: ${stage.id}
    stage: ${stage.id}
    patterns:
      - ${stage.file}
    rules:
      enabled: true
      file: empty.rules.yaml
    review:
      enabled: true`).join("\n");
  const renderedEdges = edges.map(([from, to]) => `    - from: ${from}
      to: ${to}
      review:
        enabled: true
        criteria: alignment.reviewer.md`).join("\n");
  return `version: 1
enabledStages:
${STAGES.map((stage) => `  - ${stage.id}`).join("\n")}
artifacts:
${artifacts}
workflow:
  edges:
${renderedEdges}
output:
  persist: ${persist}
  mode: centralized
  directory: .runtime-correction
`;
}


async function createDocumentProject(t, edges, options = {}) {
  const cwd = await workspace(t);
  await writeFile(cwd, ".runtime-corrector/config.yaml", workflowConfig(edges, options));
  await writeFile(cwd, ".runtime-corrector/empty.rules.yaml", "version: 1\nrules: []\n");
  await writeFile(
    cwd,
    ".runtime-corrector/alignment.reviewer.md",
    "# Document traceability\n\nKeep intent, scope, constraints, decisions, and trace IDs aligned.\n",
  );
  return cwd;
}


function runCli(cwd, ...args) {
  return spawnSync(
    process.execPath,
    [CLI, ...args, "--cwd", cwd],
    { cwd, encoding: "utf8", windowsHide: true },
  );
}


function hookInput(cwd, filePath) {
  return {
    session_id: "document-e2e-parent",
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath },
    tool_response: { success: true },
    tool_use_id: "toolu-document-e2e",
  };
}


async function createFakeClaudeShim(cwd) {
  return writeFile(cwd, "fake-claude-preload.cjs", String.raw`
const fs = require("node:fs");
const path = require("node:path");

const prompt = process.argv[1] || "";
if (prompt.includes("runtime-corrector:semantic-review --request ")) {
  const requestMatch = prompt.match(/--request "([^"]+)"/);
  if (!requestMatch) {
    process.stderr.write("missing request path");
    process.exit(2);
  }
  const requestPath = path.resolve(process.cwd(), requestMatch[1]);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_CAPTURE,
    JSON.stringify({ argv: process.argv.slice(1), request }) + "\n",
    "utf8",
  );
  process.stdout.write(JSON.stringify({
    session_id: "document-e2e-fork",
    structured_output: JSON.parse(process.env.FAKE_CLAUDE_REVIEW),
  }));
  process.exit(0);
}
`);
}


async function runHook(cwd, filePath, review, captureName) {
  const shimPath = await createFakeClaudeShim(cwd);
  const capturePath = path.join(cwd, `${captureName}.jsonl`);
  const completed = spawnSync(
    process.execPath,
    [POST_TOOL_USE],
    {
      cwd,
      input: JSON.stringify(hookInput(cwd, filePath)),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        RUNTIME_CORRECTOR_CLAUDE_EXECUTABLE: process.execPath,
        NODE_OPTIONS: `--require=${shimPath.replaceAll("\\", "/")}`,
        FAKE_CLAUDE_CAPTURE: capturePath,
        FAKE_CLAUDE_REVIEW: JSON.stringify(review),
      },
    },
  );
  let captures = [];
  try {
    captures = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { completed, captures };
}


async function findNamedFiles(root, filename) {
  const matches = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === filename) matches.push(candidate);
    }
  }
  await visit(root);
  return matches;
}


const ALIGNED_REVIEW = {
  summary: "The generated document is aligned with its direct predecessors.",
  findings: [],
  edits: [],
};


test("YAML-defined document stages form a linear generation and alignment chain", async (t) => {
  const cwd = await createDocumentProject(t, LINEAR_EDGES);
  const stages = runCli(cwd, "stages", "--format", "json");
  assert.equal(stages.status, 0, stages.stderr);
  assert.deepEqual(
    JSON.parse(stages.stdout).stages.map((stage) => [stage.stage, stage.enabled]),
    STAGES.map((stage) => [stage.id, true]),
  );

  for (let index = 0; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    const targetPath = await writeFile(cwd, stage.file, stage.content);
    const { completed, captures } = await runHook(
      cwd,
      targetPath,
      ALIGNED_REVIEW,
      `linear-${index}`,
    );

    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(captures.length, 1, `${stage.id} must create exactly one review fork`);
    assert.ok(captures[0].argv.includes("--fork-session"));
    const request = captures[0].request;
    assert.equal(request.stage, stage.id);
    if (index === 0) {
      assert.equal(Object.hasOwn(request, "workflow"), false);
      assert.deepEqual(request.artifactFiles, [stage.file]);
      continue;
    }
    const predecessor = STAGES[index - 1];
    assert.equal(request.workflow.nodeId, stage.id);
    assert.deepEqual(request.workflow.editableArtifactFiles, [stage.file]);
    assert.deepEqual(request.workflow.incomingEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      sourceFiles: edge.sourceFiles,
      targetFiles: edge.targetFiles,
      reviewer: edge.reviewer?.path,
    })), [{
      from: predecessor.id,
      to: stage.id,
      sourceFiles: [predecessor.file],
      targetFiles: [stage.file],
      reviewer: ".runtime-corrector/alignment.reviewer.md",
    }]);
    assert.deepEqual(request.artifactFiles, [stage.file, predecessor.file]);
    if (index > 1) {
      assert.equal(
        request.artifactFiles.includes(STAGES[index - 2].file),
        false,
        "transitive ancestors must not be read unless an edge names them",
      );
    }
  }
});


test("DAG generation preserves explicit fan-in order and cross-level alignment", async (t) => {
  const cwd = await createDocumentProject(t, DAG_EDGES);
  const paths = new Map();
  for (const stage of STAGES) {
    paths.set(stage.id, await writeFile(cwd, stage.file, stage.content));
  }

  const expectations = [
    {
      target: "solution-design",
      sources: ["requirements-breakdown", "code-understanding"],
      excluded: ["requirements-analysis", "manual-test-design", "dt-design"],
    },
    {
      target: "manual-test-design",
      sources: ["solution-design", "requirements-breakdown"],
      excluded: ["requirements-analysis", "code-understanding", "dt-design"],
    },
    {
      target: "dt-design",
      sources: ["code-understanding", "solution-design"],
      excluded: ["requirements-analysis", "requirements-breakdown", "manual-test-design"],
    },
  ];

  for (const [index, expectation] of expectations.entries()) {
    const target = STAGES.find((stage) => stage.id === expectation.target);
    const { completed, captures } = await runHook(
      cwd,
      paths.get(target.id),
      ALIGNED_REVIEW,
      `dag-${index}`,
    );
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(captures.length, 1, `${target.id} fan-in must use one review fork`);
    const request = captures[0].request;
    assert.deepEqual(
      request.workflow.incomingEdges.map((edge) => edge.from),
      expectation.sources,
      "incoming edges must retain YAML order",
    );
    assert.deepEqual(
      request.workflow.incomingEdges.map((edge) => edge.sourceFiles),
      expectation.sources.map((sourceId) => [
        STAGES.find((stage) => stage.id === sourceId).file,
      ]),
    );
    assert.deepEqual(request.workflow.editableArtifactFiles, [target.file]);
    assert.deepEqual(request.artifactFiles, [
      target.file,
      ...expectation.sources.map(
        (sourceId) => STAGES.find((stage) => stage.id === sourceId).file,
      ),
    ]);
    for (const excludedId of expectation.excluded) {
      const excluded = STAGES.find((stage) => stage.id === excludedId);
      assert.equal(request.artifactFiles.includes(excluded.file), false);
    }
  }
});


test("DAG generation reviews available input while an unfinished branch stays pending", async (t) => {
  const cwd = await createDocumentProject(t, DAG_EDGES);
  await writeFile(cwd, STAGES[0].file, STAGES[0].content);
  await writeFile(cwd, STAGES[1].file, STAGES[1].content);
  const solution = STAGES.find((stage) => stage.id === "solution-design");
  const solutionPath = await writeFile(cwd, solution.file, solution.content);

  const { completed, captures } = await runHook(
    cwd,
    solutionPath,
    ALIGNED_REVIEW,
    "dag-partial-fan-in",
  );

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(captures.length, 1);
  const request = captures[0].request;
  assert.equal(request.deterministicStatus, "pending");
  assert.equal(request.bundleComplete, false);
  assert.deepEqual(
    request.workflow.incomingEdges.map((edge) => [
      edge.from,
      edge.status,
      edge.sourceFiles,
    ]),
    [
      ["requirements-breakdown", "ready", [STAGES[1].file]],
      ["code-understanding", "pending", []],
    ],
  );
  assert.deepEqual(request.artifactFiles, [solution.file, STAGES[1].file]);
  assert.deepEqual(request.workflow.editableArtifactFiles, [solution.file]);
  assert.equal(
    request.deterministicDiagnostics.at(-1).ruleId,
    "WORKFLOW-EDGE-SOURCE-MISSING",
  );
});


test("DAG edge finding proposes a target-only correction patch", async (t) => {
  const cwd = await createDocumentProject(t, DAG_EDGES, { persist: true });
  for (const stage of STAGES.slice(0, 3)) {
    await writeFile(cwd, stage.file, stage.content);
  }
  const solution = STAGES.find((stage) => stage.id === "solution-design");
  const solutionPath = await writeFile(
    cwd,
    solution.file,
    "# Solution design\n\n- DESIGN-001: Add a network importer.\n",
  );
  const review = {
    summary: "The solution drops offline scope and traceability.",
    findings: [{
      ruleId: "AGENT-EDGE-REQUIREMENTS-BREAKDOWN-TO-SOLUTION-DESIGN-TRACE",
      severity: "error",
      path: solution.file,
      line: 3,
      message: "The design is not traced to SR-001 and contradicts the offline constraint.",
      evidence: [
        "docs/20-requirements-breakdown.md: SR-001 requires offline import",
        "docs/30-code-understanding.md: MOD-001 owns file import",
      ],
    }],
    edits: [{
      target: solution.file,
      operations: [{
        type: "replace-line",
        line: 3,
        expect: "- DESIGN-001: Add a network importer.",
        replacement: "- DESIGN-001 -> SR-001: Add an offline importer.",
      }],
    }],
  };

  const { completed, captures } = await runHook(
    cwd,
    solutionPath,
    review,
    "dag-target-correction",
  );

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(captures.length, 1);
  assert.deepEqual(
    captures[0].request.workflow.incomingEdges.map((edge) => edge.from),
    ["requirements-breakdown", "code-understanding"],
  );
  assert.deepEqual(captures[0].request.workflow.editableArtifactFiles, [solution.file]);
  const patches = await findNamedFiles(
    path.join(cwd, ".runtime-correction", "latest"),
    "patch.diff",
  );
  assert.equal(patches.length, 1);
  const patch = await fs.readFile(patches[0], "utf8");
  assert.match(patch, /^--- a\/docs\/40-solution-design\.md$/m);
  assert.match(patch, /^\+- DESIGN-001 -> SR-001: Add an offline importer\.$/m);
  assert.doesNotMatch(
    patch,
    /10-requirements-analysis|20-requirements-breakdown|30-code-understanding/,
  );
  assert.equal(
    await fs.readFile(solutionPath, "utf8"),
    "# Solution design\n\n- DESIGN-001: Add a network importer.\n",
    "runtime corrector must not apply its candidate patch",
  );
});
