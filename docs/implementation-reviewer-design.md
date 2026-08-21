# Implementation/Verification Reviewer — Design (Blueprint + Adversarial Critique)

> Produced 2026-08-13 by a 10-agent design workflow (ground → parallel method design → synthesis → adversarial critique), every mechanism verified against source with file:line anchors.
> Decision: Option A (multi-method implementation review) per user directive; methods = defined testcases, code-summary semantic compare, screenshot verification, click simulation, build/manifest/static/log/a11y.

## Build order (amended by the critique)

**Phase −1 (MANDATORY FIRST): delivery-gated closure attribution.** `attributeClosures` (experiments/evaluation/critic-ingest.mjs) stamps every FIXED family as CRITIC with no arm/delivery/temporal check, and closure fires unconditionally in both arms (orchestrator.mjs:917-921, before the shadow strip at :960-973). Fix: stamp `delivered`/`deliveredAt` on observations at record time (corrector) and `fixedAt` on the FIXED transition; attribute CRITIC only when (a) the arm delivered (shadowMode=false), (b) fix post-dates delivery; else SELF. Report V04_net = CRITIC-rate(T1) − SELF-rate(B0). Lock with tests (a B0 closure must never attribute CRITIC).

Then Phase 0 (wiring skeleton) → Phase 1 MVP (Method 2, no device) → Phase 2 (build/manifest/static) → Phase 3 (device spine + journey drive) → Phase 4 (screenshots + testcases) → Phase 5 (hilog/a11y extensions), per the blueprint below, with the critique's eight risk-fixes folded in (symptom-only correction text + ground-truth-token redactor; stop-reviewer barred from PASS on device metrics lacking first-party evidence; transition-invariant assertions, not byte-distinctness; separate/cloned AVD or snapshot-restore; TASK_COMPLETE async barrier instead of in-hook 30-min regression).

---

All facts verified against source. I have what I need to synthesize. Below is the blueprint — returned as my final response.

---

# VeriPilot Runtime Corrector — Implementation/Verification Reviewer: Build Blueprint

**Goal.** Add a reviewer that verifies the *built app* against frozen ground truth using multiple methods, emits deviations the critic delivers as corrections, and lets those deviations **close** (detect → fix → retest → no‑regression) — moving V04 off zero and giving M12/M13/M15 (and M09/M10/M11) real, first‑party signal, **without ever trusting developer‑produced evidence**.

Every mechanism below is anchored to code I read in this session. Two corrections to the architecture map are load‑bearing and verified:

- **Closure keys on the bare `claimId` (`sourceId`), not the `M12:` objectId.** `passedMetricSourceIds` returns `object.sourceId` (`orchestrator.mjs:656‑661`), `sourceId = claim.claimId` (`metrics.mjs:55`), and `markMetricPassesFixed` tests `finding.violatedGroundTruthIds.every(id => passed.has(id))` (`deviations.mjs:130`). So a finding's `violatedGroundTruthIds` **must be the bare `claimId`**; the metric judgement's `objectId` must be the prefixed `M12:<claimId>` (`metrics.mjs:53`). Mixing these is the mechanical reason V04 = 0.
- **There is no M16 at runtime.** `METRIC_CATALOG` is M01–M15 (`metrics.mjs:9‑25`), `METRIC_IDS` length 15 (`config.mjs:4‑6`). `calculateMetricReport` rejects any judgement outside the frozen population as `UNKNOWN_OBJECT` (`metrics.mjs:166‑172`). The "code‑implementation" signal's runtime carrier is **M12** (requirement execution, `earliestPhase IMPLEMENTATION`). V04/M16 are computed offline from the deviation families this pipeline produces.

---

## 1. New role, pipeline, and trigger

| Thing | Value | Where it registers |
|---|---|---|
| Reviewer role (config form) | `implementationReviewer` | `REVIEWER_ROLES`, `config.mjs:8‑13` → auto‑compiles `runtimeV2.reviewers.implementationReviewer` (`config.mjs:77‑80`) |
| Reviewer role (subprocess form) | `implementation-reviewer` | `INTERNAL_ROLES`, `internal-run.mjs:8‑13` (leases throw on unknown role, `:32`) |
| Feature gate | `implementationCorrection.enabled` (+ `deviceBudgetMs`) | new block in `compileRuntimeV2Config`, mirroring `stopCorrection` (`config.mjs:44,68‑71`), OR'd into top‑level `enabled` (`config.mjs:84‑90`) |
| Pipeline name | `"IMPLEMENTATION"` (the `pipeline` arg to `recordDeviationFindings`) | `deviations.mjs:72‑121` — no new recorder needed |

**Trigger: `Stop`, classification ∈ {`STAGE_COMPLETE`, `TASK_COMPLETE`}, as a new step *inside* `assessStop`** (`orchestrator.mjs:755`), placed **after** the stop reviewer returns `review` (`:813`/`:797`) and **before** `calculateMetricReport` (`:880`) — i.e. only on the branch that reaches the metric report. This is the single best attach point, for four independently verified reasons:

