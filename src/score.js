// Scoring: compare what BeingDB returns for the generated query with what it
// returns for the trusted reference query. Pure functions over a db.query()
// wrapper, so the same code runs in the browser eval and in Node.
import { predicatesIn } from "./prompt.js";

const cell = (v) => (v ? `${v.type}:${v.value}` : "null");
const rowSet = (rows, cols) => new Set(rows.map((r) => JSON.stringify(cols.map((c) => cell(r[c])))));
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const collapse = (seq) => seq.filter((x, i) => i === 0 || x !== seq[i - 1]);

// Ordered selections of k distinct columns.
function* selections(cols, k) {
  if (k === 0) return yield [];
  for (let i = 0; i < cols.length; i++)
    for (const rest of selections([...cols.slice(0, i), ...cols.slice(i + 1)], k - 1)) yield [cols[i], ...rest];
}

// Find generated columns whose distinct rows equal the reference key rows
// (variable names and column order are free; extra generated columns allowed).
export function matchColumns(ref, keys, gen) {
  const target = rowSet(ref.results, keys);
  for (const sel of selections(gen.variables, keys.length)) if (setEq(rowSet(gen.results, sel), target)) return sel;
  return null;
}

function orderMatches(ref, gen, keys, sel, orderBy) {
  const genCol = sel[keys.indexOf(orderBy)];
  const a = collapse(ref.results.map((r) => cell(r[orderBy])));
  const b = collapse(gen.results.map((r) => cell(r[genCol])));
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function judge(item, ref, gen) {
  const keys = item.key || ref.variables;
  const sel = matchColumns(ref, keys, gen);
  if (!sel) return { correct: false };
  if (item.orderBy && !orderMatches(ref, gen, keys, sel, item.orderBy)) return { correct: false, orderWrong: true };
  return { correct: true, exactProjection: gen.variables.length === keys.length };
}

const PATTERN_LINE = /^(\s*)([a-z][a-z0-9_]*)\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)\s*$/;

// Literal constants (atoms, years, numbers) used in clause arguments or comparisons.
export function constantsIn(dsl) {
  const out = new Set();
  const lines = dsl.split("\n").slice(1);
  for (const line of lines) {
    const t = line.trim();
    if (/^(where|not|optional|either|or|order by|limit|offset)\b/.test(t)) continue;
    const args = t.match(/\(([^)]*)\)/);
    const parts = args ? args[1].split(",") : t.split(/\s+(?:=|!=|<=|>=|<|>|between|and)\s+|\s+/);
    for (const p of parts.map((s) => s.trim())) {
      if (/^@?\d+$/.test(p)) out.add(p.replace(/^@/, ""));
      else if (/^[a-z][a-z0-9_]*$/.test(p) && !["between", "and"].includes(p)) out.add(p);
      else if (/^".*"$/.test(p)) out.add(p);
    }
  }
  return out;
}

// Diagnose a valid-but-wrong query. The argument-order probe swaps each
// binary pattern in turn and asks BeingDB whether that makes it correct.
function diagnose(item, ref, genRun, dsl, db) {
  if (!item.predicates.every((p) => predicatesIn(dsl).includes(p))) return "wrong predicate";
  const lines = dsl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PATTERN_LINE);
    if (!m) continue;
    const swapped = [...lines];
    swapped[i] = `${m[1]}${m[2]}(${m[4]}, ${m[3]})`;
    const r = db.query(swapped.join("\n"));
    if (r.status === "ok" && judge(item, ref, r.response).correct) return `argument order (${m[2]})`;
  }
  const missing = [...constantsIn(item.reference)].filter((c) => !constantsIn(dsl).has(c));
  if (missing.length) return `constant/bound (${missing.join(", ")})`;
  const keys = item.key || ref.variables;
  if (genRun.variables.length < keys.length) return "missing output variable";
  if (judge({ ...item, orderBy: undefined }, ref, genRun).correct) return "ordering";
  return "other (join/semantics)";
}

