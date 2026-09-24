// Decoding grammar (xgrammar EBNF, used by WebLLM's response_format "grammar")
// generated from BeingDB.predicates(). It constrains the model's tokens to the
// DSL's surface shape with real predicate names, arities and literal types.
// It checks nothing semantic: BeingDB still validates and executes every query.

const LITERAL = {
  atom: "atom",
  string: "string",
  year: "year",
  integer: "integer",
  decimal: "decimal",
  boolean: "boolean",
  year_month: "yearmonth",
  date: "date",
  uri: "uri",
};

export function buildGrammar(meta, { allowUnsupported = true } = {}) {
  const arg = (types) => `(${["var", '"_"', ...new Set(types.map((t) => LITERAL[t] || "literal"))].join(" | ")})`;
  const patterns = meta.predicates.map(
    (p) => `"${p.name}(" ${p.arguments.map((a) => arg(a.types)).join(' ", " ')} ")"`,
  );
  // Lines are newline-separated (not terminated) so the model can stop right
  // after its last clause. Counts and lengths are bounded because small models
  // otherwise sometimes repeat a clause or grow a name until max_tokens.
  return String.raw`
root ::= ${allowUnsupported ? "query | unsupported" : "query"}
unsupported ::= "UNSUPPORTED: " [^\n]{1,200}
query ::= "find " ("distinct ")? var (", " var){0,5} "\nwhere" line{1,8} block{0,3} tail
line ::= "\n  " clause
inner ::= "\n    " clause
block ::= "\n  not" inner{1,4} | "\n  optional" inner{1,4} | "\n  either" inner{1,4} ("\n  or" inner{1,4}){1,3}
clause ::= pattern | var " " op " " value | var " between " value " and " value
op ::= "=" | "!=" | "<=" | ">=" | "<" | ">"
value ::= var | year | integer | decimal | atom | string
tail ::= ("\norder by " var dir (", " var dir){0,2})? ("\nlimit " [1-9] [0-9]{0,3})?
dir ::= " ascending" | " descending"
var ::= [A-Z] [A-Za-z0-9_]{0,23}
atom ::= [a-z] [a-z0-9_]{0,63}
string ::= "\"" [^"\n]{0,100} "\""
year ::= "@" [0-9] [0-9] [0-9] [0-9]
yearmonth ::= year "-" [0-9] [0-9]
date ::= yearmonth "-" [0-9] [0-9]
integer ::= "-"? [0-9]+
decimal ::= "-"? [0-9]+ "." [0-9]+
boolean ::= "true" | "false"
uri ::= "<" [^>\n]+ ">"
literal ::= atom | string | year | integer | decimal
pattern ::= ${patterns.join("\n  | ")}
`.trim();
}
