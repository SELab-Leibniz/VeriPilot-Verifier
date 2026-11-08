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
