// SR-03: streaming fallback safety and the SSE contract.
//
// The commitment boundary is `validateChatComboResponse`: while it buffers, the
// candidate may still be replaced; once it returns ok, the combo hands that
// response to the client and must never splice in another candidate.
//
// These tests drive the real production path (handleChat → handleComboChat →
// handleSingleModelChat → handleChatCore → real combo validator) and mock only
// the upstream executor/auth/settings edges.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  // Short first-meaningful budget so a silent candidate fails over fast; the
  // production default (30 s) is untouched.
  process.env.COMBO_FIRST_MEANINGFUL_TIMEOUT_MS = "150";
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id, name) => ({ id, connectionId: id, connectionName: name, isActive: true, accessToken: "tok", providerSpecificData: {} });
  return {
    conn,
    fetchMock,
    state: {
      combos: {},
      connections: [conn("conn-1", "Local")],
      validateSuccess: null,
      calls: [],
      markCalls: [],
    },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ model, body, stream, credentials, signal }) {
        h.state.calls.push({ model, conn: credentials?.connectionId || null, stream });
        const res = await globalThis.fetch("https://upstream.example/v1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, model }),
          signal,
        });
        return { response: res, url: "https://upstream.example/v1", headers: {}, transformedBody: body };
      },
    };
  },
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logOpenAIRequest() {}, logConvertedChunk() {}, appendOpenAIChunk() {}, logError() {}, logResponse() {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (_provider, exclude) => {
    const conns = h.state.connections;
    return conns.find((c) => !exclude?.has(c.connectionId)) || null;
  }),
  markAccountUnavailable: vi.fn(async (_id, status, _error, _provider, _model, resetsAtMs) => {
    h.state.markCalls.push({ id: _id, status, resetsAtMs });
    return { shouldFallback: status === 429 || status >= 500, cooldownMs: 0 };
  }),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(async () => 0), clearAntigravityStrikes: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategies: {}, comboStrategy: "fallback", comboStickyRoundRobinLimit: 0, providerThinking: {} })),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (m) => {
    const i = String(m).indexOf("/");
    return i <= 0 ? { provider: null, model: null } : { provider: m.slice(0, i), model: m.slice(i + 1) };
  }),
  getComboModels: vi.fn(async (name) => h.state.combos[name] || null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(async () => {}), checkAndRefreshToken: vi.fn(async (_p, c) => c) }));
