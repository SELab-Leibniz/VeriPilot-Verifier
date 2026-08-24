# Runtime Corrector

> 中文版（默认）: [README.md](README.md) · [Documentation index](docs/README.md)

**What it is:** a Claude Code plugin that reviews your coding agent's work in real time. While the agent writes code, it checks the changes against the task requirements and feeds problems back; when the agent declares "done", it runs an acceptance check — and blocks completion with a concrete to-do list until the work is actually done or the correction budget runs out.

**What it never does:** it never modifies your project files, never auto-applies patches, and never blocks development because of its own faults (fail-open). The main agent — and you — always keep the final say.

## The cooperation loop in 30 seconds

```text
you send a request ────► the corrector records it in the task baseline (Ground Truth)
agent writes code ─────► the corrector reviews the change ──► top-3 problems + candidate patches go back to the agent
agent fixes, or rejects with evidence ──► … (loop)
agent says "done" ─────► the termination gate:
    hard problems + budget left ──► BLOCK + concrete to-dos ──► agent continues
    budget exhausted ───────────► ALLOW + "unresolved findings recorded" disclosure
    acceptance passes ──────────► ALLOW
```

Three things to keep in mind:

1. **The agent does not need to know the corrector exists.** Zero coupling — the corrector sits on Claude Code lifecycle hooks and works the same whatever model drives the coding agent.
2. **Feedback is rationed.** At most 3 top problems go back inline; the full record is written to disk (the agent can read more on demand). It never floods the agent's context.
3. **Only deterministically-proven hard problems can block completion.** Inferred concerns advise but never block, and blocking has a budget (default 3 per epoch, `maxCorrectionsPerEpoch`) — a session can never be trapped forever.

## 1. Install

Requirements: a recent **Claude Code** (plugins, hooks, skills) and **Node.js >= 18**. The plugin has **zero npm dependencies**.

```bash
# option a: as a marketplace plugin
claude
> /plugin marketplace add /path/to/runtime-corrector
> /plugin install runtime-corrector@runtime-corrector-local

# option b: point at the plugin directory
claude --plugin-dir /path/to/runtime-corrector

# option c: from a clone
git clone <repository-url> runtime-corrector
claude --plugin-dir ./runtime-corrector
```

## 2. Quick start (zero config)

Install the plugin, open **any** project, and just work — no configuration needed. On a new task's first event, three things happen automatically:

1. **Material discovery**: it finds `README*`, `docs/**/*.md`, and markdown named like `requirement`/`spec`, and fingerprints the platform (`oh-package.json5` → harmonyos). The result is journaled once per task (`DERIVED_CONFIG`).
2. **Baseline building**: two independent extractors decompose the materials and your request into atomic requirements, a skeptical adjudicator merges them, and the baseline **freezes** — from then on only your real messages can change it; the agent's own inferences never can.
3. **Review begins**: every change and every completion attempt is checked against the frozen baseline.

A first intervention typically looks like:

```text
[runtime-corrector] Terminal correction 1/3
Task incomplete: the delete flow required by the README is not implemented.
- CR-003: the material requires swipe-to-delete, but no delete path exists
- M14: milestone "list interactions" has no verification evidence
Continue the task and correct these deviations, or reject with evidence.
```

To see and edit what was derived, run `/runtime-corrector:init` — it materializes the same derivation into an annotated `.runtime-corrector/config.yaml`.

## 3. How it cooperates with your coding agent

### When it triggers

The corrector sits on Claude Code lifecycle hooks; the agent is **synchronously paused** at each trigger, so feedback arrives before the next action:

| Moment | What the corrector does |
|---|---|
| Session starts | validates/recovers local state; on a new task, builds the baseline (above) |
| You send a message | mines it for new/changed requirements — the only authority that can amend a frozen baseline |
| Before a skill runs | gates the invocation against that skill's frozen contract |
| After the agent writes a file | reviews the artifact: deterministic checks + an isolated semantic review |
| Agent declares completion | the termination gate: acceptance review + implementation checks (kit integration, build/device verification) → allow or block |

