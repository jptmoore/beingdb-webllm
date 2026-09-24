// Build the model's schema context from BeingDB's own introspection
// (BeingDB.predicates()) plus a few BeingDB queries. Nothing is hard-coded:
// load a different pack and the context changes with it.

// Unary atom predicates with at least this many facts act as "classes"
// (person, work, venue, ...) used to label argument roles.
const CLASS_MIN_FACTS = 20;
// Predicates with at least this many facts get a role signature and an example.
const DETAIL_MIN_FACTS = 5;

export function literal(v) {
  switch (v.type) {
    case "string":
      return JSON.stringify(v.value);
    case "year":
    case "year_month":
    case "date":
    case "instant":
      return "@" + v.value;
    case "uri":
      return `<${v.value}>`;
    default:
      return v.value;
  }
}

// Placeholder variable names for non-atom argument types.
const TYPE_VAR = { year: "Year", integer: "Number", decimal: "Number", string: "Text", date: "Date", instant: "Time", uri: "Uri" };
const pascal = (s) => s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
const typeVar = (types) => (types.length === 1 && TYPE_VAR[types[0]]) || "Value";

// Distinct names within one signature: collaborated_with(Person, Person2).
function numbered(names) {
  const seen = {};
  return names.map((n) => ((seen[n] = (seen[n] || 0) + 1) > 1 ? `${n}${seen[n]}` : n));
}

function values(db, dsl) {
  const r = db.query(dsl);
  if (r.status !== "ok") throw new Error(`schema query failed: ${JSON.stringify(r.response)}`);
  return r.response;
}

// For each argument position, a variable-style role name: the class most of
// its atom values belong to (Work, Person, ...), or the literal type (Year, Text).
function argumentRoles(db, p, classes) {
  const vars = p.arguments.map((_, i) => `A${i}`);
  const res = values(db, `find ${vars.join(", ")}\nwhere\n  ${p.name}(${vars.join(", ")})`);
  return numbered(
    p.arguments.map((arg, i) => {
      if (!arg.types.includes("atom")) return typeVar(arg.types);
      const vals = res.results.map((row) => row[vars[i]]).filter((v) => v && v.type === "atom").map((v) => v.value);
      const shares = classes
        .map((c) => ({ name: c.name, share: vals.filter((v) => c.members.has(v)).length / (vals.length || 1) }))
        .filter((c) => c.share >= 0.3)
        .sort((a, b) => b.share - a.share);
      if (!shares.length) return "Thing";
      // Mixed columns (works and people are both "exhibited_at") get both names.
      return shares[0].share >= 0.8 || shares.length === 1
        ? pascal(shares[0].name)
        : `${pascal(shares[0].name)}Or${pascal(shares[1].name)}`;
    }),
  );
}

export function buildSchema(db) {
  const meta = db.predicates();
  const preds = meta.predicates;
  const classes = preds
    .filter((p) => p.arity === 1 && p.count >= CLASS_MIN_FACTS && p.arguments[0].types.join() === "atom")
    .map((p) => ({
      name: p.name,
      members: new Set(values(db, `find X\nwhere\n  ${p.name}(X)`).results.map((r) => r.X.value)),
    }))
    // Prefer the most specific class when shares tie (smaller sets first).
    .sort((a, b) => a.members.size - b.members.size);

  const byCount = [...preds].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const detailed = byCount.filter((p) => p.count >= DETAIL_MIN_FACTS);
  const rest = byCount.filter((p) => p.count < DETAIL_MIN_FACTS);

  const detailLines = detailed.map((p) => {
    const roles = p.arity === 1 ? [pascal(p.name)] : argumentRoles(db, p, classes);
    const ex = p.examples[0] ? `  e.g. ${p.name}(${p.examples[0].map(literal).join(", ")})` : "";
    return `${p.name}(${roles.join(", ")})${ex}`;
  });

  const groups = new Map();
  for (const p of rest) {
    const sig = `(${numbered(p.arguments.map((a) => (a.types.includes("atom") ? "Thing" : typeVar(a.types)))).join(", ")})`;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(p.name);
  }
  const groupLines = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([sig, names]) => `${sig}: ${names.sort().join(", ")}`);

  const text =
    `Main predicates, with argument roles and a real example fact:\n${detailLines.join("\n")}\n\n` +
    `Other predicates (few facts each), grouped by arguments:\n${groupLines.join("\n")}`;

  const signatures = new Map(
    rest.map((p) => [p.name, `${p.name}${[...groups.entries()].find(([, names]) => names.includes(p.name))[0]}`]),
  );
  for (let i = 0; i < detailed.length; i++) signatures.set(detailed[i].name, detailLines[i].split("  e.g.")[0]);

  return {
    text,
    meta,
    signatures,
    names: new Set(preds.map((p) => p.name)),
    fingerprint: meta.environmentFingerprint,
    stats: { predicates: preds.length, detailed: detailed.length, classes: classes.map((c) => c.name) },
  };
}
