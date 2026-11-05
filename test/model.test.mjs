// The chatbot's default model must still exist in the installed WebLLM release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

test("the default model is in WebLLM's prebuilt model list", () => {
  const source = readFileSync(new URL("../src/generator.js", import.meta.url), "utf8");
  const id = source.match(/DEFAULT_MODEL = "([^"]+)"/)?.[1];
  assert.ok(id, "DEFAULT_MODEL not found in src/generator.js");
  assert.ok(
    prebuiltAppConfig.model_list.some((m) => m.model_id === id),
    `${id} is not in WebLLM's prebuilt models; pick another with npm run models`,
  );
});

test("every model in the picker is in WebLLM's prebuilt model list", () => {
  const source = readFileSync(new URL("../src/setup.js", import.meta.url), "utf8");
  const block = source.match(/CHAT_MODELS = \[([\s\S]*?)\];/)?.[1] ?? "";
  const ids = [...block.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length, "CHAT_MODELS not found in src/setup.js");
  const known = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
  assert.deepEqual(ids.filter((id) => !known.has(id)), [], "picker models missing from WebLLM; update CHAT_MODELS");
});
