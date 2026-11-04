import { setupDatabase, setupModel, modelIsCached, CHAT_MODELS } from "./setup.js";
import { DEFAULT_MODEL, prebuiltModels } from "./generator.js";
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
let loading = false;
let stage = "";

// The chosen model: ?model= wins (as on the eval pages), then the last choice made here.
const MODEL_KEY = "rewind-chatbot-model";
const knownModel = (id) => !!id && prebuiltModels().some((m) => m.model_id === id);
let modelId = [new URLSearchParams(location.search).get("model"), localStorage.getItem(MODEL_KEY), DEFAULT_MODEL].find(knownModel);
const modelChoice = (id) => CHAT_MODELS.find((m) => m.id === id) ?? { id, label: id };
const vramGB = (id) => prebuiltModels().find((m) => m.model_id === id).vram_required_MB / 1024;
const downloadText = (id) => (modelChoice(id).downloadGB ? `about ${modelChoice(id).downloadGB} GB` : "a few GB");
const cachedModels = new Set();
let gpuF16 = true;

// Set while a model loads; still set at the next visit if the tab crashed or hung during the load
// (typically a model too large for the GPU), so that model is not loaded automatically again.
const LOADING_KEY = "rewind-chatbot-loading";

// Browser cache and GPU queries can stall (e.g. after a GPU crash); never let them block the page.
const withTimeout = (promise, ms, fallback, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        log(`${what} did not answer within ${ms / 1000} s; carrying on`);
        resolve(fallback);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const checkCached = (id) =>
  withTimeout(Promise.resolve().then(() => modelIsCached(id)).catch(() => false), 20000, false, `Cache check for ${id}`);

// Marks the other downloaded models in the picker. Runs once, one query at a time, and only
// while no model is loading, so it never competes with a load for the browser cache.
let checkedOthers = false;
async function checkOtherModels() {
  if (checkedOthers) return;
  checkedOthers = true;
  for (const m of CHAT_MODELS) {
    if (loading) return void (checkedOthers = false);
    if (cachedModels.has(m.id)) continue;
    if (await checkCached(m.id)) cachedModels.add(m.id);
    renderModelPicker();
  }
}

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
  $("model-select").disabled = !navigator.gpu || !db || busy;
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
    <p class="muted">This downloads ${esc(modelChoice(modelId).label)} (${downloadText(modelId)}) once; your browser keeps it for next time.
    You can pick a different model from the ☰ menu. Nothing you type leaves your computer.</p>`;
}

function renderModelPicker() {
  const select = $("model-select");
  const ids = CHAT_MODELS.map((m) => m.id);
  if (!ids.includes(modelId)) ids.push(modelId);
  select.innerHTML = ids
    .map((id) => {
      const m = modelChoice(id);
      const needsF16 = prebuiltModels().find((r) => r.model_id === id).required_features?.includes("shader-f16");
      const off = needsF16 && !gpuF16;
      const extra = [m.downloadGB && `${m.downloadGB} GB`, m.note, cachedModels.has(id) && "downloaded", off && "not supported by this GPU"]
        .filter(Boolean)
        .join(", ");
      return `<option value="${esc(id)}"${id === modelId ? " selected" : ""}${off ? " disabled" : ""}>${esc(m.label)}${extra ? ` (${esc(extra)})` : ""}</option>`;
    })
    .join("");
  select.disabled = !navigator.gpu || !db || busy;
  const state = modelInfo?.modelId === modelId ? "Loaded." : cachedModels.has(modelId) ? "Downloaded, not loaded." : "Not downloaded yet.";
  $("model-note").textContent =
    `${state} Download: ${downloadText(modelId)}; needs about ${vramGB(modelId).toFixed(1)} GB of GPU memory. ` +
    `Larger models may answer better but are slower and need more memory.`;
}

async function switchModel(id) {
  if (id === modelId || busy) return renderModelPicker();
  modelId = id;
  localStorage.setItem(MODEL_KEY, id);
  const url = new URL(location.href);
  if (url.searchParams.has("model")) {
    url.searchParams.set("model", id);
    history.replaceState(null, "", url);
  }
  // WebLLM cannot cancel a load in progress (and a stuck one holds the GPU), so start afresh.
  if (loading) {
    localStorage.removeItem(LOADING_KEY);
    return location.reload();
  }
  ready = false;
  setReady(false);
  document.querySelectorAll("[data-load]").forEach((b) => b.closest(".msg")?.remove());
  const old = generator;
  generator = modelInfo = undefined;
  if (old) await withTimeout(old.engine.unload().catch((e) => log(`Unload failed: ${e.message}`)), 10000, undefined, "Unloading the previous model");
  setMenu(false);
  const label = esc(modelChoice(id).label);
  const bubble = addMessage("bot", "");
  if (cachedModels.has(id)) loadModel(bubble, true);
  else {
    setStatus(`${modelChoice(id).label} is not downloaded yet.`, "Not started");
    renderModelPicker();
    offerLoad(bubble, `Switching to ${label}. I need to download it first.`);
  }
}

async function loadModel(bubble, switched = false) {
  if (loading) return;
  loading = true;
  const label = modelChoice(modelId).label;
  renderModelPicker();
  bubble.innerHTML = `<p>${switched ? `Switching to ${esc(label)}…` : "Getting ready…"} <span class="muted" data-progress-text></span></p><progress max="1" value="0"></progress>
    <p class="muted" data-stalled hidden>This is taking longer than expected. If it stays stuck, choose a smaller model from the ☰ menu or reload the page.</p>`;
  const bar = bubble.querySelector("progress");
  const progressText = bubble.querySelector("[data-progress-text]");
  setStatus(`Loading ${label}…${cachedModels.has(modelId) ? "" : ` (the first time, this downloads ${downloadText(modelId)})`}`, "Loading…");
  localStorage.setItem(LOADING_KEY, modelId);
  const t0 = performance.now();
  let lastProgress = t0;
  let percent = 0;
  const watchdog = setInterval(() => {
    const now = performance.now();
    progressText.textContent = `${percent}% · ${((now - t0) / 1000).toFixed(0)} s`;
    if (now - lastProgress > 60000 && bubble.querySelector("[data-stalled]")) bubble.querySelector("[data-stalled]").hidden = false;
  }, 1000);
  try {
    ({ generator, info: modelInfo } = await setupModel(log, (p) => {
      bar.value = p.progress;
      percent = Math.round(p.progress * 100);
      lastProgress = performance.now();
      progressText.textContent = `${percent}% · ${((lastProgress - t0) / 1000).toFixed(0)} s`;
      if (bubble.querySelector("[data-stalled]")) bubble.querySelector("[data-stalled]").hidden = true;
    }, {
      recoverGrammarErrors: true,
      onRecover: (e) => {
        log(`WebLLM grammar error (${e.message}); reloading the model and retrying`);
        stage = "Hit a snag, restarting and trying again";
      },
    }, modelId));
    window.demo.generator = generator;
    cachedModels.add(modelId);
    gpuF16 = modelInfo.f16 ?? true;
    setStatus(`Ready: ${label} (${modelInfo.modelId}).`, "Ready", "ok");
    ready = true;
    if (switched) {
      bubble.innerHTML = `<p>Now using <b>${esc(label)}</b>. Ask me anything about the REWIND interviews.</p>`;
      setReady(true);
    } else {
      bubble.closest(".msg").remove();
      greet();
    }
    $("question").focus();
    setTimeout(checkOtherModels, 0);
  } catch (e) {
    log(`Model failed: ${e.message}`);
    const why = looksLikeDownloadFailure(e.message)
      ? `I couldn't download ${esc(label)}. A firewall or proxy may be blocking huggingface.co: try another network.`
      : `I couldn't start ${esc(label)}. It may need more GPU memory than is available: try a smaller model from the ☰ menu.`;
    setStatus(`The model could not be loaded: ${e.message}`, "Error", "bad");
    bubble.innerHTML = `<p>${why}</p><p class="muted">${esc(e.message)}</p><p><button class="primary" data-load>Try again</button></p>`;
  } finally {
    clearInterval(watchdog);
    localStorage.removeItem(LOADING_KEY);
    loading = false;
    renderModelPicker();
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

$("model-select").addEventListener("change", (e) => switchModel(e.target.value));
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
  if (e.target.closest("[data-load]")) return loadModel(e.target.closest(".bubble"), !!$("chat").querySelector(".suggestions"));
  const more = e.target.closest("[data-more]");
  if (more) {
    more.parentElement.querySelectorAll("[data-extra]").forEach((el) => (el.hidden = false));
    more.remove();
  }
});

