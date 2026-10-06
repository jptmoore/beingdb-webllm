// Deterministic per-question evidence for benchmark reports: failure category,
// predicate / argument / entity evidence and result signatures. Pure functions
// over the db.query() wrapper, shared by the browser benchmark and Node
// re-analysis. No model is involved in any judgement here.
import { predicatesIn } from "./prompt.js";
import { judge, matchColumns, scoreItem } from "./score.js";

// Bump when classification rules change, so runs record which rules produced their categories.
export const ANALYSIS_VERSION = "taxonomy/1";

export const FAILURE_CATEGORIES = [
  "syntax_generation",
  "unknown_predicate",
  "wrong_predicate",
  "wrong_argument_order",
  "entity_grounding",
  "literal_vs_variable",
  "wrong_join",
  "missing_constraint",
  "wrong_constraint",
  "wrong_projection",
  "wrong_ordering",
  "unsupported_not_detected",
  "supported_marked_unsupported",
  "validation_repair_failed",
  "invalid_query", // first-attempt field only: rejected by BeingDB before any repair
  "runtime_model_failure",
  "unclassified",
];

// Result rows kept per attempt; the rest are re-derivable by re-running the DSL.
export const MAX_STORED_ROWS = 200;

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cell = (v) => (v ? `${v.type}:${v.value}` : "null");
const canonicalRows = (res, cols) => [...new Set(res.results.map((r) => JSON.stringify(cols.map((c) => cell(r[c])))))].sort();
// Order-insensitive signature of the distinct rows on the given columns (names ignored).
export const rowsSha256 = (res, cols = res.variables) => sha256(JSON.stringify(canonicalRows(res, cols)));

// ---- DSL surface parsing (for evidence only; BeingDB remains the validator) ----

function splitArgs(s) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((a) => a !== "");
}

function term(text) {
  const kind =
    text === "_" ? "wildcard"
    : /^[A-Z]/.test(text) ? "variable"
    : /^@/.test(text) ? "temporal"
    : /^-?\d/.test(text) ? "number"
    : /^"/.test(text) ? "string"
    : /^</.test(text) ? "uri"
    : /^(true|false)$/.test(text) ? "boolean"
    : "atom";
  return { text, kind };
}

export function parseDsl(dsl) {
  const lines = (dsl || "").split("\n");
  const find = (lines[0].match(/^find\s+(?:distinct\s+)?(.*)$/)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const clauses = [];
  const orderBy = [];
  let block = null;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t === "where") continue;
    if (/^(not|optional|either|or)$/.test(t)) {
      block = t;
      continue;
    }
    if (t.startsWith("order by ")) {
      orderBy.push(...t.slice(9).split(",").map((s) => s.trim().split(/\s+/)[0]));
      continue;
    }
    if (/^(limit|offset)\b/.test(t)) continue;
    const indent = raw.length - raw.trimStart().length;
    const inBlock = indent >= 4 ? block : null;
    const m = t.match(/^([a-z][a-z0-9_]*)\((.*)\)$/);
    if (m) clauses.push({ kind: "pattern", predicate: m[1], args: splitArgs(m[2]).map(term), block: inBlock, line: i + 1 });
    else
      clauses.push({
        kind: "comparison",
        text: t,
        terms: t.split(/\s+(?:=|!=|<=|>=|<|>|between|and)\s+/).map((s) => term(s.trim())),
        block: inBlock,
        line: i + 1,
      });
  }
  return { find, clauses, orderBy };
}

const CONSTANT_KINDS = new Set(["atom", "temporal", "number", "string", "uri", "boolean"]);
const numericKind = (k) => (k === "temporal" || k === "number" ? "numeric" : k);

function constantsOf(parsed) {
  const seen = new Map();
  for (const c of parsed.clauses)
    for (const t of c.kind === "pattern" ? c.args : c.terms) if (CONSTANT_KINDS.has(t.kind) && !seen.has(t.text)) seen.set(t.text, t);
  return [...seen.values()];
}

const variablesOf = (parsed) => [
  ...new Set(parsed.clauses.flatMap((c) => (c.kind === "pattern" ? c.args : c.terms)).filter((t) => t.kind === "variable").map((t) => t.text)),
];

// Elsa_Stansfield / ElsaStansfield -> elsa_stansfield
const variableAsAtom = (v) => [v.toLowerCase(), v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()];
const nameTokens = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

