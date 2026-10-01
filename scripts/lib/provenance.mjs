// Software provenance and host facts recorded with every benchmark run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { root } from "./server.mjs";

const exec = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const sha256Text = (text) => createHash("sha256").update(text).digest("hex");

// Paths (relative to the repo) that never make a tree "dirty": benchmark output.
const OUTPUT_PATHS = [/^eval\/results\//];

export function gitInfo(dir, name) {
  if (!dir || !existsSync(dir)) return { name, present: false };
  const top = exec("git", ["rev-parse", "--show-toplevel"], dir);
  if (!top) return { name, present: true, git: false };
  const lines = (exec("git", ["status", "--porcelain"], top) || "").split("\n").filter(Boolean);
  const changed = lines.filter((l) => !OUTPUT_PATHS.some((re) => re.test(l.slice(3))));
  const diff = exec("git", ["diff", "HEAD"], top) || "";
  return {
    name,
    present: true,
    git: true,
    commit: exec("git", ["rev-parse", "HEAD"], top),
    branch: exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], top),
    describe: exec("git", ["describe", "--always", "--dirty", "--tags"], top),
    commitDate: exec("git", ["log", "-1", "--format=%cI"], top),
    remote: exec("git", ["config", "--get", "remote.origin.url"], top),
    // Uncommitted changes: results from a dirty tree do not correspond exactly to `commit`.
    dirty: changed.length > 0,
    changedFiles: changed.slice(0, 200),
    diffSha256: diff ? sha256Text(diff) : null,
  };
}

const packageVersion = (name) => {
  try {
    return JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

export function vendorPaths() {
  const wasmDir = path.join(root, "vendor", "beingdb-wasm");
  const webllmDir = path.join(root, "vendor", "web-llm");
  const real = (p) => (existsSync(p) ? realpathSync(p) : null);
  const wasmReal = real(wasmDir);
  // beingdb-wasm vendors the BeingDB runtime through a symlink to ../beingdb.
  const wasmRepo = wasmReal ? exec("git", ["rev-parse", "--show-toplevel"], wasmReal) : null;
  const beingdbRuntime = wasmRepo ? real(path.join(wasmRepo, "vendor", "beingdb_runtime")) : null;
  return { wasmDir, webllmDir, wasmReal, wasmRepo, beingdbRuntime };
}

export function provenance() {
  const v = vendorPaths();
  const assets = v.wasmReal ? path.join(v.wasmReal, "main.bc.wasm.assets") : null;
  const wasmModules = assets && existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith(".wasm")) : [];
  const file = (p) => (p && existsSync(p) ? sha256File(p) : null);
  return {
    repositories: {
      "beingdb-webllm": gitInfo(root, "beingdb-webllm"),
      "beingdb-wasm": gitInfo(v.wasmRepo, "beingdb-wasm"),
      beingdb: gitInfo(v.beingdbRuntime, "beingdb"),
    },
    // The build actually served to the browser (may predate the repositories' current commits).
    artefacts: {
      beingdbWasmLoaderSha256: file(v.wasmReal && path.join(v.wasmReal, "main.bc.wasm.js")),
      beingdbWasmModules: Object.fromEntries(wasmModules.map((f) => [f, sha256File(path.join(assets, f))])),
      rewindDataSha256: file(v.wasmReal && path.join(v.wasmReal, "rewind.browser.json")),
    },
    packages: {
      "@mlc-ai/web-llm": packageVersion("@mlc-ai/web-llm"),
      "playwright-core": packageVersion("playwright-core"),
    },
    node: process.version,
  };
}

// Memory state at one moment: swapping during a run inflates model and BeingDB timings.
export function memorySnapshot() {
  const snap = { at: new Date().toISOString(), freeBytes: os.freemem(), swapUsedBytes: null, swapTotalBytes: null, freePercent: null };
  const mb = (s) => Math.round(parseFloat(s) * 2 ** 20);
  if (os.platform() === "darwin") {
    const swap = exec("sysctl", ["-n", "vm.swapusage"]);
    snap.swapTotalBytes = swap?.match(/total = ([\d.]+)M/) ? mb(swap.match(/total = ([\d.]+)M/)[1]) : null;
    snap.swapUsedBytes = swap?.match(/used = ([\d.]+)M/) ? mb(swap.match(/used = ([\d.]+)M/)[1]) : null;
    const free = exec("memory_pressure")?.match(/free percentage: (\d+)%/)?.[1];
    snap.freePercent = free === undefined ? null : Number(free);
  } else if (os.platform() === "linux" && existsSync("/proc/meminfo")) {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => {
      const m = info.match(new RegExp(`^${k}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("SwapTotal");
    const free = kb("SwapFree");
    snap.swapTotalBytes = total;
    snap.swapUsedBytes = total !== null && free !== null ? total - free : null;
    const avail = kb("MemAvailable");
    snap.freePercent = avail !== null ? Math.round((100 * avail) / os.totalmem()) : null;
  }
  return snap;
}

// Best-effort machine facts from the OS (the browser cannot see these reliably).
export function hostInfo() {
  const cpus = os.cpus();
  const info = {
    platform: os.platform(),
    release: os.release(),
    version: os.version?.() ?? null,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(),
    hardwareModel: null,
    osProductVersion: null,
    power: null,
  };
  if (info.platform === "darwin") {
    info.hardwareModel = exec("sysctl", ["-n", "hw.model"]);
    info.osProductVersion = exec("sw_vers", ["-productVersion"]);
    const batt = exec("pmset", ["-g", "batt"]);
    const lowPower = exec("pmset", ["-g"])?.match(/lowpowermode\s+(\d)/)?.[1];
    info.power = {
      source: batt?.match(/'([^']+)'/)?.[1] ?? null,
      lowPowerMode: lowPower === undefined ? null : lowPower === "1",
    };
  } else if (info.platform === "linux") {
    const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : null);
    info.hardwareModel = read("/sys/devices/virtual/dmi/id/product_name");
    info.osProductVersion = read("/etc/os-release")?.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? null;
  } else if (info.platform === "win32") {
    info.osProductVersion = os.version?.() ?? null;
  }
  return info;
}
