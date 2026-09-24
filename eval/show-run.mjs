// Print a saved eval run compactly: node eval/show-run.mjs eval/results/<run>.json
import { readFileSync } from "node:fs";

const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
const scores = new Map(run.scores.map((s) => [s.id, s]));
for (const { id, run: r } of run.results) {
  const s = scores.get(id);
  const verdict = s.correct ? "PASS" : `FAIL ${s.failure}`;
  console.log(`${id} ${verdict}  [${r.outcome}, repairs ${r.repairs}, llm ${Math.round(r.llmMs)} ms]  ${r.question}`);
  for (const a of r.attempts) {
    const body = a.reply.dsl ? a.reply.dsl.replace(/\n\s*/g, " / ") : `${a.reply.status}: ${a.reply.reason || a.reply.error || ""}`;
    const errs = a.db && a.db.status !== "ok" ? (a.db.response.errors || [a.db.response.error]).map((e) => e.message).join("; ") : "";
    console.log(`   > ${body}${a.db?.status === "ok" ? `  (${a.db.response.count} rows)` : ""}${errs ? `\n     !! ${errs}` : ""}`);
  }
}
console.log(JSON.stringify(run.summary, null, 2));
