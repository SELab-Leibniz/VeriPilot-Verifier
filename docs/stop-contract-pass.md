# Stop behavior and regression correction

Base: `85757c39d0f11c7651caf8681582cfedd2ff0657`.
Worktree: `rc-wt/stop-contract-pass`; branch: `codex/stop-contract-pass-85757c3`.

User objective: disable document and skill correction, optimize only Stop;
complete security_tool_2 first, then security_tool_6, with full evaluation PASS.
Reuse existing review and Huawei native test tooling; retain before/after tests,
feedback, source checkpoints, effective configuration and candidate patches.
MatrixAssistant and its bundled OpenClaw are read-only hosts.

Verified outcome (2026-11-09, Shanghai): both target candidates reached full
independent evaluator PASS after real Stop feedback and model-authored repair.

- security_tool_2: 1/2 target tests and 739/746 regressions before repair;
  **2/2 and 746/746 after repair**. Stop caught a broken existing service seam.
  The main model restored use of `PermissionService.loadApplications` rather
  than bypassing its established loading contract. One actual correction;
  final Stop NO_DEVIATION_FOUND. RC source `0913b3e`.
- security_tool_6: the original report's evaluated candidate reproduced
  7/7 target tests and 616/617 regressions; **7/7 and 617/617 after repair**.
  An independently calibrated native public-input check exposed the
  missing/empty USB payload fallback. Stop delivered this deviation, and the
  main model reused its existing VID/PID identification result to keep
  unidentified events out of auto-deny. One actual correction; accepted final
  Stop NO_DEVIATION_FOUND. RC source `f1a70c6`, package SHA256
  `6cc2f96ba98ca1ee0b1d42d905b33236b81254fefa2e7aa05a2961c6581f9697`.
- Final complete RC verification on `9d098ff`: 299/299 test files, 3,065 pass,
  zero failures or timeouts, 46 skipped (`rc-tests-v8-r2.log`). Changes from the
  packaged source are only this development note and the timing-test fix
  described below. No further product changes followed this verification.

These are targeted failing-candidate replay/repair results on two development
checkpoints, not fresh natural task runs or a same-binary success-rate study.
For st2, the raw replay wrapper's compaction-accounting failure is retained;
the exact genuine repair was recovered, fingerprinted and independently
graded rather than declaring that wrapper successful. For st6, the original
report's candidate and archived completion were authenticated before a new
independent replay; it is not a continuation of that archived original run.

The native contract case is deliberately specific to an existing public USB
input contract. The general `config/stop-behavior-only.json` runs the complete
original public suite. The st6 PASS additionally uses the optional composed
check configured in `st6-report-r3-v8/stop-policy.json`; the general profile
alone is not credited with this result. This adds a native check to the
existing Stop, not another model review stage or a general inference engine.

Final auditable evidence, relative to the evidence root below:

- `completion-evidence.json`: checked scores, patch hashes, before/after
  contract output, actual correction IDs, source/package and qualifications.
  `finalize-evidence.mjs` rechecks those bindings without running models.
- `st2-frozen-v4-repair-r2/grade-recovered-repair/results.json`:
  complete/executed/resolved true, candidate SHA256
  `c4c68617122400d26013792fa0fb230154135e04782364d359ae096e4dd186dd`.
  Its `completion-audit.json` and `recovered-repair/receipt.json` preserve the
  real corrective session and the original wrapper failure. The old CLI
  manifest's `privateModel` label says v4-flash; both actual private review
  transcripts record `deepseek-v4.1-flash`, which is the effective-model
  evidence used here.
- `st6-report-r3-import/grade-before/results.json` and
  `st6-report-r3-v8/grade-final/results.json`: complete independent before/after
  grades. Final candidate SHA256
  `72d50453f1d9bf36a8bfc242346406c760676483732442a60d5e58eb3d3d8c68`.
  `st6-report-r3-v8/result.json` records actualBusinessStart,
  infrastructureComplete and nativeStopSettled all true, one correction and
  the accepted final review. Before/after source, feedback, native reports,
  effective configuration and failed earlier runs remain available.

Acceptance:

- security_tool_2: F2P 2/2 and P2P 746/746 in an independent full evaluator.
- security_tool_6: F2P 7/7 and P2P 617/617 in an independent full evaluator.
- Each result must identify the exact RC source/package and show actual Stop
  review, feedback delivery and repair, with before/after artifacts.
- Full business runs start from the task's original base, without hidden tests
  or gold supplied to the business or Stop reviewer. Historical failure replays
  are development evidence, not fresh end-to-end results.

Extension requested on 2026-11-09: add security_tool_1 and security_tool_7
with the same full independent PASS gate. Required scores are respectively
F2P 1/1 + P2P 611/611 and F2P 5/5 + P2P 673/673. Preserve the same isolated
worktree, Stop-only policy, public-input boundary and read-only hosts. Started
with the validated v8 package and fresh tasks from their exact original bases.
The existing release driver now permits st7 as well as st1/st2/st6; workflow,
models and checks are unchanged. Evidence root for this extension:
`C:/Users/user/workspace/program_workspace/Experiments/rc-stop-contract-20261109-st1-st7`.

**Extension verified: both final candidates pass with the same v12 runtime
package**, source `9d40ac8`, SHA256
`a8a635c0b19db84756893b5cd509f0156e48535ae95a9eadd64647e3a06e3a5f`.

- `st1-fresh-v12`: real fresh run from the original base; first draft and
  final candidate independently pass **1/1 + 611/611**, zero corrections.
  Actual proposal Stop `stop-skip-5ce4e63e6985329633a3088e` settled
  `STOP_DOCUMENT_ONLY_CHANGES` with **zero reviewer requests**. The following
  real code-stage Stop scanned all three selected objects and settled
  NO_DEVIATION_FOUND (`stop-2ea9249b37d8ffe8bbd19725`). Final candidate SHA256
  `d8ac51ec6738382960a86625c019237f01c602631ccd4925fadc13f0422f089e`.
