// Question -> model -> DSL -> BeingDB, with a bounded repair loop driven by
// BeingDB's own validation errors. The model never sees or alters result rows.
//
// Two conditions share this loop:
// - default (run 9): every model reply goes straight to BeingDB.query; any
//   validation error is sent back to the model (at most maxRepairs times).
// - dbGuided (run 10): BeingDB first diagnoses the reply; repairs BeingDB can
//   prove are applied without a model call (at most MAX_DETERMINISTIC_PASSES),
//   valid queries are executed, and the model is asked again only when the
//   query is invalid or BeingDB proves an empty result.
import { parseReply, repairMessage, diagnosticRepairMessage, emptyResultMessage } from "./prompt.js";

export const MAX_REPAIRS = 2;
// Greedy first attempt; repairs sample (seeded) so the model does not simply
// repeat the query BeingDB just rejected.
export const REPAIR_TEMPERATURE = 0.7;
// Proven BeingDB repairs applied to one model reply before giving up on them.
export const MAX_DETERMINISTIC_PASSES = 2;

export const PIPELINE_VERSIONS = { modelRepair: "model-repair/run9", dbGuided: "db-guided-repair/1" };

// BeingDB diagnostics that prove a query empty for a reason only the model can fix.
const EMPTY_PROOFS = new Set(["unknown_constant", "constant_not_at_position", "disjoint_join", "contradictory_negation"]);

// generator: { complete(messages, format, { temperature }) -> { text, ms, usage } }
// db: wrapBeingDB(...) ; schema: buildSchema(...) ; prompt: buildPrompt(schema)
export async function ask({
  question,
  generator,
  db,
  schema,
  prompt,
  maxRepairs = MAX_REPAIRS,
  temperature = 0,
  repairTemperature = REPAIR_TEMPERATURE,
  dbGuided = false,
  maxDeterministicPasses = MAX_DETERMINISTIC_PASSES,
}) {
  const t0 = performance.now();
  const messages = prompt.messages(question);
  const attempts = [];
  const steps = [];
  let format = prompt.format;
  for (let i = 0; i <= maxRepairs; i++) {
    const grammar = format === prompt.format ? "query_or_unsupported" : "query_only";
    let gen;
    try {
      gen = await generator.complete(messages, format, { temperature: i === 0 ? temperature : repairTemperature });
    } catch (e) {
      // Keep the evidence gathered so far for callers that record failures.
      e.attempts = attempts;
      e.steps = steps;
      throw e;
    }
    steps.push({ kind: i === 0 ? "model" : "model_repair", ms: gen.ms });
    const reply = parseReply(gen.text);
    const attempt = { raw: gen.text, reply, llmMs: gen.ms, usage: gen.usage, finish: gen.finish, grammar, request: gen.request };
    attempts.push(attempt);
    if (reply.status === "unsupported") break;
    let next;
    if (reply.status !== "ok") {
      attempt.feedback = `Your reply was not usable: ${reply.error}. Reply with only the query.`;
      next = prompt.format;
    } else if (!dbGuided) {
      attempt.db = db.query(reply.dsl);
      steps.push({ kind: "query", ms: attempt.db.ms, status: attempt.db.status });
      if (attempt.db.status === "ok") break;
      const repair = repairMessage(attempt.db.response, schema);
      attempt.feedback = repair.text;
      next = repair.allowUnsupported ? prompt.format : prompt.fixFormat;
    } else {
      const guided = guide(reply.dsl, db, maxDeterministicPasses, steps);
      attempt.guided = guided.record;
      if (guided.dsl !== reply.dsl) attempt.reply = { ...reply, dsl: guided.dsl, modelDsl: reply.dsl };
      const diag = guided.diagnosis;
      if (diag.status !== "ok") {
        // Invalid: the validation response stands in for the query result.
        attempt.db = { status: diag.status === "error" ? "error" : "invalid", response: diag.response, ms: diag.ms };
        const repair = diagnosticRepairMessage(diag.response, schema);
        attempt.feedback = repair.text;
        next = repair.allowUnsupported ? prompt.format : prompt.fixFormat;
      } else {
        attempt.db = db.query(guided.dsl);
        steps.push({ kind: "execute", ms: attempt.db.ms, status: attempt.db.status, rows: attempt.db.response.count ?? null });
        const proofs = (diag.response.diagnostics || []).filter((d) => d.severity === "error" && EMPTY_PROOFS.has(d.code));
        if (attempt.db.status === "ok" && !(attempt.db.response.count === 0 && proofs.length)) break;
        if (attempt.db.status === "ok") {
          attempt.feedback = emptyResultMessage(proofs, schema);
          next = prompt.format;
        } else {
          const repair = repairMessage(attempt.db.response, schema);
          attempt.feedback = repair.text;
          next = repair.allowUnsupported ? prompt.format : prompt.fixFormat;
        }
      }
    }
    if (i === maxRepairs) break;
    format = next;
    // After a proven BeingDB repair, the conversation shows the query BeingDB actually judged.
    messages.push({ role: "assistant", content: attempt.reply.modelDsl ? attempt.reply.dsl : gen.text }, { role: "user", content: attempt.feedback });
  }
  const last = attempts.at(-1);
  const outcome = last.reply.status === "unsupported" ? "unsupported" : last.db?.status === "ok" ? "ok" : "failed";
  const sum = (f) => attempts.reduce((n, a) => n + (f(a) || 0), 0);
  const ofKind = (...k) => steps.filter((s) => k.includes(s.kind));
  const msOf = (...k) => ofKind(...k).reduce((n, s) => n + (s.ms || 0), 0);
  const deterministic = attempts.flatMap((a) => a.guided?.repairs || []);
  return {
    question,
    outcome,
    attempts,
    repairs: attempts.length - 1,
    llmMs: sum((a) => a.llmMs),
    dbMs: msOf("query", "diagnose", "execute"),
    totalMs: performance.now() - t0,
    pipeline: { version: dbGuided ? PIPELINE_VERSIONS.dbGuided : PIPELINE_VERSIONS.modelRepair, dbGuided, maxRepairs, maxDeterministicPasses: dbGuided ? maxDeterministicPasses : 0 },
    calls: {
      model: ofKind("model", "model_repair").length,
      modelRepair: ofKind("model_repair").length,
      beingdb: ofKind("query", "diagnose", "execute").length,
      diagnose: ofKind("diagnose").length,
      // BeingDB.query calls (in the default condition each one validates and executes).
      execute: ofKind("query", "execute").length,
      deterministicRepairs: deterministic.length,
    },
    beingdbMs: { diagnose: msOf("diagnose"), execute: msOf("query", "execute") },
    diagnosticCodes: [...new Set(attempts.flatMap((a) => a.guided?.codes || []))].sort(),
    deterministicRepairs: deterministic,
    path: steps.map((s) => s.kind),
  };
}

