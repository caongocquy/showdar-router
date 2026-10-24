// SR-04: cancellation propagation and resource cleanup.
//
// Ownership under test:
//   HTTP Request.signal → handleChat → combo requestSignal → per-candidate
//   options.signal → ChatCore streamController → executor fetch signal.
//
// These tests assert the *lifecycle* contract (abort terminates work, nothing is
// dispatched after cancellation, no false health write), not socket-level leaks.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id) => ({ id, connectionId: id, connectionName: id, isActive: true, accessToken: "tok", providerSpecificData: {} });
  return {
    conn,
    fetchMock,
    state: {
      combos: {},
      connections: [conn("conn-1")],
      validateSuccess: null,
      calls: [],
      markCalls: [],
      prefetch: [],
      prefetchBlock: null,
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

// Controllable pre-dispatch image prefetch: lets us prove it receives the
// request signal and that an abort there never reaches the provider.
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: async (_body, _src, _tgt, options = {}) => {
    h.state.prefetch.push({ hasSignal: !!options.signal });
    if (h.state.prefetchBlock) await h.state.prefetchBlock(options.signal);
    return 0;
  },
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logOpenAIRequest() {}, logConvertedChunk() {}, appendOpenAIChunk() {}, logError() {}, logResponse() {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (_provider, exclude) => h.state.connections.find((c) => !exclude?.has(c.connectionId)) || null),
  markAccountUnavailable: vi.fn(async (id, status) => {
    h.state.markCalls.push({ id, status });
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

// BaseExecutor is exercised directly, so its network edge is mocked separately.
const baseFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => baseFetch(...args) }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { validateChatComboResponse } = await import("../../open-sse/services/chatComboResponseValidator.js");
const { handleFusionChat } = await import("../../open-sse/services/combo.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

const enc = (s) => new TextEncoder().encode(s);
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const base = { object: "chat.completion.chunk", created: 1, model: "test-model" };
const roleFrame = (id = "chatcmpl-1") => frame({ ...base, id, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
const contentFrame = (id, text) => frame({ ...base, id, choices: [{ index: 0, delta: { content: text } }] });
const finishFrame = (id = "chatcmpl-1") => frame({ ...base, id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const DONE_FRAME = "data: [DONE]\n\n";
const successFrames = (id = "chatcmpl-1", text = "hi") => [roleFrame(id), contentFrame(id, text), finishFrame(id), DONE_FRAME];

function sseFixture(frames, { holdOpen = false } = {}) {
  const tracker = { cancelled: 0, pulls: 0 };
  const body = new ReadableStream({
    pull(c) {
      tracker.pulls += 1;
      if (tracker.pulls <= frames.length) c.enqueue(enc(frames[tracker.pulls - 1]));
      else if (!holdOpen) c.close();
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

function combo(models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]) {
  h.state.combos["mycombo"] = models;
  h.state.connections = [h.conn("conn-1")];
  h.state.validateSuccess = validateChatComboResponse;
  h.state.calls = [];
  h.state.markCalls = [];
  h.state.prefetch = [];
  h.state.prefetchBlock = null;
  h.fetchMock.mockReset();
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* stream error is part of the contract under test */ }
  return text;
}

const terminalCount = (text) => text.split("\n\n").filter((block) => block.trim() === "data: [DONE]").length;
const assistantText = (text) => text
  .split("\n\n")
  .map((block) => block.trim())
  .filter((block) => block.startsWith("data: {"))
  .map((block) => { try { return JSON.parse(block.slice(5).trim()); } catch { return null; } })
  .filter(Boolean)
  .flatMap((p) => (p.choices || []).map((c) => c.delta?.content || ""))
  .join("");

beforeEach(() => {
  baseFetch.mockReset();
});

describe("SR-04 A — cancellation before dispatch", () => {
  it("dispatches nothing when the client signal is already aborted", async () => {
    combo();
    const ctrl = new AbortController();
    ctrl.abort();

    const res = await runChat({ model: "mycombo", signal: ctrl.signal });

    expect(res.status).toBe(499);
    expect(h.state.calls).toEqual([]);
    expect(h.state.markCalls).toEqual([]);
  }, 10000);

  it("reports 499 and dispatches nothing when the client body is aborted mid-read", async () => {
    combo();
    const ctrl = new AbortController();
    // Transport-level abort surfaces as an AbortError from the body reader.
    const body = new ReadableStream({
      start(c) { c.error(Object.assign(new Error("aborted"), { name: "AbortError" })); },
    });
    const req = new Request("http://localhost:21298/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
      signal: ctrl.signal,
    });

    const res = await handleChat(req);

    expect(res.status).toBe(499);
    expect(h.state.calls).toEqual([]);
    expect(h.state.markCalls).toEqual([]);
  }, 10000);

  it("aborts during image prefetch, propagates the signal and never dispatches", async () => {
    combo(["gemini/gemini-2.5-pro"]);
    h.state.prefetchBlock = (signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    const res = await p;

    expect(res.status).toBe(499);
    expect(h.state.prefetch).toEqual([{ hasSignal: true }]);
    expect(h.state.calls).toEqual([]);
  }, 10000);
});

describe("SR-04 B/F — executor retry, backoff and timeouts", () => {
  const creds = { apiKey: "k" };
  const fakeResponse = (status) => ({ status, headers: { get: () => "" } });

  it("aborts inside the retry backoff instead of returning the failed response", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 429: { attempts: 2, delayMs: 200 } } });
    baseFetch.mockResolvedValue(fakeResponse(429));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    let thrown = null;
    try { await ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: ctrl.signal }); } catch (e) { thrown = e; }

    // A cancelled client must terminate the attempt, not hand the 429 back as a
    // provider failure (which would cooldown the credential for nothing).
    expect(thrown?.name).toBe("AbortError");
    expect(baseFetch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("aborts an in-flight connect with AbortError and does not retry", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", timeoutMs: 5000, retry: { 502: { attempts: 2, delayMs: 0 } } });
    baseFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    let thrown = null;
    try { await ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: ctrl.signal }); } catch (e) { thrown = e; }

    expect(thrown?.name).toBe("AbortError");
    expect(baseFetch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("classifies an upstream connect timeout as a provider failure, not client cancellation", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", timeoutMs: 25, retry: { 502: { attempts: 0 } } });
    baseFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    let thrown = null;
    try { await ex.execute({ model: "m", body: {}, stream: false, credentials: creds }); } catch (e) { thrown = e; }

    expect(thrown?.name).not.toBe("AbortError");
    expect(thrown?.status).toBe(502);
  }, 10000);
});

describe("SR-04 C — combo and account fallback", () => {
  it("stops between account attempts and does not mark the aborted attempt unavailable", async () => {
    combo(["deepseek/deepseek-chat"]);
    h.state.connections = [h.conn("conn-1"), h.conn("conn-2")];
    const ctrl = new AbortController();
    h.fetchMock.mockImplementationOnce(async () => {
      ctrl.abort();
      return jsonFixture({ error: { message: "upstream exploded" } }, 500);
    });

    const res = await runChat({ model: "mycombo", signal: ctrl.signal });

    expect(res.status).toBe(499);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].conn).toBe("conn-1");
    // The genuine 500 is recorded once; the cancellation adds no health write.
    expect(h.state.markCalls).toEqual([{ id: "conn-1", status: 500 }]);
  }, 10000);

  it("aborts a candidate during pre-output validation without trying the next candidate", async () => {
    combo();
    const upstream = sseFixture([roleFrame()], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);
    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 40);

    const res = await p;
    await drain(res);

    expect(res.status).toBe(499);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.markCalls).toEqual([]);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);
});

describe("SR-04 D — active SSE stream cleanup", () => {
  it("cancels the upstream when the client cancels before the first pull", async () => {
    combo(["deepseek/deepseek-chat"]);
    const upstream = sseFixture([roleFrame(), contentFrame("chatcmpl-1", "streaming")], { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);
    h.fetchMock.mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    await res.body.cancel();
    await new Promise((r) => setTimeout(r, 20));

    expect(h.state.calls).toHaveLength(1);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);

  it("cancels cleanly after the terminal frame without a duplicate terminal or redispatch", async () => {
    combo(["deepseek/deepseek-chat"]);
    const upstream = sseFixture(successFrames(), { holdOpen: true });
    h.fetchMock.mockImplementationOnce(async () => upstream.response);

    const res = await runChat({ model: "mycombo" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("data: [DONE]")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(terminalCount(seen)).toBe(1);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));

    expect(h.state.calls).toHaveLength(1);
    expect(upstream.tracker.cancelled).toBeGreaterThanOrEqual(1);
  }, 10000);
});

describe("SR-04 E — fusion panel cancellation", () => {
  const log = { info() {}, warn() {}, debug() {} };
  const okJson = (content) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { headers: { "content-type": "application/json" } });
  const failJson = (status) => new Response(JSON.stringify({ error: { message: "boom" } }), { status, headers: { "content-type": "application/json" } });

  it("returns 499, not 503, when the parent aborts before any panel answer", async () => {
    const ctrl = new AbortController();
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel: (_body, _model, _isPanel, options = {}) => new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(failJson(499)), { once: true });
        setTimeout(() => ctrl.abort(), 15);
      }),
      log,
      comboName: "f",
      requestSignal: ctrl.signal,
    });

    expect(res.status).toBe(499);
  }, 10000);

  it("returns 499 and dispatches no judge when the parent aborts before judging", async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model, _isPanel, options = {}) => {
        if (options.signal?.aborted) return failJson(499);
        return okJson(`${model} answer`);
      },
      beforeModelAttempt: async () => { attempts += 1; if (attempts === 3) ctrl.abort(); return { skip: false }; },
      log,
      comboName: "f",
      requestSignal: ctrl.signal,
    });

    expect(res.status).toBe(499);
    expect(attempts).toBe(3); // two panels + one aborted judge, no retry judge
  }, 10000);

  it("keeps a surviving panel when another panel fails", async () => {
    const onFailure = vi.fn(async () => {});
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model) => (model === "p/a" ? failJson(500) : okJson("winner")),
      onModelFailure: onFailure,
      log,
      comboName: "f",
      judgeModel: "p/b",
    });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("winner");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toBe("p/a");
  }, 10000);
});
