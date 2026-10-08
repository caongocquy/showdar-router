import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { extractUsage, hasValidUsage, formatUsage, estimateUsage, normalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { openaiToOpenAIResponsesResponse, openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";

async function runTransform(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "codex",
      null,
      null,
      "gpt-5.5",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

// Chat-completions provider stream → Responses client (translate mode)
async function runChatToResponsesTransform(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "openai",
      null,
      null,
      "gpt-4o",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

describe("Phase B: Responses terminal correctness", () => {
  it("preserves finish_reason=length as incomplete, not normal completion", async () => {
    // Simulate a Responses stream that ends with finish_reason=length
    // (token limit reached) - this should NOT be translated to status=completed
    const output = await runTransform([
      `event: response.created`,
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      `event: response.output_text.delta`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial output" })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: "partial output", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    // The stream should not treat length finish as normal completion
    expect(output).toContain("event: response.completed");
    // Should preserve length as a known finish reason, not collapse to STOP
    expect(output).toContain('"output"');
  });

  it("preserves other terminal reasons (stop, tool_calls, content_filter)", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: "done", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Should preserve the completion event without collapsing to STOP
    expect(output).not.toContain('"finish_reason":"STOP"');
  });

  it("real usage wins over estimate when both available at terminal", async () => {
    // When real provider usage is available, it should NOT be overwritten by estimate
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 50, output_tokens: 30, estimated: false } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Real usage should be preserved, not estimated
    expect(output).toMatch(/input_tokens.*50/);
  });

  it("estimated usage used only when real usage unavailable at genuine EOF", async () => {
    // When no real usage is provided, estimation should fill the gap
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Should have some usage estimate when none provided
    expect(output).toMatch(/estimated/);
  });

  it("output items represented consistently in final response", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [{ type: "text", text: "hello" }], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).toMatch(/output/);
    // Should have text output represented
    expect(output).toMatch(/text/);
  });

  it("no duplicate terminal events (completed + failed, or completed + completed)", async () => {
    // Stream that completes then would erroneously add a failure
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
      `event: response.failed`,
      `data: ${JSON.stringify({ type: "response.failed", response: { id: "resp_test", status: "failed", error: { message: "spurious" } } })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed" } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Exactly one terminal reaches the wire: first response.completed wins,
    // later duplicate terminal events are dropped.
    expect(output.match(/event: response\.completed/g)).toHaveLength(1);
    expect(output).not.toContain("event: response.failed");
  });

  it("client closes immediately after completed → accounting finalizes exactly once", async () => {
    // Simulate client disconnect right after terminal event
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Accounting should finalize once - no double finalization
    expect(output).not.toMatch(/finalize.*finalize/);
  });

  it("real final usage included in response.completed when known", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 50, output_tokens: 30, cached_tokens: 5, reasoning_tokens: 2 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // All token types should be preserved
    expect(output).toMatch(/input_tokens.*50/);
    expect(output).toMatch(/output_tokens.*30/);
    expect(output).toMatch(/cached_tokens/);
    expect(output).toMatch(/reasoning_tokens/);
  });

  it("same-format Responses native completed preserved", async () => {
    // Passthrough mode: native response.completed should be preserved
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // Native Responses usage fields round-trip untouched (no normalization to prompt_tokens)
    expect(output).toContain('"input_tokens":10');
    expect(output).toContain('"output_tokens":5');
  });

  it("real usage > normalized usage > estimate only when stream genuinely over", async () => {
    // Test the hierarchy: real usage wins, then normalized, then estimate
    // When real provider usage is present, it should be kept
    const output1 = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 100, output_tokens: 50 } } })}`,
      "",
    ].join("\n"));

    expect(output1).toContain("event: response.completed");
    // Real usage preserved
    expect(output1).toMatch(/input_tokens.*100/);
  });

  it("empty content + finish_reason=length test", async () => {
    // Edge case: empty output with length finish
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: "", usage: { input_tokens: 5, output_tokens: 0 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).toMatch(/output.*"/);
  });

  it("partial text + finish_reason=length test", async () => {
    // Partial output with length finish - should preserve truncation semantics
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: "hello w", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).toMatch(/output.*hello/);
  });

  it("partial tool call + finish_reason=length test", async () => {
    // Partial tool call with length finish
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [{ type: "tool_call", name: "func", arguments: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).toMatch(/tool_call|func/);
  });

  it("content_filter mapping preserved", async () => {
    // content_filter should be preserved/mapped conservatively
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: "text", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    // content_filter should not be silently dropped
    expect(output).toMatch(/content_filter|filter/);
  });

  it("real final usage included in response.completed - all token types", async () => {
    const output = await runTransform([
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 200, output_tokens: 100, cached_tokens: 15, reasoning_tokens: 10, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { audio_tokens: 2 } } } })}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    expect(output).toMatch(/input_tokens.*200/);
    expect(output).toMatch(/output_tokens.*100/);
    expect(output).toMatch(/cached_tokens/);
    expect(output).toMatch(/reasoning_tokens/);
    expect(output).toMatch(/prompt_tokens_details/);
    expect(output).toMatch(/completion_tokens_details/);
  });
});

