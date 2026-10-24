# Kitchen acceptance criteria

## CLI and shared contract
AC1.1 In an offline environment with only the Python standard library available, --help exits 0 and shows usage; no package installation or network access is used.
AC1.2 Each command accepts --store PATH before its subcommand; all successful commands produce exactly one JSON result, exit 0, have empty stderr, and preserve Unicode names including 番茄炒蛋 🍳. An existing parent directory may be assumed.
AC1.3 With an absent store path, pantry list and recipe list return {} and create no store file. With an existing store, these two list commands leave its bytes unchanged.

## Pantry and recipes
AC2.1 pantry set 番茄 0 returns {"name":"番茄","amount":0}; pantry list from another process contains 番茄:0.
AC2.2 pantry set accepts nonnegative integer amounts and pantry list maps ingredient names to integer amounts.
AC3.1 recipe list initially returns {}; adding 番茄炒蛋 🍳 with {"番茄":2,"鸡蛋":3} returns its exact name and ingredients and a subsequent process's recipe list includes the same object.
AC3.2 Empty recipe objects, empty ingredient names, zero or negative quantities, boolean quantities and malformed JSON are rejected with nonzero exit and explanatory stderr; existing store bytes remain equal to their before-operation bytes.

## Feasibility and cooking
AC4.1 Given saved recipe {"番茄":2,"鸡蛋":3} and inventory {"番茄":2,"鸡蛋":2}, can-cook returns {"can_cook":false,"missing":{"鸡蛋":1}} with exit 0 and no stderr.
AC4.2 Given the same recipe and inventory {"番茄":2,"鸡蛋":3}, can-cook returns {"can_cook":true,"missing":{}} with exit 0 and no stderr.
AC4.3 In a freshly initialized adequate fixture, cook returns {"cooked":"番茄炒蛋 🍳"}; pantry list in a later independent process returns {"番茄":0,"鸡蛋":0}, demonstrating full deduction and persisted result.
AC4.4 In an inadequate fixture where 番茄 is available but 鸡蛋 is short, cook exits nonzero with explanatory stderr and every store byte stays unchanged, including the available 番茄 quantity.

## Failures, isolation and delivery
AC5.1 Unknown recipes and negative pantry amounts exit nonzero with explanatory stderr and leave existing store bytes unchanged.
AC5.2 A distinct --store file continues to show empty pantry and recipes when only the first store has been populated.
AC6.1 The only created or edited artifacts are kitchen.py and local app data; frozen requirements, Skill, RC configuration and supplied read-only baseline retain their original bytes.
AC6.2 Prior to a completion declaration, an actual bundled-verifier run must exit 0 and produce KITCHEN_VERIFIED.
