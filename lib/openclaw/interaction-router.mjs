// Deliberately conservative: quoted/code content is never a command. This is
// syntax routing of unambiguous control phrases, not a second task classifier.
export function splitUserActions(messageId, text) {
  if (!messageId) throw new Error("Trusted message identity is required.");
  if (typeof text !== "string") throw new Error("Text required.");
  if (/```|^\s*>/mu.test(text)) return [{ messageId, actionId: "requirement-1", purpose: "requirement", text, start: 0, end: text.length }];
  const parts = [...text.matchAll(/[^;；\n]+/gu)];
  const counts = {};
  return parts.map((part) => {
    const fragment = part[0].trim();
    const query = /^(?:请)?(?:查询|查看|告诉我)?(?:当前|现在|任务)?(?:的)?(?:状态|进度|反馈|纠偏反馈|反馈及采纳情况|采纳情况)(?:是什么|如何|怎样)?[？?。！!]*$/u.test(fragment)
      || /^(?:现在|当前)?(?:到哪一步了|进行到哪一步了|做到哪了|有什么反馈|反馈有没有采纳)[？?。！!]*$/u.test(fragment)
      || /^(?:status|progress|feedback)[?.!]*$/iu.test(fragment);
    const purpose = query ? "control_query" : "requirement";
    const actionId = `${query ? "query" : "requirement"}-${counts[purpose] = (counts[purpose] ?? 0) + 1}`;
    return { messageId, actionId, purpose, requirementEligible: !query, text: part[0], start: part.index, end: part.index + part[0].length };
  });
}
export function projectTrustedActions(entries, mappings = {}) {
  return entries.flatMap((entry) => {
    const mapping = mappings[entry.nativeUuid ?? entry.uuid] ?? mappings[entry.sourceMessageId];
    if (!mapping || entry.type !== "user" || entry.isMeta || entry.actionId) return [entry];
    return mapping.actions.map((action) => ({ ...entry, uuid: `${mapping.messageId}/${action.actionId}`,
      isMeta: action.purpose === "control_query", sourceMessageId: mapping.messageId, actionId: action.actionId,
      purpose: action.purpose, message: { ...entry.message, id: `${mapping.messageId}/${action.actionId}`,
        content: [{ type: "text", text: action.text }] } }));
  });
}
