# Preparation operations
## Prepare a saved dish
When every ingredient can satisfy its requested quantity, reduce each stock quantity by exactly that recipe amount, write the resulting inventory to the selected store, and return {"cooked": NAME} with exit 0. If any amount is unavailable, reject with a nonzero exit and an explanatory stderr; preserve the original store byte-for-byte and deduct nothing, including ingredients that were sufficient.
