// List or validate WebLLM model ids from the installed @mlc-ai/web-llm package.
//   npm run models                         all prebuilt chat models
//   npm run models -- --filter qwen        substring filter
//   npm run models -- --check <id> ...     exit 1 if any id is unknown
//   npm run models -- --validate models/benchmark-models.json
//   npm run models -- --json
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

const { values, positionals } = parseArgs({
  options: { filter: { type: "string" }, check: { type: "boolean" }, validate: { type: "string" }, json: { type: "boolean" }, all: { type: "boolean" } },
  allowPositionals: true,
});
const version = JSON.parse(readFileSync(new URL("../node_modules/@mlc-ai/web-llm/package.json", import.meta.url), "utf8")).version;
// The benchmark prompt is ~2,000 tokens and repairs add up to ~900 more.
const MIN_CONTEXT = 3000;

const list = prebuiltAppConfig.model_list.filter((m) => values.all || !m.model_type || m.model_type === 0);
const describe = (m) => {
  const ctx = m.overrides?.context_window_size ?? null;
  return {
    id: m.model_id,
    vramMB: m.vram_required_MB ? Math.round(m.vram_required_MB) : null,
    lowResource: !!m.low_resource_required,
    shaderF16: m.required_features?.includes("shader-f16") || /q\df16/.test(m.model_id),
    contextWindow: ctx,
    // -1k builds cannot hold the benchmark prompt.
    fitsPrompt: ctx === null || ctx < 0 || ctx >= MIN_CONTEXT,
  };
};

const known = new Map(list.map((m) => [m.model_id, m]));
const ids = values.validate ? JSON.parse(readFileSync(values.validate, "utf8")).map((m) => m.id) : values.check ? positionals : null;
if (ids) {
  let ok = true;
  for (const id of ids) {
    const m = known.get(id);
    if (!m) {
      ok = false;
      console.log(`UNKNOWN  ${id}`);
    } else {
      const d = describe(m);
      if (!d.fitsPrompt) ok = false;
      console.log(`${d.fitsPrompt ? "ok      " : "TOO-SMALL"} ${id}  (~${d.vramMB} MB VRAM${d.contextWindow ? `, context ${d.contextWindow}` : ""})`);
    }
  }
  console.log(`\nWebLLM ${version}: ${ok ? "all models available" : "some models are unknown or cannot hold the benchmark prompt"}`);
  process.exit(ok ? 0 : 1);
}

const rows = list.map(describe).filter((d) => !values.filter || d.id.toLowerCase().includes(values.filter.toLowerCase()));
if (values.json) console.log(JSON.stringify({ webllm: version, models: rows }, null, 1));
else {
  console.log(`WebLLM ${version} prebuilt models (${rows.length}); VRAM is WebLLM's estimate:\n`);
  for (const d of rows.sort((a, b) => (a.vramMB ?? 0) - (b.vramMB ?? 0)))
    console.log(
      `${d.id.padEnd(52)} ${String(d.vramMB ?? "?").padStart(6)} MB` +
        `${d.lowResource ? "  low-resource" : ""}${d.shaderF16 ? "  f16" : ""}${d.contextWindow ? `  ctx ${d.contextWindow}` : ""}${d.fitsPrompt ? "" : "  (too small for the benchmark prompt)"}`,
    );
}
