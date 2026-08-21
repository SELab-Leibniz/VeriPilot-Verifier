const UI_DESCRIPTION_PATTERN = /(?:\bui\b|user interface|screen|page|button|dialog|layout|navigation|tap|click|swipe|visual|accessibility|restart|persist|界面|页面|按钮|点击|滑动|弹窗|布局|跳转|视觉|截图|收藏|登录|授权|权限|相机|地图|无障碍|朗读|重启|持久化)/iu;
const SKIP_TEST_PATTERN = /(?:因为|由于|因此|所以|故|导致)[^。\n]{0,80}(?:未|没|无法|不能|跳过)[^。\n]{0,30}(?:测试|验证|验收)|(?:未|没|无法|不能|跳过)[^。\n]{0,30}(?:鸿蒙|HarmonyOS|UI|界面|模拟器|emulator|simulator)[^。\n]{0,30}(?:测试|验证|验收)|(?:because|due to|therefore|so)[^.\n]{0,100}(?:did not|didn't|could not|couldn't|cannot|skip(?:ped)?)[^.\n]{0,40}(?:test|verify|validation)/iu;
const NEGATIVE_ENVIRONMENT_PATTERN = /(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator|设备(?:环境)?)[^。\n]{0,40}(?:不可用|不存在|未安装|没有安装|找不到|无法使用|不能使用|缺失|not available|unavailable|not installed|missing|cannot use|could not use)|(?:不存在|未安装|没有安装|找不到|缺少|no|missing)[^。\n]{0,30}(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator)/iu;
const POSITIVE_ENVIRONMENT_PATTERN = /(?:鸿蒙(?:环境|工具链)?|HarmonyOS|OpenHarmony|DevEco|hdc|模拟器|仿真器|emulator|simulator)[^。\n]{0,30}(?:(?<!不)可用|已安装|已找到|已连接|启动成功|(?<!un)(?<!not )available|installed|connected|started)|(?:已找到|已安装|已连接|(?<!不)可使用)[^。\n]{0,20}(?:鸿蒙|DevEco|hdc|模拟器|emulator)/iu;


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


function lastMatchIndex(pattern, text) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let index = -1;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    index = match.index;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return index;
}


