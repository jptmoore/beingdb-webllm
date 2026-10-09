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

- `predicates()` returns name, arity, per-position observed types, fact
  counts and example facts, plus any author declarations from the pack:
  `description`, and `role`/`semanticType` per argument (the same JSON as native
  `GET /predicates?detailed=true`). Before `beingdb-wasm` d88657a the browser
  runtime dropped the declarations, so they never reached the prompt.
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
  argument, the declared description (if any) and the first example fact from
  `predicates()`. A role is the one declared in the pack (`role` in
  `predicates()`); for undeclared arguments it is inferred: the class that at
  least 80% of that position's values belong to (`Work`, `Person`), two classes
  for mixed columns (`WorkOrPerson`), `Thing` otherwise, or the literal type
  (`Year`, `Text`, `Number`). Roles are written as variables so the model can
  copy them: `created_by(Work, Artist): Relates a work to the artist or artist
  group who made it.  e.g. created_by(static_acceleration, david_critchley)`.
- **Other predicates** (137 with fewer than 5 facts): names grouped by argument
  shape, e.g. `(Thing, Year): began_in, started_by, ...`. Their declared roles
  and descriptions are not listed here (that would add ~9,400 chars); they
  appear in repair messages, whose signatures carry declared roles and
  descriptions for every predicate.