### How signals go back

| Channel | Nature | Content |
|---|---|---|
| Context injection | advisory | top-3 diagnostics + top-2 candidate patches inline; disk paths for the full record. Patches are **never auto-applied** — fixing or rejecting with evidence is the agent's decision |
| Stop block | coercive, budgeted | `decision: block` + the to-do list. Only hard problems can block; after `maxCorrectionsPerEpoch` attempts the gate opens with a `CORRECTION_BUDGET_EXHAUSTED` disclosure |
| Disk record | pull-based | full diagnostics, the baseline ledger, and the journal under `.runtime-correction/` — readable by the agent and by humans at any time |

```text
.runtime-correction/
├── latest/<stage>/<artifact>/diagnostic.md   # latest full diagnostics
├── latest/<stage>/<artifact>/patch.diff      # candidate Git patch (never auto-applied)
├── latest/<stage>/<artifact>/result.json     # machine-readable result
├── runs/<stage>/<artifact>/<roundId>/        # per-round archive
└── tasks/<taskId>/
    ├── ground-truth/current.md               # frozen baseline (human-readable)
    ├── evaluations/*.json                    # review reports
    └── journal/events.jsonl                  # append-only event journal
```

### Where reviewers run

Every reviewer (extraction, adjudication, skill, artifact, stop, implementation) is an **isolated read-only sub-session**: `Read`/`Grep` only, output constrained by a JSON schema, released when done. Review reasoning never leaks into the agent's context — except through the rationed feedback above.

Sessions start three ways. Roles that need the development conversation use `fork` (the default, branching the parent session). **Baseline building defaults to `detached`** — it works from the materials carried in its request, so forking an ever-growing parent buys nothing and costs real time (the material text is inlined into the request, so the reviewer never re-reads the files). `independent` is a fresh session against a configured provider, for heterogeneous cross-checking.

## 4. Six terms

| Term | Meaning |
|---|---|
| Ground Truth (baseline) | the ledger of atomic requirements decomposed from materials + your messages; frozen once built |
| Freeze | after freezing, only your explicit messages can add/remove baseline entries — agent inference never can |
| Finding | a concrete deviation from one review, always citing a baseline entry or objective evidence |
| Correction budget | how many times the gate may block (default 3); once spent it opens and records what's unresolved — sessions are never trapped |
| Assurance level | how deep this acceptance actually verified: static / build / device — see §6 |
| Open question | ambiguity in the materials enters the baseline as a question + a default-safe reading, never an invented directive; one message from you resolves it |

## 5. Configuration

**Most projects need none.** When you do, create `.runtime-corrector/config.yaml`; precedence is always: plugin defaults < derived < explicit.

### Three common recipes

```yaml
# ① Observe-only: record everything, intervene never (for controlled evaluation)
shadowMode: true

# ② Cross-check the critical gates with an independent model (recommended):
#    baseline adjudication + the termination gate
reviewers:
  modelPolicy:
    preset: critical-gates      # critical-gates = those two roles; all = every role
    provider:
      baseUrl: https://api.example-provider.com
      apiKeyEnv: REVIEWER_API_KEY   # the NAME of an env var — no secrets in config
      model: example-reviewer-model

# ③ CI hard-requires device-level verification: no device counts as an
#    infrastructure failure and blocks
implementationCorrection:
  device:
    mode: required
```

> **No secrets anywhere.** `apiKeyEnv` stores the *name* of an environment variable; the key value exists only in the reviewer subprocess environment and is never written to disk, journal, or logs. If the variable is unset, the reviewer falls back to the default session and records `REVIEWER_PROVIDER_DEGRADED`.

### Full key reference

