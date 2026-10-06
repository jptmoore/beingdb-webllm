// Diagnostic (read-only, does not affect benchmarks): do the pack's predicate
// declarations reach the model? Checks each stage and exits 1 if one fails.
//   node eval/diagnose-annotations.mjs [--id m02] [--questions eval/questions-annotated.json]
//                                      [--run <benchmark run dir>] [--full]
// The prompt is built with the same buildSchema/buildPrompt as benchmark.html; --run
// checks a benchmark run recorded this exact prompt.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBeingDB, wasmDir } from "./node-beingdb.mjs";
import { buildSchema } from "../src/schema.js";
import { buildPrompt, PROMPT_VERSION } from "../src/prompt.js";

// systemPrompt sha256 of nl2dsl-prompt/run8 (no annotations), as recorded by both
// 20261005T160921Z (baseline) and 20261006T131109Z Llama benchmark runs.
const RUN8_SYSTEM_SHA256 = "56a339e82ae38fa27677e822d4e841d818183eeda4d0e337f26fcfc2da17ab4e";

const { values: o } = parseArgs({
  options: {
    id: { type: "string", default: "m02" },
    questions: { type: "string", default: "eval/questions-annotated.json" },
    run: { type: "string" },
    full: { type: "boolean" },
  },
});
const sha = (s) => createHash("sha256").update(s).digest("hex");
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};

// 1. Export: declarations stored in each predicate's pack meta.
const meta = JSON.parse(readFileSync(path.join(wasmDir, "rewind.browser.json"), "utf8")).tree.meta;
const declared = Object.fromEntries(Object.entries(meta).map(([n, m]) => [n, JSON.parse(m).declaration]).filter(([, d]) => d));
const declaredDescs = Object.values(declared).filter((d) => d.description).length;
const declaredRoles = Object.values(declared).filter((d) => d.arguments).length;
console.log(`export:  ${declaredDescs}/${Object.keys(meta).length} descriptions, ${declaredRoles} role sets  (${path.join(wasmDir, "rewind.browser.json")})`);

// 2. Runtime: BeingDB.predicates().
const { db, summary } = await loadBeingDB();
const preds = db.predicates().predicates;
const rtDescs = preds.filter((p) => p.description).length;
const rtRoles = preds.filter((p) => p.arguments.some((a) => a.role)).length;
console.log(`runtime: ${rtDescs}/${preds.length} descriptions, ${rtRoles} role sets  (fingerprint ${summary.environmentFingerprint})`);
check(rtDescs === declaredDescs && rtRoles === declaredRoles, "WASM runtime exposes every declared description and role set");

// 3. Schema and prompt: the same construction as the benchmark page.
const schema = buildSchema(db);
const prompt = buildPrompt(schema);
const detailed = preds.filter((p) => schema.text.split("\n").some((l) => l.startsWith(`${p.name}(`)));
const inText = detailed.filter((p) => p.description && schema.text.includes(p.description)).length;
const rolesInText = detailed.filter((p) => schema.text.includes(`${p.name}(${p.arguments.map((a) => a.role).join(", ")})`)).length;
const sigDescs = preds.filter((p) => p.description && schema.signatures.get(p.name)?.includes(p.description)).length;
console.log(`schema:  ${detailed.length} main predicates: ${inText} described, ${rolesInText} with declared roles; ${sigDescs} repair signatures described`);
check(inText === detailed.filter((p) => p.description).length, "schema text describes every main predicate that has a description");
check(rolesInText === detailed.length, "schema text uses declared roles for every main predicate");
check(sigDescs === rtDescs, "repair signatures carry every description");
check(prompt.system.endsWith(schema.text) && prompt.messages("q")[0].content === prompt.system, "system prompt (UI, eval page, benchmark) contains the schema");
const systemSha = sha(prompt.system);
console.log(`prompt:  ${PROMPT_VERSION}, system ${prompt.system.length} chars, total ${prompt.chars} chars (~${Math.round(prompt.chars / 3.5)} tokens), systemPrompt sha256 ${systemSha}`);
check(systemSha !== RUN8_SYSTEM_SHA256, `system prompt differs from the run-8 baseline (${RUN8_SYSTEM_SHA256.slice(0, 12)})`);

if (o.run) {
  const recorded = JSON.parse(readFileSync(path.join(o.run, "run.json"), "utf8")).config.prompt;
  const local = { schemaText: sha(schema.text), systemPrompt: systemSha, messages: sha(JSON.stringify(prompt.messages("<question>"))) };
  for (const [k, v] of Object.entries(local)) check(v === recorded.sha256[k], `${k} matches ${path.basename(o.run)}`);
  check(recorded.version === PROMPT_VERSION, `run prompt version ${recorded.version}`);
  check(Object.values(declared).some((d) => d.description && recorded.text.system.includes(d.description)), "run's recorded system prompt contains descriptions");
}

// 4. One question: the predicate/schema context the model gets, vs. what BeingDB declares.
const item = JSON.parse(readFileSync(o.questions, "utf8")).items.find((i) => i.id === o.id);
if (!item) throw new Error(`no question ${o.id} in ${o.questions}`);
console.log(`\n${item.id}: ${item.question}\nreference:\n${item.reference}\n`);
for (const name of item.predicates || []) {
  const line = schema.text.split("\n").find((l) => l.startsWith(`${name}(`) || l.includes(` ${name},`) || l.endsWith(` ${name}`));
  const d = declared[name];
  console.log(`${name}`);
  console.log(`  in prompt : ${line ?? "(not listed)"}`);
  console.log(`  repair sig: ${schema.signatures.get(name)}`);
  console.log(`  declared  : ${name}(${(d?.arguments || []).map((a) => a.role).join(", ")}) -- ${d?.description ?? "(none)"}`);
}
if (o.full) for (const m of prompt.messages(item.question)) console.log(`\n[${m.role}]\n${m.content}`);
process.exit(failed ? 1 : 0);
