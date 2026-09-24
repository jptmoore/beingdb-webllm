// Print the model context built from the live BeingDB schema: node eval/show-prompt.mjs [--grammar]
import { loadBeingDB } from "./node-beingdb.mjs";
import { buildSchema } from "../src/schema.js";
import { buildPrompt } from "../src/prompt.js";

const { db } = await loadBeingDB();
const t = performance.now();
const schema = buildSchema(db);
const prompt = buildPrompt(schema);
for (const m of prompt.messages("<question>")) console.log(`[${m.role}]\n${m.content}\n`);
if (process.argv.includes("--grammar")) console.log(`[grammar]\n${prompt.format.grammar}`);
console.error(
  `\n[schema built in ${(performance.now() - t).toFixed(0)} ms; ${JSON.stringify(schema.stats)}; ` +
    `${prompt.chars} chars, ~${Math.round(prompt.chars / 3.5)} tokens]`,
);
