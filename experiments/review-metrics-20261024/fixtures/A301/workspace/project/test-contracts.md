# Kitchen test contracts
## Atomic rejection check
Setup: persist recipe "粥"={"rice":2,"oil":2} and pantry={"rice":5,"oil":1}; save the store bytes B before invocation.
Stimulus: invoke a fresh CLI process with that store and cook "粥".
Oracle: exit status is nonzero; stderr explains insufficient oil; after termination the store bytes equal B exactly. Since B contains rice=5 and oil=1, the exact-byte oracle also rejects partial deduction. The fixture and oracle are shared and complete. No execution result is supplied or required for this test-plan review.