export function detectHarmonyEnvironmentMisconception({ snapshot, lastAssistantMessage, environment }) {
  const messages = assistantMessages(snapshot, lastAssistantMessage);
  let candidate = null;
  for (const message of messages) {
    const plain = message.text.split(/\r?\n/u).filter((line) => !line.trim().startsWith(">")
      && !/(?:用户说|用户提到|需求文档写|the user said|the requirement says)/iu.test(line)).join("\n");
    const positiveIndex = lastMatchIndex(POSITIVE_ENVIRONMENT_PATTERN, plain);
    const negativeIndex = lastMatchIndex(NEGATIVE_ENVIRONMENT_PATTERN, plain);
    if (positiveIndex >= 0) candidate = null;
    if (negativeIndex >= 0
      && negativeIndex > positiveIndex
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


function toolResults(entries) {
  const results = new Map();
  for (const entry of entries) {
    for (const block of contentBlocks(entry?.message)) {
      if (block?.type !== "tool_result") continue;
      const id = String(block.tool_use_id ?? block.id ?? "");
      if (!id) continue;
      const resultText = blockText(block);
      const failedByText = /(?:\bexit(?:ed)?(?:\s+with)?\s+code\s*[:=]?\s*[1-9]\d*|\berror\s*:|\b(?:command|build|install|launch|test)\s+failed\b)/iu.test(resultText);
      results.set(id, {
        present: true,
        successful: block.is_error !== true && !failedByText,
        text: resultText.slice(0, 2000),
      });
    }
  }
  return results;
}


function commandSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote && command[index - 1] !== "\\" && command[index - 1] !== "`") quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\r" || character === "\n" || character === ";" || character === "|" || character === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      while (index + 1 < command.length && command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}


function firstToken(segment) {
  const source = segment.trim();
  if (!source) return null;
  const quote = source[0] === "\"" || source[0] === "'" ? source[0] : null;
  if (quote) {
    const end = source.indexOf(quote, 1);
    if (end < 0) return null;
    return { token: source.slice(1, end), remainder: source.slice(end + 1).trim() };
  }
  const match = source.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return match ? { token: match[1], remainder: match[2] ?? "" } : null;
}


function executableName(command) {
  return String(command ?? "").split(/[\\/]/u).at(-1).toLowerCase();
}


function unwrapShellInvocation(segment, depth = 0) {
  if (depth > 2) return [];
  let source = segment.trim();
  if (source.startsWith("&")) source = source.slice(1).trim();
  if (/^call(?:\s|$)/iu.test(source)) source = source.replace(/^call(?:\s+|$)/iu, "");
  const parsed = firstToken(source);
  if (!parsed) return [];
  const name = executableName(parsed.token);
  if (new Set(["cmd", "cmd.exe"]).has(name)) {
    const wrapper = parsed.remainder.match(/(?:^|\s)\/(?:c|k)(?:\s+)([\s\S]+)$/iu);
    if (!wrapper) return [];
    let nested = wrapper[1].trim();
    if ((nested.startsWith("\"") && nested.endsWith("\""))
      || (nested.startsWith("'") && nested.endsWith("'"))) nested = nested.slice(1, -1);
    return commandSegments(nested).flatMap((item) => unwrapShellInvocation(item, depth + 1));
  }
  if (new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]).has(name)) {
    const wrapper = parsed.remainder.match(/(?:^|\s)-(?:command|c)(?:\s+)([\s\S]+)$/iu);
    if (!wrapper) return [];
    let nested = wrapper[1].trim();
    if ((nested.startsWith("\"") && nested.endsWith("\""))
      || (nested.startsWith("'") && nested.endsWith("'"))) nested = nested.slice(1, -1);
    return commandSegments(nested).flatMap((item) => unwrapShellInvocation(item, depth + 1));
  }
  if (!/^(?:hdc(?:\.exe)?|hvigorw(?:\.bat|\.cmd|\.exe)?|emulator(?:\.exe)?|previewer(?:\.exe)?|devecostudio64(?:\.exe)?)$/iu.test(name)) return [];
  return [{ executable: name, args: parsed.remainder }];
}


function harmonyInvocations(command) {
  if (!command) return [];
  return commandSegments(command).flatMap((segment) => unwrapShellInvocation(segment));
}


function commandSemantics(command) {
  const invocation = harmonyInvocations(command)[0];
  if (!invocation) return { kind: null, topic: null };
  const { executable, args } = invocation;
  let kind = "harmony-tool";
  if (/^hvigorw/iu.test(executable) && /(?:assemblehap|assembleapp|build)/iu.test(args)) kind = "build";
  else if (/^hdc/iu.test(executable) && /\binstall\b/iu.test(args)) kind = "install";
  else if (/^hdc/iu.test(executable) && /(?:\baa\s+start\b|\bstart\s+-b\b)/iu.test(args)) kind = "launch";
  else if (/^hdc/iu.test(executable) && /(?:uitest|uiInput)[\s\S]*(?:click|tap|swipe|input|keyEvent)|\binput\b/iu.test(args)) kind = "ui-action";
  else if (/^hdc/iu.test(executable) && /(?:uitest|uiTest)[\s\S]*(?:dumpLayout|find|assert|query)/iu.test(args)) kind = "ui-assertion";
  else if (/^hdc/iu.test(executable) && /(?:uitest|screencap)[\s\S]*(?:screenCap|screencap)/iu.test(args)) kind = "capture";

  let topic = "environment";
  if (/^emulator/iu.test(executable)) topic = "emulator";
  else if (/^hdc/iu.test(executable) && /\blist\s+targets\b/iu.test(args)) topic = "target";
  else if (/^devecostudio64/iu.test(executable)) topic = "deveco";
  else if (/^hdc/iu.test(executable)) topic = "hdc";
  return { kind, topic };
}


