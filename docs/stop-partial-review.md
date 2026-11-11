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

Only a deviation requires evidence attachments. PASS, NO_DEVIATION_FOUND,
AUTHORIZED_CHANGE, UNVERIFIED and frame CHECKED decisions need no citation;
regression explanations may contain only their per-case verdict and text reason.
An optional invalid citation cannot reject a non-deviation conclusion.

The preferred wire format is `citations: [{path: "src/service.ts", start: 12,
end: 16}]`. The program reads the bytes and records their full-file hash,
the range and its exact excerpt. Tests, dependency source and runtime output
are eligible. Resolved paths must stay inside the project, or identify an
exact external original input already explicitly allowed by the program.
Path traversal and links that escape this scope are rejected mechanically.
There is no prior-read, read-coverage, evidence-owner/type, authorization-quote,
full-failure-output or production-trace gate on these attachments.

The first invalid deviation attachment returns TASK_CITATION_INVALID with one
repair opportunity. A second failure, or finishing without a repair, saves only
that proposal as a CITATION unverified item. Its siblings remain deliverable;
it is not a technical failure or an unresolved original-requirement majority.
A carried deviation with such a result stays open. Citations are checked again
at finish and publication; the host delivery gate also removes stale attachment
owners individually. A worker that has already ended is not restarted for this
safety check. Original input/baseline changes, cancellation, expiry and timeout
remain whole-review protections.

Migration: replace `citeIds: ["C7"]` with `citations: [{path,start,end}]`.
Known legacy IDs (including unacknowledged read receipts) and path#Lstart-Lend
or path:start-end strings in citeIds remain readable. Existing persisted
citations are retained. New original-checklist entries can use path plus
lineStart/lineEnd; legacy citeId entries remain compatible.

Host feedback includes the source location and an excerpt; complete attachments
(path, start, end, sha256, text) remain in each published feedback item. Existing
transport bounds still apply to inline excerpts. The existing instruction
“如反馈不成立，请说明依据” is retained. citationDiagnostics records rejected
submissions, corrected items, downgraded items and their individual events in
the local review/evaluation/report; those diagnostics are not business feedback.

Evaluation JSON, metric reports and the user report retain unverifiedItems,
regressionCheck, frameCoverage.items and reviewCoverage. Coverage stores each
reviewed subject in its denominator and its unresolved flag. Ambiguous output
paths share the owning requirement's denominator; program-triaged test failures
and individual frame items are included. unverifiedRatio is null for empty
coverage. Per-item records are authoritative when comparing runs; an overall
NO_DEVIATION_FOUND does not mean a zero unresolved ratio.
