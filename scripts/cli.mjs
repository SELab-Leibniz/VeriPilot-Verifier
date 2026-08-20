#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkArtifact, loadConfig } from "../lib/runtime-corrector.mjs";
import {
  assertStageName,
  loadReviewer,
  loadSimpleProjectConfig,
} from "../lib/policy/project-policy.mjs";
import {
  buildDefaultStageSpecification,
  loadDefaultRules,
} from "../lib/default-runtime.mjs";
import { parseSimpleYaml } from "../lib/simple-yaml.mjs";
import { formatStageSpecification } from "../lib/stage-specification.mjs";
import { EDGE_REVIEW_BASELINE } from "../lib/review-graph.mjs";
import { validateProjectPolicy } from "../lib/policy/validator.mjs";
import {
  deriveConfigDefaults,
  renderMaterializedConfig,
} from "../lib/runtime-v2/derive.mjs";
import { POLICY_ROOT_DIRECTORY } from "../lib/runtime-v2/paths.mjs";


const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


function usage() {
  return [
    "Runtime Corrector",
    "",
    "用法：",
    "  runtime-corrector help [--cwd <directory>]",
    "  runtime-corrector init [--cwd <directory>]",
    "  runtime-corrector validate [--cwd <directory>] [--format json|text]",
    "  runtime-corrector stages [--cwd <directory>] [--format json|text]",
    "  runtime-corrector stage <stage> <on|off> [--cwd <directory>]",
    "  runtime-corrector check <artifact> [--cwd <directory>] [--format json|text]",
    "  runtime-corrector explain <stage> [--cwd <directory>] [--format json|text]",
    "  runtime-corrector spec <stage> [--cwd <directory>] [--format json|text]",
    "",
    "示例：",
    "  runtime-corrector help --cwd C:\\path\\to\\project",
    "  runtime-corrector init --cwd C:\\path\\to\\project",
    "  runtime-corrector validate --cwd C:\\path\\to\\project",
    "  runtime-corrector stages --cwd C:\\path\\to\\project",
    "  runtime-corrector stage <stage> off --cwd C:\\path\\to\\project",
    "  runtime-corrector check <artifact> --format json",
    "  runtime-corrector explain <stage> --cwd C:\\path\\to\\project",
    "  runtime-corrector spec <stage> --cwd C:\\path\\to\\project",
  ].join("\n");
}


function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  if (!new Set(["check", "help", "init", "validate", "explain", "spec", "stages", "stage"]).has(argv[0])) {
    throw new Error(`不支持的命令“${argv[0]}”。`);
  }
  const command = argv[0];
  const positional = [];
  let cwd = process.cwd();
  let format = "text";
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      if (!argv[index + 1]) throw new Error("--cwd 缺少目录参数。");
      cwd = argv[index + 1];
      index += 1;
    } else if (argument === "--format") {
      if (!argv[index + 1]) throw new Error("--format 缺少格式参数。");
      format = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`不支持的选项“${argument}”。`);
    } else {
      positional.push(argument);
    }
  }
  if (!cwd) throw new Error("--cwd 缺少目录参数。");
  const expectedCount = new Set(["help", "init", "validate", "stages"]).has(command)
    ? 0
    : command === "stage"
      ? 2
      : 1;
  if (positional.length !== expectedCount) {
    if (new Set(["help", "init", "validate", "stages"]).has(command)) {
      throw new Error(`${command} 命令不接受位置参数。`);
    }
    if (command === "stage") throw new Error("stage 命令需要 <stage> <on|off>。");
    throw new Error(command === "check" ? "缺少要检查的 artifact 路径。" : "缺少 stage 参数。");
  }
  const subject = positional[0];
  if (new Set(["explain", "spec", "stage"]).has(command)) assertStageName(subject);
  if (new Set(["help", "init"]).has(command) && format !== "text") {
    throw new Error(`${command} 命令不支持 --format。`);
  }
  if (command === "stage" && format !== "text") {
    throw new Error("stage 命令不支持 --format。");
  }
  if (command === "stage" && !new Set(["on", "off"]).has(positional[1])) {
    throw new Error("stage 状态只能是 on 或 off。");
  }
  if (!new Set(["json", "text"]).has(format)) {
    throw new Error("--format 只能是 json 或 text。");
  }
  return {
    command,
    cwd: path.resolve(cwd),
    format,
    ...(command === "check" ? { artifact: subject } : {}),
    ...(["explain", "spec", "stage"].includes(command) ? { stage: subject } : {}),
    ...(command === "stage" ? { enabled: positional[1] === "on" } : {}),
  };
}


