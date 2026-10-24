# Query shortage test
Create the stated recipe and pantry, snapshot the store bytes, and invoke can-cook 汤. Pass iff exit=0, stderr is empty, stdout parses as {"can_cook":false,"missing":{"water":3}}, and store bytes match the snapshot. This expected missing value is used directly; no other oracle is referenced.
