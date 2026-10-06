// Model-free checks, in Node against the same beingdb-wasm build:
//   node eval/check-references.mjs              validate references, examples and the scorer
//   node eval/check-references.mjs run.json     re-score a run exported from eval.html
//   --questions <path>                          question file [eval/questions.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { loadBeingDB } from "./node-beingdb.mjs";
import { EXAMPLES, predicatesIn, buildPrompt } from "../src/prompt.js";
import { buildSchema } from "../src/schema.js";
import { scoreItem, summarise, matchColumns } from "../src/score.js";
import { buildAnalysisContext, classifyAttempt } from "../src/analysis.js";
import { loadSuite } from "../scripts/lib/suite.mjs";

const { values: opts, positionals } = parseArgs({
  options: { questions: { type: "string", default: fileURLToPath(new URL("./questions.json", import.meta.url)) } },
  allowPositionals: true,
});
const { db, summary } = await loadBeingDB();
const { items, environmentFingerprint } = JSON.parse(readFileSync(opts.questions, "utf8"));
assert.equal(summary.environmentFingerprint, environmentFingerprint, `dataset changed since ${opts.questions} was written`);

const fake = (dsl, status = "ok") => {
  const reply = status === "ok" ? { status, dsl } : { status, reason: "" };
  const attempt = { reply, llmMs: 0, db: status === "ok" ? db.query(dsl) : undefined };
  return { attempts: [attempt], repairs: 0, outcome: status === "ok" ? (attempt.db.status === "ok" ? "ok" : "failed") : status };
};

if (positionals[0]) {
  const run = JSON.parse(readFileSync(positionals[0], "utf8"));
  const byId = new Map(items.map((i) => [i.id, i]));
  // Saved runs omit result rows; BeingDB re-derives them from the recorded DSL.
  for (const { run: r } of run.results)
    for (const a of r.attempts) if (a.db && a.reply.dsl) a.db = { ...db.query(a.reply.dsl), ms: a.db.ms };
  const scores = run.results.map((r) => scoreItem(byId.get(r.id), r.run, db));
  console.log(JSON.stringify(summarise(scores, run.results.map((r) => r.run)), null, 2));
  process.exit(0);
}

for (const ex of EXAMPLES) {
  if (!ex.a.startsWith("find")) continue;
  const r = db.query(ex.a);
  assert.equal(r.status, "ok", `example "${ex.q}": ${JSON.stringify(r.response)}`);
  assert.ok(r.response.count > 0, `example "${ex.q}" returns no rows`);
  assert.ok(!items.some((i) => i.question === ex.q), `example "${ex.q}" duplicates an eval question`);
}
buildPrompt(buildSchema(db));
const schema = buildSchema(db);
const ctx = buildAnalysisContext(db, schema);
const suite = loadSuite(opts.questions); // throws if questions.json no longer matches eval/suite.json

let supported = 0;
const countMismatches = [];
for (const item of items) {
  if (!item.reference) {
    assert.ok(scoreItem(item, fake("", "unsupported"), db).correct);
    continue;
  }
  supported++;
  const r = db.query(item.reference);
  assert.equal(r.status, "ok", `${item.id}: ${JSON.stringify(r.response)}`);
  const keys = item.key || r.response.variables;
  const distinct = new Set(r.response.results.map((row) => JSON.stringify(keys.map((k) => row[k])))).size;
  assert.ok(distinct > 0, `${item.id} returns no rows`);
  if (item.expectCount !== undefined && distinct !== item.expectCount)
    countMismatches.push(`${item.id}: expectCount ${item.expectCount}, got ${distinct}`);
  for (const p of item.predicates) assert.ok(predicatesIn(item.reference).includes(p), `${item.id} uses ${p}`);
  assert.ok(matchColumns(r.response, keys, r.response));

  // The scorer must accept the reference itself...
  const self = scoreItem(item, fake(item.reference), db);
  assert.ok(self.correct && self.firstCorrect, `${item.id}: reference not judged correct`);
  assert.equal(classifyAttempt(item, r.response, fake(item.reference).attempts[0], db, ctx, { final: true }), null, `${item.id}: reference got a failure category`);
  // ...and reject it with a binary pattern's arguments swapped (when that changes the answer).
  const lines = item.reference.split("\n");
  const i = lines.findIndex((l) => /^\s*[a-z_]+\([^,()]+,\s*[^,()]+\)\s*$/.test(l));
  if (i >= 0) {
    const m = lines[i].match(/^(\s*)([a-z_]+)\(([^,()]+),\s*([^,()]+)\)/);
    lines[i] = `${m[1]}${m[2]}(${m[4]}, ${m[3]})`;
    const swapped = scoreItem(item, fake(lines.join("\n")), db);
    if (!swapped.correct && swapped.finalValid) {
      assert.match(swapped.failure, /argument order/, `${item.id}: swap diagnosed as ${swapped.failure}`);
      const c = classifyAttempt(item, r.response, fake(lines.join("\n")).attempts[0], db, ctx, { final: true });
      assert.ok(["wrong_argument_order", "wrong_ordering"].includes(c?.category), `${item.id}: swap categorised as ${c?.category}`);
    }
  }
  console.log(`${item.id} ok  ${String(distinct).padStart(4)} rows  ${item.question}`);
}
assert.deepEqual(countMismatches, [], "expectCount mismatches");
console.log(`\n${items.length} questions (${supported} supported, ${items.length - supported} unsupported); references, examples and scorer OK`);
console.log(`suite ${suite.id}, ${suite.file} sha256 ${suite.sha256}`);