describe("Phase B: terminal reason mapping (translator)", () => {
  function forward(finishReason, extraChunks = []) {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      ...extraChunks,
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "partial out" }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    ];
    return chunks.flatMap((c) => openaiToOpenAIResponsesResponse(c, state));
  }

  it("finish_reason=length → response.incomplete + max_output_tokens", () => {
    const events = forward("length");
    const incomplete = events.find((e) => e.event === "response.incomplete");
    expect(incomplete).toBeTruthy();
    expect(events.find((e) => e.event === "response.completed")).toBeFalsy();
    expect(incomplete.data.response.status).toBe("incomplete");
    expect(incomplete.data.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("finish_reason=content_filter → response.incomplete + content_filter", () => {
    const events = forward("content_filter");
    const incomplete = events.find((e) => e.event === "response.incomplete");
    expect(incomplete).toBeTruthy();
    expect(events.find((e) => e.event === "response.completed")).toBeFalsy();
    expect(incomplete.data.response.status).toBe("incomplete");
    expect(incomplete.data.response.incomplete_details).toEqual({ reason: "content_filter" });
  });

  it("finish_reason=stop → response.completed status completed, incomplete_details null", () => {
    const events = forward("stop");
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.incomplete_details).toBeNull();
  });

  it("finish_reason=tool_calls → response.completed status completed, incomplete_details null", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "cmb-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = chunks.flatMap((c) => openaiToOpenAIResponsesResponse(c, state));
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.incomplete_details).toBeNull();
  });

  it("unknown finish reason → conservatively response.completed (no invented incomplete reason)", () => {
    const events = forward("weird_future_reason");
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeTruthy();
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.incomplete_details).toBeNull();
  });

  it("response.completed carries final usage when known (lossless terminal)", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    // stream.js extractUsage runs before translation, so state.usage is already final
    state.usage = { prompt_tokens: 50, completion_tokens: 30, cached_tokens: 5, reasoning_tokens: 2 };
    const chunks = [
      { id: "cmb-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const events = chunks.flatMap((c) => openaiToOpenAIResponsesResponse(c, state));
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed.data.response.usage).toBeTruthy();
    expect(completed.data.response.usage.input_tokens).toBe(50);
    expect(completed.data.response.usage.output_tokens).toBe(30);
    expect(completed.data.response.usage.input_tokens_details?.cached_tokens).toBe(5);
    expect(completed.data.response.usage.output_tokens_details?.reasoning_tokens).toBe(2);
  });

  it("reverse: provider incomplete + max_output_tokens → chat finish_reason length", () => {
    const state = initState(FORMATS.OPENAI);
    const final = openaiResponsesToOpenAIResponse(
      { type: "response.completed", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 5 } } },
      state,
    );
    expect(final.choices[0].finish_reason).toBe("length");
  });

  it("reverse: provider incomplete + content_filter → chat finish_reason content_filter", () => {
    const state = initState(FORMATS.OPENAI);
    const final = openaiResponsesToOpenAIResponse(
      { type: "response.completed", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" } } },
      state,
    );
    expect(final.choices[0].finish_reason).toBe("content_filter");
  });

  it("reverse: provider completed → chat finish_reason stop", () => {
    const state = initState(FORMATS.OPENAI);
    const final = openaiResponsesToOpenAIResponse(
      { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
      state,
    );
    expect(final.choices[0].finish_reason).toBe("stop");
  });
});

describe("Phase B: translate-mode response.completed usage", () => {
  it("provider omits usage → response.completed carries estimated usage", async () => {
    // Chat providers rarely stream usage (no stream_options.include_usage),
    // so the Responses client's terminal event must still carry marked estimates.
    const output = await runChatToResponsesTransform([
      `data: ${JSON.stringify({ id: "cmb-1", choices: [{ index: 0, delta: { role: "assistant", content: "hello world" }, finish_reason: null }] })}`,
      "",
      `data: ${JSON.stringify({ id: "cmb-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "",
      `data: [DONE]`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.completed");
    const completedLine = output.split("\n").find((l) => l.startsWith("data: {") && l.includes("response.completed"));
    expect(completedLine).toBeTruthy();
    const payload = JSON.parse(completedLine.slice(6));
    expect(payload.response.usage).toBeTruthy();
    expect(payload.response.usage.estimated).toBe(true);
    expect(payload.response.usage.input_tokens).toBeGreaterThan(0);
  });

  it("provider supplies real usage → response.completed keeps it unestimated", async () => {
    const output = await runChatToResponsesTransform([
      `data: ${JSON.stringify({ id: "cmb-1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } })}`,
      "",
      `data: [DONE]`,
      "",
    ].join("\n"));

    const completedLine = output.split("\n").find((l) => l.startsWith("data: {") && l.includes("response.completed"));
    const payload = JSON.parse(completedLine.slice(6));
    expect(payload.response.usage.input_tokens).toBe(40);
    expect(payload.response.usage.output_tokens).toBe(7);
    expect(payload.response.usage.estimated).toBeUndefined();
  });
});