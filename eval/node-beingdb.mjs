// Load the linked beingdb-wasm runtime (prebuilt by default) and the Rewind export in Node (no model).
// Used by the reference checker/scorer; the browser app loads the same artefacts.
// dataFile loads another export instead (.json or .json.gz), e.g. a pinned
// older revision for tests that replay recorded runs.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { wrapBeingDB } from "../src/beingdb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const wasmDir = path.resolve(here, "../vendor/beingdb-wasm");

function readExport(file) {
  const bytes = readFileSync(file);
  return (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
}

export function loadBeingDB({ dataFile = path.join(wasmDir, "rewind.browser.json") } = {}) {
  return new Promise((resolve, reject) => {
    globalThis.onBeingDBReady = (BeingDB) => {
      const summary = JSON.parse(BeingDB.load(readExport(dataFile)));
      if (summary.error) reject(new Error(summary.error.message));
      else resolve({ BeingDB, db: wrapBeingDB(BeingDB), summary });
    };
    // In Node the wasm_of_ocaml loader resolves its assets next to require.main.
    process.mainModule = { filename: path.join(wasmDir, "main.bc.wasm.js") };
    createRequire(import.meta.url)(path.join(wasmDir, "main.bc.wasm.js"));
  });
}
