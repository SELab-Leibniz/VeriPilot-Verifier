# Isolated review module experiments

This directory intentionally tracks an explicit allowlist of experimental sources,
locked dependencies, source manifests and verification summaries. The enclosing
`.runtime-correction/` ignore rule continues to exclude all other runtime data.
Production Stop is not integrated with this module.
The local `.gitattributes` preserves exact bytes so Windows checkout newline
conversion cannot invalidate the recorded source hashes.

## Current checkpoint

- Production baseline when these experiments ran: `20ec5b5`.
- Executable module: `experiments/review-task/long/`.
- Exact earlier successful source identity: `source-snapshot-05-long/manifest.json`.
- Long-stage result and limits: `long-context-results.md` and
  `long-context-results.json`.
- Independent byte and semantic checks:
  `long-stage-live-02-independent-measurement.json` and
  `long-stage-live-02-semantic-review.json`.
- Earlier prompt/citation iteration: `iteration-02-review.md`.

The frozen source-04 worker preserves the first long-stage failure; commit
`73390e0` preserves the source-05 worker. The current worker additionally accepts
an optional trusted `promptAppend`; its empty default preserves the original
provider prompt byte for byte. Files named in the source manifests but absent from a
frozen directory are retained at the executable-module path. No source snapshot
is silently overwritten.

## Offline mechanism checks

Requires Node.js >=22.19.0. From the repository root:

```powershell
npm ci --prefix .runtime-correction/review-module-lab-20261024-02/experiments/review-task
node --test .runtime-correction/review-module-lab-20261024-02/experiments/review-task/long/checks.mjs .runtime-correction/review-module-lab-20261024-02/experiments/review-task/long/sdk-checks.mjs .runtime-correction/review-module-lab-20261024-02/experiments/review-task/long/memory-checks.mjs
```

The original checkpoint has 59 passing mechanism checks with scripted providers.
The prompt experiment adds three SDK checks (62 total), including actual provider
prompt preservation. These do not count as real-model quality samples. TAP files
are `verification-long-final-02.tap` and `prompt-accuracy-20261024-01/worker-regression.tap`.

## Real review stages and provenance

`kitchen-matrix.mjs`, `complex-neutral.mjs` and `long-stage.mjs` run review stages,
not end-to-end application development. Their default mode is offline preflight;
model access requires explicit `--live`. `harness-common.mjs` reads the already
configured provider without persisting credentials or changing host settings.
All output destinations must be new children of this lab directory.

Kitchen source and its verifier come from the tracked repository example, but
the historical kitchen harness also needs its separately retained frozen capture.
The complex and long-stage harnesses additionally require the existing read-only
local capture and earlier frozen lab workspace named in their inputs. Those
business snapshots and raw native sessions are deliberately not committed.
Consequently a fresh clone can reproduce offline mechanism checks and the curated
prompt-accuracy fixtures below. Historical kitchen/complex/long-stage replay needs
the separately retained inputs. Reports retain their local paths and hashes for audit.

The small `long-stage-live-01/report.json` and `long-stage-live-02/report.json`
files are immutable original summaries, not complete transcripts. The successful
raw report still says pending semantic review; the independent semantic report
and `long-context-results.json` record the subsequently completed verification.

Do not treat a successful review execution as business PASS: the controlled long
stage correctly concluded `DEVIATION`. It does not replace the original four
production metrics, which remain 0/4. Current limitations include conservative
CJK/indivisible-batch stops and no automatic cross-process worker restart.

## Metric prompt experiment

`prompt-accuracy-20261024-01/results.md` records the baseline, two candidate
iterations and frozen selection. Selected profiles distinguish decomposition,
acceptance coverage, source implementation and runtime evidence; all share one
read-only review engine. `experiments/review-task/prompt-accuracy/` contains the
review-stage runner, audit preparation and programmatic result collector.

Only curated fixtures, profiles, compact results and independent audits are
tracked. Raw provider sessions remain in the local ignored lab. No production
Stop route is changed by this experiment. See the prompt experiment README for
offline reproduction and the limits of the quality measurements.
