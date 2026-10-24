# Isolated Python TodoList end-to-end validation

This experiment starts without `todo.py`. A real business model writes the app,
runs frozen acceptance, and reaches the ordinary native Stop path. The observer
does not implement or repair the business app. It builds the current corrector
source, freezes input hashes, and proves ownership of the new native worktree.

Document/artifact correction and Skill correction are disabled only in the new
profile. Ground Truth, final Stop, and implementation review remain enabled.
The original project, sessions, Gateway, credentials files, and settings are not
modified. Existing authorized model credentials are read in memory and passed
through the child environment; saved provider metadata contains no API key.

Frozen acceptance uses the unchanged nine tests from
`examples/python-todolist-transactions/test_todo.py` and one connected same-store
journey. The verifier is checked against the existing reference app before live
admission; the reference implementation is never copied into the new workspace.
The model and observer each execute the same frozen verifier independently.

From the repository root:

```powershell
node experiments/todolist-e2e-20261024/run.mjs
node experiments/todolist-e2e-20261024/run.mjs --live --output=experiments/live-todolist-UNIQUE
node experiments/todolist-e2e-20261024/run.mjs --live --max-corrections=2 --output=experiments/live-todolist-m16-UNIQUE
node experiments/todolist-e2e-20261024/analyze.mjs experiments/live-todolist-UNIQUE
node experiments/todolist-e2e-20261024/postcheck.mjs experiments/live-todolist-UNIQUE
node experiments/todolist-e2e-20261024/audit.mjs experiments/live-todolist-UNIQUE
node experiments/todolist-e2e-20261024/run.mjs --case=kitchen --live --output=experiments/live-kitchen-UNIQUE
```

The live switch is explicit; output must be a new direct `experiments/live-todolist-*`
directory. The current helper uses the installed Windows OpenClaw host and Python
paths. It installs the existing frozen reviewer dependency lock and copies only
the current built plugin into this run. It retains the installed hook timeout and
follows the actual saved Stop deadline, adding only 15 seconds for observation of
persisted results. It never changes product budgets after admission.

Saved evidence includes input/source hashes, isolation proof, native session and
trajectory pointer, Gateway log and events, per-item reviewer artifacts, committed
core assessments, independent business acceptance, and original/protected-file
hash checks. Chat's final reply alone does not certify Stop completion. The
observer distinguishes all-metric PASS, formal completion retaining UNVERIFIED,
and an uncertified Stop. Failures preserve partial artifacts and close only the
Gateway owned by this run.

`--max-corrections=2` explicitly freezes that Stop limit before business admission.
The runner checks the effective configuration and records the metric catalog,
M16 prompt hash and exact current plugin source hashes, including uncommitted
work. Old default fixtures remain unchanged. A counter value of zero can coexist
with an admitted partial-feedback continuation after a checker failure: report
business correction attempts, infrastructure failures and native receipts separately.

`probe-manual-check.mjs` is a separate zero-model mechanism probe for missing
current-run identity inside a pending correction chain. It does not start another
business experiment or change the live app. `audit.mjs` reports direct claim-ID
ownership separately from semantic coverage, and preserves an optional supplementary
store-path counterexample alongside the original frozen acceptance and metric verdicts.

That probe expects the historical unfixed behavior; its original JSON is preserved.
Current fixed behavior is covered by the registered-tool and correction-chain
regressions in `test/openclaw-session-projects.test.mjs` and
`test/openclaw-native-stop-budget.test.mjs`.

`validate-m16-repair.mjs experiments/live-m16-repair-validation-UNIQUE --prepare-only`
prepares seven isolated source cases and checks the copied TodoList counterexample
and repaired-copy acceptance without model calls or reading authentication config.
Omitting `--prepare-only` sends these cases and requirements to the configured
external model service and requires explicit authorization for that data transfer.
The script refuses to reuse an output directory and never edits the original run.

After a completed seven-case real-model run,
`node experiments/todolist-e2e-20261024/analyze-m16-repair.mjs experiments/live-m16-repair-validation-UNIQUE`
checks the authorized source/requirement identity, actual SOURCE read proofs,
PASS production traces, preserved original source and current code hashes. It
counts protocol errors and provider errors separately from the SDK's acknowledged
post-save cancellations, and writes analysis.json without model calls. The final
20261025-05 run matched all seven expectations; earlier false PASS and timeout
iterations remain preserved. This is a source regression, not another business E2E.

Token counts come from persisted model/SDK usage and include cache reads where
reported. They are not exact billing totals. Ordinary happy-path completion does
not establish fault recovery, correction effectiveness, or overflow resilience.

`--case=kitchen` reuses this runner with the original kitchen contract, Skill,
and 21-case offline verifier. It starts without kitchen.py, keeps document/Skill
correction disabled, and uses its own Python source adapter. The kitchen verifier
starts applications with `-I -S`; application Unicode output must work even when
Python ignores UTF-8 environment settings. The analyzer and postcheck also accept
these kitchen run directories. Native temporary review files are copied into
observer snapshots while they exist; the last messages may disappear before a
poll, so native usage from snapshots is explicitly a lower bound. The observer
does not change any native temporary files or the protected business fixtures.
