// Flatten saved runs into one row per run x trial x question for pandas/R:
//   npm run export-results -- [--format csv|jsonl] [--out file] [run dirs / legacy reports ...]
// Without paths, every run under eval/results/benchmarks/ is exported.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { listRuns, loadRun, RESULTS_DIR } from "./lib/runs.mjs";
import { root } from "./lib/server.mjs";

const { values, positionals } = parseArgs({ options: { format: { type: "string" }, out: { type: "string" } }, allowPositionals: true });
const format = values.format || "csv";
if (!["csv", "jsonl"].includes(format)) {
  console.error("--format must be csv or jsonl");
  process.exit(64);
}
const paths = positionals.length ? positionals : listRuns();
if (!paths.length) {
  console.error(`no runs found under ${path.relative(root, RESULTS_DIR)}`);
  process.exit(1);
}

const join = (xs) => (xs && xs.length ? xs.join(";") : "");
const rows = [];
for (const p of paths) {
  const run = await loadRun(p);
  const m = run.meta;
  const host = m.environment?.observed?.host;
  const gpu = m.environment?.observed?.browser?.webgpu?.adapter?.info;
  const repo = m.provenance?.repositories?.["beingdb-webllm"];
  for (const r of run.records) {
    const first = r.attempts[0];
    const ev = r.schemaEvidence;
    rows.push({
      run_id: m.runId,
      status: m.status,
      legacy: !!m.legacy,
      timestamp: m.startedAt,
      suite_id: m.suite?.id ?? null,
      suite_partial: !!m.suite?.partial,
      condition: m.labels?.condition ?? null,
      non_default: join(m.config?.nonDefault),
      machine_label: m.labels?.machine ?? null,
      host_platform: host?.platform ?? null,
      host_os: host?.osProductVersion ?? null,
      host_arch: host?.arch ?? null,
      host_model: host?.hardwareModel ?? null,
      host_cpu: host?.cpuModel ?? null,
      host_memory_gb: host?.totalMemoryBytes ? Math.round(host.totalMemoryBytes / 2 ** 30) : null,
      host_power: host?.power?.source ?? null,
      browser: m.browser?.product ?? m.environment?.browser?.userAgent ?? null,
      headless: m.browser?.headless ?? null,
      gpu_vendor: gpu?.vendor ?? null,
      gpu_architecture: gpu?.architecture ?? null,
      gpu_description: gpu?.description ?? null,
      gpu_renderer: m.environment?.observed?.chromeGpu?.info?.GL_RENDERER ?? null,
      webgpu_status: m.environment?.observed?.chromeGpu?.featureStatus?.WebGPU ?? null,
      webllm_version: m.provenance?.packages?.["@mlc-ai/web-llm"] ?? null,
      webllm_commit: repo?.commit ?? null,
      webllm_dirty: repo?.dirty ?? null,
      model_id: m.model?.id ?? null,
      model_label: m.labels?.modelLabel ?? null,
      model_vram_mb: m.model?.record?.vram_required_MB ?? null,
      model_load_ms: m.model?.load?.loadMs ?? null,
      model_cached_at_load: m.model?.load?.cachedAtLoad ?? null,
      seed: m.config?.generation?.seed ?? null,
      temperature: m.config?.generation?.firstAttemptTemperature ?? null,
      repair_attempts_allowed: m.config?.repairAttempts ?? null,
      trial: r.trial,
      question_index: r.index,
      question_id: r.question.id,
      difficulty: r.question.level,
      tags: join(r.question.tags),
      supported: r.question.supported,
      outcome: r.outcome,
      correct: r.score.correct,
      valid_first_attempt: r.score.firstValid,
      correct_first_attempt: r.score.firstCorrect,
      valid_final: r.score.finalValid,
      fabricated: r.score.fabricated,
      repair_count: r.repairs,
      failure_category: r.failure?.category ?? null,
      failure_rule: r.failure?.rule ?? null,
      failure_category_first_attempt: r.firstAttemptFailure?.category ?? null,
      manual_category: r.manual?.category ?? null,
      manual_note: r.manual?.note ?? null,
      legacy_failure: r.score.legacyFailure,
      model_ms: r.timing.llmMs,
      model_ms_first_attempt: r.timing.firstAttemptLlmMs ?? first?.timing?.llmMs ?? null,
      model_calls: r.timing.llmCalls,
      prompt_tokens_first_attempt: first?.timing?.promptTokens ?? null,
      completion_tokens_total: r.attempts.reduce((s, a) => s + (a.timing?.completionTokens || 0), 0),
      ttft_ms_first_attempt: first?.timing?.ttftMs ?? null,
      prefill_tok_s_first_attempt: first?.timing?.prefillTokPerS ?? null,
      decode_tok_s_first_attempt: first?.timing?.decodeTokPerS ?? null,
      grammar_init_ms: r.attempts.reduce((s, a) => s + (a.timing?.grammarInitMs || 0), 0),
      beingdb_ms: r.timing.dbMs,
      beingdb_queries: r.timing.dbQueries,
      total_ms: r.timing.totalMs,
      page_hidden_ms: r.page?.hiddenMs ?? null,
      reference_predicates: join(ev?.referencePredicates),
      required_predicates: join(ev?.requiredPredicates),
      generated_predicates: join(ev?.generatedPredicates),
      first_attempt_predicates: join(ev?.firstAttemptPredicates),
      missing_predicates: join(ev?.missingPredicates),
      extra_predicates: join(ev?.extraPredicates),
      predicate_selection_correct: ev?.predicateSelectionCorrect ?? null,
      argument_order_correct: ev?.argumentOrderCorrect ?? null,
      reference_constants: join(ev?.constants.reference),
      generated_constants: join(ev?.constants.generated),
      missing_constants: join(ev?.constants.missing),
      unknown_atoms: join(ev?.generatedGrounding.flatMap((g) => g.args.filter((a) => a.kind === "atom" && !a.inPack).map((a) => a.text))),
      reference_rows_sha256: r.reference?.keyRowsSha256 ?? null,
      final_rows_sha256: r.final?.rowsSha256 ?? null,
      final_dsl: r.final?.dsl ?? null,
      question: r.question.text,
    });
  }
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const out = values.out || path.join(root, "eval", "results", "export", `benchmark-questions.${format}`);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const cols = Object.keys(rows[0] || {});
writeFileSync(
  out,
  format === "csv" ? [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n" : rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
console.log(`${rows.length} rows from ${paths.length} run(s) -> ${path.relative(process.cwd(), path.resolve(out))}`);
