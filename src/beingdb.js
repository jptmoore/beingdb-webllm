// Thin wrapper over the beingdb-wasm browser API. BeingDB does all parsing,
// validation, planning and execution; this only loads it and times calls.

export function wrapBeingDB(BeingDB) {
  return {
    predicates: () => JSON.parse(BeingDB.predicates()),
    // status: "ok" (executed), "invalid" (validation errors), "error" (runtime/request failure)
    query(dsl) {
      const t = performance.now();
      const response = JSON.parse(BeingDB.query(dsl));
      const ms = performance.now() - t;
      const status = response.valid === false ? "invalid" : response.error ? "error" : "ok";
      return { status, response, ms };
    },
    // Validation + BeingDB's data-aware diagnostics and proven repair, without executing.
    // status: "ok" (valid), "invalid", "error"
    diagnose(dsl) {
      const t = performance.now();
      const response = JSON.parse(BeingDB.diagnose(dsl));
      const ms = performance.now() - t;
      const status = response.error ? "error" : response.valid ? "ok" : "invalid";
      return { status, response, ms };
    },
  };
}

export async function loadBeingDB(base = "vendor/beingdb-wasm/") {
  const t0 = performance.now();
  const BeingDB = await new Promise((resolve, reject) => {
    window.onBeingDBReady = resolve;
    const script = document.createElement("script");
    script.src = base + "main.bc.wasm.js";
    script.onerror = () => reject(new Error(`failed to load ${script.src}`));
    document.head.append(script);
  });
  const t1 = performance.now();
  const text = await (await fetch(base + "rewind.browser.json")).text();
  const t2 = performance.now();
  const summary = JSON.parse(BeingDB.load(text));
  if (summary.error) throw new Error(`BeingDB load failed: ${summary.error.message}`);
  const t3 = performance.now();
  return {
    db: wrapBeingDB(BeingDB),
    summary,
    timings: { wasmMs: t1 - t0, fetchMs: t2 - t1, loadMs: t3 - t2, dataBytes: text.length },
  };
}
