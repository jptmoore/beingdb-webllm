// Benchmark suite identity: the question file, its hash and the suite id in eval/suite.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { root } from "./server.mjs";
import { sha256Text } from "./provenance.mjs";

export const DEFAULT_QUESTIONS = path.join(root, "eval", "questions.json");

export function loadSuite(questionsPath = DEFAULT_QUESTIONS) {
  const suite = JSON.parse(readFileSync(path.join(root, "eval", "suite.json"), "utf8"));
  const file = path.resolve(questionsPath);
  const text = readFileSync(file, "utf8");
  const sha = sha256Text(text);
  const data = JSON.parse(text);
  let id;
  if (sha === suite.questionsSha256) id = suite.id;
  else if (file === DEFAULT_QUESTIONS)
    throw new Error(
      `eval/questions.json (sha256 ${sha}) no longer matches ${suite.id} (sha256 ${suite.questionsSha256}). ` +
        `Benchmark questions are versioned: record the change as a new suite id and hash in eval/suite.json.`,
    );
  else id = data.suite || `custom:${path.basename(file)}`;
  return {
    id,
    registered: id === suite.id,
    file: path.relative(root, file),
    sha256: sha,
    itemsSha256: sha256Text(JSON.stringify(data.items)),
    environmentFingerprint: data.environmentFingerprint,
    items: data.items,
  };
}