vi.mock("@/sse/services/comboHealthHooks.js", () => ({
  createChatComboHealthHooks: () => ({
    inspectModel: async () => ({ skip: false }),
    beforeModelAttempt: async () => ({ skip: false }),
    onModelSuccess: async () => {},
    onModelFailure: async () => {},
    onModelCancelled: async () => {},
    get validateSuccess() { return h.state.validateSuccess; },
  }),
}));
vi.mock("@/sse/utils/logger.js", async (importOriginal) => ({ ...(await importOriginal()), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn(), maskKey: () => "****" }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:1" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({ augmentModelsWithCapacityAdapter: vi.fn((m) => m), withCapacityAdapterStripping: vi.fn((f) => f), getActiveAdapterStrategy: vi.fn(() => "fallback") }));
vi.mock("../../open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { validateChatComboResponse } = await import("../../open-sse/services/chatComboResponseValidator.js");

const enc = (s) => new TextEncoder().encode(s);
const CHAT_ID = "chatcmpl-1";
const base = (id = CHAT_ID) => ({ id, object: "chat.completion.chunk", created: 1, model: "test-model" });
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const roleFrame = (id = CHAT_ID) => frame({ ...base(id), choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
const contentFrame = (id, text) => frame({ ...base(id), choices: [{ index: 0, delta: { content: text } }] });
const toolFrame = (id, tool) => frame({ ...base(id), choices: [{ index: 0, delta: { tool_calls: [tool] } }] });
const finishFrame = (id = CHAT_ID, reason = "stop") => frame({ ...base(id), choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const TOOL_ARGS_FIRST = { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } };
const DONE_FRAME = "data: [DONE]\n\n";

const successFrames = (id = CHAT_ID, text = "hi") => [roleFrame(id), contentFrame(id, text), finishFrame(id), DONE_FRAME];

/** Upstream SSE body with cancellation/pull tracking; can fail or stall on demand. */
function sseFixture(frames, { errorAt = null, error = null, holdOpen = false } = {}) {
  const tracker = { cancelled: 0, pulls: 0 };
  const body = new ReadableStream({
    pull(c) {
      tracker.pulls += 1;
      if (errorAt != null && tracker.pulls > errorAt) {
        c.error(error || Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        return;
      }
      if (tracker.pulls <= frames.length) {
        c.enqueue(enc(frames[tracker.pulls - 1]));
        return;
      }
      if (!holdOpen) c.close();
    },
    cancel() { tracker.cancelled += 1; },
  });
  return { response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), tracker };
}
const jsonFixture = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function runChat({ model, stream = true, signal } = {}) {
  const req = new Request("http://localhost:21298/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "q" }] }),
    signal,
  });
  return handleChat(req);
}

/** Reset per-test state; `models` is the combo registered under "mycombo". */
function combo(models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]) {
  h.state.combos["mycombo"] = models;
  h.state.connections = [h.conn("conn-1", "Local")];
  h.state.validateSuccess = validateChatComboResponse;
  h.state.calls = [];
  h.state.markCalls = [];
  h.fetchMock.mockReset();
}

/** Drain a client response body, tolerating a stream error. */
async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let error = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (e) {
    error = e;
  }
  return { text, error };
}

/** Parsed SSE frames: { event, data } with data kept as raw text. */
function parseSse(text) {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = null;
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      return { event, data: data.join("\n") };
    });
}

function jsonPayloads(text) {
  return parseSse(text)
    .map((f) => f.data)
    .filter((d) => d && d !== "[DONE]")
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter(Boolean);
}

const assistantText = (text) => jsonPayloads(text)
  .flatMap((p) => (p.choices || []).map((c) => c.delta?.content || ""))
  .join("");

const terminalCount = (text) => parseSse(text).filter((f) => f.data === "[DONE]").length;

describe("SR-03 C — successful streaming contract", () => {
  it("emits valid frames, one identity, one finish reason and one [DONE]", async () => {
    combo();
    h.fetchMock.mockImplementationOnce(async () => sseFixture(successFrames()).response);

    const res = await runChat({ model: "mycombo" });
    const { text, error } = await drain(res);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(error).toBeNull();
    expect(assistantText(text)).toBe("hi");
    expect(terminalCount(text)).toBe(1);
    const payloads = jsonPayloads(text);
    expect(new Set(payloads.map((p) => p.id))).toEqual(new Set([CHAT_ID]));
    expect(payloads.filter((p) => p.choices?.[0]?.finish_reason)).toHaveLength(1);
    expect(payloads.filter((p) => p.choices?.[0]?.delta?.role === "assistant")).toHaveLength(1);
    // Every data frame is JSON or the sentinel; no raw garbage.
    expect(parseSse(text).filter((f) => f.data !== "[DONE]").every((f) => f.data.startsWith("{"))).toBe(true);
  }, 10000);

  it("streams tool-call arguments as deltas with one identity and one [DONE]", async () => {
    combo(["deepseek/deepseek-chat"]);
    h.fetchMock.mockImplementationOnce(async () => sseFixture([
      roleFrame(),
      toolFrame(CHAT_ID, TOOL_ARGS_FIRST),
      toolFrame(CHAT_ID, { index: 0, function: { arguments: '{"q":' } }),
      toolFrame(CHAT_ID, { index: 0, function: { arguments: '"x"}' } }),
      finishFrame(CHAT_ID, "tool_calls"),
      DONE_FRAME,
    ]).response);

    const res = await runChat({ model: "mycombo" });
    const { text, error } = await drain(res);

    expect(error).toBeNull();
    const deltas = jsonPayloads(text).flatMap((p) => p.choices?.[0]?.delta?.tool_calls || []);
    expect(deltas.map((d) => d.id).filter(Boolean)).toEqual(["call_1"]);
    const args = deltas.map((d) => d.function?.arguments || "").join("");
    expect(args).toBe('{"q":"x"}');
    const finishes = jsonPayloads(text).map((p) => p.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toEqual(["tool_calls"]);
    expect(terminalCount(text)).toBe(1);
  }, 10000);

  it("synthesizes exactly one [DONE] when the upstream closes without one", async () => {
    combo(["deepseek/deepseek-chat"]);
    h.fetchMock.mockImplementationOnce(async () => sseFixture([roleFrame(), contentFrame(CHAT_ID, "hi"), finishFrame()]).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(assistantText(text)).toBe("hi");
    expect(terminalCount(text)).toBe(1);
    expect(parseSse(text).at(-1).data).toBe("[DONE]");
  }, 10000);
});

describe("SR-03 A — fallback before client-visible output", () => {
  it("falls back on a pre-stream HTTP error without leaking candidate 1", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => jsonFixture({ error: { message: "[429]: quota exhausted" } }, 429))
      .mockImplementationOnce(async () => sseFixture(successFrames()).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(assistantText(text)).toBe("hi");
    expect(text).not.toContain("quota");
    expect(terminalCount(text)).toBe(1);
  }, 10000);

  it("falls back on an upstream SSE error event before meaningful output", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([
        roleFrame(),
        frame({ error: { message: "provider overloaded", type: "server_error" } }),
      ]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(assistantText(text)).toBe("hi");
    expect(text).not.toContain("overloaded");
    // The failed candidate's role frame was buffered and discarded.
    expect(jsonPayloads(text).filter((p) => p.choices?.[0]?.delta?.role === "assistant")).toHaveLength(1);
  }, 10000);

  it("falls back after a role-only stream, leaking neither its bytes nor a duplicate role", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([roleFrame("chatcmpl-dead")]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(assistantText(text)).toBe("hi");
    expect(text).not.toContain("chatcmpl-dead");
    expect(jsonPayloads(text).filter((p) => p.choices?.[0]?.delta?.role === "assistant")).toHaveLength(1);
  }, 10000);

  it("falls back on malformed or truncated SSE before meaningful output", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([
        roleFrame(),
        "data: {not-json\n\n",
        'data: {"id":"chatcmpl-trunc","choices":[{"delta":{"cont',
      ]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(assistantText(text)).toBe("hi");
    expect(text).not.toContain("chatcmpl-trunc");
    expect(terminalCount(text)).toBe(1);
  }, 10000);

  it("falls back when the upstream EOFs before any content", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(assistantText(text)).toBe("hi");
    expect(h.state.calls).toHaveLength(2);
  }, 10000);

  it("falls back when the first meaningful content misses the budget", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([roleFrame()], { holdOpen: true }).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const t0 = Date.now();
    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(res.status).toBe(200);
    expect(assistantText(text)).toBe("hi");
    expect(h.state.calls).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 10000);
});

describe("SR-03 B — no splicing after client-visible output", () => {
  it("terminates without a second candidate when the stream dies after content", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([roleFrame(), contentFrame(CHAT_ID, "partial")], { holdOpen: true, errorAt: 3 }).response)
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat"]);
    expect(assistantText(text)).toBe("partial");
    expect(text).not.toContain("WRONG");
    expect(terminalCount(text)).toBe(0); // truncated, not a completed completion
    expect(new Set(jsonPayloads(text).map((p) => p.id))).toEqual(new Set([CHAT_ID]));
  }, 10000);

  it("keeps partial tool-call arguments intact and never switches candidates", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([
        roleFrame(),
        toolFrame(CHAT_ID, TOOL_ARGS_FIRST),
        toolFrame(CHAT_ID, { index: 0, function: { arguments: '{"q":' } }),
      ], { holdOpen: true, errorAt: 4 }).response)
      .mockImplementationOnce(async () => sseFixture([
        roleFrame("chatcmpl-2"),
        toolFrame("chatcmpl-2", { index: 0, id: "call_2", type: "function", function: { name: "other", arguments: "{}" } }),
        finishFrame("chatcmpl-2", "tool_calls"),
        DONE_FRAME,
      ]).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat"]);
    const deltas = jsonPayloads(text).flatMap((p) => p.choices?.[0]?.delta?.tool_calls || []);
    expect(deltas.map((d) => d.id).filter(Boolean)).toEqual(["call_1"]);
    expect(deltas.map((d) => d.function?.arguments || "").join("")).toBe('{"q":');
    expect(text).not.toContain("call_2");
    expect(text).not.toContain("other");
    expect(terminalCount(text)).toBe(0);
  }, 10000);

  it("surfaces a provider error event after content without a second candidate or [DONE]", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([
        roleFrame(),
        contentFrame(CHAT_ID, "part"),
        frame({ error: { message: "upstream boom", type: "server_error" } }),
      ]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    const { text, error } = await drain(res);

    expect(error).toBeNull();
    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat"]);
    expect(assistantText(text)).toBe("part");
    expect(text).toContain("upstream boom");
    expect(text).not.toContain("WRONG");
    expect(terminalCount(text)).toBe(0);
  }, 10000);

  it("errors the client stream on a non-network transport failure after content", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([roleFrame(), contentFrame(CHAT_ID, "part")], { holdOpen: true, errorAt: 3, error: new Error("decode failure") }).response)
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    const { text } = await drain(res);

    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat"]);
    expect(text).toContain("part");
    expect(text).not.toContain("WRONG");
    expect(terminalCount(text)).toBe(0);
  }, 10000);
});

