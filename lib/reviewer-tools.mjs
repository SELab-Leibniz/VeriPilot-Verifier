export const HOST_TOOL_REVIEWER_ROLES = Object.freeze([
  "onboarding-extractor", "onboarding-adjudicator", "skill-reviewer", "artifact-reviewer", "implementation-reviewer",
]);

export const inheritsHostReviewerTools = role => HOST_TOOL_REVIEWER_ROLES.includes(role);

export const usesReadOnlyReviewerTools = (role, request) => inheritsHostReviewerTools(role)
  || role === "ground-truth-extractor"
  || role === "stop-reviewer" && request?.reviewScope?.kind === "classification";

const forbiddenOperations = ["write", "edit", "apply_patch", "exec", "process", "code_execution",
  "bash", "bash_output", "kill_shell", "multi_edit", "notebook_edit", "shell", "terminal",
  "execute", "execute_code", "execute_command", "run_code", "run_command"];
const mcpOperationPatterns = ["write*", "edit*", "apply_patch*", "exec*", "run_code*", "run_command*", "bash*", "shell*", "terminal*", "code_execution*"];
export const REVIEWER_NATIVE_TOOL_DENY = Object.freeze([...forbiddenOperations, ...mcpOperationPatterns.map(name => `mcp__*__${name}`)]);
export const REVIEWER_CLI_TOOL_DENY = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "CodeExecution",
  ...REVIEWER_NATIVE_TOOL_DENY]);

// The host can discover additional tools after the initial catalog is built.
// Return a terminal before-tool decision, never a throwable fail-open hint.
export function blockReviewerToolCall(name) {
  if (typeof name !== "string" || name === "read:result") return undefined;
  const normalized = name.split("__").at(-1).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replaceAll("-", "_");
  if (!forbiddenOperations.some(operation => normalized === operation || normalized.startsWith(`${operation}_`))) return undefined;
  return { block: true, blockReason: `RC_REVIEWER_TOOL_DENIED: ${name} is an edit, write or execution tool. Use read/search and this review's dedicated tools.` };
}

export const HOST_REVIEWER_TOOL_INSTRUCTIONS = "Use the host's available read and search tools, under its existing permissions and approvals, to gather evidence for this review. Editing, writing, patching, shell/process and code execution tools are prohibited. RC-specific candidate, progress and result tools remain scoped to this private review. Assess the assigned request and return its structured result; do not apply business changes or continue the parent task.";
