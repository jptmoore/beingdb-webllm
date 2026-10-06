// node --test: the question pipeline, with scripted model replies over the linked beingdb-wasm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ask, MAX_DETERMINISTIC_PASSES } from "../src/pipeline.js";
import { buildSchema } from "../src/schema.js";
import { buildPrompt } from "../src/prompt.js";
import { loadBeingDB } from "../eval/node-beingdb.mjs";

const { db } = await loadBeingDB();
const schema = buildSchema(db);
const prompt = buildPrompt(schema);

// A generator that replays fixed replies and records every request.
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async complete(messages, format, { temperature }) {
      calls.push({ messages: messages.map((m) => ({ ...m })), grammar: format === prompt.format ? "query_or_unsupported" : "query_only", temperature });
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { text, ms: 1000, usage: null, finish: "stop", request: { temperature } };
    },
  };
}

// Counts the BeingDB calls the pipeline makes.
function counting(inner = db) {
  const n = { query: 0, diagnose: 0 };
  return {
    n,
    ...inner,
    query: (dsl) => (n.query++, inner.query(dsl)),
    diagnose: (dsl) => (n.diagnose++, inner.diagnose(dsl)),
  };
}

const run = (replies, { db: inner, ...opts } = {}) => {
  const generator = scripted(replies);
  const cdb = counting(inner);
  return ask({ question: "q", generator, db: cdb, schema, prompt, ...opts }).then((r) => ({ r, generator, n: cdb.n }));
};

test("a correct candidate costs one model call in both conditions", async () => {
  const q = "find Work\nwhere\n  made_at(Work, oval_house)";
  for (const dbGuided of [false, true]) {
    const { r, n } = await run([q], { dbGuided });
    assert.equal(r.outcome, "ok");
    assert.equal(r.calls.model, 1);
    assert.equal(r.calls.modelRepair, 0);
    assert.equal(r.calls.deterministicRepairs, 0);
    assert.equal(r.attempts[0].reply.dsl, q);
    assert.deepEqual(n, dbGuided ? { query: 1, diagnose: 1 } : { query: 1, diagnose: 0 });
    assert.deepEqual(r.path, dbGuided ? ["model", "diagnose", "execute"] : ["model", "query"]);
  }
});

test("a proven argument swap is applied without a model repair", async () => {
  const q = "find Work\nwhere\n  created_by(david_critchley, Work)";
  const off = await run([q]);
  assert.equal(off.r.attempts[0].db.response.count, 0, "run 9 accepts the empty result");
  const { r, generator } = await run([q], { dbGuided: true });
  assert.equal(generator.calls.length, 1);
  assert.equal(r.calls.deterministicRepairs, 1);
  assert.equal(r.attempts[0].reply.modelDsl, q);
  assert.equal(r.attempts[0].reply.dsl, "find Work\nwhere\n  created_by(Work, david_critchley)");
  assert.ok(r.attempts[0].db.response.count > 0);
  assert.deepEqual(r.path, ["model", "diagnose", "deterministic_repair", "diagnose", "execute"]);
  assert.equal(r.deterministicRepairs[0].applied[0].kind, "swap_arguments");
  assert.ok(r.diagnosticCodes.includes("constant_not_at_position"));
});

test("a singleton variable naming an atom at its position becomes that atom", async () => {
  const { r } = await run(["find Work\nwhere\n  made_at(Work, OvalHouse)"], { dbGuided: true });
  assert.equal(r.calls.model, 1);
  assert.equal(r.attempts[0].reply.dsl, "find Work\nwhere\n  made_at(Work, oval_house)");
  assert.equal(r.deterministicRepairs[0].applied[0].kind, "replace_variable");
});

