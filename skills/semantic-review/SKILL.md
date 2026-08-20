---
name: semantic-review
description: Review the current Runtime Corrector artifact or bundle snapshot in an isolated session and return structured diagnostics plus a minimal candidate edit plan. Invoked automatically by the PostToolUse hook after every matching write.
allowed-tools: Read Grep
---

# Runtime Corrector Semantic Review

Read the request JSON supplied in `$ARGUMENTS`, then inspect every artifact named by that request. Resolve every relative artifact path against the request's absolute `projectRoot`; the isolated process may run from the parent conversation's directory instead of the artifact workspace. The current conversation inherited by the isolated session is the authority for the user's actual intent, but never for the current artifact contents. The files on disk after reading the request are the only authority for the artifact snapshot; ignore prior copies, findings, and edit plans from the inherited conversation. The request's deterministic diagnostics, stage specification, and reviewer criteria are the executable policy.

Return only the JSON object required by the caller's JSON Schema.

## Review rules

1. When `nodeReviewEnabled` is true, review every currently available current-node target. If the request includes `workflow`, `workflow.targetFiles` is the current-node set and all other named files are read-only context. For a complete bundle, check cross-file fidelity and consistency rather than reviewing only the trigger file. When `nodeReviewEnabled` is false, do not perform a general current-node review; evaluate only enabled workflow edges and declared Ground Truth inputs.
2. When `bundleComplete` is false, still review all criteria that can be decided from the available snapshot. Treat checks that require a missing bundle member as deferred; do not report the mere absence of a not-yet-generated member as a semantic error.
3. Preserve every valid deterministic diagnostic. Add semantic findings only when supported by concrete artifact or conversation evidence.
4. Findings use stable rule IDs prefixed with `AGENT-`. Each finding must name an available artifact path, explain the deviation, and include concise evidence.
5. Produce edits only when the exact replacement is evidence-grounded and does not require a new user or product decision.
6. An edit targets only a file listed in `artifactFiles`. Use exact 1-based original line numbers and exact `expect` text.
7. Supported operations are `remove-line`, `replace-line`, `insert-before`, and `insert-after`. Keep edits minimal.
8. `edits` may contain more than one available target, but each target appears at most once.
9. If the available artifacts comply, return no findings and no edits. If a finding requires human input, return the finding with no speculative edit.
10. Immediately before returning, re-read every file named by a finding or edit. Verify that quoted evidence and each operation's exact `expect` still exist at the stated line in the current snapshot. Drop a finding and edit that only describe an already-corrected prior snapshot.
11. This structured response describes only the current snapshot; it is not an execution history. Never preserve, restate, label, or report a resolved, stale, prior-round, or superseded issue in `summary`, `findings`, `evidence`, or `edits`, even when the inherited conversation asks the parent Agent to record earlier review results. The parent Agent can read persisted diagnostics for history. If every prior issue is corrected, return an empty `findings` array and an empty `edits` array.

## Workflow edge review

When the request includes `workflow`, review each entry in `workflow.incomingEdges` in its given order, in addition to the current node review:

1. Compare the target artifacts with the available source artifacts for contradictions, omissions, unsupported scope expansion, changed constraints or decisions, and broken traceability identifiers.
2. Treat an incoming edge with missing source artifacts as deferred. Do not report the missing source as a semantic finding; continue reviewing the current node and every other edge with available evidence.
3. Apply each edge's `reviewer` criteria in addition to this built-in consistency baseline. Missing criteria means baseline-only; an empty configured criteria file is rejected before this request is created.
4. Use stable edge rule IDs prefixed with `AGENT-EDGE-<FROM>-TO-<TO>-`, uppercasing node IDs and replacing characters outside `A-Z0-9` with `-`.
5. Every finding `path` and every edit `target` must be listed in `workflow.editableArtifactFiles`. Source artifacts are read-only, although finding evidence may cite their contents and paths.

Never modify files, apply patches, run shell commands, create another Agent, or ask the user a question.

## Ground Truth input review

When `workflow.groundTruthInputs` is present, treat every listed file as a read-only declared authority for this check:

1. Apply only a source whose `status` is `ready`; an unresolved required source means the basis is incomplete and must not be guessed.
2. Compare target artifacts with the source's declared type, version and authority. Report omissions, contradictions or unsupported expansion against a ready source.
3. Ground Truth files may be cited as evidence, but every finding path and edit target must still belong to `workflow.editableArtifactFiles`.
4. Do not resolve conflicts between Ground Truth sources by recency or file modification time. Report that the basis is unresolved unless the supplied reviewer criteria explicitly define the authorized precedence.

## Runtime v2 Ground Truth and checkpoint metrics

When the request includes `runtimeV2`:

1. Read `runtimeV2.groundTruthPath` as the frozen task Ground Truth for this review. Hard active claims are authoritative; soft, conflicted, retracted, `AGENT_INFERRED`, and `BASIS_PENDING` claims may support advice but cannot independently create an error finding.
2. Compare current-node targets against active hard claims. Agent-authored content cannot promote itself into Ground Truth.
3. For a Ground Truth deviation, set `rootCauseId` to one of the frozen IDs in `runtimeV2.rootCauseIds` and list the affected claim IDs in `violatedGroundTruthIds`.
4. When `runtimeV2.population` is non-null, return exactly one `metricObjectJudgements` item for every object belonging to `runtimeV2.metricIds`, or for every population object when `metricIds` is null.
5. Use `NOT_YET_APPLICABLE`, `NOT_APPLICABLE`, `UNVERIFIED`, and `BASIS_PENDING` distinctly. Never convert missing or inapplicable evidence into a zero score.
6. Do not calculate percentages. The host validates and aggregates object judgements deterministically.
7. When no metric population is supplied, return an empty `metricObjectJudgements` array.
