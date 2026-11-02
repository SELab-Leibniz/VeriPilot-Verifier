# Real benchmark: Skill correction only

This profile exercises native Skill reading, constraint extraction, completion
review, feedback, actual business-agent repair and re-review. It uses five large
DeepSWE 1.1 tasks: SQLite import checkpoints, Kombu dead lettering, IPython session
bundles, Narwhals rolling windows and pwntools tube multiplexing.

DeepSWE provides public task instructions rather than Skills. The harness places
each original instruction verbatim below Skill frontmatter and asks the native
agent to read that Skill and complete/commit the original task. This is a
benchmark-based Skill diagnostic, with an explicit adoption wrapper, rather than
an unchanged official agent protocol or leaderboard score.

Only `skillCorrection` and its existing M08 terminal feedback transport are
enabled. Global ground-truth extraction, document correction, write-time
implementation correction and all other terminal metrics are disabled. Cases
receive no injected defect, replacement completion, forced reviewer finding or
manual business-code repair.

## Finite configurable budgets

`--timeout-ms` defaults to **86400000 (24 hours)** per case and accepts whole
seconds between 2000 and 86400000 ms. `--max-steps` defaults to **2000** and accepts
a positive safe integer. These are limits, not disabled timeouts or unlimited
execution. Smaller values can be used for shorter runs.

The wall budget propagates to the native business run, provider, registered
hooks, repair runs, private reviewers, completion assessment and stuck-session
detection. The agent runner audits the effective loaded budgets before model
dispatch. The isolated original verifier receives the remaining case wall time.
The controller allows two additional minutes for shutdown. Cases run concurrently
when requested; there is no separate suite-wide deadline.

`maxSteps` bounds actual upstream model requests across business, extraction,
review and repair for each case. The same value configures private review steps,
structured review attempts, format repair attempts, watch turns, feedback count
and repair admissions. Those secondary counters are not interchangeable with
model requests; the host relay is the overall model-request gate. No previous
96-request, 200-turn or one-hour phase cap remains in this profile. Normal
application defaults remain unchanged.

## Reproduce

Prerequisites: Docker, Node, Python 3.11+, the cached original task images, and
the pinned OpenClaw Node volume named in the host controller. The dataset checkout
must be at `427384f43d8001f2b14a82e99ace940cc234045a`.

```sh
npm run build:plugin
python3.12 scripts/prepare-native-skill-benchmarks.py \
  --dataset /Volumes/PortableSSD/projects/DeepSWE \
  --output .runtime-correction/skill-real-new-run \
  --timeout-ms 86400000 --max-steps 2000 \
  sqlite-utils-safe-import-checkpoints \
  kombu-virtual-queue-dead-lettering \
  ipython-session-bundle-replay \
  narwhals-rolling-window-suite \
  pwntools-tube-multiplexing
python3.12 scripts/run-native-skill-suite.py \
  --prepared-root .runtime-correction/skill-real-new-run \
  --parallel 3 --attempt live-001
```

The suite prompts for the GLM key without saving it. The real account key stays
in host process memory; task containers receive a disposable local relay token.
Agent containers never receive original hidden verifier files or reference
solutions. Original verifier files are byte-checked against the pinned dataset
and run in a separate network-disabled container after model execution ends.

The prepared inputs are frozen, including source hashes, image IDs, public
instruction, Skill and policy hashes. Future preparations omit repository reports,
tests and examples from the runtime source mount. An existing attempt directory
is never overwritten.

## Evidence and interpretation

Each attempt retains:

- `effective-budgets.json` and `policy.json`: actual loaded settings.
- `native-host/`, `project-evidence/`, `skill-evidence.json`: paired native Skill
  read/result, real extracted graph, private runs, evaluations and watcher state.
- `first-stop/`: committed patch at the first authenticated completion before
  any admitted repair; a missing snapshot stays missing.
- `model.patch`, `working-tree.patch`: final actual commits and any uncommitted
  work, saved separately; the harness never commits business work on behalf of
  the model.
- `skill-feedback-delivery.json`: findings correlated with actual outgoing model
  payloads and admitted native repairs.
- `result.json`, `process-exit.json`: authenticated original/repair terminals,
  settled private runs, completion gates, closed relay and process exit.
- `official-scoring/comparison.json`: unchanged original verifier rewards for
  the first-completion and final committed patches.

A harness PASS requires the real Skill read, a nonempty graph, native extraction
and Skill-review runs, a watcher PASS with original-source interpretation checked,
global baseline version zero, settled private runs and authenticated native
terminals. It does **not** imply the original benchmark passed. Review decisions
and original verifier scores must be reported separately. Before/after is the
same trajectory, not an RC-off comparison; unchanged patches show no demonstrated
correction benefit.

## Current run

Prepared run: `.runtime-correction/skill-real-bench-20261102-002`, attempt
`skill-live-001`. All five zero-model preflights passed with actual 24-hour phase
budgets and 2000-step review budgets. The combined targeted regression suite has
78 passes and one skip. Real benchmark results are pending.
