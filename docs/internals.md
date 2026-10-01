# beingdb-webllm internals

Technical notes and the experiment log. See the [README](../README.md) for usage.

## Execution path

```
index.html / eval.html
  src/beingdb.js    loads vendor/beingdb-wasm/main.bc.wasm.js + rewind.browser.json -> BeingDB.load
  src/schema.js     BeingDB.predicates() + BeingDB queries -> schema text, signatures
  src/grammar.js    BeingDB.predicates() -> xgrammar EBNF for the reply
  src/prompt.js     rules + schema + few-shot turns; parse reply; repair message
  src/generator.js  WebLLM engine (the only model-specific module)
  src/pipeline.js   ask(): generate -> BeingDB.query -> bounded repair
  src/score.js      compare BeingDB results of generated vs reference queries
```

`pipeline.ask()` only needs `generator.complete(messages, format, {temperature})`,
so another WebLLM model is a URL parameter (`?model=`), and another runtime would
be a new `generator.js`. BeingDB integration does not depend on the model.

`benchmark.html` (driven by `npm run benchmark`) uses the same modules plus
`src/analysis.js`; see [benchmarking.md](benchmarking.md).

## Consuming beingdb-wasm

`npm run link` creates two symlinks (nothing is copied):

- `vendor/beingdb-wasm -> ../../beingdb-wasm/_build/default/web` (release build:
  `main.bc.wasm.js`, one `.wasm` module, `rewind.browser.json`). The script
  refuses a dev build (more than one `.wasm`), which Safari cannot load.
- `vendor/web-llm -> ../node_modules/@mlc-ai/web-llm/lib` (self-contained ES module).

The browser API used is exactly the one `beingdb-wasm` documents:
`window.onBeingDBReady`, `BeingDB.load(text)`, `BeingDB.query(dsl)`,
`BeingDB.predicates()`. It was sufficient:

- `predicates()` already returns name, arity, per-position observed types, fact
  counts and example facts (the same shape as native `GET /predicates?detailed=true`).
- There is no separate validate call, and none is needed: `query()` returns
  `{"valid": false, "errors": [...]}` (with codes, line numbers and, for unknown
  predicates, ranked suggestions) before executing anything, and executing a
  valid Rewind query takes about a millisecond.

The Node tools (`eval/node-beingdb.mjs`) load the same symlinked build. The
wasm_of_ocaml loader looks for its assets next to `require.main`, so the ESM
loader sets `process.mainModule` to the loader's path first.

## Schema context

Built at startup from BeingDB only (about 10-30 ms in the browser):

- **Classes**: unary atom predicates with at least 20 facts (`person`, `work`,
  `venue`, `organisation`, `exhibition`), with their members fetched by query.
- **Main predicates** (at least 5 facts, 31 of 168): name, a role name per
  argument, and the first example fact from `predicates()`. A role is the
  class that at least 80% of that position's values belong to (`Work`,
  `Person`), two classes for mixed columns (`WorkOrPerson`), `Thing` otherwise,
  or the literal type (`Year`, `Text`, `Number`). Roles are written as
  variables so the model can copy them: `created_by(Work, Person)  e.g.
  created_by(static_acceleration, david_critchley)`.
- **Other predicates** (137 with fewer than 5 facts): names grouped by argument
  shape, e.g. `(Thing, Year): began_in, started_by, ...`.

Change the pack and the context, grammar and signatures change with it. The
`environmentFingerprint` is checked against `eval/questions.json`.

Print the exact prompt with `node eval/show-prompt.mjs [--grammar]`.

## Prompt

System message: short rules (below) followed by the schema. Then nine example
question/answer pairs as chat turns (six queries, three `UNSUPPORTED`), all
over real Rewind data and checked by `npm run check-eval`; none is an
evaluation question. About 1,970 prompt tokens in total.

```
You translate questions about a BeingDB database into BeingDB queries.
BeingDB runs your query and returns the answer, so never answer from your own knowledge.
Reply with only the query. If the predicates below cannot answer the question, reply UNSUPPORTED: <reason>.

Query format:
find Var1, Var2
where
  predicate(Var1, Var2)
  Var2 > @1980

- One clause per line: a predicate from the list, or a comparison of a variable.
- Capitalised words are variables. Names of people, works, places and organisations are lowercase atoms: Peter Donebauer -> peter_donebauer, the Tate -> tate.
- Keep each predicate's argument order: the roles show what goes where, e.g. created_by(Work, Person).
- Use the same variable in two clauses to join them. Every find variable must be used in a clause.
- Years are written @1979. Comparisons: =, !=, <, <=, >, >=, Y between @1975 and @1980.
- "not" on its own line, followed by indented clauses, excludes matches. "optional" keeps rows with no match.
- "order by Var ascending" only when the question asks for an order.
- Queries cannot count, sum, average or rank: such questions are unsupported.
```

