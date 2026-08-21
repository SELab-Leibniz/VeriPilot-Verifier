const UI_DESCRIPTION_PATTERN = /(?:\bui\b|user interface|screen|page|button|dialog|layout|navigation|tap|click|swipe|visual|accessibility|restart|persist|界面|页面|按钮|点击|滑动|弹窗|布局|跳转|视觉|截图|收藏|登录|授权|权限|相机|地图|无障碍|朗读|重启|持久化)/iu;
const SKIP_TEST_PATTERN = /(?:因为|由于|因此|所以|故|导致)[^。\n]{0,80}(?:未|没|无法|不能|跳过)[^。\n]{0,30}(?:测试|验证|验收)|(?:未|没|无法|不能|跳过)[^。\n]{0,30}(?:鸿蒙|HarmonyOS|UI|界面|模拟器|emulator|simulator)[^。\n]{0,30}(?:测试|验证|验收)|(?:because|due to|therefore|so)[^.\n]{0,100}(?:did not|didn't|could not|couldn't|cannot|skip(?:ped)?)[^.\n]{0,40}(?:test|verify|validation)/iu;
const NEGATIVE_ENVIRONMENT_PATTERN = /(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator|设备(?:环境)?)[^。\n]{0,40}(?:不可用|不存在|未安装|没有安装|找不到|无法使用|不能使用|缺失|not available|unavailable|not installed|missing|cannot use|could not use)|(?:不存在|未安装|没有安装|找不到|缺少|no|missing)[^。\n]{0,30}(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator)/iu;
const POSITIVE_ENVIRONMENT_PATTERN = /(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator)[^。\n]{0,30}(?:可用|已安装|已找到|已连接|启动成功|available|installed|connected|started)|(?:已找到|已安装|已连接|可使用)[^。\n]{0,20}(?:鸿蒙|DevEco|hdc|模拟器|emulator)/iu;


function contentBlocks(message) {
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message?.content) ? message.content : [];
}


function blockText(block) {
  if (typeof block === "string") return block;
  if (typeof block?.text === "string") return block.text;
  if (typeof block?.content === "string") return block.content;
  if (Array.isArray(block?.content)) return block.content.map(blockText).join("\n");
  return "";
}


function assistantMessages(snapshot, lastAssistantMessage = null) {
  const messages = [];
  for (const [sequence, entry] of (snapshot?.entries ?? []).entries()) {
    if (entry?.type !== "assistant") continue;
    const text = contentBlocks(entry.message)
      .filter((block) => block?.type === "text" || typeof block === "string")
      .map(blockText)
      .join("\n")
      .trim();
    if (text) messages.push({
      sequence,
      messageId: entry.message?.id ?? entry.uuid ?? `assistant-${sequence}`,
      text,
    });
  }
  const finalText = String(lastAssistantMessage ?? "").trim();
  if (finalText && messages.at(-1)?.text !== finalText) {
    messages.push({ sequence: Number.MAX_SAFE_INTEGER, messageId: "stop:last-assistant-message", text: finalText });
  }
  return messages;
}


function assertionTopic(text) {
  if (/(?:模拟器|仿真器|emulator|simulator)/iu.test(text)) return "emulator";
  if (/(?:hdc)/iu.test(text)) return "hdc";
  if (/(?:设备|target|device)/iu.test(text)) return "target";
  if (/(?:deveco)/iu.test(text)) return "deveco";
  return "environment";
}


function contradictsSnapshot(text, environment) {
  const capabilities = environment?.capabilities ?? {};
  const topic = assertionTopic(text);
  if (topic === "emulator") {
    return capabilities.emulator?.state === "INSTALLED_NOT_STARTED"
      && new Set(["READY", "STARTABLE"]).has(capabilities.uiTestReadiness);
  }
  if (topic === "hdc") return capabilities.deviceControl?.state === "READY";
  if (topic === "target") return capabilities.target?.state === "CONNECTED";
  if (topic === "deveco") return capabilities.installation?.state === "PRESENT";
  return capabilities.build?.state === "READY" || capabilities.deviceControl?.state === "READY";
}


function excerpt(text) {
  const line = text.split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => !item.startsWith(">") && NEGATIVE_ENVIRONMENT_PATTERN.test(item) && SKIP_TEST_PATTERN.test(item));
  return (line ?? text).slice(0, 400);
}


