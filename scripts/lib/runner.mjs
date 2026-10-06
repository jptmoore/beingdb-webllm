// One benchmark run: start/reuse the static server, launch a real Chromium-based
// browser with a persistent profile (so model weights stay cached), drive
// benchmark.html through the same pipeline/scorer as the demo, and write
//   <output>/<runId>/run.json        metadata, config, environment, provenance, compatibility, load
//   <output>/<runId>/questions.jsonl one record per trial x question (full evidence)
//   <output>/<runId>/summary.json    per-trial and aggregate metrics
//   <output>/<runId>/browser.log     page console
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { root, startServer } from "./server.mjs";
import { hostInfo, memorySnapshot, provenance, vendorPaths } from "./provenance.mjs";
import { loadSuite, DEFAULT_QUESTIONS } from "./suite.mjs";
import { aggregate } from "./summary.mjs";
import { RESULT_SCHEMA, RESULTS_DIR, groupByTrial } from "./runs.mjs";
import { modelSpecificRequest } from "../../src/generator.js";
import { ANALYSIS_VERSION } from "../../src/analysis.js";
import { PIPELINE_VERSIONS, MAX_DETERMINISTIC_PASSES } from "../../src/pipeline.js";

// Defaults reproduce the final experiment configuration (run 8).
export const DEFAULTS = {
  runs: 1,
  browser: "chrome",
  port: 8010,
  seed: 1,
  temperature: 0,
  repairTemperature: 0.7,
  topP: undefined,
  maxTokens: 200,
  repetitionPenalty: 1.0,
  repairAttempts: 2,
  // Run 10 condition: BeingDB diagnoses replies and applies proven repairs before any model repair.
  dbGuidedRepair: false,
  warmup: false,
  headless: false,
  cold: false,
  probe: false,
  allowSoftwareGpu: false,
  questionTimeout: 600,
  condition: "baseline",
  output: RESULTS_DIR,
  questions: DEFAULT_QUESTIONS,
  browserArgs: [],
};

// Settings that change what the model is asked or how it decodes.
const GENERATION_KEYS = ["seed", "temperature", "repairTemperature", "topP", "maxTokens", "repetitionPenalty", "repairAttempts", "questions", "ids"];
// Settings that change how replies are checked and repaired (not the prompt or decoding).
const PIPELINE_KEYS = ["dbGuidedRepair"];

const CHANNELS = { chrome: "chrome", "chrome-beta": "chrome-beta", "chrome-canary": "chrome-canary", edge: "msedge", "edge-beta": "msedge-beta", chromium: undefined };

// Keep inference at full speed even if the window is covered; expose gc() so the page can
// collect harness garbage between questions, outside the timed regions.
const BROWSER_ARGS = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--no-first-run", "--no-default-browser-check", "--window-size=1280,1000", "--js-flags=--expose-gc"];

export const DETERMINISM_NOTE =
  "First attempts decode greedily (temperature 0); repairs sample with a fixed seed that WebLLM resets per request, and WebLLM has no cross-request prefix cache, so replies do not depend on question order. " +
  "Replies are expected to repeat exactly on the same machine, browser, driver and model build, but WebGPU numerics may differ across GPUs, drivers and browsers, so bit-identical replies across machines are not guaranteed.";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

class BenchmarkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function ensureServer(port) {
  const local = readFileSync(path.join(root, "src", "benchmark.js"), "utf8");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/src/benchmark.js`);
    if (res.ok && (await res.text()) === local) return { reused: true, close: async () => {} };
    throw new BenchmarkError("setup_failed", `port ${port} is in use by another server (not this checkout); stop it or pass --port`);
  } catch (e) {
    if (e instanceof BenchmarkError) throw e;
  }
  const server = await startServer(port);
  return {
    reused: false,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function checkVendor() {
  const v = vendorPaths();
  for (const f of [path.join(v.wasmDir, "main.bc.wasm.js"), path.join(v.wasmDir, "rewind.browser.json"), path.join(v.webllmDir, "index.js")])
    if (!existsSync(f)) throw new BenchmarkError("setup_failed", `missing ${path.relative(root, f)}: run 'npm install' and 'npm run link' (needs a release build of ../beingdb-wasm)`);
}

async function modelRecord(modelId) {
  const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
  return prebuiltAppConfig.model_list.find((m) => m.model_id === modelId) ?? null;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new BenchmarkError("aborted", `${what} timed out after ${ms / 1000} s`)), ms))),
  ]);
}

// chrome://gpu: the browser's own view of GPU acceleration and the GPU/driver in use.
const CHROME_GPU_KEYS = ["GPU0", "GPU1", "GPU2", "GL_RENDERER", "GL_VENDOR", "Display type", "Machine model name", "Machine model version", "Skia Backend", "Optimus", "AMD switchable", "Chrome version", "Operating system", "ANGLE commit id"];

async function chromeGpu(context) {
  const page = await context.newPage();
  try {
    await page.goto("chrome://gpu");
    await page.waitForTimeout(1500);
    const raw = await page.evaluate(() => {
      const roots = [document];
      const rows = [];
      const items = [];
      while (roots.length) {
        const r = roots.pop();
        for (const el of r.querySelectorAll("*")) {
          if (el.shadowRoot) roots.push(el.shadowRoot);
          if (el.tagName === "TR" && el.children.length >= 2) rows.push([el.children[0].textContent.trim(), el.children[1].textContent.trim()]);
          if (el.tagName === "LI") items.push(el.textContent.trim());
        }
      }
      return { rows, items };
    });
    const info = {};
    for (const [k, v] of raw.rows) if (CHROME_GPU_KEYS.includes(k) && !(k in info)) info[k] = v;
    // Includes Playwright's own default flags; home directory redacted.
    const cmd = raw.rows.find(([k]) => k === "Command Line")?.[1];
    if (cmd) info["Command Line"] = cmd.replaceAll(os.homedir(), "~");
    const featureStatus = {};
    for (const li of raw.items) {
      const m = li.match(/^([^:]{2,40}):\s*(.+)$/);
      if (m && !(m[1] in featureStatus)) featureStatus[m[1]] = m[2];
    }
    return { featureStatus, info };
  } catch (e) {
    return { error: e.message.split("\n")[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

function headline(agg) {
  if (!agg) return null;
  const m = (k) => agg.counts[k]?.mean ?? null;
  const t = agg.timing;
  return {
    trials: agg.trials,
    supported: m("supported"),
    unsupported: m("unsupported"),
    meanCounts: Object.fromEntries(["firstValid", "finalValid", "firstCorrect", "finalCorrect", "unsupportedDetected", "fabricated", "overallCorrect", "runtimeFailures"].map((k) => [k, m(k)])),
    medianModelMsPerCall: t.model.msPerCall?.median ?? null,
    medianFirstAttemptModelMs: t.model.firstAttemptMs?.median ?? null,
    medianBeingdbMsPerQuery: t.beingdb.msPerQuery?.median ?? null,
    efficiency: Object.fromEntries(Object.entries(agg.perTrial[0]?.efficiency ?? {}).filter(([, v]) => typeof v === "number")),
    failureCategories: Object.fromEntries(Object.entries(agg.failureCategories).map(([k, v]) => [k, v.mean])),
  };
}

const fmt = (x, d = 0) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));

export function printSummary(agg, log = console.log) {
  const t0 = agg.perTrial[0];
  const c = (k) => (agg.trials === 1 ? `${t0.counts[k]}` : `${agg.counts[k].mean} (min ${agg.counts[k].min}, max ${agg.counts[k].max})`);
  const S = t0.counts.supported;
  const U = t0.counts.unsupported;
  log(`\nTrials: ${agg.trials}`);
  log(`Valid DSL, first attempt:      ${c("firstValid")}/${S}`);
  log(`Correct, first attempt:        ${c("firstCorrect")}/${S}`);
  log(`Valid DSL after repair:        ${c("finalValid")}/${S}`);
  log(`Correct after repair:          ${c("finalCorrect")}/${S}`);
  log(`Unsupported recognised:        ${c("unsupportedDetected")}/${U}  (fabricated queries: ${c("fabricated")})`);
  log(`Overall correct:               ${c("overallCorrect")}/${S + U}`);
  const tm = agg.timing;
  log(`Model ms per call (median):    ${fmt(tm.model.msPerCall?.median)}  first attempt ${fmt(tm.model.firstAttemptMs?.median)}, repair ${fmt(tm.model.repairAttemptMs?.median)}`);
  log(`BeingDB ms per query (median): ${fmt(tm.beingdb.msPerQuery?.median, 2)}  (max ${fmt(tm.beingdb.msPerQuery?.max, 2)})`);
  const e = t0.efficiency;
  if (e) {
    log(`Model calls:                   ${e.modelCalls} (${e.firstAttemptCalls} first attempts, ${e.modelRepairCalls} repairs); ${e.modelCallsPerQuestion} per question, ${e.modelCallsPerSupportedQuestion} per supported question`);
    log(`BeingDB calls:                 ${e.beingdbCalls} (${e.diagnoseCalls} diagnose, ${e.executeCalls} query/execute), ${fmt(e.beingdbMsTotal, 1)} ms in total`);
    log(`Proven (deterministic) repairs: ${e.deterministicRepairs} in ${e.questionsRepairedDeterministically} questions (${e.questionsRepairedDeterministicallyCorrect} then correct)`);
    log(`Solved with one model call:    ${e.correctWithOneModelCall}/${S + U}; questions needing a model repair: ${e.questionsWithModelRepair}`);
    log(`Correct answers per model call: ${fmt(e.correctPerModelCall, 3)}; end-to-end per question (median): ${fmt(e.medianTotalMs / 1000, 1)} s`);
  }
  log(`Failure categories: ${Object.entries(agg.failureCategories).map(([k, v]) => `${k} ${v.mean}`).join(", ") || "none"}`);
  if (agg.trials > 1) log(`Identical replies across trials: ${agg.determinism.identicalAcrossTrials}/${agg.determinism.questions}`);
}

export async function runBenchmark(options, { log = console.log, signal } = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  if (!o.model) throw new BenchmarkError("setup_failed", "--model <WebLLM model id> is required (list them with: npm run models)");
  if (!(o.browser in CHANNELS)) throw new BenchmarkError("setup_failed", `--browser must be one of ${Object.keys(CHANNELS).join(", ")}`);
  const record = await modelRecord(o.model);
  if (!record) throw new BenchmarkError("setup_failed", `${o.model} is not in the installed WebLLM prebuilt model list; see: npm run models`);
  checkVendor();

  let suite;
  try {
    suite = loadSuite(o.questions);
  } catch (e) {
    throw new BenchmarkError("setup_failed", e.message);
  }
  const ids = o.ids ? String(o.ids).split(",").map((s) => s.trim()) : null;
  const unknownIds = ids?.filter((id) => !suite.items.some((i) => i.id === id)) ?? [];
  if (unknownIds.length) throw new BenchmarkError("setup_failed", `unknown question id(s): ${unknownIds.join(", ")}`);
  const items = ids ? suite.items.filter((i) => ids.includes(i.id)) : suite.items;

  const host = hostInfo();
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = `${stamp}_${slug(o.machine || host.hardwareModel || os.hostname())}_${o.model}`;
  const dir = path.resolve(o.output, runId);
  mkdirSync(dir, { recursive: true });
  const questionsFile = path.join(dir, "questions.jsonl");
  writeFileSync(questionsFile, "");
  const browserLog = createWriteStream(path.join(dir, "browser.log"));

  const nonDefault = [...GENERATION_KEYS, ...PIPELINE_KEYS].filter((k) => o[k] !== DEFAULTS[k] && !(k === "questions" && path.resolve(o[k]) === DEFAULT_QUESTIONS));
  const warnings = [];
  const meta = {
    schema: RESULT_SCHEMA,
    runId,
    status: "starting",
    error: null,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    // Human-supplied labels, kept apart from anything observed automatically.
    labels: { machine: o.machine ?? null, modelLabel: o.modelLabel ?? null, condition: o.condition, notes: o.notes ?? null },
    suite: {
      id: suite.id,
      registered: suite.registered,
      file: suite.file,
      sha256: suite.sha256,
      itemsSha256: suite.itemsSha256,
      environmentFingerprint: suite.environmentFingerprint,
      partial: items.length !== suite.items.length,
      questionIds: items.map((i) => i.id),
    },
    model: { id: o.model, label: o.modelLabel ?? null, record, load: null, smoke: null, warmup: null },
    config: {
      runs: o.runs,
      repairAttempts: o.repairAttempts,
      questionTimeoutS: o.questionTimeout,
      warmup: o.warmup,
      coldCache: o.cold,
      generation: {
        firstAttemptTemperature: o.temperature,
        repairTemperature: o.repairTemperature,
        seed: o.seed,
        topP: o.topP ?? null,
        topPSource: o.topP === undefined ? "model default (mlc-chat-config; see model.load.chatConfig.top_p)" : "command line",
        maxTokens: o.maxTokens,
        repetitionPenalty: o.repetitionPenalty,
        modelSpecificRequest: null,
      },
      grammar: {
        constrained: true,
        mechanism: "WebLLM response_format {type: 'grammar'} (xgrammar EBNF generated from BeingDB.predicates())",
        firstAttempt: "query_or_unsupported",
        repairAfterValidationError: "query_only (when every predicate exists), else query_or_unsupported",
      },
      // The repair loop. db-guided-repair/1 adds BeingDB.diagnose before execution, applies
      // BeingDB-proven repairs without a model call, and adds BeingDB diagnostics to model repair
      // messages; the initial prompt (config.prompt) is unchanged.
      pipeline: {
        version: o.dbGuidedRepair ? PIPELINE_VERSIONS.dbGuided : PIPELINE_VERSIONS.modelRepair,
        dbGuidedRepair: !!o.dbGuidedRepair,
        maxModelRepairs: o.repairAttempts,
        maxDeterministicPasses: o.dbGuidedRepair ? MAX_DETERMINISTIC_PASSES : 0,
      },
      prompt: null,
      analysisVersion: ANALYSIS_VERSION,
      nonDefault,
      determinism: DETERMINISM_NOTE,
    },
    browser: null,
    environment: { observed: { host, memoryAtStart: memorySnapshot(), memoryAtEnd: null, browser: null, chromeGpu: null } },
    compatibility: null,
    provenance: provenance(),
    beingdb: null,
    warnings,
    summary: null,
    files: { questions: "questions.jsonl", summary: "summary.json", browserLog: "browser.log" },
  };
  const save = () => writeFileSync(path.join(dir, "run.json"), JSON.stringify(meta, null, 1));
  for (const [name, r] of Object.entries(meta.provenance.repositories))
    if (r.dirty) warnings.push(`${name} has uncommitted changes: results do not correspond exactly to commit ${r.commit?.slice(0, 10)}`);
  if (nonDefault.length) warnings.push(`non-default settings: ${nonDefault.join(", ")} (not the baseline configuration)`);
  if (host.power?.source === "Battery Power") warnings.push("running on battery power: performance may be reduced");
  if (host.power?.lowPowerMode) warnings.push("macOS Low Power Mode is on: performance will be reduced");
  const mem = meta.environment.observed.memoryAtStart;
  if (mem.swapUsedBytes > 2 ** 30) warnings.push(`${(mem.swapUsedBytes / 2 ** 30).toFixed(1)} GB of swap in use at start: close other applications for representative timings`);
  if (o.headless) warnings.push("headless browser: WebGPU may be unavailable or software-rendered; check environment.observed.browser.webgpu");
  if (record.vram_required_MB && record.vram_required_MB * 1e6 > 0.75 * host.totalMemoryBytes)
    warnings.push(`model needs ~${Math.round(record.vram_required_MB)} MB of GPU memory, more than 75% of this machine's ${Math.round(host.totalMemoryBytes / 1e9)} GB RAM`);
  save();
  log(`Run ${runId}\n  -> ${path.relative(process.cwd(), dir) || dir}`);
  for (const w of warnings) log(`  warning: ${w}`);

