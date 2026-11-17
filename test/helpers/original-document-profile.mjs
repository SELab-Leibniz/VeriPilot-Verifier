import { promises as fs } from "node:fs";
import path from "node:path";
import { parseSimpleYaml } from "../../lib/simple-yaml.mjs";
import { emitSimpleYaml } from "../../scripts/bench/rc-config-overrides.mjs";

// Document/B12 regressions opt into their features independently of the release default.
export async function installOriginalDocumentProfile(projectRoot) {
  const target = path.join(projectRoot, ".runtime-corrector");
  await fs.cp(new URL("../../.runtime-corrector-default/", import.meta.url), target, { recursive: true });
  const file = path.join(target, "config.yaml");
  const config = parseSimpleYaml(await fs.readFile(file, "utf8"));
  config.enabledStages = ["proposal", "design", "tasks"];
  for (const artifact of config.artifacts) artifact.review.enabled = true;
  for (const edge of config.workflow.edges) edge.review.enabled = true;
  config.artifactCorrection.originalRequirementsEnabled = true;
  config.stopCorrection.deviationOnly = true;
  config.requirementFrame.enabled = false;
  await fs.writeFile(file, emitSimpleYaml(config));
}