function orderedUiChains(steps) {
  const chains = [];
  let setup = null;
  let action = null;
  let capturableChain = null;
  for (const step of steps) {
    if (step.kind === "build") {
      setup = { build: step, install: null, launch: null };
      action = null;
      capturableChain = null;
    } else if (step.kind === "install" && setup?.build) {
      setup = { ...setup, install: step, launch: null };
      action = null;
      capturableChain = null;
    } else if (step.kind === "launch" && setup?.install) {
      setup = { ...setup, launch: step };
      action = null;
      capturableChain = null;
    } else if (step.kind === "ui-action" && setup?.launch) {
      action = step;
      capturableChain = null;
    } else if (step.kind === "ui-assertion" && setup?.launch && action) {
      const chainSteps = [setup.build, setup.install, setup.launch, action, step];
      const chain = {
        steps: chainSteps,
        kinds: chainSteps.map((item) => item.kind),
        scopeText: [action, step].flatMap((item) => [item.command, item.resultText]).filter(Boolean).join("\n"),
        hasCapture: false,
      };
      chains.push(chain);
      capturableChain = chain;
      action = null;
    } else if (step.kind === "capture" && capturableChain) {
      capturableChain.steps.push(step);
      capturableChain.kinds.push(step.kind);
      capturableChain.scopeText = [capturableChain.scopeText, step.command, step.resultText].filter(Boolean).join("\n");
      capturableChain.hasCapture = true;
      capturableChain = null;
    }
  }
  return chains;
}


function objectEvidenceBinding(chain, object, obligationCount) {
  if (obligationCount === 1) return "implicit-single-obligation";
  const scope = chain.scopeText.toLowerCase();
  const tokens = [object.objectId, object.sourceId]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
  return tokens.some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, "iu").test(scope);
  }) ? "explicit-object-reference" : null;
}


function requiresCapture(object) {
  return (object.verification?.evidenceKinds ?? [])
    .some((kind) => new Set(["capture", "screenshot"]).has(String(kind).toLowerCase()));
}


export function extractHarmonyExecutionEvidence(snapshot, obligations = []) {
  const entries = snapshot?.entries ?? [];
  const results = toolResults(entries);
  let lastSourceModification = -1;
  const steps = [];
  let order = 0;
  for (const [sequence, entry] of entries.entries()) {
    for (const block of contentBlocks(entry?.message)) {
      order += 1;
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "");
      if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/iu.test(name)
        || /(?:^|[_:.])apply_patch$/iu.test(name)) lastSourceModification = order;
      const command = commandFromBlock(block);
      const { kind, topic } = commandSemantics(command);
      if (!kind) continue;
      const id = String(block.id ?? block.tool_use_id ?? "");
      const result = id ? results.get(id) : null;
      steps.push({
        sequence,
        order,
        kind,
        command,
        topic,
        successful: result?.successful === true,
        resultPresent: result?.present === true,
        resultText: result?.text ?? "",
        toolUseId: id || null,
      });
    }
  }
  const freshSuccessful = steps.filter((step) => step.successful && step.order > lastSourceModification);
  const kinds = new Set(freshSuccessful.map((step) => step.kind));
  const chains = orderedUiChains(freshSuccessful);
  const evidenceByObject = obligations.map((object) => {
    const candidate = chains.find((chain) => (!requiresCapture(object) || chain.hasCapture)
      && objectEvidenceBinding(chain, object, obligations.length));
    return {
      objectId: object.objectId,
      complete: Boolean(candidate),
      binding: candidate ? objectEvidenceBinding(candidate, object, obligations.length) : null,
      requiredCapture: requiresCapture(object),
      kinds: candidate?.kinds ?? [],
      toolUseIds: candidate?.steps.map((step) => step.toolUseId).filter(Boolean) ?? [],
    };
  });
  return {
    lastSourceModification,
    steps: steps.map(({ command: _command, resultText, ...step }) => ({
      ...step,
      hasResultOutput: Boolean(resultText.trim()),
    })),
    attemptedHarmonyEnvironment: steps.length > 0,
    usedHarmonyEnvironment: freshSuccessful.length > 0,
    completeUiChain: evidenceByObject.length > 0
      ? evidenceByObject.every((item) => item.complete)
      : chains.length > 0,
    orderedUiChains: chains.map((chain) => ({
      kinds: chain.kinds,
      hasCapture: chain.hasCapture,
      toolUseIds: chain.steps.map((step) => step.toolUseId).filter(Boolean),
    })),
    evidenceByObject,
    successfulKinds: [...kinds],
  };
}


