# Runtime Corrector

> 中文版（默认）: [README.md](README.md)

A runtime critic for coding agents, packaged as a Claude Code plugin. It watches a development
session through lifecycle hooks, builds its own ground truth of what the task requires, reviews the
agent's work in isolated read-only sessions, and intervenes with rationed, evidence-backed
corrections — including a termination gate that blocks a premature "done".

[中文说明 / Chinese README](README.md) · [Documentation index](docs/README.md)

## 1. What it is

Runtime Corrector is built on four mechanisms:

1. **Event-driven intervention on self-built runtime ground truth.** On the first hook event of a
   task, an onboarding panel decomposes all task materials (README, requirement/spec documents,
   the user's actual request) into atomic Ground Truth claims; an adjudicator merges the panel's
   proposals skeptically and the ledger **freezes**. After the freeze only explicit user messages
   can change the baseline — the agent's own inferences cannot.
2. **Isolated review.** Every reviewer (extractor, adjudicator, skill reviewer, artifact reviewer,
   stop reviewer, implementation reviewer) runs in a separate read-only Claude session (`Read` and
   `Grep` only, structured JSON output enforced by schema). Reviewers can optionally run on an
   independent provider/model for heterogeneous cross-checking.
3. **Rationed feedback with strictly attributed closure.** Delivered diagnostics are capped (top-3
   inline for artifact checks, bounded per-skill feedback budgets, bounded Stop corrections per
   epoch); everything else is persisted on disk. Every finding becomes a deviation family whose
   closure is attributed — a fix only counts as critic-driven if it landed after the finding was
   actually delivered.
4. **Termination gate.** When the agent tries to stop, a stop reviewer judges the frozen metric
   population and open findings. Unfinished work blocks the stop with a concrete to-do list, up to
   a configured correction budget; after the budget is exhausted the stop is allowed and the
   unresolved findings are recorded.

```text
             Claude Code development session
   SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · Stop
                            |
                            v  (plugin hooks)
 +---------------------- Runtime Corrector ------------------------+
 |                                                                 |
 |  zero-config derivation ──> config compile (defaults<derived<explicit)
 |                            |                                    |
 |  task onboarding: materials ─> extractor panel ─> adjudicator   |
 |                                  └──> Ground Truth ledger (FROZEN)
 |                            |                                    |
 |  isolated read-only reviewers (fork or independent provider)    |
 |    · artifact review   · skill watcher   · implementation review|
 |    · deterministic checks (hard rules, kit-integration)         |
 |                            |                                    |
 |  deviation families ──> rationed feedback ──> Stop gate         |
 |  journal + evaluations persisted under .runtime-correction/     |
 +-----------------------------------------------------------------+
                            |
                            v
      diagnostics / candidate patches / block-or-allow decision
```

The plugin **never edits project files and never applies patches** — it diagnoses, persists
evidence, and feeds the main agent decisions it can act on.

## 2. Installation

Requirements: **Claude Code** with plugin, hooks, and Skill support (a current release), and
**Node.js >= 18**. The plugin has **zero npm dependencies**.

**a) As a marketplace plugin**

```bash
claude
> /plugin marketplace add /path/to/runtime-corrector   # or a git URL hosting this directory
> /plugin install runtime-corrector@runtime-corrector-local
```

**b) Directly from a directory**

```bash
claude --plugin-dir /path/to/runtime-corrector
```

**c) From a fresh clone**

```bash
git clone <repository-url> runtime-corrector
claude --plugin-dir ./runtime-corrector
```

## 3. Quickstart (zero-config)

Install the plugin, open **any** project, and start working. No `.runtime-corrector/` directory is
required. On the first hook event of a new task:

1. **Auto-derivation** runs: task materials are discovered (`README*`, `docs/**/*.md`,
   `*requirement*`/`*spec*` markdown, capped and deterministic) and the platform is fingerprinted
   (`oh-package.json5` → `harmonyos`; a plain `package.json` project has no adapter yet → the
   deterministic kit check stays off). What was derived is journaled once per task as a
   `DERIVED_CONFIG` event.
2. **Task onboarding** runs: two independent extractor passes decompose the materials and the user
   request into atomic claims, an adjudicator merges them, and the Ground Truth ledger freezes
   (`ONBOARDING_COMPLETED` in the journal).
3. From then on the corrector reviews the session against the frozen baseline. A first
   intervention typically looks like:

```text
[runtime-corrector] Terminal correction 1/3
The task is not complete: the delete flow required by README.md is not implemented.
- CR-003: swipe-to-delete is required by the material but no delete path exists
- M14: milestone "list interactions" has no verification evidence
Continue the task, correct these deviations, or respond with an evidence-based rejection.
```

To make the derived choices visible and editable, run `/runtime-corrector:init` — it materializes
the same derivation into a commented `.runtime-corrector/config.yaml`.

## 4. Configuration reference

Configuration lives in `.runtime-corrector/config.yaml`. Precedence is always
**plugin defaults < derived values < explicit config**. A walkthrough of the important keys:

