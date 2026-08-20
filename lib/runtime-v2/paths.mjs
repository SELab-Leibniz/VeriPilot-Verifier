// Central names for the plugin's on-disk trees.
//
// The output tree holds everything the corrector writes at runtime
// (diagnostics, rounds, task state, internal-run leases); the policy root
// holds the project's declared configuration and rules. Call sites that have
// access to the loaded config may override the output-tree name via
// `output.directory` (see outputTreeDirectory below); everything else uses
// the exported defaults.

export const OUTPUT_TREE_DIRECTORY = ".runtime-correction";
export const POLICY_ROOT_DIRECTORY = ".runtime-corrector";
export const LEGACY_POLICY_CONFIG_FILE = ".runtime-corrector.json";


/** Output-tree directory name, honoring the config `output.directory` override. */
export function outputTreeDirectory(output = null) {
  return output?.directory ?? OUTPUT_TREE_DIRECTORY;
}