- `st7-frozen-v12`: exact failing 2/5 candidate, one real automatic repair,
  independent full PASS **5/5 + 673/673**. Final candidate SHA256
  `19b2365d65d070a2409180941ca128ec484947a2cf207b800d5da2fc4e72359d`.
  The optional native requirements check runs within the existing Stop,
  independently of the original suite, and improves **4/8 -> 8/8**.
- `completion-evidence.json` binds the same package, candidate hashes,
  full before/intermediate/after grades, actual feedback, model edit receipts,
  final review and complete runtime verification. The v12 runtime bytes are
  identical to the full-suite-verified v10 package; subsequent commits add
  only the benchmark runner/probe and evidence documentation. No installation
  or push was performed.

The st1 result is a fresh case, and st7 is a targeted frozen replay with real
model-authored repair. The latter uses the configured public requirement
probe, so this does not establish a fresh-run success rate or automatically
generalize to other tasks. The earlier failed scores and retries are retained.

The 2026-11-09 extension for `soduku-harmony_11` and `security_tool_9`
reached full independent PASS with the same v12 runtime package (source
`9d40ac8`). Both fresh code turns finished naturally, and both proposal
turns recorded `STOP_DOCUMENT_ONLY_CHANGES` with zero reviewer requests.
Their first Stop reviews settled `NO_DEVIATION_FOUND` despite incomplete
independent target scores. The two actual candidates and business transcripts
were authenticated and frozen for separate Stop replays.

- `soduku-harmony_11` improved from **8/10 to 10/10 F2P** with **288/288
  P2P**. The public placement probe exercises both diagonals through
  `isValidPlacement` and includes standard-mode and non-conflict controls.
  The actual Stop repair made the public predicate and generation use the
  active topology. The native probe improved from **2/4 to 4/4**, and the
  original public suite passed **289/289**.
- `security_tool_9` improved from **6/7 to 7/7 F2P** with **670/670 P2P**.
  The public probe exercises the direct Bluetooth dispatch rejection and
  the policy-save entry point with the task-start dispatch substitute,
  plus a USB save control. The actual Stop repair rejects Bluetooth before
  persistence. The native probe improved from **2/3 to 3/3**. The restored
  original suite retains its old Bluetooth assertions and test ordering.
  The two original dispatch rejection cases pass **2/2** alone and both
  fail when run after the original ACL tests, reproducing the mock leakage.

Each replay delivered one real Stop correction with an `ok` repair terminal.
Both replay summaries retain `state=failed` and
`STOP_REGRESSION_CHECK_UNVERIFIED` for the initial regression disposition.
Both final Stop records settled `NO_DEVIATION_FOUND` and the independent
evaluator ran each repaired patch to completion. The package and patch hashes,
initial and final grades, native check outputs and repair receipts are in
`completion-evidence.json` under
`C:/Users/user/workspace/program_workspace/Experiments/rc-stop-contract-20261109-sod11-st9`.

On 2026-11-09, each of the six cases started once from its original task
commit using the Stop-only policy and the package built from `61d98d6`.
The archive SHA256 matched the verified v12 package
(`a8a635c0b19db84756893b5cd509f0156e48535ae95a9eadd64647e3a06e3a5f`).
The runs for st9, Sudoku-X, st6 and st7 included their public probes.

- `security_tool_1` passed with **1/1 F2P** and **611/611 P2P**.
- `security_tool_2` passed with **2/2 F2P** and **746/746 P2P**.
- `security_tool_9` passed with **7/7 F2P** and **670/670 P2P**.
  The final Stop recorded `UNVERIFIED` with `STOP_REVIEW_INCOMPLETE`.
- `soduku-harmony_11` scored **0/10 F2P** and **288/288 P2P** from its
  interrupted code-turn checkpoint. The host reported a patch error and the
  final export failed while staging the missing test path. The grader used
  the saved checkpoint from that same turn and verified its patch hash.
- `security_tool_6` passed with **7/7 F2P** and **617/617 P2P**.
- `security_tool_7` failed with **4/5 F2P** and **673/673 P2P**. The public
  firewall probe passed **8/8** and the final Stop recorded
  `NO_DEVIATION_FOUND`. Independent scoring found a failure restoring the
  previous rules, deployments and mode after a failed switch.

The six scored patches include four passes, one failed completed run and one
interrupted checkpoint. Their totals are **21/32 F2P** and **3605/3605 P2P**.
The scoring records and candidate hashes are indexed in
`C:/Users/user/workspace/program_workspace/Experiments/rc-stop-contract-20261109-six-once/batch-results.json`.

Extension development evidence:

- Both native evaluator controls completed. st1 base is 0/1 + 611/611;
  reference control is 1/1 + 611/611. st7 base is 0/5 + 673/673;
  reference control is 5/5 + 673/673. These controls run separately from all
  business and reviewer sessions, which receive only the public request/source.
- `st1-fresh-v1` completed its real proposal and code stages from the original
  st1 base `83eb89433333eb9b5c84e8d784480e77fa8d610d`.
  Both independent first-draft and final grades passed 1/1 + 611/611;
  final patch SHA256
  `d0e1b46d2f53f4f4a1461d307ff744dafc9fc69e628f7a78159551c382b3d649`.
  The implementation changes the existing password-length option constant;
  Stop found no production deviation and admitted zero corrections. This is
  a fresh full PASS using the existing RC version, not evidence of a repair
  gain caused by Stop. The local suite's two pre-existing logging-repository
  failures persisted without new failures; the complete independent oracle
  still passed all 612 expected tests.
