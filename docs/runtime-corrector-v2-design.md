# Runtime Corrector v2 design

Status: implemented contract
Metric catalog: `vp-m01-m15-v1`

## Goals

Runtime Corrector v2 keeps the existing artifact node/edge correction model and adds three opt-in correction loops:

1. a task-scoped, dynamically versioned Ground Truth ledger;
2. Skill execution supervision based on a task-specific natural-language constraint graph;
3. stage and terminal assessment using M01 through M15.

The corrector diagnoses and records. It never edits project artifacts or applies patches on behalf of the main agent.

## Trust and authority

Ground Truth claims use this authority order:

1. `USER_EXPLICIT`
2. `MATERIAL_DERIVED`
3. `PROJECT_CONSTRAINT`
4. `AGENT_INFERRED`

`AGENT_INFERRED`, `BASIS_PENDING`, and conflicted claims can be reviewed but cannot independently block Stop. Assistant messages, hook feedback, internal-reviewer output, and agent-modified user material cannot become `USER_EXPLICIT`.

Ground Truth is an append-only ledger. Updates use `ADD`, `SUPERSEDE`, `RETRACT`, `CONFLICT`, and `RESOLVE`; the current JSON document is a deterministic projection of the ledger. Every assessment pins the Ground Truth version, metric-population version, target snapshot digest, and transcript cursor. After onboarding the ledger carries `frozenAtVersion`: post-freeze operations with any authority other than `USER_EXPLICIT` are dropped fail-soft (journaled as `GROUND_TRUTH_POST_FREEZE_OPS_DROPPED`), so new real user messages can still supersede the baseline while agent inference cannot.

## Automated task onboarding

On the first correction-relevant action of a new task — before `Skill`, `Bash`, `PowerShell`, `Write`, `Edit`, `NotebookEdit`, or `Monitor` is released — the orchestrator crosses a lazy correction barrier and runs the onboarding pass over `dynamicGroundTruth.materialRoots` (`lib/runtime-v2/onboarding.mjs`). Session startup, plugin reload, ordinary greetings, compaction, and teardown do not run onboarding. A terminal completion claim at `Stop` also crosses the barrier when no tool did. There is no user confirmation anywhere in this flow.

1. **Panel decomposition.** `dynamicGroundTruth.panel.size` (default 2) independent `onboarding-extractor` passes decompose ALL task materials into atomic claims in a single dedicated pass per reviewer. Passes run in PARALLEL (onboarding must fit one hook event) and DETACHED by default — a fresh session rather than a fork, because the extractor works from the materials in its request and forking a large, actively growing parent conversation is pure cost. The manifest inlines each material's text (capped, truncation flagged) so a detached extractor never re-reads the files. Passes reuse the `groundTruthExtractor` configuration but raise its timeout floor: a bulk decompose of a full requirements document is not an incremental refresh. An explicit per-role `session` always wins.
2. **Adjudication.** With `panel.adjudicator: true` (default), one `onboarding-adjudicator` reviewer (config role `onboardingAdjudicator`) receives the panel claim sets plus a deterministic majority/disputed partition and merges them: majority-agreed claims are confirmed (stamped `panelConfirmed` on the ledger); disagreements and open questions are decided with a skeptic instruction — prefer the narrower claim; unresolvable ambiguity stays an `openQuestions` claim that must carry a default-safe reading the corrector can review against. With `adjudicator: false` the deterministic merge applies: the majority stands and disputed claims are downgraded to `AGENT_INFERRED`/`SOFT`.
3. **Freeze.** The merged delta is applied as one ledger version and the ledger freezes (`frozenAtVersion`). Reviews thereafter run against the frozen baseline plus any user-explicit deltas. An empty merge result never freezes.
4. **Fail-soft.** A fully failed panel, a failed adjudication, or a rejected delta journals `ONBOARDING_DEGRADED` and falls back to the incremental single-extractor behavior — as does `panel.size: 0` or `dynamicGroundTruth.enabled: false`. Completed and permanent outcomes are reused from `task.json`; bounded deferred failures retry only at a later correction barrier, never during `SessionEnd`.

### Self-extracted capability checklist

The onboarding extractor also mines dependency/capability obligations into `capabilityChecklist` claims (capability name, expected module/dependency, source hint): explicit dependency/kit tables become `MATERIAL_DERIVED`/`HARD` entries; obligations inferred from requirement semantics become `AGENT_INFERRED`/`SOFT`. After adjudication the entries are cross-checked deterministically against the platform adapter catalog (`config/platforms/<name>.json` names and special cases); entries not resolvable to a platform module are kept but flagged `catalogUnmatched` — review-only, never Stop-blocking.

