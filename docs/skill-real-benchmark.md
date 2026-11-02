# Real benchmark: Skill correction only

This profile exercises native Skill reading, constraint extraction, completion
review, feedback, actual business-agent repair and re-review. It uses five large
DeepSWE 1.1 tasks: SQLite import checkpoints, Kombu dead lettering, IPython session
bundles, Narwhals rolling windows and pwntools tube multiplexing.

**Result: no actual correction benefit demonstrated.** Five distinct tasks were
executed across nine real attempts, including the retained interrupted/failed
rounds. There were zero admitted business repairs. Four tasks produced completed
committed predictions; only SQLite passed its complete original verifier. IPython
and pwntools were accepted by Skill/M08 despite original benchmark failures.
The long-budget transport works, but detection and actual repair remain unproven.
Machine-readable evidence is in
[skill-real-benchmark-results-20261102.json](skill-real-benchmark-results-20261102.json).

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

Temporary HTTP 408/429/5xx responses wait and retry inside the same original
request rather than immediately ending the native run. Configure the delay with
`RC_EVAL_RETRY_BASE_MS` (default 30000) and `RC_EVAL_RETRY_MAX_MS` (default 120000).
Every actual upstream attempt, including failed attempts, consumes the same
2000-step case budget, and waiting consumes the original case wall time.
`relay.json` records every transport attempt and the total `upstreamSteps`.

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

| Task | Skill watcher | M08 / native outcome | Original F2P before → after | Repairs |
| --- | --- | --- | --- | ---: |
| SQLite checkpoints | PASS | PASS | 60/60 → 60/60 | 0 |
| Kombu dead lettering | PASS | UNVERIFIED: one unproven item | 73/76 → 73/76 | 0 |
| IPython session bundle | PASS | PASS, false acceptance against bench | 16/17 → 16/17 | 0 |
| Narwhals rolling windows | PASS; review says NOT_COMPLETED | UNVERIFIED: intermediate host terminal | N/A: no completed committed prediction | 0 |
| pwntools tube multiplexing | PASS | PASS, false acceptance against bench | 71/73 → 71/73 | 0 |

F2P refers to original fail-to-pass tests. A watcher PASS is distinct from a
completed business task and from the original benchmark reward.

The combined targeted regression suite has 96 passes and one skip. All prepared
cases passed zero-model preflights with actual 24-hour phase budgets and
2000-step review budgets. Real runs use the following frozen inputs:

| Prepared run | Attempt | Cases | Source |
| --- | --- | --- | --- |
| `skill-real-bench-20261102-002` | `skill-live-001` | All five | `d8bfc47` |
| `skill-real-bench-20261102-003` | `skill-live-002` | IPython, SQLite, pwntools | `d9369cd` |
| `skill-real-bench-20261102-004` | `skill-live-003` | Narwhals | `bc0eb38` |

All prepared runs are below `.runtime-correction/`. The first round retained
three original-run failures caused by provider HTTP 429; none had committed a
prediction, and their missing first-completion snapshots are not scored as zero
or a successful baseline. The retry version reruns those tasks serially from
their original pristine images.

The first Narwhals round repeatedly produced malformed extractor JSON. It was
explicitly interrupted for the syntax-diagnostic update, before its configured
budget expired. The new diagnostic quotes a small region around the JSON parser
error for the same private session; JSON/schema/source validation remains strict.
The next Narwhals round starts from the original pristine image.

Kombu's first completed prediction received a Skill watcher PASS, but the M08
completion review left one obligation UNVERIFIED because its evidence was not
established. No repair was admitted. The unchanged original verifier scored
73/76 fail-to-pass tests and 1412/1412 pass-to-pass tests, both before and after;
the patches were unchanged, so no correction benefit was demonstrated.

IPython's retry completed the full native Skill/M08 review with PASS, zero repair
admissions and all six Skill evidence gates satisfied. The original verifier
scored 16/17 fail-to-pass and 29/29 pass-to-pass tests both before and after. The
remaining failure was `test_session_bundle_magic_start_status_stop`; this is an
observed false acceptance relative to the original benchmark. No original
verifier output was fed back into the model. The unchanged patches demonstrate
no correction benefit, despite the successful review transport.

Narwhals's second round recovered a real 15-unit graph after the business agent
reread the Skill. Its native host then ended with `status: ok` but
`stopReason: toolUse`, while only three files had uncommitted edits. The Skill
review reported NOT_COMPLETED and M08 returned UNVERIFIED/FINDINGS_ONLY_SCOPE,
with no repair. This is an incomplete native turn, not a completed prediction.
Its raw grader rewards were zero on empty committed patches; those zeros are
not evidence about correction quality. The old harness incorrectly labeled its
host-terminal snapshot as a first completion. The runner now rejects such
intermediate terminals before taking a completion snapshot. Existing raw records
are retained unchanged and the summary marks `completedOriginalTurn: false`.

SQLite's retry completed all native evidence gates with Skill/M08 PASS, zero
repairs, a clean committed prediction, and original verifier reward 1. Both
snapshots passed 60/60 fail-to-pass and 1038/1038 pass-to-pass tests. It succeeded
on the first completed prediction, so the unchanged final patch demonstrates no
correction benefit.

pwntools completed the native review with all Skill evidence gates satisfied,
Skill/M08 PASS and zero repairs, after 296 actual upstream requests and about
51.5 minutes. It was not cut off at the old small request/phase limits. Both
original verifier runs passed 71/73 fail-to-pass and 1/1 pass-to-pass tests. The
remaining failures were `test_256kb_payload` and `test_concurrent_open_close`.
This is a second false acceptance relative to the original benchmark, with no
change between the completed and final committed patches.

All controllers and provider relays closed, and no Skill benchmark container
remains running. All four completed committed predictions had identical before
and after patch hashes. No score improvement or actual correction loop was
observed. The first-round 429 failures justified the bounded relay backoff change;
the serial retry rounds did not encounter another 429, so live recovery through
that retry path was not exercised. The new localized JSON syntax diagnostic has
a targeted regression test; the replacement Narwhals round did not produce the
same syntax error, so its effect on that model failure was not established.

The five-task sample uses different explicitly recorded frozen source revisions
while repairing the benchmark transport. It is a diagnostic pilot, not a
controlled RC-on/RC-off study. The results support investigating the missed
IPython magic lifecycle and pwntools payload/concurrency behavior, and the native
intermediate-terminal recovery, without claiming that larger budgets fix those
semantic or host issues. This run makes no general Stop-policy changes.
