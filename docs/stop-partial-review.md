# Stop review with unresolved observations

A completed, current Stop reports DEVIATION if it confirms any deviation,
otherwise NO_DEVIATION_FOUND. Neither status claims every behavior was
verified. Individual unresolved requirements, regression cases, file-quality
checks and ambiguous original output paths remain local in unverifiedItems,
each with id, type and reason. They do not consume a technical failure or enter
host correction feedback.

An unfinished, cancelled, timed-out or stale review, changed baseline inputs,
empty scope, or a strict majority (more than half) of unresolved original
requirement items still yields overall UNVERIFIED. Standing regression and
advisory frame items do not enter the original-requirement majority. A carried
deviation closes only after its own current PASS; an unresolved recheck stays
open even when the overall scan finds no new deviation.

## Program regression triage

stopCorrection.regressionCheck retains command/cwd/timeout/output options and
accepts:

- baselineFile: immutable task-start JSON with completeRuntime: true and
  statuses keyed by exact public test ID. Original FAIL/ERROR becomes
  PRE_EXISTING_FAILURE.
- isolationCommand: argv containing {testId}. It runs that exact case alone
  in a fresh process and emits exactly one RC_REGRESSION_CASE line with JSON
  fields id, status: PASS, complete: true and observed: [that exact id].
  Only exit zero, exact singleton identity and completion establish
  TEST_ISOLATION. Shell interpolation is never used.

The full command can emit RC_REGRESSION_INVENTORY followed by JSON with
complete: true and failures: [{id,title}]. This preserves the complete
inventory independently of the bounded human-readable name list. Flat TAP and
the existing named report remain supported. Missing, ambiguous or truncated
inventories never establish an exclusion.

Baseline failures and isolated passes require no reviewer explanation.
Remaining cases accept AUTHORIZED_CHANGE, REGRESSION or UNVERIFIED and a
reason. REGRESSION must link a saved evidence-backed deviation. Missing
decisions remain unresolved. Isolation shares the original regression budget,
cancellation and deadline; it does not get a new review window.

## Mechanical citations and reports

Stop tools accept citations: [{path,start,end,sha256?}], issued citeIds, or
path#Lstart-Lend / path:start-end references. The program reads the file,
validates the range, binds its full-file hash and checks currentness through
publication. It does not require a prior session read, authorization quote,
full failure-output read, production-only proof, or mandatory production trace.
The reviewer owns whether evidence supports its decision. Original requirements,
scope ownership, baseline hashes and lifecycle protections remain program-owned.

Evaluation JSON, metric reports and the user report retain unverifiedItems,
regressionCheck, frameCoverage.items and reviewCoverage. Coverage stores each
reviewed subject in its denominator and its unresolved flag. Ambiguous output
paths share the owning requirement's denominator; program-triaged test failures
and individual frame items are included. unverifiedRatio is null for empty
coverage. Per-item records are authoritative when comparing runs; an overall
NO_DEVIATION_FOUND does not mean a zero unresolved ratio.
