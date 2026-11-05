// Turns BeingDB's rows into a short natural-language answer with the language model,
// then checks the sentence against the rows. The rows stay the source of truth: the page
// shows them under the sentence, and falls back to them when the sentence fails the check.
// When the search ignores something the question names, it cannot be answering the question,
// and phrasing its facts as an answer misattributes them, so no sentence is written.

// Friendly display of BeingDB values: atoms like `david_critchley` become "David Critchley".
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
export function displayValue(cell) {
  if (!cell) return "—";
  if (cell.type !== "atom") return String(cell.value);
  return String(cell.value)
    .split("_")
    .filter(Boolean)
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w) ? w : /^[^aeiouy\d]{2,4}$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ")
    .replace(/ S\b/g, "'s");
}
export const words = (variable) => variable.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
export const header = (variable) => {
  const w = words(variable);
  return w[0].toUpperCase() + w.slice(1);
};

// Results up to this size are phrased in full; larger ones are summarised from the first rows.
export const PHRASE_ROWS = 20;
export const PHRASE_MAX_TOKENS = 256;

const SYSTEM = `You write the answers of a chatbot about the REWIND interviews with video artists.
You are given a user's question, the database search that was run for it, what its relations mean, and the facts it found.
Answer in plain, friendly English, in one to three flowing sentences, using only those facts:
no lists, no headings and no Markdown.
Do not add anything that is not in the facts. Do not mention databases, searches, queries, results, rows or facts.
Follow the search and the meaning of its relations; never link a fact to a person or thing that the fact itself does not name.`;

// The predicates a query uses, with their declared roles and descriptions (schema.signatures).
export function relationLines(dsl, signatures) {
  if (!dsl || !signatures) return [];
  const used = [...new Set([...dsl.matchAll(/\b([a-z][a-z0-9_]*)\s*\(/g)].map((m) => m[1]))];
  return used.filter((n) => signatures.has(n)).map((n) => `- ${signatures.get(n)}`);
}

export function answerMessages(question, res, { dsl, signatures } = {}) {
  const vars = res.variables;
  const rows = res.results.slice(0, PHRASE_ROWS);
  const total = Math.max(res.total ?? 0, res.results.length);
  const complete = rows.length === total && !res.hasMore && !res.truncated;
  const lines = rows.map((r) => "- " + vars.map((v) => `${header(v)}: ${displayValue(r[v])}`).join("; "));
  const relations = relationLines(dsl, signatures);
  const instruction = complete
    ? `Mention every one of the ${total} above.`
    : `Say that there are ${total}${res.hasMore || res.truncated ? " or more" : ""} in total and name a few of them as examples. ` +
      `Do not say that only some are listed.`;
  const context =
    (dsl ? `Search:\n${dsl.trim()}\n\n` : "") + (relations.length ? `Meaning of its relations:\n${relations.join("\n")}\n\n` : "");
  const heading = complete ? "Facts:" : `Facts (a sample of ${total}${res.hasMore || res.truncated ? "+" : ""}):`;
  return {
    complete,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Question: ${question}\n\n${context}${heading}\n${lines.join("\n")}\n\n${instruction}` },
    ],
  };
}

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export const tokens = (s) => norm(s).split(" ").filter(Boolean);

// A fact value counts as mentioned when all its words appear in the answer,
// so "British Film Institute Bfi" matches "the British Film Institute (BFI)".
const mentions = (answerTokens, value) => tokens(value).every((t) => answerTokens.has(t));

// Rejects answers that leave out a value (complete results only) or name something new:
// a capitalised word or a number, mid-sentence, that is in none of the facts, the question and the search.
export function checkAnswer(text, question, res, complete, dsl = "") {
  const answer = String(text ?? "").trim();
  if (!answer) return { ok: false, reason: "empty answer" };
  const answerTokens = new Set(tokens(answer));
  const values = [...new Set(res.results.slice(0, PHRASE_ROWS).flatMap((r) => res.variables.map((v) => displayValue(r[v]))))];
  if (complete) {
    const missing = values.filter((v) => !mentions(answerTokens, v));
    if (missing.length) return { ok: false, reason: `leaves out ${missing.join(", ")}` };
  }
  const known = new Set([...values.flatMap(tokens), ...tokens(question), ...tokens(dsl), "rewind"]);
  const total = Math.max(res.total ?? 0, res.results.length);
  for (const n of [total, res.results.length, Math.min(res.results.length, PHRASE_ROWS)]) known.add(String(n));
  const added = [];
  for (const m of answer.matchAll(/(?<=[^.!?:;\s"“(]\s+|\(|")([A-Z][\w’'-]*|\d[\d,.]*\w*)/g)) {
    const t = tokens(m[1]);
    if (t.length && !t.every((w) => known.has(w))) added.push(m[1]);
  }
  for (const m of answer.matchAll(/\b\d[\d,.]*\w*/g)) if (!tokens(m[0]).every((w) => known.has(w))) added.push(m[0]);
  if (added.length) return { ok: false, reason: `adds ${[...new Set(added)].join(", ")}` };
  return { ok: true };
}

// Names (capitalised words after the first) and numbers in the question that the search does not use.
export function ignoredByQuery(question, dsl) {
  const used = new Set([...tokens(dsl ?? ""), "rewind"]);
  const named = [...String(question).matchAll(/(?<=\S\s+)[A-Z][\w’'-]*|\d+/g)].map((m) => m[0]);
  return [...new Set(named.filter((w) => !tokens(w).every((t) => used.has(t))))];
}

// The answer as paragraphs and bullet lists, without Markdown emphasis or heading marks,
// in case the model writes a list despite the instructions.
export function answerBlocks(text) {
  const blocks = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\*\*|__/g, "").replace(/^#+\s*/, "").trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[*•-]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (blocks.at(-1)?.type !== "ul") blocks.push({ type: "ul", items: [] });
      blocks.at(-1).items.push(bullet[1]);
    } else blocks.push({ type: "p", text: line });
  }
  return blocks;
}

// One model call; never throws, so a failure only means falling back to the plain list.
export async function phraseAnswer({ question, response, generator, dsl, signatures }) {
  const { messages, complete } = answerMessages(question, response, { dsl, signatures });
  const ignored = ignoredByQuery(question, dsl);
  if (ignored.length) return { text: "", ok: false, skipped: true, reason: `the search does not use ${ignored.join(", ")} from the question`, complete, messages, ms: 0 };
  const t = performance.now();
  try {
    const gen = await generator.complete(messages, undefined, { temperature: 0, maxTokens: PHRASE_MAX_TOKENS });
    const text = (gen.text ?? "").trim();
    const verdict = gen.finish === "length" ? { ok: false, reason: "answer was cut off" } : checkAnswer(text, question, response, complete, dsl);
    return { text, ...verdict, complete, messages, ms: performance.now() - t, usage: gen.usage };
  } catch (e) {
    return { text: "", ok: false, reason: `model error: ${e.message}`, complete, messages, ms: performance.now() - t };
  }
}
