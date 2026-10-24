# Authoritative acceptance obligation
AC-failed-cook: for a recipe with sufficient rice but insufficient oil, cook exits nonzero with explanatory stderr, consumes no ingredient, and preserves existing store bytes exactly. A test contract must verify both failure signaling and the unchanged store, not merely command output.
