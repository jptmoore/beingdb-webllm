// Load saved benchmark runs for compare/export: a run directory (run.json +
// questions.jsonl [+ annotations.jsonl]), or a legacy eval.html report (runs 2-8),
// which is re-analysed in Node with the same analysis code and BeingDB build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { root } from "./server.mjs";
import { aggregate } from "./summary.mjs";
import { loadSuite } from "./suite.mjs";

export const RESULT_SCHEMA = "beingdb-webllm-benchmark/v1";
export const RESULTS_DIR = path.join(root, "eval", "results", "benchmarks");

export const readJsonl = (f) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

export function groupByTrial(records) {
  const m = new Map();
  for (const r of records) {
    if (!m.has(r.trial)) m.set(r.trial, []);
    m.get(r.trial).push(r);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, rs]) => rs);
}

// Manual codes live beside the data and never overwrite the automatic category.
function applyAnnotations(records, annotations) {
  for (const a of annotations)
    for (const r of records) if (r.question.id === a.questionId && (a.trial == null || a.trial === r.trial)) r.manual = a;
}

export function listRuns(dir = RESULTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((d) => existsSync(path.join(d, "run.json")))
    .sort();
}

export async function loadRun(p) {
  let abs = path.resolve(p);
  if (!existsSync(abs)) throw new Error(`${p}: not found`);
  if (statSync(abs).isFile() && path.basename(abs) === "run.json") abs = path.dirname(abs);
  if (statSync(abs).isDirectory()) {
    const meta = JSON.parse(readFileSync(path.join(abs, "run.json"), "utf8"));
    if (!meta.schema?.startsWith("beingdb-webllm-benchmark/")) throw new Error(`${p}: not a benchmark run (schema ${meta.schema})`);
    const records = readJsonl(path.join(abs, "questions.jsonl"));
    applyAnnotations(records, readJsonl(path.join(abs, "annotations.jsonl")));
    return { path: abs, meta, records, byTrial: groupByTrial(records) };
  }
  return convertLegacy(abs);
}

let nodeContext;
async function nodeAnalysis() {
  if (nodeContext) return nodeContext;
  const { loadBeingDB } = await import("../../eval/node-beingdb.mjs");
  const { buildSchema } = await import("../../src/schema.js");
  const { buildAnalysisContext } = await import("../../src/analysis.js");
  const { db, summary } = await loadBeingDB();
  const schema = buildSchema(db);
  nodeContext = { db, summary, schema, ctx: buildAnalysisContext(db, schema) };
  return nodeContext;
}

async function convertLegacy(file) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  const { analyseQuestion } = await import("../../src/analysis.js");
  const { db, summary, schema, ctx } = await nodeAnalysis();
  const suite = loadSuite();
  const byId = new Map(suite.items.map((i) => [i.id, i]));
  const runId = `legacy:${path.basename(file, ".json")}`;
  const records = [];
  for (const [index, { id, run }] of (report.results || []).entries()) {
    // Saved legacy runs omit result rows; BeingDB re-derives them from the recorded DSL.
    for (const a of run.attempts) if (a.db && a.reply.dsl) a.db = { ...db.query(a.reply.dsl), ms: a.db.ms };
    const rec = await analyseQuestion({ item: byId.get(id), run, db, schema, ctx });
    records.push({ schema: `${RESULT_SCHEMA}#question`, runId, trial: 1, index, ...rec, page: null });
  }
  applyAnnotations(records, readJsonl(file.replace(/\.json$/, ".annotations.jsonl")));
  const fingerprintOk = report.db?.environmentFingerprint === summary.environmentFingerprint;
  const meta = {
    schema: RESULT_SCHEMA,
    legacy: true,
    runId,
    status: report.results ? "complete" : "model_load_failed",
    error: report.error ?? null,
    startedAt: report.started ?? null,
    finishedAt: report.finished ?? null,
    labels: { machine: null, modelLabel: null, condition: null, notes: `legacy eval.html report ${path.basename(file)}, re-analysed in Node` },
    suite: {
      id: fingerprintOk ? suite.id : null,
      sha256: null,
      partial: records.length !== suite.items.length,
      questionIds: records.map((r) => r.question.id),
    },
    model: { id: report.model?.modelId ?? null, load: report.model ? { cachedAtLoad: report.model.cached, loadMs: report.model.loadMs } : null },
    environment: { browser: { userAgent: report.model?.userAgent ?? report.userAgent ?? null }, host: null },
    config: { repairAttempts: report.maxRepairs ?? null, generation: null },
    provenance: null,
  };
  const byTrial = groupByTrial(records);
  meta.summary = byTrial.length ? aggregate(byTrial) : null;
  return { path: file, meta, records, byTrial };
}