The deterministic kit-integration checker (`lib/runtime-v2/impl-review.mjs`) consumes the frozen `capabilityChecklist` claims as its primary source and cites the claim ids in findings; the wave-1 checklist-table parser remains the fallback when onboarding produced no checklist. Stop-blocking stays limited to claims that are not inferred-only: a hard table-derived or panel-majority-confirmed entry that is missing from the production source is an `error` (blocks), an inferred-only entry is a `warning`.

## Task and session identity

State belongs to a task episode, not merely a directory. Native session resume and Runtime Corrector internal forks inherit the episode. A new unrelated session starts a new task unless it explicitly names a task ID. User changes to hard requirements start a new correction epoch; agent inference does not.

The canonical local layout is:

```text
.runtime-correction/tasks/<taskId>/
  task.json
  ground-truth/current.json
  ground-truth/current.md
  ground-truth/history.jsonl
  skills/<skillId>/skill-ground-truth.json
  skills/<skillId>/skill-ground-truth.md
  metrics/population.json
  evaluations/
  journal/
```

JSON is authoritative. Markdown is a read-only rendering. The directory remains excluded from Git by default.

## Hook lifecycle

| Event | Responsibility |
|---|---|
| `SessionStart` | validate configuration and clean up stale internal-run leases and Runtime Corrector atomic temp files; never create a task or reviewer |
| `UserPromptSubmit` | non-creating lookup; reconcile an existing task, reset the turn barrier, and retain due watcher checks |
| `PreToolUse(Skill\|Bash\|PowerShell\|Write\|Edit\|NotebookEdit\|Monitor)` | synchronously cross the lazy barrier; Skill additionally resolves its source, generates Skill Ground Truth, and starts or joins a watcher |
| `PostToolUse(any tool)` | reconcile assistant turns and run due Skill completion checks; parallel events serialize one watcher evaluation per due turn |
| `PostToolUse(Write|Edit)` when an artifact matches | additionally retain node/edge review, refresh Ground Truth, and run checkpoint metrics when configured |
| `Stop` | reconcile turns, expire due Skill watchers, classify the stopping context, run stage/task assessment |
| `PreCompact` | persist the transcript cursor for an existing task only |
| `SessionEnd` | before configuration loading, perform an O(1) task lookup and best-effort lifecycle journaling for an existing task; never run cleanup |

Hooks first perform a cheap, non-creating task lookup. A model fork is created only after the lazy barrier for new evidence, a newly activated evaluation scope, or a changed dependency hash. Parallel first-tool hooks share a session task-creation lock and a long-lived onboarding single-flight lock; a dead owner is reclaimed immediately after Ctrl+C, while a live long-running onboarding is not mistaken for a stale 30-second lock.

## Skill watcher

`PreToolUse(Skill)` resolves and scans only the invoked Skill directory. The extractor creates a task-specific graph covering required steps, prerequisites, conditions, inputs, outputs, and prohibited behavior. Explicit mandatory/prohibited instructions are hard constraints; examples and recommendations are soft.

A turn is one real user message or one unique main-assistant model response. Tool results, hook injections, and internal-reviewer messages do not count. Completion is checked every 10 turns by default. A reviewer returns `COMPLETED` or `NOT_COMPLETED`; a completed execution is then assessed for deviation. At the default maximum of 30 turns, only executed steps and activated constraints are assessed. Missing future steps are `NOT_YET_EXECUTED` unless the agent claimed completion or abandonment. `Stop` always checks an active watcher even before the next interval and uses partial-final semantics: attempting to terminate is a completion or abandonment claim, so an omitted mandatory prerequisite may produce the Skill's one correction feedback and block that Stop once.

Repeated calls to the same active Skill join the watcher and do not reset its window. The default correction budget is one injected deviation per task, Skill, and correction epoch. `PASS` does not consume that budget.

## Artifact and Stop assessment

Every matched artifact write retains existing node and direct incoming-edge review. Dynamic Ground Truth is available as reviewer evidence. Full stage metrics run only for artifacts marked `metricCheckpoint: true`.

Stop first classifies the response as `INTERMEDIATE`, `WAITING_FOR_USER`, `BLOCKED_EXTERNAL`, `STAGE_COMPLETE`, or `TASK_COMPLETE`. Only the final two classifications run metric assessment. A non-terminal classification is normally allowed, but a reviewer finding with blocker/error severity that cites active hard Ground Truth still blocks the attempted Stop. This prevents a contradictory reviewer result such as “INTERMEDIATE, but the agent's completion claim must be blocked” from failing open. A correction epoch permits three blocking Stop responses by default. The next assessment is recorded but cannot block and is marked `CORRECTION_BUDGET_EXHAUSTED` when unresolved. Budget-exhausted assessments return no additional context to the main Agent; this makes the allow decision terminal instead of waking the Agent into another Stop loop.

## Metrics

