# Kitchen test contracts
Setup recipe "粥"={"rice":2,"oil":2}, pantry={"rice":5,"oil":1}. Invoke cook "粥" in a fresh process. Assert exit is nonzero and stderr mentions insufficient oil. The checks end here; do not inspect the store after the command.