- The document-only proposal Stop ended UNVERIFIED / STOP_NO_REVIEW_SCOPE;
  its rejected attempts to register process/doc requirements as M16 are
  retained. The subsequent actual code-stage Stop settled
  NO_DEVIATION_FOUND (`stop-78313e987d1958a132af129e`), with all three selected
  objects scanned. The deviation-only rollup also retains
  `verificationIncomplete: true`; the PASS claim comes from the separate
  full evaluator, not treating NO_DEVIATION_FOUND as a full test verdict.
- `st7-fresh-v1` starts with the same validated package and Stop-only policy.
  No new generic analyzer or task-specific contract fixture has been added
  for either extension case.

The fresh st7 run exposed a scope defect before production implementation:
its proposal-completion Stop reviewed the design, requested a document repair
and consumed one correction. `enabledStages: []` leaves the compiler's active
artifact list empty, but retains all declared workflow paths in
`configuredArtifacts`. Task-change ownership had used only the active list,
incorrectly transferring the disabled workflow documents to Stop. Preserve
the existing declared-path ownership using that retained metadata, with the
existing active-list fallback. Explicit review exclusions and the existing
document-quality/declared-metric Stop gates are unchanged.

The regression test loads the actual default project configuration with
disabled stages, verifies the declared paths still exist, and exercises a
document-only Stop followed by a real business-code edit. Before the fix it
incorrectly called the reviewer; after the fix it skips the documents with
no reviewer or correction budget and still reviews the later code. Rejected
red result: `disabled-doc-stages-red.log`; ownership and original-regression
integration checks after the fix: **27/27 pass**
(`disabled-doc-stages-green.log`). The existing v8 run stays intact; the
corrected package requires its own verified trial.

Scope-fix source `c8a3bb4` completed the full RC suite: 299/299 files,
3,066 pass, zero failures/timeouts, 46 skipped (`rc-tests-v9.log` and
`rc-tests-v9-verification.json`). Package SHA256
`f4949ad9ff16d4624145df2b8d3191d8df258fa9d8cd51cbc6e6ce407fde7320`.

The untouched v8 st7 trial finished naturally with a settled final Stop
NO_DEVIATION_FOUND, but both independent first-draft and final grades are
**2/5 F2P + 673/673 P2P, FAIL**, exact candidate SHA256
`d1335f39800d478f7b34737fd1815b42340ff475e8774563ce9d91c1847dd249`.
The two service targets pass; the ViewModel still emits the rejected action's
busy label for cross-operation guards and skips the confirmed-state reload
when its awaited operation rejects. These contradictions are visible in the
public original request and current producer/caller source. The grader's
tests, assertions and outputs are not supplied to the business/review model.
Its local updated suite passed 680/680; the restored original suite's sole
old no-save assertion was explained against the authorized previous-mode
restore. That explanation does not certify the missing requested UI effects.

The existing rejection-vs-returned-failure/effect analysis instructions were
inside the full-PASS-only prompt branch, so the enabled deviation-only mode
never received them. Move that analysis into the common Stop instructions
without requiring full PASS traces in deviation-only mode. Add one general
check that an extended guard's output still identifies its actual pending
state and preserves the original state-to-output mapping. This first attempt
tries the existing reviewer with guidance alone, without another review stage.
Related Stop workspace, regression and ownership checks: **62/62 pass**
(`stop-guidance-v10-tests.log`).

`st7-frozen-v1` imports the exact completed v8 candidate using the existing
authenticated release-freeze importer, retaining the original successful
`agent.wait` terminal for code run `725f8ab8-aa26-495a-a9ee-46160da67e05`,
the complete main transcript and exact patch hash. Its import manifest
SHA256 is `b360c395f39fbfbec1969f7ef0d6daa3e9909213942de434dd22a754a9a67dc3`.
The next check is an independent frozen-candidate Stop replay with real
automatic repair, not a fresh task or a continuation of the completed v8 run.

The actual guidance-only v10 replay still returned NO_DEVIATION_FOUND, started
no business correction and independently reproduced **2/5 + 673/673** on the
identical `d1335f3...` candidate (`st7-frozen-v10`). Guidance alone did not close
the gap. Its runtime package source `bfb4ed0` completed all 299 RC test files:
3,066 pass, zero failures/timeouts, 46 skipped (`rc-tests-v10.log` and its
verification receipt). Package SHA256
`a8a635c0b19db84756893b5cd509f0156e48535ae95a9eadd64647e3a06e3a5f`.

Reuse the existing isolated native runner for one optional public task check:
`scripts/bench/probes/security-tool-firewall-state-contract.ets`. It derives
its inputs from the public failed-switch request and its stable messages from
the task-start ViewModel guards. Four controls exercise both original guards
and normal mode/toggle service calls. Three requirement cases exercise both
cross-operation rejections and confirmed-state reload after a thrown service
call. Each service method is mocked once in a separate native process, using
a mutable outcome holder rather than stacking SDK mock wrappers. The thrown
case catches only to inspect state effects; it does not impose a new exception
transport contract.

On both the untouched prepared original source and the exact failing
candidate, all **four controls pass**, and all **three new requirement cases
fail** with real assertions. This is deliberately a new-task requirements
check, not a claim that those new requirements passed on base or regressed.
The initial five-case fixture and output remain preserved; the final fixture
adds successful-service controls so a missed mock cannot masquerade as a
missing reload. Final probe SHA256
`83cc1b55059dbb8131e108e992e5651923e8ed951c6bf4a67af704a8e32de5d9`;
evidence `st7-public-state-{original,candidate}-r2.json`. No evaluator test,
assertion body or reference code enters this check.

