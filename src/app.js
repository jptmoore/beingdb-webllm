import { setupDatabase, setupModel, modelIsCached } from "./setup.js";
import { ask } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const log = (msg) => ($("log").textContent += msg + "\n");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The exact BeingDB rows, shown in the technical details.
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
  return `${summary}<div class="table-wrap"><table><tr>${head}</tr>${rows}</table></div>`;
}

// Friendly display of BeingDB values: atoms like `david_critchley` become "David Critchley".
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
export function displayValue(cell) {
  if (!cell) return "—";
  if (cell.type !== "atom") return String(cell.value);
  return String(cell.value)
    .split("_")
    .filter(Boolean)
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w) ? w : /^[^aeiouy\d]{2,4}$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ")
    .replace(/ S\b/g, "'s");
}
const words = (variable) => variable.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
const plural = (w) => (/[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(w) ? w + "es" : w + "s");
const header = (variable) => {
  const w = words(variable);
  return w[0].toUpperCase() + w.slice(1);
};

const SHOWN = 10;
const moreButton = (n) => (n > SHOWN ? `<button class="more" data-more>Show all ${n}</button>` : "");
const hiddenIf = (i) => (i >= SHOWN ? " hidden data-extra" : "");

export function friendlyAnswer(res) {
  const n = res.results.length;
  if (!n) return `<p>I couldn't find anything in the interview facts that matches that. Try rephrasing, or ask about something else.</p>`;
  const vars = res.variables;
  const noun = vars.length === 1 ? words(vars[0]) : "result";
  const things = (k) => `${k} ${k === 1 ? noun : plural(noun)}`;
  const intro =
    res.total !== undefined && res.total > n
      ? `Here are the first ${things(n)} of ${res.total} I found:`
      : res.hasMore || res.truncated
        ? `Here are ${things(n)} I found (there are more):`
        : `I found ${things(n)}:`;
  let body;
  if (vars.length === 1) {
    body = `<ul>${res.results.map((r, i) => `<li${hiddenIf(i)}>${esc(displayValue(r[vars[0]]))}</li>`).join("")}</ul>`;
  } else {
    const head = vars.map((v) => `<th>${esc(header(v))}</th>`).join("");
    const rows = res.results
      .map((r, i) => `<tr${hiddenIf(i)}>${vars.map((v) => `<td>${esc(displayValue(r[v]))}</td>`).join("")}</tr>`)
      .join("");
    body = `<div class="table-wrap"><table class="answer-table"><tr>${head}</tr>${rows}</table></div>`;
  }
  return `<p>${esc(intro)}</p>${body}${moreButton(n)}`;
}

function technicalDetails(run) {
  const last = run.attempts.at(-1);
  const status = {
    ok: `<span class="ok">Valid: BeingDB executed the query</span>`,
    unsupported: `<span class="warn">The model reports the question cannot be expressed: ${esc(last.reply.reason || "")}</span>`,
    failed: `<span class="bad">No valid query after ${run.repairs} repair attempt(s)</span>`,
  }[run.outcome];
  const attempts = run.attempts
    .map(
      (a, i) =>
        `<p><b>Attempt ${i + 1}</b> (${a.llmMs.toFixed(0)} ms, ${a.usage?.prompt_tokens ?? "?"} prompt / ${a.usage?.completion_tokens ?? "?"} completion tokens)</p>` +
        `<pre>${esc(a.raw)}</pre>` +
        (a.db ? `<p>BeingDB: ${esc(a.db.status)} in ${a.db.ms.toFixed(1)} ms</p>` : "") +
        (a.feedback ? `<pre>${esc(a.feedback)}</pre>` : ""),
    )
    .join("");
  return `<div class="tech">
    <h4>Generated query <span class="muted">(${esc(modelInfo.modelId)})</span></h4>
    <pre>${esc(last.reply.dsl || `(no query) ${last.reply.reason || last.reply.error || ""}`)}</pre>
    <p>${status} · repair attempts: ${run.repairs}</p>
    <p class="muted">LLM: ${run.llmMs.toFixed(0)} ms (${run.attempts.length} call${run.attempts.length > 1 ? "s" : ""}) ·
      BeingDB: ${run.dbMs.toFixed(1)} ms · total: ${run.totalMs.toFixed(0)} ms</p>
    <details${run.repairs > 0 ? " open" : ""}><summary>Attempts and BeingDB feedback</summary>${attempts}</details>
    ${last.db?.status === "ok" ? `<details><summary>BeingDB rows</summary>${resultsTable(last.db.response)}</details>` : ""}
    ${last.db ? `<details><summary>Raw BeingDB response</summary><pre>${esc(JSON.stringify(last.db.response, null, 2))}</pre></details>` : ""}
  </div>`;
}

function renderRun(run) {
  const last = run.attempts.at(-1);
  const text =
    run.outcome === "ok"
      ? friendlyAnswer(last.db.response)
      : run.outcome === "unsupported"
        ? `<p>Sorry, I can't answer that from the REWIND interview facts. I know about the interviewed artists, their works, and the people and organisations around them.</p>`
        : `<p>Sorry, I couldn't work out how to answer that. Could you try rephrasing the question?</p>`;
  return text + technicalDetails(run);
}

// ---- chat UI ----

let generator;
let modelInfo;
let db, schema, prompt;
let samples = [];
let ready = false;
let busy = false;
let stage = "";

function addMessage(role, html) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.innerHTML = `${role === "bot" ? `<div class="avatar" aria-hidden="true">R</div>` : ""}<div class="bubble"></div>`;
  const bubble = msg.querySelector(".bubble");
  if (role === "user") bubble.textContent = html;
  else bubble.innerHTML = html;
  $("chat").append(msg);
  msg.scrollIntoView({ block: "end", behavior: "smooth" });
  return bubble;
}

