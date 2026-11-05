// The grounding check must pass every benchmark question's reference query, and catch made-up names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { queryConstants, ungroundedConstants, relevanceMessages } from "../src/guard.js";

const questions = (file) => JSON.parse(readFileSync(new URL(`../eval/${file}`, import.meta.url), "utf8")).items;

test("reference queries only use names their questions mention", () => {
  const flagged = [];
  for (const file of ["questions.json", "questions-v2.json"])
    for (const q of questions(file).filter((q) => q.reference)) {
      const bad = ungroundedConstants(q.question, q.reference);
      if (bad.length) flagged.push(`${file} ${q.id}: ${bad.join(", ")}`);
    }
  assert.deepEqual(flagged, []);
});

test("a made-up name is flagged", () => {
  const dsl = "find count(Work)\nwhere\n  created_by(Work, david_hall)";
  assert.deepEqual(queryConstants(dsl), ["david_hall"]);
  assert.deepEqual(ungroundedConstants("what is i type some gibberish", dsl), ["david_hall"]);
  assert.deepEqual(ungroundedConstants("How many works did David Hall make?", dsl), []);
});

test("strings in contains are checked, variables and _ are not", () => {
  const dsl = 'find E, T\nwhere\n  exhibition_title(E, T)\n  T contains "video"\n  held_at(E, _)';
  assert.deepEqual(queryConstants(dsl), ["video"]);
  assert.deepEqual(ungroundedConstants("Which exhibitions were about videos?", dsl), []);
  assert.deepEqual(ungroundedConstants("Which exhibitions were about painting?", dsl), ["video"]);
});

test("the relevance prompt ends with the user's message", () => {
  const m = relevanceMessages("hi there", "the REWIND interviews");
  assert.equal(m[0].role, "system");
  assert.deepEqual(m.at(-1), { role: "user", content: "hi there" });
});