The existing composed runner gains an explicit `--requirement-probe` mode:
keep the complete restored-original suite, then run this task check separately
without treating its original failures as exempt known failures. Compatibility
probes still require their hash-bound passing-control metadata. Existing
snapshot/evaluator checks pass **11/11** (`requirement-probe-tests-v11.log`).
The real composed execution reports the one explainable original-suite
assertion separately from the three missing requirement effects
(`requirement-composed-v11.log`), then returns FAIL. The optional launcher flag
`run-frozen.ps1 -RequirementProbe` configures this command inside the same Stop;
it adds no reviewer and makes no business-source edits.

The actual v11 replay (source `a80956b`, same runtime package bytes as v10)
accepted two original M16 deviations and delivered them at
`feedback-delivery/feedback-20261108T230617689Z-3334ee15`. Actual corrective
run `rc-stop-bedc5a0db4712796ddc9ec8da122a069795b9cee274d69ae69b6a889b470df49`
fixed both pending-state messages and reloaded confirmed state after a thrown
mode operation. Its 681 local tests and native build pass, the public probe
improves 4/7 -> 7/7, and both carried items receive accepted PASS receipts.
The final Stop settles NO_DEVIATION_FOUND, but the independent full candidate
grade improves only to **4/5 + 673/673, FAIL**. Its remaining target has a test
error on the exceptional ViewModel path; production still rethrows after
reload. Candidate SHA256
`fbc5da166158acb97bd475ecea426c24377c322bef240738e4eddea530992b32`.

Check the existing `FirewallOperationResult.success` contract separately
from state reload. The positive mode control now also verifies the existing
returned-failure path and confirmed-state reload. The new requirement case
expects a handled mode failure to return a failed operation result without
prescribing error text or copying an evaluator assertion. The public task
defines thrown operations as failed switches; its existing production caller
consumes the result's success flag. The initial seven-case probe deliberately
did not test this transport effect, and the v11 full grade remains preserved.

With the expanded public fixture, the untouched original source completes
with all four controls passing and four new requirement cases failing. The
exact v11 model repair completes **7/8**, failing only the new result-port
case, despite confirmed-state reload now passing. Evidence:
`st7-public-state-original-r3.json` and `st7-public-state-repaired-v11-r3.json`;
fixture SHA256 `2e45c353331bd7dc583db1754af5bff5fda12a0b0c1c943c9f0f2cc3b5f6f444`.
The next independent replay retains the authenticated original `d1335f3...`
candidate and uses the expanded requirement check. It requires a real model
repair and a complete 5/5 + 673/673 independent grade to close the extension.

The v12 review accepted three original M16 deviations covering the two
mutual-exclusion directions plus both exceptional mode effects: confirmed
reload and the existing failure result. Feedback was delivered at
`feedback-delivery/feedback-20261108T232743018Z-b0a228ca` in
`biz-d4f7e921d42f/.runtime-correction/tasks/oc-scope-0fc26a1c-22b3-4377-84e2-2f06ab7d6216`.
Its actual corrective run
`rc-stop-bedc5a0db4712796ddc9ec8da122a069795b9cee274d69ae69b6a889b470df49`
has the same deterministic identifier as v11, but a separate isolated project,
task and feedback receipt. The model corrected both messages, attempted the
confirmed reload and returned a failed `FirewallOperationResult` on the
exceptional mode path. Its native build and all 682 local tests passed.
All three carried deviations received accepted PASS receipts; raw rejected
citation/condition submissions remain in the logs. The original suite still
has only the explained old no-save assertion; the separate eight-case check
passes completely. Final Stop settled NO_DEVIATION_FOUND, then the full
independent evaluator executed and resolved all 678 expected tests.

First changes:

1. Enable existing regression execution, using original public test assertions
   in an isolated sibling workspace rather than modified assertions.
2. Review exact changes against existing callers and test substitutes; preserve
   unchanged behavior only where the original request did not change it.
3. Review completed runs with a tool-warning terminal, using exact-run completion
   evidence while retaining interruption/error handling.
4. Use the existing isolated native OpenClaw/OpenSpec harness and full evaluator.
   Pin host deepseek-v4-flash and reviewer deepseek-v4.1-flash as in the reports.

Policy: `config/stop-behavior-only.json`. M16 is the enabled Stop metric;
original user requirements remain available through originalRequirementsBasis.
Original-requirements recording is not document correction.

Evidence root: `C:/Users/user/workspace/program_workspace/Experiments/rc-stop-contract-20261108`.

The following is the preserved development log; intermediate failures and
incomplete results are historical observations, not final outcome claims.

Verified development evidence:

- Source checkpoint `6d4dfaa`: 298 RC test files completed; 3,053 pass,
  zero fail, 46 skipped. Log: `rc-tests.log` under the evidence root.
- Harness checkpoint `5b26355`: checkpoint plugin entry declaration fixed;
  a real Gateway loaded the observer and both pinned model definitions with
  zero model requests (`observer-preflight/result.json`). Affected checkpoint
  and business-terminal tests: 10/10 pass.
- `st2-calibration/results.json`: original base F2P 0/2, P2P 746/746;
  reference control F2P 2/2, P2P 746/746. Actual native runtime results.
- `st2-fresh-v1`: preparation failure before any model request, retained in
  `st2-live-v1.log` and `provider-boundary.json` (requests=0). Not a scored run.
- `st2-public-replay/result.json`: the historical 85757c3 st2 r2 patch, replayed
  without hidden tests, fails six of 747 original public tests. This demonstrates
  an executable regression signal; the reviewer must still compare each failed
  assertion with the original requested behavior. Full logs and the isolated
  original-test workspace are retained beside this result.

