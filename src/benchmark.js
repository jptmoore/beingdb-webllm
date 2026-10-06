// Browser side of the reproducible benchmark (scripts/benchmark.mjs drives it
// through Playwright). The same setup, pipeline and scorer as the demo and
// eval pages; this page only exposes them as window.bench for automation.
import { setupDatabase } from "./setup.js";
import { WebLLMGenerator, prebuiltModels } from "./generator.js";
import { ask } from "./pipeline.js";
import { analyseQuestion, analyseError, buildAnalysisContext, sha256 } from "./analysis.js";
import { EXAMPLES, RULES, PROMPT_VERSION } from "./prompt.js";
import { collectEnvironment } from "./environment.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const log = (msg) => {
  $("log").textContent += msg + "\n";
  console.log(`[bench] ${msg}`);
};

// Background tabs are throttled; record how long the page was hidden during each question.
let hiddenSince = document.visibilityState === "hidden" ? performance.now() : null;
let hiddenTotal = 0;
let visibilityChanges = 0;
document.addEventListener("visibilitychange", () => {
  visibilityChanges++;
  if (document.visibilityState === "hidden") hiddenSince = performance.now();
  else if (hiddenSince !== null) {
    hiddenTotal += performance.now() - hiddenSince;
    hiddenSince = null;
  }
  $("visibility").textContent = document.visibilityState === "hidden" ? "Page hidden: timings may be throttled" : "";
});
const hiddenMs = () => hiddenTotal + (hiddenSince !== null ? performance.now() - hiddenSince : 0);

const state = {};
const ready = (async () => {
  const { db, summary, timings, schema, prompt } = await setupDatabase(log);
  const t = performance.now();
  const ctx = buildAnalysisContext(db, schema);
  timings.analysisContextMs = performance.now() - t;
  Object.assign(state, { db, dbSummary: summary, dbTimings: timings, schema, prompt, ctx });
})();

async function promptInfo() {
  const { prompt, schema } = state;
  return {
    version: PROMPT_VERSION,
    chars: prompt.chars,
    fewShotExamples: EXAMPLES.length,
    sha256: {
      rules: await sha256(RULES),
      examples: await sha256(JSON.stringify(EXAMPLES)),
      schemaText: await sha256(schema.text),
      systemPrompt: await sha256(prompt.system),
      messages: await sha256(JSON.stringify(prompt.messages("<question>"))),
      grammar: await sha256(prompt.format.grammar),
      fixGrammar: await sha256(prompt.fixFormat.grammar),
    },
    schemaStats: schema.stats,
    text: { system: prompt.system, examples: EXAMPLES, grammar: prompt.format.grammar, fixGrammar: prompt.fixFormat.grammar },
  };
}

const phaseOf = (text) =>
  /^Fetching param cache/.test(text) ? "download"
  : /^Loading model from cache/.test(text) ? "cache_read"
  : /^Loading GPU shader modules/.test(text) ? "shader_compile"
  : "other";

// Minimum WebGPU capabilities WebLLM 0.2.85 requests in detectGPUDevice().
const WEBLLM_LIMITS = { maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32 << 10, maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 };