// Variables that stand in for reference constant c: the same name as a variable, or a
// single-use variable in c's argument slot that shares a name token (Scratch_Volume_1).
function variablesForConstant(c, refParsed, genParsed) {
  const exact = variablesOf(genParsed).filter((v) => variableAsAtom(v).includes(c.text));
  if (exact.length) return exact;
  const uses = new Map();
  for (const k of genParsed.clauses) for (const t of k.kind === "pattern" ? k.args : k.terms) if (t.kind === "variable") uses.set(t.text, (uses.get(t.text) || 0) + 1);
  const wanted = new Set(nameTokens(c.text));
  const out = new Set();
  for (const r of refParsed.clauses.filter((k) => k.kind === "pattern"))
    r.args.forEach((a, i) => {
      if (a.text !== c.text) return;
      for (const g of genParsed.clauses.filter((k) => k.kind === "pattern" && k.predicate === r.predicate)) {
        const v = g.args[i];
        if (v?.kind === "variable" && uses.get(v.text) === 1 && !genParsed.find.includes(v.text) && nameTokens(v.text).some((t) => wanted.has(t))) out.add(v.text);
      }
    });
  return [...out];
}

// ---- Context from the loaded pack (built once per page) ----

export function buildAnalysisContext(db, schema) {
  const atoms = new Map(); // atom -> Set("predicate/position")
  for (const p of schema.meta.predicates) {
    const vars = p.arguments.map((_, i) => `A${i}`);
    const r = db.query(`find ${vars.join(", ")}\nwhere\n  ${p.name}(${vars.join(", ")})`);
    if (r.status !== "ok") continue;
    for (const row of r.response.results)
      vars.forEach((v, i) => {
        const c = row[v];
        if (c?.type !== "atom") return;
        if (!atoms.has(c.value)) atoms.set(c.value, new Set());
        atoms.get(c.value).add(`${p.name}/${i}`);
      });
  }
  const byName = new Map(schema.meta.predicates.map((p) => [p.name, p]));
  // Role names shown to the model (Work, Person, WorkOrPerson...) and class predicates, lowercased.
  const roles = new Set(schema.stats.classes);
  for (const sig of schema.signatures.values())
    for (const r of (sig.match(/\(([^)]*)\)/)?.[1] || "").split(",")) roles.add(r.trim().replace(/\d+$/, "").toLowerCase());
  const exampleInPrompt = new Set([...byName.keys()].filter((n) => schema.text.includes(`e.g. ${n}(`)));
  return { atoms, byName, roles, exampleInPrompt };
}

function grounding(pattern, ctx) {
  return pattern.args.map((a, i) => {
    if (a.kind !== "atom") return { position: i, text: a.text, kind: a.kind };
    const where = ctx.atoms.get(a.text);
    const samePred = where ? [...where].filter((w) => w.startsWith(`${pattern.predicate}/`)).map((w) => Number(w.split("/")[1])) : [];
    return {
      position: i,
      text: a.text,
      kind: "atom",
      inPack: !!where,
      atThisPosition: samePred.includes(i),
      // The atom occurs in this predicate, but only at another position: reversed-role evidence.
      onlyAtOtherPositions: samePred.length > 0 && !samePred.includes(i) ? samePred : null,
      predicatesUsingAtom: where ? where.size : 0,
      isRoleName: ctx.roles.has(a.text),
    };
  });
}

// ---- Classification ----

const errorsOf = (response) => response?.errors || (response?.error ? [response.error] : []);
const errorCodes = (attempt) => [...new Set(errorsOf(attempt.db?.response).map((e) => e.code))];

const PATTERN_LINE = /^(\s*)([a-z][a-z0-9_]*)\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)\s*$/;

// Predicates whose (single) argument swap makes the query correct, checked by BeingDB.
function swapProbe(item, ref, dsl, db) {
  const lines = dsl.split("\n");
  const fixed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PATTERN_LINE);
    if (!m) continue;
    const swapped = [...lines];
    swapped[i] = `${m[1]}${m[2]}(${m[4]}, ${m[3]})`;
    const r = db.query(swapped.join("\n"));
    if (r.status === "ok" && judge(item, ref, r.response).correct) fixed.push({ predicate: m[2], line: i + 1 });
  }
  return fixed;
}