1. **The closure engine already lives here.** `assessStop` freezes the population (`buildMetricPopulation`, `:767‑772`), computes the report from `review.metricObjectJudgements` (`:880‑883`), records families (`recordDeviationFindings(pipeline:"STOP")`, `:909‑916`), and runs the **only** automatic closure path `markMetricPassesFixed(passedMetricSourceIds(report))` (`:917‑921`). Feeding device‑grounded judgements into that same `review.metricObjectJudgements` reuses all of it with **zero new closure plumbing**.
2. **Shadow suppression is inherited for free.** Feedback returns through `assessStop` → `handleRuntimeV2Event`'s wrapper, which nulls `decision`/`feedback` under `shadowMode` (`orchestrator.mjs:960‑973`). The ARTIFACT/`PostToolUse` path does *not* inherit this (`finalizeArtifactRuntimeV2` has no shadow guard), so we deliberately avoid it.
3. **Device serialization is structural.** `Stop` fires when the developer agent's turn is quiescent, so it is not concurrently driving the one emulator (`127.0.0.1:5555`). The `emulator` mutex then only has to guard against overlapping reviewer runs.
4. **Cost.** A build+drive journey is ~50–90 s/state (T1 journal). Once‑per‑milestone is affordable; a per‑`PostToolUse` trigger would run it hundreds of times.

**Milestone scoping.** At `STAGE_COMPLETE`, run only the milestone's journeys/test‑cases (frozen milestone map CM1→CJ‑001, CM2→CJ‑002, CM3→CJ‑003+CJ‑004; `app-requirements.md:195‑197`). At `TASK_COMPLETE`, run the full regression — the CAC‑020 "all four journeys on one final HAP, no evidence splicing" gate (`app-requirements.md:223`).

> The role reviewers (stop/skill/impl) build their prompt **inline** in `reviewer.mjs:285‑290` from `request.json.instructions[]` — they do **not** read a `reviewers/*.md` file (those `.md` files belong only to the ARTIFACT node/edge path). So a reviewer `.md` charter is optional documentation, not a functional requirement.

---

## 2. Execution model: PLAN‑THEN‑EXECUTE (reject Bash‑grant)

**Recommendation: a three‑phase split — LLM plans, non‑LLM Node executes, LLM judges — mirroring the existing `artifact-checker → semantic-review` deterministic‑then‑LLM pattern. Do NOT grant the reviewer `Bash`+`hdc`.**

| Phase | Actor | Tools | Job |
|---|---|---|---|
| **A — PLAN** | `implementation-reviewer` LLM subprocess (`startRoleReviewer`, `reviewer.mjs:269`) | `Read,Grep` (argv unchanged, `reviewer.mjs:208‑211`) | Read frozen population + prose test contracts + source; emit a deterministic `VerificationPlan` targeting UI nodes **semantically** (`text`/`accessibilityText`/id), never pixels |
| **B — EXECUTE** | new non‑LLM Node module in the **hook process** | fixed allow‑list: `hvigorw`, `hdc`, `unzip`, linter | Build own HAP, deterministic reset, drive UI, capture **own** evidence into a developer‑invisible dir, compute exact‑match assertions |
| **C — JUDGE** | same reviewer session via `handle.followUp` (`reviewer.mjs:317`, as `assessStop:797`) | `Read,Grep` over the reviewer‑private evidence dir only | Read manifest + captures (incl. opening `.jpeg` with `Read`, which renders images) + `groundTruthPath`; emit `metricObjectJudgements` + `findings` |

**Why not Bash‑grant** (three verified defects):

- **Contamination.** The reviewer's `request.json` carries `groundTruthPath` (frozen expected answers). An LLM holding frozen ground truth *and* arbitrary `Bash` is a direct exfiltration channel into the developer‑visible workspace — exactly what the `Read,Grep` sandbox (`reviewer.mjs:208‑211`) + `internalRunEnvironment` isolation (`internal-run.mjs:86‑99`) exist to prevent. Keeping `buildArguments` untouched preserves the barrier by construction.
- **Determinism.** An LLM issuing hdc would re‑import the developer's `click 660 680` + `sleep`‑retry flakiness (T1 journal), making M12/M15/V04 high‑variance and indefensible in a study that needs repeatability (task #24). A code executor with **semantic node resolution + exact‑match dump assertions** is strictly more stable than the developer's own approach.
- **Budget.** A full drive far exceeds `reviewer.timeoutMs` (default 240 000 ms, `config.mjs:33`) and is enforced by `child.kill()` (`reviewer.mjs:186‑189`). Phase B runs in the hook process under its **own** `deviceBudgetMs`, so the LLM never waits on the device; the two LLM calls stay short.

The executor **cannot** be a reviewer child — `inspectInternalRun` requires `depth ≥ 1` for internal runs and there is no nesting (`internal-run.mjs:107‑118`); it runs as plain plugin Node code invoked by `assessStop`. Only Phases A/C are `startRoleReviewer` subprocesses.

---

## 3. The methods, as sub‑checks

All device work is owned by the executor; the LLM only plans and judges. `<evi>` = `.runtime-correction/tasks/<taskId>/impl-evidence/<epoch>/…` (developer‑invisible; the evaluation package excludes `.runtime-correction/`). Every capture is SHA‑256'd at recv time (self‑applied distinctness guard) into an `evidenceManifest`.

