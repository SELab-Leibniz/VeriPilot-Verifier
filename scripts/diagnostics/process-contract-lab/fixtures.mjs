const event = (id, start, end, action, extra = {}) => ({ id, start, end, action,
  actor: "MAIN_TASK", sessionId: "lab-session", taskId: "lab-task", completed: true, ...extra });
const scope = { sessionId: "lab-session", taskId: "lab-task" };
export const fixtures = [
  { ...scope, id: "ordinary-read-external-change", source: "Read the project's frozen spec if provided.",
    events: [event("fs-change", 5, 6, "filesystem observation", { actor: "UNKNOWN" }),
      event("read-contract", 20, 21, "read contract.txt, complete content returned"),
      event("edit-module", 30, 31, "edit module.py"), event("verify", 40, 41, "verify module.py, PASS")],
    expected: { orderRequired: false, confirmedOrderDeviation: false } },
  { ...scope, id: "explicit-reversed-order", source: "Before modifying orders.py, you MUST read contract.md. This ordering is mandatory.",
    events: [event("write-orders", 10, 11, "edit orders.py"), event("read-contract", 20, 21, "read contract.md")],
    expected: { orderRequired: true, confirmedOrderDeviation: true } },
  { ...scope, id: "equivalent-content-delivery", source: "You MUST obtain the requirements.txt contents before changing worker.py. No specific reading tool is required.",
    events: [event("exec-cat-result", 10, 11, "exec cat requirements.txt; complete file contents returned with matching hash"),
      event("edit-worker", 20, 21, "edit worker.py")],
    expected: { orderRequired: true, confirmedOrderDeviation: false } },
  { ...scope, id: "advisory-numbered-steps", source: "建议采用以下工作习惯：1. 先阅读说明。2. 再修改实现。这是建议，不是强制的执行顺序。",
    events: [event("edit-implementation", 10, 11, "edit implementation.py"), event("read-guide", 20, 21, "read guide.md")],
    expected: { orderRequired: false, confirmedOrderDeviation: false } },
];
export const modelInputs = fixtures.map(({ expected, ...fixture }) => fixture);
