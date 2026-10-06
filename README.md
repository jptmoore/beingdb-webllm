# beingdb-webllm

An experiment: can a **small local browser LLM** act as a natural-language
interface to [BeingDB](../beingdb)?

```
question  ->  local WebLLM model  ->  BeingDB DSL  ->  beingdb-wasm  ->  real Rewind results
```

The model only translates the question into a BeingDB query. BeingDB (compiled
to WebAssembly by [beingdb-wasm](../beingdb-wasm)) validates and runs it, and
the rows you see come straight from BeingDB. The model never sees, edits or
summarises the results, and it does not contain or check the Rewind data.

**The LLM interprets language. BeingDB determines the answer.**

## Relationship to the other projects

```
beingdb        database, DSL parser/validator/planner/evaluator
   |
beingdb-wasm   the same runtime in the browser + the Rewind export
   |
beingdb-webllm this repo: WebLLM model + prompt + validation/repair loop + evaluation
```

Nothing from BeingDB is copied or changed here. The app loads the
`beingdb-wasm` release build and data through a symlink and uses its public
browser API (`BeingDB.load`, `BeingDB.query`, `BeingDB.predicates`). No changes
to `beingdb` or `beingdb-wasm` were needed.

## Model

Default: **`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`** (WebLLM 0.2.85 prebuilt).

- 869 MB download (once, cached by the browser); ~1.6 GB GPU memory.
- Chosen for an 8 GB M1 MacBook Air: among WebLLM's 1-3B models it combines a
  small footprint (WebLLM marks it `low_resource_required`) with good
  instruction following and structured output for its size. Sub-1B models were
  not tried; larger ones leave little memory headroom on 8 GB.