Generation: temperature 0 for the first attempt, `repetition_penalty` 1.0 (the
model default of 1.1 penalises repeating variable names, which every join needs).

## Structured output: a grammar from the predicate list

The reply is constrained with WebLLM's `response_format: {type: "grammar"}`
(xgrammar EBNF) generated from `BeingDB.predicates()`:

```
root ::= query | unsupported
unsupported ::= "UNSUPPORTED: " [^\n]{1,200}
query ::= "find " ("distinct ")? var (", " var){0,5} "\nwhere" line{1,8} block{0,3} tail
line ::= "\n  " clause
clause ::= pattern | var " " op " " value | var " between " value " and " value
pattern ::= "created_by(" (var | "_" | atom) ", " (var | "_" | atom) ")" | ... (all 168)
```

It guarantees the surface shape: one clause per line, real predicate names,
correct arity, literal syntax per observed argument type (`@1979` where a
column holds years). It checks nothing semantic: binding, joins, connectivity,
types of comparisons, and whether the query answers the question are left to
BeingDB and the evaluation. Lines are newline-separated rather than terminated,
so the model can stop after its last clause (with terminated lines it kept
appending `order by` clauses until the token limit). Clause counts and name
lengths are bounded (longest Rewind atom: 61 characters) because the model
sometimes repeats a clause until `max_tokens`; the bounds cut those cases from
~40 s to ~15-23 s without changing any answer (run 8 vs run 6).

JSON output (`{"status","dsl","reason"}` with a JSON schema) was tried first
(runs 1-2): the DSL inside a JSON string was often malformed (`and` lines,
quoted names, `order by year_created(Work)`), and the model often switched to
`"unsupported"` after an error.

## Validation and repair

```
question -> model -> DSL -> BeingDB.query
                              | ok      -> results (done)
                              | invalid -> BeingDB errors -> model (at most 2 repairs)
```

The repair message contains BeingDB's error messages (with line numbers), a
one-line reminder of the rule behind each error code, and the signatures of
predicates BeingDB mentions or suggests. If none of the errors is
`unknown_predicate`, every predicate used exists, so the repair call uses a
grammar without the `UNSUPPORTED` branch and asks for a fix. Repairs sample at
temperature 0.7 (seed 1, so runs are repeatable): at temperature 0 the model
usually repeated the rejected query verbatim.

Repairs continue the same conversation, so WebLLM reuses the KV cache and
only prefills the ~55 new tokens: a repair costs about 2 s versus 9 s for a new
question.

## Evaluation method

`eval/questions.json`: 50 questions. Each supported item has a reference query
(checked by `npm run check-eval` to be valid, non-empty, and to return the
recorded number of rows), the predicates it needs, tags, and optionally `key`
(the reference variables that form the answer; others may be omitted) and
`orderBy`.

A generated query is **correct** if BeingDB's distinct result rows, projected
onto some choice of its columns, equal the reference's distinct rows on the
key columns. Variable names, column order, extra columns and `distinct` do not
matter; values and types do. With `orderBy`, the generated rows must also be in
the reference order on that column. Syntactically valid but wrong queries fail.

Failures are classified automatically: refused, invalid (BeingDB error codes),
wrong predicate (a required predicate missing), argument order (swapping the
arguments of one pattern makes it correct, checked by re-running it through
BeingDB), constant/bound (a reference constant or number missing, e.g.
`Elsa_Stansfield` written as a variable), missing output variable, ordering,
or other.

For unsupported items, correct means the final reply is `UNSUPPORTED`. A valid
query for an unsupported question is counted as "fabricated" (BeingDB shows
real rows, but for a question that was not asked).

Scoring runs in the browser and, from a saved report, in Node against the same
WASM build (`node eval/check-references.mjs report.json`); both agree.

## Experiment log

All runs: 50 questions, 8 GB M1 MacBook Air, VS Code's integrated Chromium 150,
max 2 repairs. Reports for runs 2-8 are in `eval/results/` (run 1 predates saving).

