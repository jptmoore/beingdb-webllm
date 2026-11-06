// node --test: replays of recorded benchmark runs over the data they ran on.
// The linked dataset moves on as the pack is cleaned up, so these load the
// REWIND export the runs used (beingdb-rewind-interviews 9faf73f, 168
// predicates, fingerprint sha256:72f26c19...), kept gzipped as a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ask } from "../src/pipeline.js";
import { buildSchema } from "../src/schema.js";
import { buildPrompt } from "../src/prompt.js";
import { loadBeingDB } from "../eval/node-beingdb.mjs";

const dataFile = fileURLToPath(new URL("../eval/test/fixtures/rewind-72f26c.browser.json.gz", import.meta.url));
const { db, summary } = await loadBeingDB({ dataFile });
const schema = buildSchema(db);
const prompt = buildPrompt(schema);

test("the replay fixture is the dataset the recorded runs used", () => {
  assert.equal(summary.environmentFingerprint, "sha256:72f26c197b218529990de9cdf11da453d667020f693dbc4ba5398aa4ac1ed01d");
  assert.deepEqual([summary.predicates, summary.facts], [168, 1842]);
});

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

const run = (replies, opts = {}) => {
  const generator = scripted(replies);
  return ask({ question: "q", generator, db, schema, prompt, ...opts }).then((r) => ({ r, generator }));
};

// Benchmark records (questions.jsonl) of a saved run kept as a test fixture.
const FIXTURES = { "20261006T135634Z": "run9-model", "20261006T164839Z": "run10-db-guided" };
const recordsOf = (prefix) =>
  readFileSync(new URL(`../eval/test/fixtures/${FIXTURES[prefix]}/questions.jsonl`, import.meta.url), "utf8").trim().split("\n").map(JSON.parse);

// Where BeingDB proves no repair, proven-only must be run 9: replaying Run 9's
// recorded replies, every such question reproduces Run 9 exactly.
test("proven-only without a proven repair is exactly run 9 (Run 9 replay)", async () => {
  let same = 0;
  for (const rec of recordsOf("20261006T135634Z")) {
    const { r, generator } = await run(rec.attempts.map((a) => a.raw), { repairPolicy: "proven-only", maxRepairs: 2 });
    if (r.calls.deterministicRepairs > 0) continue;
    const id = rec.question.id;
    same++;
    assert.equal(r.outcome, rec.outcome, `${id} outcome`);
    assert.deepEqual(generator.calls.map((c) => c.grammar), rec.attempts.map((a) => a.grammar), `${id} grammars`);
    assert.deepEqual(r.attempts.map((a) => a.feedback ?? null), rec.attempts.map((a) => a.feedback), `${id} repair messages`);
    assert.deepEqual(r.attempts.map((a) => a.db?.status ?? null), rec.attempts.map((a) => a.beingdb?.status ?? null), `${id} BeingDB status`);
  }
  assert.ok(same >= 40, `${same} questions without a proven repair`);
});

// Replaying every model reply recorded by the Run 9 benchmark through the
// default pipeline must reproduce Run 9's grammars, repair messages and outcomes.

// Run 10 (db-guided) replayed from its recorded replies: same path, BeingDB
// diagnoses, proven repairs, repair messages and outcomes. Run 10 predates
// BeingDB 0.1.7's unsatisfiable_comparison diagnostic, which now adds lines to
// two recorded messages (e16, u05), and 0.4.1's contains hint, which extends a
// line (h02); only those additions are tolerated.
const NEWER_DIAGNOSTIC_LINE = /^- No \w+ fact has a value at argument \d+ satisfying .+, so the query returns no rows\./;
// BeingDB 0.4.1 may append a contains hint to a recorded diagnostic line.
const CONTAINS_HINT = / Values there contain ".*?" \(.*?\): put a variable there and add \w+ contains ".*?"\./;
function assertRecordedMessage(now, was, label) {
  if (now !== null) now = now.split("\n").map((l) => l.replace(CONTAINS_HINT, "")).join("\n");
  if (now === was || now === null || was === null) return assert.equal(now, was, label);
  const nowLines = now.split("\n");
  const wasLines = was.split("\n");
  let k = 0;
  for (const line of nowLines) {
    if (k < wasLines.length && line === wasLines[k]) k++;
    else
      assert.ok(
        NEWER_DIAGNOSTIC_LINE.test(line) || ["BeingDB also found:", "Relevant predicates:"].includes(line) || line.startsWith("  "),
        `${label}: unexpected line ${JSON.stringify(line)}`,
      );
  }
  assert.equal(k, wasLines.length, `${label}: recorded lines missing`);
  assert.ok(nowLines.some((l) => NEWER_DIAGNOSTIC_LINE.test(l)), `${label}: differs without a newer diagnostic`);
}
test("db-guided repair reproduces Run 10 exactly from its recorded replies", async () => {
  const records = recordsOf("20261006T164839Z");
  assert.equal(records.length, 50);
  for (const rec of records) {
    const { r, generator } = await run(rec.attempts.map((a) => a.raw), { dbGuided: true, maxRepairs: 2 });
    const id = rec.question.id;
    assert.equal(r.outcome, rec.outcome, `${id} outcome`);
    assert.deepEqual(generator.calls.map((c) => c.grammar), rec.attempts.map((a) => a.grammar), `${id} grammars`);
    assert.equal(r.attempts.length, rec.attempts.length, `${id} attempts`);
    r.attempts.forEach((a, i) => assertRecordedMessage(a.feedback ?? null, rec.attempts[i].feedback ?? null, `${id} repair message ${i}`));
    assert.deepEqual(r.attempts.map((a) => a.reply.dsl ?? null), rec.attempts.map((a) => a.reply.dsl ?? null), `${id} judged queries`);
    assert.deepEqual(r.attempts.map((a) => a.db?.status ?? null), rec.attempts.map((a) => a.beingdb?.status ?? null), `${id} BeingDB status`);
    assert.deepEqual(r.path, rec.efficiency.path, `${id} path`);
    assert.deepEqual(r.calls, rec.efficiency.calls, `${id} calls`);
    assert.deepEqual(r.deterministicRepairs, rec.efficiency.deterministicRepairs, `${id} proven repairs`);
  }
});
test("with db-guided repair off, Run 9 is reproduced exactly from its recorded replies", async () => {
  const records = recordsOf("20261006T135634Z");
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

test("with annotations stripped, the replay data reproduces the run-8 baseline schema", async () => {
  // Uses the fixture: annotations were added to the pack after Run 8, and later data changes move the hash.
  const meta = db.predicates();
  const stripped = {
    ...meta,
    predicates: meta.predicates.map(({ description, ...p }) => ({
      ...p,
      arguments: p.arguments.map(({ role, semanticType, ...a }) => a),
    })),
  };
  const schema = buildSchema({ ...db, predicates: () => stripped });
  // schemaText hash recorded by the 20261005T160921Z Llama baseline benchmark.
  assert.equal(
    createHash("sha256").update(schema.text).digest("hex"),
    "7fe2fa162c001c09e1d58f5e98cb3679ac244b7076989368312edc1eb901ab37",
  );
});