Fresh full st2 run: `st2-fresh-v2`, pinned package `release-v2/release.json`
from source `5b263551d1b30469159426c789cb9fd388b85a02`.
Launcher: `run-case.ps1`. It grades the first production draft and final patch
in a separate evaluator after the business/Stop loop ends.
No fresh PASS has been established yet. st6 starts after verified st2 PASS.

Fresh st2 evidence so far:

- The business completed its first implementation after one successful
  same-run context-compaction recovery. Its modified public suite passed
  749/749 and its HAP build succeeded.
- The actual Stop's original-assertion check then failed 6/747 tests
  (`sc-b/rc-regression-zTf0ts.result.json`). Its untouched production snapshot
  is retained at `sc-b/rc-regression-zTf0ts`.
- Independent full first-draft grade: F2P 1/2, P2P 741/746, FAIL
  (`st2-fresh-v2/grade-first-regression-draft/results.json`). Recovery of the
  first draft uses only the production tree already saved by the real Stop
  check, with a separate index; `recovered-first-draft/receipt.json` records
  the source snapshot and patch digest.
- Stop delivered a concrete production-path deviation: the new refresh logic
  was only in `refreshApplicationList`, while the UI still used the unchanged
  `refreshAccountsAndApplicationList` path. Corrective run
  `rc-stop-0862d0eb8ae4ae914367acc09bbf098e1eeed0d5cacd695450566544f724354f`
  is in the same business session. Full feedback is retained in the project
  `feedback-delivery/feedback-20261108T160554543Z-5447023a` directory.
- Lifecycle follow-up source `4bc9c14`: 85 native lifecycle/Stop tests pass,
  including the actual `agent_end` event shape without message stopReason.
  `observer-preflight-v3/result.json` additionally proves a before-finalization
  snapshot through the real hook runner, with zero model requests.

The v2 full run finished but did not pass. Its first repair removed the public
`refreshApplicationList` method. The original suite then could not compile;
Stop nevertheless returned NO_DEVIATION_FOUND. The final independent evaluator
also could not execute its tests (compile failure, not 748 observed failures).
Evidence: `st2-fresh-v2/grade-final/results.json` and the second actual Stop
snapshot `sc-b/rc-regression-Puw5lJ.result.json`.

The next candidate reuses the bounded task-start test excerpt collector from
`05d061e` (at most 12 KiB of edited/deleted original test cases), and adds one
failed-check disposition to the existing finish_stop_review tool. A reviewer
must submit a supported regression, cite original authorization for each
distinct changed assertion, or leave the check UNVERIFIED. It cannot finish
clean while ignoring a failed check. Original-versus-current source evidence
still controls whether an actual deviation is justified. New guard/evidence
tests and existing workspace review tests: 45/45 pass.

The native adapter's diagnostic filter was also dropping mixed-case
`Error Message: Property ...` compiler messages. It now retains those details
so a deleted API can be compared with the original caller.

Candidate `643daf6` verification:

- Full RC suite: 299 files, 3,057 pass, zero fail, 46 skipped
  (`rc-tests-v3.log`).
- Frozen read-only pilot `st2-guard-pilot-r2`: actual deepseek-v4.1-flash
  review now reports the standing regression: deleting refreshApplicationList
  breaks the task-start callers and yields eight ArkTS compiler errors. Saved
  assessment `stop-63841168bed967a8d95f7e59` is DEVIATION. This is diagnostic
  evidence, not a repaired or full-PASS business run. The shadow pilot's later
  terminal UNVERIFIED/STOP_ASSESSMENT_NOT_PUBLISHED does not negate or promote
  that saved assessment.
- Initial pilot `st2-guard-pilot` was stopped after its configuration incorrectly
  waited for the historical run in until_pass mode; its state and setup-stop
  receipt remain. The completed read-only replay uses assessment/shadow mode.
- The checkpoint observer now also records the exact successful agent_end;
  real before-finalization and completion hooks verified with zero model
  requests (`observer-preflight-v3c/result.json`), plus 10 checkpoint/terminal
  tests. This keeps a tool-warning terminal distinguishable from a real abort.

Fresh v3 (`2259b90`) completed both independent grades, with identical first
and final production patches: F2P 1/2, P2P 739/746, FAIL. The real observer saved
both the proposal and first implementation checkpoints. Its original-test
check completed 747 tests with eight assertion failures
(`sc-b/rc-regression-H1ETOu.result.json`). Stop returned NO_DEVIATION_FOUND and
EXPLAINED, treating the newly introduced service method as authorization to
bypass the existing mocked service entry point. No correction was started.
Full transcripts, explanations and independent results remain under
`st2-fresh-v3`.

The next minimal change clarifies the distinction between an obsolete expected
value and an unchanged assertion whose substitute boundary is bypassed.
Adding a helper or needing fresh data does not itself authorize changing that
boundary; equivalent effects after remocking are not compatibility evidence.
This changes review guidance only and adds no new analysis framework. Existing
regression/workspace-review tests: 45/45 pass (`seam-guard-tests-v4.log`).
The same captured v3 candidate will be replayed to isolate this review change
and preserve a directly comparable before/after evaluation.

st2 now has a full independent PASS after one actual Stop-driven correction
with source `0913b3e` (`release-v4`). The same v3 candidate was replayed in
`st2-frozen-v4-repair-r2`, using assessment mode to admit correction after the
historical turn, with documents/skills still disabled. The new review reported
the service-boundary regression, explicitly separated the one obsolete
refresh-policy assertion, and delivered feedback to the actual main model.
Its repair preserved `PermissionService.loadApplications` and moved policy
snapshot loading inside that service entry point. The actual original suite
then completed 746/747; only the intentionally changed assertion failed
(`sc-b/rc-regression-7JMpZa.result.json`).