export function detectHarmonyEnvironmentMisconception({ snapshot, lastAssistantMessage, environment }) {
  const messages = assistantMessages(snapshot, lastAssistantMessage);
  let candidate = null;
  for (const message of messages) {
    const plain = message.text.split(/\r?\n/u).filter((line) => !line.trim().startsWith(">")
      && !/(?:用户说|用户提到|需求文档写|the user said|the requirement says)/iu.test(line)).join("\n");
    if (POSITIVE_ENVIRONMENT_PATTERN.test(plain)) candidate = null;
    if (NEGATIVE_ENVIRONMENT_PATTERN.test(plain)
      && SKIP_TEST_PATTERN.test(plain)
      && contradictsSnapshot(plain, environment)) {
      candidate = { ...message, excerpt: excerpt(plain), topic: assertionTopic(plain) };
    }
  }
  return candidate;
}


function commandFromBlock(block) {
  const input = block?.input ?? {};
  for (const key of ["cmd", "command", "script"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}


function successfulToolResults(entries) {
  const results = new Map();
  for (const entry of entries) {
    for (const block of contentBlocks(entry?.message)) {
      if (block?.type !== "tool_result") continue;
      const id = String(block.tool_use_id ?? block.id ?? "");
      if (!id) continue;
      const resultText = blockText(block);
      const failedByText = /(?:exit code|exited with code|error:|failed)[ :=-]+(?:[1-9]|true)/iu.test(resultText);
      results.set(id, block.is_error !== true && !failedByText);
    }
  }
  return results;
}


function commandKind(command) {
  if (!command) return null;
  if (/(?:hvigorw(?:\.bat|\.cmd)?)[^\r\n]*(?:assemblehap|assembleapp|build)/iu.test(command)) return "build";
  if (/\bhdc(?:\.exe)?\b[^\r\n]*\binstall\b/iu.test(command)) return "install";
  if (/\bhdc(?:\.exe)?\b[^\r\n]*(?:\baa\s+start\b|\bstart\s+-b\b)/iu.test(command)) return "launch";
  if (/(?:uitest|uiInput)[^\r\n]*(?:click|tap|swipe|input|keyEvent)|\bhdc\b[^\r\n]*\binput\b/iu.test(command)) return "ui-action";
  if (/(?:uitest|uiTest)[^\r\n]*(?:dumpLayout|find|assert|query)/iu.test(command)) return "ui-assertion";
  if (/(?:uitest|screencap)[^\r\n]*(?:screenCap|screencap)/iu.test(command)) return "capture";
  if (/\bhdc(?:\.exe)?\b|hvigorw|deveco|emulator|previewer/iu.test(command)) return "harmony-tool";
  return null;
}


export function extractHarmonyExecutionEvidence(snapshot) {
  const entries = snapshot?.entries ?? [];
  const results = successfulToolResults(entries);
  let lastSourceModification = -1;
  const steps = [];
  for (const [sequence, entry] of entries.entries()) {
    for (const block of contentBlocks(entry?.message)) {
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "");
      if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/iu.test(name)) lastSourceModification = sequence;
      const kind = commandKind(commandFromBlock(block));
      if (!kind) continue;
      const id = String(block.id ?? block.tool_use_id ?? "");
      steps.push({ sequence, kind, successful: id ? results.get(id) === true : false, toolUseId: id || null });
    }
  }
  const freshSuccessful = steps.filter((step) => step.successful && step.sequence > lastSourceModification);
  const kinds = new Set(freshSuccessful.map((step) => step.kind));
  return {
    lastSourceModification,
    steps,
    attemptedHarmonyEnvironment: steps.length > 0,
    usedHarmonyEnvironment: freshSuccessful.length > 0,
    completeUiChain: ["build", "install", "launch", "ui-action"].every((kind) => kinds.has(kind))
      && (kinds.has("ui-assertion") || kinds.has("capture")),
    successfulKinds: [...kinds],
  };
}


function explicitUiVerification(object) {
  const verification = object.verification;
  if (!verification) return false;
  return verification.platform === "harmonyos"
    && verification.runtimeRequired === true
    && (verification.modalities ?? []).some((item) => new Set(["device", "ui"]).has(item));
}


export function harmonyUiObligations(population) {
  return ["M12", "M13", "M15"].flatMap((metricId) => population?.metrics?.[metricId] ?? [])
    .filter((object) => object.hard && object.evidenceRequired)
    .filter((object) => explicitUiVerification(object)
      || UI_DESCRIPTION_PATTERN.test(object.description));
}


