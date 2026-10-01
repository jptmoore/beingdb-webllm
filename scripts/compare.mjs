// Compare saved benchmark runs deterministically (no model involved):
//   npm run compare -- <runA> <runB> [--trial n] [--json]
// A run is a benchmark directory (or its run.json) or a legacy eval report (eval/results/run8-final.json).
import { parseArgs } from "node:util";
import { loadRun } from "./lib/runs.mjs";
import { aggregate } from "./lib/summary.mjs";

const { values, positionals } = parseArgs({ options: { trial: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true });
if (positionals.length !== 2) {
  console.error("usage: npm run compare -- <runA> <runB> [--trial n] [--json]");
  process.exit(64);
}
const trialNo = Number(values.trial || 1);
const runs = await Promise.all(positionals.map(loadRun));

function describe(run) {
  const m = run.meta;
  const agg = run.byTrial.length ? aggregate(run.byTrial) : null;
  const gpu = m.environment?.observed?.browser?.webgpu?.adapter?.info;
  const host = m.environment?.observed?.host;
  return {
    path: run.path,
    runId: m.runId,
    status: m.status,
    model: m.model?.id,
    machine: m.labels?.machine ?? null,
    host: host ? [host.hardwareModel, host.cpuModel, host.totalMemoryBytes ? `${Math.round(host.totalMemoryBytes / 2 ** 30)} GB` : null].filter(Boolean).join(", ") : null,
    browser: m.browser?.product ?? m.environment?.browser?.userAgent ?? null,
    gpu: [gpu ? [gpu.vendor, gpu.architecture, gpu.description].filter(Boolean).join(" / ") : null, m.environment?.observed?.chromeGpu?.info?.GL_RENDERER].filter(Boolean).join("; ") || null,
    suite: `${m.suite?.id ?? "?"}${m.suite?.partial ? " (partial)" : ""}`,
    suiteSha256: m.suite?.sha256 ?? null,
    condition: m.labels?.condition ?? null,
    nonDefault: m.config?.nonDefault ?? null,
    dirty: m.provenance ? Object.entries(m.provenance.repositories).filter(([, r]) => r.dirty).map(([n]) => n) : null,
    agg,
  };
}
const [A, B] = runs.map(describe);

const mean = (d, k) => d.agg?.counts[k]?.mean ?? null;
const S = (d) => mean(d, "supported");
const U = (d) => mean(d, "unsupported");
const Q = (d) => mean(d, "questions");
const med = (d, f) => f(d.agg?.timing)?.median ?? null;
const metrics = [
  ["overall accuracy", (d) => [mean(d, "overallCorrect"), Q(d)]],
  ["supported semantic accuracy (final)", (d) => [mean(d, "finalCorrect"), S(d)]],
  ["unsupported detection", (d) => [mean(d, "unsupportedDetected"), U(d)]],
  ["fabricated queries (unsupported)", (d) => [mean(d, "fabricated"), U(d)]],
  ["false refusals (supported)", (d) => [mean(d, "falseRefusals"), S(d)]],
  ["first-attempt validity", (d) => [mean(d, "firstValid"), S(d)]],
  ["post-repair validity", (d) => [mean(d, "finalValid"), S(d)]],
  ["first-attempt correctness", (d) => [mean(d, "firstCorrect"), S(d)]],
  ["post-repair correctness", (d) => [mean(d, "finalCorrect"), S(d)]],
  ["predicate selection correct", (d) => [mean(d, "predicateSelectionCorrect"), S(d)]],
  ["runtime failures", (d) => [mean(d, "runtimeFailures"), Q(d)]],
];
const timings = [
  ["median model ms per call", (d) => med(d, (t) => t?.model.msPerCall)],
  ["median model ms, first attempt", (d) => med(d, (t) => t?.model.firstAttemptMs)],
  ["median prefill tok/s, first attempt", (d) => med(d, (t) => t?.model.firstAttemptPrefillTokPerS)],
  ["median decode tok/s", (d) => med(d, (t) => t?.model.decodeTokPerS)],
  ["median BeingDB ms per query", (d) => med(d, (t) => t?.beingdb.msPerQuery)],
  ["median question-to-result ms", (d) => med(d, (t) => t?.totalMsPerQuestion)],
];
const cats = [...new Set([A, B].flatMap((d) => Object.keys(d.agg?.failureCategories || {})))].sort();

// Question-level comparison on one trial of each run.
const pick = (run) => new Map((run.byTrial[Math.min(trialNo, run.byTrial.length) - 1] || []).map((r) => [r.question.id, r]));
const [qa, qb] = runs.map(pick);
const ids = [...qa.keys()].filter((id) => qb.has(id));
const line = (r) => (r.final?.dsl ? r.final.dsl.replace(/\n\s*/g, " / ") : `(${r.final?.reply ?? r.outcome})`);
const cat = (r) => r.manual?.category ?? r.failure?.category ?? null;
const groups = { aCorrectBWrong: [], aWrongBCorrect: [], bothWrongSameQuery: [], bothWrongSameCategory: [], bothWrongDifferent: [], bothCorrect: [] };
for (const id of ids) {
  const a = qa.get(id);
  const b = qb.get(id);
  const e = { id, question: a.question.text, a: { category: cat(a), dsl: line(a) }, b: { category: cat(b), dsl: line(b) } };
  if (a.score.correct && b.score.correct) groups.bothCorrect.push(e);
  else if (a.score.correct) groups.aCorrectBWrong.push(e);
  else if (b.score.correct) groups.aWrongBCorrect.push(e);
  else if (a.final?.dsl && a.final.dsl === b.final?.dsl) groups.bothWrongSameQuery.push(e);
  else if (cat(a) === cat(b)) groups.bothWrongSameCategory.push(e);
  else groups.bothWrongDifferent.push(e);
}

const caveats = [];
if (A.suiteSha256 && B.suiteSha256 && A.suiteSha256 !== B.suiteSha256) caveats.push("different question files (sha256 differs)");
if (A.suite !== B.suite) caveats.push(`different suites: ${A.suite} vs ${B.suite}`);
for (const d of [A, B]) {
  if (d.nonDefault?.length) caveats.push(`${d.runId}: non-default settings ${d.nonDefault.join(", ")}`);
  if (d.dirty?.length) caveats.push(`${d.runId}: dirty working tree (${d.dirty.join(", ")})`);
  if (d.status !== "complete") caveats.push(`${d.runId}: status ${d.status}`);
}

if (values.json) {
  const strip = ({ agg, ...d }) => d;
  console.log(
    JSON.stringify(
      {
        a: strip(A),
        b: strip(B),
        caveats,
        metrics: Object.fromEntries(metrics.map(([n, f]) => [n, { a: f(A), b: f(B) }])),
        timings: Object.fromEntries(timings.map(([n, f]) => [n, { a: f(A), b: f(B) }])),
        failureCategories: Object.fromEntries(cats.map((c) => [c, { a: A.agg?.failureCategories[c]?.mean ?? 0, b: B.agg?.failureCategories[c]?.mean ?? 0 }])),
        trial: trialNo,
        questions: groups,
      },
      null,
      1,
    ),
  );
  process.exit(0);
}

const w = 38;
const fmtCount = ([n, d]) => (n === null ? "-" : `${Number.isInteger(n) ? n : n.toFixed(1)}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`);
const cw = Math.min(64, Math.max(30, ...["runId", "model", "machine", "host", "gpu"].map((k) => String(A[k] ?? "").length + 2)));
const col = (s) => {
  const t = String(s ?? "-");
  return (t.length > cw - 2 ? `${t.slice(0, cw - 3)}…` : t).padEnd(cw);
};
console.log(`${"".padEnd(w)}${col("A")}B`);
for (const k of ["runId", "model", "machine", "host", "browser", "gpu", "suite", "condition", "status"]) console.log(`${k.padEnd(w)}${col(A[k])}${B[k] ?? "-"}`);
console.log(`${"trials".padEnd(w)}${col(A.agg?.trials)}${B.agg?.trials ?? "-"}`);
console.log("");
for (const [n, f] of metrics) console.log(`${n.padEnd(w)}${col(fmtCount(f(A)))}${fmtCount(f(B))}`);
console.log("");
for (const [n, f] of timings) {
  const a = f(A);
  const b = f(B);
  console.log(`${n.padEnd(w)}${col(a === null ? "-" : Math.round(a * 100) / 100)}${b === null ? "-" : Math.round(b * 100) / 100}`);
}
console.log("\nfailure categories (mean per trial)");
for (const c of cats) console.log(`  ${c.padEnd(w - 2)}${col(A.agg?.failureCategories[c]?.mean ?? 0)}${B.agg?.failureCategories[c]?.mean ?? 0}`);
console.log(`\nper question (trial ${trialNo}; ${ids.length} shared questions; both correct: ${groups.bothCorrect.length})`);
const show = (title, xs, both = true) => {
  console.log(`\n${title}: ${xs.length}`);
  for (const e of xs) {
    console.log(`  ${e.id}  ${e.question}`);
    if (both) console.log(`     A ${e.a.category ?? "correct"}: ${e.a.dsl}`);
    console.log(`     B ${e.b.category ?? "correct"}: ${e.b.dsl}`);
  }
};
show("A correct, B wrong", groups.aCorrectBWrong);
show("A wrong, B correct", groups.aWrongBCorrect);
show("both wrong with the same final query", groups.bothWrongSameQuery, false);
show("both wrong, same category, different query", groups.bothWrongSameCategory);
show("both wrong, different category", groups.bothWrongDifferent);
if (caveats.length) console.log(`\ncaveats:\n${caveats.map((c) => `  - ${c}`).join("\n")}`);