// Diagnose, and apply BeingDB-proven repairs (re-diagnosing each result) at most
// `passes` times; never revisits a query, so it cannot loop.
function guide(dsl, db, passes, steps) {
  const record = { diagnoses: [], repairs: [], codes: [] };
  const seen = new Set([dsl]);
  let diagnosis;
  for (let pass = 0; ; pass++) {
    diagnosis = db.diagnose(dsl);
    const r = diagnosis.response;
    const codes = (r.diagnostics || []).map((d) => d.code);
    steps.push({ kind: "diagnose", ms: diagnosis.ms, status: diagnosis.status });
    record.diagnoses.push({ dsl, ms: diagnosis.ms, valid: r.valid ?? false, provablyEmpty: r.provablyEmpty ?? false, errors: (r.errors || []).map((e) => e.code), diagnostics: codes });
    record.codes.push(...codes, ...(r.errors || []).map((e) => e.code));
    const repaired = r.repair?.query;
    if (!repaired || pass >= passes || seen.has(repaired)) break;
    seen.add(repaired);
    record.repairs.push({ from: dsl, to: repaired, applied: r.repair.applied });
    steps.push({ kind: "deterministic_repair", ms: 0, applied: r.repair.applied.map((a) => a.kind) });
    dsl = repaired;
  }
  record.codes = [...new Set(record.codes)].sort();
  return { dsl, diagnosis, record };
}