| Run | Model | Change | 1st valid | 1st correct | Final valid | Final correct | Unsupported detected | Fabricated |
|---|---|---|---|---|---|---|---|---|
| 1 | Qwen2.5-1.5B | JSON schema; examples inside the system prompt | 11/38 | 6/38 | 11/38 | 6/38 | 10/12 | 2 |
| 2 | Qwen2.5-1.5B | + fix-only repair schema, clearer rules | 12/38 | 4/38 | 12/38 | 4/38 | 2/12 | 0 |
| 3 | Qwen2.5-1.5B | grammar from predicates; roles as variables; examples as chat turns | 24/38 | 10/38 | 30/38 | 11/38 | 0/12 | 4 |
| 4 | Qwen2.5-1.5B | + 2 unsupported examples; sampled repairs | 22/38 | 10/38 | 29/38 | 10/38 | 0/12 | 5 |
| 5 | Qwen2.5-3B | as run 4 | 14/38 | 6/38 | 22/38 | 6/38 | 4/12 | 7 |
| 6 | Qwen2.5-1.5B | + repetition_penalty 1.0 | 29/38 | 14/38 | 32/38 | 14/38 | 0/12 | 6 |
| 7 | Qwen2.5-3B | as run 6 | 15/38 | 5/38 | 23/38 | 6/38 | 4/12 | 6 |
| **8** | **Qwen2.5-1.5B** | **+ bounded grammar (final)** | **29/38** | **14/38** | **32/38** | **14/38** | **0/12** | **6** |

Run 1's 10/12 unsupported came with 27 false refusals of supported questions
(after a repair the model almost always switched to "unsupported"), so it is
not a real detection rate.

Side experiments (a few questions each, not in the table): a 7-predicate
prompt, rules without the schema, JSON vs free text vs grammar, and
`Qwen2.5-1.5B-Instruct-q4f32_1` (to rule out f16 precision) all produced the
same kinds of error. A needle-in-a-haystack check at 2,600 tokens passed, so
long-context attention works.

Generation is deterministic (greedy first attempt, seeded repairs): run 8 gave
the same replies as run 6 for every question, and the Chrome smoke test the
same replies as the integrated browser.

### Final run (run 8) in detail

By tag (first attempt / after repair, correct answers):

| Tag | n | First | Final |
|---|---|---|---|
| easy | 18 | 8 | 8 |
| medium | 14 | 4 | 4 |
| hard | 6 | 2 | 2 |
| constant | 26 | 10 | 10 |
| join | 14 | 3 | 3 |
| range | 6 | 4 | 4 |
| order | 2 | 0 | 0 |
| negation | 2 | 2 | 2 |
| optional / self-join / disjunction | 1 each | 0 | 0 |

Other measures: required predicates present in 22/38 final queries; every
correct query had exactly the reference's answer columns (14/14); no supported
question was refused.

Failures (24 supported, 12 unsupported):

| Category | Count | Example |
|---|---|---|
| wrong predicate | 10 | "Which artists were interviewed?" -> `interviewee(rewind, InterviewedArtist)` |
| invalid after 2 repairs | 6 | `find Person` with `funded_by(organisation, peter_donebauer)` (Person unbound, every time) |
| constant/bound | 5 | `educated_at(Person, Elsa_Stansfield)`: name as a variable, and the wrong argument |
| argument order | 2 | `influenced_by(Person, peter_donebauer)` instead of `influenced_by(peter_donebauer, X)` |
| other | 1 | `created_by(work, Person)`: lowercase `work` is an atom, so 0 rows |
| unsupported, invalid query | 6 | "What is the capital of France?" -> queries over `named_by_competition` |
| unsupported, fabricated | 6 | "How many works did George Barber create?" -> lists his 18 works |

Representative successes (first attempt, no repair):

```
Which works were created in 1979?
find Work
where
  year_created(Work, @1979)

Which works were created after 1980, and by whom?
find Work, Person
where
  year_created(Work, Year)
  Year > @1980
  created_by(Work, Person)

Which works by Elsa Stansfield were created in the 1980s?
find Work
where
  created_by(Work, elsa_stansfield)
  year_created(Work, Year)
  Year between @1980 and @1989

Which interviewed artists were not funded by the Arts Council?
find InterviewedArtist
where
  interviewed_artist(InterviewedArtist)
  not
    funded_by(InterviewedArtist, arts_council)
```

Repair: BeingDB's feedback made 3 more queries valid (7-8 in other runs) but
has not produced a correct answer in the final configuration (1 in runs 3 and
7). The model fixes the reported symptom (e.g. drops the unbound `order by`)
rather than the underlying mistake, or repeats the rejected query.

## Performance (8 GB M1 MacBook Air)

