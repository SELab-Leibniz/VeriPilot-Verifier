// Mechanical checks for the explicit per-invocation Claude session contract.
// Inspect tool-call arguments, never an assistant's prose claim of compliance.
// Shell expansion/wrappers are deliberately not executed or guessed: without
// literal, attributable evidence the result is UNVERIFIED, not a fabricated PASS.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export function requiresFreshCliSession(text) {
  return /claude/iu.test(text)
    && /(?:all|each|every).{0,50}(?:invocations?|calls?)|每次.{0,40}(?:调用|启动)|所有.{0,30}调用|per[- ]invocation/iu.test(text)
    && /fresh|新(?:的|生成)?|全新/iu.test(text) && /uuid/iu.test(text)
    && !/must not|shall not|不要|不得|无需/iu.test(text);
}

function invocations(snapshot) {
  const records = [];
  let ambiguous = false;
  for (const entry of snapshot?.entries ?? []) {
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const tool of entry.message.content) {
      if (tool.type !== "tool_use" || !["Bash", "PowerShell"].includes(tool.name)) continue;
      const command = String(tool.input?.command ?? "");
      if (!/claude|session-id/iu.test(command)) continue;
      // Only a direct command is fully attributable here. Complex scripts,
      // variables, pipelines and quoted command text need external receipts.
      const direct = command.trim().match(/^(?:claude(?:\.exe|\.cmd)?|"[^"\r\n]*[/\\]claude\.(?:exe|cmd)")\s+([^\r\n;&|]+)$/iu);
      if (!direct) { ambiguous = true; continue; }
      const args = direct[1].match(/"[^"]*"|'[^']*'|\S+/gu)?.map((arg) => arg.replace(/^["']|["']$/gu, "")) ?? [];
      const flag = args.findIndex((arg) => arg === "--session-id");
      const id = flag >= 0 ? args[flag + 1] : args.find((arg) => arg.startsWith("--session-id="))?.slice(13);
      records.push({
        id, resumed: args.includes("--resume") || args.includes("-r") || args.some((arg) => arg.startsWith("--resume=")),
        forked: args.includes("--fork-session"), nonInteractive: args.includes("-p") || args.includes("--print"),
        evidence: `transcript:${entry.uuid ?? entry.message.id ?? "assistant"} tool:${tool.id}`,
      });
    }
  }
  return { records, ambiguous };
}

export function processMetricJudgements({ population, snapshot }) {
  const objects = Object.values(population.metrics).flat().filter((object) => /^M(?:11|12):/u.test(object.objectId)
    && object.verificationTarget !== "IMPLEMENTATION" && object.verificationTarget !== "ARTIFACT"
    && requiresFreshCliSession(object.description ?? ""));
  if (objects.length === 0) return [];
  const { records, ambiguous } = invocations(snapshot);
  const ids = records.map((record) => record.id).filter((id) => UUID.test(id ?? "")).map((id) => id.toLowerCase());
  return objects.map((object) => {
    const nonInteractiveRequired = /non[- ]interactive|非交互/iu.test(object.description);
    const violation = records.some((record) => record.resumed && !record.forked)
      || new Set(ids).size !== ids.length
      || (nonInteractiveRequired && records.some((record) => !record.nonInteractive));
    const complete = !ambiguous && records.length > 0 && records.every((record) => UUID.test(record.id ?? "") && !record.forked);
    return {
      objectId: object.objectId,
      judgement: violation ? "DEVIATION" : complete ? "PASS" : "UNVERIFIED",
      reason: violation
        ? "Observed Claude invocation arguments reuse a session/UUID or omit required non-interactive mode."
        : complete ? "Every observed direct Claude invocation supplies a distinct literal UUID and the required invocation mode."
          : "Per-invocation UUID freshness cannot be verified from direct tool-call arguments; variables, wrappers or missing invocation records are not proof.",
      evidence: records.map((record) => record.evidence),
    };
  });
}
