// User-visible status wording. The gateway and the browser console both import
// this file, so it must not depend on Node APIs. Keep the tables in
// docs/status-display-plan.md in sync.
export const BRAND = "纠偏插件";

// indicator: running = pulsing green, passed = green, waiting = amber, idle = grey.
export const STATUS = {
  stopping: { text: `${BRAND} 正在停止纠偏`, indicator: "waiting" },
  terminated: { text: `${BRAND} 本轮纠偏已停止`, indicator: "idle" },
  aborted: { text: "纠偏评审结果：无偏差", indicator: "idle" },
  sessionOff: { text: `${BRAND} 本会话纠偏已关闭`, indicator: "idle" },
  armed: { text: `${BRAND} 已开启，等待本轮开始`, indicator: "idle" },
  unregistered: { text: `${BRAND} 尚无纠偏记录`, indicator: "idle" },
  repairing: { text: "纠偏评审结果：有偏差，正在自动修复", indicator: "running" },
  rereviewing: { text: "修复完成，重新评审", indicator: "running" },
  reviewing: { text: `${BRAND} 评审中`, indicator: "running" },
  background: { text: `${BRAND} {check}`, indicator: "running" },
  hidden: { text: null, indicator: null },
  passed: { text: "纠偏评审结果：无偏差", indicator: "passed" },
  noDeviation: { text: "纠偏评审结果：无偏差", indicator: "passed" },
  deviationLeft: { text: "纠偏评审结果：有偏差", indicator: "waiting" },
  reviewIncomplete: { text: "纠偏评审结果：无偏差", indicator: "idle" },
};

export const CHECKS = {
  "requirement-frame": "提议 Agent 正在生成需求简报",
  "background-review": "正在后台检查",
  "onboarding-extractor": "正在提取需求",
  "ground-truth-extractor": "正在更新需求基线",
  "ground-truth-reviewer": "正在核对需求基线",
  "skill-reviewer": "正在核对 Skill",
  "artifact-reviewer": "正在评审产物",
  "implementation-reviewer": "正在评审实现",
  "stop-reviewer": "评审中",
};
export const OTHER_CHECK = "正在执行其他纠偏检查";

// Console "纠偏运行" field while the round is active.
export const PHASES = {
  IDLE: "当前空闲", RUNNING: "暂无纠偏活动", FINALIZING: "正在等待本轮收尾",
  COEXIST_WAIT: "等待宿主续作结束", REVIEW_QUEUED: "正在等待终审", REVIEWING: "评审中",
  WAIT_CORRECTION: "正在等待启动修复", CORRECTING: "正在自动修复", RELEASING: "正在停止纠偏",
  USER_DISPATCHING: "正在启动下一轮", ENDED: "本轮已结束", CLOSED: "会话已关闭",
};

// Console review conclusion; the status line maps outcomes through STATUS instead.
export const OUTCOMES = {
  PASS: "验收通过", NO_DEVIATION_FOUND: "无偏差", DEVIATION: "有偏差", UNVERIFIED: "未验证",
  COMPLETED_WITH_HISTORICAL_DEVIATIONS: "带历史偏差结束", DISABLED: "本轮未执行终审",
  SKIPPED: "本轮未执行终审", CANCELLED: "终审已取消",
};

export const DETAILS = {
  round: { unknown: "状态待核对", unregistered: "尚无纠偏记录", inactive: "当前无纠偏运行", unavailable: "状态不可用" },
  agents: { unavailable: "状态不可用", running: "正在运行", none: "当前无纠偏 Agent 在运行" },
  review: { reviewing: "评审中", invalid: "结论不可用", unavailable: "不可用", pending: "尚未终审" },
};

export const CONSOLE = {
  title: `${BRAND}会话控制台`,
  previewTitle: "输入框状态栏预览",
  previewHidden: "（当前不显示状态行）",
  previewUnavailable: `${BRAND} 状态不可用`,
  history: `${BRAND} 历史会话`,
  repairInput: `修复轮收到的${BRAND}输入`,
  noProject: `当前会话没有可读取的${BRAND}项目`,
};