function combinations(xs, k) {
  if (k === 0) return [[]];
  return xs.flatMap((x, i) => combinations(xs.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
}

function classifyValidWrong(item, ref, gen, dsl, db, ctx) {
  const keys = item.key || ref.variables;
  const v = judge(item, ref, gen);
  if (v.orderWrong) return { category: "wrong_ordering", rule: "right rows, wrong order on the orderBy column", evidence: { orderBy: item.orderBy } };

  if (gen.variables.length < keys.length) {
    const subset = combinations(keys, gen.variables.length).find((ks) => ks.length && matchColumns(ref, ks, gen));
    if (subset)
      return {
        category: "wrong_projection",
        rule: "rows match the reference on a subset of the answer columns",
        evidence: { matchedKeys: subset, missingKeys: keys.filter((k) => !subset.includes(k)) },
      };
  }

  const refParsed = parseDsl(item.reference);
  const genParsed = parseDsl(dsl);
  const genPreds = predicatesIn(dsl);
  const missingPreds = item.predicates.filter((p) => !genPreds.includes(p));
  if (missingPreds.length)
    return {
      category: "wrong_predicate",
      rule: "a required reference predicate is absent",
      evidence: { missing: missingPreds, used: genPreds, extra: genPreds.filter((p) => !predicatesIn(item.reference).includes(p)) },
    };

  const swaps = swapProbe(item, ref, dsl, db);
  if (swaps.length) return { category: "wrong_argument_order", rule: "swapping one pattern's arguments makes the answer correct (BeingDB re-run)", evidence: { swaps } };

  const refC = constantsOf(refParsed);
  const genC = constantsOf(genParsed);
  const genTexts = new Set(genC.map((c) => c.text));
  const refTexts = new Set(refC.map((c) => c.text));
  const missing = refC.filter((c) => !genTexts.has(c.text));
  const extra = genC.filter((c) => !refTexts.has(c.text));
  const extraAtoms = extra.filter((c) => c.kind === "atom");
  const unknownAtoms = extraAtoms.filter((c) => !ctx.atoms.has(c.text)).map((c) => c.text);

  if (missing.length) {
    const asVariable = missing.filter((c) => c.kind === "atom").map((c) => ({ c, vars: variablesForConstant(c, refParsed, genParsed) })).filter((x) => x.vars.length);
    if (asVariable.length)
      return {
        category: "literal_vs_variable",
        rule: "a reference constant is written as a variable (same name, or a single-use similarly named variable in its place)",
        evidence: { constants: asVariable.map((x) => x.c.text), variables: [...new Set(asVariable.flatMap((x) => x.vars))] },
      };
    if (unknownAtoms.length && missing.some((c) => c.kind === "atom"))
      return {
        category: "entity_grounding",
        rule: "a reference entity is missing and the query uses an atom that does not exist in the pack",
        evidence: { missing: missing.map((c) => c.text), unknownAtoms },
      };
    const replacedBy = extra.filter((e) => missing.some((m) => numericKind(m.kind) === numericKind(e.kind)));
    if (replacedBy.length)
      return {
        category: "wrong_constraint",
        rule: "a reference constant is replaced by a different constant of the same kind",
        evidence: { missing: missing.map((c) => c.text), replacedBy: replacedBy.map((c) => c.text) },
      };
    return { category: "missing_constraint", rule: "a reference constant or bound is absent", evidence: { missing: missing.map((c) => c.text) } };
  }

  if (unknownAtoms.length) {
    const roleAtoms = unknownAtoms.filter((a) => ctx.roles.has(a));
    if (roleAtoms.length)
      return { category: "literal_vs_variable", rule: "a role/class name is written as a lowercase atom", evidence: { atoms: roleAtoms } };
    return { category: "entity_grounding", rule: "the query uses an atom that does not exist in the pack", evidence: { unknownAtoms } };
  }
  if (extra.length) return { category: "wrong_constraint", rule: "extra constants not in the reference", evidence: { extra: extra.map((c) => c.text) } };
  if (gen.variables.length < keys.length) return { category: "wrong_projection", rule: "fewer answer columns than the reference", evidence: { generated: gen.variables, keys } };
  const refPatterns = refParsed.clauses.filter((c) => c.kind === "pattern").length;
  const genPatterns = genParsed.clauses.filter((c) => c.kind === "pattern").length;
  if (refPatterns >= 2 && genPatterns >= 2)
    return { category: "wrong_join", rule: "right predicates and constants, wrong rows, multi-pattern query", evidence: { refPatterns, genPatterns } };
  return { category: "unclassified", rule: "valid but wrong; no deterministic rule applies", evidence: {} };
}

// null = correct. `final` selects the name for invalid queries.
export function classifyAttempt(item, ref, attempt, db, ctx, { final }) {
  if (!attempt) return { category: "runtime_model_failure", rule: "no model reply", evidence: {} };
  const reply = attempt.reply;
  if (!item.reference) {
    if (reply.status === "unsupported") return null;
    const preds = reply.dsl ? predicatesIn(reply.dsl) : [];
    const fabricated = attempt.db?.status === "ok";
    return {
      category: "unsupported_not_detected",
      rule: fabricated ? "valid query for an unsupported question" : "query (invalid) instead of UNSUPPORTED",
      evidence: { fabricated, predicates: preds, rows: fabricated ? attempt.db.response.count : null, errorCodes: fabricated ? [] : errorCodes(attempt) },
    };
  }
  if (reply.status === "unsupported") return { category: "supported_marked_unsupported", rule: "model replied UNSUPPORTED", evidence: { reason: reply.reason } };
  if (reply.status !== "ok") return { category: "syntax_generation", rule: "reply is neither a query nor UNSUPPORTED", evidence: { error: reply.error, finish: attempt.finish } };
  if (attempt.db?.status !== "ok") {
    const codes = errorCodes(attempt);
    const evidence = { errorCodes: codes, messages: errorsOf(attempt.db?.response).map((e) => e.message), finish: attempt.finish };
    if (codes.includes("syntax_error")) return { category: "syntax_generation", rule: "BeingDB syntax_error", evidence };
    if (codes.includes("unknown_predicate")) return { category: "unknown_predicate", rule: "BeingDB unknown_predicate", evidence };
    return final
      ? { category: "validation_repair_failed", rule: "still rejected by BeingDB after the repair budget", evidence }
      : { category: "invalid_query", rule: "rejected by BeingDB", evidence };
  }
  if (judge(item, ref, attempt.db.response).correct) return null;
  return classifyValidWrong(item, ref, attempt.db.response, reply.dsl, db, ctx);
}

// ---- Schema / predicate evidence ----

function argumentOrder(refParsed, genParsed) {
  const out = [];
  for (const g of genParsed.clauses.filter((c) => c.kind === "pattern")) {
    const refs = refParsed.clauses.filter((c) => c.kind === "pattern" && c.predicate === g.predicate);
    if (!refs.length) continue;
    let status = "not_comparable";
    const evidence = [];
    for (const r of refs)
      r.args.forEach((ra, i) => {
        if (!CONSTANT_KINDS.has(ra.kind)) return;
        const j = g.args.findIndex((ga) => ga.text === ra.text);
        if (j < 0) return;
        evidence.push({ constant: ra.text, referencePosition: i, generatedPosition: j });
        if (j !== i) status = "reversed";
        else if (status !== "reversed") status = "same";
      });
    out.push({ predicate: g.predicate, line: g.line, status, evidence });
  }
  return out;
}

export function schemaEvidence(item, firstDsl, finalDsl, schema, ctx) {
  const refPreds = item.reference ? predicatesIn(item.reference) : [];
  const genPreds = finalDsl ? predicatesIn(finalDsl) : [];
  const firstPreds = firstDsl ? predicatesIn(firstDsl) : [];
  const required = item.predicates || [];
  const refParsed = parseDsl(item.reference || "");
  const genParsed = parseDsl(finalDsl || "");
  const refC = constantsOf(refParsed).map((c) => c.text);
  const genC = constantsOf(genParsed).map((c) => c.text);
  const order = item.reference ? argumentOrder(refParsed, genParsed) : [];
  const missing = required.filter((p) => !genPreds.includes(p));
  const describe = (n) => {
    const p = ctx.byName.get(n);
    return {
      signature: schema.signatures.get(n) ?? null,
      arity: p?.arity ?? null,
      facts: p?.count ?? null,
      exampleInPrompt: ctx.exampleInPrompt.has(n),
      example: p?.examples?.[0] ?? null,
    };
  };
  return {
    requiredPredicates: required,
    referencePredicates: refPreds,
    firstAttemptPredicates: firstPreds,
    generatedPredicates: genPreds,
    missingPredicates: item.reference ? missing : [],
    extraPredicates: genPreds.filter((p) => !refPreds.includes(p)),
    predicateSelectionCorrect: item.reference && finalDsl ? missing.length === 0 : null,
    exactPredicateSet: item.reference && finalDsl ? missing.length === 0 && genPreds.every((p) => refPreds.includes(p)) : null,
    predicates: Object.fromEntries([...new Set([...refPreds, ...firstPreds, ...genPreds])].map((n) => [n, describe(n)])),
    constants: { reference: refC, generated: genC, missing: refC.filter((c) => !genC.includes(c)), extra: genC.filter((c) => !refC.includes(c)) },
    referenceGrounding: refParsed.clauses.filter((c) => c.kind === "pattern").map((c) => ({ predicate: c.predicate, line: c.line, args: grounding(c, ctx) })),
    generatedGrounding: genParsed.clauses.filter((c) => c.kind === "pattern").map((c) => ({ predicate: c.predicate, line: c.line, block: c.block, args: grounding(c, ctx) })),
    argumentOrder: order,
    argumentOrderCorrect: order.some((o) => o.status === "reversed") ? false : order.some((o) => o.status === "same") ? true : null,
  };
}

// ---- Timing ----

export function attemptTiming(a) {
  const x = a.usage?.extra || {};
  const ms = (s) => (typeof s === "number" ? s * 1000 : null);
  const ttftMs = ms(x.time_to_first_token_s);
  const e2eMs = ms(x.e2e_latency_s);
  const grammarInitMs = ms(x.grammar_init_s);
  return {
    llmMs: a.llmMs ?? null,
    promptTokens: a.usage?.prompt_tokens ?? null,
    completionTokens: a.usage?.completion_tokens ?? null,
    // WebLLM's time to first token includes grammar compilation (grammarInitMs) on first use.
    ttftMs,
    prefillMs: ttftMs !== null ? ttftMs - (grammarInitMs || 0) : null,
    decodeMs: ttftMs !== null && e2eMs !== null ? e2eMs - ttftMs : null,
    e2eMs,
    prefillTokPerS: x.prefill_tokens_per_s ?? null,
    decodeTokPerS: x.decode_tokens_per_s ?? null,
    grammarInitMs,
    grammarPerTokenMs: ms(x.grammar_per_token_s),
  };
}

// ---- Per-question record ----

async function serialiseAttempt(a, i, item, ref) {
  let beingdb = null;
  if (a.db) {
    const r = a.db.response;
    beingdb = {
      status: a.db.status,
      ms: a.db.ms,
      count: r.count ?? null,
      variables: r.variables ?? null,
      errors: r.errors ?? null,
      warnings: r.warnings ?? null,
      error: r.error ?? null,
      rowsSha256: r.results ? await rowsSha256(r) : null,
      rows: r.results ? r.results.slice(0, MAX_STORED_ROWS) : null,
      rowsTruncated: r.results ? r.results.length > MAX_STORED_ROWS : false,
    };
  }
  let verdict = null;
  if (item.reference && a.db?.status === "ok") {
    const v = judge(item, ref, a.db.response);
    verdict = { correct: v.correct, orderWrong: !!v.orderWrong, exactProjection: !!v.exactProjection, matchedColumns: matchColumns(ref, item.key || ref.variables, a.db.response) };
  }
  return {
    n: i + 1,
    grammar: a.grammar ?? null,
    request: a.request ?? null,
    raw: a.raw,
    reply: a.reply,
    finish: a.finish ?? null,
    usage: a.usage ?? null,
    timing: attemptTiming(a),
    beingdb,
    verdict,
    // The repair message sent back to the model after this attempt (if any).
    feedback: a.feedback ?? null,
    // db-guided condition: BeingDB diagnoses of this reply and the proven repairs applied to it.
    guided: a.guided ?? null,
  };
}

function questionInfo(item) {
  return {
    id: item.id,
    level: item.level,
    tags: item.tags || [],
    supported: !!item.reference,
    text: item.question,
    reference: item.reference ?? null,
    predicates: item.predicates ?? [],
    key: item.key ?? null,
    orderBy: item.orderBy ?? null,
    unsupportedReason: item.reason ?? null,
  };
}

async function referenceInfo(item, db) {
  if (!item.reference) return { ref: null, info: null };
  const r = db.query(item.reference);
  if (r.status !== "ok") throw new Error(`reference ${item.id} is not valid: ${JSON.stringify(r.response)}`);
  const ref = r.response;
  const keys = item.key || ref.variables;
  return {
    ref,
    info: {
      count: ref.count,
      variables: ref.variables,
      key: keys,
      distinctKeyRows: canonicalRows(ref, keys).length,
      keyRowsSha256: await rowsSha256(ref, keys),
      rowsSha256: await rowsSha256(ref),
      ms: r.ms,
    },
  };
}

// run: the object returned by pipeline.ask() (attempts with full BeingDB responses).
export async function analyseQuestion({ item, run, db, schema, ctx }) {
  const { ref, info } = await referenceInfo(item, db);
  const legacy = scoreItem(item, run, db);
  const attempts = [];
  for (const [i, a] of run.attempts.entries()) attempts.push(await serialiseAttempt(a, i, item, ref));
  const first = run.attempts[0];
  const last = run.attempts.at(-1);
  const failure = classifyAttempt(item, ref, last, db, ctx, { final: true });
  const firstAttemptFailure = classifyAttempt(item, ref, first, db, ctx, { final: false });
  const llm = run.attempts.map((a) => a.llmMs);
  return {
    question: questionInfo(item),
    reference: info,
    outcome: run.outcome,
    repairs: run.repairs,
    attempts,
    final: {
      attempt: run.attempts.length,
      reply: last.reply.status,
      dsl: last.reply.dsl ?? null,
      valid: last.db?.status === "ok",
      rowsSha256: attempts.at(-1).beingdb?.rowsSha256 ?? null,
    },
    score: {
      supported: !!item.reference,
      firstValid: item.reference ? first.db?.status === "ok" : null,
      finalValid: item.reference ? last.db?.status === "ok" : null,
      firstCorrect: legacy.firstCorrect,
      correct: legacy.correct,
      exactProjection: legacy.exactProjection ?? null,
      predicatesOk: legacy.predicatesOk ?? null,
      fabricated: legacy.fabricated ?? null,
      falseRefusal: !!item.reference && run.outcome === "unsupported",
      legacyFailure: legacy.failure ?? null,
    },
    failure,
    firstAttemptFailure,
    schemaEvidence: schemaEvidence(item, first.reply.dsl, last.reply.dsl, schema, ctx),
    timing: {
      llmMs: run.llmMs,
      dbMs: run.dbMs,
      totalMs: run.totalMs,
      otherMs: run.totalMs - run.llmMs - run.dbMs,
      llmCalls: llm.length,
      dbQueries: run.attempts.filter((a) => a.db).length,
      firstAttemptLlmMs: llm[0],
      repairLlmMs: llm.slice(1).reduce((s, x) => s + x, 0),
    },
    // Which calls the question cost: model calls are expensive, BeingDB calls cheap.
    efficiency: {
      pipeline: run.pipeline ?? null,
      calls: run.calls ?? null,
      beingdbMs: run.beingdbMs ?? null,
      deterministicRepairs: run.deterministicRepairs ?? [],
      diagnosticCodes: run.diagnosticCodes ?? [],
      path: run.path ?? null,
    },
  };
}

// A question the pipeline could not finish (engine error, device lost, timeout).
export async function analyseError({ item, error, attempts = [], db }) {
  const { ref, info } = await referenceInfo(item, db);
  return {
    question: questionInfo(item),
    reference: info,
    outcome: "error",
    repairs: Math.max(0, attempts.length - 1),
    attempts: await Promise.all(attempts.map((a, i) => serialiseAttempt(a, i, item, ref))),
    final: { attempt: attempts.length, reply: null, dsl: null, valid: false, rowsSha256: null },
    score: {
      supported: !!item.reference,
      firstValid: item.reference ? false : null,
      finalValid: item.reference ? false : null,
      firstCorrect: false,
      correct: false,
      exactProjection: null,
      predicatesOk: null,
      fabricated: null,
      falseRefusal: false,
      legacyFailure: "error",
    },
    failure: { category: "runtime_model_failure", rule: "the model call threw", evidence: { message: String(error?.message || error) } },
    firstAttemptFailure: { category: "runtime_model_failure", rule: "the model call threw", evidence: {} },
    schemaEvidence: null,
    timing: { llmMs: attempts.reduce((s, a) => s + (a.llmMs || 0), 0), dbMs: attempts.reduce((s, a) => s + (a.db?.ms || 0), 0), totalMs: null, llmCalls: attempts.length, dbQueries: attempts.filter((a) => a.db).length },
  };
}
