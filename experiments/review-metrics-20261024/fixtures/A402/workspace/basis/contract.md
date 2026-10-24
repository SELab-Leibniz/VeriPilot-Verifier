# Authoritative acceptance obligation and contract quality
For recipe 汤={"water":3,"salt":2} and pantry={"water":1,"salt":2}, can-cook must report can_cook=false and missing={"water":2}, exit 0, emit no stderr, and preserve existing store bytes. The test must use an oracle consistent with these required semantics.
