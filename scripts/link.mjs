// Link the sibling beingdb-wasm runtime and REWIND dataset into vendor/ (no copying).
//
//   npm run link              the committed prebuilt runtime and bundled dataset (default;
//                             no OCaml toolchain): vendor/beingdb-wasm/* -> ../beingdb-wasm/{prebuilt,data}/
//   npm run link -- --build   a local release build instead, for BeingDB runtime development:
//                             vendor/beingdb-wasm -> ../beingdb-wasm/_build/default/web
//                             (first: cd ../beingdb-wasm && dune build --profile release)
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmRepo = path.resolve(root, "../beingdb-wasm");
const vendor = path.join(root, "vendor");
const build = process.argv.includes("--build");

const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const singleWasm = (assets) => {
  const wasm = readdirSync(assets).filter((f) => f.endsWith(".wasm"));
  if (wasm.length !== 1) fail(`expected one .wasm module (release build) in ${path.relative(root, assets)}, found ${wasm.length}; Safari needs --profile release`);
};
// unlink, not rmSync, for a symlink: Node 23's rmSync refuses a symlink to a directory (EISDIR).
const remove = (p) => {
  const stat = lstatSync(p, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) unlinkSync(p);
  else rmSync(p, { recursive: true });
};
const link = (name, target) => {
  remove(path.join(vendor, name));
  symlinkSync(target, path.join(vendor, name));
  console.log(`vendor/${name} -> ${target}`);
};

if (!existsSync(wasmRepo)) fail("../beingdb-wasm not found: git clone https://github.com/jptmoore/beingdb-wasm.git ../beingdb-wasm");
mkdirSync(vendor, { recursive: true });

if (build) {
  const web = path.join(wasmRepo, "_build/default/web");
  for (const f of ["main.bc.wasm.js", "main.bc.wasm.assets", "rewind.browser.json"])
    if (!existsSync(path.join(web, f))) fail(`missing ${path.join(web, f)}; run 'dune build --profile release' in ../beingdb-wasm`);
  singleWasm(path.join(web, "main.bc.wasm.assets"));
  link("beingdb-wasm", "../../beingdb-wasm/_build/default/web");
} else {
  const prebuilt = path.join(wasmRepo, "prebuilt");
  const data = path.join(wasmRepo, "data");
  const runtimeManifest = path.join(prebuilt, "runtime.json");
  const dataMeta = path.join(data, "rewind.browser.meta.json");
  if (!existsSync(runtimeManifest) || !existsSync(dataMeta))
    fail("../beingdb-wasm has no prebuilt runtime (prebuilt/runtime.json) or dataset metadata (data/rewind.browser.meta.json); update it (git pull), or link a local build with: npm run link -- --build");
  // Refuse a modified bundle: the files must be the ones beingdb-wasm's metadata describes and tests.
  const manifest = JSON.parse(readFileSync(runtimeManifest, "utf8"));
  for (const [f, hash] of Object.entries(manifest.files))
    if (!existsSync(path.join(prebuilt, f)) || `sha256:${sha256(path.join(prebuilt, f))}` !== hash)
      fail(`../beingdb-wasm/prebuilt/${f} does not match prebuilt/runtime.json; run 'npm test' in ../beingdb-wasm`);
  singleWasm(path.join(prebuilt, "main.bc.wasm.assets"));
  const meta = JSON.parse(readFileSync(dataMeta, "utf8"));
  if (sha256(path.join(data, meta.file)) !== meta.sha256)
    fail(`../beingdb-wasm/data/${meta.file} does not match data/rewind.browser.meta.json; run 'npm test' in ../beingdb-wasm`);

  // A real directory of links, so loader, .wasm and data sit side by side as the pages expect.
  remove(path.join(vendor, "beingdb-wasm"));
  mkdirSync(path.join(vendor, "beingdb-wasm"));
  const up = "../../../beingdb-wasm";
  link("beingdb-wasm/main.bc.wasm.js", `${up}/prebuilt/main.bc.wasm.js`);
  link("beingdb-wasm/main.bc.wasm.assets", `${up}/prebuilt/main.bc.wasm.assets`);
  link("beingdb-wasm/runtime.json", `${up}/prebuilt/runtime.json`);
  link("beingdb-wasm/rewind.browser.json", `${up}/data/rewind.browser.json`);
  link("beingdb-wasm/rewind.browser.meta.json", `${up}/data/rewind.browser.meta.json`);
  console.log(`prebuilt runtime: BeingDB ${manifest.beingdb.commit.slice(0, 12)}; REWIND dataset fingerprint: ${meta.environmentFingerprint}`);
}
link("web-llm", "../node_modules/@mlc-ai/web-llm/lib");
