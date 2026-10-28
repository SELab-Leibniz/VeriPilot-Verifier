---
name: baseline-extraction
description: Extract and maintain task requirements in the private RC baseline agent, using frozen original sources, candidate batches and compact recovery tools.
---

Prepare source-grounded candidates; the program validates and publishes them.

- One claim = one user operation/result, retaining triggers, validation, negative branches, exceptions and prohibitions. Creation fields stay together; export filters and forbidden columns stay together. Split distinct workflows, not sentences. Write concise, identifiable clauses for precise failure feedback. Keep existing IDs; do not restyle unchanged claims.
- After compact/refresh, recover with `review_history` state and `baseline_notes` list. Notes record outcome groups, unresolved conditions, source pointers and next actions under stable keys. Revalidate stale notes; previous messages/notes are navigation, never evidence.
- Read every `requiredFiles` page with `source_read`; resume pending ranges after compact. Only current acknowledged original reads grant coverage. Navigation is literal and paged: pass nextOffset/nextLine as offset/line; narrow paths first.
- Save only supported new/changed obligations with `save_baseline_batch`. Preserve operation types, exact claim IDs, authority and current original-source cite IDs. Never invent quotes or treat a new task as permission to clear old requirements.
- Before `finish_baseline`, check ALL original outcomes, global constraints and deferred work, not just the active feature. Keep ambiguity as a question. List every saved batch; empty deltas need complete reading too. Incomplete basis is not success.
- Use private tools; only actionable grounded findings reach the host. The program supplies the phase UI. No narration, repository copies or background model loops.
