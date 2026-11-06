// node --test: the written answer's prompt and the check that guards it (no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerMessages, answerBlocks, checkAnswer, displayValue, header, ignoredByQuery, phraseAnswer, PHRASE_ROWS, words } from "../src/answer.js";

const atom = (value) => ({ type: "atom", value });
const response = (variables, rows, extra = {}) => ({
  variables,
  results: rows.map((r) => Object.fromEntries(variables.map((v, i) => [v, atom(r[i])]))),
  total: rows.length,
  hasMore: false,
  truncated: false,
  ...extra,
});
const bbc = response(["Person", "Employer"], [["anna_ridley", "bbc"], ["delia_derbyshire", "bbc"]]);
const q = "Who was employed by the BBC?";
const bbcDsl = "find Person, Employer\nwhere\n  employed_by(Person, Employer)\n  Employer = bbc";

test("displayValue humanises atoms", () => {
  assert.equal(displayValue(atom("delia_derbyshire")), "Delia Derbyshire");
  assert.equal(displayValue(atom("bbc")), "BBC");
  assert.equal(displayValue(atom("an_audience_s_new_clothes")), "An Audience's New Clothes");
});

test("answerMessages gives the question, search and facts, and asks for all of a complete result", () => {
  const { messages, complete } = answerMessages(q, bbc, { dsl: bbcDsl });
  assert.equal(complete, true);
  const user = messages.at(-1).content;
  assert.match(user, /Question: Who was employed by the BBC\?/);
  assert.match(user, /Search:\nfind Person, Employer/);
  assert.match(user, /- Person: Anna Ridley; Employer: BBC/);
  assert.match(user, /Mention every one of the 2 above/);
});

test("answerMessages explains the search with the relations it uses", () => {
  const signatures = new Map([["funded_by", "funded_by(Recipient, Funder): Relates a recipient to its funder."], ["created_by", "x"]]);
  const res = response(["Person"], [["mike_stubbs"]]);
  const dsl = "find Person\nwhere\n  funded_by(Person, _)";
  const user = answerMessages("Who funded Peter Donebauer?", res, { dsl, signatures }).messages.at(-1).content;
  assert.match(user, /Search:\nfind Person\nwhere\n  funded_by\(Person, _\)/);
  assert.match(user, /Meaning of its relations:\n- funded_by\(Recipient, Funder\): Relates a recipient to its funder\./);
  assert.doesNotMatch(user, /created_by/);
});

test("answerMessages summarises large results from the first rows", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [`work_${i}`]);
  const { messages, complete } = answerMessages("List the works.", response(["Work"], rows, { total: 137 }));
  assert.equal(complete, false);
  const user = messages.at(-1).content;
  assert.equal(user.split("\n").filter((l) => l.startsWith("- ")).length, PHRASE_ROWS);
  assert.match(user, /Facts \(a sample of 137\):/);
  assert.match(user, /Say that there are 137 in total/);
});

test("checkAnswer accepts a faithful sentence", () => {
  assert.deepEqual(checkAnswer("Anna Ridley and Delia Derbyshire both worked for the BBC.", q, bbc, true, bbcDsl), { ok: true });
  assert.equal(checkAnswer("Two people were employed by the BBC: Anna Ridley and Delia Derbyshire.", q, bbc, true, bbcDsl).ok, true);
});

test("checkAnswer rejects a sentence that leaves out a name", () => {
  const r = checkAnswer("Anna Ridley worked for the BBC.", q, bbc, true, bbcDsl);
  assert.equal(r.ok, false);
  assert.match(r.reason, /leaves out Delia Derbyshire/);
});

test("checkAnswer rejects a sentence that adds a name or number", () => {
  const name = checkAnswer("Anna Ridley, Delia Derbyshire and Peter Donebauer worked for the BBC.", q, bbc, true, bbcDsl);
  assert.equal(name.ok, false);
  assert.match(name.reason, /adds Peter, Donebauer/);
  const year = checkAnswer("Anna Ridley and Delia Derbyshire worked for the BBC in 1975.", q, bbc, true, bbcDsl);
  assert.equal(year.ok, false);
  assert.match(year.reason, /adds 1975/);
});

