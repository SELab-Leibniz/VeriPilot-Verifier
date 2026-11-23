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
  const stages = ["proposal", "design", "tasks"];
  const review = () => ({ enabled: true, criteria: "example.reviewer.md" });
  config.enabledStages = stages;
  config.artifacts = stages.map(stage => ({ name: stage, stage, type: stage, format: "markdown", editable: true,
    pathTemplates: [`openspec/changes/{changeName}/${stage}.md`], rules: { enabled: false }, review: review() }));
  config.workflow = { correlation: { keys: ["changeName"] },
    edges: [["proposal", "design"], ["proposal", "tasks"], ["design", "tasks"]]
      .map(([from, to]) => ({ from, to, review: review() })) };
  config.artifactCorrection.originalRequirementsEnabled = true;
  config.stopCorrection.deviationOnly = true;
  config.requirementFrame.enabled = false;
  await fs.writeFile(file, emitSimpleYaml(config));
}
