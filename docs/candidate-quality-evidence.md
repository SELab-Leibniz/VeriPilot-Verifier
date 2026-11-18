# Candidate quality evidence

The formal paired campaign grades only workflow-eligible candidates. That can leave a frozen candidate from an unsuccessful workflow ungraded. This optional reader records candidate test evidence separately, while preserving the workflow result and the existing formal campaign.

Run it with an independently retained hash of the complete input manifest:

```sh
node scripts/inspect-candidate-quality.mjs \
  --inputs=/absolute/path/inputs.json \
  --inputs-sha256=<retained-sha256> \
  --output=/absolute/path/new-evidence.json
```

Omit `--output` to print JSON. An output file must be new. The reader does not start a model, SDK, device or grader; modify existing evidence; reconstruct a patch; or write campaign observations. Its output has kind `candidate-quality-evidence-v1`, no campaign `.score`, `formalEligibility: "NOT_EVALUATED"` and `formalPairsAdded: 0`.

## Input manifest

Use kind `candidate-quality-inputs-v1`, an `experimentId`, and a fixed `slots` array containing **every planned observation**, including unstarted slots. Slot IDs must be unique. A business result may appear in only one slot. Retain the manifest hash outside this output: changing the planned population creates a different input snapshot.

Each slot contains:

| Field | Contents |
| --- | --- |
| `id` | Unique observation identity |
| `stage` | `UNSTARTED`, `STARTED` or `TERMINAL` |
| `expected` | `instanceId`, `baseCommit`, `datasetSha256`, `publicInputSha256`, `packageSha256`, `sourceCommit`, `rcEnabled` |
| `business` | Optional references to existing release-runner `result`, `manifest`, `freeze`, `candidate`, `session`, `workspacePatch` files |
| `grading` | Optional references and evaluator pins described below |

Each file reference is `{ "file": "relative/or/absolute/path", "sha256": "<retained-sha256>" }`. Relative paths resolve against the manifest directory. `result` and `manifest` are supplied together. A frozen candidate requires `freeze`, `candidate` and `session` together; a freeze containing `workspacePatchSha256` also requires `workspacePatch`.

The reader binds result and manifest to the expected task, input, release and RC arm. It checks the result's embedded freeze against `freeze.json`, the prepared Git identity against the manifest, and the retained candidate, session and workspace-patch bytes against the freeze hashes. `SEALED_PATCH_VERIFIED` describes these checks. It does not claim to have replayed the run or independently authenticated its Git commit object.

`grading` contains:

| Field | Contents |
| --- | --- |
| `provenance` | `DIAGNOSTIC` or `FORMAL_CAMPAIGN` |
| `record`, `coverage` | Digest references to the raw candidate grade and runtime coverage log |
| `parser` | `HYPIUM` for Previewer logs, or `INSTRUMENT` for phone logs |
| `toolchainSha256`, `testPatchSha256`, `calibrationDirectory` | Expected evaluator identities recorded by the grade |
| `expectedCases` | Original exact test IDs as `{ "f2p": [...], "p2p": [...] }`; no duplicates across groups |
| `suiteSha256`, `runnerSha256` | Required for `INSTRUMENT` |

The original grade must identify the exact frozen patch, task, dataset, evaluator test patch, toolchain and calibration reference. The reader parses the retained runtime log and recomputes every expected outcome, completeness, runtime error and test-inventory field. An incomplete or interrupted report retains its observed and missing counts with `quality: null`. A complete grade must also satisfy the existing sealed-grade checks.

`FORMAL_CAMPAIGN` requires an existing version-1 campaign grading receipt supplied as `campaignReceipt`, its exact `campaignSlot` (`id`, `repetition`, `arm`), and its `calibrationSha256`. The reader verifies that receipt's business-result, candidate, release, evaluator and raw-grade bindings, score and terminal execution. The business result must report natural completion. These checks preserve a receipt's source classification; they do not re-evaluate formal campaign eligibility, match it to another arm, or add a formal comparison. A diagnostic never acquires formal credit through this reader.

## Reading the output

Every input slot appears once. Statuses distinguish `UNSTARTED`, `NO_RESULT`, `NO_FROZEN_PATCH`, `GRADING_PENDING`, `GRADE_PARTIAL`, `GRADE_COMPLETE`, `EVIDENCE_MISSING` and `INVALID_EVIDENCE`. A missing file stays missing; a changed hash or mismatched identity is invalid. Neither is a measured failure or a passing grade.

Workflow completion, RC review status and required-check statuses remain beside the candidate evidence. Complete candidate test counts are stored in `quality`; partial observations have no quality score. Summary counts describe slots, including slots with a complete grade from each provenance. They do not count independent grader executions, compute a treatment effect, or infer a pass rate from the graded subset.

The manifest and file hashes establish consistency with the operator's retained inputs. They do not establish who produced those inputs, independently qualify the backend or calibration, verify that the original requirement/test inventory is exhaustive, or prove that the plugin improves quality. Preserve those qualifications and the formal campaign result separately. Generating a manifest for historical diagnostic evidence does not turn that evidence into a pre-registered experiment.
