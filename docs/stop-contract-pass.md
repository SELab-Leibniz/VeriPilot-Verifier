# Stop behavior and regression correction

Base: `85757c39d0f11c7651caf8681582cfedd2ff0657`.
Worktree: `rc-wt/stop-contract-pass`; branch: `codex/stop-contract-pass-85757c3`.

User objective: disable document and skill correction, optimize only Stop;
complete security_tool_2 first, then security_tool_6, with full evaluation PASS.
Reuse existing review and Huawei native test tooling; retain before/after tests,
feedback, source checkpoints, effective configuration and candidate patches.
MatrixAssistant and its bundled OpenClaw are read-only hosts.

Acceptance:

- security_tool_2: F2P 2/2 and P2P 746/746 in an independent full evaluator.
- security_tool_6: F2P 7/7 and P2P 617/617 in an independent full evaluator.
- Each result must identify the exact RC source/package and show actual Stop
  review, feedback delivery and repair, with before/after artifacts.
- Full business runs start from the task's original base, without hidden tests
  or gold supplied to the business or Stop reviewer. Historical failure replays
  are development evidence, not fresh end-to-end results.

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