| # | Method | Inputs (frozen expected side) | Commands / mechanism (own evidence only) | Finding it emits (rootCauseId) | Metric moved |
|---|---|---|---|---|---|
| **1** | **Defined‑testcase execution** | `requirements`(M12), `acceptanceCriteria`(M13), `criticalJourneys`(M15); prose `TC-*`/`DT-CM*` as **navigation hints only** (on‑device `ohosTest` stubs are DevEco templates — `hvigorw test` is not a logic source) | Deterministic reset → per test: `uitest dumpLayout`→`file recv`→resolve semantic node→`uiInput click/text/swipe`→re‑dump; **exact‑match** over `attributes.text`/`accessibilityText`/node presence | non‑PASS → `IMPLEMENTATION_BEHAVIOR_MISMATCH`; contracted test absent → `TEST_NOT_EXECUTED` | **M12** (primary), M13, M15 |
| **2** | **Code‑summary → semantic requirement compare** | `requirements`(M12), `developmentStandards`(M09), `workflowSteps`(M11), statically‑decidable `acceptanceCriteria`(M13) | **No device.** Collector `git ls-files entry/src/main/ets/** + module.json5 + AppScope` → per‑file SHA manifest; LLM summarizes each module, compares to each owned claim, cites `path:line` (must be in manifest) | code contradicts req → `IMPLEMENTATION_BEHAVIOR_MISMATCH`; req present, no code → `REQUIREMENT_OMITTED`; workflow skipped → `WORKFLOW_CONSTRAINT_VIOLATION` | **M12/M09/M11**; M13 (static subset only) |
| **3** | **Screenshot verification** | `criticalJourneys`(M15), `acceptanceCriteria`(M13), `requirements`(M12) whose evidence is a rendered screen | Drive to target state, then **back‑to‑back with no input between**: `snapshot_display`+`file recv` **and** `dumpLayout`+`file recv`; bind PNG↔dump by frame fingerprint (sorted visible‑text set); LLM opens the PNG with `Read` and may only **downgrade** a structural PASS, never upgrade a FAIL | rendered state ≠ expected → `IMPLEMENTATION_BEHAVIOR_MISMATCH`; claim contradicts capture → `EVIDENCE_CLAIM_CONTRADICTS_ARTIFACT` | **M15**, M13, M12 |
| **4** | **Click simulation / critical‑journey drive** | `criticalJourneys`(M15) + step‑level `requirements`(M12) + fixed acceptance‑sim inputs (`FLOWER-ROSE-001`, `红玫瑰`, `31.2304,121.4737`, `花友小雅`, `123456`; `app-requirements.md:29‑33`) | Full journey drive from deterministic reset; persistence steps use `aa force-stop`→`aa start` **without** uninstall so arkdata survives; assert persisted state; localize failure to first failing `stepId` | journey step ≠ outcome → `IMPLEMENTATION_BEHAVIOR_MISMATCH`; unreachable at verification → `MILESTONE_EVIDENCE_GATE_BYPASSED`; couldn't run → `TEST_NOT_EXECUTED` | **M15** (primary), M13, M12 |
| **5** | **Build / manifest / static / log / a11y compliance** | `developmentStandards`(M09), `workflowSteps`(M11), `experienceRules`(M10) | **5A** `hvigorw clean assembleHap` (own, from source excluding `entry/build/`) → this HAP is the **install artifact for methods 1/3/4**; **5B** `unzip` HAP, parse `module.json5`/`AppScope`, exact set‑diff on permissions/deviceTypes/bundleName; **5C** `hvigorw lint`/eslint/fixed pattern scan; **ext:** `hilog -x` around the drive asserting no FATAL/ANR; a11y walk over own dumps | build fails → `IMPLEMENTATION_BEHAVIOR_MISMATCH` (blocker) + gate M12/M13/M15 to `NOT_YET_EXECUTED`; manifest wrong → `IMPLEMENTATION_BEHAVIOR_MISMATCH`/`WORKFLOW_CONSTRAINT_VIOLATION`; packed≠source → `EVIDENCE_CLAIM_CONTRADICTS_ARTIFACT` | **M09/M11**, M10; build‑provenance anchor for M12/M13/M15 |
| **6** | **Execution architecture (the spine)** | — | Phase A/B/C wiring, `withTaskResourceLock({resource:"emulator"})` (`task-store.mjs:112`), deterministic reset, connect‑precheck with fixed backoff, per‑command timeouts, `deviceBudgetMs` | device unreachable → judge `EXTERNAL_BLOCKED`/`UNVERIFIED`, `STALE_OR_UNBOUND_EVIDENCE`; never a false PASS | enables all of M09–M15 + V04 |

**Executor command vocabulary** (fixed, verbatim from the T1 journal, one target only):
```bash
export PATH="$COMMAND_LINE_TOOL_PATH/bin:$COMMAND_LINE_TOOL_PATH/sdk/default/openharmony/toolchains:$PATH"
export JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
T=127.0.0.1:5555 ; PKG=com.example.flowershop ; AB=EntryAbility
hdc list targets                                              # connect precheck (retry w/ backoff)
hvigorw clean assembleHap --no-daemon -p product=default -p buildMode=debug > <evi>/build.log 2>&1
hdc -t $T shell aa force-stop $PKG ; hdc -t $T shell bm uninstall -n $PKG
hdc -t $T install <reviewer-built>.hap ; hdc -t $T shell aa start -a $AB -b $PKG
hdc -t $T shell uitest dumpLayout -p /data/local/tmp/s.json ; hdc -t $T file recv /data/local/tmp/s.json <evi>/…/pre.json
hdc -t $T shell uitest uiInput click <cx> <cy>               # cx,cy = bounds-center from the FRESH dump
hdc -t $T shell snapshot_display -f /data/local/tmp/s.jpeg   ; hdc -t $T file recv … <evi>/…/post.jpeg
```
`file recv` **always** targets `<evi>`, **never** the developer's `./VeriPilotWorkspace/artifacts/`.

