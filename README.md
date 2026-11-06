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
  -> local model        writes a short answer from the rows (checked, chatbot only)
```

**The model interprets the question; BeingDB determines the answer.** The
rows come only from BeingDB, so every row is a fact in the store. The chatbot
then asks the model to phrase them as a sentence, and checks it: a sentence
that leaves out a name (for complete results), adds a name or number that is
in neither the rows, the question nor the query, or answers a query that
ignores a name from the question, is discarded in favour of the plain list.
The exact rows are always one click away (**Show the facts**). The benchmark
scores the query and its rows only.

Nothing leaves the browser: the only network access is the one-off
download of the model weights, which the browser caches.

It currently runs over the [REWIND interviews](https://github.com/jptmoore/beingdb-rewind-interviews)
facts bundled with beingdb-wasm.

## Try it

**<https://jptmoore.github.io/beingdb-webllm/>**: nothing to install. You
need a browser with WebGPU and `shader-f16` (current Chrome or Edge on a
desktop or laptop), and about 2 GB of disk and GPU memory: the first
**Start the chatbot** downloads the model once, and the browser caches it.

## Run it locally

You need Node 22 or later, a browser with WebGPU and `shader-f16` (current
Chrome or Edge), and about 2 GB of disk and GPU memory for the default model.

```sh
git clone https://github.com/jptmoore/beingdb-wasm.git ../beingdb-wasm   # runtime and data; nothing to build
npm install
npm run link     # link beingdb-wasm's prebuilt runtime and data, and WebLLM, into vendor/
npm run serve    # http://localhost:8010/
```

Open <http://localhost:8010/>, click **Start the chatbot**, and ask a question
or pick a suggestion. The page is the **Rewind interview chatbot**: answers
appear as plain chat replies. Open the ☰ menu to see the status, the model
instructions and the log, and turn on **Show technical details on answers**
to see, under each answer, the query the model wrote, BeingDB's verdict, any
repairs, timings and the raw rows.

`npm run build:site` builds the same page as a static site in `dist/site/`,
which [.github/workflows/pages.yml](.github/workflows/pages.yml) publishes
to GitHub Pages on every push to `main`.

The default model is `Llama-3.2-3B-Instruct-q4f16_1-MLC`, which is also the
reference model for evaluating changes (see
[benchmarking](docs/benchmarking.md#reference-model-and-reference-condition)).
The ☰ menu's **Language model** picker switches to Meta Llama 3.1 8B Instruct,
Google Gemma 2 2B IT or Microsoft Phi-4 Mini Instruct (the list is
`CHAT_MODELS` in [src/setup.js](src/setup.js)); the page remembers the choice.
Any other WebLLM model can be chosen
with `?model=<WebLLM id>`, which takes precedence over the picker, for example
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
| `guard.js` | before the search, a short model call checks the message is a question about the facts (gibberish, greetings and unrelated questions get a quick reply); after it, a check that the search only names things the question mentions |
| `answer.js` | the chatbot's written answer: a second model call phrases the rows (up to 20; larger results are summarised), then a check against the rows, question and query decides whether to show it |
| `app.js`, `chat.css` | the chat page (the eval pages share `style.css`) |

When BeingDB rejects a query, it first applies any repair it can prove from
the data (for example a uniquely determined argument swap), without a model
call. If the query is still invalid, the model gets BeingDB's error and tries
again, at most twice. An empty result is shown as is, with BeingDB's
explanation, rather than retried.

## Make it better

The quality of the chatbot depends on the model, the prompt, the schema
context (the predicate declarations in your facts help a lot), the grammar
and the repair loop. To change one and measure the effect, use the benchmark
in [eval/](eval/): 66 REWIND questions with reference answers, run in a real
browser, scored by comparing BeingDB's answers.

```sh
npm test                                                   # model-free checks
npm run benchmark -- --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "<your machine>" --questions eval/questions-v3.json --repair-policy proven-only
```

Run the reference model before and after your change, on the same machine,
and compare the two runs (`npm run compare`). Results stay on your machine in
`eval/results/`; they are not tracked in git, because they depend on the
machine, browser and WebLLM version. See
[docs/benchmarking.md](docs/benchmarking.md) for running and comparing
benchmarks, the reference condition and the result format.

## Keeping up with WebLLM

WebLLM is an ordinary npm dependency. Dependabot opens a pull request for each
new release, and the Pages workflow tests and builds it. By hand:
`npm update @mlc-ai/web-llm && npm test`; the tests check that the default
model still exists in the new release.

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
eval/                the benchmark: questions, pages, scorer, scripts (results go to eval/results/, untracked)
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
