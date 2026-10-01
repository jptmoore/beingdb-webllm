// npm run benchmark:matrix -- --models models/benchmark-models.json [benchmark options]
// Runs the same benchmark for each model in turn (a fresh browser per model),
// continuing past incompatible models, and writes a matrix index next to the runs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { OPTIONS, HELP, toOptions, interruptSignal } from "./benchmark.mjs";
import { runBenchmark, DEFAULTS } from "./lib/runner.mjs";

let values;
try {
  ({ values } = parseArgs({ options: { ...OPTIONS, models: { type: "string" } }, strict: true }));
} catch (e) {
  console.error(e.message);
  process.exit(64);
}
if (values.help || !values.models) {
  console.log(
    `npm run benchmark:matrix -- --models <file.json> [options]\n\n` +
      `The file is a JSON array of {"id": "<WebLLM model id>", "label": "...", "runs": n?}.\n` +
      `Every model gets identical prompt/generation settings; only "runs" may differ per entry.\n` +
      `All benchmark options except --model apply to every model:\n\n${HELP}`,
  );
  process.exit(values.help ? 0 : 64);
}
if (values.model) {
  console.error("--model is not used by benchmark:matrix; list models in the --models file");
  process.exit(64);
}

const models = JSON.parse(readFileSync(values.models, "utf8"));
if (!Array.isArray(models) || !models.every((m) => typeof m.id === "string")) {
  console.error(`${values.models}: expected a JSON array of {"id": ..., "label": ...}`);
  process.exit(64);
}
let base;
try {
  base = toOptions(values);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(64);
}
const signal = interruptSignal();
const startedAt = new Date().toISOString();
const entries = [];
for (const m of models) {
  if (signal.aborted) break;
  console.log(`\n=== ${m.label || m.id} (${entries.length + 1}/${models.length}) ===`);
  let result;
  try {
    const runs = m.runs ?? base.runs;
    result = await runBenchmark({ ...base, model: m.id, modelLabel: m.label, ...(runs !== undefined ? { runs } : {}) }, { signal });
  } catch (e) {
    console.error(`error: ${e.message}`);
    result = { status: e.status || "setup_failed", meta: { error: e.message } };
  }
  entries.push({ id: m.id, label: m.label ?? null, status: result.status, error: result.meta?.error ?? null, runDir: result.dir ?? null, summary: result.meta?.summary ?? null });
}

const outDir = path.resolve(base.output || DEFAULTS.output);
mkdirSync(outDir, { recursive: true });
const indexFile = path.join(outDir, `matrix-${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
writeFileSync(
  indexFile,
  JSON.stringify({ schema: "beingdb-webllm-benchmark/v1#matrix", startedAt, finishedAt: new Date().toISOString(), modelsFile: values.models, options: base, entries }, null, 1),
);
console.log("\nModel matrix:");
for (const e of entries)
  console.log(
    `  ${(e.label || e.id).padEnd(28)} ${e.status.padEnd(18)} ` +
      (e.summary ? `overall ${e.summary.meanCounts.overallCorrect}/${e.summary.supported + e.summary.unsupported}, median model ${Math.round(e.summary.medianModelMsPerCall)} ms/call` : e.error || ""),
  );
console.log(`\n${indexFile}`);
process.exit(entries.every((e) => e.status === "complete") ? 0 : 1);
