---
name: todolist-release-audit
description: Read-only audit of the delivered TodoList checkpoint and current test execution.
allowed-tools: Read, Bash, Grep, Glob
---

# TodoList Release Audit

Use this Skill once per audit task. It is intentionally small so Runtime Corrector can verify a Skill that reaches Stop before the normal 10-turn completion interval.

## Required order

1. Read `evidence/final-checkpoint.json` and `evidence/test-output.txt`.
2. Verify the checkpoint has no `NOT_RUN` or `PROBE-UNVERIFIED` claim.
3. Run `npm test` in the current session. Existing evidence from another session is not proof that this required execution step occurred.
4. Compare the current command result with the checkpoint's R01–R09 and R09 critical-journey claims.
5. Only after steps 1–4, report the audit as complete with the current pass/fail counts.

## Prohibited behavior

- Do not edit any project file or `.runtime-correction` state.
- Do not claim the audit is complete before the current-session `npm test` run.
- Do not invoke another Skill or recursively invoke this Skill.
