// Link the sibling beingdb-wasm browser build into vendor/ (no copying).
// Build it first with: (cd ../beingdb-wasm && dune build --profile release)
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.resolve(root, "../beingdb-wasm/_build/default/web");
const vendor = path.join(root, "vendor");

for (const f of ["main.bc.wasm.js", "main.bc.wasm.assets", "rewind.browser.json"]) {
  if (!existsSync(path.join(web, f))) {
    console.error(`missing ${path.join(web, f)}; run 'dune build --profile release' in ../beingdb-wasm`);
    process.exit(1);
  }
}
const wasm = readdirSync(path.join(web, "main.bc.wasm.assets")).filter((f) => f.endsWith(".wasm"));
if (wasm.length !== 1) {
  console.error(`expected one .wasm module (release build), found ${wasm.length}; Safari needs --profile release`);
  process.exit(1);
}

mkdirSync(vendor, { recursive: true });
const links = {
  "beingdb-wasm": "../../beingdb-wasm/_build/default/web",
  "web-llm": "../node_modules/@mlc-ai/web-llm/lib",
};
for (const [name, target] of Object.entries(links)) {
  // unlink, not rmSync: Node 23's rmSync refuses a symlink to a directory (EISDIR).
  if (lstatSync(path.join(vendor, name), { throwIfNoEntry: false })) unlinkSync(path.join(vendor, name));
  symlinkSync(target, path.join(vendor, name));
  console.log(`vendor/${name} -> ${target}`);
}