function topicMatchesMisconception(step, misconception) {
  const topic = misconception?.topic;
  if (topic === "emulator") return new Set(["emulator", "target"]).has(step.topic);
  if (topic === "target") return step.topic === "target";
  if (topic === "hdc") return new Set(["hdc", "target"]).has(step.topic);
  if (topic === "deveco") return step.topic === "deveco";
  return step.topic !== null;
}


function failureMatchesMisconception(step, misconception) {
  return topicMatchesMisconception(step, misconception)
    && step.resultPresent
    && !step.successful
    && step.hasResultOutput;
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
  const executionEvidence = extractHarmonyExecutionEvidence(snapshot, obligations);
  const completedIds = new Set(executionEvidence.evidenceByObject
    .filter((item) => item.complete)
    .map((item) => item.objectId));
  const missingObligations = obligations.filter((object) => !completedIds.has(object.objectId));
  const connectedTarget = environment?.capabilities?.target?.state === "CONNECTED";
  const misconceptionEligibleObligations = missingObligations.filter((object) => (
    object.verification?.realDeviceOnly !== true || connectedTarget
  ));
  const missingEvidence = missingObligations.length > 0;
  const misconception = missingEvidence && misconceptionEligibleObligations.length > 0
    ? detectHarmonyEnvironmentMisconception({ snapshot, lastAssistantMessage, environment })
    : null;
  const latestRelevantAttempt = misconception
    ? executionEvidence.steps
      .filter((step) => step.sequence <= misconception.sequence && topicMatchesMisconception(step, misconception))
      .at(-1) ?? null
    : null;
  const matchingFailureEvidence = latestRelevantAttempt && failureMatchesMisconception(latestRelevantAttempt, misconception)
    ? latestRelevantAttempt
    : null;
  const environmentUsable = new Set(["AVAILABLE", "PARTIAL"]).has(environment?.status)
    && new Set(["READY", "STARTABLE"]).has(environment?.capabilities?.uiTestReadiness);
  const triggered = Boolean(environmentUsable && misconception && missingEvidence && !matchingFailureEvidence);
  const metricObjectJudgements = missingObligations.map((object) => ({
    objectId: object.objectId,
    judgement: "UNVERIFIED",
    reason: "Required HarmonyOS runtime/UI verification is missing a current, ordered, object-bound build, install, launch, interaction, and assertion evidence chain.",
    evidence: executionEvidence.successfulKinds.map((kind) => `Observed successful HarmonyOS step: ${kind}`),
  }));
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
    matchingFailureEvidence,
    latestRelevantAttempt,
    obligations,
    missingObligations,
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
    ...(assessment.missingObligations ?? assessment.obligations)
      .map((object) => `  - ${object.objectId}: ${String(object.description).slice(0, 240)}`),
    "- 缺失证据：绑定对应验收对象的有序 build → install → launch → UI action → assertion 成功链；要求截图时还需随后 capture。",
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