  let server;
  let context;
  const records = [];
  try {
    server = await ensureServer(o.port);
    const origin = `http://localhost:${o.port}`;
    const { chromium } = await import("playwright-core");
    const profileDir = o.profile ? path.resolve(o.profile) : path.join(os.homedir(), ".cache", "beingdb-webllm", "browser-profiles", o.browser);
    mkdirSync(profileDir, { recursive: true });
    const args = [...BROWSER_ARGS, ...o.browserArgs];
    log(`Launching ${o.browser}${o.headless ? " (headless)" : ""}; keep its window visible until the run finishes…`);
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: CHANNELS[o.browser],
        executablePath: o.executablePath,
        headless: o.headless,
        viewport: null,
        args,
      });
    } catch (e) {
      throw new BenchmarkError("setup_failed", `could not launch ${o.browser}: ${e.message.split("\n")[0]}`);
    }
    const page = context.pages()[0] ?? (await context.newPage());
    let crashed = false;
    page.on("console", (m) => browserLog.write(`[${m.type()}] ${m.text()}\n`));
    page.on("pageerror", (e) => browserLog.write(`[pageerror] ${e.message}\n`));
    page.on("crash", () => (crashed = true));
    await page.goto(`${origin}/benchmark.html`);
    await page.bringToFront();
    await page.waitForFunction(() => window.bench);
    await page.evaluate(() => window.bench.ready);

    const version = await page.evaluate(() => navigator.userAgentData?.getHighEntropyValues(["fullVersionList"]).then((v) => v.fullVersionList).catch(() => null));
    const brands = (version || []).filter((b) => !/Not.?A.?Brand/i.test(b.brand));
    const product = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
    meta.environment.observed.chromeGpu = await chromeGpu(context);
    meta.browser = {
      requested: o.browser,
      channel: CHANNELS[o.browser] ?? null,
      executable: o.executablePath ? path.basename(o.executablePath) : null,
      product: product ? `${product.brand}/${product.version}` : null,
      fullVersionList: version,
      headless: o.headless,
      args,
      profile: o.profile ? "custom" : "default",
      origin,
      server: server.reused ? "reused" : "started",
    };

    const env = await page.evaluate((id) => window.bench.environment(id), o.model);
    meta.environment.observed.browser = env.browser;
    meta.beingdb = env.beingdb;
    meta.config.prompt = env.prompt;
    meta.compatibility = env.compatibility;
    if (env.beingdb.environmentFingerprint !== suite.environmentFingerprint)
      throw new BenchmarkError("incompatible", `BeingDB data fingerprint ${env.beingdb.environmentFingerprint} differs from the question set's ${suite.environmentFingerprint}`);
    const failed = env.compatibility.checks.filter((c) => !c.ok && !(o.allowSoftwareGpu && c.id === "hardware_adapter"));
    if (failed.length) throw new BenchmarkError("incompatible", `compatibility check failed: ${failed.map((c) => `${c.id}${c.detail ? ` (${c.detail})` : c.required !== undefined ? ` (required ${c.required}, available ${c.available})` : ""}`).join("; ")}`);
    if (env.browser.webgpu.adapter?.softwareRenderer) warnings.push("WebGPU adapter is a software/fallback renderer: timings are not representative");
    const webgpuStatus = meta.environment.observed.chromeGpu?.featureStatus?.WebGPU;
    if (webgpuStatus && !/hardware accelerated/i.test(webgpuStatus)) warnings.push(`chrome://gpu reports WebGPU: ${webgpuStatus}`);
    await page.bringToFront();
    const gpuInfo = env.browser.webgpu.adapter?.info;
    log(`Browser ${meta.browser.product ?? env.browser.userAgent}; WebGPU ${gpuInfo?.vendor ?? "?"} / ${gpuInfo?.architecture ?? "?"}${gpuInfo?.description ? ` (${gpuInfo.description})` : ""}`);
    save();

    const generation = { seed: o.seed, maxTokens: o.maxTokens, repetitionPenalty: o.repetitionPenalty, topP: o.topP };
    if (o.cold) log("Cold-cache run: deleting this model from the browser cache first (it will be downloaded again).");
    const load = await page.evaluate(([id, opts]) => window.bench.loadModel(id, opts), [o.model, { generation, cold: o.cold }]);
    meta.model.load = load;
    if (!load.ok) throw new BenchmarkError("model_load_failed", `model failed to load: ${load.error}`);
    log(`Model loaded in ${fmt(load.loadMs / 1000, 1)} s (${load.cachedAtLoad ? "from browser cache" : "downloaded"})`);
    const cc = load.chatConfig || {};
    const specific = modelSpecificRequest(o.model);
    meta.config.generation.modelSpecificRequest = Object.keys(specific).length ? specific : null;
    if (meta.config.generation.modelSpecificRequest) warnings.push(`model-specific request fields applied: ${JSON.stringify(specific)}`);
    meta.config.generation.resolvedModelDefaults = {
      temperature: cc.temperature ?? null,
      top_p: cc.top_p ?? null,
      repetition_penalty: cc.repetition_penalty ?? null,
      presence_penalty: cc.presence_penalty ?? null,
      frequency_penalty: cc.frequency_penalty ?? null,
      context_window_size: cc.context_window_size ?? null,
    };
    save();

    const smoke = await page.evaluate((n) => window.bench.smoke({ maxRepairs: n }), o.repairAttempts);
    meta.model.smoke = smoke;
    if (!smoke.ok)
      throw new BenchmarkError(
        "incompatible",
        smoke.error ? `smoke generation failed: ${smoke.error}` : `context window ${smoke.contextWindow} is too small (~${smoke.estimatedTokensNeeded} tokens needed with ${o.repairAttempts} repairs)`,
      );
    log(`Smoke generation OK (${smoke.usage?.prompt_tokens} prompt tokens, context window ${smoke.contextWindow ?? "?"}, ${fmt(smoke.ms / 1000, 1)} s)`);
    if (o.probe) {
      meta.status = "probe_ok";
      return { dir, status: meta.status, meta };
    }
    if (o.warmup) {
      meta.model.warmup = await page.evaluate(() => window.bench.warmup());
      log(`Warm-up done (${meta.model.warmup.map((w) => `${fmt(w.ms / 1000, 1)} s`).join(", ")})`);
    }

    meta.status = "running";
    save();
    let consecutiveErrors = 0;
    for (let trial = 1; trial <= o.runs; trial++) {
      for (const [index, item] of items.entries()) {
        if (signal?.aborted) throw new BenchmarkError("interrupted", "interrupted by user");
        const label = `${trial}/${o.runs}`;
        await page.evaluate((s) => window.bench.status(s), `Trial ${label} · question ${index + 1}/${items.length} · ${item.id} (keep this window visible)`);
        let rec;
        try {
          rec = await withTimeout(
            page.evaluate(([it, opts]) => window.bench.runQuestion(it, opts), [
              item,
              { maxRepairs: o.repairAttempts, temperature: o.temperature, repairTemperature: o.repairTemperature, dbGuided: !!o.dbGuidedRepair, label },
            ]),
            o.questionTimeout * 1000,
            `question ${item.id}`,
          );
        } catch (e) {
          if (crashed) throw new BenchmarkError("aborted", `browser page crashed during ${item.id}`);
          throw e instanceof BenchmarkError ? e : new BenchmarkError("aborted", `harness error during ${item.id}: ${e.message.split("\n")[0]}`);
        }
        rec = { schema: `${RESULT_SCHEMA}#question`, runId, trial, index, ...rec };
        records.push(rec);
        appendFileSync(questionsFile, JSON.stringify(rec) + "\n");
        const verdict = rec.score.correct ? "correct" : `wrong  ${rec.failure?.category ?? ""}`;
        log(
          `[${label}] ${String(index + 1).padStart(2)}/${items.length} ${item.id}  ${verdict.padEnd(34)} ` +
            `repairs ${rec.repairs}  model ${fmt(rec.timing.llmMs / 1000, 1)} s  BeingDB ${fmt(rec.timing.dbMs, 1)} ms` +
            (rec.efficiency?.calls ? `  calls ${rec.efficiency.calls.model}/${rec.efficiency.calls.beingdb}` : "") +
            (rec.efficiency?.calls?.deterministicRepairs ? `  proven repairs ${rec.efficiency.calls.deterministicRepairs}` : "") +
            (rec.page?.hiddenMs > 0 ? `  (page hidden ${fmt(rec.page.hiddenMs / 1000, 1)} s)` : ""),
        );
        consecutiveErrors = rec.outcome === "error" ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= 3) throw new BenchmarkError("aborted", `3 consecutive model failures (last: ${rec.failure.evidence.message})`);
      }
    }
    meta.status = "complete";
    await page.evaluate(() => window.bench.unload()).catch(() => {});
  } catch (e) {
    meta.status = e instanceof BenchmarkError ? e.status : "aborted";
    meta.error = e.message;
    log(`\n${meta.status.toUpperCase()}: ${e.message}`);
  } finally {
    meta.finishedAt = new Date().toISOString();
    const mem0 = meta.environment.observed.memoryAtStart;
    const mem1 = (meta.environment.observed.memoryAtEnd = memorySnapshot());
    if (mem0.swapUsedBytes !== null && mem1.swapUsedBytes !== null && mem1.swapUsedBytes - mem0.swapUsedBytes > 256 * 2 ** 20)
      warnings.push(`swap use grew by ${Math.round((mem1.swapUsedBytes - mem0.swapUsedBytes) / 2 ** 20)} MB during the run: memory pressure may have inflated timings`);
    if (records.some((r) => r.page?.hiddenMs > 0)) warnings.push("the page was hidden during some questions: their timings may be throttled");
    if (records.length) {
      const agg = aggregate(groupByTrial(records));
      meta.summary = headline(agg);
      writeFileSync(
        path.join(dir, "summary.json"),
        JSON.stringify({ schema: `${RESULT_SCHEMA}#summary`, runId, status: meta.status, model: o.model, labels: meta.labels, suite: meta.suite.id, ...agg }, null, 1),
      );
      printSummary(agg, log);
    }
    save();
    await context?.close().catch(() => {});
    await server?.close();
    browserLog.end();
    log(`\n${meta.status}: ${path.join(dir, "run.json")}`);
  }
  return { dir, status: meta.status, meta };
}