function setStatus(text, pill, cls = "") {
  $("state").textContent = text;
  $("state").className = `state ${cls}`;
  $("status-pill").textContent = pill;
  $("status-pill").className = `pill ${cls}`;
}

function setReady(on) {
  $("question").disabled = !on || busy;
  $("ask").disabled = !on || busy;
  document.querySelectorAll(".chip").forEach((c) => (c.disabled = !on || busy));
}

function pickSamples(k = 4) {
  return [...samples].sort(() => Math.random() - 0.5).slice(0, k);
}

function greet() {
  const chips = pickSamples()
    .map((q) => `<button class="chip" data-question="${esc(q)}">${esc(q)}</button>`)
    .join("");
  addMessage(
    "bot",
    `<p>Hi! I'm the Rewind interview chatbot. Ask me about the artists interviewed for REWIND, their works, collaborators, funders and more.</p>
     <p>Not sure where to start? Try one of these:</p><div class="suggestions">${chips}</div>`,
  );
  setReady(ready);
}

// WebLLM reports blocked or failed downloads in several ways; all mean the weights never arrived.
const looksLikeDownloadFailure = (msg) => /fetch|network|download|cache|status|40[0-9]|50[0-9]|cors|aborted/i.test(msg);

function offerLoad(bubble, intro) {
  bubble.innerHTML = `<p>${intro}</p><p><button class="primary" data-load>Start the chatbot</button></p>
    <p class="muted">This downloads the language model (about 2 GB) once; your browser keeps it for next time. Nothing you type leaves your computer.</p>`;
}

async function loadModel(bubble) {
  bubble.innerHTML = `<p>Getting ready… <span class="muted" data-progress-text></span></p><progress max="1" value="0"></progress>`;
  const bar = bubble.querySelector("progress");
  const label = bubble.querySelector("[data-progress-text]");
  setStatus("Loading the model… (the first time, this downloads about 2 GB)", "Loading…");
  try {
    ({ generator, info: modelInfo } = await setupModel(log, (p) => {
      bar.value = p.progress;
      label.textContent = `${Math.round(p.progress * 100)}%`;
    }, {
      recoverGrammarErrors: true,
      onRecover: (e) => {
        log(`WebLLM grammar error (${e.message}); reloading the model and retrying`);
        stage = "Hit a snag, restarting and trying again";
      },
    }));
    window.demo.generator = generator;
    $("model-id").textContent = modelInfo.modelId;
    setStatus(`Ready: ${modelInfo.modelId}.`, "Ready", "ok");
    ready = true;
    bubble.closest(".msg").remove();
    greet();
    $("question").focus();
  } catch (e) {
    log(`Model failed: ${e.message}`);
    const why = looksLikeDownloadFailure(e.message)
      ? "I couldn't download the language model. A firewall or proxy may be blocking huggingface.co: try another network."
      : "I couldn't start the language model.";
    setStatus(`The model could not be loaded: ${e.message}`, "Error", "bad");
    bubble.innerHTML = `<p>${why}</p><p class="muted">${esc(e.message)}</p><p><button class="primary" data-load>Try again</button></p>`;
  }
}

