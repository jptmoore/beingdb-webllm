// Shared page bootstrap: BeingDB + live schema + prompt, then the model.
import { loadBeingDB } from "./beingdb.js";
import { buildSchema } from "./schema.js";
import { buildPrompt } from "./prompt.js";
import { WebLLMGenerator, DEFAULT_MODEL, webgpuInfo } from "./generator.js";

export async function setupDatabase(log) {
  log("Loading BeingDB WASM and REWIND data…");
  const { db, summary, timings } = await loadBeingDB();
  const t = performance.now();
  const schema = buildSchema(db);
  const prompt = buildPrompt(schema);
  timings.schemaMs = performance.now() - t;
  log(
    `BeingDB ready: ${summary.predicates} predicates / ${summary.facts} facts ` +
      `(wasm ${timings.wasmMs.toFixed(0)} ms, fetch ${timings.fetchMs.toFixed(0)} ms, load ${timings.loadMs.toFixed(0)} ms, ` +
      `schema ${timings.schemaMs.toFixed(0)} ms; prompt ${prompt.chars} chars)`,
  );
  return { db, summary, timings, schema, prompt };
}

// Models offered in the chatbot's model picker (all in WebLLM 0.2.85's prebuilt list).
// downloadGB: weight files on Hugging Face (records in ndarray-cache.json).
export const CHAT_MODELS = [
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Meta Llama 3.2 3B Instruct", downloadGB: 1.8, note: "recommended" },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", label: "Meta Llama 3.1 8B Instruct", downloadGB: 4.5 },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Google Gemma 2 2B IT", downloadGB: 1.5 },
  { id: "Phi-4-mini-instruct-q4f16_1-MLC", label: "Microsoft Phi-4 Mini Instruct", downloadGB: 2.2 },
];

export const modelIdFromURL = () => new URLSearchParams(location.search).get("model") || DEFAULT_MODEL;
export const modelIsCached = (modelId = modelIdFromURL()) => new WebLLMGenerator(modelId).isCached();

export async function setupModel(log, progress, generatorOptions = {}, modelId = modelIdFromURL()) {
  const gpu = await webgpuInfo();
  if (!gpu.ok) throw new Error("WebGPU is not available in this browser, so the local model cannot run.");
  if (!gpu.f16 && modelId.includes("q4f16")) log("Warning: this GPU lacks shader-f16; a q4f32 model may be required.");
  const generator = new WebLLMGenerator(modelId, generatorOptions);
  const cached = await generator.isCached();
  log(`Loading ${modelId} (${cached ? "from browser cache" : "first download"}, ~${Math.round(generator.record.vram_required_MB)} MB VRAM)…`);
  await generator.load((p) => progress(p));
  const storage = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const info = {
    modelId,
    cached,
    f16: gpu.f16,
    loadMs: generator.loadMs,
    vramMB: generator.record.vram_required_MB,
    storageMB: storage.usage ? storage.usage / 1e6 : undefined,
    jsHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : undefined,
    userAgent: navigator.userAgent,
  };
  log(`Model ready in ${(info.loadMs / 1000).toFixed(1)} s${info.storageMB ? `; origin storage ${info.storageMB.toFixed(0)} MB` : ""}`);
  return { generator, info };
}