describe("SR-03 D — buffered (non-streaming) clients", () => {
  it("validates buffered responses, falls back once and returns one JSON completion", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => sseFixture([roleFrame("chatcmpl-dead")]).response)
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo", stream: false });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(body)).not.toContain("data:");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.content).toBe("hi");
    expect(h.state.calls).toHaveLength(2);
  }, 10000);

  it("falls back when a 200 JSON response is not a chat completion", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => jsonFixture({ ok: true }))
      .mockImplementationOnce(async () => sseFixture(successFrames(CHAT_ID, "hi")).response);

    const res = await runChat({ model: "mycombo", stream: false });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.choices?.[0]?.message?.content).toBe("hi");
    expect(h.state.calls).toHaveLength(2);
  }, 10000);
});

describe("SR-03 E — cancellation and cleanup", () => {
  it("aborts before meaningful output without a second dispatch or cooldown", async () => {
    combo();
    const upstream = sseFixture([roleFrame()], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);

    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 40);
    const res = await p;
    await drain(res).catch(() => ({}));

    expect(h.state.calls).toHaveLength(1);
    expect(h.state.markCalls).toEqual([]);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);

  it("cancels a stalled candidate during buffered validation", async () => {
    combo();
    const upstream = sseFixture([], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);

    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 40);
    const res = await p;
    await drain(res).catch(() => ({}));

    expect(h.state.calls).toHaveLength(1);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);

  it("cancels upstream once after output starts and dispatches no second candidate", async () => {
    combo();
    const upstream = sseFixture([roleFrame(), contentFrame(CHAT_ID, "streaming"), contentFrame(CHAT_ID, "more")], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);
    h.fetchMock.mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let firstText = "";
    for (let i = 0; i < 3 && !firstText.includes("streaming"); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      firstText += decoder.decode(value, { stream: true });
    }
    expect(firstText).toContain("streaming");
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.calls).toHaveLength(1);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);

  it("cancels during tool-call streaming without mixing completions", async () => {
    combo();
    const upstream = sseFixture([
      roleFrame(),
      toolFrame(CHAT_ID, TOOL_ARGS_FIRST),
      toolFrame(CHAT_ID, { index: 0, function: { arguments: '{"q":' } }),
    ], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);

    const res = await runChat({ model: "mycombo" });
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.calls).toHaveLength(1);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);
});

describe("SR-03 — validator format contract", () => {
  it("accepts Responses-style deltas as meaningful output", async () => {
    const frames = [
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}\n\n",
    ];
    const fixture = sseFixture(frames);
    const result = await validateChatComboResponse(fixture.response, null, { firstMeaningfulTimeoutMs: 150 });

    expect(result.ok).toBe(true);
    const { text } = await drain(result.response);
    expect(text).toContain("response.created");
    expect(text).toContain("response.completed");
  }, 10000);

  it("does not drain the upstream past client demand after committing", async () => {
    combo(["deepseek/deepseek-chat"]);
    const tail = Array.from({ length: 40 }, (_, i) => contentFrame(CHAT_ID, `t${i}`));
    const fixture = sseFixture([roleFrame(), contentFrame(CHAT_ID, "hi"), ...tail], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => fixture.response);

    const res = await runChat({ model: "mycombo" });
    // Committed (content already buffered) but the client has not read yet.
    await new Promise((r) => setTimeout(r, 60));
    const beforeRead = fixture.tracker.pulls;

    expect(beforeRead).toBeLessThanOrEqual(5); // 2 buffered + stream prefetch, not 42
    await res.body.cancel();
  }, 10000);
});
