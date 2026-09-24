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
node eval/check-references.mjs eval/results/X.json  # re-score a saved run with BeingDB in Node
node eval/show-run.mjs eval/results/X.json          # every question, attempt and error
```

The evaluation set ([eval/questions.json](eval/questions.json)) has 50 questions
over the real Rewind predicates: 18 easy, 14 medium and 6 hard supported
questions, each with a trusted reference query, and 12 deliberately
unsupported ones. A generated query counts as correct only if BeingDB returns
the same answer rows for it as for the reference query.

## How it works

1. **Schema from BeingDB.** At startup the app calls `BeingDB.predicates()` and
   a few BeingDB queries, and builds the model context from them: every
   predicate with its arity, argument roles (`created_by(Work, Person)`) and a
   real example fact. Nothing about the dataset is hard-coded.
2. **Prompt.** Short DSL rules, the schema, and nine example questions over the
   real data (as chat turns). About 2,000 tokens.
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

## Limitations

- Accuracy is too low for unsupervised use: always read the generated DSL.
  BeingDB guarantees that shown rows are real facts for that query, not that
  the query means what you asked.
- ~11 s per question on an M1 Air, almost all of it prompt prefill; WebLLM
  re-reads the whole prompt for every new question.
- One model, one dataset, 50 questions. The questions were written with
  knowledge of the data, and the examples resemble some question patterns.
- Needs WebGPU. BeingDB itself runs in any browser `beingdb-wasm` supports.