const startBubble = addMessage("bot", `<span class="typing"><span></span><span></span><span></span></span>Starting up…`);
renderModelPicker();
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
  const label = modelChoice(modelId).label;
  const interrupted = localStorage.getItem(LOADING_KEY) === modelId;
  localStorage.removeItem(LOADING_KEY);
  if (navigator.gpu) {
    // Only the chosen model, as before the picker existed: in Safari, extra cache or WebGPU
    // queries running alongside a model load can stall the load. See checkOtherModels().
    startBubble.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>Checking for ${esc(label)}…`;
    if (await checkCached(modelId)) cachedModels.add(modelId);
  }
  renderModelPicker();
  if (!navigator.gpu) {
    setStatus(`${facts} This browser has no WebGPU, so the model cannot run here.`, "Unsupported browser", "bad");
    startBubble.innerHTML = `<p>Sorry, this browser can't run the chatbot: it needs WebGPU. Please use a current Chrome, Edge or Safari on a desktop or laptop.</p>`;
  } else if (interrupted) {
    setStatus(`${facts} ${label} did not finish loading last time.`, "Not started", "bad");
    startBubble.innerHTML = `<p>Last time, ${esc(label)} didn't finish loading. It may need more memory than this device has.</p>
      <p>Pick a smaller model from the ☰ menu, or try again.</p><p><button class="primary" data-load>Try ${esc(label)} again</button></p>`;
  } else if (cachedModels.has(modelId)) {
    loadModel(startBubble);
  } else {
    setStatus(`${facts} ${label} is not downloaded yet.`, "Not started");
    offerLoad(startBubble, "Hi! I'm the Rewind interview chatbot. I can answer questions about the artists and works in the REWIND interviews.");
  }
} catch (e) {
  log(`Startup failed: ${e.message}`);
  setStatus(`Startup failed: ${e.message}`, "Error", "bad");
  startBubble.innerHTML = `<p>Sorry, I couldn't start: ${esc(e.message)}</p>`;
}
