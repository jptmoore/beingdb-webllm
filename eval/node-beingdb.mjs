// Load the beingdb-wasm release build and the Rewind export in Node (no model).
// Used by the reference checker/scorer; the browser app loads the same artefacts.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { wrapBeingDB } from "../src/beingdb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const wasmDir = path.resolve(here, "../vendor/beingdb-wasm");

export function loadBeingDB() {
  return new Promise((resolve, reject) => {
    globalThis.onBeingDBReady = (BeingDB) => {
      const summary = JSON.parse(BeingDB.load(readFileSync(path.join(wasmDir, "rewind.browser.json"), "utf8")));
      if (summary.error) reject(new Error(summary.error.message));
      else resolve({ BeingDB, db: wrapBeingDB(BeingDB), summary });
    };
    // In Node the wasm_of_ocaml loader resolves its assets next to require.main.
    process.mainModule = { filename: path.join(wasmDir, "main.bc.wasm.js") };
    createRequire(import.meta.url)(path.join(wasmDir, "main.bc.wasm.js"));
  });
}