```yaml
version: 2                      # 2 enables the runtime-correction capabilities
locale: zh                      # feedback language; unset => derived from LC_ALL/LANG

dynamicGroundTruth:
  enabled: true
  materialRoots: [docs/]        # unset => auto-discovered
  panel:
    size: 2                     # baseline extraction passes; 0 disables onboarding
    adjudicator: true           # skeptical merge

stopCorrection:
  enabled: true
  maxCorrectionsPerEpoch: 3     # termination-gate budget

implementationCorrection:
  enabled: true
  platform: harmonyos           # platform adapter; unset => fingerprinted; null => kit check off
  checklistPaths: [docs/kits.md] # optional explicit kit checklist documents
  checklistSection: "10\\.1"    # checklist heading regex (default: content-based match)
  kitColumnIndex: 0             # kit-name column (auto-located from the header when possible)
  # Checklist document vocabulary (defaults ship as data in
  # config/checklist-vocabulary.v1.json; override for other languages/conventions)
  kitHeaderPattern: "kit|依赖"   # which column holds capabilities (matched against the header)
  candidacyMarkers: "候选|feasib" # the whole table lists candidates -> advisory, never blocking
  hedgeMarkers: "候选|POC|future" # a cell hedges its own entry -> that entry is advisory
  device:
    mode: auto                  # auto = degrade with the environment / required = CI / off = static only
  deviceBudgetMs: 600000        # wall-clock ceiling for build/device verification

evidenceRoots: [evidence]       # evidence-distinctness guard (off when unset)

output:
  directory: .runtime-correction
```

**Reviewer roles.** Every role accepts `model`, `effort`, `timeoutMs`, `maxBudgetUsd`, `session` (`fork` default / `detached` = fresh session, no provider needed / `independent` = fresh session against a configured provider), `provider`; `defaults` covers all roles (effort `low`, 240s timeout, session `fork`). Roles: `groundTruthExtractor` (materials → baseline), `onboardingAdjudicator` (merge & freeze), `skillReviewer`, `artifactReviewer`, `stopReviewer` (termination gate), `implementationReviewer`. Explicit per-role config always beats the `modelPolicy` preset.

Version-1 artifact/stage correction (per-file hard rules, semantic review, workflow edges) is documented in [docs/configuration.md](docs/configuration.md); `/runtime-corrector:init` keeps the full reference as `config.reference.yaml`.

### Commands

| Command | Purpose |
|---|---|
| `/runtime-corrector:init` | materialize the derived config as an editable `config.yaml` |
| `/runtime-corrector:help` | project-aware help and stage status |
| `/runtime-corrector:validate` | validate the project policy |
| `/runtime-corrector:stages` | list/toggle v1 artifact stages |
| `/runtime-corrector:explain <stage>` / `:spec <stage>` | explain the active policy / full stage spec |
| `/runtime-corrector:check <artifact>` | check one artifact manually |

## 6. Verification depth: device / build / static

Implementation acceptance picks its verification depth from the environment. Every concrete command is declared by the platform adapter — the core contains no platform commands:

| Level | Condition | What runs |
|---|---|---|
| `device` | a device/emulator is detected + the toolchain exists | build gate + install/launch/screenshot smoke |
| `build` | toolchain only | build gate (cached per source digest — identical sources never rebuild) |
| `static` | neither / platform declares nothing / `mode: off` | static verification |

Three disciplines: **a missing device lowers the assurance level, never flips a judgement** — checks the environment cannot run are skipped with a recorded reason (never marked PASS, never charged to the agent); only checks that ran and objectively failed (a build break, a launch crash) become blocking findings; and every acceptance feedback carries an assurance disclosure line, so a static-only green never masquerades as a device-verified one.

## 7. When things go wrong

The plugin's ordinary checks **fail open**: its own faults never block development. **The termination gate is the one exception**: when the final acceptance cannot run, it does not pretend the check passed — it blocks and asks for a retry. That blocking is strictly bounded, so a session can never be trapped:

