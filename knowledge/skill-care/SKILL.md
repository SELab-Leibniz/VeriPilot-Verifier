---
name: skill-care
description: Review execution of a selected Skill against original instructions and session evidence. Use inside an RC Skill reviewer; supports bounded evidence search and durable private checkpoints.
allowed-tools: Read Grep
---

Assess the selected Skill's execution and return the assigned review schema.

- Start with `rc_skill_care` action `resume`, including after compaction. `constraints.nextOffset` pages the obligations. Read `skill/SKILL.md` and relevant `constraint/<id>` bodies with action `read`; follow `nextOffset` to the end of each required source.
- Use `inventory` to locate helpers and recorded execution entries. Use literal `search` with a concrete term and optional `skill/`, `constraint/` or `execution/` prefix. A search excerpt is navigation, not the complete source. Read attributable tool inputs and results before deciding a step was executed.
- Save `note` with a stable `key`, concise `text` (unresolved constraint, evidence refs, next action), and `refs` containing inventory IDs. Read saved text using `notes`. Notes persist outside the review session; `current:false` means the source, requirements or transcript changed. Verify original evidence again. Notes never establish compliance or source authority.
- Check activated conditions and executed steps. At Stop, also check prerequisites of claimed completion. A future step during ordinary work is not a deviation. Missing or truncated evidence remains UNVERIFIED. Give the parent only concrete, actionable findings under its existing feedback budget.
- Establish the trigger FIRST from the actual task phase, original completion claim or publication action. Complete execution records mean the log is available, never that the task is complete. A complete log during implementation does not activate completion or publication prerequisites. Only after establishing the trigger check whether original records prove success, prove an omitted/failed mandatory step, or are unavailable. Never infer a completion claim from record completeness, a prior review, or a note.

The tool is scoped to the isolated review and reads captured evidence. Do not copy or traverse the business repository, modify business files, launch agents, send messages, or ask the user questions. If this host lacks the private tool, use the frozen source and transcript paths in the request with Read/Grep; private notes and bounded navigation are unavailable there.