**Ownership partition (mandatory, verified).** Merge the impl reviewer's `metricObjectJudgements` into `review.metricObjectJudgements` **by `objectId`, impl wins, deduped** — because two judgements for one `objectId` are forced to `CHECKER_ERROR` (`metrics.mjs:174‑187`). Method 2 owns M09/M11/M12(static); methods 1/3/4 own M12(runtime)/M13/M15; method 5 owns M09/M10/M11. Each `objectId` gets exactly one judgement; the stop reviewer keeps everything the impl reviewer did not judge.

---

## 4. Finding → delivered correction → closure loop (how it moves V04/M12/M13/M15)

The pipeline supplies exactly two outputs into the existing `assessStop` machinery, **before line 880**:

1. **`metricObjectJudgements`** with `objectId = "M12:<claimId>"` etc., `DEVIATION` on first detection, `PASS` on retest — merged (dedupe by objectId) into `review.metricObjectJudgements`.
2. **`findings`** appended to `review.findings` for delivery richness (step localization, `actualEvidence` = own capture paths+shas, `suggestedNextAction`).

Then the existing code path runs unchanged:

```
report = calculateMetricReport({ population, judgements: review.metricObjectJudgements })   // :880
recordDeviationFindings({ pipeline:"STOP"→augment to include IMPLEMENTATION findings,
    findings:[...blockingFindings, ...metricDeviationFindings(report)], ... })              // :909-916
markMetricPassesFixed({ passedObjectIds: passedMetricSourceIds(report) })                    // :917-921
```

**Why this closes (the detect→fix→retest→no‑regression loop):**

