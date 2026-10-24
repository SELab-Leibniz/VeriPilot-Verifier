# One-obligation review engine

This promotes the isolated worker saved at commit 81a5b9e. Pi 1.4.0 owns the agent loop, read-only tools, append-only session and native compaction. The adapter validates one small decision, resolves cite IDs to disclosed source ranges, saves it durably and exposes checkpoint/history retrieval. The six original system-prompt paragraphs are unchanged. Production routing and the Stop collector are separate callers.

The integration adds optional task.targetPrefixes: canonical relative directory prefixes such as project/ or process/. A real targetFiles seed is still required. A checked source under a prefix can establish target evidence without serializing every project path in the initial prompt; a basis-only citation cannot qualify by prefix. Undefined prefixes retain the original behavior.

API: runReviewTask from review-task.mjs; reviewPromptProfile(metricId, scope) from prompt-profile.mjs; ModelRuntime from sdk.mjs resolves this package's locked SDK. Unsupported/untuned profiles have no prompt addition. M12's v2 addition is selected only for SOURCE_IMPLEMENTATION, with RUNTIME_ACCEPTANCE retaining the base system prompt. Cache owners can include REVIEW_PROMPT_PROFILE_DIGEST to invalidate older prompt decisions.

Dependencies are isolated in this package. Use npm ci --ignore-scripts --prefix lib/review-task when preparing the development workspace or a distribution that preserves this directory. Root Node 18 CLI code must not eagerly import this Node >=22.19 SDK. OpenClaw packaging owns installation/copying of these locked runtime dependencies; this module never installs packages at runtime.

The SDK versions remain the tested versions. Production adds the optional target prefixes described above and cancellation checks around preparation; both are covered by focused tests. The dependency override changes undici 8.10.2 -> 8.12.2. Pi 1.4.0 pins the old transport version. This is a transport patch, not a prompt or model change. The new package lock's audit reports zero known findings at preparation time.

The promoted mechanism suite is test/review-task-engine.test.mjs plus its three review-task sources. It runs scripted providers without business execution or network model calls; it does not estimate model-review accuracy.