async function initializeProjectTemplate({ cwd }) {
  const target = path.join(cwd, POLICY_ROOT_DIRECTORY);
  try {
    await fs.access(target);
    throw new Error(`${target} 已存在；为避免覆盖项目规则，init 不会继续。`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(cwd, { recursive: true });
  const source = path.join(PLUGIN_ROOT, "templates", "project", POLICY_ROOT_DIRECTORY);
  await fs.cp(source, target, { recursive: true, errorOnExist: true });
  // Materialize the derived configuration: run the same derivation the
  // zero-config runtime performs and write it as the project's config.yaml,
  // so the detected task materials and platform are visible and editable
  // instead of implicit. The static v1 reference remains available as
  // config.reference.yaml.
  const derived = await deriveConfigDefaults(cwd);
  await fs.rename(
    path.join(target, "config.yaml"),
    path.join(target, "config.reference.yaml"),
  );
  await fs.writeFile(
    path.join(target, "config.yaml"),
    renderMaterializedConfig(derived),
    "utf8",
  );
  return { target, derived };
}


async function readStageControl(cwd) {
  const configPath = path.join(cwd, POLICY_ROOT_DIRECTORY, "config.yaml");
  let contents;
  try {
    contents = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`尚未初始化 Runtime Corrector：${configPath} 不存在。请先运行 init。`);
    }
    throw error;
  }
  await loadSimpleProjectConfig(cwd);
  const document = parseSimpleYaml(contents, { source: configPath });
  if (!Array.isArray(document.artifacts) || document.artifacts.length === 0) {
    // A materialized version 2 config legitimately has no v1 artifacts yet;
    // stage control simply has nothing to switch.
    return { configPath, contents, installed: [], enabled: [], artifactByStage: new Map() };
  }
  const installed = [...new Set(document.artifacts.map((artifact) => artifact.stage ?? artifact.name))];
  const enabled = document.enabledStages === undefined ? installed : document.enabledStages;
  if (!Array.isArray(enabled)) throw new Error(`${configPath} enabledStages 必须是列表。`);
  const artifactByStage = new Map(document.artifacts.map((artifact) => [artifact.stage ?? artifact.name, artifact]));
  return { configPath, contents, installed, enabled, artifactByStage };
}


function replaceEnabledStages(contents, enabledStages) {
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const rendered = enabledStages.length === 0
    ? ["enabledStages: []"]
    : ["enabledStages:", ...enabledStages.map((stage) => `  - ${stage}`)];
  const start = lines.findIndex((line) => /^enabledStages\s*:/.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s+/.test(lines[end]))) end += 1;
    lines.splice(start, end - start, ...rendered, "");
  } else {
    const version = lines.findIndex((line) => /^version\s*:/.test(line));
    lines.splice(version >= 0 ? version + 1 : 0, 0, "", ...rendered);
  }
  return `${lines.join(eol).replace(new RegExp(`${eol}+$`), "")}${eol}`;
}


async function setStageEnabled({ cwd, stage, enabled }) {
  const control = await readStageControl(cwd);
  if (!control.installed.includes(stage)) {
    throw new Error(`${stage} 尚未安装。已安装：${control.installed.join("、")}。`);
  }
  const selected = new Set(control.enabled);
  if (enabled) selected.add(stage); else selected.delete(stage);
  const nextEnabled = control.installed.filter((candidate) => selected.has(candidate));
  await fs.writeFile(control.configPath, replaceEnabledStages(control.contents, nextEnabled), "utf8");
  return stageStatus({ ...control, enabled: nextEnabled });
}


function stageStatus(control) {
  return {
    config: control.configPath,
    stages: control.installed.map((stage) => {
      const artifact = control.artifactByStage.get(stage);
      return {
        stage,
        enabled: control.enabled.includes(stage),
        rules: artifact?.rules ?? null,
        review: artifact?.review ?? null,
      };
    }),
  };
}