- `Qwen2.5-3B-Instruct-q4f16_1-MLC` was also tested; it was twice as slow and
  less accurate on this task (see [Results](#results)).

Any other WebLLM prebuilt model can be tried with `?model=<id>` on either page.

## Requirements

- A browser with **WebGPU** (and `shader-f16` for the default q4f16 model).
- About 2 GB of free memory for the model plus the page.
- Node >= 22 (for the local server and model-free checks) and a
  **release** build of `../beingdb-wasm` (single WASM module, needed by Safari).
- For `npm run benchmark`: Google Chrome, Edge or another Chromium-based browser.

Tested on an 8 GB M1 MacBook Air (macOS 27):

| Browser | BeingDB | Model | Time per question |
|---|---|---|---|
| Chrome 153 / Chromium 150 | yes | yes | ~10 s |
| Safari 27 | yes | yes | ~23 s |
| Firefox 156 | yes | no: WebLLM needs 10 storage buffers per shader stage, Firefox allows 9 | - |

Details: [docs/internals.md](docs/internals.md#browser-support).

## Everything runs locally

Static files + WebLLM + BeingDB WASM + the exported Rewind pack. There is no
remote model API, API key, telemetry, embeddings or vector store, and no
server-side logic (the optional dev server only serves files and saves eval
reports). The only network access is the one-off download of the model weights
(Hugging Face) and WebLLM's model library (GitHub), which the browser caches.

## Run the demo

```sh
cd ../beingdb-wasm && dune build --profile release && cd -
npm install
npm run link          # vendor/ -> ../beingdb-wasm build + WebLLM
npm run serve         # http://localhost:8010/
```

Open <http://localhost:8010/>, click **Load model** (first time only; later
visits load from the browser cache), type a question and press **Ask BeingDB**.
The page shows the generated DSL, whether BeingDB accepted it, any repair
attempts with BeingDB's error messages, model and BeingDB timings, and the raw
BeingDB rows. The full model instructions are shown at the bottom of the page.

Any static server works for the demo (`python3 -m http.server 8010`);
`npm run serve` additionally lets the evaluation page save its report.

## Run the evaluation

Open <http://localhost:8010/eval.html> and press **Run evaluation** (about
10-12 minutes for 50 questions on an M1 Air in Chrome; keep the tab visible). The report is saved to
`eval/results/` (with `npm run serve`) or can be downloaded.

```sh
npm run check-eval                                  # model-free: references, examples, scorer
npm run check-eval -- --questions eval/questions-annotated.json  # same, for the annotated pack's fingerprint
npm test                                            # schema/prompt tests (incl. the linked WASM build)
node eval/diagnose-annotations.mjs [--run <dir>]    # do the pack's predicate declarations reach the prompt?
node eval/check-references.mjs eval/results/X.json  # re-score a saved run with BeingDB in Node
node eval/show-run.mjs eval/results/X.json          # every question, attempt and error
```

The evaluation set ([eval/questions.json](eval/questions.json)) has 50 questions
over the real Rewind predicates: 18 easy, 14 medium and 6 hard supported
questions, each with a trusted reference query, and 12 deliberately
unsupported ones. A generated query counts as correct only if BeingDB returns
the same answer rows for it as for the reference query.

## Reproducible benchmarking

One command runs the full 50-question evaluation for a model in a real browser
(WebGPU + WebLLM, the same code as the pages above) and writes a complete,
machine-readable report. No manual steps: the command starts the server,
launches the browser, loads the model, runs every question, scores it and saves
the results.

```sh
git pull && (cd ../beingdb-wasm && git pull && dune build --profile release)
npm install
npm run link

npm run benchmark -- --model Qwen2.5-1.5B-Instruct-q4f16_1-MLC --machine "MacBook Air M1 8GB"
npm run benchmark -- --model Llama-3.1-8B-Instruct-q4f16_1-MLC --runs 3 --machine "MacBook Pro M4 Max 64GB"
npm run benchmark:matrix -- --models models/benchmark-models.json --machine "MacBook Pro M4 Max 64GB"
npm run compare -- eval/results/benchmarks/<runA> eval/results/benchmarks/<runB>
npm run export-results -- --format csv
```

- **Browser.** Google Chrome by default (`--browser edge|chromium|chrome-canary`
  or `--executable-path`), launched with a visible window. **Leave the window in
  the foreground until the command finishes**: browsers throttle hidden pages,
  and the report flags any question that ran while the page was hidden. Safari
  and Firefox are not automated; test them by hand with `eval.html`.
- **Models.** `npm run models` lists the models in the installed WebLLM
  version with their memory estimates; `npm run models -- --validate
  models/benchmark-models.json` checks a matrix file. Larger models just need a
  machine with enough GPU memory, e.g. `--model Qwen2.5-7B-Instruct-q4f16_1-MLC`.
  Use `--probe` first to check that a model loads and fits without running the
  questions.
- **Fails early.** Before any question the command checks WebGPU, the adapter
  (a software renderer is rejected), `shader-f16`, the WebGPU limits WebLLM
  needs, the model's context window, and that the model loads and generates.
  An unusable model/machine stops with a report saying why (exit code 2).
- **Cache.** Weights download once into a dedicated browser profile
  (`~/.cache/beingdb-webllm/browser-profiles/`) and are reused by later runs;
  keep the default port so the cache is found. `--cold` deletes the model from
  the cache first to measure a real download.
- **Defaults reproduce the experiment** (run 8: greedy first attempt, repairs
  at temperature 0.7 with seed 1, 200 max tokens, 2 repairs, same prompt and
  grammar for every model). Changing `--seed`, `--temperature`, `--max-tokens`,
  `--repair-attempts` etc. is recorded as a non-default condition.
  `--runs N` repeats the evaluation with the model loaded once. `--warmup`
  also compiles the repair grammar beforehand, so no timed call includes
  one-off grammar compilation (the main grammar is always compiled by the
  pre-run smoke check). `npm run benchmark -- --help` lists every option.
- **Machine labels.** The report records what the OS and browser expose (OS,
  CPU, RAM, hardware model, power source, browser version, WebGPU adapter,
  features and limits, `chrome://gpu` status). Browsers hide some details, so
  add your own description with `--machine "..."` (and `--notes`); labels are
  stored separately from what was observed.
- **Provenance.** Git commit and uncommitted changes of `beingdb-webllm`,
  `beingdb-wasm` and `beingdb`, hashes of the WASM build and data, the WebLLM
  version, the question-set suite id (`rewind-nl2dsl-v1`) and its sha256, and
  hashes of the prompt and grammars. A dirty working tree is reported, never
  hidden.
- **Results** go to `eval/results/benchmarks/<time>_<machine>_<model>/`:
  `run.json` (configuration, environment, provenance, model loading),
  `questions.jsonl` (every question and attempt: DSL, BeingDB errors, repair
  messages, model and BeingDB timings, failure category, predicate evidence),
  `summary.json` (accuracy counts, timing medians/means/percentiles, failure
  categories, predicate confusions) and `browser.log`. Schema:
  `beingdb-webllm-benchmark/v1`.
- **Comparing and analysing.** `compare` prints the two runs' accuracy,
  latency and failure categories side by side and lists the questions one got
  right and the other wrong; it also accepts the older `eval/results/run*.json`
  reports. `export-results` writes one CSV/JSONL row per run x question to
  `eval/results/export/` for pandas or R.
- **Caveats.** Timings depend on power mode, thermal state and other load;
  benchmark on mains power with other GPU-heavy apps closed. Replies repeat
  exactly on the same machine and browser, but WebGPU numerics may differ
  between GPUs, drivers and browsers. Failure categories are deterministic
  rules, not ground truth; hand-coded categories can be added in an
  `annotations.jsonl` beside a run without touching the data.

Details (checks, schema, metrics, failure taxonomy): [docs/benchmarking.md](docs/benchmarking.md).

## How it works

1. **Schema from BeingDB.** At startup the app calls `BeingDB.predicates()` and
   a few BeingDB queries, and builds the model context from them: every
   predicate with its arity, argument roles and, for the main predicates, the
   description declared in the pack and a real example fact
   (`created_by(Work, Artist): Relates a work to the artist or artist group who
   made it.  e.g. ...`). Nothing about the dataset is hard-coded.
2. **Prompt.** Short DSL rules, the schema, and nine example questions over the
   real data (as chat turns). About 2,500 tokens (about 2,000 before the pack
   declared roles and descriptions, prompt run 8).
3. **Constrained output.** The model's reply is constrained by a grammar
   generated from the same predicate list: it must be either a DSL query using
   real predicate names with the right number of arguments, or
   `UNSUPPORTED: <reason>`.
4. **Validate and run.** BeingDB validates and executes the query.
5. **Bounded repair.** If BeingDB rejects it, its error messages (with
   suggestions and the relevant predicate signatures) go back to the model, at
   most twice.

Details and the experiment log: [docs/internals.md](docs/internals.md).

## Results

Final configuration, Qwen2.5-1.5B, 50 questions, 8 GB M1 MacBook Air:

| | |
|---|---|
| Valid DSL, first attempt | 29/38 (76%) |
| Correct answer, first attempt | 14/38 (37%) |
| Valid DSL after repair | 32/38 (84%) |
| Correct answer after repair | 14/38 (37%) |
| Unsupported questions recognised | 0/12 (6 got a valid but meaningless query) |
| Overall correct | 14/50 (28%) |
| Model time per call (median) | 9.0 s (about 2,000 prompt tokens at ~250 tokens/s) |
| BeingDB time per query (median / max) | 0.6 ms / 11 ms |
| Model load | 30 s first time (download), 2.5-9 s from cache |

The model reliably handles single-predicate lookups, simple year ranges and a
negation pattern it has seen, but it often picks the wrong predicate, swaps
arguments, writes names as variables (`Elsa_Stansfield`), and never declines
unsupported questions. The repair loop turns some rejected queries into valid
ones but has not yet turned a wrong answer into a right one. Qwen2.5-3B scored
lower (6/38 correct) at twice the latency.

`npm run benchmark` with default settings reproduces this run exactly (every
model reply of every attempt identical to run 8, in Chrome 154 instead of VS
Code's Chromium 150); the report is in
[`eval/results/benchmarks/20261001T120717Z_…`](eval/results/benchmarks/20261001T120717Z_macbook-air-m1-8gb_Qwen2.5-1.5B-Instruct-q4f16_1-MLC/).

### Other models on the M1 Air

Same machine, prompt, grammar and repair loop; the new models were run with
`npm run benchmark` and default settings in Chrome 154, one trial each:

| Model | Status | Overall correct | Valid DSL after repair | Unsupported recognised | Model time per call (median) |
|---|---|---|---|---|---|
| Qwen2.5-1.5B-Instruct (above) | complete | 14/50 (28%) | 32/38 (84%) | 0/12 | 9.0 s |
| Llama-3.2-3B-Instruct | complete | 20/50 (40%) | 32/38 (84%) | 7/12 | 15.1 s |
| Qwen3.5-2B | **aborted** after 19 of 50 questions | not scored | 0/19 completed questions | - | - |

**Llama-3.2-3B-Instruct** (`Llama-3.2-3B-Instruct-q4f16_1-MLC`, ~2.3 GB GPU
memory). First attempt: 27/38 valid DSL, 13/38 correct. After repair: 32/38
valid, 13/38 correct (repair made 5 more queries valid, none correct). It
recognised 7 of the 12 unsupported questions; 3 others got a valid but
meaningless query. Model time per call 15.1 s median (first attempt 15.8 s,
repair 3.5 s); BeingDB 2.4 ms median / 61.6 ms max per query. Failures: wrong
predicate 8, still invalid after repair 6, unsupported not detected 5, wrong
projection 4, wrong constraint 3, wrong argument order 2, entity grounding 1,
unclassified 1. This is currently the strongest completed
M1 result in the repository. The gain over Qwen2.5-1.5B comes from declining
unsupported questions; on supported questions the two are similar (13/38 vs
14/38), and Llama is about 1.7x slower per call. This is a single trial.

**Qwen3.5-2B** (`Qwen3.5-2B-q4f16_1-MLC`, ~2.2 GB GPU memory). This is an
aborted run, not a 0% score. The `--probe` run passed: the model loaded, the
4,096-token context window fits the prompt, and the smoke generation completed
(its reply did not match the example query). The benchmark then produced no
valid BeingDB DSL for any of the 19 questions it completed (`e01`-`e18`,
`m01`): all 57 attempts, including repairs, were rejected as "neither a query
nor UNSUPPORTED" (`syntax_generation`). Every reply began with an empty
`<think></think>` block even though the harness sent `enable_thinking: false`,
and 25 of the 57 replies hit the 200-token limit. The run was aborted when
question `m02` timed out after 600 s.

Caveats recorded in these reports: all four runs (two `--probe`, two
benchmark) warn that the `beingdb-webllm` working tree had uncommitted changes,
so the results do not correspond exactly to commit `2b1dec9e1b` (the recorded
change is `package-lock.json`). Both benchmark runs started with heavy swap use
(7.7 GB for Qwen3.5, 8.6 GB for Llama) that grew during the run, so memory
pressure may have inflated timings. The Qwen3.5 runs were on battery power. No
question ran with the page hidden.

Reports in `eval/results/benchmarks/`: Llama-3.2-3B
[probe](eval/results/benchmarks/20261005T160554Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[benchmark](eval/results/benchmarks/20261005T160921Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/);
Qwen3.5-2B
[probe](eval/results/benchmarks/20261005T152424Z_macbook-air-m1-8gb_Qwen3.5-2B-q4f16_1-MLC/),
[aborted benchmark](eval/results/benchmarks/20261005T153112Z_macbook-air-m1-8gb_Qwen3.5-2B-q4f16_1-MLC/).

## Limitations

- Accuracy is too low for unsupervised use: always read the generated DSL.
  BeingDB guarantees that shown rows are real facts for that query, not that
  the query means what you asked.
- ~11 s per question on an M1 Air, almost all of it prompt prefill; WebLLM
  re-reads the whole prompt for every new question.
- One model, one dataset, 50 questions. The questions were written with
  knowledge of the data, and the examples resemble some question patterns.
- Needs WebGPU. BeingDB itself runs in any browser `beingdb-wasm` supports.
