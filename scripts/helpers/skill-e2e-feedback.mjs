// The native host can deliver Skill obligations through its unified M08
// channel. A matching graph node, actual Skill deviation and real admission
// are all required; a generic Stop message or arbitrary tag is insufficient.
export function unifiedSkillFeedbackReceipts({ payload, graph, findings, admissionIds, request }) {
  if (!payload?.tools?.some(tool => tool.function?.name === 'exec') || !findings?.length || !admissionIds?.length) return [];
  const nodes = (graph?.constraints ?? []).filter(node => findings.some(finding =>
    finding.violatedGroundTruthIds?.includes(node.constraintId)
    || finding.expectedConstraint?.includes(`constraint/${node.constraintId}`)
    || finding.expectedConstraint?.startsWith(`${node.constraintId} (`)));
  const receipts = [];
  for (const message of payload.messages ?? []) {
    const text = message.content;
    if (message.role !== 'user' || typeof text !== 'string'
      || !text.includes('[runtime-corrector:stop-feedback]') || !text.includes('[runtime-corrector:stop-reference]')) continue;
    const admissionId = admissionIds.find(id => text.includes(`准入 ${id}`));
    if (!admissionId) continue;
    for (const node of nodes) {
      const objectId = `M08:${graph.skillId}:${node.constraintId}`;
      if (text.includes(`${objectId} (`)) receipts.push({ delivery: 'native-m08-skill-feedback', request,
        admissionId, objectId, skillId: graph.skillId, skillGraphDigest: graph.digest });
    }
  }
  return receipts;
}
