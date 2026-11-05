// The browser lost the GPU (sleep, long idle, driver reset): WebLLM has disposed its engine.
export const isGpuLost = (e) =>
  e?.name === "DeviceLostError" || /disposed|device ?lost|webgpu/i.test(String(e?.message ?? e));
