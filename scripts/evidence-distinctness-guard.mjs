#!/usr/bin/env node
import { decodeHookInput, encodeHookOutput } from '../lib/protocol/core-hooks.mjs';
import { resolvePluginRoot } from '../lib/plugin-root.mjs';
import { loadConfig } from '../lib/runtime-corrector.mjs';
import { checkEvidenceDistinctness } from '../lib/evidence-distinctness.mjs';

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const input = decodeHookInput(raw);
  if (input.hook_event_name !== 'PostToolUse') return;
  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { root: pluginRoot } = await resolvePluginRoot({ env: process.env, executingModuleUrl: import.meta.url });
  const plan = await loadConfig({ cwd: projectRoot, pluginRoot });
  const feedback = checkEvidenceDistinctness({ projectRoot, plan });
  if (feedback && !plan?.runtimeV2?.shadowMode) {
    process.stdout.write(JSON.stringify(encodeHookOutput('PostToolUse', input, { feedback })) + '\n');
  }
}
main().catch((error) => {
  if (process.env.EVIDENCE_GUARD_DEBUG) console.error('EVIDENCE_GUARD ERROR:', error);
});
