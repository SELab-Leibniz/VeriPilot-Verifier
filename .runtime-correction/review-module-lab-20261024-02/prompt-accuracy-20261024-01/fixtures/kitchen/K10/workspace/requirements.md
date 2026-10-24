# Offline kitchen CLI contract

R01 Implement `kitchen.py` with the Python standard library, no installation or
network access. `--help` exits 0 and shows usage. All commands accept global
`--store PATH` before the subcommand; use a local JSON file for persistence.
Successful commands below exit 0 with one JSON result and no stderr. Preserve
Unicode names exactly. An existing parent directory may be assumed. List queries
and can-cook never create or modify store files.

R02 `pantry list` returns an object mapping ingredient names to integer amounts,
or `{}` for a missing store. `pantry set NAME AMOUNT` accepts a nonnegative integer
and returns `{"name": NAME, "amount": AMOUNT}`. Retain zero-amount entries.

R03 `recipe list` returns an object mapping recipe names to ingredient objects,
or `{}` initially. `recipe add NAME INGREDIENTS_JSON` stores a nonempty object of
nonempty ingredient names and positive integer amounts (booleans are invalid),
and returns `{"name": NAME, "ingredients": <that object>}`.

R04 `can-cook NAME` reads the saved recipe and inventory, returns
`{"can_cook": <boolean>, "missing": <ingredient-to-shortfall object>}`, and
does not change store bytes. `cook NAME` subtracts all required quantities only
when sufficient, persists the result, and returns `{"cooked": NAME}`.

R05 Unknown recipes, insufficient stock, negative inventory, malformed recipe
JSON or nonpositive ingredient amounts exit nonzero with an explanatory stderr
and leave existing store bytes unchanged. A failed cook must not consume even
the ingredients that were available. State persists across independent CLI
processes; different `--store` files remain isolated.

R06 Only create/edit `kitchen.py` and project-local app data. Preserve this spec,
the Skill, RC configuration and any read-only baseline. Run the bundled kitchen
verifier and obtain `KITCHEN_VERIFIED` before declaring the app complete.