function formatStageStatus(status, cwd) {
  const lines = [
    "[runtime-corrector] 阶段控制",
    `配置：${displayPath(status.config, cwd)}`,
    "",
  ];
  for (const item of status.stages) {
    lines.push(`${item.enabled ? "[on]" : "[off]"} ${item.stage}`);
    lines.push(
      `  硬规则：${item.rules?.enabled ? `on (${item.rules.file})` : "off"}`,
    );
    lines.push(
      `  Agent 审阅：${item.review?.enabled
        ? `on (${item.review.criteria ?? "built-in baseline"})`
        : "off"}`,
    );
  }
  lines.push(
    "",
    "运作顺序：写入命中文件 → 执行硬规则 → 隔离执行 Agent 审阅 → 校验候选 Diff → 主 Agent 决定最小修正 → 记录诊断。",
    "开关阶段：runtime-corrector stage <stage> <on|off>",
    "修改规则：编辑对应 *.rules.yaml；修改语义审阅：编辑对应 *.reviewer.md。下一次写入立即生效。",
    "项目内说明：.runtime-corrector/README.md",
  );
  return lines.join("\n");
}


async function buildHelp(cwd) {
  try {
    return { initialized: true, status: stageStatus(await readStageControl(cwd)) };
  } catch (error) {
    if (error.message.includes("尚未初始化 Runtime Corrector")) {
      return { initialized: false, status: null };
    }
    throw error;
  }
}


function formatHelp(help, cwd) {
  const lines = [
    "[runtime-corrector] Claude 对话帮助",
    "",
    "最常用命令：",
    "  /runtime-corrector:init                         初始化项目规则",
    "  /runtime-corrector:validate                     校验项目纠偏策略",
    "  /runtime-corrector:stages                       查看阶段开关",
    "  /runtime-corrector:stages <stage> off             关闭一个阶段",
    "  /runtime-corrector:explain <stage>                查看实际执行规则",
    "  /runtime-corrector:spec <stage>                   获取完整 Stage 规范地图",
    "  /runtime-corrector:check <artifact>               手动检查产物",
    "  /runtime-corrector:help                           再次显示本帮助",
    "",
    "也可以直接对 Claude 说：",
    "  “只开启我指定的 Stage”",
    "  “关闭某个 Stage 的纠偏”",
    "  “告诉我这个 Stage 的规则和 Agent 审阅标准在哪里”",
    "",
    "控制模型：config.yaml 中的 enabledStages、rules.enabled 和 review.enabled 分别控制阶段、硬规则和语义审阅。",
    "运行链路：写入命中文件 → 硬规则 → 一次性隔离 Agent reviewer → 候选 Diff 校验 → 主 Agent 决定最小修正 → 诊断留痕。",
    "信任边界：插件只诊断并提供审阅上下文，不自动修改产物，也不自动应用 Patch。",
  ];
  if (!help.initialized) {
    lines.push(
      "",
      "当前项目：尚未初始化。运行 /runtime-corrector:init，或直接说“初始化 Runtime Corrector”。",
    );
    return lines.join("\n");
  }
  lines.push("", "当前项目阶段：");
  if (help.status.stages.length === 0) {
    lines.push("  （尚未声明 v1 artifact Stage；version 2 纠偏由 config.yaml 中的功能开关控制。）");
  }
  for (const item of help.status.stages) {
    lines.push(`  ${item.enabled ? "[on]" : "[off]"} ${item.stage}`);
  }
  lines.push(
    `  配置：${displayPath(help.status.config, cwd)}`,
    "  详细文件：运行 /runtime-corrector:stages",
  );
  return lines.join("\n");
}


