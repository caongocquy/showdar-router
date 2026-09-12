import { describe, expect, it, vi } from "vitest";
import { classifyRouteFailure } from "../../open-sse/services/routeFailureClassifier.js";
import { RouteHealthState } from "../../open-sse/services/routeHealthState.js";
import { validateChatComboResponse } from "../../open-sse/services/chatComboResponseValidator.js";
import { defaultClaudeToolType } from "../../open-sse/translator/concerns/toolCall.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const now = Date.parse("2026-09-12T00:00:00.000Z");

function storage() {
  const values = {};
  return {
    async getAll() { return { ...values }; },
    async set(key, value) { values[key] = value; },
    async remove(key) { delete values[key]; },
    async clear() { Object.keys(values).forEach((key) => delete values[key]); },
  };
}

describe("runtime health hardening", () => {
  it("classifies Gemini daily free-tier quota separately from transient 429", () => {
    const daily = classifyRouteFailure(429, JSON.stringify({
      error: { details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
    }));
    const transient = classifyRouteFailure(429, "NVIDIA rate limit; retry in 2s");

    expect(daily.reason).toBe("daily_quota");
    expect(daily.scope).toBe("route");
    expect(transient.reason).toBe("transient_rate_limit");
  });

  it("keeps structured Gemini quota identity available to downstream classification", async () => {
    const result = await parseUpstreamError(new Response(JSON.stringify({
      error: { message: "Resource exhausted", details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
    }), { status: 429, headers: { "content-type": "application/json" } }));
    expect(result.message).toContain("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
    expect(classifyRouteFailure(result.statusCode, result.message).reason).toBe("daily_quota");
  });

  it("does not schedule a daily-quota route from a short RetryInfo", async () => {
    const state = new RouteHealthState(storage());
    const record = await state.recordFailure("gemini/gemini-3.8-flash", {
      ...classifyRouteFailure(429, "quotaId=GenerateRequestsPerDayPerModel-FreeTier"),
    }, new Date(now + 40_000).toISOString(), now);

    expect(new Date(record.nextProbeAt).getTime() - now).toBeGreaterThan(60 * 60 * 1000);
  });

  it("keeps transient NVIDIA-style cooldown short and clears on success", async () => {
    const state = new RouteHealthState(storage());
    const failure = await state.recordFailure("nvidia/model", {
      ...classifyRouteFailure(429, "rate limit; retry in 2s"),
    }, new Date(now + 2_000).toISOString(), now);

    expect(new Date(failure.nextProbeAt).getTime() - now).toBe(2_000);
    await state.recordSuccess("nvidia/model");
    expect((await state.snapshot())["nvidia/model"]).toBeUndefined();
  });

  it("times out an empty successful stream and cancels it once", async () => {
    let cancelCount = 0;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); },
      cancel() { cancelCount++; },
    }), { headers: { "content-type": "text/event-stream" } });

    const result = await validateChatComboResponse(response, null, { firstMeaningfulTimeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.errorText).toMatch(/no content|timeout/i);
    expect(cancelCount).toBe(1);
  });

  it("fails over after an empty stream instead of pinning the combo", async () => {
    const attempted = [];
    const result = await handleComboChat({
      body: { stream: true },
      models: ["gemini/model", "nvidia/model"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model.startsWith("gemini")) {
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      },
      validateSuccess: (response, model) => validateChatComboResponse(response, model, { firstMeaningfulTimeoutMs: 10 }),
      log: { info() {}, warn() {} },
    });

    expect(attempted).toEqual(["gemini/model", "nvidia/model"]);
    expect(result.ok).toBe(true);
  });

  it("preserves meaningful progress and finalizes after a terminal event", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const result = await validateChatComboResponse(response, null, { firstMeaningfulTimeoutMs: 10 });
    expect(result.ok).toBe(true);
    expect(await result.response.text()).toContain("ok");
  });

  it("defaults Claude tool type only for opted-in strict providers", () => {
    const tools = [{ name: "lookup" }, { name: "computer", type: "computer_use" }];
    expect(defaultClaudeToolType(tools, { requireClaudeToolType: true })).toEqual([
      { name: "lookup", type: "custom" },
      { name: "computer", type: "computer_use" },
    ]);
    expect(defaultClaudeToolType(tools, { requireClaudeToolType: false })).toEqual(tools);
  });
});
