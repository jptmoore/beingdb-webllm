import { setupDatabase, setupModel, modelIsCached } from "./setup.js";
import { ask } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => ($("log").textContent += msg + "\n");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function resultsTable(res) {
  if (!res.results.length) return "<p>0 rows</p>";
  const head = res.variables.map((v) => `<th>${esc(v)}</th>`).join("");
  const rows = res.results
    .map((r) => `<tr>${res.variables.map((v) => `<td>${r[v] ? esc(r[v].value) : "<i>null</i>"}</td>`).join("")}</tr>`)
    .join("");
  return `<p>${res.count} rows</p><table><tr>${head}</tr>${rows}</table>`;
}

let generator;
let modelInfo;

async function loadModel() {
  $("load").disabled = true;
  $("progress").hidden = false;
  try {
    ({ generator, info: modelInfo } = await setupModel(log, (p) => {
      $("progress").value = p.progress;
      $("progress-text").textContent = p.text;
    }));
    $("progress").hidden = true;
    $("ask").disabled = false;
    window.demo.generator = generator;
  } catch (e) {
    log(`Model failed: ${e.message}`);
    $("load").disabled = false;
  }
}

function render(run) {
  const last = run.attempts.at(-1);
  $("answer").hidden = false;
  $("model").textContent = modelInfo.modelId;
  $("dsl").textContent = last.reply.dsl || `(no query) ${last.reply.reason || last.reply.error || ""}`;
  const status = {
    ok: `<span class="ok">Validation: valid (BeingDB executed the query)</span>`,
    unsupported: `<span class="warn">Model reports the question cannot be expressed: ${esc(last.reply.reason)}</span>`,
    failed: `<span class="bad">No valid query after ${run.repairs} repair attempt(s)</span>`,
  }[run.outcome];
  $("status").innerHTML = `${status}<br>Repair attempts: ${run.repairs}`;
  $("timing").textContent =
    `LLM: ${run.llmMs.toFixed(0)} ms (${run.attempts.length} call${run.attempts.length > 1 ? "s" : ""}) · ` +
    `BeingDB: ${run.dbMs.toFixed(1)} ms · total: ${run.totalMs.toFixed(0)} ms`;
  $("attempts").innerHTML = run.attempts
    .map(
      (a, i) =>
        `<p><b>Attempt ${i + 1}</b> (${a.llmMs.toFixed(0)} ms, ${a.usage?.prompt_tokens ?? "?"} prompt / ${a.usage?.completion_tokens ?? "?"} completion tokens)</p>` +
        `<pre>${esc(a.raw)}</pre>` +
        (a.db ? `<p>BeingDB: ${a.db.status} in ${a.db.ms.toFixed(1)} ms</p>` : "") +
        (a.feedback ? `<pre>${esc(a.feedback)}</pre>` : ""),
    )
    .join("");
  $("attempts-box").open = run.repairs > 0;
  $("results").innerHTML = last.db?.status === "ok" ? resultsTable(last.db.response) : "<p>No results.</p>";
  $("raw").textContent = last.db ? JSON.stringify(last.db.response, null, 2) : "";
}

try {
  const { db, schema, prompt } = await setupDatabase(log);
  $("prompt").textContent =
    prompt.messages("<question>").map((m) => `[${m.role}]\n${m.content}`).join("\n\n") +
    `\n\n[decoding grammar]\n${prompt.format.grammar}`;
  // For poking at the pipeline from the devtools console.
  window.demo = { db, schema, prompt, ask };

  const { items } = await (await fetch("eval/questions.json")).json();
  for (const it of items) $("samples").append(new Option(`${it.id}: ${it.question}`, it.question));
  $("samples").addEventListener("change", (e) => e.target.value && ($("question").value = e.target.value));

  $("ask").addEventListener("click", async () => {
    $("ask").disabled = true;
    try {
      render(await ask({ question: $("question").value.trim(), generator, db, schema, prompt }));
    } catch (e) {
      log(`Error: ${e.message}`);
    }
    $("ask").disabled = false;
  });

  $("load").disabled = false;
  $("load").addEventListener("click", loadModel);
  if (!navigator.gpu) log("WebGPU is not available in this browser: BeingDB works, the local model cannot run.");
  else if (await modelIsCached()) loadModel();
  else log("Click 'Load model' to download the model (about 1 GB, once; cached by the browser).");
} catch (e) {
  log(`Startup failed: ${e.message}`);
}
