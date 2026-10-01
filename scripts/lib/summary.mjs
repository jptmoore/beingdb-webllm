// Deterministic summaries of benchmark question records (questions.jsonl):
// one per trial, plus an aggregate over trials. Used by the runner, compare and export.
import { summarise } from "../../src/score.js";

export function stats(xs) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const r = (x) => Math.round(x * 100) / 100;
  // Nearest-rank percentiles; true median (mean of the middle two for even n).
  const rank = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  const mid = v.length / 2;
  return {
    n: v.length,
    mean: r(v.reduce((s, x) => s + x, 0) / v.length),
    median: r(v.length % 2 ? v[Math.floor(mid)] : (v[mid - 1] + v[mid]) / 2),
    min: r(v[0]),
    max: r(v.at(-1)),
    p90: r(rank(0.9)),
    p95: r(rank(0.95)),
  };
}

const count = (xs, f) => xs.filter(f).length;
const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const sortTally = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

// Denominators for every rate: supported (S), unsupported (U), all (A).
const RATE_BASE = {
  firstValid: "S",
  finalValid: "S",
  firstCorrect: "S",
  finalCorrect: "S",
  predicateSelectionCorrect: "S",
  falseRefusals: "S",
  unsupportedDetected: "U",
  unsupportedFirstAttempt: "U",
  fabricated: "U",
  overallCorrect: "A",
  runtimeFailures: "A",
};

export function timingSummary(records) {
  const attempts = records.flatMap((r) => r.attempts);
  const first = records.map((r) => r.attempts[0]).filter(Boolean);
  const repairs = records.flatMap((r) => r.attempts.slice(1));
  const t = (as, k) => stats(as.map((a) => a.timing?.[k]));
  const db = (as) => stats(as.filter((a) => a.beingdb).map((a) => a.beingdb.ms));
  return {
    model: {
      msPerCall: t(attempts, "llmMs"),
      firstAttemptMs: t(first, "llmMs"),
      repairAttemptMs: t(repairs, "llmMs"),
      msPerQuestion: stats(records.map((r) => r.timing?.llmMs)),
      firstAttemptPromptTokens: t(first, "promptTokens"),
      repairPromptTokens: t(repairs, "promptTokens"),
      completionTokens: t(attempts, "completionTokens"),
      firstAttemptTtftMs: t(first, "ttftMs"),
      firstAttemptPrefillMs: t(first, "prefillMs"),
      decodeMs: t(attempts, "decodeMs"),
      firstAttemptPrefillTokPerS: t(first, "prefillTokPerS"),
      decodeTokPerS: t(attempts, "decodeTokPerS"),
      grammarInitMs: stats(attempts.map((a) => a.timing?.grammarInitMs).filter((x) => x > 0)),
      calls: attempts.length,
    },
    beingdb: {
      msPerQuery: db(attempts),
      firstAttemptQueryMs: db(first),
      repairQueryMs: db(repairs),
      msPerQuestion: stats(records.map((r) => r.timing?.dbMs)),
      referenceQueryMs: stats(records.map((r) => r.reference?.ms)),
      queries: attempts.filter((a) => a.beingdb).length,
    },
    totalMsPerQuestion: stats(records.map((r) => r.timing?.totalMs)),
    page: {
      hiddenMs: records.reduce((s, r) => s + (r.page?.hiddenMs || 0), 0),
      questionsWhileHidden: count(records, (r) => (r.page?.hiddenMs || 0) > 0 || r.page?.visibilityState === "hidden"),
    },
  };
}

