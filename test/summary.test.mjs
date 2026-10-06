// node --test: benchmark efficiency instrumentation (scripts/lib/summary.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { efficiencySummary, callsOf } from "../scripts/lib/summary.mjs";

const rec = (id, supported, correct, calls, totalMs, extra = {}) => ({
  question: { id, supported },
  score: { correct },
  attempts: Array.from({ length: calls.model }, () => ({ beingdb: {} })),
  timing: { totalMs, dbMs: calls.beingdb * 2 },
  efficiency: { calls, beingdbMs: { diagnose: calls.diagnose * 2, execute: calls.execute * 2 }, diagnosticCodes: extra.codes || [], deterministicRepairs: extra.det || [] },
});
const c = (model, diagnose, execute, det) => ({ model, modelRepair: model - 1, beingdb: diagnose + execute, diagnose, execute, deterministicRepairs: det });

test("efficiency summary counts calls, repairs and accuracy per model call", () => {
  const records = [
    rec("a", true, true, c(1, 1, 1, 0), 20000), // one call, correct
    rec("b", true, true, c(1, 2, 1, 1), 21000, { codes: ["constant_not_at_position"], det: [{ applied: [{ kind: "swap_arguments" }] }] }),
    rec("c", true, false, c(3, 3, 1, 0), 70000, { codes: ["unknown_constant"] }),
    rec("d", false, true, c(2, 1, 1, 0), 45000),
  ];
  const e = efficiencySummary(records);
  assert.equal(e.modelCalls, 7);
  assert.equal(e.modelRepairCalls, 3);
  assert.equal(e.firstAttemptCalls, 4);
  assert.equal(e.modelCallsPerSupportedQuestion, 1.667);
  assert.equal(e.beingdbCalls, 11);
  assert.equal(e.diagnoseCalls, 7);
  assert.equal(e.executeCalls, 4);
  assert.equal(e.beingdbMsTotal, 22);
  assert.equal(e.diagnoseMsTotal, 14);
  assert.equal(e.deterministicRepairs, 1);
  assert.equal(e.questionsRepairedDeterministically, 1);
  assert.equal(e.questionsRepairedDeterministicallyCorrect, 1);
  assert.equal(e.questionsWithModelRepair, 2);
  assert.equal(e.correctWithOneModelCall, 2);
  assert.deepEqual(e.rates, { solvedWithOneModelCall: 0.5, repairedDeterministically: 0.25, requiringModelRepair: 0.5 });
  assert.equal(e.correctPerModelCall, 0.429);
  assert.equal(e.supportedCorrectPerModelCall, 0.4);
  assert.deepEqual(e.correctWithinBudget, { "30s": 2, "60s": 3 });
  assert.deepEqual(e.deterministicRepairKinds, { swap_arguments: 1 });
});

test("records from before run 10 derive their calls from attempts", () => {
  assert.deepEqual(callsOf({ attempts: [{ beingdb: {} }, { beingdb: {} }, { beingdb: null }] }), c(3, 0, 2, 0));
  const dir = readdirSync("eval/results/benchmarks").find((d) => d.startsWith("20261006T135634Z"));
  const records = readFileSync(`eval/results/benchmarks/${dir}/questions.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  const e = efficiencySummary(records);
  assert.equal(e.modelCalls, records.reduce((n, r) => n + r.timing.llmCalls, 0));
  assert.equal(e.executeCalls, records.reduce((n, r) => n + r.timing.dbQueries, 0));
});

test("the repair policy is resolved from the CLI and recorded in run.json and summaries", async () => {
  const { toOptions } = await import("../scripts/benchmark.mjs");
  const { pipelineConfig, DEFAULTS } = await import("../scripts/lib/runner.mjs");
  const { policyOf } = await import("../scripts/lib/summary.mjs");
  assert.equal(toOptions({}).repairPolicy, undefined);
  assert.equal(DEFAULTS.repairPolicy, "model");
  assert.equal(toOptions({ "db-guided-repair": true }).repairPolicy, "db-guided");
  assert.equal(toOptions({ "repair-policy": "proven-only" }).repairPolicy, "proven-only");
  assert.equal(toOptions({ "repair-policy": "db-guided", "db-guided-repair": true }).repairPolicy, "db-guided");
  assert.throws(() => toOptions({ "repair-policy": "proven-only", "db-guided-repair": true }), /conflicting/);
  assert.throws(() => toOptions({ "repair-policy": "nope" }), /unknown repair policy/);

  const cfg = (repairPolicy) => pipelineConfig({ repairPolicy, repairAttempts: 2 });
  assert.deepEqual(
    Object.fromEntries(["model", "db-guided", "proven-only"].map((p) => [p, [cfg(p).version, cfg(p).repairPolicy, cfg(p).dbGuidedRepair, cfg(p).maxDeterministicPasses]])),
    {
      model: ["model-repair/run9", "model", false, 0],
      "db-guided": ["db-guided-repair/1", "db-guided", true, 2],
      "proven-only": ["proven-repairs-only/1", "proven-only", false, 2],
    },
  );
  // Run 10's recorded config.pipeline is what db-guided records today (plus the new fields).
  const run10 = JSON.parse(readFileSync(`eval/results/benchmarks/${readdirSync("eval/results/benchmarks").find((d) => d.startsWith("20261006T164839Z"))}/run.json`, "utf8"));
  for (const [k, v] of Object.entries(run10.config.pipeline)) assert.deepEqual(cfg("db-guided")[k], v, k);

  const load = (prefix) => {
    const dir = readdirSync("eval/results/benchmarks").find((d) => d.startsWith(prefix));
    return readFileSync(`eval/results/benchmarks/${dir}/questions.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  };
  assert.deepEqual(efficiencySummary(load("20261006T135634Z")).repairPolicies, { model: 50 });
  assert.deepEqual(efficiencySummary(load("20261006T164839Z")).repairPolicies, { "db-guided": 50 });
  assert.equal(policyOf({ efficiency: { pipeline: { version: "proven-repairs-only/1", repairPolicy: "proven-only" } } }), "proven-only");
});