```yaml
version: 2                      # 2 enables the runtime-critic features below

locale: en                      # zh (default) | en — language of delivered diagnostics

dynamicGroundTruth:
  enabled: true
  materialRoots:                # task materials; unset => auto-discovered
    - README.md
    - docs/requirements.md
  panel:
    size: 2                     # onboarding extractor passes; 0 disables onboarding
    adjudicator: true           # skeptical merge of panel proposals

stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3     # Stop-gate budget; exhausted => stop allowed, findings recorded

implementationCorrection:
  enabled: true
  platform: harmonyos           # platform adapter; unset => fingerprinted; null => kit check off
  checklistPaths: [docs/kits.md] # optional explicit kit checklist documents
  checklistSection: "10\\.1"    # regex matching the checklist section heading
  kitColumnIndex: 0             # kit-name column in the checklist table
  device:
    mode: auto                  # auto = degrade with the environment / required = CI hard-requires device level / off = static only
  deviceBudgetMs: 600000        # wall-clock ceiling for deterministic build/device verification

evidenceRoots: [evidence]       # dirs guarded for evidence-file distinctness (off when unset)

output:
  directory: .runtime-correction # where diagnostics/state are written
```

**Reviewer roles.** All reviewers accept `model`, `effort` (`low`…`max`), `timeoutMs`,
`maxBudgetUsd`, `session`, `provider`; `defaults` applies to every role:

| Role | Judges | Defaults |
|---|---|---|
| `defaults` | fallback for all roles | effort `low`, timeout 240 s, session `fork` |
| `groundTruthExtractor` | material/transcript → atomic claims (also panel passes) | inherits |
| `onboardingAdjudicator` | skeptical merge of panel proposals (freeze gate) | inherits |
| `skillReviewer` | Skill execution vs. its frozen contract | inherits |
| `artifactReviewer` | written artifacts vs. frozen Ground Truth / stage metrics | inherits |
| `stopReviewer` | may the session stop? (termination gate) | inherits |
| `implementationReviewer` | the built app vs. the frozen population | inherits |

**Heterogeneous review (recommended).** The two self-consistency-critical gates — the onboarding
adjudicator (freezes the baseline) and the stop reviewer (decides whether work may end) — can run
in a **fresh, independent session on a different provider/model** instead of a fork of the parent
session:

```yaml
reviewers:
  onboardingAdjudicator:
    session: independent        # fresh session, no --resume of the parent
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY   # NAME of an env var — never a key literal
      model: example-reviewer-model
  stopReviewer:
    session: independent
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY
      model: example-reviewer-model
```

Equivalent preset shorthand (`critical-gates` covers exactly those two roles; `all` covers every
role; explicit per-role keys always win):

```yaml
reviewers:
  modelPolicy:
    preset: critical-gates
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY
      model: example-reviewer-model
```

> **No secrets in config.** `apiKeyEnv` is the *name* of an environment variable. The key value is
> read at spawn time, exists only in the reviewer subprocess environment, and is never written to
> disk, journal, or logs. If the variable is unset or empty, the reviewer degrades to the default
> fork session and journals `REVIEWER_PROVIDER_DEGRADED`.

Version 1 artifact/stage correction (per-file hard rules, semantic review, workflow edges) is
documented in [docs/configuration.md](docs/configuration.md); `/runtime-corrector:init` leaves a
commented reference as `config.reference.yaml`.

## 5. Usage — what you see in a session

**Delivered diagnostics are rationed.** Artifact checks show at most the top-3 most severe findings
inline (plus candidate-patch counts); Skill feedback is budgeted per skill; Stop corrections are
budgeted per epoch. Full detail always lands on disk:

```text
.runtime-correction/
├── latest/<stage>/<artifact>/diagnostic.md   # newest full diagnostics
├── latest/<stage>/<artifact>/patch.diff      # candidate Git patch (never auto-applied)
├── latest/<stage>/<artifact>/result.json     # machine-readable result
├── runs/<stage>/<artifact>/<roundId>/        # archived earlier rounds
└── tasks/<taskId>/
    ├── ground-truth/current.json             # the frozen ledger
    ├── evaluations/*.json                    # stop/artifact/impl review reports
    └── journal/events.jsonl                  # append-only event journal
```

**Acting on corrections.** The main agent (or you) can fix the deviation, or reply with an
evidence-based rejection; both paths are recorded, and closures are attributed honestly.

**Resolving `OPEN_QUESTION` items.** Ambiguities in the task materials are frozen as open
questions with a default-safe reading, never as invented directives. A plain user message in the
session resolves them: after the freeze, only `USER_EXPLICIT` authority can supersede baseline
claims — just say what you actually want.

**The Stop gate.** When the agent declares completion prematurely, the Stop is blocked with a
`Terminal correction n/N` message listing the blocking objects. After `maxCorrectionsPerEpoch`
attempts the gate opens (`CORRECTION_BUDGET_EXHAUSTED`) and the unresolved findings stay recorded.

**Commands.**

