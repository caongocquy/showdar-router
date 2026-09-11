import { describe, it, expect, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";
import { validateChatComboResponse } from "../../open-sse/services/chatComboResponseValidator.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .clone().json() surface the engine uses.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return make();
}

function realResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { headers: { "content-type": "application/json" } });
}

function sseResponse(content = "answer") {
  const chunk = { choices: [{ delta: { content }, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

describe("fusion combo", () => {
  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("runs a single eligible model through health and success hooks", async () => {
    const before = vi.fn(async (_model, options) => ({ skip: false, probe: !options?.inspectOnly }));
    const onSuccess = vi.fn();
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel: async () => realResponse("solo"),
      beforeModelAttempt: before,
      onModelSuccess: onSuccess,
      log,
    });
    expect(res.ok).toBe(true);
    expect(before).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith("p/only");
  });

  it("keeps a single eligible streaming response readable", async () => {
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["p/only"],
      handleSingleModel: async () => sseResponse("solo"),
      validateSuccess: validateChatComboResponse,
      log,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("solo");
  });

  it("does not let a second single-model half-open request acquire the probe", async () => {
    let owner = false;
    let providerCalls = 0;
    const before = async (_model, options) => {
      if (options?.inspectOnly) return { skip: false };
      if (owner) return { skip: true, nextProbeAt: new Date(Date.now() + 60_000).toISOString() };
      owner = true;
      return { skip: false, probe: true };
    };
    const handleSingleModel = async () => {
      providerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return realResponse("solo");
    };
    const options = { body: { messages: [{ role: "user", content: "hi" }] }, models: ["p/only"], handleSingleModel, beforeModelAttempt: before, log };
    const [first, second] = await Promise.all([handleFusionChat(options), handleFusionChat(options)]);
    expect(first.ok).toBe(true);
    expect(second.status).toBe(503);
    expect(providerCalls).toBe(1);
  });

  it("accepts a streaming judge without consuming its SSE response", async () => {
    const calls = [];
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b"],
      judgeModel: "p/judge",
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return model === "p/judge" ? sseResponse("FINAL") : realResponse(`ans-${model}`);
      },
      validateSuccess: validateChatComboResponse,
      log,
    });
    expect(calls).toEqual(["p/a", "p/b", "p/judge"]);
    expect((await res.text())).toContain("data:");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("falls back when a streaming judge completes without meaningful content", async () => {
    const calls = [];
    const empty = new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b"],
      judgeModel: "p/judge",
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "p/judge") return empty;
        if (model === "p/a" && calls.filter((m) => m === "p/a").length > 1) return sseResponse("FALLBACK");
        return realResponse(`ans-${model}`);
      },
      validateSuccess: validateChatComboResponse,
      log,
    });
    expect(calls).toEqual(["p/a", "p/b", "p/judge", "p/a"]);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it.each([
    ["OpenRouter reset", 429, { error: { message: "rate limit", metadata: { headers: { "X-RateLimit-Reset": String(Date.now() + 60_000) } } } }, true],
    ["Gemini retry delay", 429, { error: { message: "busy", details: [{ retryDelay: "7s" }] } }, true],
    ["provider capacity", 503, { error: { message: "capacity" } }, false],
  ])("preserves %s panel failure metadata", async (_name, status, payload, hasRetry) => {
    const failures = [];
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/fail", "p/ok"],
      handleSingleModel: async (_body, model) => model === "p/fail"
        ? new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
        : realResponse("survivor"),
      onModelFailure: async (_model, failure) => failures.push(failure),
      log,
    });
    expect(res.ok).toBe(true);
    expect(failures[0]).toMatchObject({ status, errorText: payload.error.message });
    if (hasRetry) expect(failures[0].retryAfter).toEqual(expect.any(String));
    else expect(failures[0].retryAfter).toBeNull();
  });

  it("does not record a panel response cancelled by the router", async () => {
    const failures = vi.fn();
    const requestController = new AbortController();
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      requestSignal: requestController.signal,
      handleSingleModel: async (_body, _model, _isPanel, { signal }) => {
        requestController.abort();
        return new Response(JSON.stringify({ error: { message: "aborted" } }), { status: 499, headers: { "content-type": "application/json" } });
      },
      onModelFailure: failures,
      log,
    });
    expect(res.status).toBe(503);
    expect(failures).not.toHaveBeenCalled();
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(([, m]) => m !== "p/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel).toBeUndefined();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });

  it("does not count an empty HTTP 200 toward quorum and replays a lone answer as SSE", async () => {
    const calls = vi.fn(async (_body, model) => model === "p/empty" ? realResponse("") : realResponse("answer"));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/empty", "p/answer"], handleSingleModel: calls, log,
      tuning: { stragglerGraceMs: 1, panelHardTimeoutMs: 1000 }
    });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"answer"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