The replay driver exited with `Frozen Stop started an unauthorized business
run` during final accounting. Saved events show all business calls belong to
the admitted correction; the extra IDs are the host's same-session native
context compaction. Both the accepted finish_stop_review receipt and final
NO_DEVIATION_FOUND assessment `stop-79253bdaa0f54ea399baf82d` were saved before
shutdown. The original driver failure is retained, not relabeled as a normal
completed fresh run. The small accounting fix excludes only native compaction
with the exact session ID, session key and native ID format; other starts are
still rejected. Existing completion and frozen-order tests: 13/13 pass
(`frozen-compaction-tests.log`).

`capture-frozen-repair.mjs` retained the actual repair using a separate index.
It verifies changed production bytes against the real Stop snapshot and the
published assessment's file hashes before grading. Independent evaluator:
F2P **2/2**, P2P **746/746**, complete/executed/resolved **true**.
Evidence: `st2-frozen-v4-repair-r2/grade-recovered-repair/results.json` and
`recovered-repair/receipt.json` (patch SHA256
`c4c68617122400d26013792fa0fb230154135e04782364d359ae096e4dd186dd`).
Compared with its unchanged source candidate (1/2, 739/746), the actual Stop
feedback and model repair recovered the target behavior and all regressions.
This is a frozen-candidate repair result, not a new fresh full business run.

st6 preparation starts only after this verified st2 evaluator PASS.

st6 first fresh run (`147bc62`, same plugin archive as `0913b3e`):

- Calibration completed: base F2P 0/7, P2P 617/617; gold control 7/7,
  617/617. Original project-local suite has 615 tests; the frozen evaluator's
  regression group has 617. Both controls executed completely.
- `st6-fresh-v1` completed the two original OpenSpec stages. Its modified
  local suite reached 621/621. Actual Stop's task-start suite completed
  612/615, with three assertions affected by the new auto-deny behavior
  (`sc-b/rc-regression-PeILfv.result.json`).
- Stop reported a concrete original-requirement deviation: the USB path
  overwrote an existing explicit allow policy with auto-deny, although the
  request limits auto-deny to devices without an explicit policy. Feedback
  `stop-42656447a96b46304f2e7641` started actual corrective run
  `rc-stop-05ab855f4fc772475e01fb5e416209992886271c15d5d86089ae95a15345e8f4`.
- The repair's new whitelist cases initially failed; the business then
  introduced additional production dependency hooks and changed its test
  substitutes. Its modified suite finished 623/623, and the passive observer
  retained exact before-finalization and successful agent_end receipts.
- Post-run state then held at HOST_RUN_RECONCILIATION_ESCALATED, without
  starting the next review. A later root-agent diagnostic probe used an
  unsupported dynamic import in inspector cleanup, terminating the isolated
  Node process. This is an agent operation error, not a business or benchmark
  test failure. `run-failure.json`, raw logs and both model checkpoints are
  retained. No final Stop acceptance is claimed for this attempt.
- Independent full grading of the untouched checkpoints: first draft F2P
  1/7, P2P 616/617; actual whitelist repair F2P 1/7, P2P 617/617. Both are
  complete/executed FAIL. Whitelist compatibility recovered, but six target
  cases remain failed. Evidence is in `st6-fresh-v1/grade-first-draft` and
  `grade-after-repair`; no evaluator test or expected answer was passed to
  the business model.

The next small changes retain the original service/repository boundary at
call time, including function-valued static fields and new production test
hooks. Runtime recovery now allows the exact owned corrective run to resume
after its genuine public terminal arrives, without resending any business
request. Two reproductions cover a late agent_end and explicit recheck. The
native drain wait has its own bounded five-minute minimum because context
compaction can outlive the shorter hook window; a successful agent_end still
does not replace the public terminal. The full driver now saves existing
terminal-observer events as they arrive. Related tests: 33/33 pass
(`late-drain-tests-v5.log`). st6 has not passed yet.

The first v5 full suite invocation omitted `--openclaw-host`, so 19 files
failed to load the installed public tool validator; all 19 pass when rechecked
with the explicit read-only host root and English locale. The original log,
recheck results and aggregate audit are retained. A clean full invocation with
the proper host setting is required for the final verification record; no
implementation change was made to conceal those configuration failures.

The correctly configured full suite has now completed on `799de60`: 299/299
files, 3,060 passed, zero failed, 46 intentionally skipped, zero timed-out
files (`rc-tests-v5-configured.log`). `release-v5` is pinned to that source and
archive SHA256 `2990be68d5ccbbf98583f4c2c2694b6c47c654fc66e4096890fb5db6e82d3f34`.
Fresh st6 retry `st6-fresh-v2` uses that package and the same model roles,
original-requirements workflow and Stop-only overrides. No prior business fix
or evaluator test was copied into its new original-base workspace.

Fresh st6 v2 ended early with the real host error "Agent couldn't generate a
response". The host recorded an incomplete turn at stopReason=toolUse after
59 tool actions, with zero compactions; no completed implementation checkpoint
or final Stop acceptance exists. The strict terminal rule correctly retained
HOST_RUN_NOT_COMPLETED. Its partial candidate's complete independent score is
4/7, 615/617, FAIL (`st6-fresh-v2/grade-final/results.json`); this is not a
completed business run.