test("unsafe cases still go to the model", async () => {
  // Invalid (unknown predicate): model repair with BeingDB's errors.
  let { r, generator } = await run(["find W\nwhere\n  created_bi(W, A)", "find W\nwhere\n  created_by(W, A)"], { dbGuided: true });
  assert.equal(r.calls.model, 2);
  assert.match(r.attempts[0].feedback, /^BeingDB rejected that query/);
  assert.equal(generator.calls[1].grammar, "query_or_unsupported");
  // Valid but provably empty, no proven repair: model repair, UNSUPPORTED allowed.
  ({ r, generator } = await run(["find Work\nwhere\n  created_by(Work, nobody_at_all)", "UNSUPPORTED: no such artist."], { dbGuided: true }));
  assert.equal(r.calls.model, 2);
  assert.equal(r.outcome, "unsupported");
  assert.match(r.attempts[0].feedback, /^BeingDB ran that query and it returned no rows, because:\n- 'nobody_at_all' does not occur in any fact/);
  assert.equal(generator.calls[1].grammar, "query_or_unsupported");
  // Valid, empty, and nothing proves it wrong: accepted, no model repair.
  ({ r } = await run(["find Work\nwhere\n  year_created(Work, Y)\n  Y > @2100"], { dbGuided: true }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.attempts[0].db.response.count, 0);
  assert.equal(r.calls.model, 1);
  // Valid with rows but a warning (singleton): accepted.
  ({ r } = await run(["find Work\nwhere\n  created_by(Work, Artist)"], { dbGuided: true }));
  assert.equal(r.calls.model, 1);
  assert.ok(r.diagnosticCodes.includes("singleton_variable"));
});

test("repair loops are bounded", async () => {
  // The model never fixes the query: 1 + maxRepairs model calls.
  const { r } = await run(["find W\nwhere\n  created_bi(W, A)"], { dbGuided: true });
  assert.equal(r.calls.model, 3);
  assert.equal(r.outcome, "failed");
  // A BeingDB that always proposes a new repair: at most MAX_DETERMINISTIC_PASSES per reply.
  let k = 0;
  const endless = {
    ...db,
    diagnose: (dsl) => ({ status: "ok", ms: 0.1, response: { valid: true, errors: [], diagnostics: [], provablyEmpty: false, repair: { query: `${dsl}\n% ${k++}`, applied: [{ kind: "swap_arguments" }] } } }),
  };
  const out = await run(["find Work\nwhere\n  made_at(Work, oval_house)"], { dbGuided: true, db: endless });
  assert.equal(out.r.calls.deterministicRepairs, MAX_DETERMINISTIC_PASSES);
  assert.equal(out.n.diagnose, MAX_DETERMINISTIC_PASSES + 1);
  // A repair that leads back to a query already seen stops at once.
  const cycle = { ...db, diagnose: (dsl) => ({ status: "ok", ms: 0.1, response: { valid: true, errors: [], diagnostics: [], repair: { query: dsl, applied: [] } } }) };
  const c = await run(["find Work\nwhere\n  made_at(Work, oval_house)"], { dbGuided: true, db: cycle });
  assert.equal(c.r.calls.deterministicRepairs, 0);
  assert.equal(c.n.diagnose, 1);
});

test("instrumentation adds up", async () => {
  const { r } = await run(["find W\nwhere\n  created_bi(W, A)", "find Work\nwhere\n  created_by(david_critchley, Work)"], { dbGuided: true });
  assert.deepEqual(r.path, ["model", "diagnose", "model_repair", "diagnose", "deterministic_repair", "diagnose", "execute"]);
  assert.deepEqual(r.calls, { model: 2, modelRepair: 1, beingdb: 4, diagnose: 3, execute: 1, deterministicRepairs: 1 });
  assert.equal(r.llmMs, 2000);
  assert.ok(Math.abs(r.dbMs - (r.beingdbMs.diagnose + r.beingdbMs.execute)) < 1e-9);
  assert.equal(r.pipeline.version, "db-guided-repair/1");
});

test("after a proven repair, a model repair sees the query BeingDB judged", async () => {
  // Swap proven, but the repaired query is still provably empty (unknown second constant).
  const q = "find X\nwhere\n  created_by(david_critchley, X)\n  person(nobody_at_all)";
  const { r, generator } = await run([q, "UNSUPPORTED: no."], { dbGuided: true });
  assert.equal(r.calls.deterministicRepairs, 1);
  assert.equal(r.calls.model, 2);
  const turns = generator.calls[1].messages.slice(-2);
  assert.equal(turns[0].content, "find X\nwhere\n  created_by(X, david_critchley)\n  person(nobody_at_all)");
  assert.match(turns[1].content, /nobody_at_all/);
});

// Replaying every model reply recorded by the Run 9 benchmark through the
// default pipeline must reproduce Run 9's grammars, repair messages and outcomes.
test("with db-guided repair off, Run 9 is reproduced exactly from its recorded replies", async () => {
  const dir = readdirSync("eval/results/benchmarks").find((d) => d.startsWith("20261006T135634Z"));
  const records = readFileSync(`eval/results/benchmarks/${dir}/questions.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 50);
  for (const rec of records) {
    const { r, generator } = await run(rec.attempts.map((a) => a.raw), { maxRepairs: 2 });
    const id = rec.question.id;
    assert.equal(r.outcome, rec.outcome, `${id} outcome`);
    assert.equal(r.attempts.length, rec.attempts.length, `${id} attempts`);
    assert.deepEqual(generator.calls.map((c) => c.grammar), rec.attempts.map((a) => a.grammar), `${id} grammars`);
    assert.deepEqual(r.attempts.map((a) => a.feedback ?? null), rec.attempts.map((a) => a.feedback), `${id} repair messages`);
    assert.deepEqual(r.attempts.map((a) => a.db?.status ?? null), rec.attempts.map((a) => a.beingdb?.status ?? null), `${id} BeingDB status`);
  }
});
