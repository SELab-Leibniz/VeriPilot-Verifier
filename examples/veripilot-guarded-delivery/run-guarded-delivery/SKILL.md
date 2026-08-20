---
name: run-guarded-delivery
description: Run guarded_delivery_workflow.yaml from an existing Runtime Corrector six-stage analysis into an Agent-authored four-file Planning projection, PRD Contract auto, and Build QA auto, with exact semantic evidence scopes and a completion report after every stage. Use when a user asks to continue six-stage outputs into SR.md, PilotPlan.md, relations.json, granularity-choice.json, PRD.md, acceptance-contract.json, or Build QA without invoking the Planning or IR plugins.
---

# Run Guarded Delivery

Treat
`${CLAUDE_PLUGIN_ROOT}/examples/veripilot-guarded-delivery/guarded-delivery-workflow/guarded_delivery_workflow.yaml`
as the execution authority. Read it completely before writing or invoking a
component.

## Enforce the architecture

Use this exact chain:

1. Revalidate the six existing stage documents.
2. Build the lossless `planning-source.md` carrier.
3. Bootstrap one unified VeriPilot v2 workspace and stop at
   `workspace_created`.
4. Author the Planning four-file projection directly as the current Agent.
5. Prove six-stage-to-Planning consistency with Runtime Corrector.
6. Publish the four files as a guarded-delivery-owned standard delivery
   manifest.
7. Run PRD Contract in auto mode with that manifest.
8. Prove Planning-to-PRD consistency with Runtime Corrector.
9. Validate the PRD handoff, run Build QA in auto mode with `scope all`, and
   audit its execution evidence.
10. Write the final delivery summary.

Never invoke `/planning:*`, `/planning:workflow`, `/ir:*`, or `/ir:workflow`.
Do not write anything under `stages/20-planning`. IR is unnecessary because PRD
Contract accepts the standard `veripilot.delivery_manifest.v2` envelope emitted
by the guarded-delivery publication helper.

## Keep semantic scope exact

Allow only these two product-semantic comparisons:

- Six-stage baseline:
  `requirement-analysis.md`, `requirement-breakdown.md`,
  `code-understanding.md`, `solution-design.md`,
  `manual-test-cases.md`, `dt-design.md`.
  Planning subjects: `SR.md`, `PilotPlan.md`, `relations.json`,
  `granularity-choice.json`.
- Planning baseline: those exact four files.
  PRD subjects: `PRD.md`, `acceptance-contract.json`.

Do not add `planning-source.md`, IR, `traceability.json`, manifests, handoffs,
private runtime files, or Build QA evidence to either comparison. Manifests and
handoffs remain valid inputs only for schema, identity, capability, lineage,
hash-closure, and importer checks.

## Preflight

1. Require an explicit absolute business-project path unless the current
   session directory is positively known to be that project.
2. Require the session working directory and project root to be the same real
   path. Runtime Corrector policy discovery and exact artifact paths are
   working-directory-relative.
3. Verify the component versions declared by the YAML. Version drift blocks
   execution until the public contracts are re-audited.
4. If `.runtime-corrector` is absent, copy the complete example policy.
   If it exists, do not overwrite or silently merge it. Verify that it declares
   the exact 6-to-4 and 4-to-2 evidence sets and all protocol/evidence gates;
   otherwise stop with a migration diff for maintainer approval.
5. If the exact `VeriPilotWorkspace/guarded-current` exists, resume it only
   after workspace/request identity and hash validation. Never select another
   workspace child by scanning.
6. Stage 0 verifies only that Build QA and its public workflow are available.
   Do not declare Harmony unavailable merely because the business project has
   no project-local `hvigorw`, `local.properties` omits an SDK path, or SDK
   environment variables are unset. Build QA 3.6.0 owns coherent DevEco
   Studio/Command Line Tools discovery and frozen-input environment admission
   in Stage 110. Propagate that component result instead of duplicating or
   weakening its gate.

## Revalidate the six stages

For Stage 10 through 60 in order:

1. Require the exact YAML path and hash its current bytes.
2. Reuse a completion report only when its schema, recorded hashes,
   deterministic `passed`, and semantic `completed` state match the current
   bytes.
