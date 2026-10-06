// node --test: schema context from declared predicate metadata (unit + linked WASM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildSchema } from "../src/schema.js";
import { buildPrompt, repairMessage } from "../src/prompt.js";
import { loadBeingDB } from "../eval/node-beingdb.mjs";

// The WASM module initialises once per process, so the linked-build tests share one load.
const linked = loadBeingDB();

const atom = (value) => ({ type: "atom", value });
const arg = (position, extra = {}) => ({ position, types: ["atom"], ...extra });

// A stand-in for wrapBeingDB(...) over a few facts; answers "find ... where p(Vars)".
function fakeDb(predicates, facts) {
  return {
    predicates: () => ({ predicates, environmentFingerprint: "sha256:test", languageVersion: "beingdb-dsl/1" }),
    query(dsl) {
      const [, name, vars] = dsl.match(/([a-z_]+)\(([^)]*)\)/);
      const vs = vars.split(", ");
      const results = (facts[name] || []).map((f) => Object.fromEntries(vs.map((v, i) => [v, atom(f[i])])));
      return { status: "ok", response: { results } };
    },
  };
}

const people = Array.from({ length: 20 }, (_, i) => `person_${i}`);
const works = Array.from({ length: 20 }, (_, i) => `work_${i}`);
const facts = {
  person: people.map((p) => [p]),
  work: works.map((w) => [w]),
  created_by: works.map((w, i) => [w, people[i]]),
  made_at: works.slice(0, 6).map((w) => [w, "studio"]),
  rented_by: [["work_0", "person_1"]],
  sold_at: [["work_1", "person_2"]],
};
const pred = (name, args, extra = {}) => ({
  name,
  arity: args.length,
  count: facts[name].length,
  arguments: args,
  examples: [facts[name][0].map(atom)],
  ...extra,
});
const plain = () => [
  pred("person", [arg(0)]),
  pred("work", [arg(0)]),
  pred("created_by", [arg(0), arg(1)]),
  pred("made_at", [arg(0), arg(1)]),
  pred("rented_by", [arg(0), arg(1)]),
  pred("sold_at", [arg(0), arg(1)]),
];

test("without declarations the schema text is unchanged", () => {
  const s = buildSchema(fakeDb(plain(), facts));
  assert.ok(s.text.startsWith("Main predicates, with argument roles and a real example fact:\n"));
  assert.match(s.text, /^created_by\(Work, Person\) {2}e\.g\. created_by\(work_0, person_0\)$/m);
  assert.match(s.text, /^\(Thing, Thing2\): rented_by, sold_at$/m);
  assert.equal(s.signatures.get("created_by"), "created_by(Work, Person)");
  assert.equal(s.signatures.get("rented_by"), "rented_by(Thing, Thing2)");
  assert.equal(s.stats.described, 0);
});

test("declared roles win over inferred ones; descriptions only on main predicates", () => {
  const preds = plain();
  const by = Object.fromEntries(preds.map((p) => [p.name, p]));
  by.created_by.arguments = [arg(0, { role: "Work" }), arg(1, { role: "Artist" })];
  by.created_by.description = "Relates a work to the artist who made it.";
  // Partially declared: the undeclared position falls back to inference.
  by.made_at.arguments = [arg(0), arg(1, { role: "Location" })];
  by.rented_by.arguments = [arg(0, { role: "Work" }), arg(1, { role: "Renter" })];
  by.rented_by.description = "Relates a work to whoever rented it.";
  const s = buildSchema(fakeDb(preds, facts));

  assert.ok(s.text.startsWith("Main predicates, with argument roles, a description and a real example fact:\n"));
  assert.match(
    s.text,
    /^created_by\(Work, Artist\): Relates a work to the artist who made it\. {2}e\.g\. created_by\(work_0, person_0\)$/m,
  );
  assert.match(s.text, /^made_at\(Work, Location\) {2}e\.g\./m);
  // Compact predicates stay compact in the system prompt...
  assert.match(s.text, /^\(Thing, Thing2\): rented_by, sold_at$/m);
  assert.ok(!s.text.includes("whoever rented it"));
  // ...but repair signatures carry their declared roles and description.
  assert.equal(s.signatures.get("created_by"), "created_by(Work, Artist): Relates a work to the artist who made it.");
  assert.equal(s.signatures.get("rented_by"), "rented_by(Work, Renter): Relates a work to whoever rented it.");
  assert.equal(s.signatures.get("sold_at"), "sold_at(Thing, Thing2)");
  assert.deepEqual([s.stats.described, s.stats.describedInText, s.stats.declaredRoles], [2, 1, 3]);
});

test("linked beingdb-wasm with annotations stripped reproduces the run-8 baseline schema", async () => {
  const { db } = await linked;
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

test("linked beingdb-wasm: annotations reach the system prompt and repairs", async () => {
  const { db } = await linked;
  const meta = db.predicates();
  assert.ok(meta.predicates.filter((p) => p.description).length > 100, "runtime exposes descriptions");
  assert.ok(meta.predicates.every((p) => p.arguments.every((a) => a.role)), "runtime exposes roles");

  const schema = buildSchema(db);
  const prompt = buildPrompt(schema);
  const line = prompt.system.split("\n").find((l) => l.startsWith("created_by("));
  assert.equal(
    line,
    "created_by(Work, Artist): Relates a work to the artist or artist group who made it.  e.g. created_by(static_acceleration, david_critchley)",
  );
  assert.equal(schema.stats.describedInText, schema.stats.detailed, "every main predicate is described");
  // The interactive page, eval page and benchmark all send prompt.messages(question).
  assert.equal(prompt.messages("q")[0].content, prompt.system);

  const bad = db.query("find W\nwhere\n  created_bi(W, A)");
  assert.equal(bad.status, "invalid");
  const repair = repairMessage(bad.response, schema);
  assert.match(repair.text, /created_by\(Work, Artist\): Relates a work to the artist/);
});