Use the existing genuine-session continuation path to finish that work. A
sealed schema adapter in `st6-v2-resume-input` keeps the actual error terminal,
original 064ce248 session history bytes, original task binding and authentic
Stop ledger; actualBusinessStart is derived from the captured exact-run model
start, not from a presumed completion. It verifies the frozen Git commit,
candidate/transcript hashes and original 615-test baseline. A frozen current
HEAD remains distinct from the original prepared HEAD, preserving task-start
assertions. No new implementation hint or evaluator result enters the resumed
business prompt.

The continuation CLI now honors the explicit host-profile model/role options
outside the frozen experiment mode, accepts an authenticated frozen current
HEAD while retaining the original baseline commit, and reuses the passive
business checkpoint observer. Related restoration/profile tests: 11 pass,
one optional test skipped (`resume-compat-tests.log`). The corrected no-model
preflight verifies the pinned artifact and resume binding
(`st6-v2-continuation-preflight-r2`). Initial preflight omitted those arguments
because of PowerShell array concatenation; its no-model record is retained.

The genuine continuation completed its first main turn with actual agent_end
success, 621/621 modified local tests and a successful build. The longer native
drain reached REVIEWING without a new business request. Its immutable full
checkpoint is `st6-v2-continuation-1/checkpoints/b68a38ce-5ad2-4f42-a386-790a5d69765f`
(SHA256 `963ad31994cd4d4d267152feb0f5e7176530316c242126ed842c10e928fa31a8`).
Independent grading before Stop correction completed: F2P 4/7, P2P 615/617,
FAIL (`grade-before-stop/results.json`). Actual Stop assessment
`stop-7a57560285d99e3201e2db82` found that USB auto-deny still overwrote an
explicit allow policy and admitted corrective run
`rc-stop-ecc3844087445bd8b2714ff6208e67e598bb50f26c4453709699443c5a8d8585`.
No independent evaluator result was supplied to that model.

Continuation capture must diff against the original prepared commit, not a
later frozen HEAD containing an interrupted implementation. The CLI now uses
`preparedHead` for both complete workspace and scoped candidate patches and
records that base in the scope receipt. It also preserves the authenticated
`resumeHead` for another genuine continuation. The current already-running
process still uses the earlier exporter; retain its raw output and grade and
recover the complete candidate from its passive full checkpoint if necessary.
Candidate/export/inherited-scope/checkpoint/resume tests: 11/11 pass; script
syntax and diff checks pass. This is an evidence-capture fix, not a business
implementation change or a claim that st6 has passed.

The actual first Stop repair's full checkpoint
`checkpoints/8c4f4fec-7920-463d-9931-d338066bb065` independently scores F2P
4/7, P2P 616/617, complete/executed FAIL (`grade-after-first-stop/results.json`).
Its public changed tests cache `ORIGINAL_DISPATCH` and route service assertions
through that saved function after adding static mocks in other suites. This
can conceal an un-restored canonical service entry point from later callers;
the code of the installed mock library and actual cleanup need inspection.

The next review change is limited to the standing REGRESSION item: changed
test source may establish shared production-state pollution when paired with
the prior caller/assertion it breaks. Production implementation obligations
still reject test-only proof. Guidance explicitly asks the reviewer to check
real cleanup semantics and masked state leaks instead of trusting a method
named `clear` or `reset`. A native Stop protocol reproduction verifies both
the accepted regression report and the rejected test-only production claim.
Related regression/proof tests: 47/47 pass
(`test-state-leak-review-v6-r2.log`). The initial test fixture incorrectly used
a nested Node test runner; its failure is retained in the first log. The
corrected fixture explicitly calls the canonical method after loading the
polluting test setup.

The v5 continuation driver settled with actual business completion **true**
and infrastructure completion **true**, but final verification UNVERIFIED /
BASELINE_INPUT_CHANGED. The reviewer recursively searched the live experiment
output parent for `baseline-local-tests.json`; subsequent directory changes
correctly invalidated that search inventory. Its final prose is not an accepted
Stop verdict. The raw HEAD-delta candidate then failed to apply in the full
evaluator, as predicted by the capture issue above; that original export and
failed grading log remain intact. The independently graded passive full
checkpoint remains 4/7, 616/617.

The existing pending-RC continuation path can retry this unresolved review
with exact history and task binding. `st6-v2-pending-review-input` supplies only
the earlier CLI's omitted frozen-HEAD metadata, verifies the current full patch
against the passive checkpoint SHA256, and retains the authentic ledger
(used=1, no open Stops or reserved admissions, no budget reset). The review
guide now directs an exact read of a configured public baseline path instead
of searching its shared live output parent and explicitly excludes hidden
tests/reference solutions/independent grades from review inputs. Related
workspace-review tests: 35/35 pass (`bounded-baseline-navigation-v6b.log`).

Full RC suite completed for the shared-state review change: 299/299 files,
3,061 passed, zero failures/timeouts, 46 skipped (`rc-tests-v6.log`).
The first pending-verification continuation (`st6-pending-v6b`) preserved the
implementation and ran 622/622 local tests, but did not start a new private
review: its post-run record says STOP_NOT_REQUIRED. Its independent full
grade remains 4/7, 616/617, FAIL. The new package alone cannot be credited with
a review that never ran.

The runtime had re-armed a read-only continuation only after
STOP_SESSION_MIGRATION_REQUIRED, leaving an interrupted search-evidence review
unresolved unless a business source edit happened. Extend that existing retry
path specifically to BASELINE_INPUT_CHANGED on a genuine new user turn. Reuse
the original registered Stop retry signal so the completion-text classifier
cannot silently skip the retry. This case retains ordinary execute-and-correct
mode and the existing ledger; migration retains verification-only behavior,
and accepted work still triggers no extra review. Native Stop/dispatcher tests
pass 93/93 (`interrupted-review-retry-v6c-r2.log`), including a stopped task
with no new source edits. The first incomplete retry reproduction remains in
the prior log rather than being overwritten.

