# Review timeout unification — 2026-10-16

## Change

All plugin host adapters now use a 1,200,000 ms (20 minute) default for semantic and role reviews. The inclusive project-config range is 1,000–3,600,000 ms (maximum 60 minutes). The OpenClaw Hook keeps its existing 2,000 ms minimum and shares the same default/maximum constants.

Configuration remains in the project's `.runtime-corrector/config.yaml`:

```yaml
limits:
  semanticReviewTimeoutMs: 1800000
reviewers:
  defaults:
    timeoutMs: 1200000
  stopReviewer:
    timeoutMs: 3600000
```

Role > reviewer defaults > semantic limit > plugin default. Schema and direct compilation reject invalid values. The built-in JSON Schema validator now implements `maximum`. Bundles and initialized templates retain the same defaults across hosts.

Onboarding no longer overrides a shorter explicit timeout with an internal floor. Its phase/lock budgets derive from the configured extractor and adjudicator timeouts; the old 18/29 minute phase/total ceilings are removed. A shorter enclosing deadline still applies, with time divided between the two phases. Repairs and follow-ups retain the original role deadline. Device execution and multi-stage total budgets remain separate.

## Automated verification

- Full suite: 846 tests, 840 passed, 6 environment-dependent skips, 0 failures.
- Final onboarding suite after adding the 60 minute phase-budget assertion: 33 passed, 0 failures.
- Regression coverage includes the originally rejected 1,800,000 ms configuration, inclusive 60 minute boundary, missing defaults, role precedence, all reviewer roles, invalid types/ranges, actual native runner timeout arguments, enclosing deadlines, cancellation, repair and handoff behavior.
- The original `tmp95` configuration loads successfully with semantic and role review timeouts of 1,800,000 ms; that file was not changed.
- The 60 minute boundary is verified through configuration and dispatched deadline values, without an hour-long wall-clock wait.

## Installed plugin and live development Session

Installed version: `1.9.1-openclaw.11-session-projects.9` in the normal user extension directory. A backup was saved under `~/.openclaw/backups/review-timeout-20261016/`. MA was restarted to load the new code.

The first test Session was interrupted by a subsequent MA process restart. The host explicitly marked that Session failed/interrupted; this attempt is not counted as a successful run. Its local evidence remains under `dist/review-timeout-verification/`.

The second test used the actual installed plugin, existing `main` agent, current native Gateway, existing `custom/deepseek-v4-flash` model and MA's persisted Session cwd bridge. It created and read a tiny `hello.py` under an independent test project, using the YAML above.

- Session: `agent:main:session-1792144441931-rc-review-timeout`.
- Session ID: `5539f392-5e6a-44e5-bfd0-6e0ad44b54ff`.
- Business run: `0016f5e6-ef1e-410b-aa40-cd861e04a119`.
- Task: `oc-scope-73b53bd0-525f-4a46-b2cd-4e6b14e54365`.
- Project admission: `enabled: true`, correct cwd, native mode.
- Onboarding: `COMPLETED`, Ground Truth frozen at version 1.
- Three real model reviewer runs settled: onboarding extractor, incremental Ground Truth extractor, Stop reviewer.
- Native terminal record: `SETTLED`, `reviewStatus: PASS`; 12 journal events and a persisted Stop evaluation.
- `hello.py` contained the exact requested bytes. This is a successful review/record-generation check; it does not exercise automatic repair of an intentionally introduced defect.

Local machine-readable evidence: `dist/review-timeout-verification/summary.json`, `runtime.json`, `session.json`, `status.json`, `business.json`, `installed.json`, `tests.log`, `onboarding-final.log`. The project and `.runtime-correction/` records are retained in `dist/review-timeout-verification/project-1792144441930/`.

## Scope and integrity

MA program files were not edited. The executable, application archive, bundled defaults and OpenClaw launcher hashes match the pre-install baseline. Models, global tools, agent entries (including main authorization and deny rules), RC plugin settings and the original project configuration remain unchanged.

MA startup itself normalized six existing user-config fields. Running its installed `ensureDefaults` function against the original config in an isolated in-memory context reproduced the observed agent configuration exactly; the verification did not write that config. Details are retained in `startup-normalization.json`:

- `agents.defaults.contextLimits.postCompactionMaxChars`: 30000 → 8000.
- `agents.defaults.compaction.mode`: `default` → `safeguard`.
- `agents.defaults.compaction.reserveTokensFloor`: 40000 → 30000.
- `agents.defaults.compaction.recentTurnsPreserve`: 10 → 5.
- `agents.defaults.compaction.maxHistoryShare`: 0.75 → 0.65.
- `agents.defaults.compaction.memoryFlush.softThresholdTokens`: 4000 → 6000.

These unrelated host defaults were not manually changed or restored. The existing `ShareSessionDialog` frontend issue is outside this plugin-only change.