The versioned catalog uses M01 through M15 from the VeriPilot experiment protocol. A Ground Truth snapshot produces a frozen population: the explicit list of objects in each denominator. The semantic reviewer labels each population object; deterministic code validates the object set and calculates the ratio. Reviewer judgements for IDs outside that frozen population are quarantined as `checkerIssues`: they never affect a numerator or denominator and do not discard valid judgements from the same assessment.

Supported object judgements are `PASS`, `DEVIATION`, `UNVERIFIED`, `BASIS_PENDING`, `EXTERNAL_BLOCKED`, `NOT_APPLICABLE`, `NOT_YET_APPLICABLE`, `CHECKER_ERROR`, and `NOT_YET_EXECUTED`. These states are never silently converted to zero.

## Internal reviewer isolation

An internal run carries an `internalRunId`, role, and depth, backed by a live lease in `.runtime-correction/internal-runs`. Every Runtime Corrector hook immediately returns without state writes or feedback when that identity is valid. `internalDepth >= 1` cannot create another reviewer.

Internal reviewers are read-only and cannot use Skill, Agent, MCP, network, Write, or Edit. A malformed structured result receives one repair attempt in the same reviewer session; a second failure becomes `CHECKER_ERROR` or `UNVERIFIED` and consumes no correction budget. Ground Truth output is constrained to the ledger's canonical category enum; a schema-valid delta that fails claim-reference or authority validation receives one domain-repair follow-up in the same fork before the atomic ledger update.

On Windows, task-state atomic renames retry transient `EPERM`, `EACCES`, and `EBUSY` failures. `SessionStart` removes stale internal-run leases and files matching Runtime Corrector's own hidden atomic-temporary naming convention. `SessionEnd` is routed before configuration loading, records only best-effort lifecycle state for an already indexed task, and is unconditionally silent/fail-open, so Ctrl+C cannot re-enter onboarding or suppress Claude Code's native resume-session footer. Other lifecycle events whose hook schema has no `additionalContext` field fail open silently after recording the warning locally. An active `Stop` is the exception: if Ground Truth refresh, the Stop reviewer, or the lifecycle hook fails before a valid terminal assessment exists, the completion is `UNVERIFIED` and the hook fails closed. Observe-only mode remains silent, and a configuration-load failure remains silent because the arm is not yet known.

## Configuration

New behavior requires `version: 2` and explicit feature flags. Version 1 remains backward compatible and cannot declare v2 keys.

```yaml
version: 2
artifacts: []

dynamicGroundTruth:
  enabled: true
  evidenceCapture: minimal
  materialRoots: [docs]
  # Automated task onboarding: decompose -> agent panel -> freeze.
  # size: 0 disables onboarding and keeps incremental extraction only.
  panel:
    size: 2
    adjudicator: true

skillCorrection:
  enabled: true
  selection:
    mode: include
    include: [documents, my-plugin:release]
    exclude: [experimental-*]
  completionCheckIntervalTurns: 10
  maxWatchTurns: 30
  maxFeedbacksPerSkill: 1

artifactCorrection:
  groundTruthReviewEnabled: true
  stageMetricsEnabled: true

stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3

reviewers:
  groundTruthExtractor:
    effort: low   # onboarding panel passes reuse this role's limits
  onboardingAdjudicator:
    effort: low
```

Every reviewer role also accepts `session` and `provider`. `session: fork` (the default) reviews inside a `--fork-session` of the coding agent's conversation; `session: detached` starts a fresh session with ambient credentials and no parent fork, for roles that work from their request payload alone (task onboarding defaults to this); `session: independent` spawns a fresh session against a configured Anthropic-compatible provider. The recommended heterogeneous setup targets the two highest self-consistency-risk gates — `onboardingAdjudicator` (adjudicates and freezes the Ground Truth ledger) and `stopReviewer` (decides whether work may end). The canonical configuration form is the explicit per-role blocks:

```yaml
reviewers:
  onboardingAdjudicator:
    session: independent
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY   # NAME of the env var — never a key literal
      model: example-reviewer-model
  stopReviewer:
    session: independent
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY
      model: example-reviewer-model
```

`reviewers.modelPolicy` is an equivalent shorthand only: `preset: critical-gates` covers exactly the two roles above, `all` covers every reviewer role, `off` (default) touches nothing, and an explicit `reviewers.<role>.session/provider` always overrides the preset for that role. Whenever configuration is materialized to disk (for example `/runtime-corrector:init`), the preset must be expanded into the explicit per-role blocks — the written file never contains a bare preset keyword. Configuration stores the API key's environment-variable NAME only; if that variable is missing or empty at spawn time the role journals `REVIEWER_PROVIDER_DEGRADED` and falls back to the fork behavior, and the parent session's own credentials are stripped from an independent reviewer's environment so they can never reach the third-party endpoint.

Configuration errors are reported once and v2 features fail open as one unit. Existing v1 artifact correction remains unaffected.
