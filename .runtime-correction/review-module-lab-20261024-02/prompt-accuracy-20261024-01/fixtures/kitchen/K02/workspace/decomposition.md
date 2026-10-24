# Kitchen requirements decomposition

## Local CLI and common behavior
D1.1 Implement kitchen.py using only Python standard library; no installation or network access.
D1.2 Every command accepts global --store PATH before its subcommand; persist in that local JSON file. An existing parent directory may be assumed.
D1.3 --help exits 0 and shows usage.
D1.4 Successful commands exit 0, return one JSON result, emit no stderr, and preserve Unicode names exactly.
D1.5 pantry list, recipe list and can-cook do not create or modify store files.

## Pantry
D2.1 pantry list returns a mapping from ingredient names to integer amounts, or {} when no store exists.
D2.2 pantry set NAME AMOUNT accepts nonnegative integers, returns {"name": NAME, "amount": AMOUNT}, and retains entries whose amount is zero.

## Recipes
D3.1 recipe list returns recipe-name to ingredient-object mappings, or {} initially.
D3.2 recipe add NAME INGREDIENTS_JSON saves a nonempty ingredient object with nonempty names and positive integer quantities; booleans are invalid quantities.
D3.3 Successful recipe add returns {"name": NAME, "ingredients": that object}.

## Cooking feasibility and consumption
D4.1 can-cook NAME reads the saved named recipe and inventory and returns JSON containing the can_cook boolean.
D4.2 The feasibility query preserves existing store bytes and does not create a missing store.
D4.3 cook NAME proceeds only when every ingredient is sufficient, subtracts all required quantities, persists the changed inventory, and returns {"cooked": NAME}.

## Rejection and persistence boundaries
D5.1 Unknown recipes, insufficient stock, negative pantry amounts, malformed recipe JSON, and nonpositive recipe ingredient quantities fail with a nonzero exit and explanatory stderr; existing store bytes are unchanged.
D5.2 A failed cook consumes none of the available ingredients.
D5.3 State survives independent CLI processes, and different --store paths remain isolated.

## Delivery constraints
D6.1 Edit only kitchen.py and project-local app data; preserve the frozen spec, Skill, RC configuration and any read-only baseline.
D6.2 Before declaring the application complete, run the bundled verifier and obtain KITCHEN_VERIFIED.
