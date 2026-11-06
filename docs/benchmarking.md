# Benchmarking the chatbot

The benchmark measures the chatbot's translation step: how often the model
turns a question into a query that BeingDB answers correctly. Use it to check
whether a change to the model, prompt, grammar, schema metadata or repair
policy makes the chatbot better or worse.

## What is measured

The task has 66 questions over the REWIND dataset
(`eval/questions-v4.json`): 55 answerable and 11 deliberately unsupported.

- An answerable question is correct if BeingDB returns the same answer rows
  for the generated query as for a trusted reference query.
- An unsupported question is correct if the model replies `UNSUPPORTED`.

The score is **query-generation accuracy**: one step of the chatbot, not
end-to-end answer accuracy. BeingDB validates a query, returns diagnostics or
facts actually in its store, and lets the wider system repair, reformulate or
rerun it. The benchmark runs only a bounded part of that loop (proven repairs
plus at most two model repairs), so a score of, say, 31/63 means 31 questions
were turned into the right query under this condition, not that BeingDB answers
49% of questions correctly. See the [evaluation method](internals.md#evaluation-method).

Scores depend on the model, the WebLLM version, the browser and the machine,
so treat them as a way to compare changes on your own setup rather than as
fixed numbers. Results are written to `eval/results/`, which is not tracked in
git.

## Running the benchmark

`npm run benchmark` runs the full evaluation for one model in a real browser
through Playwright, using the same code as the chatbot. It checks
compatibility, loads the model, runs and scores every question, and writes a
self-describing run directory. Leave the browser window in the foreground:
hidden pages are throttled, and the report flags them. See
`npm run benchmark -- --help` for every option. It needs an installed Chrome
or Edge with WebGPU and `shader-f16`.

Model-free checks, which need no GPU:

```sh
npm test                                                         # chatbot and summary tests against the linked runtime
npm run check-eval -- --questions eval/questions-v4.json         # reference queries + scorer against the linked pack
```

**List models**

```sh
npm run models                     # VRAM estimate, f16 requirement, context window; flags models too small for the prompt
npm run models -- --filter qwen
```

**Probe a model** (does it load, fit and generate?) before a full run:

```sh
npm run benchmark -- --probe --model <MODEL-ID> \
  --machine "<MACHINE DESCRIPTION>" --questions eval/questions-v4.json
```

The probe ends with status `probe_ok`. Otherwise it reports `incompatible` or
`model_load_failed` (exit code 2) with the reason. Weights are cached in
`~/.cache/beingdb-webllm/browser-profiles/`; keep the default port, 8010, so
the cache is reused.

**Run a candidate model** under the reference condition:

```sh
npm run benchmark -- \
  --model <MODEL-ID> \
  --machine "<MACHINE DESCRIPTION>" \
  --questions eval/questions-v4.json \
  --repair-policy proven-only \
  --condition annotated-v3-proven-repairs
```

**Run the reference model** with the same command and
`--model Llama-3.2-3B-Instruct-q4f16_1-MLC`. Do this on every new machine and
after any meaningful change to the pack, prompt, grammar, pipeline or WebLLM
version.

**Several models** in one go: `npm run benchmark:matrix -- --models eval/models/benchmark-models.json`,
with the same options minus `--model`.

The bare form, `npm run benchmark -- --model <MODEL-ID>`, uses the historical
baseline question file. That file is pinned to the pre-annotation pack, so it
stops as `incompatible` with the current `beingdb-wasm`, by design.

`eval/eval.html` (served by `npm run serve`) runs the original 50 questions
interactively in the page and saves a report to `eval/results/`. It uses the
`model` repair policy and `eval/questions.json`; use it for exploring, and
`npm run benchmark` for comparisons.

## Reference model and reference condition

The **reference model** is `Llama-3.2-3B-Instruct-q4f16_1-MLC`, also the
chatbot's default. It is a stable comparison point, not necessarily the best
model.
- Every new model is compared against it under the same condition, ideally on
  the same machine.
- Rerun it whenever the condition changes.

The **reference condition** is everything besides the model and machine:

| | |
|---|---|
| Questions | `eval/questions-v4.json` (66 items) |
| Data | the REWIND export and BeingDB runtime linked from `beingdb-wasm` |
| Prompt and grammar | the current `src/prompt.js` and `src/grammar.js`, built from the predicate declarations |
| Repair policy | `proven-only`, also the chatbot's default |
| Decoding | defaults: greedy first attempt; repairs at temperature 0.7, seed 1; 200 max tokens; repetition penalty 1; at most 2 model repairs |

Each run records the exact versions and hashes of all of these, plus the
WebLLM version, in its `run.json`.

**Model comparisons are only meaningful when this condition is kept fixed.**
`--condition` is just a label and changes nothing. The settings that define
the condition are recorded in each `run.json` (`config.nonDefault`,
`config.prompt.sha256`, `config.pipeline`); check them before comparing.
Earlier conditions (baseline, Runs 9-11) are listed in
[past conditions](#past-conditions).

**Repair, in brief.** When BeingDB rejects a query, the model can be asked to
repair it. Under `proven-only`, BeingDB first applies its own repairs, but
only rewrites it can prove from the data, such as a uniquely determined
argument swap. These cost no model call. After that, the model is asked to
repair only queries BeingDB still rejects, exactly as under the `model`
policy. An empty result never triggers a retry. `summary.json` counts proven
repairs and model repairs separately. Proven repairs help some models more
than others, so **keep the repair policy fixed across model comparisons**.
Details: [repair policies](#pipeline-conditions-and-cost-metrics).

**Past results.** On an 8 GB M1 MacBook Air with WebLLM 0.2.85, Llama-3.2-3B
scored 31/63 under the previous condition (Run 12: `eval/questions-v2.json`,
prompt run12; about 23 s per question). That is a
historical data point, not a target; the runs behind it and earlier model
comparisons are described in the [experiment log](internals.md#experiment-log).

## Keeping up with WebLLM

`@mlc-ai/web-llm` is a normal npm dependency (`^0.2.85`), and Dependabot opens
a pull request for each new release; the Pages workflow tests and builds it.
To update by hand:

```sh
npm update @mlc-ai/web-llm
npm test          # includes a check that the default model still exists in WebLLM
npm run serve     # try the chatbot
```

New WebLLM releases can change speed and replies. To see whether one helps or
hurts, run the reference model under the reference condition before and after
the update, on the same machine, and compare the two runs.

## Keeping comparisons fair

When comparing models, keep fixed:

- question set
- BeingDB pack and data
- schema metadata
- prompt
- grammar
- repair policy
- decoding settings
- WebLLM version
- browser and browser version, where practical

Record with each run:

- `--machine "<model, chip, RAM>"`
- `--condition <label>`
- `--notes` for anything unusual, e.g. power state or other load

The harness records the model, OS, RAM, swap, power source, browser and WebGPU
adapter itself. Run the reference model on the same machine in the same
session where possible. Use `--runs N` to see timing spread; replies are
deterministic on one machine.

## Results, comparison and export

Each run writes `eval/results/benchmarks/<UTC time>_<machine>_<model>/` on
your machine (the folder is not tracked in git; keep or share runs as you
like):

| File | Content |
|---|---|
| `run.json` | status, labels, condition settings, environment, provenance |
| `questions.jsonl` | every question and attempt: DSL, BeingDB errors, repairs, timings, failure category |
| `summary.json` | accuracy, cost per correct answer, timing statistics, failure categories |
| `browser.log` | page console |

```sh
npm run compare -- eval/results/benchmarks/<runA> eval/results/benchmarks/<runB>
npm run export-results -- --format csv     # all runs -> eval/results/export/, one row per run x question
```

Schemas, metrics and the failure taxonomy are
[below](#result-files-and-schema-beingdb-webllm-benchmarkv1).

## Hardware, provenance and caveats

**Hardware of past runs.** The runs in the experiment log were all made on one machine: a MacBook Air M1
(`MacBookAir10,1`, 8 GB unified memory, macOS 27), mostly in Chrome 154-155.
That is where the experiments happened to run, not a requirement or a
recommendation. The harness exists to compare models across machines. Larger
candidates are listed in [`eval/models/benchmark-models.json`](../eval/models/benchmark-models.json).

**Provenance.** Every report records:

- commits and dirty state of `beingdb-webllm`, `beingdb-wasm` and `beingdb`;
- WASM, data and question-suite hashes, and the BeingDB data fingerprint;
- prompt and grammar hashes;
- the WebLLM version;
- machine, OS, RAM, swap, power, browser and WebGPU adapter details;
- all benchmark parameters.

The benchmark deliberately refuses incompatible environments, such as a
question file whose fingerprint does not match the loaded pack, or a software
GPU. See [compatibility checks](#compatibility-checks-fail-fast).

**Timings are machine-specific.** They depend on GPU, memory and power state,
and on the 8 GB machine heavy swap use inflated them. Compare timings only
under controlled conditions. See [timing caveats](#timing-caveats).

# Harness internals

How `npm run benchmark` works, what it records, and how results are judged.

## Architecture

```
eval/scripts/benchmark.mjs          CLI (options, exit codes)
  eval/scripts/lib/runner.mjs       one run: server, browser, page driving, files
    scripts/lib/server.mjs          the same static server as `npm run serve` (started or reused)
    eval/scripts/lib/provenance.mjs git state, package versions, artefact hashes, host facts
    eval/scripts/lib/suite.mjs      question file -> suite id + sha256 (eval/suite.json)
    playwright-core                 launches the locally installed Chrome/Edge (no bundled browser)
      eval/benchmark.html           thin page exposing window.bench
        eval/src/benchmark.js       load model, smoke check, run one question, report environment
        src/environment.js          navigator / WebGPU adapter facts
        src/pipeline.js             ask(): the same generate -> BeingDB -> repair loop as the chatbot
        eval/src/score.js           the same semantic scorer as eval/eval.html
        eval/src/analysis.js        deterministic failure category + predicate/argument/entity evidence
  eval/scripts/lib/summary.mjs      per-trial and aggregate metrics (Node, from questions.jsonl)
eval/scripts/benchmark-matrix.mjs   several models in sequence (fresh browser per model)
eval/scripts/compare.mjs            two runs side by side
eval/scripts/export-results.mjs     flat CSV/JSONL, one row per run x trial x question
eval/scripts/models.mjs             list/validate WebLLM model ids from the installed package
```

The chatbot (`index.html`), the interactive evaluation (`eval/eval.html`) and the
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
  via `eval/eval.html`.
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
- `eval/questions-v2.json` (suite `rewind-nl2dsl-annotated-v2`) is the
  annotated suite for BeingDB 0.4.0. Counting (`count(Var)`): `u03` ("How many
  works did George Barber create?") is answerable and becomes `c01`, and `c02`-`c04`
  add a grouped count, a count that must be distinct through a join (21 work-venue
  rows, 12 works) and a ranking by count. Text search (`contains`): `s01`-`s04` find
  things by part of a value or an atom's name, one of them combined with a count.
  An audit before Run 12 added `alternatives`: further reference queries that are
  also correct because the pack names one entity in several ways (`arts_council`,
  `arts_council_of_great_britain` and `received_funding_from` in `e09`/`m05`/`h01`;
  the three Tate atoms in `e15`/`h06`; `educated_at`/`studied_at` in `m06`;
  `year_created` subjects that are not works in `c02`/`c06`). An answer is correct
  if it matches the reference or any alternative, and the verdict records which
  (`alternative`, 1-based). `u12` ("Which artist has made the most works?") had
  become answerable and duplicated `c04`, so it now asks for a count filter; `m15`
  (earliest year), `c05`-`c06`, `s05`-`s06` and `u13` (a ratio) were added.
  63 items: 51 supported, 12 unsupported. Pass it with `--questions`.
- `eval/questions-v3.json` (suite `rewind-nl2dsl-annotated-v3`) is v2 for
  BeingDB 0.5.0's `sum`/`avg`/`min`/`max`, with the same fingerprint. `u04`
  ("What is the average duration of the works?") is answerable and becomes `a01`;
  running times are recorded under both `duration_minutes` and `length_minutes`, so
  it accepts either or both as alternatives. `a02` (one artist's first and last
  years), `a03` (each artist's earliest year) and `a04` (the latest year; works-only
  years accepted, as in `c02`/`c06`) were added. `u12` (a count filter) and `u13`
  (a ratio) stay unsupported. 66 items: 55 supported, 11 unsupported. Every other
  item is unchanged from v2.
- `eval/questions-v4.json` (suite `rewind-nl2dsl-annotated-v4`) has v3's questions
  over the cleaned pack (beingdb-rewind-interviews a561d79, fingerprint
  `sha256:1776a24b…`): duplicate entity atoms and synonym predicates were merged
  (168 -> 114 predicates, 1,842 -> 1,778 facts). With one Arts Council atom,
  education under `educated_at` only, running times under `duration_minutes` only
  and `year_created` holding works only, `e09`/`m05`/`h01` use
  `arts_council_of_great_britain` and lose their alternatives, `m06` and `a01` lose
  theirs, and the `c02`/`c06`/`a04` alternatives that now return the reference's
  rows are dropped; `e17` uses `maidstone_college_of_art`. Thirteen `expectCount`s
  changed with the data, e.g. `m09` (Elsa Stansfield's 1980s works) from 1 to 5
  once her facts under `elsa` joined. The Tate atoms (`e15`/`h06`) are unchanged.
  Runs on v3 and v4 are not directly comparable: the answers changed with the data.
  The pipeline replay tests (`test/replay.test.mjs`) load the v3 data from
  `eval/test/fixtures/rewind-72f26c.browser.json.gz` so recorded runs still replay.
- `npm run check-eval -- --questions <file>` checks references, examples and
  the scorer against the linked build for any of these files.

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
                remote, dirty, changedFiles, diffSha256} },
                artefacts { beingdbWasmRuntime ("prebuilt" | "build"), beingdbWasmPrebuilt (prebuilt/runtime.json:
                            beingdb commit, sources, toolchain), wasm loader/module/data sha256,
                            rewindDataMeta (fingerprint, counts, facts and BeingDB commits) },
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

### Past conditions

A condition is the question file and pack, schema metadata, prompt, grammar,
repair policy, decoding settings, WebLLM version and harness code. Only the
model and machine should vary within one. `--condition` is a free-text label
and changes no setting. Compare `suite.sha256`,
`beingdb.environmentFingerprint`, `config.prompt.sha256`, `config.pipeline`
and `config.nonDefault` rather than the label.

| Condition | Questions | Prompt | Repair policy | Role |
|---|---|---|---|---|
| Baseline (defaults) | `eval/questions.json` | `nl2dsl-prompt/run8` | `model` | historical; needs the pre-annotation pack (`beingdb-wasm` 41c0d8d) |
| Annotated predicates (Run 9) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `model` | historical ablation; prompt run9 is `beingdb-webllm` 5e28dc5 |
| Annotated + BeingDB-guided repair (Run 10) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `db-guided` | historical ablation; as Run 9 |
| Annotated + proven repairs (Run 11) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `proven-only` | previous reference condition; as Run 9 |
| Annotated v2 + proven repairs (Run 12) | `eval/questions-v2.json` | `nl2dsl-prompt/run12` | `proven-only` | previous reference condition (needs BeingDB/`beingdb-wasm` 0.4.0); Llama 31/63 (below) |
| Annotated v3 + proven repairs (Run 13) | `eval/questions-v3.json` | `nl2dsl-prompt/run13` | `proven-only` | previous reference condition (needs BeingDB/`beingdb-wasm` 0.5.0); Llama 37/66 (below) |
| Annotated v4 + proven repairs (Run 14) | `eval/questions-v4.json` | `nl2dsl-prompt/run14` | `proven-only` | reference condition (needs `beingdb-wasm` with the cleaned REWIND data); Llama 41/66 (below) |

Prompt run13 lets the model write `sum(Var)`, `avg(Var)`, `min(Var)` and
`max(Var)`: the grammar accepts them wherever it accepted `count(Var)`, a rule says
to use them like `count` for totals, averages, earliest and latest and to keep the
thing being added up as a variable (BeingDB adds each distinct combination of the
named variables once, so `duration_minutes(_, Minutes)` would add equal running
times once), the "unsupported" rule now names arithmetic and filters on a count or
total, one example uses `min`, and the unsupported "total running time" example
became an unsupported subtraction. Suite v3 makes `u04` (average duration) the
answerable `a01` and adds `a02`-`a04`. To separate the prompt from the questions,
run prompt run12 on v3 as well (check out the commit that adds
`eval/questions-v3.json`), then compare both on the 62 shared questions and on
`a01`-`a04`:

```bash
npm run benchmark -- --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "<MACHINE DESCRIPTION>" --questions eval/questions-v3.json \
  --repair-policy proven-only --condition annotated-v3-proven-repairs-run13-llama
```

Run 13 with Llama 3.2 3B (`20261106T150229Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`,
complete, BeingDB/`beingdb-wasm` 0.5.0, on battery with 1.6 GB of swap in use, so
timings are not representative): 37/66 overall, 30/55 supported, 7/11 unsupported.
Prompt run12 on v3 was not run separately: with the run12 prompt, the first 24 v3
questions reproduced the Run 12 v2 run (`20261106T120006Z_…`) exactly, and replaying
that run's recorded replies through BeingDB 0.5.0 left all 62 shared questions
unchanged. On those 62, Run 13 scores 35 against Run 12's 30. It gained `e03`,
`e09`, `m01`, `m03`, `m10`, `m15` (`min(Year)`) and the refusals `u02`, `u05`, `u09`,
and lost `e07`, `e13`, `c01` (refused although answerable) and `m07`
(`Work contains "george_barber"`). Of the new items, `a01` (`avg`) and `a04` (`max`)
are correct; `a02` picked the wrong predicate and `a03` did not group. The model gave
"Queries cannot filter on a count or total" as the reason for unrelated refusals
(`u05`, `u10`, `u11`, `u13`), and in the chatbot refused "How many people were
employed by the BBC?" with it.

Prompt run14 targets those refusals: counting is always allowed and only arithmetic
or a condition on a count or total is unsupported; the model is told to check the
predicate names and descriptions before refusing; the subtraction example's reason
becomes "Queries cannot do arithmetic"; and a plain count over people (`employed_by`)
is added as an example. A smoke check of an earlier draft
(`20261106T155133Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`, `--ids` on
`c01`, `c06`, `e07`, `e12`, `e13`, `u05`, `u10`, `u11`, `u12`, `u13`, so partial)
got 7/10 against Run 13's 6/10 on the same items: `e13` became correct and refusals
gave fitting reasons instead of the count one. That draft also had an unsupported
example "Who had more than five collaborators?" ("Queries cannot filter on a
count"); the model copied its reason onto `c01` and still did not refuse `u12`, so
it was removed. The draft's prompt hashes therefore differ from the final run14,
whose "studied at a college" example also uses `educated_at` because the cleaned
pack merged `studied_at` into it. Run 14 is measured on suite v4, so it changes
the prompt and the data at once: compare it with Run 13 overall and per item, and
read a change on an item whose data changed (the v4 entry above lists them) as
possibly the data's. It needs a full run:

```bash
npm run benchmark -- --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "<MACHINE DESCRIPTION>" --questions eval/questions-v4.json \
  --repair-policy proven-only --condition annotated-v4-proven-repairs-run14-llama
```

Run 14 with Llama 3.2 3B (`20261106T173129Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`,
complete, 6.5 GB of swap in use at the start, so timings are not representative;
3,045 prompt tokens): 41/66 overall, 33/55 supported, 8/11 unsupported, against
Run 13's 37/66 (30/55, 7/11). It gained `e04`, `e07`, `e13`, `m07`, `c01`, `c05`,
`a02` and `u06`: the refusals of answerable questions that run14 targets
(`e07`, `e13`, `c01`) are gone, and `e04` benefits from the merged BFI atoms. It
lost `e03` and `m08` (a constant put into a variable's place; an unrelated
predicate chain) and `e17` and `h01`, whose data changed: the model guessed
`maidstone_college` and `arts_council`, atoms the cleaned pack no longer has,
and `m05` fails the same way. BeingDB reports each as `unknown_constant`, with
exactly one value at that argument containing the guessed name
(`maidstone_college_of_art`, `arts_council_of_great_britain`), but
`proven-only` does not treat that as a proven repair, so the empty result (or,
under `not`, the unfiltered one in `h01`) stands. Entity grounding is therefore
the main open problem after the pack cleanup.

BeingDB 0.5.1 adds the `replace_constant` repair for exactly this: an atom that
occurs in no fact, extended at an underscore by exactly one atom at that
argument, in any scope (beingdb-wasm repinned to it). Replaying Run 14's
recorded replies through it, `e17` and `h01` become correct with one model call
and one proven repair; `m05` gets the atom right but keeps an unrelated clause
the model added. With the same replies Run 14 would score 43/66; a new run
measures it.

Saved runs of the Run 11 condition carry the labels
`annotated-predicates-proven-repairs-run11`, `…-llama` and `…-hermes`, with
identical settings and hashes.

Prompt run12 lets the model write `count(Var)` and `Var contains "text"`: the
decoding grammar accepts `count(Var)` in `find` and `order by` and `contains` with
quoted text as a clause, the rules say to count "how many" in the query (sums,
averages, ratios and filters on a count stay unsupported) and, when a question gives only a word or part of a
name, to use `contains` instead of guessing an atom, and two examples of each show
them (an overall and a per-group count; `contains` on a text column and on an atom
column), none of them eval questions or eval predicates' answers. It changes the prompt for every question, so compare
Run 12 with Run 11 on the 48 items whose question text they share (`u03` became
`c01` and `u12` was replaced) as well as on the new items; `e09`, `e15`, `m05`,
`m06`, `h01` and `h06` also accept their alternatives in Run 12, so count those
separately (`alternative` in the verdict) when comparing. For
Llama:

```bash
npm run benchmark -- --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --questions eval/questions-v2.json --repair-policy proven-only \
  --condition annotated-v2-proven-repairs-run12-llama
``` Results per condition:
[experiment log](internals.md#later-runs-npm-run-benchmark-chrome-154155).

From BeingDB 0.1.5 (`beingdb-wasm` built from it), a diagnostic for a constant
that occurs nowhere in its predicate can end with `Did you mean <value>?` (0.1.6
only suggests values that are close in spelling or share most of their words). Only the
`db-guided` policy (Run 10) shows diagnostic messages to the model, so its repair
messages can differ from runs on older builds, although the recorded Run 10
replies still reproduce exactly (`test/pipeline.test.mjs`); `model` and
`proven-only` are unaffected (`proven-only` applies the same proven repairs as
before). The prompt is unchanged, so `config.prompt.sha256` stays the same: tell
such runs apart by `provenance.repositories.beingdb` / `beingdb-wasm` commits.
Execute responses also gain `hasMore` and `truncated`, which scoring ignores.

BeingDB 0.1.7 adds the `unsatisfiable_comparison` diagnostic (a comparison no
stored value satisfies, such as `Price > 1000` on a retailer column), and an empty
DSL result now carries the `diagnose` fields. In the recorded Run 10 replies this
adds lines to the repair messages of `e16` and `u05` only; outcomes, paths, calls and
proven repairs are unchanged, and the Run 10 replay test tolerates exactly those
added lines. BeingDB 0.4.1's `contains` hint (a diagnostic for a literal
that only occurs inside values at its argument ends with advice to use `contains`)
extends one recorded line (`h02`); the replay test strips exactly that sentence.

A smoke run of the eight new v2 items with Llama 3.2 3B
(`20261023T175241Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`, `--ids`, so
partial) got 1/8: the model used `count(...)` for every count question but did not
group (`c02`), and never used `contains`, writing the searched word as an argument
instead. It also exposed wrong references (`s01`, `s03`, `s04` targeted small text
predicates while the main atom predicates `uses_medium`/`exhibited_at` hold most
matches) and a `db-guided` gap (a zero count is one row, so a provably empty count
was not treated as empty). The v2 references, the run12 rules and examples (a
grouped count; `contains` on an atom column) and the pipeline (`provablyEmpty`) were
changed after it, so that run predates the final v2 suite and prompt.

A second smoke run on the post-smoke-1 v2 suite and prompt
(`20261023T180602Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`, partial) got
2/8: the grouped-count example fixed `c02`, while `c03`/`c04` still fail on the
predicate or entity (a misspelled atom in the wrong argument; `collaborated_with`
for "created"), as in ordinary questions. Llama 3.2 3B still never used `contains`
(`s01`-`s04`): it writes the word as an argument constant or picks a predicate by
name similarity. Treat the `s` items as a capability measure for small models
rather than tuning the prompt further for them.

Run 12 with Llama 3.2 3B (`20261023T203430Z_macbookair10-1_Llama-3.2-3B-Instruct-q4f16_1-MLC`,
complete, BeingDB/`beingdb-wasm` 0.4.1, run under `caffeinate -dimsu`): 31/63
overall, 26/51 supported, 5/12 unsupported. On the 48 items whose question text
Run 11 shares, it scores 26/48, the same as both Run 11 Llama runs, but not on the
same items: `e02`, `e05` (using `contains "school"`) and `m06` became correct, and
`e09` (`Recipient = "Arts Council"`), `m05` (`contains "arts_council"` on an
interview URL) and `m13` became wrong. The longer prompt therefore moves answers
without a net change, and the model now uses `contains`, though not always where
it belongs. New items: 5/15 (`c01`, `c02`, `c06`, `s05`, `u13`); `u12` (a count
filter) was answered with a count query. No answer needed an alternative
reference. An earlier attempt (`20261023T183426Z_…`) is kept for the record: it
was aborted when `u05` timed out after 600 s, most likely because the machine slept
(a Node replay of the pipeline on that reply takes milliseconds); its 54 completed
items match the complete run exactly.

### Timing caveats

Timings depend on the GPU, memory bandwidth and unified memory size. They are
inflated by memory pressure: the report warns when more than 1 GB of swap is
in use at the start or swap grows during the run. Battery power, Low Power
Mode, thermal state and hidden windows also affect them. Almost all
end-to-end time is prompt prefill; BeingDB takes milliseconds per question.
For example, the Run 11 condition gave identical replies on the M1 Air in
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

Assigned by `eval/src/analysis.js`, in this order, with the rule that fired and its
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
is versioned (`ANALYSIS_VERSION` in `eval/src/analysis.js`, recorded as
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
