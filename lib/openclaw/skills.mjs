import { promises as fs } from "node:fs";
import path from "node:path";

export async function adaptSkillsForOpenClaw(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await adaptSkillsForOpenClaw(file); continue; }
    if (!entry.name.endsWith(".md")) continue;
    const original = await fs.readFile(file, "utf8");
    const adapted = original.replace(/node -e "[^"\r\n]*" "scripts\/cli\.mjs" ([a-z]+)([^\r\n]*)/gu,
      (_match, command, rest) => {
        const subject = /<stage>/u.test(rest) ? "<stage>" : /<artifact-path>/u.test(rest) ? "<artifact-path>" : undefined;
        const args = { command, ...(subject ? { subject } : {}), ...(/--format json/u.test(rest) ? { format: "json" } : {}) };
        if (command === "stage") return `${JSON.stringify({ ...args, enabled: true })}\n   ${JSON.stringify({ ...args, enabled: false })}\n   Choose only the one matching the requested on/off state.`;
        return JSON.stringify(args);
      }).replace(/^allowed-tools: Bash, PowerShell$/gmu, "allowed-tools: runtime_corrector read")
      .replace(/^allowed-tools: Read Grep\r?$/gmu, "allowed-tools: read")
      .replace(/with the available Bash or PowerShell tool/gu, "with the runtime_corrector tool (use the JSON arguments below)")
      .replace(/bundled CLI command/gu, "runtime_corrector tool call")
      .replace(/ask Claude/gu, "ask the agent")
      .replace(/run `\/runtime-corrector:init`/gu, 'call runtime_corrector with command "init"')
      .replace(/current conversation inherited by the isolated session/gu, "frozen main-task transcript supplied with the request")
      .replace(/```(?:bash|sh|powershell)/gu, "```json");
    await fs.writeFile(file, adapted);
  }
}
