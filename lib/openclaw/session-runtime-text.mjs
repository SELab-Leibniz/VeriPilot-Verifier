const phases = {
  IDLE: "当前空闲", RUNNING: "MA 正在处理", FINALIZING: "正在等待本轮收尾",
  COEXIST_WAIT: "等待宿主续作结束", REVIEW_QUEUED: "正在等待终审", REVIEWING: "正在终审",
  WAIT_CORRECTION: "正在等待启动修复", CORRECTING: "正在自动修复", RELEASING: "正在停止纠偏",
  USER_DISPATCHING: "正在启动下一轮", ENDED: "本轮已结束", CLOSED: "会话已关闭",
};
const roles = {
  "requirement-frame": "提议 Agent 正在生成需求简报",
  "background-review": "正在后台检查",
  "onboarding-extractor": "正在提取需求",
  "ground-truth-extractor": "正在更新需求基线",
  "ground-truth-reviewer": "正在核对需求基线",
  "skill-reviewer": "正在核对 Skill",
  "artifact-reviewer": "正在评审产物",
  "stop-reviewer": "正在终审",
  "implementation-reviewer": "正在评审实现",
};
const outcomes = {
  PASS: "验收通过", NO_DEVIATION_FOUND: "无偏差", DEVIATION: "有偏差", UNVERIFIED: "未验证",
  COMPLETED_WITH_HISTORICAL_DEVIATIONS: "带历史偏差结束", DISABLED: "本轮未执行终审",
  SKIPPED: "本轮未执行终审", CANCELLED: "终审已取消",
};
const waitingPhases = new Set(["FINALIZING", "COEXIST_WAIT", "REVIEW_QUEUED", "REVIEWING", "WAIT_CORRECTION", "CORRECTING", "RELEASING"]);

export function sessionRuntimeText(snapshot) {
  const { phase, stage, status, outcome, registered, effectiveEnabled, inputMode, hostReconciliation } = snapshot;
  const wait = inputMode === "WAIT" || (inputMode === undefined && (waitingPhases.has(phase) || hostReconciliation === "UNKNOWN"));
  let activity;
  if (status === "UNKNOWN") activity = "状态待核对";
  else if (status === "STOPPING") activity = "正在停止纠偏";
  else if (wait && (snapshot.ended || !registered)) activity = "本会话暂缓接收新消息";
  else if (status === "TERMINATED") activity = "本轮纠偏已停止";
  else if (status === "INTERRUPTED") activity = "本轮纠偏已中断";
  else if (effectiveEnabled === false && !snapshot.active) activity = "本会话纠偏已关闭";
  else if (!registered) activity = "本会话尚无纠偏记录";
  else if (phase === "RUNNING" && Object.hasOwn(roles, stage)) activity = roles[stage];
  else activity = Object.hasOwn(phases, phase) ? phases[phase] : "状态不可用";

  const review = Object.hasOwn(outcomes, outcome) ? outcomes[outcome] : outcome ? "结论不可用"
    : phase === "REVIEWING" ? "终审中" : phase === "REVIEW_QUEUED" ? "等待终审"
      : snapshot.ended ? "不可用" : "尚未终审";
  const activities = status !== "UNKNOWN" && (snapshot.active || status === "STOPPING") && Array.isArray(snapshot.activities)
    ? snapshot.activities.map(({ role }) => Object.hasOwn(roles, role) ? roles[role] : "正在执行其他纠偏检查") : [];
  if (status !== "UNKNOWN" && snapshot.running && Object.hasOwn(roles, stage) && !activities.includes(roles[stage]))
    activities.push(roles[stage]);
  const line = ["RC " + activity, wait ? "建议本轮结束后再发送" : outcome ? review : null].filter(Boolean).join(" · ");
  return { activity, review, activities, line };
}
