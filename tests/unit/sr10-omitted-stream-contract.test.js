// SR-10: OpenAI Chat Completions omitted `stream` is non-streaming.
//
// Drives the real chat core, translators and response handlers; only the
// upstream executor + persistence edges are mocked. Covers a plain
// OpenAI-format provider and a forceStream provider.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [],
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ body, stream }) {
        h.calls.push({ stream, bodyStream: body.stream });
        if (stream) {
          const id = "chatcmpl-sr10";
          const chunks = [
            { id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
          const raw = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
          return { response: new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }), url: "https://upstream.example/v1", headers: {}, transformedBody: body };
        }
        const json = {
          id: "chatcmpl-sr10",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        };
        return { response: new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } }), url: "https://upstream.example/v1", headers: {}, transformedBody: body };
      },
    };
  },
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logOpenAIRequest() {}, logConvertedChunk() {}, appendOpenAIChunk() {}, logError() {}, logResponse() {} }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

async function run({ provider, model, stream }) {
  h.calls = [];
  const body = { model, messages: [{ role: "user", content: "q" }] };
  if (stream !== undefined) body.stream = stream;
  const result = await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test", connectionId: "conn-sr10", providerSpecificData: {} },
    connectionId: "conn-sr10",
    sourceFormatOverride: "openai",
  });
  return result?.response || result;
}

const isJson = (res) => (res.headers.get("content-type") || "").includes("application/json");
const isSse = (res) => (res.headers.get("content-type") || "").includes("text/event-stream");

describe("SR-10 omitted stream contract", () => {
  it("treats omitted as false for an OpenAI-format provider", async () => {
    const res = await run({ provider: "deepseek", model: "deepseek-chat" });
    expect(res.status).toBe(200);
    expect(isJson(res)).toBe(true);
    expect(isSse(res)).toBe(false);
    expect((await res.json()).choices[0].message.content).toBe("hi");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ stream: false, bodyStream: false });
  });

  it("keeps explicit true streaming", async () => {
    const res = await run({ provider: "deepseek", model: "deepseek-chat", stream: true });
    expect(res.status).toBe(200);
    expect(isSse(res)).toBe(true);
    expect(await res.text()).toContain("data: [DONE]");
    expect(h.calls[0]).toMatchObject({ stream: true, bodyStream: true });
  });

  it("buffers forceStream upstream SSE for an omitted non-streaming client", async () => {
    const res = await run({ provider: "openai", model: "gpt-4o" });
    expect(res.status).toBe(200);
    expect(isJson(res)).toBe(true);
    expect((await res.json()).choices[0].message.content).toBe("hi");
    expect(h.calls[0]).toMatchObject({ stream: true, bodyStream: true });
  });

  it("keeps explicit true streaming for a forceStream provider", async () => {
    const res = await run({ provider: "openai", model: "gpt-4o", stream: true });
    expect(res.status).toBe(200);
    expect(isSse(res)).toBe(true);
    expect(await res.text()).toContain("data: [DONE]");
    expect(h.calls[0]).toMatchObject({ stream: true, bodyStream: true });
  });
});