| Command | Effect |
|---|---|
| `/runtime-corrector:init` | materialize the derived config into an editable `config.yaml` |
| `/runtime-corrector:help` | project-aware help and stage state |
| `/runtime-corrector:validate` | validate the project policy |
| `/runtime-corrector:stages` | list/toggle v1 artifact stages |
| `/runtime-corrector:explain <stage>` / `:spec <stage>` | explain the active policy / full stage spec |
| `/runtime-corrector:check <artifact>` | check one artifact on demand |

## 6. Degradation & troubleshooting

The plugin **fails open**: its own faults never block development. Look in
`.runtime-correction/tasks/<taskId>/journal/events.jsonl`:

| Journal event | Meaning | Action |
|---|---|---|
| `DERIVED_CONFIG` | informational: which materials/platform were auto-derived for this task | none; materialize with `/runtime-corrector:init` to override |
| `ONBOARDING_DEGRADED` | panel/adjudication/apply failed; fell back to incremental extraction, ledger unfrozen | usually transient; check reviewer timeouts/budget, re-trigger with a new task |
| `REVIEWER_PROVIDER_DEGRADED` | independent-session provider unusable (env var unset/empty or provider not configured); reviewer ran as a fork instead | export the env var named by `apiKeyEnv`, verify `provider.baseUrl` |
| `STOP_ASSESSMENT_FAILED` | the stop review itself errored; the Stop was allowed (fail-open) with the failure journaled | inspect the recorded error; a later Stop retries |
| `SKILL_REVIEW_FAILED` / `STOP_REVIEW_FAILED` | one isolated review crashed; watcher marked `UNVERIFIED` | transient reviewer fault; no action unless recurring |

If hooks themselves crash, a bounded `[runtime-corrector] v2 features failed open` notice is
emitted (never in observe-only mode) and the session continues.

### 6.1 The device-verification ladder (device / build / static)

On top of static checks, the implementation review runs a deterministic verification
ladder that **degrades honestly with the environment**. Every concrete command is
declared by the platform adapter's `deviceCheck` section (probes, build gate, smoke
steps) — the core framework contains no platform commands, and a platform without a
`deviceCheck` simply caps at the static level:

| Level | Condition | What runs |
|---|---|---|
| `device` | a connected device/emulator is probed AND the toolchain exists | build gate + adapter-declared smoke steps (install/launch/screenshot) |
| `build` | toolchain only (e.g. a project `hvigorw`) | build gate (cached on the source-manifest digest — identical sources never rebuild) |
| `static` | neither / platform declares nothing / `device.mode: off` | static verification only (all of 1.0.x behavior) |

Three disciplines: **a missing device lowers the assurance level, never flips a
judgement** — checks the environment cannot run are skipped with a recorded reason
(never PASS, and never a deviation charged to the developer); only checks that DID
run and objectively failed (a build break, a crash on launch) become blocking
findings (`impl:build:*` / `impl:device:*`); and every Stop feedback carries an
assurance disclosure line (e.g. `Assurance: static-level verification only …`), so a
static-only green is never mistaken for a device-verified one. In CI, set
`device.mode: required` to turn "no device connected" itself into a blocking
infrastructure finding.

## 7. Design guarantees

- **Read-only reviewers.** Every reviewer subprocess is restricted to `Read`/`Grep`, with
  Write/Edit/Skill/Agent/MCP disabled; role prompts treat all content as evidence, not
  instructions.
- **Never edits your work.** The plugin never modifies project files and never applies candidate
  patches; every change decision stays with the main agent.
- **No secrets anywhere.** No API endpoint or key literals in code; configuration stores env-var
  *names* only; provider credentials live only in the reviewer subprocess environment.
- **Platform adapters.** Platform conventions (module naming, source roots) are data under
  `config/platforms/*.json`; unknown or `null` platforms simply skip the kit check.
- **Deterministic checks independent of the LLM.** Hard rules, the kit-integration check, evidence
  distinctness, and closure attribution are plain code — reproducible regardless of any model.
- **Never guesses workflow instances.** The plugin does not decide whether you are continuing an
  existing change or creating a new one, and never selects the "latest" document by modification
  time; with `patterns` and no correlation, matched files form one legacy bundle by design.
- **Observe-only mode.** `shadowMode: true` records identical detection with zero intervention,
  for evaluating the critic on an untouched run.

## More documentation

See [docs/README.md](docs/README.md) for the full documentation index:

- v2 design and configuration: [docs/runtime-corrector-v2-design.md](docs/runtime-corrector-v2-design.md)
- v1 artifact/stage configuration and rules: [docs/configuration.md](docs/configuration.md)
- End-to-end mechanics of one correction round: [docs/how-it-works.md](docs/how-it-works.md)
- Commands, CLI, hook JSON, custom matchers: [docs/interfaces.md](docs/interfaces.md)
- Tutorials: [docs/tutorial.md](docs/tutorial.md),
  [docs/six-stage-workflow-from-zero.md](docs/six-stage-workflow-from-zero.md)
- Copyable business workflows under `examples/`