| | Qwen2.5-1.5B | Qwen2.5-3B |
|---|---|---|
| Download | 869 MB (30 shards) | 1,736 MB (62 shards) |
| WebLLM VRAM estimate | 1,630 MB | 2,505 MB |
| First load (download + compile) | 29.5 s | 74 s |
| Load from browser cache | 2.5-6 s | 14-17 s |
| Prompt | ~1,970 tokens | same |
| Prefill | ~240-280 tokens/s | ~135 tokens/s |
| Time to first token | ~7.5-8.3 s | ~14.5 s |
| Decode (grammar-constrained) | ~11 tokens/s | ~8 tokens/s |
| First attempt, median | 10.4 s | 18-19.5 s |
| Repair attempt, median (KV reused, ~55 new tokens) | 2.2 s | 4.1 s |
| Any model call: median / p90 | 9.0 s / 12.2 s | 16.2 s / 20.4 s |
| Question to result, median | 11.0 s | 20.5 s |
| One-off grammar compile (first question per page) | ~10 s | ~10 s |

BeingDB, same runs: `load` 15-40 ms, schema context 10-35 ms, generated
queries 0.6 ms median, 4 ms p90, 11 ms max (53 ms for one heavy 3B query).
BeingDB is under 0.01% of question-to-result time.

Memory: with the 1.5B model loaded the page's JS heap stayed at 25-70 MB (the
model lives in GPU memory). System-wide wired memory was about 3.3 GB during
inference, with other applications open and 23% of memory free; there was no
failure or visible slowdown from memory pressure with either model. Unloading
the model (`?unload=1` on the eval page) releases it.

Prefill dominates: WebLLM has no prefix cache across independent requests, so
every new question re-reads the ~2,000-token system prompt and examples.

## Browser support

BeingDB WASM compatibility is unchanged from `beingdb-wasm` (release build):
it loaded and answered in every browser below. The model needs WebGPU.
Results on the 8 GB M1 Air, final code, 10-question smoke test
(`eval/results/smoke-*.json`; a compatibility and determinism check, not an
accuracy measure: 8 of the 10 are questions the model gets right):

| Browser | Model runs | Replies | First attempt, median | Prefill / decode | Notes |
|---|---|---|---|---|---|
| VS Code integrated Chromium 150 | yes | reference | 10.4 s | ~240 / 11 tok/s | all full runs |
| Chrome 153 | yes | identical | 9.2 s | ~270 / 11 tok/s | |
| Safari 27 | yes | identical | 22.9 s | ~100 / 8 tok/s | 2.3x slower than Chromium |
| Firefox 156 | **no** | - | - | - | WebLLM: `maxStorageBuffersPerShaderStage` requested 10, limit 9; BeingDB `load` 532 ms |

The page reports WebGPU/model failures and keeps BeingDB usable (the DSL can
still be run by hand in `beingdb-wasm`'s own demo). Chrome and Safari throttle
background windows heavily; keep the evaluation tab visible.

## Observations about BeingDB

No BeingDB change was needed. Two things surfaced that may be worth a look in
BeingDB itself:

- `Y = 1979` against a year-typed argument silently returns no rows (integer
  vs year equality is false), while `Y >= 1970` and `Y between 1975 and 1980`
  work through integer-to-year promotion. Validation does not flag the
  equality case. The prompt therefore always uses `@1979`.
- The model often writes names as capitalised variables (`Elsa_Stansfield`). A
  variable that occurs only once is valid but usually a mistake; a
  `singleton_variable` warning from BeingDB would give the repair loop
  something to act on.
- The benchmark's grounding evidence shows a second silent case: an atom that
  never occurs at that argument position (`created_by(work, P)`,
  `soundtrack_by(Work, cultural_quarter)` where `cultural_quarter` only occurs
  as the first argument) is valid and returns 0 rows. An "atom not found at this
  position" warning, with the positions where it does occur, would expose both
  reversed arguments and role names written as atoms. Not implemented: the
  benchmark first measures whether these failures persist in larger models.

## What would help next

- A different model family first, rather than a bigger Qwen: the 3B model was
  worse and twice as slow. Candidates on WebLLM: Llama-3.2-3B, Qwen2.5-Coder-3B,
  Qwen3-1.7B/4B (with thinking disabled), Phi-3.5-mini.
- Entity grounding: most constant errors are names the model cannot map to
  atoms. An exact-match lookup of question words against atoms in the pack
  would help, but is a retrieval step and was left out of this milestone.
- Prefix KV caching (not in WebLLM 0.2.85) would cut ~7 s per question.
- MCP is not needed for this: the model calls nothing. It becomes relevant only
  if a larger, remote or agentic model should use BeingDB as a tool.
