import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRuntimeV2Config } from '../lib/runtime-v2/config.mjs';

test('shadowMode defaults off and is opt-in', () => {
  assert.equal(compileRuntimeV2Config({ version: 2 }).shadowMode, false);
  assert.equal(compileRuntimeV2Config({ version: 2, shadowMode: true }).shadowMode, true);
  // Any non-true value must not silently enable it: a control arm that
  // accidentally speaks to the agent is an invalid baseline.
  assert.equal(compileRuntimeV2Config({ version: 2, shadowMode: 'yes' }).shadowMode, false);
});

test('shadow mode strips the outbound decision while preserving what was suppressed', async () => {
  // Exercise the wrapper directly: the internal handler is what journals, and
  // the wrapper is the only thing standing between it and the agent.
  const { handleRuntimeV2Event } = await import('../lib/runtime-v2/orchestrator.mjs');

  // A disabled plan short-circuits before any I/O, which is enough to prove the
  // wrapper's contract without standing up a whole task tree.
  const live = await handleRuntimeV2Event({
    input: { session_id: 's1', hook_event_name: 'Stop' },
    projectRoot: '/nonexistent',
    plan: { runtimeV2: { enabled: false } }
  });
  assert.equal(live.shadowMode, undefined, 'live runs carry no shadow marker');

  const shadowed = await handleRuntimeV2Event({
    input: { session_id: 's1', hook_event_name: 'Stop' },
    projectRoot: '/nonexistent',
    plan: { runtimeV2: { enabled: false, shadowMode: true } }
  });
  assert.equal(shadowed.shadowMode, true);
  assert.equal(shadowed.decision, undefined, 'no decision may reach the agent');
  assert.equal(shadowed.feedback, null, 'no feedback may reach the agent');
  assert.ok(Object.hasOwn(shadowed, 'suppressedDecision'), 'what was withheld is recorded');
  assert.ok(Object.hasOwn(shadowed, 'suppressedFeedback'));
});

test('shadowMode survives the project-policy YAML load path end to end', async (t) => {
  // Regression for the arm-contamination incident: loadProjectPolicySource
  // rebuilt the config through an explicit key whitelist that silently dropped
  // shadowMode, so plan.runtimeV2.shadowMode compiled to false and the
  // "shadow" control arm received live corrections. The in-memory compiler
  // tests above cannot catch that — this one goes through the real
  // .runtime-corrector/config.yaml load path.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadConfig } = await import('../lib/runtime-corrector.mjs');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-yaml-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.runtime-corrector'), { recursive: true });
  await fs.writeFile(path.join(root, '.runtime-corrector', 'config.yaml'), [
    'shadowMode: true',
    'version: 2',
    'artifacts:',
    '  - name: requirements',
    '    stage: requirements',
    '    format: markdown',
    '    patterns:',
    '      - spec/requirements.md',
    ''
  ].join('\n'), 'utf8');

  const plan = await loadConfig({ cwd: root, pluginRoot: path.resolve(import.meta.dirname, '..') });
  assert.equal(plan.configSource, 'project-simple');
  assert.equal(plan.runtimeV2.shadowMode, true,
    'shadowMode from the project YAML must reach the compiled runtime plan');
});