// Evidence for "is the model weak, or is the schema/entity information insufficient?"
export function schemaSummary(records) {
  const sup = records.filter((r) => r.question.supported && r.schemaEvidence);
  const wrong = sup.filter((r) => !r.score.correct);
  const confusions = {};
  for (const r of wrong) {
    const ev = r.schemaEvidence;
    for (const m of ev.missingPredicates) {
      const used = ev.extraPredicates.length ? ev.extraPredicates : ["(none)"];
      for (const e of used) {
        const k = `${m} -> ${e}`;
        (confusions[k] ??= { count: 0, questions: [] }).count++;
        confusions[k].questions.push(r.question.id);
      }
    }
  }
  const reversed = {};
  const bump = (p, k, id) => {
    const e = (reversed[p] ??= { swapFixes: 0, reversedVsReference: 0, atomOnlyAtOtherPosition: 0, questions: [] });
    e[k]++;
    if (!e.questions.includes(id)) e.questions.push(id);
  };
  for (const r of records) {
    const id = r.question.id;
    if (r.failure?.category === "wrong_argument_order") for (const s of r.failure.evidence.swaps) bump(s.predicate, "swapFixes", id);
    for (const o of r.schemaEvidence?.argumentOrder || []) if (o.status === "reversed") bump(o.predicate, "reversedVsReference", id);
    for (const g of r.schemaEvidence?.generatedGrounding || []) for (const a of g.args) if (a.onlyAtOtherPositions) bump(g.predicate, "atomOnlyAtOtherPosition", id);
  }
  const unknownAtoms = {};
  for (const r of records)
    for (const g of r.schemaEvidence?.generatedGrounding || [])
      for (const a of g.args) if (a.kind === "atom" && !a.inPack) (unknownAtoms[a.text] ??= []).push(r.question.id);
  const usage = {};
  for (const r of sup) {
    const ev = r.schemaEvidence;
    for (const p of ev.requiredPredicates) {
      const u = (usage[p] ??= { required: 0, present: 0, correctQuestions: 0, usedWhenNotRequired: 0, exampleInPrompt: ev.predicates[p]?.exampleInPrompt ?? null, facts: ev.predicates[p]?.facts ?? null });
      u.required++;
      if (ev.generatedPredicates.includes(p)) u.present++;
      if (r.score.correct) u.correctQuestions++;
    }
    for (const p of ev.extraPredicates) {
      const u = (usage[p] ??= { required: 0, present: 0, correctQuestions: 0, usedWhenNotRequired: 0, exampleInPrompt: ev.predicates[p]?.exampleInPrompt ?? null, facts: ev.predicates[p]?.facts ?? null });
      u.usedWhenNotRequired++;
    }
  }
  const unsupportedMapped = records.filter((r) => !r.question.supported && r.final?.dsl);
  return {
    predicateConfusions: Object.fromEntries(Object.entries(confusions).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))),
    reversedArguments: Object.fromEntries(Object.entries(reversed).sort((a, b) => b[1].questions.length - a[1].questions.length)),
    entityGroundingFailures: records
      .filter((r) => ["entity_grounding", "literal_vs_variable"].includes(r.failure?.category))
      .map((r) => ({ id: r.question.id, category: r.failure.category, evidence: r.failure.evidence })),
    unknownAtoms,
    failedDespiteCorrectPredicates: wrong
      .filter((r) => r.schemaEvidence.predicateSelectionCorrect)
      .map((r) => ({ id: r.question.id, category: r.failure?.category ?? null })),
    unsupportedMappedTo: sortTally(tally(unsupportedMapped.flatMap((r) => r.schemaEvidence?.generatedPredicates || []))),
    unsupportedMappedQuestions: unsupportedMapped.map((r) => ({ id: r.question.id, predicates: r.schemaEvidence?.generatedPredicates || [], valid: r.final.valid })),
    predicateUsage: Object.fromEntries(Object.entries(usage).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

// The pre-benchmark eval summary (strings like "14/38 (37%)"), for continuity with runs 2-8.
function legacySummary(records) {
  const scores = records.map((r) => ({
    supported: r.question.supported,
    level: r.question.level,
    tags: r.question.tags,
    outcome: r.outcome,
    firstValid: r.score.firstValid,
    finalValid: r.score.finalValid,
    firstCorrect: r.score.firstCorrect,
    correct: r.score.correct,
    exactProjection: r.score.exactProjection,
    predicatesOk: r.score.predicatesOk,
    fabricated: r.score.fabricated,
    failure: r.score.legacyFailure,
  }));
  const runs = records.map((r) => ({ attempts: r.attempts.map((a) => ({ llmMs: a.timing.llmMs, db: a.beingdb && { ms: a.beingdb.ms } })), totalMs: r.timing.totalMs || 0 }));
  return summarise(scores, runs);
}

export function trialSummary(records) {
  const sup = records.filter((r) => r.question.supported);
  const uns = records.filter((r) => !r.question.supported);
  const counts = {
    questions: records.length,
    supported: sup.length,
    unsupported: uns.length,
    firstValid: count(sup, (r) => r.score.firstValid),
    finalValid: count(sup, (r) => r.score.finalValid),
    firstCorrect: count(sup, (r) => r.score.firstCorrect),
    finalCorrect: count(sup, (r) => r.score.correct),
    repairedToValid: count(sup, (r) => !r.score.firstValid && r.score.finalValid),
    repairedToCorrect: count(sup, (r) => !r.score.firstCorrect && r.score.correct),
    predicateSelectionCorrect: count(sup, (r) => r.schemaEvidence?.predicateSelectionCorrect === true),
    falseRefusals: count(sup, (r) => r.score.falseRefusal),
    unsupportedDetected: count(uns, (r) => r.score.correct),
    unsupportedFirstAttempt: count(uns, (r) => r.score.firstCorrect),
    fabricated: count(uns, (r) => r.score.fabricated),
    overallCorrect: count(records, (r) => r.score.correct),
    runtimeFailures: count(records, (r) => r.outcome === "error"),
    questionsRepaired: count(records, (r) => r.repairs > 0),
    repairAttempts: records.reduce((s, r) => s + r.repairs, 0),
  };
  const base = { S: sup.length, U: uns.length, A: records.length };
  const rates = Object.fromEntries(Object.entries(RATE_BASE).map(([k, b]) => [k, base[b] ? Math.round((1e4 * counts[k]) / base[b]) / 1e4 : null]));
  const byGroup = {};
  for (const r of sup)
    for (const g of [r.question.level, ...r.question.tags]) {
      const e = (byGroup[g] ??= { n: 0, firstCorrect: 0, finalCorrect: 0 });
      e.n++;
      e.firstCorrect += r.score.firstCorrect ? 1 : 0;
      e.finalCorrect += r.score.correct ? 1 : 0;
    }
  return {
    counts,
    rates,
    failureCategories: sortTally(tally(records.filter((r) => r.failure).map((r) => r.failure.category))),
    firstAttemptFailureCategories: sortTally(tally(records.filter((r) => r.firstAttemptFailure).map((r) => r.firstAttemptFailure.category))),
    byLevelAndTag: byGroup,
    timing: timingSummary(records),
    schema: schemaSummary(records),
    legacy: legacySummary(records),
  };
}

const spread = (xs) => {
  const s = stats(xs);
  return s && { values: xs, mean: s.mean, min: s.min, max: s.max };
};

export function aggregate(recordsByTrial) {
  const trials = recordsByTrial.map(trialSummary);
  const all = recordsByTrial.flat();
  const keys = (f) => [...new Set(trials.flatMap((t) => Object.keys(f(t))))];
  const perQuestion = {};
  for (const r of all) {
    const q = (perQuestion[r.question.id] ??= { trials: 0, correct: 0, firstCorrect: 0, categories: {}, finalDsl: new Set(), replies: new Set() });
    q.trials++;
    q.correct += r.score.correct ? 1 : 0;
    q.firstCorrect += r.score.firstCorrect ? 1 : 0;
    if (r.failure) q.categories[r.failure.category] = (q.categories[r.failure.category] || 0) + 1;
    q.finalDsl.add(r.final?.dsl ?? `(${r.final?.reply})`);
    q.replies.add(JSON.stringify(r.attempts.map((a) => a.raw)));
  }
  const questions = Object.entries(perQuestion).map(([id, q]) => ({
    id,
    trials: q.trials,
    correct: q.correct,
    firstCorrect: q.firstCorrect,
    categories: q.categories,
    finalDslVariants: q.finalDsl.size,
    identicalAcrossTrials: q.replies.size === 1,
  }));
  return {
    trials: trials.length,
    counts: Object.fromEntries(keys((t) => t.counts).map((k) => [k, spread(trials.map((t) => t.counts[k] ?? 0))])),
    rates: Object.fromEntries(keys((t) => t.rates).map((k) => [k, spread(trials.map((t) => t.rates[k]))])),
    failureCategories: Object.fromEntries(keys((t) => t.failureCategories).map((k) => [k, spread(trials.map((t) => t.failureCategories[k] || 0))])),
    timing: timingSummary(all),
    determinism: {
      questions: questions.length,
      identicalAcrossTrials: count(questions, (q) => q.identicalAcrossTrials),
      differing: questions.filter((q) => !q.identicalAcrossTrials).map((q) => q.id),
    },
    perQuestion: questions,
    perTrial: trials,
  };
}