async function onAsk(question) {
  question = question.trim();
  if (!question || !ready || busy) return;
  busy = true;
  setReady(true);
  $("question").value = "";
  autoGrow();
  addMessage("user", question);
  const bubble = addMessage("bot", "");
  const t0 = performance.now();
  stage = "Looking through the interviews";
  const tick = () =>
    (bubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>${esc(stage)}… <span class="muted">${((performance.now() - t0) / 1000).toFixed(0)} s</span>`);
  tick();
  const timer = setInterval(tick, 500);
  try {
    const run = await ask({
      question, generator, db, schema, prompt, repairPolicy: "proven-only",
      onProgress: ({ repair }) => {
        if (repair) stage = "Refining my search";
      },
    });
    clearInterval(timer);
    bubble.innerHTML = renderRun(run);
  } catch (e) {
    clearInterval(timer);
    log(`Error: ${e.message}`);
    bubble.innerHTML = `<p>Sorry, something went wrong: ${esc(e.message)}</p>`;
  } finally {
    busy = false;
    setReady(true);
    bubble.closest(".msg").scrollIntoView({ block: "end", behavior: "smooth" });
    $("question").focus();
  }
}

function autoGrow() {
  const q = $("question");
  q.style.height = "auto";
  q.style.height = `${q.scrollHeight}px`;
}

function setMenu(open) {
  $("menu").hidden = !open;
  $("scrim").hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
}

$("menu-button").addEventListener("click", () => setMenu($("menu").hidden));
$("menu-close").addEventListener("click", () => setMenu(false));
$("scrim").addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && setMenu(false));

const TECH_KEY = "rewind-chatbot-show-tech";
$("show-tech").checked = localStorage.getItem(TECH_KEY) === "1";
document.body.classList.toggle("show-tech", $("show-tech").checked);
$("show-tech").addEventListener("change", (e) => {
  document.body.classList.toggle("show-tech", e.target.checked);
  localStorage.setItem(TECH_KEY, e.target.checked ? "1" : "0");
});
$("clear").addEventListener("click", () => {
  if (busy || !ready) return;
  $("chat").innerHTML = "";
  greet();
  setMenu(false);
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  onAsk($("question").value);
});
$("question").addEventListener("input", autoGrow);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    onAsk($("question").value);
  }
});
$("chat").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip && !chip.disabled) return onAsk(chip.dataset.question);
  if (e.target.closest("[data-load]")) return loadModel(e.target.closest(".bubble"));
  const more = e.target.closest("[data-more]");
  if (more) {
    more.parentElement.querySelectorAll("[data-extra]").forEach((el) => (el.hidden = false));
    more.remove();
  }
});

const startBubble = addMessage("bot", `<span class="typing"><span></span><span></span><span></span></span>Starting up…`);
try {
  let summary;
  ({ db, schema, prompt, summary } = await setupDatabase(log));
  $("prompt").textContent =
    prompt.messages("<question>").map((m) => `[${m.role}]\n${m.content}`).join("\n\n") +
    `\n\n[decoding grammar]\n${prompt.format.grammar}`;
  // For poking at the pipeline from the devtools console.
  window.demo = { db, schema, prompt, ask };

  const { items } = await (await fetch("eval/questions.json")).json();
  samples = items.filter((it) => it.level !== "unsupported").map((it) => it.question);

  const facts = `BeingDB is ready (${summary.predicates} predicates, ${summary.facts.toLocaleString()} facts).`;
  if (!navigator.gpu) {
    setStatus(`${facts} This browser has no WebGPU, so the model cannot run here.`, "Unsupported browser", "bad");
    startBubble.innerHTML = `<p>Sorry, this browser can't run the chatbot: it needs WebGPU. Please use a current Chrome or Edge on a desktop or laptop.</p>`;
  } else if (await modelIsCached()) {
    loadModel(startBubble);
  } else {
    setStatus(`${facts} The model is not downloaded yet.`, "Not started");
    offerLoad(startBubble, "Hi! I'm the Rewind interview chatbot. I can answer questions about the artists and works in the REWIND interviews.");
  }
} catch (e) {
  log(`Startup failed: ${e.message}`);
  setStatus(`Startup failed: ${e.message}`, "Error", "bad");
  startBubble.innerHTML = `<p>Sorry, I couldn't start: ${esc(e.message)}</p>`;
}
