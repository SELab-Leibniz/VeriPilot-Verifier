# Runtime audit fixes (2026-09-09)

This contract supersedes the unconditional M09/M11/M12 ownership and silent
fail-open/completion behavior in the earlier implementation-review blueprint.

## Evidence ownership

Ground Truth operations may carry `verificationTarget`:

| Target | Evidence | Reviewer |
| --- | --- | --- |
| `ARTIFACT` | Actual document contents and upstream references | General/artifact reviewer |
| `PROCESS` | Tool history, invocation arguments, ordering | General reviewer and supported deterministic process checks |
| `IMPLEMENTATION` | Manifested production source, supported build/device checks | Implementation reviewer |

M11 workflow objects never belong to the production-source reviewer. Only
implementation-targeted M09/M12 objects are supplied to it. For older ledgers,
an authoritative docs-only/no-application-code scope exclusion skips source
and device verification. Known planning stages also skip those checks. In a
mixed task, per-object targets preserve code checks while excluding document
and process objects. Missing source files alone never disable a code check.

An implementation review records `COMPLETED`, `SKIPPED` (with a reason), or
`FAILED`. Its failure cannot inherit general-review PASS judgements: every
owned object becomes `CHECKER_ERROR`, and the bounded infrastructure retry
path applies. Omitted owned objects become checker errors too. Deterministic
capability findings survive reviewer faults.

The final review summary is generated from the merged assessment. Original
general-review output remains in `stopReviewerSummary` and
`stopReviewerJudgements`; evaluated metric objects identify their `reviewer`.

The deterministic process checker currently supports the explicit requirement
that **every Claude CLI invocation use a fresh UUID**, optionally also requiring
non-interactive mode. Reused literal IDs and direct resume calls contradict
that contract. Variables, complex shell wrappers and absent direct invocation
records remain `UNVERIFIED`; an assistant's statement or a single observed
UUID cannot prove freshness. This is not a general shell interpreter or a
claim to mechanically validate every possible workflow constraint.

## Ground Truth provenance

Extractor and adjudicator requests include a `sourceCatalog` of actual user
message references, supplied material files and existing project instruction
files. Authoritative operations must bind to that catalog; unknown, ambiguous
or mismatched sources are rejected and journaled. Source objects support
`subject` (`MAIN_TASK` / `REVIEWER`) and `kind` (`USER_MESSAGE`, `MATERIAL`,
`PROJECT_FILE`, `INTERNAL_REVIEWER`). Internal reviewer instructions cannot
enter the task ledger under any authority, including `PROJECT_CONSTRAINT`.

Deterministically extracted capability obligations now carry the same concrete
material provenance as model-extracted claims. The adjudicator receives real
user request text as well as the panel proposals, rather than relying on the
panel's paraphrases alone.

Historical ledgers are not rewritten. Known internal-role claims in an older
ledger are excluded from newly computed metric populations and hard-claim
gates. Old evaluation reports and their original statuses remain historical
evidence; use a fresh task for a controlled before/after test.

## Completion and release

Task execution status and `task.verification` are separate:

| Outcome | Task status on terminal completion/release | User-facing output |
| --- | --- | --- |
| Complete, no blocking findings, metrics PASS | `COMPLETED` | Normal completion |
| Correction budget exhausted with unresolved findings | `COMPLETED_WITH_ISSUES` | Budget-exhausted warning, unresolved details |
| Complete with nonblocking UNVERIFIED objects | `COMPLETED_WITH_ISSUES` | Verification-incomplete warning |
| Infrastructure unavailable beyond bounded retries | `STOPPED_UNVERIFIED` | Explicit verification-unavailable warning |

Stop release warnings use the host-supported `systemMessage` channel, not
unsupported Stop `additionalContext`. Budgets remain bounded. Infrastructure
faults do not spend the developer's correction budget. Shadow mode remains
silent, and human-only release disclosures are not counted as additional
agent-directed corrections.

`task.verification` records the latest verification status, evaluation pointer
and update time; budget releases also record exhaustion. A lifecycle exit is
not evidence of verification success.

## Audit fidelity and provider configuration

- Repeated PASS checks update `lastVerifiedAt`, not `fixedAt`. `firstFixedAt`
  survives reopening; `fixedAt` describes the current closure episode.
  Unverified or inapplicable objects cannot close a deviation just because a
  different metric for the same claim passed.
- If semantic findings are valid but candidate edits fail validation, the
  overall operation remains failed while `semanticStatus=completed` and
  `patchStatus=failed`. Results preserve findings and report
  `RUNTIME-PATCH-VALIDATION-FAILED`, not a misleading semantic/API failure.
- Policy validation warns when a configured independent reviewer's key
  variable is absent **in the validation process's environment**. It does not
  test the remote service, print credentials or infer another terminal's env.
- An explicitly independent Stop reviewer gets a new role handle; reusing an
  extractor's process would otherwise retain its endpoint and credentials.
- Reviewer process errors preserve both stdout and stderr with bounded output
  and credential redaction, so a model warning cannot hide the API response.

## Regression verification

`test/audit-regressions.test.mjs` covers docs-only and mixed-task routing,
planning checkpoints, missing/failed implementation judgements, independent
Stop handle selection, budget release output, partial verification, internal
source rejection, closure timestamps, candidate-patch failure classification,
provider validation and per-invocation UUID evidence. Existing workflow and
runtime tests additionally preserve artifact immutability, hook compatibility,
deviation delivery attribution and shadow-mode behavior.

Tests use local fake reviewers and temporary fixtures. They do not establish
live gateway availability, model quality, build success or device behavior.
