# Authoritative kitchen requirement
R03: recipe add accepts a nonempty JSON object of nonempty ingredient names to positive integer amounts; booleans are invalid. Invalid input exits nonzero with explanatory stderr and leaves existing store bytes unchanged. The decomposition must preserve these concrete input and rejection semantics and be unambiguous enough to verify.
