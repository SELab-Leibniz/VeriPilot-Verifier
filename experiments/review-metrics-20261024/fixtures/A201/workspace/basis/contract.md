# Authoritative kitchen requirement
R04: cook NAME subtracts all required quantities only when stock is sufficient, persists the result, and returns a JSON object identifying the cooked recipe. R05: an insufficient-stock failure exits nonzero, explains the failure on stderr, leaves existing store bytes unchanged, and consumes none of the available ingredients.
Qualification: the candidate requirement must state observable success and rejection behavior unambiguously and must not weaken atomic failure. No specific heading, numbering or technical implementation is prescribed.