Change the pack and the context, grammar and signatures change with it. The
`environmentFingerprint` is checked against `eval/questions.json` (or the file
given with `--questions`; `eval/questions-annotated.json` holds the same
questions for the annotated pack's fingerprint).

Print the exact prompt with `node eval/show-prompt.mjs [--grammar]`.

## Prompt

System message: short rules (below) followed by the schema. Then nine example
question/answer pairs as chat turns (six queries, three `UNSUPPORTED`), all
over real Rewind data and checked by `npm run check-eval`; none is an
evaluation question. About 2,520 prompt tokens in total (Llama 3.2 3B tokenizer; 1,940 in prompt run 8, before the pack declared roles and descriptions).

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

### BeingDB-guided repair (`--db-guided-repair`, Run 10)

```
model reply -> BeingDB.diagnose
                 | proven repair -> apply, diagnose again (at most 2 passes; no model call)
                 | invalid       -> errors + diagnostics -> model repair
                 | valid         -> BeingDB.query
                                     | rows, or no rows without proof -> done
                                     | no rows + BeingDB proof        -> model repair (UNSUPPORTED allowed)
```

`src/pipeline.js` holds the loop and `src/prompt.js` the two extra message
forms (`diagnosticRepairMessage`, `emptyResultMessage`). All diagnostic logic
is in BeingDB (`Query_diagnostics`, exposed by beingdb-wasm as
`BeingDB.diagnose`); this layer only decides when to call the model.

- When a proven repair is applied, the conversation shows the model the
  query BeingDB judged.
- UNSUPPORTED stays allowed when BeingDB shows the data cannot hold the
  answer: an unknown constant, a constant not at its argument, or a
  comparison no stored value can satisfy.
- Without the flag, `repairMessage` produces run 9's text byte for byte.
  `test/pipeline.test.mjs` replays Run 9's recorded replies to check this.

Each question record gains `efficiency` (calls, BeingDB time, proven repairs,
diagnostic codes and the path taken), and each attempt gains `guided` (every
diagnose result and repair).

### Proven repairs only (`--repair-policy proven-only`, Run 11)

```
model reply -> BeingDB.diagnose
                 | proven repair -> apply, diagnose again (at most 2 passes; no model call)
              -> run 9's path on the resulting query:
                 BeingDB.query | ok (any number of rows) -> done
                               | invalid -> run 9 repair message -> model repair
```

Run 11 isolates the first of Run 10's two mechanisms. BeingDB's diagnostics
are used only to find proven repairs: they are not shown to the model, and an
empty result is accepted like any other. Where BeingDB proves no repair, the
behaviour is exactly run 9's. `test/pipeline.test.mjs` replays Run 9's
recorded replies to check this, and pins Run 10 by replaying its replies.

The three policies are one option, `--repair-policy model|db-guided|proven-only`
(`ask({ repairPolicy })`); `--db-guided-repair` remains an alias of
`db-guided`, and conflicting options are rejected.

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

These scores measure **query generation** within a bounded repair loop. Two
related things are not measured. **Grounding**: an accepted query returns only
facts in the store, whatever the model intended. **End-to-end RAG behaviour**:
a wider workflow may inspect results, use diagnostics, reformulate, retrieve
again and synthesise an answer.

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
`node eval/show-run.mjs report.json` prints every question, attempt and
BeingDB error of an `eval.html` report.

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

### Later runs (`npm run benchmark`, Chrome 154/155)

Same machine, 50 questions, settings and repair loop, one trial each. From
run 9 on, the model-facing predicate metadata changed: prompt run 9 adds the
pack's declared argument roles and descriptions. Rules, examples and grammar
are unchanged (identical hashes). Runs 10 and 11 change only the repair
policy. The last two rows were run in Chrome 155 on the run-11 code
(`beingdb-webllm` 6119082).

| Prompt | Model | Change | 1st valid | 1st correct | Final valid | Final correct | Unsupported detected | Fabricated |
|---|---|---|---|---|---|---|---|---|
| run 8 | Llama-3.2-3B | as run 8 | 27/38 | 13/38 | 32/38 | 13/38 | 7/12 | 3 |
| run 9 | Llama-3.2-3B | + declared roles and descriptions (main predicates) | 33/38 | 16/38 | 36/38 | 17/38 | 6/12 | 5 |
| run 9 | Llama-3.2-3B | run 9 reproduced on the run-10 code (replies identical) | 33/38 | 16/38 | 36/38 | 17/38 | 6/12 | 5 |
| run 9 | Llama-3.2-3B | **run 10**: + BeingDB-guided repair (`db-guided-repair/1`) | 33/38 | 21/38 | 34/38 | 22/38 | 6/12 | 4 |
| run 9 | Llama-3.2-3B | **run 11**: + proven BeingDB repairs only (`proven-repairs-only/1`) | 33/38 | 21/38 | 36/38 | 22/38 | 6/12 | 5 |
| run 9 | Llama-3.2-3B | run 11 condition rerun (replies identical to run 11) | 33/38 | 21/38 | 36/38 | 22/38 | 6/12 | 5 |
| run 9 | Hermes-3-Llama-3.2-3B | run 11 condition | 26/38 | 18/38 | 28/38 | 19/38 | 8/12 | 3 |

Runs 10 and 11 (and the later proven-only runs) count a question's first
attempt *after* any proven BeingDB repair (still one model call). Run 10 used
78 model calls, Run 11 the same 60 as Run 9; both made 5 proven repairs. See
[Run 10](#run-10-beingdb-guided-repair) and [Run 11](#run-11-proven-beingdb-repairs-only)
below for the cost comparison.

Run `20261006T131109Z`, labelled `annotated-predicates`, is not in the table:
the annotations had not reached the model yet, so it was an exact repeat of the
run-8 baseline. See [Run 9](#run-9-semantic-predicate-metadata).

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

### Default demo model (Qwen2.5-1.5B) and the harness reproduction of run 8

The demo and `eval.html` still default to `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`
(`DEFAULT_MODEL` in `src/generator.js`). It was chosen for an 8 GB M1 MacBook
Air: among WebLLM's 1-3B models it combines a small footprint (869 MB download,
~1.6 GB GPU memory; WebLLM marks it `low_resource_required`) with good
instruction following for its size. Sub-1B models were not tried. The
benchmark experiments have since moved to Llama-3.2-3B as the reference model
(see the [README](../README.md#reference-model-and-reference-condition)).

Run 8 characterised the 1.5B model as follows. It reliably handles
single-predicate lookups, simple year ranges and a negation pattern it has
seen. It often picks the wrong predicate, swaps arguments, writes names as
variables (`Elsa_Stansfield`), and never declines unsupported questions. The
repair loop turned some rejected queries into valid ones but no wrong answer
into a right one. Model load took 30 s the first time (download) and 2.5-9 s
from the cache.

`npm run benchmark` with default settings reproduced run 8 exactly. Every
model reply of every attempt was identical to run 8, in Chrome 154 instead of
VS Code's Chromium 150. That run used the pre-annotation pack (`beingdb-wasm`
41c0d8d) and prompt run 8 (the prompt up to `beingdb-webllm` c15963d):
[`20261001T120717Z_…`](../eval/results/benchmarks/20261001T120717Z_macbook-air-m1-8gb_Qwen2.5-1.5B-Instruct-q4f16_1-MLC/).
The current code uses prompt run 9 with the annotated pack, so it no longer
reproduces these replies.

### Other models with the run-8 prompt (baseline condition)

Same machine, prompt, grammar and repair loop. Run with `npm run benchmark`
and default settings in Chrome 154, one trial each:

| Model | Status | Overall correct | Valid DSL after repair | Unsupported recognised | Model time per call (median) |
|---|---|---|---|---|---|
| Qwen2.5-1.5B-Instruct | complete | 14/50 (28%) | 32/38 (84%) | 0/12 | 8.6 s (9.0 s in run 8) |
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
unclassified 1. The gain over Qwen2.5-1.5B comes from declining unsupported
questions. On supported questions the two are similar (13/38 vs 14/38), and
Llama is about 1.7x slower per call.

**Qwen3.5-2B** (`Qwen3.5-2B-q4f16_1-MLC`, ~2.2 GB GPU memory). This is an
aborted run, not a 0% score. The `--probe` run passed: the model loaded, the
4,096-token context window fits the prompt, and the smoke generation completed
(its reply did not match the example query). The benchmark then produced no
valid BeingDB DSL for any of the 19 questions it completed (`e01`-`e18`,
`m01`). All 57 attempts, including repairs, were rejected as "neither a query
nor UNSUPPORTED" (`syntax_generation`). Every reply began with an empty
`<think></think>` block even though the harness sent `enable_thinking: false`,
and 25 of the 57 replies hit the 200-token limit. The run was aborted when
question `m02` timed out after 600 s.

**Qwen2.5-3B** was only run with the earlier interactive harness (runs 5 and
7 above, before the bounded grammar): 10/50 overall, 6/38 supported correct,
at about twice the 1.5B model's latency.

Caveats recorded in these reports: all four runs (two `--probe`, two
benchmark) warn that the `beingdb-webllm` working tree had uncommitted changes
(the recorded change is `package-lock.json`), so the results do not
correspond exactly to commit `2b1dec9e1b`. Both benchmark runs started with
heavy swap use (7.7 GB for Qwen3.5, 8.6 GB for Llama) that grew during the
run, so memory pressure may have inflated timings. The Qwen3.5 runs were on
battery power. No question ran with the page hidden.

Reports in `eval/results/benchmarks/`: Llama-3.2-3B
[probe](../eval/results/benchmarks/20261005T160554Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[benchmark](../eval/results/benchmarks/20261005T160921Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/);
Qwen3.5-2B
[probe](../eval/results/benchmarks/20261005T152424Z_macbook-air-m1-8gb_Qwen3.5-2B-q4f16_1-MLC/),
[aborted benchmark](../eval/results/benchmarks/20261005T153112Z_macbook-air-m1-8gb_Qwen3.5-2B-q4f16_1-MLC/).

### Run 9: semantic predicate metadata

**What changed.** BeingDB predicate declarations can give a predicate a
natural-language description, argument roles and semantic types, e.g.
`created_by(Work, Artist)`: "Relates a work to the artist or artist group who
made it." They are compiled into the pack with the facts.

- `beingdb-wasm` carries them through the browser runtime. `BeingDB.predicates()`
  returns `description`, plus `role` and `semanticType` for each argument (the
  same JSON as the native `GET /predicates?detailed=true`).
- `beingdb-webllm` uses the declared roles instead of inferred ones, and adds
  the descriptions to the schema context given to the model (see
  [Schema context](#schema-context)).
- The demo, evaluation page, benchmark and repair messages are all built from
  the same schema, so they all receive the annotations.

**Why it matters.** The model no longer has to guess what a predicate means,
or which argument is which, from its name, argument types and one example. The
metadata stays in BeingDB next to the data, not in application-specific prompt
text: load a different annotated pack and the context changes with no code
change.

**Controlled comparison.** Both runs used the same 50 questions
(`eval/questions-annotated.json` is `questions.json` with only the data
fingerprint updated), the same model and settings, and identical rules,
few-shot examples and grammar (same hashes). Only the model-facing predicate
metadata changed: prompt `nl2dsl-prompt/run8` became `run9`. Llama-3.2-3B,
one trial each, Chrome 154:

| | Run 8 baseline | Run 9 annotated predicates |
|---|---|---|
| Overall correct | 20/50 (40%) | 23/50 (46%) |
| Supported correct after repair | 13/38 (~34%) | 17/38 (~45%) |
| Valid DSL after repair | 32/38 | 36/38 |
| Unsupported recognised | 7/12 | 6/12 |
| `wrong_predicate` | 8 | 5 |
| `validation_repair_failed` | 6 | 2 |
| `wrong_projection` | 4 | 2 |

An earlier run labelled `annotated-predicates` (`20261006T131109Z`, 20/50) is
**not** a valid annotation experiment. At that point `beingdb-wasm` dropped the
annotations, so the model received the run-8 prompt byte for byte and gave
identical replies.

**Interpretation.** Overall correctness rose from 40% to 46%, supported-query
correctness from 13/38 to 17/38, wrong-predicate failures fell from 8 to 5 and
queries still invalid after repair from 6 to 2. Unsupported-question
recognition declined slightly (7/12 to 6/12); five unsupported questions got a
valid but meaningless query, against three before. One model, one trial and
50 questions: not statistically conclusive.

**Example: `m02`**, "Which works were created after 1980, and by whom?" In
run 8 the model used only `year_created` and left out `created_by`
(`wrong_predicate`). In run 9 it added `created_by(Work, Artist)` (the
declared role name) but still failed with `wrong_projection` because `Artist`
was missing from `find`. The answer is still wrong, but the metadata changed
which predicates the model chose.

**Prompt size.** Descriptions are included only for the 31 main predicates
(at least 5 facts) to control context size. The other 137 stay in the compact
grouped list, although repair messages show their declared roles and
descriptions.

| | Run 8 | Run 9 |
|---|---|---|
| System prompt | 5,929 chars | 8,718 chars |
| Llama prompt tokens for `m02` | 1,944 | 2,524 |

The model's context window is 4,096 tokens, and repair turns add to the
prompt. Run 9's model time per call was higher, but both runs started with
more than 8 GB of swap in use, which grew during the runs (by 1.9 GB in run 9),
so this is not a reliable performance difference.

```sh
npm run benchmark -- \
  --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "MacBook Air M1 8GB" \
  --questions eval/questions-annotated.json \
  --condition annotated-predicates-run9
```

`node eval/diagnose-annotations.mjs --run <run dir>` checks that a run's
recorded prompt contains the annotations. Reports:
[run 8 baseline](../eval/results/benchmarks/20261005T160921Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[run 9 annotated](../eval/results/benchmarks/20261006T135634Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/)
(clean commits: `beingdb-webllm` d54a43d, `beingdb-wasm` d88657a, `beingdb`
ccccfbc).

### Run 10: BeingDB-guided repair

Principle: **spend BeingDB operations freely, spend model calls sparingly.**
A BeingDB check takes milliseconds; a model call takes about 25 s on this
machine. Run 10 asks whether BeingDB can fix or diagnose a candidate query
between model calls (mechanism:
[BeingDB-guided repair](#beingdb-guided-repair---db-guided-repair-run-10)).

**BeingDB** (`diagnose` action; `BeingDB.diagnose(dsl)` in the browser)
checks a candidate query against the facts and the predicate declarations,
without running it. It reports only what it can establish exactly:

- a constant that occurs in no fact (`unknown_constant`), or not at that
  argument (`constant_not_at_position`, with where it does occur);
- a join between arguments that share no value (`disjoint_join`);
- a `not` block that repeats positive clauses (`contradictory_negation`);
- a named variable used once (`singleton_variable`);
- a variable named after another argument's declared role (`role_name_mismatch`).

It also says whether the query provably returns no rows. It proposes a repair
only when it can prove it:

- swap two arguments when that is the only swap that makes every constant
  match (`performed_at(Venue, kevin_atherton)` -> `performed_at(kevin_atherton, Venue)`);
- replace a singleton variable with the atom its name spells, when that atom
  occurs at exactly that argument (`employed_by(Person, BBC)` -> `bbc`).

The same BeingDB code serves the native server, the REPL, MCP (through
`POST /query`) and the browser; the WASM output equals the native server's.

**Controlled comparison.** The same 50 questions, model, prompt
(`nl2dsl-prompt/run9`, same hashes), grammar, seed and temperatures, on the
same codebase from clean commits, one trial each:

| | Run 9 (reproduced, `model`) | Run 10 (`db-guided`) |
|---|---|---|
| Overall correct | 23/50 (46%) | 28/50 (56%) |
| Supported correct | 17/38 (45%) | 22/38 (58%) |
| Unsupported recognised | 6/12 | 6/12 |
| False refusals / fabricated queries | 0 / 5 | 1 / 4 |
| Model calls (total) | 60 | 78 |
| Model repair calls | 10 | 28 |
| Proven BeingDB repairs | 0 | 5 (all then correct) |
| BeingDB calls | 54 | 130 (76 diagnose) |
| Correct with one model call | 22 | 27 |
| Correct answers per model call | 0.383 | 0.359 |
| Median model time per call | 25.1 s | 26.2 s |
| Median BeingDB time per question | 3.0 ms | 3.7 ms |
| Median time per question | 26.1 s | 28.4 s |
| Correct within 30 s per question | 21 | 26 |

All 50 first replies were identical, so every difference comes from the
repair stage:

| Mechanism | Questions | Extra model calls | Effect |
|---|---|---|---|
| Proven BeingDB repairs | 5 (3 argument swaps, 2 names written as variables) | 0 | +5 correct |
| Model repair after BeingDB proves an empty result | 9 | +17 (15 after the proof, 2 follow-on repairs of invalid replies) | +1 correct (`m10`); 1 false refusal (a question already wrong in Run 9); no unsupported question newly recognised |
| BeingDB diagnostics added to invalid-query repairs | 7 others | +1 | −1 (`m08`, correct in Run 9: a sampled repair went differently) |

**Interpretation.** The proven repairs added 5 correct answers with no extra
model calls, in milliseconds. Asking the model again when BeingDB proves an
empty result did not pay off for this model: 17 more calls bought one correct
answer, so accuracy per model call fell slightly. One model, one trial, 50
questions; timings measured with about 10 GB of swap in use.

```sh
npm run benchmark -- \
  --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "MacBook Air M1 8GB" \
  --questions eval/questions-annotated.json \
  --repair-policy db-guided \
  --condition annotated-predicates-db-guided-run10
```

Reports:
[run 9 reproduced](../eval/results/benchmarks/20261006T162508Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[run 10](../eval/results/benchmarks/20261006T164839Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/)
(clean commits: `beingdb-webllm` 7ad5506 and 17f39ef, `beingdb-wasm` d613e8c,
`beingdb` 7c23845). Run 10 was recorded with `--db-guided-repair`, the alias of
`--repair-policy db-guided`.

### Run 11: proven BeingDB repairs only

Run 10 combined two mechanisms. Run 11 keeps the first (proven repairs) and
drops the second (model retries on proven-empty results and diagnostics in
repair messages), to measure the deterministic repairs on their own
(mechanism: [Proven repairs only](#proven-repairs-only---repair-policy-proven-only-run-11)).
Run 9 was rerun on the Run 11 code; its replies matched the original Run 9 for
all 50 questions. One trial each, clean commits:

| | Run 9 (`model`) | Run 10 (`db-guided`) | Run 11 (`proven-only`) |
|---|---|---|---|
| Overall correct | 23/50 (46%) | 28/50 (56%) | **28/50 (56%)** |
| Supported correct | 17/38 | 22/38 | **22/38** |
| Unsupported recognised | 6/12 | 6/12 | 6/12 |
| False refusals / fabricated | 0 / 5 | 1 / 4 | 0 / 5 |
| Model calls (repairs) | 60 (10) | 78 (28) | **60 (10)** |
| Model calls per supported question | 1.18 | 1.50 | 1.18 |
| Proven BeingDB repairs (then correct) | 0 | 5 (5) | 5 (5) |
| BeingDB calls: diagnose / query | 0 / 54 | 76 / 54 | 59 / 54 |
| BeingDB time, total | 429 ms | 277 ms | 269 ms |
| Correct with one model call | 22 | 27 | 27 |
| **Correct answers per model call** | 0.383 | 0.359 | **0.467** |
| Median model time per call | 24.0 s | 26.2 s | 27.3 s |
| Median time per question | 25.4 s | 28.4 s | 28.0 s |

**Where the gains come from.** Run 11's model replies and repair messages are
byte-identical to Run 9's for all 50 questions. Its only differences from
Run 9 are the 5 questions BeingDB repaired (3 argument swaps, 2 names written
as variables), and all 5 became correct. Run 10 reached the same 28/50 by a
different mix, at 18 more model calls: its empty-result retries fixed `m10`
(still wrong in Runs 9 and 11), and its changed repair text lost `m08`
(correct in Runs 9 and 11).

**Interpretation.** BeingDB-proven repairs improved accuracy without extra
model inference: +5 correct answers (46% to 56%) for 59 extra BeingDB calls
(about 3.9 ms of BeingDB time per question). Run 11 saves 18 model calls (23%)
against Run 10 at equal accuracy. The longer median times in Runs 10 and 11
come from model time per call, not BeingDB; the machine had about 10 GB of
swap in use, and in Run 11 the model produced the same replies as in Run 9.
This suggests the deterministic layer is the valuable part of Run 10, but one
model, one trial and 50 questions are not statistically conclusive. This
condition became the [reference condition](../README.md#reference-model-and-reference-condition).

```sh
npm run benchmark -- \
  --model Llama-3.2-3B-Instruct-q4f16_1-MLC \
  --machine "MacBook Air M1 8GB" \
  --questions eval/questions-annotated.json \
  --repair-policy proven-only \
  --condition annotated-predicates-proven-repairs-run11
```

Reports:
[run 9 reproduced](../eval/results/benchmarks/20261006T174738Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[run 11](../eval/results/benchmarks/20261006T181140Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/)
(clean commits: `beingdb-webllm` 7729741 and e2f50d8, `beingdb-wasm`
d376be1, `beingdb` dd8c4fe).

### Reference-condition runs in Chrome 155 (Llama rerun, Hermes 3)

Both on the run-11 code (clean commits: `beingdb-webllm` 6119082,
`beingdb-wasm` d376be1, `beingdb` dd8c4fe), with the Run 11 settings
(`--questions eval/questions-annotated.json --repair-policy proven-only`) and
identical prompt, grammar and pipeline hashes. One trial each.

| | Llama-3.2-3B-Instruct (rerun) | Hermes-3-Llama-3.2-3B |
|---|---|---|
| Condition label | `annotated-predicates-proven-repairs-llama` | `annotated-predicates-proven-repairs-hermes` |
| Overall correct | 28/50 | 27/50 |
| Supported correct, first attempt / after repair | 21/38 / 22/38 | 18/38 / 19/38 |
| Valid DSL after repair | 36/38 | 28/38 |
| Unsupported recognised | 6/12 | 8/12 |
| False refusals / fabricated | 0 / 5 | 3 / 3 |
| Model calls (repairs) | 60 (10) | 68 (18) |
| Proven BeingDB repairs (then correct) | 5 (5) | 4 (4) |
| Median model time per call | 21.2 s | 20.6 s |
| Median time per question | 22.1 s | 22.0 s |
| Power | mains | battery |
| Swap at start | 8.6 GB | 8.9 GB |

The Llama rerun gave the same replies as Run 11 for all 50 questions; only
the timings differ (22.1 s vs 28.0 s median per question). Hermes declined
more unsupported questions but falsely refused 3 supported ones (`e11`,
`e12`, `m10`) and left 7 queries invalid after repair. Its first attempt
(`20261009T095534Z`) used the default `eval/questions.json` and stopped as
`incompatible` (data fingerprint mismatch with the annotated pack).

Reports:
[Llama rerun](../eval/results/benchmarks/20261009T102014Z_macbook-air-m1-8gb_Llama-3.2-3B-Instruct-q4f16_1-MLC/),
[Hermes 3](../eval/results/benchmarks/20261009T095637Z_macbook-air-m1-8gb_Hermes-3-Llama-3.2-3B-q4f16_1-MLC/).

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

No BeingDB change was needed for the first milestones. Predicate declarations
(descriptions, argument roles, semantic types) were added to BeingDB later and
are used by prompt run 9; carrying them to the browser needed a one-line
`beingdb-wasm` change (`Session.predicates` now uses BeingDB's own
`Query_environment.to_json`). Other things that surfaced and may be worth a
look in BeingDB itself:

- The `environmentFingerprint` covers declarations, so annotating predicates
  changes it even when no fact changes. Question sets pinned to a fingerprint
  then need a new copy (`eval/questions-annotated.json`). That is correct
  for provenance, but a fingerprint was not evidence that the annotations
  reached the model: the runtime dropped them while the fingerprint changed.
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
  worse and twice as slow. Llama-3.2-3B has since been run (20/50 overall, 23/50
  with predicate annotations, 28/50 with proven BeingDB repairs) and is the
  reference model; Hermes-3-Llama-3.2-3B scored 27/50 in the same condition.
  Remaining candidates on WebLLM: Qwen2.5-Coder-3B, Qwen3-1.7B/4B (with
  thinking disabled), Phi-3.5-mini.
- Predicate annotations for more of the schema: descriptions are shown only for
  the 31 main predicates. Describing the other 137 would add about 9,400 chars,
  which is tight in a 4,096-token context. Selecting descriptions relevant to
  the question would need a retrieval step.
- Entity grounding: most constant errors are names the model cannot map to
  atoms. An exact-match lookup of question words against atoms in the pack
  would help, but is a retrieval step and was left out of this milestone.
- Prefix KV caching (not in WebLLM 0.2.85) would cut ~7 s per question.
- MCP is not needed for this: the model calls nothing. It becomes relevant only
  if a larger, remote or agentic model should use BeingDB as a tool.