export function scoreItem(item, run, db) {
  const first = run.attempts[0];
  const last = run.attempts.at(-1);
  const s = { id: item.id, level: item.level, tags: item.tags, supported: !!item.reference, outcome: run.outcome, repairs: run.repairs };
  if (!item.reference) {
    s.firstCorrect = first.reply.status === "unsupported";
    s.correct = run.outcome === "unsupported";
    s.fabricated = run.outcome === "ok";
    if (!s.correct) s.failure = run.outcome === "ok" ? "fabricated a query" : "no valid query (not flagged unsupported)";
    return s;
  }
  const refRun = db.query(item.reference);
  if (refRun.status !== "ok") throw new Error(`reference ${item.id} is not valid: ${JSON.stringify(refRun.response)}`);
  const ref = refRun.response;
  const verdict = (a) => (a && a.db && a.db.status === "ok" ? judge(item, ref, a.db.response) : { correct: false });

  s.firstValid = first.db?.status === "ok";
  s.finalValid = last.db?.status === "ok";
  const v1 = verdict(first);
  const v2 = verdict(last);
  s.firstCorrect = v1.correct;
  s.correct = v2.correct;
  s.exactProjection = !!v2.exactProjection;
  const dsl = last.reply.dsl || "";
  s.predicatesOk = s.finalValid && item.predicates.every((p) => predicatesIn(dsl).includes(p));
  if (!s.correct) {
    if (run.outcome === "unsupported") s.failure = "refused (said unsupported)";
    else if (!s.finalValid) {
      const errs = last.db?.response?.errors?.map((e) => e.code) || [last.reply.error || last.db?.response?.error?.code];
      s.failure = `invalid (${[...new Set(errs)].join(", ")})`;
    } else s.failure = diagnose(item, ref, last.db.response, dsl, db);
  }
  return s;
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "-");
const count = (xs, f) => xs.filter(f).length;

export function summarise(scores, runs) {
  const sup = scores.filter((s) => s.supported);
  const uns = scores.filter((s) => !s.supported);
  const llm = runs.flatMap((r) => r.attempts.map((a) => a.llmMs)).sort((a, b) => a - b);
  const dbq = runs.flatMap((r) => r.attempts.filter((a) => a.db).map((a) => a.db.ms)).sort((a, b) => a - b);
  const q = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
  const byTag = {};
  for (const s of sup)
    for (const t of [s.level, ...s.tags]) {
      byTag[t] ??= { n: 0, first: 0, final: 0 };
      byTag[t].n++;
      byTag[t].first += s.firstCorrect ? 1 : 0;
      byTag[t].final += s.correct ? 1 : 0;
    }
  const failures = {};
  for (const s of scores.filter((s) => !s.correct)) failures[s.failure] = (failures[s.failure] || 0) + 1;
  return {
    questions: scores.length,
    supported: sup.length,
    unsupported: uns.length,
    firstValid: pct(count(sup, (s) => s.firstValid), sup.length),
    firstCorrect: pct(count(sup, (s) => s.firstCorrect), sup.length),
    finalValid: pct(count(sup, (s) => s.finalValid), sup.length),
    finalCorrect: pct(count(sup, (s) => s.correct), sup.length),
    repairedToValid: count(sup, (s) => !s.firstValid && s.finalValid),
    repairedToCorrect: count(sup, (s) => !s.firstCorrect && s.correct),
    predicatesOk: pct(count(sup, (s) => s.predicatesOk), sup.length),
    exactProjection: pct(count(sup, (s) => s.exactProjection), count(sup, (s) => s.correct)),
    falseRefusals: count(sup, (s) => s.outcome === "unsupported"),
    unsupportedDetected: pct(count(uns, (s) => s.correct), uns.length),
    unsupportedFirstAttempt: pct(count(uns, (s) => s.firstCorrect), uns.length),
    fabricatedQueries: count(uns, (s) => s.fabricated),
    overallCorrect: pct(count(scores, (s) => s.correct), scores.length),
    byTag: Object.fromEntries(Object.entries(byTag).map(([t, v]) => [t, `first ${pct(v.first, v.n)}, final ${pct(v.final, v.n)}`])),
    failures,
    llmMsPerCall: { median: Math.round(q(llm, 0.5)), p90: Math.round(q(llm, 0.9)), calls: llm.length },
    dbMsPerQuery: { median: +q(dbq, 0.5).toFixed(2), p90: +q(dbq, 0.9).toFixed(2), max: +(dbq.at(-1) || 0).toFixed(2), queries: dbq.length },
    totalMsPerQuestion: { median: Math.round(q(runs.map((r) => r.totalMs).sort((a, b) => a - b), 0.5)) },
  };
}
