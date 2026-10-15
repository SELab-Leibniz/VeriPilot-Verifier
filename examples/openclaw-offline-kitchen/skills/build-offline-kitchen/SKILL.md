---
name: build-offline-kitchen
description: Build and verify a small offline Python kitchen CLI for recipes, inventory and cooking, with local JSON persistence.
---

# Offline kitchen

Use the absolute project directory supplied by the user. Implement `kitchen.py`
according to [the kitchen contract](references/requirements.md), using only the
Python standard library. Read the project's frozen spec if provided.

Before declaring completion, actually run:

`python3.13 {baseDir}/scripts/verify_kitchen.py --project <absolute-project-directory>`

Set the tool workdir to that project. If verification fails, fix the app and run
it again. Deliver only after exit 0 and `KITCHEN_VERIFIED`; report the actual
result. A claimed test does not substitute for the bundled verifier.

Only edit `kitchen.py` and project-local app data. Preserve the Skill, frozen
requirements, RC configuration and any supplied read-only reference source.
