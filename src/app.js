import { setupDatabase, setupModel, modelIsCached } from "./setup.js";
import { ask } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => ($("log").textContent += msg + "\n");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function resultsTable(res) {
  if (!res.results.length) {
    const why = (res.diagnostics || []).map((d) => `<li>${esc(d.message)}</li>`).join("");
    const verdict = res.provablyEmpty ? `<p class="warn">BeingDB proved this query cannot match:</p>` : "";
    return `<p>0 rows</p>${why ? `${verdict}<ul>${why}</ul>` : ""}`;
  }
  const head = res.variables.map((v) => `<th>${esc(v)}</th>`).join("");
  const rows = res.results
    .map((r) => `<tr>${res.variables.map((v) => `<td>${r[v] ? esc(r[v].value) : "<i>null</i>"}</td>`).join("")}</tr>`)
    .join("");
  const of = res.total !== undefined && res.total !== res.count ? ` of ${res.total}` : "";
  const summary = res.truncated
    ? `<p class="warn">First ${res.count}${of} rows only: BeingDB's row limit cut the result.</p>`
    : res.hasMore
      ? `<p>${res.count}${of} rows (more match beyond the query's limit)</p>`
      : `<p>${res.count}${of} rows</p>`;
  return `${summary}<table><tr>${head}</tr>${rows}</table>`;
}

let generator;
let modelInfo;
let stage = "";

const setState = (text, cls = "") => {
  $("state").textContent = text;
  $("state").className = `state ${cls}`;
};
const setAskStatus = (text, cls = "note") => {
  $("ask-status").textContent = text;
  $("ask-status").className = cls;
};

// WebLLM reports blocked or failed downloads in several ways; all mean the weights never arrived.
const looksLikeDownloadFailure = (msg) => /fetch|network|download|cache|status|40[0-9]|50[0-9]|cors|aborted/i.test(msg);

async function loadModel() {
  $("load").disabled = true;
  $("progress").hidden = false;
  setState("Loading the model… (the first time, this downloads about 2 GB)");
  try {
    ({ generator, info: modelInfo } = await setupModel(log, (p) => {
      $("progress").value = p.progress;
      $("progress-text").textContent = p.text;
    }, {
      recoverGrammarErrors: true,
      onRecover: (e) => {
        log(`WebLLM grammar error (${e.message}); reloading the model and retrying`);
        stage = "The model hit an internal error; reloading it and retrying (20-30 s)";
      },
    }));
    $("progress").hidden = true;
    $("progress-text").textContent = "";
    $("ask").disabled = false;
    $("load").hidden = true;
    setState(`Ready: ${modelInfo.modelId}. Ask a question.`, "ok");
    setAskStatus("");
    window.demo.generator = generator;
  } catch (e) {
    log(`Model failed: ${e.message}`);
    $("progress").hidden = true;
    $("load").disabled = false;
    $("load").textContent = "Try again";
    setState(
      looksLikeDownloadFailure(e.message)
        ? `The model could not be downloaded (${e.message}). A firewall or proxy may be blocking the model files from Hugging Face (huggingface.co, *.hf.co): try another network.`
        : `The model could not be loaded: ${e.message}`,
      "bad",
    );
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
  const { db, schema, prompt, summary } = await setupDatabase(log);
  $("prompt").textContent =
    prompt.messages("<question>").map((m) => `[${m.role}]\n${m.content}`).join("\n\n") +
    `\n\n[decoding grammar]\n${prompt.format.grammar}`;
  // For poking at the pipeline from the devtools console.
  window.demo = { db, schema, prompt, ask };

  const { items } = await (await fetch("eval/questions.json")).json();
  const group = (label, list) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const it of list) g.append(new Option(it.question, it.question));
    $("samples").append(g);
  };
  group("Answerable from the facts", items.filter((it) => it.level !== "unsupported"));
  group("Not in the facts (the model should say so)", items.filter((it) => it.level === "unsupported"));
  $("samples").addEventListener("change", (e) => e.target.value && ($("question").value = e.target.value));

  async function onAsk() {
    const question = $("question").value.trim();
    if (!question) return setAskStatus("Type a question first.", "warn");
    $("ask").disabled = true;
    $("ask").textContent = "Working…";
    $("answer").hidden = true;
    const t0 = performance.now();
    stage = "The model is writing a BeingDB query";
    const tick = () => setAskStatus(`${stage}… ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    tick();
    const timer = setInterval(tick, 500);
    try {
      const run = await ask({
        question, generator, db, schema, prompt, repairPolicy: "proven-only",
        onProgress: ({ attempt, repair }) => {
          stage = repair ? `BeingDB rejected the query; the model is fixing it (attempt ${attempt})` : stage;
        },
      });
      render(run);
      setAskStatus(`Done in ${(run.totalMs / 1000).toFixed(1)} s.`);
    } catch (e) {
      log(`Error: ${e.message}`);
      setAskStatus(`Something went wrong: ${e.message}`, "bad");
    } finally {
      clearInterval(timer);
      $("ask").disabled = false;
      $("ask").textContent = "Ask BeingDB";
    }
  }
  $("ask").addEventListener("click", onAsk);
  $("question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("ask").disabled) onAsk();
  });

  $("load").disabled = false;
  $("load").addEventListener("click", loadModel);
  const facts = `BeingDB is ready (${summary.predicates} predicates, ${summary.facts.toLocaleString()} facts).`;
  if (!navigator.gpu) {
    $("load").disabled = true;
    setState(`${facts} This browser has no WebGPU, so the model cannot run here: use a current Chrome or Edge on a desktop or laptop.`, "bad");
  } else if (await modelIsCached()) loadModel();
  else setState(`${facts} Click Load model to download the model (about 2 GB, once; the browser keeps it).`);
} catch (e) {
  log(`Startup failed: ${e.message}`);
  setState(`Startup failed: ${e.message}`, "bad");
}
