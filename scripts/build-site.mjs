#!/usr/bin/env node
// Build the chatbot as a static site in dist/site/ (GitHub Pages), with real
// copies of the linked BeingDB WASM runtime, REWIND data and WebLLM bundle.
//   npm run link && npm run build:site
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "site");

const files = [
  "index.html",
  ...readdirSync(path.join(root, "src")).map((f) => `src/${f}`),
  "vendor/beingdb-wasm/main.bc.wasm.js",
  "vendor/beingdb-wasm/rewind.browser.json",
  ...(existsSync(path.join(root, "vendor/beingdb-wasm/main.bc.wasm.assets"))
    ? readdirSync(path.join(root, "vendor/beingdb-wasm/main.bc.wasm.assets"))
        .filter((f) => f.endsWith(".wasm"))
        .map((f) => `vendor/beingdb-wasm/main.bc.wasm.assets/${f}`)
    : []),
  "vendor/web-llm/index.js",
  "eval/questions.json",
];

for (const f of files)
  if (!existsSync(path.join(root, f))) {
    console.error(`error: ${f} is missing; run 'npm install' and 'npm run link' first`);
    process.exit(1);
  }
if (!files.some((f) => f.endsWith(".wasm"))) {
  console.error("error: no BeingDB .wasm module in vendor/beingdb-wasm; run 'npm run link' first");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
let total = 0;
for (const f of files) {
  const to = path.join(out, f);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(root, f), to);
  chmodSync(to, 0o644);
  total += statSync(to).size;
  console.log(`  ${f.padEnd(64)} ${(statSync(to).size / 1024).toFixed(0).padStart(6)} KB`);
}
// GitHub Pages: serve the files as they are, without Jekyll.
writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`dist/site: ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
