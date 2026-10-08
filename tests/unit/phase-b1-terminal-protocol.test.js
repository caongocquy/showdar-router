// Phase B.1: Responses terminal protocol correctness.
// Contract (OpenAI Responses streaming): exactly one terminal event per stream —
// response.completed (status completed) | response.incomplete (status incomplete +
// incomplete_details) | response.failed (infrastructure). Never completed-with-
// status-incomplete, never both. Final terminal carries output[] accumulated from
// the streamed item events (same IDs), plus final usage (real > estimate).
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { initState } from "../../open-sse/translator/index.js";

const TERMINALS = ["response.completed", "response.incomplete", "response.failed"];

// Chat-completions provider stream → Responses client (translate mode)
async function runChatToResponses(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai", null, null, "gpt-4o"),
  );
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Same-format Responses passthrough
async function runPassthrough(input) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, null, "gpt-5.5"),
  );
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseEvents(output) {
  const events = [];
  let cur = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("event: ")) cur = line.slice(7).trim();
    else if (line.startsWith("data: ") && line.includes("{")) {
      if (cur) events.push({ event: cur, data: JSON.parse(line.slice(6)) });
      cur = null;
    }
  }
  return events;
}

function terminalsOf(output) {
  return parseEvents(output).filter((e) => TERMINALS.includes(e.event));
}

