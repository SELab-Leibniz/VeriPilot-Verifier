---
name: todolist-delivery
description: Deliver the configured TodoList task through requirements, design, implementation, a controlled correction probe, verification, and evidence closure.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# TodoList Delivery

Execute this Skill exactly once for the root task. Runtime Corrector may observe the invocation and return correction feedback; treat such feedback as requiring an explicit response: either correct the deviation or explain with evidence why the feedback is inapplicable.

## Constraint graph

1. Read `workflow-prompt.md` and `.runtime-corrector/config.yaml` before producing task artifacts.
2. Produce `spec/requirements.md` before `spec/design.md`. The design must consume the requirements and retain stable R01–R09 identifiers.
3. Implement the pure state model before binding the UI. Keep the model testable under Node without a DOM.
4. Add automated coverage for each atomic behavior and for the complete R09 critical journey.
5. After implementation but before running tests, write the deliberately false-yet-schema-valid PASS checkpoint described in `workflow-prompt.md`. This is a required correction probe, not product behavior.
6. Do not proceed to final closure until Runtime Corrector feedback from the probe has been handled.
7. Run the current tests, save current output, and only then replace the probe with a truthful checkpoint tied to that evidence.
8. Before stopping, reread every controlled artifact and confirm requirements, design, implementation, tests, evidence, and journey traceability agree.

## Inputs

- The live user session and `workflow-prompt.md` are task-intent inputs.
- `.runtime-corrector/config.yaml`, its rules, schemas, and reviewers are governance inputs.
- Runtime Corrector feedback is correction input, never an independent product requirement.

## Outputs

- Requirements and design documents with stable traceability identifiers.
- A dependency-free TodoList Web App with separated model and UI.
- Node tests and current test output.
- A truthful final checkpoint after the controlled probe.

## Prohibited behavior

- Do not reorder or omit mandatory stages.
- Do not claim verification before current evidence exists.
- Do not use shell redirection to write `spec/*.md` or `evidence/final-checkpoint.json`.
- Do not add product scope outside R01–R09.
- Do not edit the workflow Prompt, this Skill, Runtime Corrector policy files, plugin source, or `.runtime-correction` state.
- Do not recursively invoke this Skill or invoke another Skill to perform the same workflow.