- **Detect (epoch N).** A device DEVIATION on `M12:<claimId>` lands in `report.blockingObjects` (hard + DEVIATION, `metrics.mjs:209‑215`). `metricDeviationFindings(report)` **auto‑generates** a finding with `violatedGroundTruthIds:[object.sourceId]` = bare `claimId` (`orchestrator.mjs:637`). This is the safest closure path: **routing DEVIATION through the metric report guarantees the correct bare‑`claimId` key**, independent of what the LLM wrote. `recordDeviationFindings` opens a family keyed on `sha256(taskId, deviationKey, rootCauseId, violatedGroundTruthIds)` (`deviations.mjs:87‑92`), `status:"OPEN"`.
- **Deliver (T1 only).** Blocking objects flow through `stopFeedback` → `decision:"block"` with per‑object reasons; returned through the shadow wrapper (delivered in T1, nulled in B0). The developer sees only the finding text — never the frozen expected value beyond that line.
- **Fix + Retest (epoch N+1).** Next `STAGE_COMPLETE`/`TASK_COMPLETE`, the executor **re‑runs the milestone subset from a deterministic reset with fresh first‑party captures**. A now‑correct object judges `PASS` → `passedMetricSourceIds(report)` includes the bare `claimId` (`orchestrator.mjs:656‑661`) → `markMetricPassesFixed` flips every family whose `violatedGroundTruthIds ⊆ passed` to `FIXED` (`deviations.mjs:124‑135`). **That transition is V04.**
- **No‑regression (structural).** The whole in‑scope set re‑runs each epoch. A fix that breaks another journey re‑emits its DEVIATION, and `recordDeviationFindings` **reopens a FIXED family on re‑observation** (`deviations.mjs:105`). Multi‑claim journeys close only when **all** bound `claimId`s PASS (`deviations.mjs:130`) — a partial fix cannot prematurely close a CJ (this is CAC‑020's "no evidence splicing," enforced mechanically).

**No developer‑fabricated evidence anywhere in the loop.** Every judgement is computed by the executor over captures it produced itself into `<evi>`; the developer's `artifacts/*.json|*.jpeg` are never read. This is the direct fix for both flower‑shop runs' "100% ARTIFACT/STOP findings, zero implementation findings" and V04 = 0: the STOP reviewer's read‑only pass over fabricated `artifacts/` is **replaced** (per `objectId`, impl wins) by first‑party judgements.

**Two safeguards the individual methods didn't fully specify — add both:**

- **`normalizeImplFinding`**: before recording, strip any `M\d\d:` prefix from every `violatedGroundTruthIds` entry in the impl reviewer's *own* findings, so a stray prefixed id from the LLM can never produce a never‑closing family. (The auto‑findings from `metricDeviationFindings` are already correct.)
- **Emit rule**: findings only for non‑PASS; `metricObjectJudgements` for **every** owned object (PASS included). A spurious finding on a passing test would reopen its FIXED family (`deviations.mjs:105`). `severity:"info"` is dropped (`deviations.mjs:86`) — impl findings are never `info`.

---

## 5. Arm‑neutrality, shadowMode, contamination

- **The reviewer exists identically in both arms.** Collector + Phase A/B/C + `recordDeviationFindings` + `markMetricPassesFixed` run **unconditionally** inside `handleRuntimeV2EventInternal`, so device perturbation and recorded detection data are **byte‑identical** in B0 and T1. Safe to run unconditionally because the developer's live device state is already externalized as artifacts — tearing the device down to a known HAP loses nothing the developer still needs.
- **The arm switch is one place.** `handleRuntimeV2Event` nulls `decision`/`feedback` under `shadowMode` (`orchestrator.mjs:960‑973`). Because the impl pipeline rides the `assessStop`→Stop feedback path (not the later ARTIFACT path), it inherits suppression **for free** — no extra guard. B0 records the uncorrected‑trace detection; T1 additionally delivers.
- **Deterministic reset gives an identical device baseline in both arms** (`aa force-stop → bm uninstall → install <known‑sha reviewer‑built HAP> → aa start`), so identical perturbation does not confound the B0/T1 comparison.
- **Contamination barrier.** The LLM phases stay `Read,Grep` (argv unchanged, `reviewer.mjs:208‑211`); `internalRunEnvironment` strips `CLAUDECODE*` and stamps markers (`internal-run.mjs:86‑99`); frozen ground truth reaches the reviewer only via `groundTruthPath`; only structured finding/judgement text propagates, and only in active mode. The executor (non‑LLM Node) writes solely to `<evi>` and shells a fixed binary/target allow‑list — no exfiltration path, no ground‑truth leak.

---

## 6. File‑level implementation plan

**New files**

| File | Purpose |
|---|---|
| `runtime-corrector/lib/runtime-v2/impl-evidence-collector.mjs` | Non‑LLM spine. Holds `withTaskResourceLock({resource:"emulator"})`. Owns `hvigorw`/`hdc`/`unzip`/linter via fixed allow‑list + fixed target `127.0.0.1:5555`. Deterministic reset, semantic node resolution (parse recv'd `dumpLayout`, click bounds‑center), snapshot/dump capture, exact‑match assertions, build/manifest/lint/hilog/a11y checks. Writes `<evi>/…` + SHA‑stamped `evidenceManifest`; self‑applies the byte‑identity distinctness check. Returns `{ implJudgements, implFindings, evidenceManifestDigest }`. |
| `runtime-corrector/lib/runtime-v2/impl-review-plan.mjs` (optional) | `VerificationPlan`/assertion‑DSL types + `normalizeImplFinding` (strip `M\d\d:` from `violatedGroundTruthIds`) + objectId‑merge helper (dedupe, impl wins). |
| `runtime-corrector/config/reviewers/implementation.md` (optional) | Human‑readable role charter. **Not functionally required** — the role prompt is built inline (`reviewer.mjs:285‑290`) from `request.json.instructions[]`. |

**Changed files**

| File | Change |
|---|---|
| `runtime-corrector/lib/runtime-v2/config.mjs` | Add `implementationReviewer` to `REVIEWER_ROLES` (`:8‑13`); parse `implementationCorrection` (`{enabled, deviceBudgetMs, maxCorrectionsPerEpoch}`) mirroring `stopCorrection` (`:44,68‑71`); OR `implementationCorrection.enabled` into top‑level `enabled` (`:84‑90`). `reviewers.implementationReviewer` then compiles automatically (`:77‑80`). |
| `runtime-corrector/lib/runtime-v2/internal-run.mjs` | Add `"implementation-reviewer"` to `INTERNAL_ROLES` (`:8‑13`). |
| `runtime-corrector/config/schemas/project-config.schema.json` | Mirror the new role in the reviewers enum and add the `implementationCorrection` gate object. |
| `runtime-corrector/lib/runtime-v2/orchestrator.mjs` | In `assessStop`, on the `STAGE_COMPLETE`/`TASK_COMPLETE` branch, **between the stop reviewer's `review` (`:813`/`:797`) and `calculateMetricReport` (`:880`)**, gated on `runtimeV2.implementationCorrection.enabled`: (1) run the collector (Phase B) under the emulator mutex; (2) spawn Phase A/C via `reviewerFactory({ role:"implementation-reviewer", reviewer: runtimeV2.reviewers.implementationReviewer, schema, request })`; (3) `normalizeImplFinding` on impl findings, append to `review.findings`; (4) **merge impl `metricObjectJudgements` into `review.metricObjectJudgements` by objectId, impl wins**. Everything at `:815‑816` and `:880‑921` then runs unchanged. |
| `runtime-corrector/test/runtime-v2.test.mjs` | Add fixtures: closure fires only with bare‑`claimId` `violatedGroundTruthIds`; duplicate‑objectId merge doesn't produce `CHECKER_ERROR`; shadow strips impl feedback; distinctness rejects byte‑identical captures → `UNVERIFIED` not PASS. |

**Request object** (written to `request.json`, `reviewer.mjs:282‑284`):
```
{ schemaVersion:"runtime-corrector.impl-review-request.v2", taskId,
  instructions:[…], groundTruthPath, population,
  evidenceManifest:[{path,sha256,kind,capturedAt,boundClaimIds}],
  target:{hdcTarget:"127.0.0.1:5555", bundleName:"com.example.flowershop", abilityName:"EntryAbility"},
  sourceRoot, hapPath, rootCauseIds:[...ROOT_CAUSE_IDS] }
```

**Schemas: reuse existing, no new schema.** Phase A returns the `VerificationPlan` in the request round‑trip. Phase C returns `SKILL_REVIEW_SCHEMA`‑shaped output plus `metricObjectJudgements[JUDGEMENT_SCHEMA]` (`reviewer.mjs:90‑130`) — identical to what `assessStop` already consumes.

---

## 7. Top risks + mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| **Closure‑key mismatch** (`M12:<claimId>` in `violatedGroundTruthIds`) | Family never closes → V04 stays 0 | Drive closure through `metricObjectJudgements` → `metricDeviationFindings` auto‑sets bare `sourceId` (`:637`); `normalizeImplFinding` strips prefixes from own findings; unit test asserts closure. |
| **Duplicate objectId across stop + impl reviewer** | `CHECKER_ERROR` (`metrics.mjs:174‑187`) tanks the metric | Ownership partition + dedupe‑by‑objectId merge (impl wins) **before** `:880`; never concatenate. |
| **Stop‑hook wall‑clock** — a 5–10 min device drive inside the Stop hook may exceed the harness hook timeout | Hook killed, run destabilized | `deviceBudgetMs` (~600 000) + per‑command caps (build ≤300 s, each `hdc` ≤30 s); milestone subset at intermediate stops, full regression only at `TASK_COMPLETE`; on exhaustion judge remainder `UNVERIFIED` (never PASS). If the harness hook budget is tighter, run Phase B detached and consume results on the next Stop. |
| **Emulator flakiness** (`[Empty]`, `need connect-key`, ~50–90 s waits) | False failures | Connect precheck with fixed backoff; on persistent failure judge `EXTERNAL_BLOCKED`/`UNVERIFIED` → `STALE_OR_UNBOUND_EVIDENCE`, non‑blocking, non‑fabricating (never false PASS). |
| **Device contention** with ground‑truth‑refresh reviewers (fire on Pre/PostToolUse/Stop, `orchestrator.mjs:1034‑1052`) | Interleaved hdc corrupts state | Whole Phase B holds `withTaskResourceLock({resource:"emulator"})`; Stop‑only trigger means the developer turn is quiescent. |
| **Reviewer self‑fabrication** (byte‑identical captures across distinct states) | A capture "proves" two states | Executor applies the SHA‑256 distinctness check to its **own** captures (the PostToolUse guard `evidence-distinctness-guard.mjs` only scans developer roots, not `.runtime-correction/`); collision → re‑capture, else `UNVERIFIED`. |
| **Semantic node not found** | Journey can't proceed | Executor resolves from a fresh dump; on genuine absence, one K‑capped LLM "propose next step," else real `IMPLEMENTATION_BEHAVIOR_MISMATCH`/`TEST_NOT_EXECUTED` localized to the step. |
| **Contamination via Bash** | Ground‑truth leak into developer workspace | Never grant Bash to the LLM; executor is non‑LLM with a fixed allow‑list writing only to `<evi>`. |
| **Executor crash inside `assessStop`** | Final completion becomes unverified | Wrap in `assessStop`'s existing try/catch → `STOP_REVIEW_FAILED`, fail‑closed `decision:"block"`; the task remains active until a valid terminal assessment succeeds. |

---

## 8. Phased rollout

**MVP — Method 2 (code‑summary → semantic compare). Build this first.** It is the only method that fits the `Read,Grep` reviewer **unchanged** (no `hdc`, no executor, no `buildArguments` edit), is fully deterministic (a git‑ls + per‑file SHA manifest freezes inputs), needs zero device (so **zero arm‑confounding perturbation**), and already moves the primary target **M12** plus M09/M11 and closes via the exact same `markMetricPassesFixed` loop. It immediately proves the end‑to‑end wiring — role registration, gate, `assessStop` insertion, objectId‑merge, bare‑`claimId` closure, shadow inheritance — before any device engineering. It also catches real, document‑invisible divergences (e.g. spec mandates `pages/Home`, code ships `pages/Index.ets`).

| Phase | Ships | Adds | Metrics unlocked |
|---|---|---|---|
| **0 — Wiring skeleton** | role + gate + schema mirror + `assessStop` insertion point + merge/normalize helpers + tests (with a stub judge) | config.mjs, internal-run.mjs, schema, orchestrator.mjs | validates closure + shadow, no metrics yet |
| **1 — MVP: Method 2** | `impl-source-collector` (git‑ls + SHA manifest) + Phase A/C static reviewer | one new collector, no device | **M12** (primary), M09, M11; **first V04 closures** |
| **2 — Method 5 (build/manifest/static)** | 5A clean build → **trusted HAP for all device methods**; 5B manifest set‑diff; 5C lint | `impl-evidence-collector` (no drive yet: `hvigorw`/`unzip`/lint) | M09/M11/M10; build provenance for M12/M13/M15 |
| **3 — Device spine + Method 4 (journey drive)** | executor drive+capture under emulator mutex; deterministic reset; Method 4 | extend collector with `hdc` drive | **M15** (primary), M13, M12 |
| **4 — Methods 3 + 1** | screenshot verification (Phase‑C vision) + full test‑contract execution | reuse spine captures | M15/M13 corroboration; M12 breadth |
| **5 — Extensions** | `hilog` fault assertion → M12/M15; `accessibilityText` coverage → M10 | ride existing captures, ~0 marginal cost | M10, M12/M15 fault coverage |

Each phase is independently shippable and independently moves metrics; Phases 3–5 all reuse the single executor spine and the single `assessStop` merge point built in Phase 0.

---

**Verified anchors:** `reviewer.mjs:90‑146,164‑218,269‑343`; `orchestrator.mjs:611‑661,740‑772,813‑824,880‑921,960‑973,1034‑1052`; `deviations.mjs:7‑24,72‑121,124‑145`; `metrics.mjs:7‑25,45‑64,123‑224`; `config.mjs:4‑13,29‑36,68‑103`; `internal-run.mjs:8‑13,86‑118`; `task-store.mjs:112‑124`; `scripts/evidence-distinctness-guard.mjs`; `config/schemas/project-config.schema.json`.
---

Verified against source. The blueprint's mechanical claims mostly hold, but the closure-attribution machinery it plans to feed is already broken in a way the blueprint makes *worse*, and two contamination/fabrication channels it dismisses are real. Here is the attack.

---

# Adversarial critique — Implementation/Verification reviewer

I read the closure and attribution code the blueprint depends on. The load-bearing plumbing claims check out (`metricDeviationFindings` emits bare `sourceId` at `orchestrator.mjs:637`; `passedMetricSourceIds` returns bare `sourceId` at `:656‑661`; `markMetricPassesFixed` keys on `violatedGroundTruthIds` at `deviations.mjs:130`; duplicate `objectId` → `CHECKER_ERROR` at `metrics.mjs:174‑187`). But the blueprint validated the *pipe* and never looked at what happens to a closure *after* it lands. That is where the design fails.

## Top 8 concrete risks

**1. Closure is arm-blind, so V04 credits the critic for developer self-fixes.**
`markMetricPassesFixed` runs **unconditionally** inside `assessStop` (`orchestrator.mjs:917‑921`), *before* the shadow wrapper strips `decision`/`feedback` (`orchestrator.mjs:960‑973`). So a family reaches `status:"FIXED"` in **B0 shadow too** — the developer fixed it without ever seeing a correction. Then `attributeClosures` stamps **every** `FIXED` family as `CRITIC` with no arm/delivery check: `if (family.status === 'FIXED') attribution.set(key, 'CRITIC')` (`critic-ingest.mjs:357`). The blueprint's device methods will generate *many* closures, all laundered into `CRITIC`. "That transition is V04" is exactly the confound.
*Fix:* stamp each observation with `deliveredInArm`+`deliveredEpoch` at record time (the impl pipeline knows `shadowMode`), and rewrite `attributeClosures` to `CRITIC` only when the correction was **delivered (T1)** and the closing epoch is **strictly after** delivery; `SELF` otherwise. Report `V04_net = CRITIC-rate(T1) − SELF-rate(B0)` on the identical frozen deviation set.

**2. The frozen pre-registration and the code already disagree — the blueprint ships on the broken side.**
`FINALIZED-METRICS.md:80` pre-registers "B0 (shadow) 闭环全为 SELF." The implementation (`critic-ingest.mjs:357`) labels shadow closures `CRITIC`. This is a live spec/impl contradiction on a **primary** metric, and the blueprint routes all new closures straight through it without touching attribution.
*Fix:* make attribution honor the pre-registration (risk 1's delivery gate) and add a regression test asserting B0 closures never attribute `CRITIC` — before wiring any impl reviewer.

**3. Contamination: the correction text itself is the leak channel.**
Isolation governs the reviewer *process*, not the *content* it is designed to deliver. `stopFeedback` ships `object.reason` and `finding.reason` verbatim to the developer (`orchestrator.mjs:745‑748`). For implementation verification those reasons **necessarily** describe expected observable behavior — which for flower-shop *is* frozen ground truth (`红玫瑰`, `31.2304,121.4737`, `花友小雅`, `123456`; `app-requirements.md:29‑33`). A correction "cart should show 红玫瑰 after adding FLOWER‑ROSE‑001" hands the developer the answer key. `normalizeImplFinding` only strips `M\d\d:` prefixes from IDs; it does nothing to the prose.
*Fix:* impl findings must be **symptom-only** — reference the `claimId`/`stepId` and a generic failure ("AC‑3 not observed in the running app"), never quote expected values or captured actuals. Add a delivery-time redactor that rejects any finding whose `reason` contains a token from the frozen ground-truth value set.

**4. The merge fallback re-opens the fabrication trap.**
"Merge by `objectId`, impl wins" silently means *impl loses when it's silent*: any device-evidence object the impl reviewer omits falls back to the **stop reviewer's** judgement, which reads the developer's `artifacts/` (the fabricated dumps). A `PASS` from fabricated evidence → `passedMetricSourceIds` → `markMetricPassesFixed` closes the family → `CRITIC`. A coverage gap launders fabricated evidence into a critic-attributed win.
*Fix:* for evidence-required device metrics (M12/M13/M14/M15, `metrics.mjs:60‑61`), **bar the stop reviewer from PASS**. Any such object lacking a first-party impl judgement is forced `UNVERIFIED`, never inheriting a stop `PASS`. The merge must be exhaustive-or-`UNVERIFIED`, not exhaustive-or-inherit.

**5. Exact-match dump assertions produce false DEVIATIONs that harm the developer and still score as wins.**
"Exact-match over `attributes.text`" breaks on correct code: expected substring `红玫瑰` vs rendered `红玫瑰 ×1 ¥19.9`, async loads, timestamps. A false DEVIATION in **T1** is *delivered* — it tells the developer to change correct code, which can regress a passing journey (lowering M15 in T1 vs B0). Worse, the reopened family later re-closes and gets `CRITIC` credit anyway (risk 1).
*Fix:* assert **presence of a required semantic node** (substring/`accessibilityText`/id containment), not full-dump equality; on ambiguity emit `UNVERIFIED`, never `DEVIATION`. Gate any borderline judgement behind the vision downgrade-only rule the blueprint already proposes for screenshots.

**6. Byte-distinctness is the wrong guard and gives false confidence.**
A flaky tap that no-ops leaves the app on the prior screen; the re-dump/JPEG still differs byte-wise (timestamps, encoder noise), so the SHA distinctness check **passes** while the state never changed. Distinctness ≠ transition. This yields false negatives (element still visible → false `PASS`) and false positives interchangeably.
*Fix:* assert a **positive transition invariant** — a node present only in the target state *and* absent in the pre-dump — with bounded poll-until-stable + retry; non-transition → `UNVERIFIED`. Byte-distinctness stays only as an anti-replay backstop, not as proof of progress.

**7. Arm-neutrality of device perturbation is false past first divergence.**
Perturbation is byte-identical in B0/T1 only until T1 delivers its first correction; thereafter the developer's trajectory forks, the count and timing of `STAGE_COMPLETE`/`TASK_COMPLETE` Stops diverge, and the impl reviewer runs a **different number of times** on the two arms — an unbalanced emulator confound. Also, uninstall→reinstall (`bm uninstall`) wipes the developer's live device; in T1 a blocked developer may resume on a wiped device, a perturbation absent in B0. "Loses nothing the developer needs" is only true if state is fully externalized, which the live emulator session is not.
*Fix:* run device verification on a **separate cloned AVD**, never the developer's live device — developer perturbation becomes zero in both arms. If a shared device is unavoidable, AVD snapshot/restore around each run. Analyze per-milestone (frozen CM→CJ map), not per-Stop, so unequal Stop counts don't bias.

**8. The one verification that matters most (TASK_COMPLETE / CAC‑020) is the one that cannot fit the hook.**
Blueprint's own numbers: ~300 s build + 4 journeys × ~6 states × ~70 s ≈ **30+ minutes** for the final full-regression drive, inside a Stop hook. The blueprint's fallback — "run Phase B detached, consume on the next Stop" — **fails for TASK_COMPLETE**: the agent completes the task and exits, so there is no next Stop. The CAC‑020 "all four journeys on one final HAP" gate is exactly the undeferrable, over-budget case.
*Fix:* decouple completion from the hook. Do **not** flip `state.status = "COMPLETED"` (`orchestrator.mjs:899`) until a detached regression returns; block the completing Stop pending the async barrier, or move final verification to an explicit finalization/SessionEnd step. On budget exhaustion, judge the remainder `UNVERIFIED` (never `PASS`), keeping the task open rather than closing on unverified evidence.

---

## The single biggest threat to the study's validity

**Closure attribution, not device engineering.** Everything else degrades a metric or annoys the developer; this one makes the **primary** result — V04, the critic's net closure contribution — *unfalsifiable in the critic's favor*. Two verified facts compound:

1. Closure fires in **both arms** unconditionally (`orchestrator.mjs:917‑921`, before the shadow strip at `:960‑973`), and
2. Attribution is a pure status test — `FIXED ⇒ CRITIC` — with **no delivery, arm, or temporal check** (`critic-ingest.mjs:353‑362`), already contradicting the frozen pre-registration (`FINALIZED-METRICS.md:80`).

The proposed reviewer pours a large volume of new, device-grounded closures into precisely this broken attributor. The likely outcome is a headline "V04 moved off zero, critic works" that is mostly **developer self-debugging relabeled `CRITIC`** — a positive result the design cannot distinguish from no effect.

**Neutralize before building any device method:**
- **Delivery-gated, temporally-causal attribution.** A closure is `CRITIC` only if (a) the arm delivered the correction (`shadowMode === false`), (b) the closing epoch is strictly after the delivery epoch, and (c) the fixing turn/commit post-dates the delivery. Everything else is `SELF`. Stamp `deliveredInArm`/`deliveredEpoch` on each observation at record time.
- **Report the between-arm delta as the result**, never the raw T1 count: `V04_net = CRITIC-rate(T1) − SELF-rate(B0)` on the identical frozen deviation set, with the Clopper–Pearson intervals the spec already mandates (`FINALIZED-METRICS.md:136`).
- **Lock it with tests** that fail if a shadow (B0) closure ever attributes `CRITIC`, and if a closure whose fix pre-dates delivery attributes `CRITIC`.

Do this first. A device reviewer feeding an honest attributor is a study; a device reviewer feeding `critic-ingest.mjs:357` as written is a confound generator.

**Verified anchors:** `deviations.mjs:124‑135`; `metrics.mjs:53,55,60‑61,174‑187`; `orchestrator.mjs:625‑639,656‑661,740‑752,880‑921,960‑973`; `reviewer.mjs:198‑218`; `config.mjs:8‑13,68‑71,84‑103`; `critic-ingest.mjs:348‑362`; `critic-metrics.mjs:229‑250`; `FINALIZED-METRICS.md:68,80`; `app-requirements.md:29‑33`.
