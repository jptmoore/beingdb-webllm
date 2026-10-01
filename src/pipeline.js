// Question -> model -> DSL -> BeingDB, with a bounded repair loop driven by
// BeingDB's own validation errors. The model never sees or alters result rows.
import { parseReply, repairMessage } from "./prompt.js";

export const MAX_REPAIRS = 2;
// Greedy first attempt; repairs sample (seeded) so the model does not simply
// repeat the query BeingDB just rejected.
export const REPAIR_TEMPERATURE = 0.7;

// generator: { complete(messages, format, { temperature }) -> { text, ms, usage } }
// db: wrapBeingDB(...) ; schema: buildSchema(...) ; prompt: buildPrompt(schema)
export async function ask({ question, generator, db, schema, prompt, maxRepairs = MAX_REPAIRS, temperature = 0, repairTemperature = REPAIR_TEMPERATURE }) {
  const t0 = performance.now();
  const messages = prompt.messages(question);
  const attempts = [];
  let format = prompt.format;
  for (let i = 0; i <= maxRepairs; i++) {
    const grammar = format === prompt.format ? "query_or_unsupported" : "query_only";
    let gen;
    try {
      gen = await generator.complete(messages, format, { temperature: i === 0 ? temperature : repairTemperature });
    } catch (e) {
      // Keep the evidence gathered so far for callers that record failures.
      e.attempts = attempts;
      throw e;
    }
    const reply = parseReply(gen.text);
    const attempt = { raw: gen.text, reply, llmMs: gen.ms, usage: gen.usage, finish: gen.finish, grammar, request: gen.request };
    attempts.push(attempt);
    if (reply.status === "unsupported") break;
    if (reply.status === "ok") {
      attempt.db = db.query(reply.dsl);
      if (attempt.db.status === "ok") break;
      const repair = repairMessage(attempt.db.response, schema);
      attempt.feedback = repair.text;
      format = repair.allowUnsupported ? prompt.format : prompt.fixFormat;
    } else {
      attempt.feedback = `Your reply was not usable: ${reply.error}. Reply with only the query.`;
      format = prompt.format;
    }
    messages.push({ role: "assistant", content: gen.text }, { role: "user", content: attempt.feedback });
  }
  const last = attempts.at(-1);
  const outcome = last.reply.status === "unsupported" ? "unsupported" : last.db?.status === "ok" ? "ok" : "failed";
  const sum = (f) => attempts.reduce((n, a) => n + (f(a) || 0), 0);
  return {
    question,
    outcome,
    attempts,
    repairs: attempts.length - 1,
    llmMs: sum((a) => a.llmMs),
    dbMs: sum((a) => a.db?.ms),
    totalMs: performance.now() - t0,
  };
}
