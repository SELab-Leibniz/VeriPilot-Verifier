---
name: code-understanding
description: Trace implementation and compatibility obligations through public entry points, source relationships, and existing tests when the semantic_graph tool is available.
disable-model-invocation: true
---

Use semantic_graph early for source changes. Start with the public entry point, shared helper, or state field. If the name is unknown, use `search` with a short behavioral phrase to find symbols and existing tests. Ask for `context` using an exact symbol, preferably `Type.method`. Use `outline` when you have a file path. Scope ambiguous hits to a file.

- Use `incoming` on the exact symbol to find callers and existing tests. Read the setup and assertion when a test substitutes a dependency. Check what the public caller guarantees with that substitute.
- When an import cannot resolve, use `dependencies` on the importing file. A `case-mismatch` shows the requested and existing paths. Verify the actual file name and import spelling, especially after a case-only rename on a case-insensitive filesystem.
- Use `outgoing` on the public entry point. Follow calls and writes to the observable result, including the first write, external call, or returned value that matters. Read the listed control sites and unresolved call locations where relevant. Follow success, returned failure, and thrown failure separately before deciding that a check is covered.
- When an operation must recover or roll back, use `outgoing` on the code that reads the state before writing. Check `catchReturns` on called functions and read the return and its caller. If a failed read can produce the same value as a successful empty read, trace whether the caller proceeds with a write or accepts that value as confirmed state.
- Identify the shared owner before suggesting a new path. Look for other public callers that would retain the old behavior, and for adjacent defaults, fallback inputs, or state transitions that existing code and tests depend on.
- When a shared operation gains a dependency, follow its incoming callers through to their own results. A test may use that operation only to prepare a separate action. Preserve the action's original valid inputs and observable effects when the new dependency is absent, unless the original requirement changes that contract.
- When a string-valued contract changes, use `context` on its type and `literal` with each changed or removed value. Check the remaining switch branches, producers, and tests. A matching string is a location to inspect. Confirm the enclosing type or input before linking it to the contract.
- Trace the origin and validation of the inputs to any new effect. Separate values used for display or logs from validated targets for a write or external call. Follow missing, empty, and invalid inputs through the same public entry point and verify where each path stops.

Choose a few decisive paths. Include the actual entry point, callee or write boundary, and source locations in guidance or findings. Cite the narrow source_read lines showing the call, condition, write, or assertion. If the graph misses a call or reports a partial index, follow the original source and tests directly.
