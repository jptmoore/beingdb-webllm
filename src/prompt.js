// Model instructions: DSL rules + live schema + a few examples over real Rewind
// data, and the decoding grammars. Model-agnostic: any WebLLM chat model can use it.
import { buildGrammar } from "./grammar.js";

const UNSUPPORTED = "UNSUPPORTED: ";

const RULES = `You translate questions about a BeingDB database into BeingDB queries.
BeingDB runs your query and returns the answer, so never answer from your own knowledge.
Reply with only the query. If the predicates below cannot answer the question, reply ${UNSUPPORTED}<reason>.

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
- Queries cannot count, sum, average or rank: such questions are unsupported.`;

// Real Rewind queries (checked by eval/check-references.mjs), none of them eval questions.
export const EXAMPLES = [
  { q: "Which works were made at Oval House?", a: "find Work\nwhere\n  made_at(Work, oval_house)" },
  { q: "Who created Mandala?", a: "find Person\nwhere\n  created_by(mandala, Person)" },
  { q: "What did Anna Ridley produce?", a: "find Work\nwhere\n  produced_by(Work, anna_ridley)" },
  { q: "Which works were created from 1968 to 1972?", a: "find Work, Year\nwhere\n  year_created(Work, Year)\n  Year between @1968 and @1972" },
  {
    q: "List David Critchley's works with their year, newest first.",
    a: "find Work, Year\nwhere\n  created_by(Work, david_critchley)\n  year_created(Work, Year)\norder by Year descending",
  },
  {
    q: "Which works by Kevin Atherton have never been exhibited?",
    a: "find Work\nwhere\n  created_by(Work, kevin_atherton)\n  not\n    exhibited_at(Work, _)",
  },
  { q: "What price did Tape Tape sell for?", a: `${UNSUPPORTED}No predicate records prices.` },
  { q: "Where does Kevin Atherton live now?", a: `${UNSUPPORTED}No predicate records where people live.` },
  { q: "What is the total running time of Judith Goddard's works?", a: `${UNSUPPORTED}Queries cannot sum values.` },
];

export function buildPrompt(schema) {
  const system = `${RULES}\n\n${schema.text}`;
  const shots = EXAMPLES.flatMap((e) => [
    { role: "user", content: e.q },
    { role: "assistant", content: e.a },
  ]);
  return {
    system,
    messages: (question) => [{ role: "system", content: system }, ...shots, { role: "user", content: question }],
    format: { type: "grammar", grammar: buildGrammar(schema.meta) },
    // For repairs where BeingDB found every predicate: the question is
    // expressible, so the model must fix the query rather than give up.
    fixFormat: { type: "grammar", grammar: buildGrammar(schema.meta, { allowUnsupported: false }) },
    chars: system.length + shots.reduce((n, m) => n + m.content.length, 0),
  };
}

export function parseReply(text) {
  const t = text.trim();
  if (t.startsWith(UNSUPPORTED.trim())) return { status: "unsupported", reason: t.slice(UNSUPPORTED.trim().length).trim() };
  if (t.startsWith("find")) return { status: "ok", dsl: t };
  return { status: "model_error", error: "reply is neither a query nor UNSUPPORTED" };
}

const PREDICATE_RE = /\b([a-z][a-z0-9_]*)\s*\(/g;

export function predicatesIn(dsl) {
  return [...new Set([...dsl.matchAll(PREDICATE_RE)].map((m) => m[1]))];
}

// One-line reminders of the DSL rule behind each BeingDB error code.
const HINTS = {
  syntax_error: "Use: find line, where line, then one clause per line.",
  unknown_predicate: "Use only predicates from the list.",
  arity_mismatch: "Give the predicate exactly the listed number of arguments.",
  unbound_projection: "Every find variable must appear in a clause; remove it or add the clause that binds it.",
  unbound_order_variable: "An order by variable must appear in a clause; remove the order by or bind it.",
  unsafe_negation: "Variables inside not must also appear in a clause outside it; otherwise use _.",
  disconnected_query: "All clauses must be joined through shared variables or constants.",
  literal_type_mismatch: "Check the literal type: years need @ (@1979), strings need quotes, names are lowercase_atoms.",
  comparison_type_mismatch: "Compare years with years (@1979) and numbers with numbers.",
};

// Feed BeingDB's own validation errors back, plus the signatures of the
// predicates they mention (or suggest), so the repair is grounded in the schema.
// Returns the message and whether "unsupported" stays an allowed reply.
export function repairMessage(response, schema) {
  const errors = response.errors || (response.error ? [response.error] : []);
  const lines = errors.map((e) => `- ${e.message}${e.line ? ` (line ${e.line})` : ""}`);
  const hints = [...new Set(errors.map((e) => HINTS[e.code]).filter(Boolean))];
  const mentioned = new Set();
  for (const e of errors) {
    for (const s of e.suggestions || []) mentioned.add(s);
    if (e.predicate && schema.names.has(e.predicate)) mentioned.add(e.predicate);
  }
  const sigs = [...mentioned].filter((n) => schema.signatures.has(n)).map((n) => `  ${schema.signatures.get(n)}`);
  const unknown = errors.some((e) => e.code === "unknown_predicate");
  const text =
    `BeingDB rejected that query:\n${lines.join("\n")}\n` +
    (hints.length ? `${hints.join("\n")}\n` : "") +
    (sigs.length ? `Relevant predicates:\n${sigs.join("\n")}\n` : "") +
    (unknown
      ? `Reply with the corrected query, or ${UNSUPPORTED}<reason> if no listed predicate records the needed information.`
      : `The predicates exist, so reply with the corrected query.`);
  return { text, allowUnsupported: unknown };
}
