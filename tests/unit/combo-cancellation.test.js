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
});
