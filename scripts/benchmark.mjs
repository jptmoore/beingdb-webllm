// npm run benchmark -- --model <WebLLM model id> [options]   (see --help)
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runBenchmark, DEFAULTS } from "./lib/runner.mjs";

export const OPTIONS = {
  model: { type: "string" },
  runs: { type: "string" },
  browser: { type: "string" },
  "executable-path": { type: "string" },
  "browser-arg": { type: "string", multiple: true },
  profile: { type: "string" },
  port: { type: "string" },
  questions: { type: "string" },
  ids: { type: "string" },
  output: { type: "string" },
  seed: { type: "string" },
  temperature: { type: "string" },
  "repair-temperature": { type: "string" },
  "top-p": { type: "string" },
  "max-tokens": { type: "string" },
  "repetition-penalty": { type: "string" },
  "repair-attempts": { type: "string" },
  "question-timeout": { type: "string" },
  machine: { type: "string" },
  notes: { type: "string" },
  condition: { type: "string" },
  warmup: { type: "boolean" },
  headed: { type: "boolean" },
  headless: { type: "boolean" },
  cold: { type: "boolean" },
  probe: { type: "boolean" },
  "allow-software-gpu": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export const HELP = `Options (defaults reproduce the run-8 baseline configuration):
  --model <id>              WebLLM prebuilt model id (required; list: npm run models)
  --runs <n>                repeat the whole evaluation n times with the loaded model [${DEFAULTS.runs}]
  --machine "<label>"       your description of the machine, e.g. "MacBook Pro M4 Max 64GB"
  --notes "<text>"          free-text note stored with the run
  --condition <name>        experimental-condition label [${DEFAULTS.condition}]
  --browser <name>          chrome | chrome-beta | chrome-canary | edge | edge-beta | chromium [${DEFAULTS.browser}]
  --executable-path <path>  any other Chromium-based browser binary
  --browser-arg <arg>       extra browser flag (repeatable), e.g. --browser-arg=--enable-unsafe-webgpu
  --profile <dir>           browser profile (model cache) [~/.cache/beingdb-webllm/browser-profiles/<browser>]
  --port <n>                local server port; keep it fixed so the model cache is reused [${DEFAULTS.port}]
  --questions <path>        question file [eval/questions.json = suite rewind-nl2dsl-v1]
  --ids <e01,m02,...>       run only these questions (marks the run partial)
  --output <dir>            where run directories are written [eval/results/benchmarks]
  --seed <n>                [${DEFAULTS.seed}]
  --temperature <x>         first-attempt temperature [${DEFAULTS.temperature}]
  --repair-temperature <x>  [${DEFAULTS.repairTemperature}]
  --top-p <x>               [model default]
  --max-tokens <n>          [${DEFAULTS.maxTokens}]
  --repetition-penalty <x>  [${DEFAULTS.repetitionPenalty}]
  --repair-attempts <n>     [${DEFAULTS.repairAttempts}]
  --question-timeout <s>    abort the run if one question takes longer [${DEFAULTS.questionTimeout}]
  --warmup                  compile both grammars and run 2 example questions before timing
  --cold                    delete this model from the browser cache first (measures a cold download)
  --probe                   only check compatibility, load the model and run one smoke generation
  --headless                run the browser headless (not recommended: WebGPU may be missing or software)
  --headed                  run with a visible window (the default)
  --allow-software-gpu      do not fail on a software/fallback WebGPU adapter`;

const num = (v) => (v === undefined ? undefined : Number(v));

export function toOptions(values) {
  const o = {
    model: values.model,
    runs: num(values.runs),
    browser: values.browser,
    executablePath: values["executable-path"],
    browserArgs: values["browser-arg"],
    profile: values.profile,
    port: num(values.port),
    questions: values.questions,
    ids: values.ids,
    output: values.output,
    seed: num(values.seed),
    temperature: num(values.temperature),
    repairTemperature: num(values["repair-temperature"]),
    topP: num(values["top-p"]),
    maxTokens: num(values["max-tokens"]),
    repetitionPenalty: num(values["repetition-penalty"]),
    repairAttempts: num(values["repair-attempts"]),
    questionTimeout: num(values["question-timeout"]),
    machine: values.machine,
    notes: values.notes,
    condition: values.condition,
    warmup: values.warmup,
    headless: values.headless && !values.headed,
    cold: values.cold,
    probe: values.probe,
    allowSoftwareGpu: values["allow-software-gpu"],
  };
  for (const [k, v] of Object.entries(o)) if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`--${k}: not a number`);
  if (o.seed !== undefined && !Number.isInteger(o.seed)) throw new Error("--seed must be an integer");
  if (o.runs !== undefined && !(Number.isInteger(o.runs) && o.runs >= 1)) throw new Error("--runs must be a positive integer");
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// Ctrl-C finishes the current question, writes the partial run and closes the browser.
export function interruptSignal() {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    console.log("\nInterrupt: finishing the current question, then saving (Ctrl-C again to quit immediately)…");
    controller.abort();
  });
  return controller.signal;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, strict: true }));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(64);
  }
  if (values.help) {
    console.log(`npm run benchmark -- --model <id> [options]\n\n${HELP}`);
    process.exit(0);
  }
  let opts;
  try {
    opts = toOptions(values);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(64);
  }
  try {
    const { status } = await runBenchmark(opts, { signal: interruptSignal() });
    process.exit(status === "complete" || status === "probe_ok" ? 0 : status === "incompatible" || status === "model_load_failed" ? 2 : 1);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(e.status === "setup_failed" ? 64 : 1);
  }
}