function compatibility(env, modelId) {
  const record = prebuiltModels().find((m) => m.model_id === modelId) ?? null;
  const gpu = env.webgpu;
  const a = gpu.adapter;
  const checks = [
    { id: "webgpu_available", ok: gpu.available, detail: gpu.available ? null : "navigator.gpu is missing" },
    { id: "adapter", ok: !!a, detail: a ? null : "requestAdapter() returned null" },
    {
      id: "hardware_adapter",
      ok: !!a && !a.softwareRenderer,
      detail: a ? `vendor=${a.info?.vendor ?? "?"} architecture=${a.info?.architecture ?? "?"} fallback=${a.isFallbackAdapter}` : null,
    },
    { id: "model_in_registry", ok: !!record, detail: record ? null : `${modelId} is not a WebLLM prebuilt model id` },
  ];
  if (a) {
    const needsF16 = !!record && (record.required_features?.includes("shader-f16") || /q\df16/.test(modelId));
    checks.push({ id: "shader_f16", ok: !needsF16 || a.features.includes("shader-f16"), required: needsF16, available: a.features.includes("shader-f16") });
    for (const [k, min] of Object.entries(WEBLLM_LIMITS)) checks.push({ id: k, ok: (a.limits?.[k] ?? 0) >= min, required: min, available: a.limits?.[k] ?? null });
    if (record?.buffer_size_required_bytes)
      checks.push({
        id: "model_buffer_size",
        ok: (a.limits?.maxStorageBufferBindingSize ?? 0) >= record.buffer_size_required_bytes,
        required: record.buffer_size_required_bytes,
        available: a.limits?.maxStorageBufferBindingSize ?? null,
      });
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    model: record && {
      vramRequiredMB: record.vram_required_MB ?? null,
      lowResourceRequired: record.low_resource_required ?? null,
      requiredFeatures: record.required_features ?? [],
      overrides: record.overrides ?? null,
    },
  };
}

