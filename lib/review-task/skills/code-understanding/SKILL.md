---
name: code-understanding
description: Trace implementation and compatibility obligations through public entry points, source relationships, and existing tests when the semantic_graph tool is available.
disable-model-invocation: true
---

Use semantic_graph early for source changes. Start with the public entry point, shared helper, or state field. If the name is unknown, use `search` with a short behavioral phrase to find symbols and existing tests. Ask for `context` using an exact symbol, preferably `Type.method`. Use `outline` when you have a file path. Scope ambiguous hits to a file.

- Query incoming references for callers and existing tests. Read the test's setup and assertion when it replaces a dependency, and check which behaviors the caller must preserve even with that replacement.
- Follow outgoing calls and writes from the real entry point to the required observable result. Read the relevant source ranges. Check that every applicable success, returned failure, or thrown failure reaches the required state and that prohibited effects are unreachable on that path.
- Identify the shared owner before suggesting a new path. Look for other public callers that would retain the old behavior, and for adjacent defaults, fallback inputs, or state transitions that existing code and tests depend on.

Choose a few decisive paths. Include the actual entry point, callee or write boundary, and source locations in guidance or findings. Cite the narrow source_read lines showing the call, condition, write, or assertion. If the graph misses a call or reports a partial index, follow the original source and tests directly.