test("checkAnswer matches values loosely and allows the total count", () => {
  const funders = response(["Funder"], [["british_film_institute_bfi"], ["arts_council"]]);
  const dsl = "find Funder\nwhere\n  funded_by(peter_donebauer, Funder)";
  const ok = checkAnswer("Peter Donebauer was funded by the British Film Institute (BFI) and the Arts Council.", "Who funded Peter Donebauer?", funders, true, dsl);
  assert.deepEqual(ok, { ok: true });
  const rows = Array.from({ length: 25 }, (_, i) => [`work_${i}`]);
  const big = response(["Work"], rows, { total: 137 });
  assert.equal(checkAnswer("There are 137 works, including Work 0 and Work 1.", "List the works.", big, false).ok, true);
});

test("answerBlocks turns a stray Markdown list into paragraphs and items", () => {
  assert.deepEqual(answerBlocks("Two works:\n\n* **Running Time**\n* Split Seconds\nThat is all."), [
    { type: "p", text: "Two works:" },
    { type: "ul", items: ["Running Time", "Split Seconds"] },
    { type: "p", text: "That is all." },
  ]);
});

test("checkAnswer allows names and years from the search itself", () => {
  const works = response(["Work"], [["running_time"], ["split_seconds"]]);
  const dsl = "find Work\nwhere\n  year_created(Work, @1979)";
  assert.equal(checkAnswer("Running Time and Split Seconds were created in 1979.", "Which works?", works, true, dsl).ok, true);
  assert.equal(checkAnswer("Running Time and Split Seconds were created in 1980.", "Which works?", works, true, dsl).ok, false);
  const venues = response(["Venue"], [["herbert_art_gallery_video_show_1970s"], ["de_appel"]]);
  assert.equal(checkAnswer("He performed at the Herbert Art Gallery Video Show 1970s and De Appel.", "Where?", venues, true).ok, true);
});

test("ignoredByQuery finds names and numbers in the question that the search does not use", () => {
  assert.deepEqual(ignoredByQuery("Who funded Peter Donebauer?", "find Person\nwhere\n  funded_by(Person, _)"), ["Peter", "Donebauer"]);
  assert.deepEqual(ignoredByQuery("Who funded Peter Donebauer?", "find F\nwhere\n  funded_by(peter_donebauer, F)"), []);
  assert.deepEqual(ignoredByQuery("Which works were created in 1979?", "find W\nwhere\n  year_created(W, @1979)"), []);
  assert.deepEqual(ignoredByQuery("Which works were created in 1979?", "find W\nwhere\n  year_created(W, @1980)"), ["1979"]);
  assert.deepEqual(ignoredByQuery("Which artists were interviewed for Rewind?", "find A\nwhere\n  interviewed_artist(A)"), []);
});

test("phraseAnswer does not call the model when the search ignores the question's names", async () => {
  let called = false;
  const generator = { complete: async () => ((called = true), { text: "x", finish: "stop" }) };
  const res = response(["Person"], [["mike_stubbs"]]);
  const r = await phraseAnswer({ question: "Who funded Peter Donebauer?", response: res, generator, dsl: "find Person\nwhere\n  funded_by(Person, _)" });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});

test("checkAnswer rejects an empty answer", () => {
  assert.equal(checkAnswer("  ", q, bbc, true).ok, false);
});

test("aggregate columns read as words in the answer prompt", () => {
  assert.equal(words("avg(Minutes)"), "average minutes");
  assert.equal(header("count(Work)"), "Work count");
  assert.equal(header("min(Year)"), "Minimum year");
  assert.equal(words("WorkTitle"), "work title");
  const res = {
    variables: ["avg(Minutes)"],
    results: [{ "avg(Minutes)": { type: "decimal", value: "18" } }],
    total: 1,
    hasMore: false,
    truncated: false,
  };
  const dsl = "find avg(Minutes)\nwhere\n  duration_minutes(Work, Minutes)";
  const { messages } = answerMessages("What is the average duration of the works?", res, { dsl });
  assert.match(messages.at(-1).content, /- Average minutes: 18/);
  assert.equal(checkAnswer("On average the works last 18 minutes.", "What is the average duration of the works?", res, true, dsl).ok, true);
  assert.equal(checkAnswer("On average the works last 20 minutes.", "What is the average duration of the works?", res, true, dsl).ok, false);
});
