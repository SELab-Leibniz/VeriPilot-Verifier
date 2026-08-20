import { loadDefaultRules } from "./default-runtime.mjs";


export {
  assertStageName,
  loadReviewer,
  loadSimpleProjectConfig,
} from "./policy/project-policy.mjs";


export async function loadSimpleRules(rulesFile) {
  return loadDefaultRules(rulesFile);
}