3. Otherwise perform a byte-preserving Write only when the environment can
   prove the bytes remain unchanged and can observe the PostToolUse semantic
   result. A manual `check` returning `agentReview.status: requested` does not
   replace a completed semantic review.
4. Correct a genuine defect only in its author-owned current stage. Revalidate
   every affected downstream report.
5. Write the stage completion report immediately.

## Author the Planning projection

Write exactly these files under
`<workspace>/delivery/planning-projection/`:

- `SR.md`
- `PilotPlan.md`
- `relations.json`
- `granularity-choice.json`

Preserve every stable requirement, acceptance, test, constraint, non-goal, and
open-question identifier from the six sources. Assign stable `SR-N` and `M<N>`
identities; map each SR to exactly one milestone; represent only true hard
dependencies as acyclic `requires` edges; keep PilotPlan, relations, and
granularity groups identical.

Let Runtime Corrector review each Write/Edit. Corrector may propose changes only
to these four Agent-owned files. Do not call Planning feedback or fabricate a
Planning component output.

## Publish the Planning projection

Only after Stage 85 passes, run the YAML's
`planningProjectionPublication.publishCommand`. The helper:

- reads workspace identity and negotiated capabilities;
- hashes exactly the four files;
- writes
  `delivery/planning-projection/manifest.json`;
- identifies `guarded-delivery`, not Planning, as producer;
- computes the protocol-v2 RFC-8785 envelope hash.

On resume, run `checkCommand`. Never hand-edit this manifest.

## Run PRD Contract

Invoke exactly the YAML's PRD public workflow command:

`/prd-contract:workflow auto ... --source-manifest "delivery/planning-projection/manifest.json" --mode auto`

Treat only public terminal `verified` as success. On `needs_human` or `blocked`,
preserve the component's one legal next action. Runtime Corrector reviews only
`PRD.md` and `acceptance-contract.json` against the four Planning files.

For a real Stage 95 semantic finding, send mapped findings through the PRD
public feedback command and rerun PRD auto with the same source manifest. Never
edit PRD-generated JSON, manifests, handoffs, hashes, or private state.

## Run Build QA

Before Build QA:

1. Require Stage 85 and 95 receipts to be passed.
2. Validate the Planning projection manifest, PRD output manifest, PRD handoff,
   workspace identity, capabilities, lineage, and hash closure.
3. Require at most seven milestones and at most 120 explicitly enumerated audit
   files.

Invoke Build QA exactly once through the YAML public workflow:

`/build-qa-loop:workflow auto ... --source-manifest "stages/40-prd-contract/output/manifest.json" --scope all --mode auto`

Do not pass the Planning projection separately; PRD owns that lineage. Do not
use `--milestone-dir` with `scope all`. Treat Build QA as a black box and audit
the declared execution/evidence files only after it returns.

## Run a Corrector gate

1. Write the gate Markdown using the YAML heading contract, real paths, current
   hashes, evidence counts, findings, decision, and next action.
2. Observe the PostToolUse semantic result. Require
   `agentReview.status: completed` with no warning/error finding.
3. Run `/runtime-corrector:check <gate-file>` and require deterministic
   `passed`.
4. Never auto-apply a candidate diff.
5. Use no more than `execution.correctionMaxRounds`.

## Write completion reports

After every attempted Stage, write its declared `*.completion.json` and
validate it against
`.runtime-corrector/schemas/stage-completion.schema.json`.

- Record actual `sha256:<64 lowercase hex>` values.
- Use only `completed`, `needs_human`, `blocked`, or `not_run`.
- Never record auto policy as human approval.
- After a stop, write `not_run` reports for every remaining predecessor Stage,
  then still write Stage 120's incomplete summary.
- Write Stage 120's own report only after the summary gate; never include the
  not-yet-created self-report in its inputs.

## Non-negotiable boundaries

- Do not invoke Planning or IR.
- Do not write `stages/20-planning` or fabricate its manifest/handoff.
- Do not retry PRD without the guarded Planning projection manifest.
- Do not broaden the two product-semantic evidence sets.
- Do not edit generated protocol or component-owned files.
- Do not claim Runtime Corrector paused inside Build QA.
- Do not claim auto/verified means human approval.
