# Acceptance: saved consumption
With recipe 米饭 requiring rice=2 and a selected store containing rice=5, cook 米饭 must exit 0 and return {"cooked":"米饭"}. After that process has ended, a separate pantry list invocation against the same store must report rice=3. Fail if either command result differs or the second process still reports rice=5.
