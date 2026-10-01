// What the browser itself reports about the machine. Values the browser does
// not expose are recorded as null, never guessed.

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i;

function plain(obj) {
  if (!obj) return null;
  const out = {};
  // WebIDL attributes are enumerable getters on the prototype, so for...in sees them.
  for (const k in obj) {
    const v = obj[k];
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
  }
  return out;
}

export async function webgpuReport() {
  if (!navigator.gpu) return { available: false, adapter: null };
  // Same adapter request as WebLLM (detectGPUDevice).
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  if (!adapter) return { available: true, adapter: null };
  const info = plain(adapter.info);
  const isFallbackAdapter = adapter.isFallbackAdapter ?? info?.isFallbackAdapter ?? null;
  const described = info ? [info.vendor, info.architecture, info.device, info.description].join(" ") : "";
  return {
    available: true,
    adapter: {
      info,
      features: [...adapter.features].sort(),
      limits: plain(adapter.limits),
      isFallbackAdapter,
      softwareRenderer: isFallbackAdapter === true || SOFTWARE_ADAPTER.test(described),
    },
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat?.() ?? null,
    wgslLanguageFeatures: navigator.gpu.wgslLanguageFeatures ? [...navigator.gpu.wgslLanguageFeatures].sort() : null,
  };
}

export async function collectEnvironment() {
  const nav = navigator;
  const uaData = nav.userAgentData
    ? await nav.userAgentData
        .getHighEntropyValues(["architecture", "bitness", "model", "platform", "platformVersion", "fullVersionList", "wow64"])
        .catch(() => null)
    : null;
  const storage = nav.storage?.estimate ? await nav.storage.estimate().catch(() => null) : null;
  return {
    userAgent: nav.userAgent,
    userAgentData: uaData ? JSON.parse(JSON.stringify(uaData)) : null,
    platform: nav.platform ?? null,
    language: nav.language ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    // Chromium rounds and caps this (max 8), so it is not the physical RAM.
    deviceMemoryGB: nav.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio },
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    crossOriginIsolated: self.crossOriginIsolated ?? null,
    jsHeapLimitMB: performance.memory ? performance.memory.jsHeapSizeLimit / 1e6 : null,
    storage: storage ? { usageBytes: storage.usage ?? null, quotaBytes: storage.quota ?? null } : null,
    webgpu: await webgpuReport(),
  };
}
