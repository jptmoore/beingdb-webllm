# Benchmark harness internals

How `npm run benchmark` works, what it records, and how results are judged.
Usage is in the [README](../README.md#systematic-benchmarking).

## Architecture

```
scripts/benchmark.mjs          CLI (options, exit codes)
  scripts/lib/runner.mjs       one run: server, browser, page driving, files
    scripts/lib/server.mjs     the same static server as `npm run serve` (started or reused)
    scripts/lib/provenance.mjs git state, package versions, artefact hashes, host facts
    scripts/lib/suite.mjs      question file -> suite id + sha256 (eval/suite.json)
    playwright-core            launches the locally installed Chrome/Edge (no bundled browser)
      benchmark.html           thin page exposing window.bench
        src/benchmark.js       load model, smoke check, run one question, report environment
        src/environment.js     navigator / WebGPU adapter facts
        src/pipeline.js        ask(): the same generate -> BeingDB -> repair loop as the demo
        src/score.js           the same semantic scorer as eval.html
        src/analysis.js        deterministic failure category + predicate/argument/entity evidence
  scripts/lib/summary.mjs      per-trial and aggregate metrics (Node, from questions.jsonl)
scripts/benchmark-matrix.mjs   several models in sequence (fresh browser per model)
scripts/compare.mjs            two runs side by side
scripts/export-results.mjs     flat CSV/JSONL, one row per run x trial x question
scripts/models.mjs             list/validate WebLLM model ids from the installed package
```

The demo (`index.html`), the interactive evaluation (`eval.html`) and the
benchmark all call the same `setupDatabase`, `WebLLMGenerator`, `ask` and
`scoreItem`. The benchmark adds only orchestration and extra analysis; it does
not have its own NL->DSL path.

Node drives the page one question at a time (`page.evaluate(bench.runQuestion)`),
and appends each record to `questions.jsonl` as soon as it is returned, so an
interrupted run keeps everything completed so far.

## Browser and WebGPU

- The browser is a locally installed Chromium-based browser launched headed
  through `playwright-core` (`channel: "chrome"` by default). Playwright's
  WebKit is not Safari and is not used; Safari and Firefox remain manual checks
  via `eval.html`.
- `--browser chromium` uses Playwright's own Chromium build, which must be
  downloaded once with `npx playwright-core install chromium`; `chrome`,
  `chrome-beta`, `chrome-canary`, `edge` and `edge-beta` use installed browsers,
  and `--executable-path` any other Chromium-based binary.
- A persistent profile (`~/.cache/beingdb-webllm/browser-profiles/<browser>`)
  keeps WebLLM's Cache Storage between runs. The cache is per origin, so the
  port (default 8010) must stay the same to reuse downloaded weights.
- Launch flags: `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
  (plus Playwright's own defaults, recorded from `chrome://gpu` "Command Line").
- The page records how long it was hidden during each question
  (`page.hiddenMs`); runs with hidden time get a warning.
- BeingDB runs as WasmGC code on the same JS heap as WebLLM and the harness, so
  garbage they create could otherwise be collected in the middle of a timed
  `BeingDB.query` (single queries of ~0.5 ms showed 50-135 ms pauses). The
  browser is started with `--js-flags=--expose-gc` and the benchmark page runs
  a full GC immediately before each pipeline query, outside the timed region
  (`page.gcBeforeBeingDBQuery`). BeingDB timings are therefore BeingDB's own
  execution cost; the GC time appears in the question's `otherMs`.
- Headless is opt-in (`--headless`). Whether headless Chrome gets a hardware
  adapter depends on platform and version, so the adapter is always checked.

## Compatibility checks (fail fast)

Before any question runs:

| Check | Source | Failure status |
|---|---|---|
| model id in the installed WebLLM registry | Node | setup error (exit 64) |
| vendor links present (`npm run link`) | Node | setup error |
| `navigator.gpu`, adapter returned | page | `incompatible` (exit 2) |
| adapter is not a fallback/software renderer (`isFallbackAdapter`, SwiftShader/llvmpipe names) | page | `incompatible` unless `--allow-software-gpu` |
| `shader-f16` present when the model is `q?f16` | page | `incompatible` |
| WebGPU limits WebLLM 0.2.85 requests (`maxStorageBuffersPerShaderStage >= 10`, `maxComputeWorkgroupStorageSize >= 32 KiB`, `maxBufferSize >= 256 MiB`, `maxStorageBufferBindingSize >= 128 MiB`, model `buffer_size_required_bytes`) | page | `incompatible` |
| BeingDB data fingerprint equals the question set's | page | `incompatible` |
| model loads (`CreateMLCEngine`) | page | `model_load_failed` (exit 2) |
| smoke generation on a few-shot example; context window >= prompt + (repairs+1) x max_tokens + repairs x 150 | page | `incompatible` |

Warnings (recorded, not fatal): dirty git trees, non-default settings, battery
power or macOS Low Power Mode, more than 1 GB of swap in use at the start or
swap growing by more than 256 MB during the run (`environment.observed.memoryAtStart`
/ `memoryAtEnd`), WebLLM VRAM estimate above 75% of host RAM,
headless mode, `chrome://gpu` not reporting "WebGPU: Hardware accelerated",
page hidden during questions, model-specific request fields.

`--probe` stops after these checks and the smoke generation.

## Question sets, data fingerprints and prompt versions

A question file is pinned to one BeingDB `environmentFingerprint`. The
fingerprint covers predicate names, arities, observed types and any declared
roles, semantic types and descriptions. Annotating predicates therefore
changes it even when no fact changes.

- `eval/questions.json` (suite `rewind-nl2dsl-v1`, registered in
  `eval/suite.json`) is the pre-annotation fingerprint and is never edited.
- `eval/questions-annotated.json` has the same 50 items (same `itemsSha256`)
  with the annotated pack's fingerprint. Pass it with `--questions`. It is
  recorded as suite `custom:questions-annotated.json` and as a non-default
  setting.
- `npm run check-eval -- --questions <file>` checks references, examples and
  the scorer against the linked build for either file.

A data fingerprint shows which pack was loaded, not what the model saw. To
attribute a change to the prompt, compare `config.prompt.version` and
`config.prompt.sha256` (`schemaText`, `systemPrompt`) between runs. The first
`annotated-predicates` run had a new fingerprint but the run-8
`systemPrompt` hash, because the runtime dropped the annotations.
`node eval/diagnose-annotations.mjs --run <run dir>` checks that declarations
reach the WASM runtime, the schema text and repair signatures. It also checks
that the run recorded this prompt and that the prompt differs from run 8.

## Result files and schema `beingdb-webllm-benchmark/v1`

`eval/results/benchmarks/<runId>/` with `runId = <UTC stamp>_<machine slug>_<model id>`:

| File | Content |
|---|---|
| `run.json` | everything about the run except per-question data (below) |
| `questions.jsonl` | one record per trial x question (`schema: ".../v1#question"`) |
| `summary.json` | `aggregate()` output: per-trial summaries, aggregate over trials, timing, schema analysis (`".../v1#summary"`) |
| `browser.log` | page console |
| `annotations.jsonl` | optional, written by hand (see below) |

`run.json` top-level keys:

```
schema, runId, status, error, startedAt, finishedAt
labels        { machine, modelLabel, condition, notes }        human-supplied only
suite         { id, registered, file, sha256, itemsSha256, environmentFingerprint, partial, questionIds }
model         { id, label, record (WebLLM registry entry), load, smoke, warmup }
  load        { cachedBefore, cachedAtLoad, coldCacheRequested, deletedFromCache, loadMs,
                phases {download, cache_read, shader_compile, other: {firstMs,lastMs,events}},
                progressEvents [{ms, progress, text}], storageBefore/After/DeltaBytes,
                chatConfig (resolved mlc-chat-config), gpuVendor, maxStorageBufferBindingSize, generation }
config        { runs, repairAttempts, questionTimeoutS, warmup, coldCache,
                generation { firstAttemptTemperature, repairTemperature, seed, topP, topPSource, maxTokens,
                             repetitionPenalty, modelSpecificRequest, resolvedModelDefaults },
                grammar { constrained, mechanism, firstAttempt, repairAfterValidationError },
                pipeline { version (model-repair/run9 | db-guided-repair/1 | proven-repairs-only/1),
                           repairPolicy (model | db-guided | proven-only), dbGuidedRepair,
                           maxModelRepairs, maxDeterministicPasses, description },
                prompt { version, chars, fewShotExamples, sha256 {rules, examples, schemaText, systemPrompt,
                         messages, grammar, fixGrammar}, schemaStats, text {system, examples, grammar, fixGrammar} },
                nonDefault [...], determinism }
browser       { requested, channel, product, fullVersionList, headless, args, profile, origin, server }
environment   { observed { host (Node: OS, CPU, RAM, hardware model, power),
                           memoryAtStart / memoryAtEnd (free RAM, swap used, macOS free percentage),
                           browser (navigator + WebGPU adapter info/features/limits),
                           chromeGpu (chrome://gpu feature status + GPU/driver rows) } }
compatibility { ok, checks [...], model { vramRequiredMB, lowResourceRequired, requiredFeatures, overrides } }
provenance    { repositories { beingdb-webllm, beingdb-wasm, beingdb: {commit, branch, describe, commitDate,
                remote, dirty, changedFiles, diffSha256} }, artefacts { wasm loader/module/data sha256 },
                packages { @mlc-ai/web-llm, playwright-core }, node }
beingdb       { predicates, facts, environmentFingerprint, languageVersion, timings }
warnings      [...]
summary       headline numbers (the full summary is summary.json)
```

`status`: `complete`, `probe_ok`, `incompatible`, `model_load_failed`,
`aborted` (timeout, crash, 3 consecutive model errors), `interrupted` (Ctrl-C),
`setup_failed`.

A `questions.jsonl` record:

```
schema, runId, trial, index
question      { id, level, tags, supported, text, reference, predicates, key, orderBy, unsupportedReason }
reference     { count, variables, key, distinctKeyRows, keyRowsSha256, rowsSha256, ms } | null
outcome       ok | unsupported | failed | error
repairs
attempts [ { n, grammar (query_or_unsupported | query_only), request {temperature, seed, ...},
             raw, reply {status, dsl | reason | error}, finish, usage (WebLLM, incl. extra),
             timing { llmMs, promptTokens, completionTokens, ttftMs, prefillMs, decodeMs, e2eMs,
                      prefillTokPerS, decodeTokPerS, grammarInitMs, grammarPerTokenMs },
             beingdb { status, ms, count, variables, errors, warnings, error, rowsSha256,
                       rows (first 200), rowsTruncated } | null,
             verdict { correct, orderWrong, exactProjection, matchedColumns } | null,
             feedback (the repair message sent after this attempt) | null,
             guided { diagnoses [ {dsl, ms, valid, provablyEmpty, errors, diagnostics} ],
                      repairs [ {from, to, applied} ], codes } | null } ]   (--db-guided-repair only)
final         { attempt, reply, dsl, valid, rowsSha256 }
score         { supported, firstValid, finalValid, firstCorrect, correct, exactProjection,
                predicatesOk, fabricated, falseRefusal, legacyFailure }
failure             { category, rule, evidence } | null     (final attempt)
firstAttemptFailure { category, rule, evidence } | null
schemaEvidence { requiredPredicates, referencePredicates, firstAttemptPredicates, generatedPredicates,
                 missingPredicates, extraPredicates, predicateSelectionCorrect, exactPredicateSet,
                 predicates { name: {signature, arity, facts, exampleInPrompt, example} },
                 constants { reference, generated, missing, extra },
                 referenceGrounding / generatedGrounding [ {predicate, line, args [ {position, text, kind,
                   inPack, atThisPosition, onlyAtOtherPositions, predicatesUsingAtom, isRoleName} ]} ],
                 argumentOrder [ {predicate, status same|reversed|not_comparable, evidence} ],
                 argumentOrderCorrect }
timing        { llmMs, dbMs, totalMs, otherMs, llmCalls, dbQueries, firstAttemptLlmMs, repairLlmMs }
efficiency    { pipeline, calls { model, modelRepair, beingdb, diagnose, execute, deterministicRepairs },
                beingdbMs { diagnose, execute }, deterministicRepairs [...], diagnosticCodes,
                path [model | model_repair | query | diagnose | deterministic_repair | execute] }
page          { started, hiddenMs, visibilityChanges, visibilityState, hasFocus, jsHeapMB }
```

Model time (`llmMs`, WebLLM call wall time) and BeingDB time (`beingdb.ms`,
`BeingDB.query` wall time including parsing its JSON reply) are measured
separately around their own calls; `otherMs` is the remainder (reply parsing,
bookkeeping).

Result rows are hashed (`rowsSha256`: sorted distinct rows, column names
ignored) so runs can be compared without storing large result sets; the first
200 rows are kept, and every query can be re-run from its DSL.

Future versions of the schema will change the `/v1` suffix; tools check the
prefix and should keep reading v1.

## Pipeline conditions and cost metrics

`--repair-policy` changes only the repair loop, never the prompt or decoding:

- `model` (default, Run 9): `BeingDB.query`; validation errors go back to the model.
- `db-guided` (Run 10, also `--db-guided-repair`): BeingDB diagnoses each reply
  (`BeingDB.diagnose`), repairs it can prove are applied without a model call,
  and the model is asked again for invalid queries (with diagnostics) and for
  empty results BeingDB proves wrong.
- `proven-only` (Run 11): the same proven repairs, then exactly Run 9's path;
  an empty result never triggers a model call.

| Policy | Proven BeingDB repairs | Model repair of invalid queries | Model asked again when BeingDB proves a valid query empty | Model sees BeingDB diagnostics |
|---|---|---|---|---|
| `model` (default) | no | yes (run 9 message) | no | no |
| `proven-only` | yes | yes (run 9 message, unchanged) | no | no |
| `db-guided` | yes | yes (with diagnostics) | yes (`UNSUPPORTED` allowed) | yes |

**Model repair** sends BeingDB's validation errors back to the model: one
model call each, sampled at temperature 0.7 with seed 1, at most
`--repair-attempts` (2) per question. A **proven repair** is a rewrite that
BeingDB's `diagnose` proposes only when it can prove it. There are two kinds:

- swap two arguments, when that is the only swap that makes every constant
  match;
- replace a single-use variable with the atom its name spells, when that atom
  occurs at exactly that argument.

Proven repairs are applied without a model call, at most
`MAX_DETERMINISTIC_PASSES` (2) per model reply, and recorded per attempt
under `guided`. Under `proven-only` the model's side of the loop is
byte-identical to `model`. Scores therefore include BeingDB's proven fixes,
which help some models' typical mistakes more than others, so keep the policy
fixed when comparing models. To measure a model without them, run it again
with `--repair-policy model`.

Mechanism and message formats:
[internals](internals.md#validation-and-repair).
The policy is recorded in `config.pipeline` (`repairPolicy`, `version`,
`description`), in `nonDefault`, in `summary.json` (`pipeline`, and
`perTrial[].efficiency.repairPolicies`) and per question
(`efficiency.pipeline`).

With repair the question becomes what each correct answer costs, so
`summary.json` (`perTrial[].efficiency`), the run's console summary and
`npm run compare` report:

- model calls (first attempts and repairs), per question and per supported
  question;
- BeingDB calls (diagnose and query/execute) and total BeingDB time;
- proven repairs, the questions they changed, and how many of those ended
  correct;
- questions solved with one model call, and questions needing a model repair;
- correct answers per model call (overall and supported);
- the median end-to-end time per question, and correct answers within 30 s
  and 60 s per question (budgets fixed in advance);
- the tally of diagnostic codes seen.

Records from before Run 10 have no `efficiency` block. For them the counts
are derived from the attempts (one model call and at most one
`BeingDB.query` per attempt), which is exact for those runs, so older runs
compare directly. Under `db-guided` and `proven-only` a "first attempt" is
the first model reply after any proven BeingDB repair (still one model call).

### Conditions in the saved results

A condition is the question file and pack, schema metadata, prompt, grammar,
repair policy, decoding settings, WebLLM version and harness code. Only the
model and machine should vary within one. `--condition` is a free-text label
and changes no setting. Compare `suite.sha256`,
`beingdb.environmentFingerprint`, `config.prompt.sha256`, `config.pipeline`
and `config.nonDefault` rather than the label.

| Condition | Questions | Prompt | Repair policy | Role |
|---|---|---|---|---|
| Baseline (defaults) | `eval/questions.json` | `nl2dsl-prompt/run8` | `model` | historical; needs the pre-annotation pack (`beingdb-wasm` 41c0d8d) |
| Annotated predicates (Run 9) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `model` | ablation |
| Annotated + BeingDB-guided repair (Run 10) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `db-guided` | ablation |
| Annotated + proven repairs (Run 11) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `proven-only` | reference condition |

Saved runs of the reference condition carry the labels
`annotated-predicates-proven-repairs-run11`, `…-llama` and `…-hermes`, with
identical settings and hashes. Results per condition:
[experiment log](internals.md#later-runs-npm-run-benchmark-chrome-154155).

### Timing caveats

Timings depend on the GPU, memory bandwidth and unified memory size. They are
inflated by memory pressure: the report warns when more than 1 GB of swap is
in use at the start or swap grows during the run. Battery power, Low Power
Mode, thermal state and hidden windows also affect them. Almost all
end-to-end time is prompt prefill; BeingDB takes milliseconds per question.
For example, the reference condition gave identical replies on the M1 Air in
Run 11 and in its Chrome 155 rerun, with medians of 28.0 s and 22.1 s per
question.

## Timing metrics

`summary.json` reports `{n, mean, median, min, max, p90, p95}` (nearest-rank
percentiles, true median) for: model ms per call / first attempt / repair,
prompt and completion tokens, time to first token, prefill ms (TTFT minus
grammar compilation), decode ms, prefill and decode tokens/s (WebLLM's own
figures), grammar compile time, BeingDB ms per query / first query / repair
queries / per question, reference query ms, and question-to-result ms.
Aggregates over trials pool all records; counts report `{values, mean, min, max}`
across trials.

The first use of each grammar compiles it (~10 s on an M1). The smoke check
always compiles the main grammar before question 1; `--warmup` also compiles
the repair grammar, so no timed question pays either cost.

Model loading: `loadMs` (total), whether the model was in the cache before
loading, the per-phase windows from WebLLM's progress text (`download` =
"Fetching param cache", `cache_read` = "Loading model from cache",
`shader_compile` = "Loading GPU shader modules"), and the origin's storage
growth (an estimate of downloaded bytes). `--cold` deletes the model from the
cache first to measure a real download; normal runs reuse the cache.

## Failure taxonomy

Assigned by `src/analysis.js`, in this order, with the rule that fired and its
evidence. No model is involved; BeingDB re-runs queries where needed.

Supported questions:

| Category | Rule |
|---|---|
| `supported_marked_unsupported` | the model replied `UNSUPPORTED` |
| `syntax_generation` | reply is not a query, or BeingDB `syntax_error` |
| `unknown_predicate` | BeingDB `unknown_predicate` (rare: the grammar only allows real names) |
| `validation_repair_failed` | final query still rejected by BeingDB after the repair budget (other codes, e.g. `unbound_projection`) |
| `invalid_query` | same, first-attempt field only |
| `wrong_ordering` | right rows, wrong order on the `orderBy` column |
| `wrong_projection` | rows equal the reference on a subset of the answer columns (or fewer columns, as a late fallback) |
| `wrong_predicate` | a required reference predicate is absent |
| `wrong_argument_order` | swapping the two arguments of one pattern makes the answer correct |
| `literal_vs_variable` | a reference constant is written as a variable (`Elsa_Stansfield`, or a single-use, similarly named variable in its argument slot such as `Scratch_Volume_1`), or a role name as an atom (`created_by(work, P)`) |
| `entity_grounding` | the query uses an atom that does not exist in the pack (and a reference entity is missing) |
| `wrong_constraint` | a reference constant is replaced by another of the same kind, or extra constants are added |
| `missing_constraint` | a reference constant or bound is absent |
| `wrong_join` | right predicates and constants, wrong rows, multi-pattern query |
| `unclassified` | valid but wrong and no rule applies |

Unsupported questions: `unsupported_not_detected` (evidence says whether the
query was valid, i.e. fabricated, and which predicates it used). Any question:
`runtime_model_failure` when the model call threw.

The categories are heuristics over deterministic evidence, not ground truth.
The older free-text diagnosis is kept as `score.legacyFailure`. The rule set
is versioned (`ANALYSIS_VERSION` in `src/analysis.js`, recorded as
`config.analysisVersion`).

### Manual annotations

Add `annotations.jsonl` to a run directory (or `<report>.annotations.jsonl`
next to a legacy report), one line per annotation:

```json
{"questionId": "m01", "trial": 1, "category": "wrong_join", "note": "joined on Work but used atom 'work'", "annotator": "jm"}
```

`trial` is optional (all trials). `compare` and `export-results` use the manual
category where present (`manual_category` column) and never change the
automatic one.

## Schema evidence

For each question: required/reference predicates, first and final generated
predicates, missing and extra ones, each predicate's signature as shown to the
model in repair messages (with declared roles and description, when the pack
has them), arity, fact count, whether the prompt showed an example fact, the
reference and generated constants, per-argument grounding of every generated
atom against the pack (exists? at this position? only at the other position of
the same predicate = reversed-role evidence? is it a role name?), and argument
order versus the reference.

`summary.json` aggregates this per trial under `schema`:
`predicateConfusions` (required -> used instead), `reversedArguments` (per
predicate: swap fixes, reversed vs reference, atom only valid at the other
position), `entityGroundingFailures`, `unknownAtoms`,
`failedDespiteCorrectPredicates`, `unsupportedMappedTo` and `predicateUsage`
(how often each required predicate was chosen, with fact counts and whether
its example was in the prompt).

## Determinism

First attempts are greedy (temperature 0). Repairs sample at 0.7 with seed 1;
WebLLM resets the seed per request and has no cross-request prefix cache, so a
question's replies do not depend on what ran before it (the smoke and warm-up
generations do not change results). Replies should repeat exactly on the same
machine, browser, driver and model build; WebGPU numerics can differ across
GPUs and drivers, so exact replies across machines are expected but not
guaranteed. `summary.json` reports `determinism.identicalAcrossTrials`.

## Legacy reports

`compare` and `export-results` accept the pre-harness `eval/results/run*.json`
reports. They are re-analysed in Node against the same BeingDB build (rows are
re-derived from the recorded DSL), marked `legacy: true`, and have no
environment/provenance beyond the user agent.