window.bench = {
  ready,
  status(text) {
    $("status").textContent = text;
  },
  async environment(modelId) {
    await ready;
    const browser = await collectEnvironment();
    return {
      browser,
      compatibility: compatibility(browser, modelId),
      beingdb: { ...state.dbSummary, timings: state.dbTimings },
      prompt: await promptInfo(),
    };
  },

  async loadModel(modelId, { generation = {}, cold = false } = {}) {
    await ready;
    const gen = new WebLLMGenerator(modelId, generation);
    const cachedBefore = await gen.isCached();
    let deletedFromCache = false;
    if (cold && cachedBefore) {
      await gen.deleteFromCache();
      deletedFromCache = true;
    }
    const cachedAtLoad = deletedFromCache ? await gen.isCached() : cachedBefore;
    const usage = async () => (navigator.storage?.estimate ? (await navigator.storage.estimate()).usage ?? null : null);
    const storageBeforeBytes = await usage();
    const events = [];
    const t0 = performance.now();
    log(`Loading ${modelId} (${cachedAtLoad ? "browser cache" : "download"}, ~${Math.round(gen.record.vram_required_MB)} MB VRAM)…`);
    try {
      await gen.load((p) => {
        if (events.length < 5000) events.push({ ms: Math.round(performance.now() - t0), progress: p.progress, text: p.text });
        $("progress").value = p.progress;
        $("progress-text").textContent = p.text;
      });
    } catch (e) {
      log(`Model load failed: ${e.message}`);
      return { ok: false, error: String(e.message || e), cachedBefore, cachedAtLoad, progressEvents: events };
    }
    state.generator = gen;
    const phases = {};
    for (const e of events) {
      const p = (phases[phaseOf(e.text)] ??= { firstMs: e.ms, lastMs: e.ms, events: 0 });
      p.lastMs = e.ms;
      p.events++;
    }
    const storageAfterBytes = await usage();
    const tryCall = async (f) => {
      try {
        return await f();
      } catch {
        return null;
      }
    };
    log(`Model ready in ${(gen.loadMs / 1000).toFixed(1)} s`);
    return {
      ok: true,
      modelId,
      record: gen.record,
      cachedBefore,
      cachedAtLoad,
      coldCacheRequested: cold,
      deletedFromCache,
      loadMs: gen.loadMs,
      phases,
      progressEvents: events,
      storageBeforeBytes,
      storageAfterBytes,
      storageDeltaBytes: storageBeforeBytes !== null && storageAfterBytes !== null ? storageAfterBytes - storageBeforeBytes : null,
      chatConfig: JSON.parse(JSON.stringify(gen.chatConfig() ?? null)),
      gpuVendor: await tryCall(() => gen.engine.getGPUVendor()),
      maxStorageBufferBindingSize: await tryCall(() => gen.engine.getMaxStorageBufferBindingSize()),
      generation: gen.options,
    };
  },

  // One generation on a few-shot example question (not an eval question): proves the
  // model runs, compiles the main grammar, and measures the real prompt size.
  async smoke({ maxRepairs }) {
    const g = state.generator;
    const { prompt } = state;
    const ex = EXAMPLES[0];
    let r;
    try {
      r = await g.complete(prompt.messages(ex.q), prompt.format, { temperature: 0 });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    const contextWindow = g.chatConfig()?.context_window_size ?? null;
    const promptTokens = r.usage?.prompt_tokens ?? null;
    // Repairs continue the conversation: each adds a reply (<= max_tokens) and ~50-150 feedback tokens.
    const needed = promptTokens === null ? null : promptTokens + (maxRepairs + 1) * g.options.maxTokens + maxRepairs * 150;
    const contextOk = contextWindow === null || contextWindow <= 0 || needed === null ? null : needed <= contextWindow;
    return { ok: contextOk !== false, question: ex.q, reply: r.text, expected: ex.a, matchesExample: r.text.trim() === ex.a, usage: r.usage, ms: r.ms, contextWindow, estimatedTokensNeeded: needed, contextOk };
  },

  // Optional: also compile the repair grammar and run one more example so the
  // first timed question does not pay one-off costs.
  async warmup() {
    const g = state.generator;
    const { prompt } = state;
    const out = [];
    for (const [ex, format, name] of [
      [EXAMPLES[1], prompt.format, "query_or_unsupported"],
      [EXAMPLES[2], prompt.fixFormat, "query_only"],
    ]) {
      const r = await g.complete(prompt.messages(ex.q), format, { temperature: 0 });
      out.push({ question: ex.q, grammar: name, reply: r.text, ms: r.ms, usage: r.usage });
    }
    return out;
  },

  async runQuestion(item, { maxRepairs, temperature, repairTemperature, repairPolicy = "model", label }) {
    const { db, schema, prompt, ctx, generator } = state;
    // BeingDB (WasmGC) shares the JS heap with WebLLM and the analysis code. Collecting their
    // garbage just before each pipeline BeingDB call keeps GC pauses out of the timed call.
    // gc() exists only when the browser runs with --js-flags=--expose-gc (the runner sets it).
    const gcBeforeBeingDBQuery = typeof globalThis.gc === "function";
    const pipelineDb = gcBeforeBeingDBQuery
      ? { ...db, query: (dsl) => (globalThis.gc(), db.query(dsl)), diagnose: (dsl) => (globalThis.gc(), db.diagnose(dsl)) }
      : db;
    const h0 = hiddenMs();
    const v0 = visibilityChanges;
    const started = new Date().toISOString();
    let record;
    try {
      const run = await ask({ question: item.question, generator, db: pipelineDb, schema, prompt, maxRepairs, temperature, repairTemperature, repairPolicy });
      record = await analyseQuestion({ item, run, db, schema, ctx });
    } catch (e) {
      log(`${item.id}: ${e.message}`);
      record = await analyseError({ item, error: e, attempts: e.attempts || [], db });
    }
    record.page = {
      started,
      gcBeforeBeingDBQuery,
      hiddenMs: hiddenMs() - h0,
      visibilityChanges: visibilityChanges - v0,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      jsHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null,
    };
    const mark = (b) => (b === null || b === undefined ? "" : b ? "✓" : "✗");
    $("table").insertAdjacentHTML(
      "beforeend",
      `<tr><td>${esc(label)}</td><td>${esc(item.id)}</td><td>${esc(item.question)}</td><td>${record.outcome}</td><td>${record.repairs}</td>` +
        `<td>${mark(record.score.firstValid)}</td><td>${mark(record.score.correct)}</td><td>${esc(record.failure?.category || "")}</td>` +
        `<td><pre>${esc(record.final.dsl || "")}</pre></td><td>${Math.round(record.timing.llmMs)}</td><td>${record.timing.dbMs.toFixed(1)}</td>` +
        `<td>${record.efficiency?.calls ? `${record.efficiency.calls.model} / ${record.efficiency.calls.beingdb} / ${record.efficiency.calls.deterministicRepairs}` : ""}</td></tr>`,
    );
    return record;
  },

  async unload() {
    await state.generator?.engine.unload();
    state.generator = null;
  },
};