The correctly configured full suite on `cba82d7` completed 299/299 files,
3,062 pass, zero fail/timeouts, 46 skipped (`rc-tests-v6c.log`). The actual
`st6-pending-v6c` continuation restored used=1 unchanged, started a new private
Stop, and admitted a real second correction after the review found the
unconfigured USB READ_ONLY path returned before first-connect auto-deny.
This establishes that the repaired retry reaches normal correction admission;
it does not establish an independent evaluator PASS.

One-off native toolchain probes use numeric toy classes in separate project
copies, without any task/evaluator cases. Synchronous and asynchronous static
method replacement both work through canonical, direct-caller and function-
value invocations. Replacing the same method twice, then calling MockKit.clear
and clearAll, leaves a wrapper returning undefined instead of the original
value. The extended probe completed with two passing observations and that
one intentional contract failure. Evidence is outside the model workspace at
`Experiments/rc-native-static-call-20261109[-extended]/receipt.json` and
`probe.ets`. This is SDK cleanup evidence, not a business score or proof of
the cause of a particular benchmark failure.

The next small review improvement keeps related missing/empty/invalid-input
cases visible within the existing eight-case navigation budget; heavily
edited ordinary cases must not consume every pointer. It also makes explicit
that one obsolete assertion cannot retire the later, still-applicable
assertions in the same test, including unchanged result fields. No additional
reviewer, analyzer or execution framework is introduced. Regression/proof
tests: 18/18 pass (`boundary-contract-navigation-v7.log`).

`32adab6` full suite: 299/299 files, 3,063 pass, zero fail/timeouts,
46 skipped (`rc-tests-v7.log`). Actual outcomes still require a stronger check:
`st6-pending-v6c` finished with NO_DEVIATION_FOUND after its real READ_ONLY
repair, but independent grading remains 4/7, 616/617. Source/trace-preserving
import of the original report's RC st6 r3 candidate independently reproduces
7/7, 616/617 (`st6-report-r3-import/grade-before/results.json`). The import
verifies the archive, exact session bytes and five official candidate source
files. Its archived native completion receipt is explicitly distinct from a
new agent.wait reply; this is an independent frozen-candidate experiment.
`st6-report-r3-v7` completed its actual review with NO_DEVIATION_FOUND, no
business repair and the unchanged 7/7, 616/617 score. Guidance alone did not
close the implicit-contract gap.

Add one optional public contract check, using the task-start missing/empty
payload input and assertions with a successful dependency outcome. Native
positive control on the untouched prepared production source: **1/1 PASS**;
the exact same case on the original report candidate: **0/1**, actual
`device_deny` versus pre-existing `default_allow`. This uses no evaluator
case, hidden expected answer or reference implementation. Evidence:
`st6-public-contract-calibration-r2/{baseline,original-run,candidate-run}.json`;
probe SHA256 `98aede300e6cdfbe9ea89d87a523d78bef0d6f375f9a92736880fcdd7ff885d4`.

The supplied ArkTS contract case runs in its own native process and snapshot.
An initial appended-case calibration failed even on base because earlier
public-suite mocks left getAll returning undefined; that rejected control is
retained under `st6-public-contract-calibration`, not counted as a candidate
regression. `arkts-stop-contract-check.mjs` composes the existing complete
original suite with this independent check, binds both baselines to the same
prepared commit and the probe bytes to their recorded SHA256, and retains both
real outputs. Baseline/hash mismatches fail before native execution. Related
tests: 23/23 pass (`contract-probe-tests-v8.log`); the combined native check
reports the four intentional old-suite assertion failures plus the one new
contract regression (`contract-composed-check-v8.log`). The source workspace
and original suite remain unchanged; only isolated snapshots execute the case.

The first v8 full RC run completed 299 files with one timing assertion failure
and no file timeouts (`rc-tests-v8.log`): the sequential-role test observed
native model budgets [3978, 3736] ms while asserting each was at least 3900.
That assertion incorrectly charged this role's own initialization delay to
the preceding role. Measure initialization per role and assert that its
initialization plus remaining model budget retains the configured independent
window; a shared budget would still fail. No product deadline is extended.
All 71 native Stop tests pass on recheck (`private-role-budget-recheck-v8.log`);
retain the first failure and run a clean full verification after this test fix.

The clean full verification subsequently completed: 299/299 files, 3,111 tests,
3,065 pass, zero failures/timeouts and 46 skipped (`rc-tests-v8-r2.log`).

The actual v8 Stop accepted the public-contract failure and delivered feedback
at `feedback-delivery/feedback-20261108T201010964Z-6d8a2a46` in the isolated
business task. Corrective run
`rc-stop-ec7647f838c96d40955502e6b207442bc9f5a601923a2a6d1c049da9570d8bfc`
made the production guard and test changes. Its own suite passed 626/626 and
its native HAP build succeeded. The restored original suite still reports
the four demand-changed assertions (including shared-state interaction after
the now-required persisted Bluetooth deny); the separate calibrated contract
check changes from FAIL to PASS. The accepted final reviewer explains those
four assertions against the original request and production source, after
retrying rejected citation submissions. Those raw warnings remain in the log.

Final review `stop-e012bfe8a86a29c8ac91fdf9` settled NO_DEVIATION_FOUND. The
driver completed normally and the separate full evaluator then executed all
624 expected tests, resolving 7/7 F2P and 617/617 P2P. Its grader uses the
original evaluator assertions, not the model's revised tests. Final candidate,
grade and actual correction are bound by `completion-evidence.json`.
No business repair was manually patched, and no hidden test or reference
implementation was supplied to either business or Stop models. Hosts remain
unmodified; no installation or push was performed.
