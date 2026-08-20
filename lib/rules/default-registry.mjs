import { GENERIC_RULE_DEFINITIONS } from "./generic-provider.mjs";
import { FILE_DIGEST_MANIFEST_RULE_DEFINITIONS } from "./file-digest-manifest-provider.mjs";
import { GRAPH_RULE_DEFINITIONS } from "./graph-provider.mjs";
import { MARKDOWN_RECORD_RULE_DEFINITIONS } from "./markdown-records-provider.mjs";
import { RuleTypeRegistry } from "./registry.mjs";


export const DEFAULT_RULE_TYPE_REGISTRY = new RuleTypeRegistry([
  ...GENERIC_RULE_DEFINITIONS,
  ...FILE_DIGEST_MANIFEST_RULE_DEFINITIONS,
  ...GRAPH_RULE_DEFINITIONS,
  ...MARKDOWN_RECORD_RULE_DEFINITIONS,
]);
