# beingdb-webllm

An experiment: can a **small local browser LLM** act as a natural-language
interface to [BeingDB](../beingdb)? This repository holds the demo and a
benchmark harness that compares WebLLM models, machines and pipeline settings
on a fixed 50-question task.

| | |
|---|---|
| **Current reference model** | `Llama-3.2-3B-Instruct-q4f16_1-MLC` |
| **Reference condition** | annotated predicates + proven BeingDB repairs ([command](#run-the-reference-condition)) |
| **Reference result** | 28/50 correct, one trial on a MacBook Air M1 8 GB ([details](#current-reference-model)) |
| **Detailed docs** | [docs/benchmarking.md](docs/benchmarking.md) (harness, result schema, metrics) and [docs/internals.md](docs/internals.md) (pipeline, prompt, repair, experiment log) |

## What it does

```
question
  -> local WebLLM model    translates the question into a query, or replies UNSUPPORTED
  -> BeingDB DSL
  -> BeingDB WASM          validates, applies only repairs it can prove, executes
  -> results               rows straight from BeingDB
```

**The LLM interprets the question; BeingDB determines the answer.** The model
never sees, edits or summarises result rows, and it holds no data. A query
BeingDB accepts can still mean something other than what was asked. That gap
is what the benchmark measures.

**What is evaluated.** There are 50 questions over the Rewind dataset: 38
answerable (18 easy, 14 medium, 6 hard) and 12 deliberately unsupported. An
answerable question is correct only if BeingDB returns the same answer rows
for the generated query as for a trusted reference query. An unsupported
question is correct if the model replies `UNSUPPORTED`. See
[evaluation method](docs/internals.md#evaluation-method).

Everything runs locally: static files, WebLLM, BeingDB WASM and the exported
Rewind pack. There is no remote model API, API key, telemetry, embeddings or
vector store. The only network access is the one-off download of model weights
(Hugging Face) and WebLLM's model library (GitHub), which the browser caches.

## Relationship to BeingDB

| Repository | Role |
|---|---|
| [`beingdb`](../beingdb) | the database: DSL parser, validator, planner, evaluator, query diagnostics and proven repairs |
| [`beingdb-wasm`](../beingdb-wasm) | the same runtime compiled to WebAssembly for the browser, plus the exported (annotated) Rewind pack |
| `beingdb-webllm` (this repo) | WebLLM model, prompt, output grammar, repair loop, evaluation and benchmark harness |

Nothing from BeingDB is copied here. `npm run link` symlinks the
`beingdb-wasm` release build into `vendor/`, and the app uses its public
browser API (`BeingDB.load`, `query`, `predicates`, `diagnose`). The schema
shown to the model is built from `BeingDB.predicates()` at startup, so nothing
about the dataset is hard-coded. See
[consuming beingdb-wasm](docs/internals.md#consuming-beingdb-wasm).

## Quick start

You need:

- Node 22 or later.
- Sibling checkouts of `../beingdb-wasm` (and `../beingdb`).
- A browser with WebGPU and `shader-f16`. The benchmark needs Chrome, Edge or
  another Chromium-based browser.
- Enough free memory for the model: WebLLM estimates about 2.3 GB of GPU
  memory for 3B q4f16 models.

```sh
(cd ../beingdb-wasm && dune build --profile release)   # release build = one .wasm module (Safari needs it)
npm install
npm run link     # vendor/ -> ../beingdb-wasm build + WebLLM
npm run serve    # http://localhost:8010/
```

Model-free checks (no WebGPU or model):

```sh
npm test                                                         # schema/prompt/pipeline tests (incl. the linked WASM build)
npm run check-eval -- --questions eval/questions-annotated.json  # reference queries and scorer against the linked pack
node eval/diagnose-annotations.mjs                               # do the pack's predicate annotations reach the prompt?
```

## Run a model interactively

- <http://localhost:8010/>: the demo. Click **Load model**, type a question
  and press **Ask BeingDB**. The page shows the generated DSL, BeingDB's
  verdict, any repairs, timings, the raw rows and the full prompt.
- <http://localhost:8010/eval.html>: runs the 50 questions in the page and
  saves a report to `eval/results/`. Keep the tab visible. Inspect a report
  with `node eval/show-run.mjs eval/results/<report>.json`, or re-score it in
  Node with `node eval/check-references.mjs eval/results/<report>.json`.

Both pages default to `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`, the original small
model. Use another model with `?model=<MODEL-ID>`, e.g.
`?model=Llama-3.2-3B-Instruct-q4f16_1-MLC`. The interactive pages always use
the default (`model`) repair policy, and `eval.html` reads
`eval/questions.json`. Use them for exploring, and `npm run benchmark` for
comparisons.

## Systematic benchmarking

`npm run benchmark` runs the full evaluation for one model in a real browser.
Playwright drives a locally installed Chrome/Edge with WebGPU, running the same
code as the demo. The command starts the server, launches the browser, checks
compatibility, loads the model, runs, scores and records every question, and
writes a self-describing run directory. `npm run benchmark -- --help` lists
every option.

### List models

```sh
npm run models                                            # WebLLM prebuilt models: VRAM estimate, f16, context window
npm run models -- --filter llama
npm run models -- --validate models/benchmark-models.json # check a matrix file
```

Models whose context window cannot hold the prompt (~2,500 tokens plus
repairs) are flagged.

### Probe a model

Check that a model loads and fits before spending a full run on it:

```sh
npm run benchmark -- --probe \
  --model <MODEL-ID> \
  --machine "<MACHINE DESCRIPTION>" \
  --questions eval/questions-annotated.json
```

The probe checks WebGPU, the adapter (a software renderer is rejected),
`shader-f16`, the WebGPU limits WebLLM needs, the data fingerprint against the
question file, model loading, the context window, and one smoke generation.
The result is a run with status `probe_ok`. Otherwise the status is
`incompatible` or `model_load_failed` (exit code 2) with the reason. Weights
download once into `~/.cache/beingdb-webllm/browser-profiles/`. Keep the
default port (8010) so the cache is reused.

### Run a benchmark

New candidate models run in the reference condition:

```sh
npm run benchmark -- \
  --model <MODEL-ID> \
  --machine "<MACHINE DESCRIPTION>" \
  --questions eval/questions-annotated.json \
  --repair-policy proven-only \
  --condition annotated-predicates-proven-repairs
```

**Leave the browser window in the foreground until it finishes.** Browsers
throttle hidden pages, and the report flags questions that ran while hidden.
A 3B model takes about 20 minutes on the 8 GB M1.

The bare default form,
`npm run benchmark -- --model <MODEL-ID> --machine "<MACHINE DESCRIPTION>"`,
runs the historical *baseline* condition (`eval/questions.json`, `model`
repair). That question file is pinned to the pre-annotation pack, so with the
current `beingdb-wasm` build it stops as `incompatible`, by design.

Useful options: `--runs N` (repeat with the model loaded once), `--warmup`
(compile both grammars before timing), `--notes "..."`, `--ids e01,m02`
(partial run), `--browser edge`, `--cold` (measure a fresh download).

### Run the reference condition

```sh
npm run benchmark -- \
  --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "<MACHINE DESCRIPTION>" \
  --questions eval/questions-annotated.json \
  --repair-policy proven-only \
  --condition annotated-predicates-proven-repairs
```

Run it on every new machine, and again after any meaningful change to the
pack, schema metadata, prompt, grammar, repair pipeline or WebLLM version.
Candidate models then always have a reference run from the same condition and
machine.

The saved runs of this condition are labelled
`annotated-predicates-proven-repairs-run11`, `…-llama` and `…-hermes`. They
have identical settings and prompt/grammar hashes. The label is free text and
the model is recorded separately, so use one model-independent label per
condition for new runs, as above.

### Several models

```sh
npm run benchmark:matrix -- \
  --models models/benchmark-models.json \
  --machine "<MACHINE DESCRIPTION>" \
  --questions eval/questions-annotated.json \
  --repair-policy proven-only \
  --condition annotated-predicates-proven-repairs
```

The models file is a JSON array of `{"id", "label", "runs"?}`. Every model
gets the same settings and a fresh browser.
[`models/benchmark-models.json`](models/benchmark-models.json) lists larger
(7-8B) candidates for machines with more memory.

## Benchmark conditions

A **condition** is everything besides the model and machine that can change a
result:

- question file and BeingDB pack
- schema metadata and prompt
- grammar
- repair policy
- decoding settings
- WebLLM version and harness code

**Model comparisons are meaningful only within one condition.**

- `--condition <label>` is only a label (default `baseline`). It changes no
  setting. Use it to name the experiment.
- Settings that differ from the defaults are listed in `run.json` under
  `config.nonDefault` (and printed as a warning). The prompt and grammar
  hashes are in `config.prompt.sha256` and the repair policy in
  `config.pipeline`. Check these, not just the label, before comparing runs.
- Do not compare a baseline run with an annotated/proven-repair run as if only
  the model changed.

Conditions in the saved results:

| Condition | Questions | Prompt | Repair policy | Role |
|---|---|---|---|---|
| Baseline (defaults) | `eval/questions.json` | `nl2dsl-prompt/run8` | `model` | historical; needs the pre-annotation pack (`beingdb-wasm` 41c0d8d) |
| Annotated predicates (Run 9) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `model` | ablation |
| Annotated + BeingDB-guided repair (Run 10) | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `db-guided` | ablation |
| **Annotated + proven repairs (Run 11)** | `eval/questions-annotated.json` | `nl2dsl-prompt/run9` | `proven-only` | **reference condition** |

The two question files hold the same 50 questions and reference queries. They
differ only in the BeingDB data fingerprint they are pinned to. Annotating the
pack's predicates changed that fingerprint, and the benchmark refuses a
question file that does not match the loaded pack. See
[question sets and fingerprints](docs/benchmarking.md#question-sets-data-fingerprints-and-prompt-versions).

## Repair policies

A model reply can be wrong in ways BeingDB detects. **Repair** is the bounded
step that tries to fix such a reply before the answer is scored. There are two
kinds:

- **Model repair.** BeingDB's validation errors go back to the model, which is
  asked again. This costs a model call (sampled at temperature 0.7, seed 1). A
  question gets at most 2 model repairs (`--repair-attempts`).
- **Proven (deterministic) repair.** BeingDB's `diagnose` rewrites the query
  itself, with no model call, but only when it can prove the rewrite. There
  are currently two cases:
  - swap two arguments, when that is the only swap that makes every constant
    match where it occurs in the data;
  - replace a single-use variable with the atom its name spells
    (`BBC` -> `bbc`), when that atom occurs at exactly that argument.

  These repairs are applied to each model reply, at most 2 passes, before the
  query is executed.

`--repair-policy` selects how the two are combined. The prompt, model and
decoding are the same under every policy.

| Policy | Proven BeingDB repairs | Model repair of invalid queries | Model asked again when BeingDB proves a valid query returns nothing | Model sees BeingDB diagnostics |
|---|---|---|---|---|
| `model` (default) | no | yes | no | no |
| **`proven-only`** (recommended) | yes | yes, exactly as in `model` | no | no |
| `db-guided` (alias `--db-guided-repair`) | yes | yes | yes (it may then reply `UNSUPPORTED`) | yes |

**Use `proven-only` for systematic experiments.** The model's side of the loop
is identical to `model`: the same repair messages, and an empty result is
accepted like any other. BeingDB only adds fixes it can prove, at no model
cost. In Run 11 that added 5 correct answers with zero extra model calls.
`db-guided` reached the same score in Run 10 but used 18 more model calls.

**Keep the policy fixed when comparing models.** Proven repairs fix particular
mistakes (swapped arguments, names written as variables). Some models make
those mistakes more often than others, so a different policy changes scores
unevenly across models.

How the policy is accounted for:

- Under `proven-only` and `db-guided`, the "first attempt" is the first model
  reply *after* any proven repair. It is still one model call.
- `summary.json` (`perTrial[].efficiency`) counts model calls, model repair
  calls and proven repairs separately, and how many of those ended correct.
- To measure a model without BeingDB's help, run it again with
  `--repair-policy model`.

Algorithms and message formats:
[validation and repair](docs/internals.md#validation-and-repair),
[pipeline conditions and cost metrics](docs/benchmarking.md#pipeline-conditions-and-cost-metrics).

## Experimental discipline

When comparing models, keep these fixed (and verify them in `run.json`):

- [ ] question file (`suite.sha256`) and BeingDB pack (`beingdb.environmentFingerprint`, `provenance.artefacts`)
- [ ] schema metadata, prompt and grammar (`config.prompt.version` and `config.prompt.sha256`)
- [ ] repair policy (`config.pipeline`)
- [ ] decoding settings (`config.generation`, `config.nonDefault`)
- [ ] WebLLM version and harness commit (`provenance`)
- [ ] machine, browser and browser version where practical

Record with every run:

- [ ] `--machine` with a description: model, chip, RAM
- [ ] `--condition` with the condition label
- [ ] `--notes` with anything unusual: power state, other load, why the run was made

The harness records OS, RAM, power source, swap, browser and WebGPU adapter
automatically. Run the reference model on the same machine in the same
session where possible. A single trial is one observation: use `--runs N` to
check timing spread (replies are deterministic on one machine).

## Current reference model

`Llama-3.2-3B-Instruct-q4f16_1-MLC` is the **reference model**. It is a stable
comparison point for ongoing experiments:

- it is not necessarily the best model available;
- rerun it after meaningful schema, prompt, pipeline or runtime changes;
- compare each new candidate against it under the same condition, ideally on
  the same machine.

Its current result is a reference point, not a leaderboard entry:

| | |
|---|---|
| Model | `Llama-3.2-3B-Instruct-q4f16_1-MLC` (WebLLM 0.2.85) |
| Condition | annotated predicates + `proven-only` repair (`eval/questions-annotated.json`, `nl2dsl-prompt/run9`, other settings default) |
| Hardware | MacBook Air M1 (`MacBookAir10,1`), 8 GB, macOS 27, Chrome 155, mains power, 8.6 GB swap in use at start |
| Overall correct | **28/50 (56%)** |
| Supported correct, first attempt / after repair | 21/38 / **22/38** |
| Valid DSL after repair | 36/38 |
| Unsupported recognised | 6/12 (5 others got a valid but meaningless query) |
| Model calls | 60 (10 model repairs); 5 proven BeingDB repairs, all ended correct |
| Median model time per call | 21.2 s |
| Median end-to-end per question | 22.1 s |
| Run | [`20261009T102014Z_…`](eval/results/benchmarks/20261009T102014Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/) (clean commits) |

The same condition was first run as Run 11
([`20261006T181140Z_…`](eval/results/benchmarks/20261006T181140Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
Chrome 154). The replies and scores were identical, but the median was
28.0 s per question, which shows how much timings vary on one machine.

## Models tested so far

All runs below are single trials on the same MacBook Air M1 8 GB. Scores are
comparable only within a table.

**Reference condition** (annotated predicates, `proven-only`):

| Model | Overall | Supported correct | Valid DSL | Unsupported recognised | False refusals | Model calls | Median per question |
|---|---|---|---|---|---|---|---|
| Llama-3.2-3B-Instruct (reference) | 28/50 | 22/38 | 36/38 | 6/12 | 0 | 60 | 22.1 s (mains) |
| Hermes-3-Llama-3.2-3B | 27/50 | 19/38 | 28/38 | 8/12 | 3 | 68 | 22.0 s (battery) |

The same Llama model scored 23/50 under the `model` policy (Run 9) and 28/50
under `db-guided` (Run 10, 78 model calls).

**Baseline condition** (pre-annotation pack, `eval/questions.json`,
`nl2dsl-prompt/run8`, `model` repair):

| Model | Overall | Supported correct | Valid DSL | Unsupported recognised | Median per question |
|---|---|---|---|---|---|
| Qwen2.5-1.5B-Instruct | 14/50 | 14/38 | 32/38 | 0/12 | 10.2 s |
| Llama-3.2-3B-Instruct | 20/50 | 13/38 | 32/38 | 7/12 | 16.1 s |
| Qwen3.5-2B | aborted after 19 questions: no valid DSL (empty `<think>` blocks despite `enable_thinking: false`), then a 600 s timeout | | | | |

Qwen2.5-3B was only tried with the earlier interactive harness and a
pre-final prompt: 6/38 supported correct, at about twice the latency of the
1.5B model.

Full record, run by run:
[experiment log](docs/internals.md#experiment-log) and
[`eval/results/benchmarks/`](eval/results/benchmarks/).

## Hardware used so far

Every completed run in this repository so far was produced on one machine:

| Machine | Chip / GPU | Memory | OS | Browsers |
|---|---|---|---|---|
| MacBook Air (`MacBookAir10,1`) | Apple M1, WebGPU adapter `apple / metal-3` | 8 GB unified | macOS 27 | Chrome 154-155 (benchmark); VS Code Chromium 150, Chrome 153, Safari 27 (interactive) |

This is where the experiments happened to run, not a requirement or a
recommendation. The harness was built to compare across machines, memory sizes,
Apple Silicon generations and other WebGPU-capable hardware. Every run records
the machine it ran on. Runs on this machine had heavy swap use (about 8-10.5 GB
at the start of each benchmark), and some were on battery. Larger models in
`models/benchmark-models.json` need a machine with more memory. Browser notes:
Safari works but was about 2.3x slower; Firefox 156 could not run WebLLM (a
WebGPU limit). See [browser support](docs/internals.md#browser-support).

## Results and comparison

Each run writes `eval/results/benchmarks/<UTC time>_<machine>_<model>/`:

| File | Content |
|---|---|
| `run.json` | status, labels, configuration, environment, provenance, model loading |
| `questions.jsonl` | every question and attempt: DSL, BeingDB errors, repairs, timings, failure category |
| `summary.json` | accuracy counts, cost/efficiency, timing statistics, failure categories |
| `browser.log` | page console |

```sh
npm run compare -- eval/results/benchmarks/<runA> eval/results/benchmarks/<runB>
npm run export-results -- --format csv     # all runs -> eval/results/export/, one row per run x question
```

`compare` prints condition, accuracy, cost, latency and failure categories
side by side, plus the questions one run got right and the other wrong. It
also reads the older `eval/results/run*.json` reports. `export-results`
produces flat CSV/JSONL for pandas or R. Schemas, metrics and the failure
taxonomy: [docs/benchmarking.md](docs/benchmarking.md#result-files-and-schema-beingdb-webllm-benchmarkv1).

## Reproducibility and provenance

Every run records:

- the git commit and uncommitted changes of `beingdb-webllm`, `beingdb-wasm`
  and `beingdb` (a dirty tree is reported, never hidden);
- hashes of the WASM build and data, and the BeingDB data fingerprint;
- the question suite id and its sha256;
- the prompt version and prompt/grammar hashes;
- the WebLLM version;
- machine, OS, RAM, swap, power source, browser and WebGPU adapter/limits;
- all benchmark parameters, with non-default ones listed.

The benchmark refuses to run with an incompatible environment: a question file
whose fingerprint does not match the loaded pack, a software GPU, missing
WebGPU features or limits, or a context window too small for the prompt. First
attempts are greedy and repairs are seeded, so replies repeat exactly on the
same machine and browser. WebGPU numerics may differ across GPUs and drivers.
See [compatibility checks](docs/benchmarking.md#compatibility-checks-fail-fast)
and [determinism](docs/benchmarking.md#determinism).

## Interpreting timings

- Timings depend on hardware: GPU, memory bandwidth and unified memory size.
- Memory pressure matters. On an 8 GB machine a 3B model leaves little
  headroom, and swap in use or growing during a run inflates timings. The
  report warns about both.
- Battery versus mains power, Low Power Mode and thermal state can matter.
- Hidden or occluded browser windows are throttled; questions that ran
  hidden are flagged.
- Almost all time is prompt prefill (WebLLM has no prefix cache across
  questions). BeingDB takes milliseconds per question.
- Compare timings only between runs under reasonably controlled conditions:
  same machine, power, similar memory state.

For example, the reference condition gave identical replies on the M1 Air in
Run 11 and in the later rerun. The median per question was 28.0 s in one and
22.1 s in the other.

## Limitations

- Accuracy is too low for unsupervised use: always read the generated DSL.
  BeingDB guarantees that shown rows are real facts for that query, not that
  the query means what was asked.
- One dataset and 50 questions, written with knowledge of the data. The
  few-shot examples resemble some question patterns. Results so far are
  single trials.
- Needs WebGPU. BeingDB itself runs in any browser `beingdb-wasm` supports.

## Detailed documentation

- [docs/benchmarking.md](docs/benchmarking.md): harness architecture,
  compatibility checks, question sets and fingerprints, result schema,
  repair-policy accounting and cost metrics, timing metrics, failure taxonomy,
  manual annotations, determinism.
- [docs/internals.md](docs/internals.md): execution path, schema context,
  prompt, output grammar,
  [validation and repair](docs/internals.md#validation-and-repair)
  (including BeingDB-guided and proven-only repair), evaluation method,
  [experiment log](docs/internals.md#experiment-log) (runs 1-11 and later),
  performance and browser support.
- [eval/questions.json](eval/questions.json) and
  [eval/questions-annotated.json](eval/questions-annotated.json): the question
  set (the same items, pinned to the pre-annotation and annotated packs).
