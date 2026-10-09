# beingdb-webllm

Can a **small local browser LLM** act as a natural-language interface to
BeingDB? This repository holds a demo and a benchmark harness that compares
WebLLM models, machines and settings on a fixed 50-question task.

| | |
|---|---|
| **Reference model** | `Llama-3.2-3B-Instruct-q4f16_1-MLC` |
| **Reference condition** | annotated question set + current pack, prompt `nl2dsl-prompt/run9`, `--repair-policy proven-only`, default decoding ([details](#reference-model-and-reference-condition)) |
| **Reference result** | 28/50 correct (one trial; [hardware](#hardware-provenance-and-caveats)) |
| **Runtime that executes queries** | `beingdb-wasm` (BeingDB compiled to WebAssembly), in the browser |
| **Detailed docs** | [docs/benchmarking.md](docs/benchmarking.md), [docs/internals.md](docs/internals.md) |

## What it does

```
question
  -> local WebLLM model    writes a BeingDB DSL query, or replies UNSUPPORTED
  -> BeingDB DSL
  -> beingdb-wasm          validates, applies only repairs it can prove, executes
  -> result rows           straight from BeingDB
```

**The LLM interprets the question; BeingDB determines the answer.** The model
never sees or edits result rows.

**What is tested** is the model's translation step. The task has 50 questions
over the Rewind dataset: 38 answerable and 12 deliberately unsupported.
- An answerable question is correct if BeingDB returns the same answer rows
  for the generated query as for a trusted reference query.
- An unsupported question is correct if the model replies `UNSUPPORTED`.

See [evaluation method](docs/internals.md#evaluation-method). Accuracy is
still far too low for unsupervised use.

Everything runs locally. The only network access is the one-off download of
model weights, which the browser caches.

## Relationship to BeingDB

```
beingdb          core engine: DSL, validation, planner, evaluator, introspection, diagnostics
   |   (runtime source, via symlink)
beingdb-wasm     the same runtime compiled to WASM + the exported Rewind pack (rewind.browser.json)
   |   (release build, via symlink: npm run link)
beingdb-webllm   WebLLM model, prompt, grammar, repair loop, evaluation and benchmark harness
```

Generated queries run in **`beingdb-wasm`** only. That happens in the browser
for the demo and benchmark, and in Node for the model-free checks. No native
`beingdb` server or CLI runs during an experiment.

| You want to… | You need |
|---|---|
| run the demo or benchmark models | `../beingdb-wasm` built with `dune build --profile release` |
| build `beingdb-wasm` | also a `../beingdb` source checkout (its `lib/runtime` is compiled into the WASM) |
| change the engine, introspection or diagnostics | `../beingdb`, then rebuild `beingdb-wasm` |
| change the data or predicate annotations | `../beingdb` (pack store + native build) to re-export `beingdb-wasm/data/rewind.browser.json` ([beingdb-wasm README](../beingdb-wasm/README.md)) |

The exported pack is committed in `beingdb-wasm`, so routine experiments never
rebuild it. If `../beingdb` is present, benchmark reports also record its
commit as provenance. More detail:
[consuming beingdb-wasm](docs/internals.md#consuming-beingdb-wasm).

## Quick start

Requirements:
- Node 22 or later.
- A WebGPU browser with `shader-f16`. The benchmark drives an installed
  Chrome or Edge.
- `../beingdb-wasm`, plus `../beingdb` to build it.

```sh
(cd ../beingdb-wasm && dune build --profile release)   # one .wasm module (+ rewind.browser.json) in _build/default/web
npm install
npm run link     # vendor/beingdb-wasm -> ../beingdb-wasm/_build/default/web; vendor/web-llm -> node_modules
npm run serve    # http://localhost:8010/
```

`npm run link` copies nothing. It refuses a dev build, which has more than one
`.wasm` file. Model-free checks:

```sh
npm test                                                         # schema/prompt/pipeline tests against the linked build
npm run check-eval -- --questions eval/questions-annotated.json  # reference queries + scorer against the linked pack
```

## Run a model interactively

- <http://localhost:8010/>: demo. Load a model, ask a question, and see the
  DSL, BeingDB's verdict, any repairs, timings and the rows.
- <http://localhost:8010/eval.html>: runs the 50 questions in the page and
  saves a report to `eval/results/`.

**The interactive default model is not the reference model.** Both pages
default to `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`, the original small model
(`DEFAULT_MODEL` in `src/generator.js`). Add
`?model=Llama-3.2-3B-Instruct-q4f16_1-MLC` (or any WebLLM id) to change it.
The pages also always use the default `model` repair policy, and `eval.html`
reads `eval/questions.json`. Use them for exploring, and `npm run benchmark`
for comparisons.

## Systematic benchmarking

`npm run benchmark` runs the full evaluation for one model in a real browser
through Playwright, using the same code as the demo. It checks
compatibility, loads the model, runs and scores every question, and writes a
self-describing run directory. Leave the browser window in the foreground:
hidden pages are throttled, and the report flags them. See
`npm run benchmark -- --help` for every option.

**List models**

```sh
npm run models                     # VRAM estimate, f16 requirement, context window; flags models too small for the prompt
npm run models -- --filter qwen
```

**Probe a model** (does it load, fit and generate?) before a full run:

```sh
npm run benchmark -- --probe --model <MODEL-ID> \
  --machine "<MACHINE DESCRIPTION>" --questions eval/questions-annotated.json
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
  --questions eval/questions-annotated.json \
  --repair-policy proven-only \
  --condition annotated-predicates-proven-repairs
```

**Run the reference model** with the same command and
`--model Llama-3.2-3B-Instruct-q4f16_1-MLC`. Do this on every new machine and
after any meaningful change to the pack, prompt, grammar, pipeline or WebLLM
version.

**Several models** in one go: `npm run benchmark:matrix -- --models models/benchmark-models.json`,
with the same options minus `--model`.

The bare form, `npm run benchmark -- --model <MODEL-ID>`, uses the historical
baseline question file. That file is pinned to the pre-annotation pack, so it
stops as `incompatible` with the current `beingdb-wasm`, by design.

## Reference model and reference condition

The **reference model** is `Llama-3.2-3B-Instruct-q4f16_1-MLC`. It is a stable
comparison point, not necessarily the best model.
- Every new model is compared against it under the same condition, ideally on
  the same machine.
- Rerun it whenever the condition changes.

The **reference condition** is everything besides the model and machine. Its
values, as recorded in the current reference run:

| | |
|---|---|
| Questions | `eval/questions-annotated.json` (50 items; sha256 `921ede38…`) |
| Pack | annotated Rewind pack from `beingdb-wasm` d376be1 (fingerprint `sha256:72f26c19…`) |
| Schema context and prompt | declared predicate roles and descriptions; `nl2dsl-prompt/run9` (system prompt sha256 `d33e0c0c…`) |
| Output grammar | generated from the predicate list (sha256 `4c9f1092…`) |
| Repair policy | `proven-only` (`proven-repairs-only/1`) |
| Decoding | defaults: greedy first attempt; repairs at temperature 0.7, seed 1; 200 max tokens; repetition penalty 1; at most 2 model repairs |
| Runtime | WebLLM 0.2.85; `beingdb-webllm` 6119082; `beingdb` dd8c4fe |

**Model comparisons are only meaningful when this condition is kept fixed.**
`--condition` is just a label and changes nothing. The settings that define
the condition are recorded in each `run.json` (`config.nonDefault`,
`config.prompt.sha256`, `config.pipeline`); check them before comparing.
Earlier conditions (baseline, Run 9, Run 10) are listed in
[conditions in the saved results](docs/benchmarking.md#conditions-in-the-saved-results).

**Repair, in brief.** When BeingDB rejects a query, the model can be asked to
repair it. Under `proven-only`, BeingDB first applies its own repairs, but
only rewrites it can prove from the data, such as a uniquely determined
argument swap. These cost no model call. After that, the model is asked to
repair only queries BeingDB still rejects, exactly as under the default
`model` policy. An empty result never triggers a retry. `summary.json`
counts proven repairs and model repairs separately. Proven repairs help some
models more than others, so **keep the repair policy fixed across model
comparisons**. Details:
[repair policies](docs/benchmarking.md#pipeline-conditions-and-cost-metrics).

### Current reference result

| | |
|---|---|
| Run | [`20261009T102014Z_…`](eval/results/benchmarks/20261009T102014Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/) (clean commits) |
| Overall correct | **28/50** |
| Supported correct: first attempt / after repair | 21/38 / **22/38** |
| Valid DSL after repair | 36/38 |
| Unsupported recognised | 6/12 |
| Model calls | 60 (10 model repairs); 5 proven BeingDB repairs |
| Median end-to-end per question | 22.1 s, on a MacBook Air M1 8 GB, Chrome 155, mains power. Machine-specific: the identical earlier run (Run 11) took 28.0 s |

### Models tested so far

All runs are single trials. Under the reference condition:

| Model | Overall | Supported correct | Valid DSL | Unsupported recognised | False refusals |
|---|---|---|---|---|---|
| Llama-3.2-3B-Instruct (reference) | 28/50 | 22/38 | 36/38 | 6/12 | 0 |
| Hermes-3-Llama-3.2-3B | 27/50 | 19/38 | 28/38 | 8/12 | 3 |

Qwen2.5-1.5B, Qwen2.5-3B, Qwen3.5-2B and an earlier Llama-3.2-3B were tested
only under older conditions. Those scores are not comparable with this table.
See the [experiment log](docs/internals.md#experiment-log) and
[`eval/results/benchmarks/`](eval/results/benchmarks/).

## Experimental discipline

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

Each run writes `eval/results/benchmarks/<UTC time>_<machine>_<model>/`:

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

Schemas, metrics and the failure taxonomy are in
[docs/benchmarking.md](docs/benchmarking.md#result-files-and-schema-beingdb-webllm-benchmarkv1).

## Hardware, provenance and caveats

**Hardware so far.** Every saved run was made on one machine: a MacBook Air M1
(`MacBookAir10,1`, 8 GB unified memory, macOS 27), mostly in Chrome 154-155.
That is where the experiments happened to run, not a requirement or a
recommendation. The harness exists to compare models across machines, and runs
on M-series Pro/Max and other WebGPU-capable hardware are expected next. Larger
candidates are listed in [`models/benchmark-models.json`](models/benchmark-models.json).

**Provenance.** Every report records:

- commits and dirty state of `beingdb-webllm`, `beingdb-wasm` and `beingdb`;
- WASM, data and question-suite hashes, and the BeingDB data fingerprint;
- prompt and grammar hashes;
- the WebLLM version;
- machine, OS, RAM, swap, power, browser and WebGPU adapter details;
- all benchmark parameters.

The benchmark deliberately refuses incompatible environments, such as a
question file whose fingerprint does not match the loaded pack, or a software
GPU. See [compatibility checks](docs/benchmarking.md#compatibility-checks-fail-fast).

**Timings are machine-specific.** They depend on GPU, memory and power state,
and on the 8 GB machine heavy swap use inflated them. Compare timings only
under controlled conditions. See
[timing caveats](docs/benchmarking.md#timing-caveats).

## Detailed documentation

- [docs/benchmarking.md](docs/benchmarking.md): harness, compatibility checks,
  question sets and fingerprints, result schema, repair policies and cost
  metrics, conditions in saved results, timing, failure taxonomy, determinism.
- [docs/internals.md](docs/internals.md): execution path, schema context,
  prompt, grammar, validation and repair, evaluation method,
  [experiment log](docs/internals.md#experiment-log), performance and browser
  support.
- [`../beingdb-wasm/README.md`](../beingdb-wasm/README.md): building the WASM
  runtime and exporting the pack.