export function assessHarmonyStopGuard({
  environment,
  population,
  snapshot,
  lastAssistantMessage,
}) {
  const obligations = harmonyUiObligations(population);
  const misconceptionEligibleObligations = obligations.filter((object) => object.verification?.realDeviceOnly !== true);
  const executionEvidence = extractHarmonyExecutionEvidence(snapshot);
  const missingEvidence = obligations.length > 0 && !executionEvidence.completeUiChain;
  const misconception = missingEvidence
    && misconceptionEligibleObligations.length > 0
    && !executionEvidence.attemptedHarmonyEnvironment
    ? detectHarmonyEnvironmentMisconception({ snapshot, lastAssistantMessage, environment })
    : null;
  const environmentUsable = new Set(["AVAILABLE", "PARTIAL"]).has(environment?.status)
    && new Set(["READY", "STARTABLE"]).has(environment?.capabilities?.uiTestReadiness);
  const triggered = Boolean(environmentUsable && misconception && missingEvidence);
  const metricObjectJudgements = missingEvidence ? obligations.map((object) => ({
    objectId: object.objectId,
    judgement: "UNVERIFIED",
    reason: "Required HarmonyOS runtime/UI verification is missing a current successful build, install, launch, interaction, and assertion evidence chain.",
    evidence: executionEvidence.successfulKinds.map((kind) => `Observed successful HarmonyOS step: ${kind}`),
  })) : [];
  const finding = triggered ? {
    deviationKey: "impl:environment:harmonyos:availability-misconception",
    rootCauseId: "TEST_NOT_EXECUTED",
    severity: "error",
    reason: `The Agent treated the HarmonyOS ${misconception.topic} as unavailable and skipped required runtime/UI verification, but the task environment snapshot reports ${environment.capabilities.uiTestReadiness}.`,
    actualEvidence: [
      `Agent statement (${misconception.messageId}): ${misconception.excerpt}`,
      `Environment snapshot: ${environment.status}/${environment.capabilities.uiTestReadiness}`,
    ],
    expectedConstraint: "Use the available HarmonyOS environment for required runtime/UI acceptance checks, or preserve first-party failure output from an actual attempt.",
    violatedGroundTruthIds: [...new Set(misconceptionEligibleObligations.map((object) => object.sourceId))],
    suggestedNextAction: "Start or connect the detected Emulator/target, then run the unmet HarmonyOS UI acceptances and retain build, install, launch, interaction, assertion, and capture evidence.",
  } : null;
  return {
    status: triggered ? "MISCONCEPTION" : obligations.length === 0 ? "NOT_APPLICABLE" : "NO_MISCONCEPTION",
    triggered,
    environmentUsable,
    misconception,
    obligations,
    executionEvidence,
    metricObjectJudgements,
    findings: finding ? [finding] : [],
    environment,
    officialDocumentation: environment?.officialDocumentation ?? [],
  };
}


export function harmonyAwarenessFeedback(assessment) {
  if (!assessment?.triggered) return [];
  const environment = assessment.environment;
  const readiness = environment?.capabilities?.uiTestReadiness ?? "UNKNOWN";
  const lines = [
    "HarmonyOS environment awareness correction / 鸿蒙环境认知纠偏：",
    `- 任务级一次性环境事实：${environment?.status ?? "UNKNOWN"}；UI 测试就绪状态：${readiness}。`,
    `- 与环境事实冲突的 Agent 声明：${assessment.misconception.excerpt}`,
    "- 尚未完成、状态为 UNVERIFIED 的鸿蒙验收：",
    ...assessment.obligations.map((object) => `  - ${object.objectId}: ${String(object.description).slice(0, 240)}`),
    "- 缺失证据：绑定当前任务的 build → install → launch → UI action → assertion/capture 成功链。",
    ...(readiness === "STARTABLE"
      ? ["- 缓存探测没有证明已有连接 target；请启动/连接检测到的 Emulator，并保留真实 HDC 输出。"]
      : []),
  ];
  const relevant = (assessment.officialDocumentation ?? []).filter((document) => (
    document.topics?.some((topic) => new Set(["device", "emulator", "ui", "build", "hvigor"]).has(topic))
  )).slice(0, 4);
  if (relevant.length > 0) {
    lines.push("- 华为官方知识链接：");
    lines.push(...relevant.map((document) => `  - ${document.url}`));
  }
  return lines;
}