| Situation | Behavior |
|---|---|
| Review failure (baseline refresh failed, reviewer timed out or crashed) | blocks, at most 2 attempts, then releases disclosing "completed but unverified" |
| The plugin runtime itself crashes (unreadable transcript, corrupt state file, …) | same 2-attempt ceiling, then releases — a bug in the plugin must never trap a session |
| Even the retry counter cannot be written (local state is what is broken) | **releases immediately**: the failure mode must degrade toward fail-open, never away from it |
| `stopCorrection.enabled: false` or `shadowMode: true` | the gate is not armed at all and never blocks, crash or not |

Both the block and the release name that off switch, and follow `locale` (Chinese or English). A release carries the `STOP_VERIFICATION_UNAVAILABLE` marker, which stays locale-independent so scripts can match it. The correction budget and this infrastructure ceiling **never spend each other**: an outage does not consume the developer's correction attempts, and vice versa.

For troubleshooting, read `.runtime-correction/tasks/<taskId>/journal/events.jsonl`:

| Journal event | Meaning | Action |
|---|---|---|
| `DERIVED_CONFIG` | informational: what materials/platform were derived | none; run `/runtime-corrector:init` to override |
| `ONBOARDING_DEGRADED` | baseline building failed; falls back to incremental extraction, ledger unfrozen | usually transient; check reviewer timeouts/budgets — it retries automatically |
| `REVIEWER_PROVIDER_DEGRADED` | independent provider unavailable; that review fell back to fork | export the env var named by `apiKeyEnv` |
| `STOP_ASSESSMENT_FAILED` / `STOP_ASSESSMENT_RETRY` | the stop review itself failed; the gate blocks and asks for a retry | inspect the recorded error; repeated failures mean a broken review environment (API key, network) |
| `STOP_VERIFICATION_UNAVAILABLE` | the retry ceiling was spent; the Stop was released but this completion was never verified | do not treat it as verified; fix the review environment and re-run the final acceptance |
| `SKILL_REVIEW_FAILED` / `STOP_REVIEW_FAILED` | one isolated review crashed; marked `UNVERIFIED` | transient; investigate only if recurring |
| `DEVICE_VERIFICATION_UNAVAILABLE` | no device/toolchain; verification degraded with disclosure | connect a device if wanted; use `device.mode: required` in CI |

If the hooks themselves crash, a bounded `[runtime-corrector] v2 features failed open` notice appears (fully silent in observe-only mode) and the session continues.

## 8. Design guarantees

- **Read-only reviewers.** Reviewer subprocesses have only `Read`/`Grep`; everything they read is treated as evidence, never as instructions.
- **Never edits for you.** No project file changes, no auto-applied patches; change decisions belong to the main agent.
- **No secrets anywhere.** No endpoint/key literals in code; config stores env-var names only.
- **Platform as data.** Platform conventions (module naming, source roots, device commands) are `config/platforms/*.json` data; an unknown or `null` platform just skips the corresponding checks.
- **Deterministic checks are model-independent.** Hard rules, kit integration, the build gate, evidence distinctness, and closure attribution are plain code — reproducible with any model.
- **No instance decisions.** The plugin never decides whether the user is continuing an existing change or creating a new one, and never selects the "latest" document by modification time; with only `patterns` configured and no correlation, all matched files belong to one legacy bundle by design.
- **Observe-only mode.** `shadowMode: true` records identical detections with zero intervention.

## More documentation

Full index at [docs/README.md](docs/README.md):

- v2 design & configuration: [docs/runtime-corrector-v2-design.md](docs/runtime-corrector-v2-design.md)
- v1 artifact/stage configuration & rules: [docs/configuration.md](docs/configuration.md)
- End-to-end mechanics of one correction round: [docs/how-it-works.md](docs/how-it-works.md)
- Commands, CLI, hook JSON, custom matchers: [docs/interfaces.md](docs/interfaces.md)
- Tutorials: [docs/tutorial.md](docs/tutorial.md), [docs/six-stage-workflow-from-zero.md](docs/six-stage-workflow-from-zero.md)
- Copy-ready business examples under `examples/`