function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n`;
}

// provider stream: optional text + finish_reason (+ optional real usage on the finish chunk)
function textStream(finishReason, { usage = null, text = "hello world" } = {}) {
  const lines = [chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }), "\n"];
  const finish = { id: "cmb-1", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
  if (usage) finish.usage = usage;
  lines.push(chatChunk(finish), "\n", "data: [DONE]\n\n");
  return lines.join("");
}

function toolCallStream(finishReason) {
  return [
    chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] }),
    "\n",
    chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
    "\n",
    "data: [DONE]\n\n",
  ].join("");
}

function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

describe("B.1: terminal event type (translate mode)", () => {
  it("1. finish_reason=stop → exactly one response.completed", async () => {
    const output = await runChatToResponses(textStream("stop"));
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(t[0].data.response.status).toBe("completed");
    expect(t[0].data.response.incomplete_details).toBeNull();
  });

  it("2. finish_reason=tool_calls → exactly one response.completed", async () => {
    const output = await runChatToResponses(toolCallStream("tool_calls"));
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(t[0].data.response.status).toBe("completed");
  });

  it("3. finish_reason=length → exactly one response.incomplete, zero response.completed", async () => {
    const output = await runChatToResponses(textStream("length"));
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.incomplete");
    expect(parseEvents(output).filter((e) => e.event === "response.completed")).toHaveLength(0);
  });

  it("4. finish_reason=content_filter → exactly one response.incomplete, zero response.completed", async () => {
    const output = await runChatToResponses(textStream("content_filter"));
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.incomplete");
    expect(parseEvents(output).filter((e) => e.event === "response.completed")).toHaveLength(0);
  });

  it("5. length terminal carries status=incomplete + incomplete_details.reason=max_output_tokens", async () => {
    const output = await runChatToResponses(textStream("length"));
    const t = terminalsOf(output)[0];
    expect(t.data.response.status).toBe("incomplete");
    expect(t.data.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("6. content_filter terminal carries status=incomplete + incomplete_details.reason=content_filter", async () => {
    const output = await runChatToResponses(textStream("content_filter"));
    const t = terminalsOf(output)[0];
    expect(t.data.response.status).toBe("incomplete");
    expect(t.data.response.incomplete_details).toEqual({ reason: "content_filter" });
  });
});

describe("B.1: final response.output[]", () => {
  it("7. translated text response final terminal contains output[]", async () => {
    const output = await runChatToResponses(textStream("stop"));
    const t = terminalsOf(output)[0];
    expect(Array.isArray(t.data.response.output)).toBe(true);
    expect(t.data.response.output.length).toBeGreaterThan(0);
  });

  it("8. output[] text matches the streamed text item", async () => {
    const output = await runChatToResponses(textStream("stop"));
    const events = parseEvents(output);
    const done = events.find((e) => e.event === "response.output_item.done" && e.data.item?.type === "message");
    const terminal = events.find((e) => TERMINALS.includes(e.event));
    expect(done).toBeTruthy();
    const item = terminal.data.response.output.find((o) => o.type === "message");
    expect(item).toBeTruthy();
    expect(item.content[0].text).toBe(done.data.item.content[0].text);
    expect(item.content[0].text).toBe("hello world");
  });

  it("9. function-call output[] matches emitted item events (call id/name/arguments)", async () => {
    const output = await runChatToResponses(toolCallStream("tool_calls"));
    const events = parseEvents(output);
    const done = events.find((e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call");
    expect(done).toBeTruthy();
    const terminal = events.find((e) => TERMINALS.includes(e.event));
    const fc = terminal.data.response.output.find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.id).toBe(done.data.item.id);
    expect(fc.call_id).toBe(done.data.item.call_id);
    expect(fc.name).toBe(done.data.item.name);
    expect(fc.arguments).toBe(done.data.item.arguments);
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("exec");
    expect(fc.arguments).toBe('{"cmd":"ls"}');
  });

  it("10. final output item IDs are consistent with streaming item IDs", async () => {
    const output = await runChatToResponses(textStream("stop"));
    const events = parseEvents(output);
    const doneIds = events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item.id);
    const terminal = events.find((e) => TERMINALS.includes(e.event));
    const outputIds = terminal.data.response.output.map((o) => o.id);
    expect(outputIds).toEqual(doneIds);
  });

  it("16a. stop → output message item status completed", async () => {
    const output = await runChatToResponses(textStream("stop"));
    const terminal = terminalsOf(output)[0];
    const item = terminal.data.response.output.find((o) => o.type === "message");
    expect(item.status).toBe("completed");
  });

  it("16b. length → output message item status incomplete (not falsely completed)", async () => {
    const output = await runChatToResponses(textStream("length"));
    const terminal = terminalsOf(output)[0];
    expect(terminal.data.response.output.length).toBeGreaterThan(0);
    const item = terminal.data.response.output.find((o) => o.type === "message");
    expect(item.status).toBe("incomplete");
  });

  it("16c. reasoning items carry no status field (protocol has none)", async () => {
    const output = await runChatToResponses([
      chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] }),
      "\n",
      chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      "\n",
      chatChunk({ id: "cmb-1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      "\n",
      "data: [DONE]\n\n",
    ].join(""));
    const terminal = terminalsOf(output)[0];
    const reasoning = terminal.data.response.output.find((o) => o.type === "reasoning");
    expect(reasoning).toBeTruthy();
    expect(reasoning).not.toHaveProperty("status");
  });
});

describe("B.1: terminal usage on both terminal types", () => {
  it("11. real usage included on response.completed", async () => {
    const output = await runChatToResponses(textStream("stop", { usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } }));
    const t = terminalsOf(output)[0];
    expect(t.event).toBe("response.completed");
    expect(t.data.response.usage.input_tokens).toBe(40);
    expect(t.data.response.usage.output_tokens).toBe(7);
    expect(t.data.response.usage.estimated).toBeUndefined();
  });

  it("12. real usage included on response.incomplete", async () => {
    const output = await runChatToResponses(textStream("length", { usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } }));
    const t = terminalsOf(output)[0];
    expect(t.event).toBe("response.incomplete");
    expect(t.data.response.usage).toBeTruthy();
    expect(t.data.response.usage.input_tokens).toBe(40);
    expect(t.data.response.usage.output_tokens).toBe(7);
    expect(t.data.response.usage.estimated).toBeUndefined();
  });
});

describe("B.1: passthrough stays lossless", () => {
  it("13. native response.incomplete remains response.incomplete (no rewrite, no synthesized failed)", async () => {
    const nativeIncomplete = {
      type: "response.incomplete",
      response: {
        id: "resp_native",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", id: "msg_n", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "cut off", annotations: [] }] }],
        usage: { input_tokens: 30, output_tokens: 12 },
      },
    };
    const output = await runPassthrough([
      `event: response.incomplete`,
      `data: ${JSON.stringify(nativeIncomplete)}`,
      "",
    ].join("\n"));

    expect(output).toContain("event: response.incomplete");
    expect(output).not.toContain("event: response.completed");
    expect(output).not.toContain("event: response.failed");
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    // native payload untouched: status, reason, output, real usage round-trip
    expect(t[0].data.response.status).toBe("incomplete");
    expect(t[0].data.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(t[0].data.response.output[0].status).toBe("incomplete");
    expect(t[0].data.response.usage.input_tokens).toBe(30);
    expect(t[0].data.response.usage.output_tokens).toBe(12);
    // single [DONE] even though upstream sent none
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("B.1: post-200 failure stays failed", () => {
  it("14. post-200 abort → response.failed, never response.incomplete", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
        controller.error(new Error("ECONNRESET"));
      },
    });
    const streamController = makeController();
    const res = await handleStreamingResponse({
      providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      provider: "openai",
      model: "gpt-4o",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI,
      stream: true,
      body: { model: "gpt-4o", messages: [] },
      streamController,
      requestStartTime: Date.now(),
    });
    const text = await res.response.text();
    expect(text).toContain("event: response.failed");
    expect(text).not.toContain("event: response.incomplete");
    expect(text).toContain("data: [DONE]");
  });
});

describe("B.1: single terminal across the wire", () => {
  it("15. duplicate native terminals + late failed collapse to exactly one terminal", async () => {
    const incomplete = (id) => ({
      type: "response.incomplete",
      response: { id, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const output = await runPassthrough([
      `event: response.incomplete`, `data: ${JSON.stringify(incomplete("resp_a"))}`, "",
      `event: response.incomplete`, `data: ${JSON.stringify(incomplete("resp_b"))}`, "",
      `event: response.failed`, `data: ${JSON.stringify({ type: "response.failed", response: { id: "resp_c", status: "failed", error: { message: "late" } } })}`, "",
    ].join("\n"));

    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.incomplete");
  });
});

describe("B.1: reverse + forced non-streaming terminals", () => {
  it("17. native response.incomplete (event type) → chat finish_reason length + usage", () => {
    const state = initState(FORMATS.OPENAI);
    const final = openaiResponsesToOpenAIResponse(
      { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 5 } } },
      state,
    );
    expect(final.choices[0].finish_reason).toBe("length");
    expect(final.usage.prompt_tokens).toBe(10);
    expect(final.usage.completion_tokens).toBe(5);
  });

  it("18. forced SSE→JSON: native response.incomplete → status incomplete, not in_progress", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          `event: response.output_item.done`,
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_j", role: "assistant", content: [{ type: "output_text", text: "cut", annotations: [] }] } })}`,
          "",
          `event: response.incomplete`,
          `data: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_j", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 9, output_tokens: 3 } } })}`,
          "",
        ].join("\n")));
        controller.close();
      },
    });
    const json = await convertResponsesStreamToJson(stream);
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(json.usage.input_tokens).toBe(9);
    expect(json.output[0].content[0].text).toBe("cut");
  });
});
