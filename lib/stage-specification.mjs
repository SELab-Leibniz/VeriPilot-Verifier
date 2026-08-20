import { promises as fs } from "node:fs";
import path from "node:path";

import { loadReviewer } from "./policy/reviewer-loader.mjs";
import { EDGE_REVIEW_BASELINE } from "./review-graph.mjs";
import { DEFAULT_STAGE_CATALOG } from "./stages/catalog.mjs";


function displayPath(filePath, cwd) {
  if (!filePath) return null;
  const relative = path.relative(cwd, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? filePath.replaceAll("\\", "/") : relative;
}


async function readText(filePath) {
  return (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
}


function stageArtifacts(config, stage) {
  return config.configuredArtifacts.filter((artifact) => artifact.stage === stage);
}


export async function buildStageSpecification({
  stage,
  cwd,
  pluginRoot,
  config,
  stageCatalog = DEFAULT_STAGE_CATALOG,
  loadRules,
}) {
  const artifacts = stageArtifacts(config, stage);
  if (artifacts.length === 0) throw new Error(`当前策略没有声明 ${stage} stage。`);

  const globalSpecificationName = stageCatalog.specificationName(stage);
  const globalPath = path.join(pluginRoot, "specs", `${globalSpecificationName}.md`);
  const globalContent = await readText(globalPath);
  const criteria = [];
  for (const artifact of artifacts) {
    let rules = null;
    const schemas = [];
    if (artifact.rulesPolicy?.enabled !== false && artifact.simpleRulesFile) {
      if (typeof loadRules !== "function") {
        throw new Error("构建 Stage 规范需要显式提供规则加载器。");
      }
      const knowledge = await loadRules(artifact.simpleRulesFile);
      rules = {
        path: displayPath(artifact.simpleRulesFile, cwd),
        content: await readText(artifact.simpleRulesFile),
      };
      const schemaPaths = [...new Set(
        knowledge.rules.map((rule) => rule.schemaPath).filter(Boolean),
      )];
      for (const schemaPath of schemaPaths) {
        schemas.push({
          path: displayPath(schemaPath, cwd),
          content: await readText(schemaPath),
        });
      }
    }
    const loadedReviewer = artifact.reviewEnabled !== false
      ? await loadReviewer(
          artifact.reviewerFile,
          config.limits.maxReviewerChars,
        )
      : null;
    const reviewer = loadedReviewer
      ? {
          path: displayPath(loadedReviewer.path, cwd),
          content: loadedReviewer.criteria,
        }
      : null;
    const incomingEdges = config.reviewGraph?.incomingEdges(artifact.nodeId) ?? [];
    const workflow = incomingEdges.length > 0 || config.workflowCorrelation
      ? {
          nodeId: artifact.nodeId,
          baseline: EDGE_REVIEW_BASELINE,
          correlation: config.workflowCorrelation
            ? {
                keys: [...config.workflowCorrelation.keys],
                selection: "derive the instance from the trigger path and include only matching artifact instances",
              }
            : null,
          incomingEdges: await Promise.all(incomingEdges.map(async (edge) => {
            const edgeReviewer = edge.reviewEnabled
              ? await loadReviewer(
                  edge.reviewerFile,
                  config.limits.maxReviewerChars,
                )
              : null;
            return {
              from: edge.from,
              to: edge.to,
              enabled: edge.reviewEnabled,
              reviewer: edgeReviewer
                ? {
                    path: displayPath(edgeReviewer.path, cwd),
                    content: edgeReviewer.criteria,
                  }
                : null,
            };
          })),
        }
      : null;
    criteria.push({
      artifact: {
        type: artifact.type,
        format: artifact.format,
        editable: artifact.editable !== false,
        patterns: artifact.patterns ?? [],
        pathTemplates: artifact.pathTemplates ?? [],
        relatedPatterns: artifact.relatedPatterns ?? [],
        relatedRoot: artifact.relatedRoot ?? "artifact-directory",
      },
      rulesEnabled: artifact.rulesPolicy?.enabled !== false,
      reviewEnabled: artifact.reviewEnabled !== false,
      rules,
      schemas,
      reviewer,
      ...(workflow ? { workflow } : {}),
    });
  }

  const enabledStages = config.enabledStages;
  return {
    version: 1,
    stage,
    authority: "plugin-global specification + active project policy",
    stageEnabled: enabledStages.includes(stage),
    config: {
      source: config.configSource,
      path: displayPath(config.configPath, cwd),
      output: config.output,
      limits: config.limits,
      workflowCorrelation: config.workflowCorrelation,
    },
    recovery: {
      slashCommand: `/runtime-corrector:spec ${stage}`,
      cliCommand: `node \"\${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs\" spec ${stage} --cwd \"$PWD\"`,
    },
    globalSpecification: {
      path: `plugin:specs/${globalSpecificationName}.md`,
      content: globalContent,
    },
    criteria,
  };
}


function fenced(language, content) {
  return ["````" + language, content.trimEnd(), "````"].join("\n");
}


export function formatStageSpecification(specification) {
  const lines = [
    `# Runtime Corrector 完整 Stage 规范：${specification.stage}`,
    "",
    `- Authority: ${specification.authority}`,
    `- Stage enabled: ${specification.stageEnabled}`,
    `- Config source: ${specification.config.source}`,
    `- Config path: ${specification.config.path ?? "plugin/default"}`,
    `- Recovery command: ${specification.recovery.slashCommand}`,
    "",
    specification.globalSpecification.content.trimEnd(),
  ];

  for (const [index, criterion] of specification.criteria.entries()) {
    lines.push(
      "",
      `# 项目实际执行来源 ${index + 1}`,
      "",
      `- Artifact type: ${criterion.artifact.type}`,
      `- Format: ${criterion.artifact.format}`,
      `- Editable: ${criterion.artifact.editable}`,
      `- Patterns: ${criterion.artifact.patterns.join(", ") || "none"}`,
      `- Path templates: ${criterion.artifact.pathTemplates.join(", ") || "none"}`,
      `- Related root: ${criterion.artifact.relatedRoot}`,
      `- Related patterns: ${criterion.artifact.relatedPatterns.join(", ") || "none"}`,
    );
    if (!criterion.rulesEnabled) {
      lines.push("", "## Deterministic rules", "", "Disabled by config (`rules.enabled: false`).");
    } else if (criterion.rules) {
      lines.push("", `## Deterministic rules: ${criterion.rules.path}`, "", fenced("yaml", criterion.rules.content));
    } else {
      lines.push("", "## Deterministic rules", "", "使用插件内置 knowledge；没有项目 rules 文件。");
    }
    for (const schema of criterion.schemas) {
      lines.push("", `## JSON Schema: ${schema.path}`, "", fenced("json", schema.content));
    }
    if (!criterion.reviewEnabled) {
      lines.push("", "## Agent semantic review", "", "Disabled by config (`review.enabled: false`).");
    } else if (criterion.reviewer) {
      lines.push("", `## Agent reviewer: ${criterion.reviewer.path}`, "", criterion.reviewer.content.trimEnd());
    } else {
      lines.push("", "## Agent semantic review", "", "Enabled with the built-in Stage baseline; no project criteria file.");
    }
    if (criterion.workflow) {
      lines.push(
        "",
        `## Workflow incoming edges: ${criterion.workflow.nodeId}`,
        "",
        `- Built-in baseline: ${criterion.workflow.baseline}`,
      );
      if (criterion.workflow.correlation) {
        lines.push(
          `- Correlation keys: ${criterion.workflow.correlation.keys.join(", ")}`,
          `- Instance selection: ${criterion.workflow.correlation.selection}`,
        );
      }
      for (const edge of criterion.workflow.incomingEdges) {
        lines.push("", `### Edge ${edge.from} -> ${edge.to}`, "", `- Enabled: ${edge.enabled}`);
        if (!edge.enabled) {
          lines.push("", "Review: disabled by config.");
        } else if (edge.reviewer) {
          lines.push(
            "",
            `Reviewer: ${edge.reviewer.path}`,
            "",
            edge.reviewer.content.trimEnd(),
          );
        } else {
          lines.push("", "Criteria: none（执行内置一致性基线）");
        }
      }
    }
  }
  lines.push(
    "",
    "# 纠偏恢复规则",
    "",
    "1. 下一次编辑前先通读本规范包，不得从错误短句猜测隐藏格式。",
    "2. 只修改当前 stage 允许修改的产物；上游事实源保持只读。",
    "3. 先处理全部确定性诊断，再按 reviewer 做有证据的语义审阅。",
    "4. Patch 数量为 0 时表示插件无法安全推导语义值，不表示诊断缺失。",
    "5. 修改后重新运行 check，直到 passed、明确转人工或发现真实规范矛盾。",
    "",
  );
  return lines.join("\n");
}
