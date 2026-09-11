import { describe, it, expect, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const response = (text) => ({ ok: true, status: 200, clone: () => response(text), json: async () => ({ choices: [{ message: { content: text } }] }) });

describe("fusion cancellation and reuse", () => {
  it("does not call a lone successful panel a second time", async () => {
    const call = vi.fn(async (_body, model, isPanel) => model === "p/ok" ? response("answer") : { ok: false, status: 500, clone: () => ({ json: async () => ({}) }) });
    await handleFusionChat({ body: { messages: [{ role: "user", content: "q" }] }, models: ["p/ok", "p/bad"], handleSingleModel: call, log, tuning: { stragglerGraceMs: 1 } });
    expect(call.mock.calls.filter(([, model]) => model === "p/ok")).toHaveLength(1);
  });

  it("aborts pending panel work after quorum grace", async () => {
    let aborted = false;
    const call = vi.fn(async (_body, model, isPanel, { signal } = {}) => {
      if (model === "p/slow") return new Promise((resolve) => {
        signal?.addEventListener("abort", () => { aborted = true; resolve({ ok: false, status: 499 }); }, { once: true });
      });
      return response(model);
    });
    await handleFusionChat({ body: { messages: [{ role: "user", content: "q" }] }, models: ["p/a", "p/b", "p/slow"], handleSingleModel: call, log, judgeModel: "p/judge", tuning: { stragglerGraceMs: 1, panelHardTimeoutMs: 1000 } });
    expect(aborted).toBe(true);
  });

  it("does not dequeue new panel work after quorum", async () => {
    const started = [];
    const call = vi.fn(async (_body, model) => {
      started.push(model);
      if (model === "p/a" || model === "p/b") return response(model);
      return new Promise((resolve) => setTimeout(() => resolve(response(model)), 200));
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/h"],
      handleSingleModel: call, log, judgeModel: "p/judge",
      tuning: { minPanel: 2, maxConcurrent: 4, stragglerGraceMs: 1, panelHardTimeoutMs: 1000 },
    });
    expect(started.filter((model) => model !== "p/judge")).toEqual(["p/a", "p/b", "p/c", "p/d"]);
  });

  it("stops the panel queue immediately when the parent request aborts", async () => {
    const started = [];
    const cancelled = vi.fn();
    const requestController = new AbortController();
    const call = vi.fn(async (_body, model, isPanel, { signal } = {}) => {
      started.push(model);
      if (started.length === 4) setTimeout(() => requestController.abort(), 0);
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        cancelled(model);
        resolve({ ok: false, status: 499 });
      }, { once: true }));
    });
    const t0 = Date.now();
    const result = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/h"],
      handleSingleModel: call,
      requestSignal: requestController.signal,
      onModelCancelled: cancelled,
      log,
      tuning: { maxConcurrent: 4, panelHardTimeoutMs: 5000 },
    });
    expect(result.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(started).toEqual(["p/a", "p/b", "p/c", "p/d"]);
  });
});
