// The only model-specific module: a WebLLM chat model that turns the prompt
// messages into a grammar-constrained reply. Weights are fetched once (Hugging
// Face, via WebLLM's prebuilt config), cached by the browser and run locally on WebGPU.
import * as webllm from "../vendor/web-llm/index.js";

export const DEFAULT_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

export class WebLLMGenerator {
  constructor(modelId = DEFAULT_MODEL) {
    this.modelId = modelId;
    this.record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    if (!this.record) throw new Error(`${modelId} is not in WebLLM's prebuilt model list`);
  }

  isCached() {
    return webllm.hasModelInCache(this.modelId);
  }

  async load(onProgress) {
    const t = performance.now();
    this.engine = await webllm.CreateMLCEngine(this.modelId, { initProgressCallback: onProgress });
    this.loadMs = performance.now() - t;
    return this.loadMs;
  }

  // format: a WebLLM response_format (here an xgrammar EBNF grammar).
  async complete(messages, format, { temperature = 0 } = {}) {
    const t = performance.now();
    const r = await this.engine.chat.completions.create({
      messages,
      temperature,
      seed: 1,
      // Queries must repeat variable names; the model default (1.05-1.1) penalises that.
      repetition_penalty: 1.0,
      max_tokens: 200,
      response_format: format,
      // Qwen3-family models think by default; the task wants the query only.
      ...(this.modelId.startsWith("Qwen3") ? { extra_body: { enable_thinking: false } } : {}),
    });
    return { text: r.choices[0].message.content, finish: r.choices[0].finish_reason, ms: performance.now() - t, usage: r.usage };
  }
}

export function webgpuInfo() {
  return navigator.gpu
    ? navigator.gpu.requestAdapter().then((a) => (a ? { ok: true, f16: a.features.has("shader-f16") } : { ok: false }))
    : Promise.resolve({ ok: false });
}
