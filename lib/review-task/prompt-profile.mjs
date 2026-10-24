import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const bytes = readFileSync(new URL("./prompts.json", import.meta.url));
const profile = JSON.parse(bytes.toString("utf8"));
export const REVIEW_PROMPT_PROFILE_DIGEST = createHash("sha256").update(bytes).digest("hex");
export const REVIEW_PROMPT_PROFILE_VERSION = profile.version;

/** Fixed task ownership chooses a reviewed prompt; never classify with another model. */
export function reviewPromptProfile(metricId, scope) {
  return {
    promptAppend: profile.scopeOverrides?.[metricId]?.[scope] ?? profile.metricPrompts[metricId] ?? "",
    reviewType: profile.reviewTypes?.[metricId]?.[scope] ?? profile.reviewTypes?.[metricId]?.default ?? "obligation-reviewer",
  };
}
