// Ad-hoc exploration: node eval/explore.mjs 'find ...' (DSL on argv or stdin).
import { readFileSync } from "node:fs";
import { loadBeingDB } from "./node-beingdb.mjs";

const { BeingDB } = await loadBeingDB();
const queries = process.argv.slice(2).length ? process.argv.slice(2) : readFileSync(0, "utf8").split("\n---\n");
for (const q of queries) {
  const r = JSON.parse(BeingDB.query(q));
  const rows = (r.results || []).map((row) => Object.values(row).map((v) => (v ? v.value : "null")).join(" | "));
  console.log(`# ${q.replace(/\n/g, " / ")}\n${r.results ? `count=${r.count}\n${rows.join("\n")}` : JSON.stringify(r)}\n`);
}
