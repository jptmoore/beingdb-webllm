import { setupDatabase, setupModel } from "./setup.js";
import { ask, MAX_REPAIRS } from "./pipeline.js";
import { scoreItem, summarise } from "./score.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
// With ?save=, mirror the log to eval/results/<save>.status.json so runs in other browsers can be followed.
let lastStatus = 0;
const status = (force) => {
  if (!params.get("save") || (!force && Date.now() - lastStatus < 3000)) return;
  lastStatus = Date.now();
  const body = JSON.stringify({ log: $("log").textContent, progress: $("progress-text").textContent, userAgent: navigator.userAgent });
  fetch(`eval/results/${params.get("save")}.status.json`, { method: "PUT", body }).catch(() => {});
};
const log = (msg) => {
  $("log").textContent += msg + "\n";
  status(true);
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mark = (b) => (b === undefined ? "" : b ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>');

const { db, summary: dbSummary, timings: dbTimings, schema, prompt } = await setupDatabase(log);
const { items, environmentFingerprint } = await (await fetch("eval/questions.json")).json();
if (dbSummary.environmentFingerprint !== environmentFingerprint) log("Warning: dataset fingerprint differs from questions.json");
const ids = params.get("ids")?.split(",");
const selected = ids ? items.filter((i) => ids.includes(i.id)) : items;
const maxRepairs = params.has("repairs") ? Number(params.get("repairs")) : MAX_REPAIRS;

const save = (name, body) =>
  fetch(`eval/results/${name}.json`, { method: "PUT", body: JSON.stringify(body, null, 1) }).catch(() => null);

let generator, info;
try {
  ({ generator, info } = await setupModel(log, (p) => {
    $("progress").value = p.progress;
    $("progress-text").textContent = p.text;
    status(false);
  }));
} catch (e) {
  log(`Model failed: ${e.message}`);
  // BeingDB itself still works here; record the browser result for the compatibility notes.
  if (params.get("save")) await save(params.get("save"), { error: e.message, userAgent: navigator.userAgent, db: dbSummary, dbTimings });
  throw e;
}

let report;
$("run").disabled = false;
$("run").addEventListener("click", run);
$("download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  a.download = `eval-${info.modelId}-${new Date().toISOString().slice(0, 16)}.json`;
  a.click();
});
if (params.get("autorun") === "1") run();

async function run() {
  $("run").disabled = true;
  const results = [];
  const scores = [];
  const started = new Date().toISOString();
  for (const [n, item] of selected.entries()) {
    $("progress").value = n / selected.length;
    $("progress-text").textContent = `${n + 1}/${selected.length} ${item.id}`;
    status(true);
    const r = await ask({ question: item.question, generator, db, schema, prompt, maxRepairs });
    const s = scoreItem(item, r, db);
    results.push({ id: item.id, run: slim(r) });
    scores.push(s);
    const last = r.attempts.at(-1);
    $("table").insertAdjacentHTML(
      "beforeend",
      `<tr><td>${item.id}</td><td>${esc(item.question)}</td><td>${r.outcome}</td><td>${r.repairs}</td>` +
        `<td>${s.supported ? mark(s.firstValid) : ""}</td><td>${mark(s.firstCorrect)}</td><td>${mark(s.correct)}</td>` +
        `<td>${esc(s.failure || "")}</td><td><pre>${esc(last.reply.dsl || last.reply.reason || last.reply.error || "")}</pre></td>` +
        `<td>${r.llmMs.toFixed(0)}</td><td>${r.dbMs.toFixed(1)}</td></tr>`,
    );
    report = { started, model: info, db: { ...dbSummary, timings: dbTimings }, promptChars: prompt.chars, maxRepairs, summary: summarise(scores, results.map((x) => x.run)), scores, results };
    $("summary").textContent = JSON.stringify(report.summary, null, 2);
    localStorage.setItem("beingdb-webllm-last-eval", JSON.stringify(report));
  }
  report.model.jsHeapMBAfter = performance.memory ? performance.memory.usedJSHeapSize / 1e6 : undefined;
  report.finished = new Date().toISOString();
  $("progress").value = 1;
  $("progress-text").textContent = "done";
  $("download").disabled = false;
  $("run").disabled = false;
  window.evalReport = report;
  const name = params.get("save") || `${info.modelId}-${report.finished.slice(0, 19).replace(/:/g, "")}`;
  const saved = await save(name, report);
  log(saved?.ok ? `Saved eval/results/${name}.json` : "Not saved (static server); use Download.");
  if (params.get("unload") === "1") {
    await generator.engine.unload();
    log("Model unloaded (GPU memory released).");
  }
}

// Keep the report small: BeingDB rows are re-derivable by re-running the DSL.
function slim(run) {
  const attempts = run.attempts.map(({ db, ...a }) => ({
    ...a,
    db: db && { status: db.status, ms: db.ms, response: { variables: db.response.variables, count: db.response.count, errors: db.response.errors, error: db.response.error } },
  }));
  return { ...run, attempts };
}
