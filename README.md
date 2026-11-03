# beingdb-webllm

**A chatbot that answers questions from [BeingDB](https://github.com/jptmoore/beingdb)
facts, entirely in your browser.** A local language model
([WebLLM](https://github.com/mlc-ai/web-llm)) turns the question into a
BeingDB query; BeingDB ([beingdb-wasm](https://github.com/jptmoore/beingdb-wasm))
checks it, applies any repair it can prove, and answers from the facts.

```
question
  -> local model        writes a BeingDB query, or replies UNSUPPORTED
  -> BeingDB (WASM)     validates, applies repairs it can prove, executes
  -> answer rows        straight from BeingDB
```

**The model interprets the question; BeingDB determines the answer.** The
model never sees or alters the result rows, so every row shown is a fact in
the store. Nothing leaves the browser: the only network access is the one-off
download of the model weights, which the browser caches.

It currently runs over the [REWIND interviews](https://github.com/jptmoore/beingdb-rewind-interviews)
facts bundled with beingdb-wasm.

## Try it

**<https://jptmoore.github.io/beingdb-webllm/>**: nothing to install. You
need a browser with WebGPU and `shader-f16` (current Chrome or Edge on a
desktop or laptop), and about 2 GB of disk and GPU memory: the first
**Load model** downloads the model once, and the browser caches it.

## Run it locally

You need Node 22 or later, a browser with WebGPU and `shader-f16` (current
Chrome or Edge), and about 2 GB of disk and GPU memory for the default model.

```sh
git clone https://github.com/jptmoore/beingdb-wasm.git ../beingdb-wasm   # runtime and data; nothing to build
npm install
npm run link     # link beingdb-wasm's prebuilt runtime and data, and WebLLM, into vendor/
npm run serve    # http://localhost:8010/
```

Open <http://localhost:8010/>, click **Load model**, and ask a question or
pick a sample. The page shows the query the model wrote, BeingDB's verdict,
any repairs, timings and the rows.

`npm run build:site` builds the same page as a static site in `dist/site/`,
which [.github/workflows/pages.yml](.github/workflows/pages.yml) publishes
to GitHub Pages on every push to `main`.

The default model is `Llama-3.2-3B-Instruct-q4f16_1-MLC`, the best-measured
model so far (see [benchmarking](docs/benchmarking.md#reference-model-and-reference-condition)).
Choose another with `?model=<WebLLM id>`, for example
`?model=Qwen2.5-1.5B-Instruct-q4f16_1-MLC` on machines with less memory;
`npm run models` lists the available ids.

## How it works

The chatbot is a few small modules in [src/](src/):

| Module | Role |
|---|---|
| `beingdb.js` | loads the BeingDB WASM runtime and the facts |
| `schema.js` | describes the available predicates to the model, from BeingDB's `predicates()`: names, argument roles, types, descriptions and examples |
| `prompt.js` | rules, schema and worked examples; parses the model's reply |
| `grammar.js` | a grammar built from the predicate list, so the model can only write well-formed queries over real predicates |
| `generator.js` | the WebLLM model (the only model-specific module) |
| `pipeline.js` | `ask()`: model -> BeingDB -> bounded repair loop |
| `app.js` | the page |

When BeingDB rejects a query, it first applies any repair it can prove from
the data (for example a uniquely determined argument swap), without a model
call. If the query is still invalid, the model gets BeingDB's error and tries
again, at most twice. An empty result is shown as is, with BeingDB's
explanation, rather than retried.

## Make it better

The quality of the chatbot depends on the model, the prompt, the schema
context (the predicate declarations in your facts help a lot), the grammar
and the repair loop. To change one and measure the effect, use the benchmark
in [eval/](eval/): 63 REWIND questions with reference answers, run in a real
browser, scored by comparing BeingDB's answers.

```sh
npm test                                                   # model-free checks
npm run benchmark -- --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "<your machine>" --questions eval/questions-v2.json --repair-policy proven-only
```

The default model currently turns 31 of the 63 questions into the right query
(26/51 answerable, 5/12 unsupported recognised). See
[docs/benchmarking.md](docs/benchmarking.md) for running and comparing
benchmarks, the reference condition, results and the result format.

## Working on BeingDB itself

`npm run link` uses beingdb-wasm's committed runtime and data, so no OCaml is
needed. To try a change to BeingDB, build beingdb-wasm from source
(`dune build --profile release` there) and run `npm run link -- --build`. To
change the data or its predicate declarations, see
[the bundled REWIND dataset](https://github.com/jptmoore/beingdb-wasm#the-bundled-rewind-dataset).

## Layout

```
index.html, src/     the chatbot
scripts/             link, serve
test/                chatbot tests
eval/                the benchmark: questions, pages, scorer, scripts, saved results
docs/                benchmarking and internals
```

## Documentation

- [docs/benchmarking.md](docs/benchmarking.md): running and comparing
  benchmarks, the reference condition and results, result files, failure
  categories.
- [docs/internals.md](docs/internals.md): execution path, schema context,
  prompt, grammar, validation and repair, evaluation method, experiment log,
  performance and browser support.

## License

[MIT](LICENSE)
