import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, resetComboRotation, handleComboChat } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("keeps the logical cursor when eligibility shrinks and expands", async () => {
    const seen = [];
    const run = (models) => handleComboChat({ body: {}, models, comboName: "dynamic", comboStrategy: "round-robin", handleSingleModel: async (_body, model) => { seen.push(model); return new Response("ok", { status: 200 }); }, log: { info() {}, warn() {} } });
    await run(["p/a", "p/b", "p/c"]);
    await run(["p/b", "p/c"]);
    await run(["p/a", "p/b", "p/c"]);
    expect(seen).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("allocates concurrent round-robin primaries fairly before provider execution", async () => {
    const seen = [];
    const run = () => handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], comboName: "concurrent", comboStrategy: "round-robin",
      handleSingleModel: async (_body, model) => { seen.push(model); return new Response("ok"); },
      log: { info() {}, warn() {} },
    });
    await Promise.all(Array.from({ length: 6 }, run));
    expect(seen).toEqual(["p/a", "p/b", "p/c", "p/a", "p/b", "p/c"]);
  });

  it("rechecks health for RR fallback candidates without moving the cursor", async () => {
    const attempted = [];
    const checked = [];
    const first = () => handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], comboName: "fallback-health", comboStrategy: "round-robin",
      handleSingleModel: async () => new Response("ok"), log: { info() {}, warn() {} },
    });
    await first();
    const res = await handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], comboName: "fallback-health", comboStrategy: "round-robin",
      beforeModelAttempt: async (model, options) => {
        if (!options?.inspectOnly) checked.push(model);
        return model === "p/c" && !options?.inspectOnly
          ? { skip: true, nextProbeAt: new Date(Date.now() + 60_000).toISOString() }
          : { skip: false };
      },
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return model === "p/b" ? new Response("fail", { status: 500 }) : new Response("ok");
      },
      log: { info() {}, warn() {} },
    });
    expect(res.ok).toBe(true);
    expect(attempted).toEqual(["p/b", "p/a"]);
    expect(checked).toEqual(["p/b", "p/c", "p/a"]);
  });

  it("skips an RR fallback candidate owned by another half-open probe", async () => {
    const attempted = [];
    const first = () => handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], comboName: "half-open-fallback", comboStrategy: "round-robin",
      handleSingleModel: async () => new Response("ok"), log: { info() {}, warn() {} },
    });
    await first();
    const res = await handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], comboName: "half-open-fallback", comboStrategy: "round-robin",
      beforeModelAttempt: async (model, options) => model === "p/c" && !options?.inspectOnly
        ? { skip: true, reason: "half-open" } : { skip: false },
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return model === "p/b" ? new Response("fail", { status: 500 }) : new Response("ok");
      },
      log: { info() {}, warn() {} },
    });
    expect(res.ok).toBe(true);
    expect(attempted).toEqual(["p/b", "p/a"]);
  });
});
