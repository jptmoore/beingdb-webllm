// Shared page bootstrap: BeingDB + live schema + prompt, then the model.
import { loadBeingDB } from "./beingdb.js";
import { buildSchema } from "./schema.js";
import { buildPrompt } from "./prompt.js";
import { WebLLMGenerator, DEFAULT_MODEL, webgpuInfo } from "./generator.js";

export async function setupDatabase(log) {
  log("Loading BeingDB WASM and Rewind data…");
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

export const modelIdFromURL = () => new URLSearchParams(location.search).get("model") || DEFAULT_MODEL;
export const modelIsCached = () => new WebLLMGenerator(modelIdFromURL()).isCached();

export async function setupModel(log, progress) {
  const modelId = modelIdFromURL();
  const gpu = await webgpuInfo();
  if (!gpu.ok) throw new Error("WebGPU is not available in this browser, so the local model cannot run.");
  if (!gpu.f16 && modelId.includes("q4f16")) log("Warning: this GPU lacks shader-f16; a q4f32 model may be required.");
  const generator = new WebLLMGenerator(modelId);
  const cached = await generator.isCached();
  log(`Loading ${modelId} (${cached ? "from browser cache" : "first download"}, ~${Math.round(generator.record.vram_required_MB)} MB VRAM)…`);
  await generator.load((p) => progress(p));
  const storage = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const info = {
    modelId,
    cached,
    loadMs: generator.loadMs,
    vramMB: generator.record.vram_required_MB,
    storageMB: storage.usage ? storage.usage / 1e6 : undefined,
    jsHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : undefined,
    userAgent: navigator.userAgent,
  };
  log(`Model ready in ${(info.loadMs / 1000).toFixed(1)} s${info.storageMB ? `; origin storage ${info.storageMB.toFixed(0)} MB` : ""}`);
  return { generator, info };
}
