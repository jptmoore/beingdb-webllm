// The only model-specific module: a WebLLM chat model that turns the prompt
// messages into a grammar-constrained reply. Weights are fetched once (Hugging
// Face, via WebLLM's prebuilt config), cached by the browser and run locally on WebGPU.
import * as webllm from "../vendor/web-llm/index.js";

export const DEFAULT_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

// topP undefined = the model's own mlc-chat-config default (irrelevant at temperature 0).
export const DEFAULT_GENERATION = { seed: 1, maxTokens: 200, repetitionPenalty: 1.0, topP: undefined };

export const prebuiltModels = () => webllm.prebuiltAppConfig.model_list;

// Request fields added for particular model families; reported in benchmark configs.
export function modelSpecificRequest(modelId) {
  // Qwen3-family models think by default; the task wants the query only.
  return modelId.startsWith("Qwen3") ? { extra_body: { enable_thinking: false } } : {};
}

export class WebLLMGenerator {
  constructor(modelId = DEFAULT_MODEL, options = {}) {
    this.modelId = modelId;
    this.options = { ...DEFAULT_GENERATION, ...options };
    this.record = prebuiltModels().find((m) => m.model_id === modelId);
    if (!this.record) throw new Error(`${modelId} is not in WebLLM's prebuilt model list`);
  }

  isCached() {
    return webllm.hasModelInCache(this.modelId);
  }

  deleteFromCache() {
    return webllm.deleteModelAllInfoInCache(this.modelId);
  }

  // The resolved mlc-chat-config (model defaults + WebLLM overrides) once loaded.
  chatConfig() {
    return this.engine?.loadedModelIdToChatConfig?.get(this.modelId);
  }

  async load(onProgress) {
    const t = performance.now();
    this.engine = await webllm.CreateMLCEngine(this.modelId, { initProgressCallback: onProgress });
    this.loadMs = performance.now() - t;
    return this.loadMs;
  }

  // format: a WebLLM response_format (here an xgrammar EBNF grammar).
  async complete(messages, format, { temperature = 0 } = {}) {
    const { seed, maxTokens, repetitionPenalty, topP } = this.options;
    const request = {
      temperature,
      seed,
      // Queries must repeat variable names; the model default (1.05-1.1) penalises that.
      repetition_penalty: repetitionPenalty,
      max_tokens: maxTokens,
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...modelSpecificRequest(this.modelId),
    };
    const t = performance.now();
    const r = await this.engine.chat.completions.create({ messages, response_format: format, ...request });
    return { text: r.choices[0].message.content, finish: r.choices[0].finish_reason, ms: performance.now() - t, usage: r.usage, request };
  }
}

export function webgpuInfo() {
  return navigator.gpu
    ? navigator.gpu.requestAdapter().then((a) => (a ? { ok: true, f16: a.features.has("shader-f16") } : { ok: false }))
    : Promise.resolve({ ok: false });
}
