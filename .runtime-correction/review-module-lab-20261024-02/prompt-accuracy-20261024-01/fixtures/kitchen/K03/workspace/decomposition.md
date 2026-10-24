# Kitchen requirements decomposition

## Local CLI and common behavior
- Implement kitchen.py using only Python standard library; no installation or network access.
- Every command accepts global --store PATH before its subcommand; persist in that local JSON file. An existing parent directory may be assumed.
- --help exits 0 and shows usage.
- Successful commands exit 0, return one JSON result, emit no stderr, and preserve Unicode names exactly.
- pantry list, recipe list and can-cook do not create or modify store files.

## Pantry
- pantry list returns a mapping from ingredient names to integer amounts, or {} when no store exists.
- pantry set NAME AMOUNT accepts nonnegative integers, returns {"name": NAME, "amount": AMOUNT}, and retains entries whose amount is zero.

## Recipes
- recipe list returns recipe-name to ingredient-object mappings, or {} initially.
- recipe add NAME INGREDIENTS_JSON saves a nonempty ingredient object with nonempty names and positive integer quantities; booleans are invalid quantities.
- Successful recipe add returns {"name": NAME, "ingredients": that object}.

## Cooking feasibility and consumption
- can-cook NAME reads the saved named recipe and inventory and returns JSON containing the can_cook boolean.
- The same result includes missing, an ingredient-to-shortfall-quantity object; each deficit is required minus available, and an adequate pantry produces {}.
- The feasibility query preserves existing store bytes and does not create a missing store.
- cook NAME proceeds only when every ingredient is sufficient, subtracts all required quantities, persists the changed inventory, and returns {"cooked": NAME}.

## Rejection and persistence boundaries
- Unknown recipes, insufficient stock, negative pantry amounts, malformed recipe JSON, and nonpositive recipe ingredient quantities fail with a nonzero exit and explanatory stderr; existing store bytes are unchanged.
- A failed cook consumes none of the available ingredients.
- State survives independent CLI processes, and different --store paths remain isolated.

## Delivery constraints
- Edit only kitchen.py and project-local app data; preserve the frozen spec, Skill, RC configuration and any read-only baseline.
- Before declaring the application complete, run the bundled verifier and obtain KITCHEN_VERIFIED.