function displayPath(filePath, cwd) {
  if (!filePath) return null;
  const relative = path.relative(cwd, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? filePath.replaceAll("\\", "/") : relative;
}


function formatPolicyValidation(validation) {
  const lines = [
    `[runtime-corrector] 策略校验：${validation.status}`,
    `项目：${validation.projectRoot}`,
  ];
  if (validation.config) lines.push(`配置：${validation.config}`);
  if (validation.policyDigest) lines.push(`策略摘要：${validation.policyDigest}`);
  lines.push(
    `Artifact：${validation.artifacts?.length ?? 0}`,
    `Ground Truth：${validation.groundTruth?.length ?? 0}`,
    `问题：${validation.issues.length}`,
  );
  for (const issue of validation.issues) {
    lines.push(
      `- [${issue.severity.toUpperCase()}] ${issue.code}`
      + `${issue.subject ? ` (${issue.subject})` : ""} — ${issue.message}`,
    );
  }
  if (validation.issues.length === 0) {
    lines.push("配置、规则、Reviewer、Schema、Workflow 图和 Ground Truth 绑定均可加载。");
  }
  return lines.join("\n");
}


async function explainStage({ stage, cwd }) {
  const config = await loadConfig({ cwd, pluginRoot: PLUGIN_ROOT });
  const artifacts = config.configuredArtifacts.filter(
    (artifact) => artifact.stage === stage,
  );
  if (artifacts.length === 0) throw new Error(`当前策略没有声明 ${stage} stage。`);
  const explained = [];
  for (const artifact of artifacts) {
    const knowledge = artifact.rulesPolicy?.enabled !== false && artifact.simpleRulesFile
      ? await loadDefaultRules(artifact.simpleRulesFile)
      : null;
    const incomingEdges = config.reviewGraph?.incomingEdges(artifact.nodeId) ?? [];
    const explainedEdges = [];
    for (const edge of incomingEdges) {
      const edgeReviewer = edge.reviewEnabled
        ? await loadReviewer(
            edge.reviewerFile,
            config.limits.maxReviewerChars,
          )
        : null;
      explainedEdges.push({
        from: edge.from,
        to: edge.to,
        enabled: edge.reviewEnabled,
        criteria: displayPath(edgeReviewer?.path, cwd),
      });
    }
    explained.push({
      type: artifact.type,
      format: artifact.format,
      editable: artifact.editable !== false,
      patterns: artifact.patterns ?? [],
      pathTemplates: artifact.pathTemplates ?? [],
      relatedPatterns: artifact.relatedPatterns ?? [],
      rules: {
        enabled: artifact.rulesPolicy?.enabled !== false,
        file: displayPath(artifact.simpleRulesFile, cwd),
      },
      review: {
        enabled: artifact.reviewEnabled !== false,
        criteria: displayPath(artifact.reviewerFile, cwd),
      },
      ...(incomingEdges.length > 0 || config.workflowCorrelation
        ? {
            workflow: {
              nodeId: artifact.nodeId,
              baseline: EDGE_REVIEW_BASELINE,
              correlation: config.workflowCorrelation
                ? {
                    keys: [...config.workflowCorrelation.keys],
                    selection: "derive the instance from the trigger path and include only matching artifact instances",
                  }
                : null,
              incomingEdges: explainedEdges,
            },
          }
        : {}),
      checks: (knowledge?.ruleSummaries ?? []).map((rule) => {
        const validator = knowledge.rules.find((candidate) => candidate.id === rule.id);
        return {
          ...rule,
          ...(validator?.schemaPath ? { schema: displayPath(validator.schemaPath, cwd) } : {}),
        };
      }),
    });
  }
  const hasWorkflow = explained.some((artifact) => artifact.workflow);
  return {
    stage,
    configSource: config.configSource,
    config: displayPath(config.configPath, cwd),
    mechanism: [
      "match artifacts",
      "validate project JSON schemas",
      ...(explained.some((item) => item.rules.enabled)
        ? ["run enabled deterministic rules"]
        : []),
      ...(hasWorkflow ? ["review configured direct incoming workflow edges"] : []),
      ...(explained.some((item) => item.review.enabled || item.workflow?.incomingEdges.some((edge) => edge.enabled))
        ? ["run one isolated Agent semantic review for the enabled node/edge checks after PostToolUse"]
        : []),
      "persist one paired diagnostic and diff result for every matched snapshot",
    ],
    artifacts: explained,
  };
}


function formatExplanation(explanation) {
  const lines = [
    `[runtime-corrector] ${explanation.stage} stage 运作说明`,
    `配置：${explanation.config ?? explanation.configSource}`,
    "执行顺序：",
    ...explanation.mechanism.map((step, index) => `${index + 1}. ${step}`),
  ];
  for (const artifact of explanation.artifacts) {
    lines.push("", `Artifact：${artifact.type} (${artifact.format})`);
    lines.push(`- Patterns: ${artifact.patterns.join(", ") || "none"}`);
    lines.push(`- Path templates: ${artifact.pathTemplates.join(", ") || "none"}`);
    lines.push(`- Hard rules: ${artifact.rules.enabled ? `ON — ${artifact.rules.file}` : "OFF"}`);
    lines.push(
      `- Node semantic review: ${artifact.review.enabled
        ? `ON — ${artifact.review.criteria ?? "built-in Stage baseline"}`
        : "OFF"}`,
    );
    lines.push("- Checks:");
    for (const check of artifact.checks) {
      lines.push(`  - ${check.id}: ${check.type}${check.enabled === false ? " (off)" : ""}${check.artifact ? ` -> ${check.artifact}` : ""}${check.schema ? ` -> ${check.schema}` : ""}`);
    }
    if (artifact.workflow) {
      lines.push(`- Workflow node: ${artifact.workflow.nodeId}`);
      lines.push(`- Edge baseline: ${artifact.workflow.baseline}`);
      if (artifact.workflow.correlation) {
        lines.push(
          `- Correlation keys: ${artifact.workflow.correlation.keys.join(", ")}`,
          `- Instance selection: ${artifact.workflow.correlation.selection}`,
        );
      }
      for (const edge of artifact.workflow.incomingEdges) {
        lines.push(
          `  - ${edge.from} -> ${edge.to}: ${edge.enabled
            ? `ON — ${edge.criteria ?? "built-in baseline"}`
            : "OFF"}`,
        );
      }
    }
  }
  lines.push("", "以上路径均是当前实际执行来源；修改项目内文件后下一次检查立即生效，无需读取插件源码。");
  return lines.join("\n");
}


try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (args.command === "help") {
    process.stdout.write(`${formatHelp(await buildHelp(args.cwd), args.cwd)}\n`);
  } else if (args.command === "init") {
    const { target, derived } = await initializeProjectTemplate(args);
    process.stdout.write([
      "[runtime-corrector] 已初始化项目配置，并物化了自动派生结果。",
      `目录：${target}`,
      `检测到任务材料 ${derived.materialRootsRelative.length} 项`
        + `${derived.materialRootsRelative.length > 0 ? `（${derived.materialRootsRelative.slice(0, 5).join("、")}${derived.materialRootsRelative.length > 5 ? " 等" : ""}）` : ""}`
        + `；平台：${derived.platform ?? "未检测到（kit 检查保持关闭）"}。`,
      "config.yaml 即为按检测结果物化的 version 2 配置，可直接修改；删除该文件则回到零配置自动派生模式。",
      "v1 artifact/Stage 中文参考模板保留为 config.reference.yaml；示例硬规则与审阅标准见 example.rules.yaml / example.reviewer.md。",
    ].join("\n") + "\n");
  } else if (args.command === "validate") {
    const validation = await validateProjectPolicy({
      cwd: args.cwd,
      pluginRoot: PLUGIN_ROOT,
    });
    process.stdout.write(args.format === "json"
      ? `${JSON.stringify(validation, null, 2)}\n`
      : `${formatPolicyValidation(validation)}\n`);
    process.exitCode = validation.valid ? 0 : 1;
  } else if (args.command === "explain") {
    const explanation = await explainStage(args);
    process.stdout.write(args.format === "json"
      ? `${JSON.stringify(explanation, null, 2)}\n`
      : `${formatExplanation(explanation)}\n`);
  } else if (args.command === "spec") {
    const config = await loadConfig({ cwd: args.cwd, pluginRoot: PLUGIN_ROOT });
    const specification = await buildDefaultStageSpecification({
      stage: args.stage,
      cwd: args.cwd,
      pluginRoot: PLUGIN_ROOT,
      config,
    });
    process.stdout.write(args.format === "json"
      ? `${JSON.stringify(specification, null, 2)}\n`
      : `${formatStageSpecification(specification)}\n`);
  } else if (args.command === "stages") {
    const status = stageStatus(await readStageControl(args.cwd));
    process.stdout.write(args.format === "json"
      ? `${JSON.stringify(status, null, 2)}\n`
      : `${formatStageStatus(status, args.cwd)}\n`);
  } else if (args.command === "stage") {
    const status = await setStageEnabled(args);
    process.stdout.write(`${formatStageStatus(status, args.cwd)}\n`);
  } else {
    const outcome = await checkArtifact({
      filePath: args.artifact,
      cwd: args.cwd,
    });
    if (!outcome.matched) {
      throw new Error(`文件未命中任何 artifact 配置：${args.artifact}`);
    }
    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
    } else {
      process.stdout.write(`${outcome.feedback}\n`);
    }
    process.exitCode = outcome.result.status === "failed" ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`[runtime-corrector] ${error.message}\n\n${usage()}\n`);
  process.exitCode = 2;
}
