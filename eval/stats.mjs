// Timing/throughput stats of saved runs: node eval/stats.mjs eval/results/*.json
import { readFileSync } from "node:fs";

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, "utf8"));
  if (!r.results) {
    console.log(`${f}: ${r.error ? `model failed: ${r.error}` : "no results"} (${r.userAgent || ""})`);
    continue;
  }
  const attempts = r.results.flatMap((x) => x.run.attempts);
  const first = r.results.map((x) => x.run.attempts[0]);
  const ex = (a, k) => a.usage?.extra?.[k];
  console.log(
    JSON.stringify(
      {
        file: f,
        model: r.model.modelId,
        cached: r.model.cached,
        loadMs: Math.round(r.model.loadMs),
        jsHeapMB: r.model.jsHeapMB && Math.round(r.model.jsHeapMB),
        jsHeapMBAfter: r.model.jsHeapMBAfter && Math.round(r.model.jsHeapMBAfter),
        userAgent: r.model.userAgent,
        dbLoadMs: r.db.timings && Math.round(r.db.timings.loadMs),
        firstPromptTokens: median(first.map((a) => a.usage?.prompt_tokens)),
        firstCompletionTokens: median(first.map((a) => a.usage?.completion_tokens)),
        firstLlmMs: Math.round(median(first.map((a) => a.llmMs))),
        ttftS: median(first.map((a) => ex(a, "time_to_first_token_s")))?.toFixed(2),
        prefillTokPerS: Math.round(median(first.map((a) => ex(a, "prefill_tokens_per_s")))),
        decodeTokPerS: median(attempts.map((a) => ex(a, "decode_tokens_per_s")))?.toFixed(1),
        repairLlmMs: Math.round(median(r.results.flatMap((x) => x.run.attempts.slice(1).map((a) => a.llmMs))) || 0),
        repairPromptTokens: median(r.results.flatMap((x) => x.run.attempts.slice(1).map((a) => a.usage?.prompt_tokens))),
        summary: { firstValid: r.summary.firstValid, firstCorrect: r.summary.firstCorrect, finalCorrect: r.summary.finalCorrect, unsupportedDetected: r.summary.unsupportedDetected },
      },
      null,
      1,
    ),
  );
}
