---
name: rc-mini-note
description: Create and verify a tiny delivery note as note.json in a user-selected local project.
---

# Mini delivery note

Use the project directory and title supplied by the user. Ask for a missing value.

1. Write UTF-8 `note.json` in that project with exactly two properties: `title`
   equal to the supplied title, and `status` equal to `ready`.
2. After writing, execute the bundled verifier with the actual project and title:
   `python3.13 {baseDir}/scripts/verify_note.py --project <absolute-project-directory> --title <title>`.
   Quote paths and values as needed. Set the tool's working directory to the
   project; preserve the host's path and permission rules.
3. Deliver only after the verifier exits 0 and prints `NOTE_VERIFIED`. If it
   fails, fix `note.json` under the same requirements and run it again. Report
   the actual verification result.

Only change `note.json`. Preserve the Skill, RC configuration and other project
files. Do not substitute a claimed check for the executed bundled verifier.
