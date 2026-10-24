// SR-01: a Gemini 429 must advance the combo (or the account chain) instead of
// stranding the request on the failing route. Drives the real production path:
// handleChat -> handleSingleModelChat -> handleChatCore -> real combo planner +
// real validateChatComboResponse. Only the upstream executor/auth/settings edges
// are mocked.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  // Keep the bounded error-body read short so a stalled body is observed fast.
  process.env.ERROR_BODY_READ_TIMEOUT_MS = "200";
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id, name) => ({ id, connectionId: id, connectionName: name, isActive: true, accessToken: "tok", providerSpecificData: {} });
  return {
    conn,
    fetchMock,
    state: {
      combos: {},
      connections: [conn("conn-1", "Local")],
      beforeModelAttempt: null,
      validateSuccess: null,
      attempts: [],
      calls: [],      // { model, conn, stream, signal } per upstream dispatch
      markCalls: [],  // markAccountUnavailable(...resetsAtMs)
    },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ model, body, stream, credentials, signal }) {
        h.state.attempts.push(model);
        h.state.calls.push({ model, conn: credentials?.connectionId || null, stream, signal });
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
  // Real policy: 429 (and 5xx) release the account so the next account is tried.
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
    inspectModel: (...a) => h.state.beforeModelAttempt?.(...a) || { skip: false },
    beforeModelAttempt: (...a) => h.state.beforeModelAttempt?.(...a) || { skip: false },
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
const { handleComboChat } = await import("../../open-sse/services/combo.js");

const enc = (s) => new TextEncoder().encode(s);
const chunk = (delta) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`;
const SSE = [
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "hi" }),
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
];
function sseResponse() {
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i >= SSE.length) return c.close(); c.enqueue(enc(SSE[i++])); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function jsonResponse(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}
const quota429 = (extra = {}) => jsonResponse({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", ...extra } }, 429);

function runChat({ model, signal, stream = true } = {}) {
  const req = new Request("http://localhost:21298/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "q" }] }),
    signal,
  });
  return handleChat(req);
}

/** Reset per-test state. `models` defines the combo under the name "mycombo". */
function combo(models = ["gemini/gemini-2.5-pro", "openai/model-b"]) {
  h.state.combos["mycombo"] = models;
  h.state.connections = [h.conn("conn-1", "Local")];
  h.state.beforeModelAttempt = null;
  h.state.validateSuccess = validateChatComboResponse;
  h.state.attempts = [];
  h.state.calls = [];
  h.state.markCalls = [];
  h.fetchMock.mockReset();
}

describe("SR-01 combo 429 fallback", () => {
  it("429 without Retry-After advances to the next candidate", async () => {
    combo();
    h.fetchMock.mockResolvedValueOnce(quota429()).mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(await res.text()).toContain("hi");
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b"]);
  });

  it("429 with a long Retry-After advances immediately instead of waiting it out", async () => {
    combo();
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: 429, message: "rate limit" } }, 429, { "retry-after": "3600" }))
      .mockImplementationOnce(async () => sseResponse());

    const t0 = Date.now();
    const res = await runChat({ model: "mycombo" });
    const text = await res.text();

    expect(text).toContain("hi");
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("429 carrying Google RetryInfo metadata advances to the next candidate", async () => {
    combo();
    h.fetchMock
      .mockResolvedValueOnce(quota429({ details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" }] }))
      .mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(await res.text()).toContain("hi");
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b"]);
  });

  it("advances in stable configured order across repeated 429s", async () => {
    combo(["gemini/gemini-2.5-pro", "openai/model-b", "openai/model-c"]);
    h.fetchMock
      .mockResolvedValueOnce(quota429())
      .mockResolvedValueOnce(quota429())
      .mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b", "model-c"]);
  });

  it("429 on one account of a provider falls back to the next account", async () => {
    combo();
    h.state.combos = {}; // single model, so the provider account chain owns fallback
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    h.fetchMock.mockResolvedValueOnce(quota429()).mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "gemini/gemini-2.5-pro" });

    expect(res.status).toBe(200);
    // Same model, two accounts: the first 429 must not end the request. (The
    // streamed body of a solo response is re-piped by chatCore and is not
    // observable through this harness's mocked executor — attempts order is.)
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "gemini-2.5-pro"]);
    await res.body?.cancel().catch(() => {});
  });

  it("skips a candidate on cooldown and returns promptly when none are left", async () => {
    combo();
    h.state.beforeModelAttempt = (model) =>
      model.includes("model-b") ? { skip: true, reason: "cooldown", nextProbeAt: new Date(Date.now() + 60000).toISOString() } : { skip: false };
    h.fetchMock.mockResolvedValueOnce(quota429());

    const t0 = Date.now();
    const res = await runChat({ model: "mycombo" });
    const body = await res.json();

    expect(h.state.attempts).toEqual(["gemini-2.5-pro"]);
    expect(res.status).toBe(429);
    expect(body.error.message).toMatch(/exhausted/i);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("429 delivered as an SSE error payload before any output advances", async () => {
    combo();
    const errStream = () => new Response(new ReadableStream({ start(c) { c.enqueue(enc(`data: ${JSON.stringify({ error: { code: 429, message: "quota exceeded" } })}\n\n`)); c.enqueue(enc("data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    h.fetchMock.mockImplementationOnce(async () => errStream()).mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(await res.text()).toContain("hi");
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b"]);
  });

  it("a non-terminating 429 error body does not block fallback", async () => {
    combo();
    const hanging = () => new Response(new ReadableStream({ start() {} }), { status: 429, headers: { "content-type": "text/event-stream" } });
    h.fetchMock.mockImplementationOnce(async () => hanging()).mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");
    expect(h.state.attempts).toEqual(["gemini-2.5-pro", "model-b"]);
  }, 10000);

  it("a client abort while a candidate stalls returns promptly", async () => {
    combo();
    // Candidate 1 accepts the connection but never produces meaningful output.
    h.fetchMock
      .mockImplementationOnce(async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } }))
      .mockImplementationOnce(async () => sseResponse());

    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);

    const res = await p;
    await res.text().catch(() => "");
    expect(res.status).toBe(499);
  }, 10000);
});

// Combo-loop level (no chatCore pipe): the client-visible stream must never have
// a second model spliced into it once a meaningful delta has been emitted.
describe("SR-01 no model splice after output started", () => {
  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  it("commits to the first candidate after a meaningful delta, even if its stream then fails", async () => {
    const attempts = [];
    const brokenAfterOutput = () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc(SSE[1])); // first meaningful delta → route committed
        setTimeout(() => c.error(new Error("upstream reset")), 5);
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["openai/model-a", "openai/model-b"],
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        return model === "openai/model-a" ? brokenAfterOutput() : sseResponse();
      },
      validateSuccess: validateChatComboResponse,
      log,
    });

    expect(attempts).toEqual(["openai/model-a"]);
    await expect(result.text()).rejects.toThrow(/upstream reset/);
  });
});

// ---------------------------------------------------------------------------
// SR-01 regression scenarios (non-streaming fallback, retry metadata, cleanup)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect unhandled rejections raised while a test body runs. */
function trackUnhandledRejections() {
  const seen = [];
  const onRejection = (err) => seen.push(err);
  process.on("unhandledRejection", onRejection);
  return { seen, stop: () => process.off("unhandledRejection", onRejection) };
}

/** An error body that never terminates; reports how often its reader was cancelled. */
function stalledErrorBody(tracker, status = 429, headers = { "content-type": "application/json" }) {
  return new Response(new ReadableStream({
    start() {},
    cancel() { tracker.cancelled += 1; },
  }), { status, headers });
}

/** A successful body that never terminates; reports reader cancellation. */
function stalledSuccessBody(tracker) {
  return new Response(new ReadableStream({
    start() {},
    cancel() { tracker.cancelled += 1; },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("SR-01 regression: non-streaming fallback", () => {
  it("falls back from a stalled 429 body and returns one complete non-streaming response", async () => {
    // `openai` is forceStream, so a non-streaming client would be forced onto
    // the SSE path; deepseek is a plain OpenAI-format provider.
    combo(["gemini/gemini-2.5-pro", "deepseek/deepseek-chat"]);
    const stalled = { cancelled: 0 };
    const completion = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1700000000,
      model: "deepseek-chat",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    h.fetchMock
      .mockImplementationOnce(async () => stalledErrorBody(stalled))
      .mockImplementationOnce(async () => jsonResponse(completion, 200));

    const t0 = Date.now();
    const res = await runChat({ model: "mycombo", stream: false });
    const elapsed = Date.now() - t0;
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.content).toBe("ok");
    expect(body.choices[0].finish_reason).toBe("stop");
    // Exactly one completion in the payload — no spliced second candidate.
    expect(raw.match(/"content":"ok"/g)).toHaveLength(1);
    // Bounded by ERROR_BODY_READ_TIMEOUT_MS (200 ms in this harness).
    expect(elapsed).toBeLessThan(2000);
    // Candidate order preserved, exactly one dispatch per candidate.
    expect(h.state.calls.map((c) => c.model)).toEqual(["gemini-2.5-pro", "deepseek-chat"]);
    expect(h.state.calls.every((c) => c.stream === false)).toBe(true);
    // The stalled error-body reader was cancelled, not leaked.
    expect(stalled.cancelled).toBe(1);
  }, 10000);
});

describe("SR-01 regression: Retry-After + account → combo fallback", () => {
  it("derives the account cooldown from Retry-After/RetryInfo and still advances account → combo immediately", async () => {
    combo(["gemini/gemini-2.5-pro", "deepseek/deepseek-chat"]);
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    const t0 = Date.now();
    h.fetchMock
      // Account 1: header form.
      .mockImplementationOnce(async () => jsonResponse({ error: { code: 429, message: "rate limit" } }, 429, { "retry-after": "3600" }))
      // Account 2: Google structured quota-reset form.
      .mockImplementationOnce(async () => quota429({ details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1800s" }] }))
      .mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });
    const text = await res.text();
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(text).toContain("hi");
    // Account order inside the candidate, then candidate order.
    expect(h.state.calls.map((c) => [c.model, c.conn])).toEqual([
      ["gemini-2.5-pro", "conn-1"],
      ["gemini-2.5-pro", "conn-2"],
      ["deepseek-chat", "conn-1"],
    ]);
    // Retry metadata becomes the route-health deadline (≈ now + header/RetryInfo).
    expect(h.state.markCalls).toHaveLength(2);
    expect(h.state.markCalls[0].status).toBe(429);
    expect(h.state.markCalls[0].resetsAtMs).toBeGreaterThan(t0 + 3_500_000);
    expect(h.state.markCalls[0].resetsAtMs).toBeLessThan(t0 + 3_700_000);
    expect(h.state.markCalls[1].resetsAtMs).toBeGreaterThan(t0 + 1_700_000);
    expect(h.state.markCalls[1].resetsAtMs).toBeLessThan(t0 + 1_900_000);
    // A long upstream window is recorded, never slept through.
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it("keeps the 429 status and candidate order when every candidate reports a long reset window", async () => {
    combo(["gemini/gemini-2.5-pro", "deepseek/deepseek-chat"]);
    const t0 = Date.now();
    h.fetchMock
      .mockImplementationOnce(async () => jsonResponse({ error: { code: 429, message: "rate limit for gemini" } }, 429, { "retry-after": "7200" }))
      .mockImplementationOnce(async () => jsonResponse({ error: { code: 429, message: "rate limit for deepseek" } }, 429, { "retry-after": "3600" }));

    const res = await runChat({ model: "mycombo" });
    const body = await res.json();
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(429);
    expect(body.error.message).toMatch(/rate limit/i);
    expect(h.state.calls.map((c) => c.model)).toEqual(["gemini-2.5-pro", "deepseek-chat"]);
    expect(h.state.markCalls.map((c) => c.status)).toEqual([429, 429]);
    expect(h.state.markCalls[0].resetsAtMs).toBeGreaterThan(t0 + 7_100_000);
    expect(h.state.markCalls[1].resetsAtMs).toBeGreaterThan(t0 + 3_500_000);
    expect(elapsed).toBeLessThan(2000);
  }, 10000);
});

describe("SR-01 regression: resource cleanup", () => {
  it("an exceeded error-body read deadline cancels the stalled reader and leaves nothing pending", async () => {
    combo();
    const stalled = { cancelled: 0 };
    const rejections = trackUnhandledRejections();
    try {
      h.fetchMock
        .mockImplementationOnce(async () => stalledErrorBody(stalled))
        .mockImplementationOnce(async () => sseResponse());

      const t0 = Date.now();
      const res = await runChat({ model: "mycombo" });
      expect(await res.text()).toContain("hi");
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(stalled.cancelled).toBe(1);

      const dispatched = h.state.calls.length;
      expect(dispatched).toBe(2);
      // Past the read deadline: no retry wait, dangling timer or extra dispatch.
      await sleep(300);
      expect(h.state.calls).toHaveLength(dispatched);
      expect(stalled.cancelled).toBe(1);
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  }, 10000);

  it("a client abort mid-stream propagates to the upstream dispatch and skips fallback", async () => {
    combo();
    const stalled = { cancelled: 0 };
    const rejections = trackUnhandledRejections();
    try {
      h.fetchMock
        .mockImplementationOnce(async () => stalledSuccessBody(stalled))
        .mockImplementationOnce(async () => sseResponse());

      const ctrl = new AbortController();
      const t0 = Date.now();
      const p = runChat({ model: "mycombo", signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 100);

      const res = await p;
      await res.text().catch(() => "");
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(499);
      // The abort reached the in-flight upstream dispatch.
      expect(h.state.calls[0].signal.aborted).toBe(true);
      // No second candidate and no cooldown bookkeeping after the client left.
      expect(h.state.calls.map((c) => c.model)).toEqual(["gemini-2.5-pro"]);
      expect(h.state.markCalls).toEqual([]);
      expect(stalled.cancelled).toBe(1);
      expect(elapsed).toBeLessThan(2000);
      await sleep(100);
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  }, 10000);
});
